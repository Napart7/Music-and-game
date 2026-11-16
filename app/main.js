'use strict';
// GlassLyrics main process.
// Design rules:
//  - transparent always-on-top window; NEVER injects into a game process, never reads game memory
//  - mouse click-through is ON by default; only the global hotkey turns it off to use the panel
//  - media info comes from Windows SMTC through a PowerShell bridge (no audio capture, no account)
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, screen, nativeImage,
        clipboard, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const lyricsEngine = require('./lyrics');
const { backendFor, trayIconName } = require('./backends');
const { parseMediaLine, parseWindowLine, normalizeAction } = require('./backends/parse');

const ROOT = __dirname;
// UI smoke tests use an isolated profile and therefore never inherit a running app's
// single-instance lock or overwrite the user's real configuration.
if (process.env.GL_TEST_USER_DATA) app.setPath('userData', path.resolve(process.env.GL_TEST_USER_DATA));
const RES = app.isPackaged ? process.resourcesPath : ROOT;
// Every OS-specific script / interpreter is resolved here and only here.
const BACKEND = backendFor(process.platform, (name) => path.join(RES, name));
const USER_DIR = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DIR, 'config.json');
const TITLE = 'GlassLyricsOverlay';

// Default global hotkeys. Users can rebind every action in the menu (general page).
// Playback-control hotkeys are EMPTY by default so they never fight a game's own keys.
const DEFAULT_HOTKEYS = {
  panel: 'Control+Alt+P',
  toggle: 'Control+Alt+H',
  layout: 'Control+Alt+B',
  fit: 'Control+Alt+F',
  // Bluetooth / wireless audio adds 100-300ms of latency, so lyrics drift out of sync.
  // Nudging the timeline from a global hotkey beats opening the menu mid-game.
  offsetEarlier: 'Control+Alt+PageUp',
  offsetLater: 'Control+Alt+PageDown',
  quit: 'Control+Shift+Alt+Q',
  prev: '',
  next: '',
  playpause: ''
};
const HOTKEY_ACTIONS = Object.keys(DEFAULT_HOTKEYS);

const DEFAULTS = {
  openAtLogin: false,
  displayIndex: 0,
  layout: 'split',
  glowTint: 'white',
  glowStrength: 0.3,
  glowRadius: 0.5,
  wordPop: true,
  wiggle: true,
  shatter: false,
  slam: true,
  stroke: true,
  showGuides: false,
  fontScale: 1,
  showTranslation: true,
  menuTab: 'play',
  hotkeys: { ...DEFAULT_HOTKEYS },
  // --- free lyric placement (percent of window; null = layout default) ---
  // x is the left margin for the left side, right margin for the right side; y is top.
  lyricPos: { left: null, right: null },   // {x,y} in %, set by drag edit mode
  sideWidth: 28,          // vw
  lineHeight: 1.5,
  fontWeight: 600,
  lyricOpacity: 1,
  // --- floating lyrics & performance ---
  floatLines: 4,          // rows visible at once (3..6, includes the current line)
  floatDrift: true,      // compositor-only drift animation per row
  perfLow: false,         // low-end mode: 30fps cap + 2-layer shadows + no wiggle
  // --- auto-fit: follow the foreground game window ---
  autoFit: true,
  hideWhenNoGame: false,
  // Empty by default: auto-fit only reads window geometry, never touches a game process.
  // Users who prefer to opt out on certain titles can still list them here.
  excludeProcesses: [],
  minWindowWidth: 640,
  minWindowHeight: 400,
  // --- lyrics: platform-aware providers ---
  // auto = follow the SMTC source app; explicit values pin a preferred provider.
  lyricSource: 'auto',   // 'auto' | 'qqmusic' | 'netease' | 'kugou' | 'lrclib' | 'off'
  lyricOffsetMs: 0,      // manual timeline calibration
  // Optional Spotify Web API credentials (client credentials flow, catalogue search only).
  // Stored locally in config.json; never bundled, never uploaded.
  spotifyClientId: '',
  spotifyClientSecret: ''
};

// Foreground-window classification lives in window-classify.js so it can be unit-tested
// (tools/verify_classify.mjs) without booting Electron.
const { classifyWindow } = require('./window-classify');

let win = null;
let tray = null;
let trayPanel = null;   // independent persistent menu; never follows overlay hide/blur
let trayPanelSignature = '';
let bridge = null;
let windowProbe = null;
let panelOpen = false;
let editMode = false;   // drag-to-place lyrics: layer becomes clickable, panel auto-closes
let layerVisible = true;
let loaded = false;
let smokeDone = false;
let quitting = false;
let lastAppliedBounds = null;
let lastWindowInfo = null;
let autoFitState = { active: false, reason: 'waiting', rect: null, bounds: null, process: '', title: '' };
let fitSmokeDone = false;
let lyricsRequestKey = '';
let lyricsInFlight = false;
let lastTrackKey = '';
let lastLyrics = null;
let lastSmtc = null;
let currentPlatform = 'other';
let lastBackendError = '';
let lastProbeError = '';
let bridgeRestarts = 0;
let probeRestarts = 0;
const hotkeys = {};

let config = loadConfig();
// GL_FORCE_* hooks are read at use sites only. Never merge them into `config`, otherwise a
// later saveConfig() would persist a test value into the user's real settings.
function effectiveLyricSource() {
  return process.env.GL_FORCE_LYRIC_SOURCE || config.lyricSource;
}

function sameBounds(a, b, tol = 2) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol &&
         Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}

function displayScaleAt(x, y) {
  try { return screen.getDisplayNearestPoint({ x, y }).scaleFactor || 1; }
  catch { return 1; }
}

function toLogicalRect(info, scale) {
  const p = info.rectPhysical;
  const g = info.rect;
  if (Array.isArray(p) && p.length === 4 && p[2] > 0 && p[3] > 0 && scale >= 1) {
    const r = [Math.round(p[0] / scale), Math.round(p[1] / scale),
               Math.round(p[2] / scale), Math.round(p[3] / scale)];
    // Sanity guard: DWM-derived values must stay close to the DPI-virtualised GetWindowRect.
    if (g && Math.abs(r[2] - g[2]) < Math.max(80, g[2] * 0.15)) return r;
  }
  return g;
}

function classifyForFit(info, scale) {
  const rect = info && info.rect ? toLogicalRect(info, scale) : null;
  let display = null;
  if (rect) {
    try {
      const d = screen.getDisplayMatching({ x: rect[0], y: rect[1], width: rect[2], height: rect[3] });
      display = d && d.bounds ? { width: d.bounds.width, height: d.bounds.height } : null;
    } catch { display = null; }
  }
  return classifyWindow(info, {
    rect,
    display,
    // Same floor as before (320x240) — minWindowWidth/Height below is the *fit* threshold.
    minW: 320,
    minH: 240,
    exclude: config.excludeProcesses || [],
    forced: process.env.GL_FORCE_GAME_PROCESS || ''
  });
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

let _saveTimer = null;
function saveConfig() {
  // Debounce: hotkey nudges (100ms intervals) and probe updates both call setConfigValue.
  // Coalescing writes to 300ms avoids blocking the main-process IPC thread on every keystroke.
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      fs.mkdirSync(USER_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
      // config.json may hold the user's Spotify client secret — keep it owner-only on POSIX.
      if (process.platform !== 'win32') {
        try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort */ }
      }
    } catch (e) {
      console.error('[config] save failed', e);
    }
  }, 300);
}

/** Linux has no Electron login-item API: use the freedesktop XDG autostart entry. */
function linuxAutostartPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'autostart', 'glasslyrics.desktop');
}

function writeLinuxAutostart(enabled) {
  const file = linuxAutostartPath();
  try {
    if (!enabled) { fs.rmSync(file, { force: true }); return; }
    // Quote paths: Linux user dirs may contain spaces or non-ASCII characters.
    const execLine = app.isPackaged
      ? `"${process.execPath}"`
      : `"${process.execPath}" "${ROOT}"`;
    const body = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=GlassLyrics',
      'Comment=Cross-game lyric overlay',
      `Exec=${execLine}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  } catch (e) {
    console.error('[config] linux autostart failed', e);
  }
}

function applyLogin() {
  const opts = { openAtLogin: !!config.openAtLogin };
  // In dev the executable is electron.exe, so pass the app dir as an argument.
  if (!app.isPackaged) {
    opts.path = process.execPath;
    opts.args = [ROOT];
  }
  if (BACKEND.capabilities.loginItem === 'xdg-autostart') {
    writeLinuxAutostart(!!config.openAtLogin);
    return;
  }
  try {
    app.setLoginItemSettings(opts);
  } catch (e) {
    console.error('[config] login item failed', e);
  }
}

function targetBounds() {
  const all = screen.getAllDisplays();
  const i = Math.min(Math.max(config.displayIndex || 0, 0), all.length - 1);
  return all[i].bounds;
}

function createWindow() {
  const b = targetBounds();
  win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    title: TITLE,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    // Must start visible: a hidden/occluded window makes Chromium suspend rAF, which freezes
    // the lyric timeline. focusable:false keeps the game focused without hiding the window.
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.on('page-title-updated', (e) => e.preventDefault());
  win.setAlwaysOnTop(true, 'screen-saver');
  lastIgnore = null;
  applyClickThrough();
  // Safety net #1: leaving the window (Alt-Tab, clicking another app) must never leave the
  // overlay in a clickable state — that is how it ends up blocking the game.
  win.on('blur', () => {
    if (panelOpen || editMode) {
      console.log('[click] blur -> restoring click-through');
      panelOpen = false; editMode = false;
      applyClickThrough();
      win.webContents.send('panel', false);
      win.webContents.send('edit-mode', false);
      rebuildTray();
      broadcastTrayPanel();
    }
  });
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    loaded = true;
    win.webContents.send('config', config);
    try { win.showInactive(); } catch { /* fall back below */ }
    applyClickThrough(true);
  });
  // Safety net: if the renderer fails to load, still show the layer (user can fix via menu).
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
  }, 4000);
}

/* ---------------- click-through state machine ----------------
 * The overlay is a full-screen window: "clickable" is window-wide, so a panel or drag
 * mode left open swallows EVERY click on the screen (the reported "can't click the game"
 * bug). Every state change goes through applyClickThrough(), and there are three safety
 * nets: window blur, the window-probe heartbeat (game becomes foreground), and a click
 * outside the panel closing it. */
let lastIgnore = null;
// Instrumentation: every Win32 window call on a fullscreen always-on-top window is a
// z-order / activation event. Counting them makes "why did my tray menu close" measurable.
const winCalls = { ignore: 0, focusable: 0, show: 0, hide: 0, bounds: 0, top: 0 };

function applyClickThrough(force) {
  if (!win || win.isDestroyed()) return;
  const clickable = panelOpen || editMode;
  if (!force && lastIgnore === !clickable) return;      // avoid redundant Win32 calls
  winCalls.ignore++;
  winCalls.focusable++;
  win.setIgnoreMouseEvents(!clickable, { forward: true });
  win.setFocusable(clickable);
  lastIgnore = !clickable;
}

/**
 * Re-assert transparency only when it actually drifted.
 *
 * This used to call applyClickThrough(true) unconditionally every 2s. On Windows every
 * setIgnoreMouseEvents / setFocusable re-applies window styles and re-raises the topmost
 * fullscreen window, which (a) put the overlay above other apps' popups and (b) cancelled
 * any open native menu in this process — the tray menu appeared, then vanished ~2s later.
 * A read-only isFocusable() probe keeps the safety net without the side effects.
 */
function ensureClickThrough() {
  if (!win || win.isDestroyed() || panelOpen || editMode || !layerVisible) return;
  if (lastIgnore === true && !win.isFocusable()) return;   // already click-through
  applyClickThrough(true);
}

/**
 * Window z-order band.
 *
 * `screen-saver` is required to sit above a borderless-fullscreen game, but it also puts
 * the overlay above every other topmost window — including native menus and other apps'
 * popups (that is the "it covers QQ / the tray menu" complaint). The high band is only
 * used while a game window is actually captured; outside games the overlay sits at
 * `floating`, which still covers normal windows but lets menus and popups stay on top.
 */
let topLevel = 'screen-saver';
function setTopLevel(level) {
  if (!win || win.isDestroyed() || topLevel === level) return;
  topLevel = level;
  winCalls.top++;
  try { win.setAlwaysOnTop(true, level); } catch { /* ignore unsupported level */ }
  keepPinnedTrayAboveOverlay();
}

function setPanel(on) {
  panelOpen = !!on;
  if (!win || win.isDestroyed()) return;
  applyClickThrough();
  win.webContents.send('panel', panelOpen);
  rebuildTray();
  broadcastTrayPanel();
}

function setEditMode(on) {
  editMode = !!on;
  if (!win || win.isDestroyed()) return;
  if (editMode && panelOpen) panelOpen = false;   // lyrics must be visible & draggable
  applyClickThrough();
  win.webContents.send('panel', panelOpen);
  win.webContents.send('edit-mode', editMode);
  // Keep tray tooltip and persistent panel in sync (same as setPanel).
  rebuildTray();
  broadcastTrayPanel();
}

function setLayerVisible(on) {
  on = !!on;
  // The window probe polls every 400ms; avoid hide/show churn (and tray rebuilds) when unchanged.
  if (layerVisible === on) return;
  layerVisible = on;
  if (!win || win.isDestroyed()) return;
  if (layerVisible) {
    winCalls.show++;
    win.showInactive();
    keepPinnedTrayAboveOverlay();
  } else { winCalls.hide++; win.hide(); }
  win.webContents.send('visible', layerVisible);
  // A freshly shown window may come back as clickable — re-assert transparency.
  applyClickThrough(true);
  rebuildTray();
  broadcastTrayPanel();
}

/**
 * Shift the lyric timeline by `delta` ms from a global hotkey.
 * Positive delta = lyrics appear earlier; negative = later. Clamped to the same
 * ±3000ms range as the menu slider so both entry points agree.
 * Returns the new value (also used by the smoke probe).
 */
function nudgeLyricOffset(delta) {
  const cur = Number(config.lyricOffsetMs) || 0;
  const next = Math.max(-3000, Math.min(3000, Math.round((cur + delta) / 50) * 50));
  if (next !== cur) setConfigValue({ lyricOffsetMs: next });
  const label = `歌词偏移 ${next > 0 ? '+' : ''}${next} ms`;
  const hint = next === 0 ? '（同步）' : (next > 0 ? '（更早）' : '（更晚）');
  if (win && !win.isDestroyed()) {
    win.webContents.send('lyric-offset', next);
    win.webContents.send('toast', { text: label + hint, key: 'offset' });
  }
  return next;
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const handlers = {
    panel: () => setPanel(!panelOpen),
    toggle: () => setLayerVisible(!layerVisible),
    layout: () => win && win.webContents.send('cycle-layout'),
    fit: () => setConfigValue({ autoFit: !config.autoFit }),
    offsetEarlier: () => nudgeLyricOffset(100),
    offsetLater: () => nudgeLyricOffset(-100),
    quit: () => app.quit(),
    prev: () => runControl('prev'),
    next: () => runControl('next'),
    playpause: () => runControl('toggle')
  };
  const userKeys = { ...DEFAULT_HOTKEYS, ...((config.hotkeys) || {}) };
  for (const [name, handler] of Object.entries(handlers)) {
    const accel = userKeys[name];
    let picked = '';
    if (accel) {
      picked = 'FAILED';
      try {
        if (globalShortcut.register(accel, handler)) picked = accel;
      } catch { /* occupied or malformed */ }
    }
    hotkeys[name] = picked;
  }
  console.log('[hotkeys]', JSON.stringify(hotkeys));
}

/** Rebind one hotkey. Returns {ok, registered} so the UI can flag conflicts. */
function setHotkey(action, accel) {
  if (!HOTKEY_ACTIONS.includes(action)) return { ok: false, reason: 'unknown-action' };
  const clean = String(accel || '').trim();
  config.hotkeys = { ...DEFAULT_HOTKEYS, ...(config.hotkeys || {}), [action]: clean };
  saveConfig();
  registerHotkeys();
  const registered = hotkeys[action];
  if (win && !win.isDestroyed()) win.webContents.send('config', config);
  return { ok: !clean || registered === clean, registered, hotkeys: { ...hotkeys } };
}

let trayRebuilds = 0;   // counts menu pops (instrumentation only)

/** Build the tray menu fresh. Called when the icon is clicked — never in advance. */
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'GlassLyrics', enabled: false },
    { type: 'separator' },
    { label: trayPanel && !trayPanel.isDestroyed() ? '关闭常驻菜单' : '打开常驻菜单',
      click: () => togglePinnedTray() },
    { type: 'separator' },
    { label: layerVisible ? '隐藏覆盖层' : '显示覆盖层', click: () => setLayerVisible(!layerVisible) },
    { label: panelOpen ? '收起主菜单' : '打开主菜单', click: () => setPanel(!panelOpen) },
    { type: 'separator' },
    { label: '歌词源', submenu: [
      { label: '自动（跟随播放器）', type: 'radio', checked: config.lyricSource === 'auto',
        click: () => setConfigValue({ lyricSource: 'auto' }) },
      { label: 'QQ 音乐优先', type: 'radio', checked: config.lyricSource === 'qqmusic',
        click: () => setConfigValue({ lyricSource: 'qqmusic' }) },
      { label: '网易云音乐优先', type: 'radio', checked: config.lyricSource === 'netease',
        click: () => setConfigValue({ lyricSource: 'netease' }) },
      { label: '酷狗音乐优先', type: 'radio', checked: config.lyricSource === 'kugou',
        click: () => setConfigValue({ lyricSource: 'kugou' }) },
      { label: 'LRCLIB 优先', type: 'radio', checked: config.lyricSource === 'lrclib',
        click: () => setConfigValue({ lyricSource: 'lrclib' }) },
      { type: 'separator' },
      { label: '关闭在线歌词', type: 'radio', checked: config.lyricSource === 'off',
        click: () => setConfigValue({ lyricSource: 'off' }) }
    ] },
    { type: 'separator' },
    {
      label: '自动捕捉游戏窗口', type: 'checkbox', checked: !!config.autoFit,
      click: (item) => setConfigValue({ autoFit: item.checked })
    },
    {
      label: '切出游戏时隐藏歌词', type: 'checkbox', checked: !!config.hideWhenNoGame,
      click: (item) => setConfigValue({ hideWhenNoGame: item.checked })
    },
    { type: 'separator' },
    {
      label: '开机自启', type: 'checkbox', checked: !!config.openAtLogin,
      click: (item) => setConfigValue({ openAtLogin: item.checked })
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
}

/* ---------------- persistent tray menu ----------------
 * Native menus are intentionally transient: the OS dismisses them on activation changes
 * and after every command. A separate small BrowserWindow is the only reliable way to
 * provide the requested persistent behaviour. Unlike the lyric overlay it is clickable
 * ONLY inside its own small bounds and has no blur auto-close handler. */
function trayPanelSnapshot() {
  const safeConfig = { ...config };
  delete safeConfig.spotifyClientSecret;
  return {
    config: safeConfig,
    layerVisible,
    panelOpen,
    pinned: !!(trayPanel && !trayPanel.isDestroyed()),
    track: lastSmtc && lastSmtc.active ? {
      title: lastSmtc.title || '', artist: lastSmtc.artist || '', status: lastSmtc.status || ''
    } : null
  };
}

function broadcastTrayPanel(force) {
  if (!trayPanel || trayPanel.isDestroyed() || !trayPanel.webContents || trayPanel.webContents.isDestroyed()) return;
  // Compute the cheap signature first. trayPanelSnapshot() copies the whole config and
  // strips credentials; building it on every 500ms playback tick only to throw it away
  // when the signature matched was pure waste. Only a real change builds the full state.
  const track = lastSmtc && lastSmtc.active
    ? [lastSmtc.title || '', lastSmtc.artist || '', lastSmtc.status || '']
    : null;
  const sig = JSON.stringify([
    config.lyricSource, config.autoFit, config.hideWhenNoGame, config.openAtLogin,
    layerVisible, panelOpen, !!(trayPanel && !trayPanel.isDestroyed()), track
  ]);
  if (!force && sig === trayPanelSignature) return; // no 500ms playback-poll rerenders
  trayPanelSignature = sig;
  trayPanel.webContents.send('tray-panel-state', trayPanelSnapshot());
}

function keepPinnedTrayAboveOverlay() {
  if (!trayPanel || trayPanel.isDestroyed() || !trayPanel.isVisible()) return;
  // The overlay may legitimately change z-order/bounds when a game is captured. Re-raise
  // only on those transitions, not on a heartbeat; showInactive never steals menu focus.
  try { trayPanel.showInactive(); } catch { /* best effort on older shells */ }
}

function trayPanelPosition(anchor, width, height) {
  const fallback = screen.getCursorScreenPoint();
  const a = anchor && Number.isFinite(anchor.x) && (anchor.width || anchor.height)
    ? anchor : { x: fallback.x, y: fallback.y, width: 0, height: 0 };
  const cx = a.x + (a.width || 0) / 2;
  const cy = a.y + (a.height || 0) / 2;
  const area = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) }).workArea;
  let x = Math.round(cx - width / 2);
  // Windows taskbar is usually at the bottom; macOS menu bar is at the top. If there is
  // not enough room, flip to the other side and finally clamp to the usable work area.
  let y = process.platform === 'win32'
    ? Math.round(a.y - height - 10)
    : Math.round(a.y + (a.height || 0) + 10);
  if (y < area.y) y = Math.round(a.y + (a.height || 0) + 10);
  if (y + height > area.y + area.height) y = Math.round(a.y - height - 10);
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - width - 8));
  y = Math.max(area.y + 8, Math.min(y, area.y + area.height - height - 8));
  return { x, y, width, height };
}

function closePinnedTray() {
  if (!trayPanel || trayPanel.isDestroyed()) return;
  const p = trayPanel;
  trayPanel = null;
  trayPanelSignature = '';
  try { p.close(); } catch { /* already closing */ }
  rebuildTray();
}

function openPinnedTray(anchor) {
  if (trayPanel && !trayPanel.isDestroyed()) {
    keepPinnedTrayAboveOverlay();
    return trayPanel;
  }
  const size = trayPanelPosition(anchor, 316, 568);
  trayPanel = new BrowserWindow({
    ...size,
    title: 'GlassLyricsTrayPanel',
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'tray-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  });
  trayPanel.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    try { trayPanel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* older macOS */ }
  }
  trayPanel.on('closed', () => {
    trayPanel = null;
    trayPanelSignature = '';
    rebuildTray();
  });
  trayPanel.webContents.on('did-finish-load', () => broadcastTrayPanel(true));
  trayPanel.loadFile(path.join(ROOT, 'tray-panel.html'));
  trayPanel.once('ready-to-show', () => {
    if (trayPanel && !trayPanel.isDestroyed()) trayPanel.show();
  });
  rebuildTray();
  return trayPanel;
}

function togglePinnedTray(anchor) {
  if (trayPanel && !trayPanel.isDestroyed()) closePinnedTray();
  else openPinnedTray(anchor);
}

/**
 * Refresh the tray tooltip only.
 *
 * This used to install a freshly built menu via tray.setContextMenu() on every state
 * change. On Windows that replaces the native menu handle, which DISMISSES a menu that is
 * currently open: right-clicking the tray icon showed the menu, then the 400ms window
 * probe flipped `layerVisible` (another app became foreground) and the menu vanished.
 * The menu is now constructed on demand in popupTrayMenu() and never replaced.
 */
let traySignature = '';
// Windows (and macOS) can build the menu at click time, which removes the whole
// "replacing an open menu closes it" class of bug. Linux AppIndicator menus are owned by
// the desktop shell, so there the menu must still be installed ahead of time.
const TRAY_ON_DEMAND = process.platform !== 'linux';
let trayFallback = false;   // set if popUpContextMenu ever fails on this system

function rebuildTray() {
  if (!tray) return;
  try {
    tray.setToolTip(`GlassLyrics · ${layerVisible ? '显示中' : '已隐藏'}${panelOpen ? ' · 菜单已打开' : ''}${trayPanel && !trayPanel.isDestroyed() ? ' · 常驻菜单已固定' : ''}`);
  } catch { /* tooltip is cosmetic */ }
  if (TRAY_ON_DEMAND && !trayFallback) return;
  const sig = JSON.stringify([layerVisible, panelOpen, config.lyricSource, config.autoFit,
    config.hideWhenNoGame, config.displayIndex, !!(trayPanel && !trayPanel.isDestroyed())]);
  if (sig === traySignature) return;
  traySignature = sig;
  try { tray.setContextMenu(buildTrayMenu()); } catch { /* tray is cosmetic */ }
}

function popupTrayMenu() {
  if (!tray) return;
  trayRebuilds++;
  try {
    tray.popUpContextMenu(buildTrayMenu());
  } catch (e) {
    // Old Electron / odd shells: fall back to the install-a-menu model for this session.
    console.error('[tray] menu failed, falling back:', e.message);
    trayFallback = true;
    traySignature = '';
    rebuildTray();
  }
}

function createTray() {
  let img = nativeImage.createFromPath(path.join(ROOT, trayIconName(process.platform)));
  if (img.isEmpty()) {
    // Last-resort inline 16×16 PNG so a missing icon never blocks startup on any OS.
    img = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR42u3OMQEAAAgDINc/9K3hWGSBVsQAAAABAAAAAAAKALgKwHcAAH9gQAAAABJRU5ErkJggg=='
    );
  }
  try {
    tray = new Tray(img);
    if (TRAY_ON_DEMAND) {
      // Right-click opens the persistent panel. Left-click keeps the familiar native menu,
      // whose first command can also open the persistent panel. No native menu is installed
      // in advance, so background state changes cannot dismiss one that is already open.
      tray.on('right-click', (_event, bounds) => togglePinnedTray(bounds));
      tray.on('click', popupTrayMenu);
    }
    rebuildTray();
  } catch (e) {
    // Linux desktops without AppIndicator support reject Tray creation. The overlay itself
    // must keep working (hotkeys still toggle the panel), so degrade instead of crashing.
    console.error('[tray] unavailable on this desktop:', e.message);
    tray = null;
  }
}

/* ---------------- auto-fit: follow the foreground game window ---------------- */

let lastFitPayload = '';
function broadcastFit() {
  // The probe fires every 400ms; sending an identical object would force a style pass in
  // the renderer for nothing. Compare first, send only on real change.
  const payload = JSON.stringify(autoFitState);
  if (payload !== lastFitPayload) {
    lastFitPayload = payload;
    if (win && !win.isDestroyed()) win.webContents.send('auto-fit', autoFitState);
  }
  // One-shot evidence for tools/verify_window_fit.py, written on the first probe result
  // regardless of whether a game was captured (so a failure is diagnosable too).
  if (!fitSmokeDone && loaded) {
    fitSmokeDone = true;
    const out = {
      ok: true, at: new Date().toISOString(),
      autoFit: autoFitState, appliedBounds: win.getBounds(),
      windowProbe: lastWindowInfo ? { rect: lastWindowInfo.rect, rectPhysical: lastWindowInfo.rectPhysical,
        title: lastWindowInfo.title, className: lastWindowInfo.className, process: lastWindowInfo.process } : null
    };
    const target = process.env.GL_FIT_OUT || path.join(USER_DIR, 'fit-smoke.json');
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(out, null, 2), 'utf8');
      console.log('[fit-smoke]', target);
    } catch (e) { console.error('[fit-smoke] write failed', e); }
  }
}

function resetToDisplay() {
  if (!win || win.isDestroyed()) return;
  const b = targetBounds();
  const bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
  if (!sameBounds(lastAppliedBounds, bounds)) {
    win.setBounds(bounds);
    lastAppliedBounds = bounds;
    keepPinnedTrayAboveOverlay();
  }
  autoFitState.active = false;
  autoFitState.bounds = bounds;
}

function applyWindowFit(info) {
  if (!win || win.isDestroyed() || !info || !info.rect) return;
  lastWindowInfo = info;
  const scale = displayScaleAt(info.rect[0], info.rect[1]);
  const cls = classifyForFit(info, scale);
  const r = toLogicalRect(info, scale);
  const wasActive = autoFitState.active;
  autoFitState = {
    active: false, reason: cls.reason, excluded: !!cls.excluded, ratio: cls.ratio ?? null,
    process: info.process, title: info.title, className: info.className,
    rect: r, bounds: lastAppliedBounds, scale
  };

  if (!config.autoFit) {
    autoFitState.reason = 'auto-fit-disabled';
    setTopLevel('screen-saver');
    resetToDisplay();
    setLayerVisible(true);
    broadcastFit();
    return;
  }

  // Opening the main menu (or clicking the overlay) makes our own HWND foreground.
  // That is NOT "the user left the game": keep the captured bounds and stay active,
  // otherwise the layer jumps back to full-screen every time the menu opens.
  if (cls.reason === 'self' && wasActive) {
    autoFitState.active = true;
    autoFitState.reason = 'captured-self-foreground';
    autoFitState.bounds = lastAppliedBounds;
    broadcastFit();
    return;
  }

  if (!cls.isGame) {
    // Not a game: stay in the lower band so other apps' menus/popups are never covered.
    setTopLevel('floating');
    // Never hide while the user is inside our own panel / drag mode: the menu is what they
    // are looking at, and hiding it reads as "the window closed by itself".
    if (config.hideWhenNoGame && !panelOpen && !editMode) {
      autoFitState.reason = cls.excluded ? 'excluded-by-config' : cls.reason;
      setLayerVisible(false);
    } else {
      resetToDisplay();
      setLayerVisible(true);
    }
    broadcastFit();
    return;
  }

  if (r[2] < config.minWindowWidth || r[3] < config.minWindowHeight) {
    autoFitState.reason = 'below-min-size';
    broadcastFit();
    return;
  }

  let d;
  try { d = screen.getDisplayMatching({ x: r[0], y: r[1], width: r[2], height: r[3] }); }
  catch { d = screen.getPrimaryDisplay(); }
  const db = d.bounds;
  const bx = Math.max(db.x, r[0]);
  const by = Math.max(db.y, r[1]);
  const bw = Math.min(r[0] + r[2], db.x + db.width) - bx;
  const bh = Math.min(r[1] + r[3], db.y + db.height) - by;
  if (bw < 320 || bh < 240) { broadcastFit(); return; }

  setTopLevel('screen-saver');   // a game is captured: stay above borderless fullscreen
  const bounds = { x: bx, y: by, width: bw, height: bh };
  if (!sameBounds(lastAppliedBounds, bounds)) {
    win.setBounds(bounds);
    lastAppliedBounds = bounds;
    keepPinnedTrayAboveOverlay();
    console.log('[fit]', info.process, JSON.stringify(bounds), cls.reason);
  }
  autoFitState.active = true;
  autoFitState.bounds = bounds;
  setLayerVisible(true);
  broadcastFit();
}

function startWindowProbe() {
  const b = BACKEND.window;
  windowProbe = spawn(b.cmd, b.args(b.script), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = '';
  windowProbe.stdout.setEncoding('utf8');
  windowProbe.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const d = parseWindowLine(line);
      if (!d) continue;
      if (d.ok && d.rect) {
        probeRestarts = 0;
        lastProbeError = '';
        applyWindowFit(d);
      } else if (d.error && d.error !== 'wayland-no-window-api' && d.error !== lastProbeError) {
        // Permission / missing-dependency errors repeat every 400ms — log once.
        lastProbeError = d.error;
        console.error('[winprobe]', d.error);
      }
    }
  });
  windowProbe.stderr.on('data', (d) => console.error('[winprobe]', d.toString().trim()));
  windowProbe.on('exit', (code) => {
    console.log('[winprobe] exit', code);
    windowProbe = null;
    if (quitting) return;
    // Backoff: a script that crashes immediately must not restart 40x/second.
    const delay = Math.min(15000, 1500 * Math.pow(2, Math.min(probeRestarts, 3)));
    probeRestarts++;
    setTimeout(startWindowProbe, delay);
  });
}

function setConfigValue(patch) {
  config = { ...config, ...(patch || {}) };
  saveConfig();
  if ('openAtLogin' in (patch || {})) applyLogin();
  if (win && !win.isDestroyed()) {
    win.webContents.send('config', config);
    if ('lyricOffsetMs' in (patch || {})) win.webContents.send('lyric-offset', config.lyricOffsetMs);
  }
  if ('lyricSource' in (patch || {})) refreshLyrics();
  if (['autoFit', 'hideWhenNoGame', 'excludeProcesses', 'displayIndex'].some((k) => k in (patch || {}))) {
    if (lastWindowInfo) applyWindowFit(lastWindowInfo);
  }
  rebuildTray();
  broadcastTrayPanel();
  return config;
}

function maybeSmoke(d) {
  // Diagnostics are opt-in. Production playback must not run three song searches, DOM
  // probes and a disk write merely because the first media sample arrived.
  if (!process.env.GL_SMOKE && !process.env.GL_SMOKE_OUT) return;
  if (smokeDone || !d.ok || !d.active || !loaded || !win || win.isDestroyed()) return;
  smokeDone = true;
  // window-probe.ps1 compiles a small C# helper on first launch (~2s). Wait for it so the
  // report carries real auto-fit state instead of "waiting".
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    // Async IIFE: the pick-search check goes through the real preload IPC bridge.
    const probe = `(async () => ({
      title: document.getElementById('pTitle').textContent,
      status: document.getElementById('pStatus').textContent,
      glyphs: document.querySelectorAll('#curGlyphs .glyph').length,
      panel: document.getElementById('panel').className,
      menuTab: document.body.dataset.menuTab || '',
      platform: document.getElementById('pPlatform') ? document.getElementById('pPlatform').textContent : '',
      cover: (() => { const c = document.getElementById('pCover');
        return c ? { hidden: c.hidden, hasSrc: !!c.src && c.src.startsWith('data:image'),
                     srcLen: c.src ? c.src.length : 0 } : null; })(),
      hotkeyRows: document.querySelectorAll('#hkList .hotkey').length,
      about: (() => {
        const v = document.getElementById('aboutVer');
        const p = document.getElementById('aboutPlat');
        const r = document.getElementById('aboutRecent');
        return {
          ver: v ? v.textContent : null,
          plat: p ? p.textContent : null,
          recentBlocks: r ? r.querySelectorAll('div').length : 0
        };
      })(),
      toastFn: typeof window.showToast === 'function',
      floatRows: typeof window.getfloatRows === 'function' ? window.getfloatRows() : null,
      writes: { ...(window.__w || {}) },
      click: window.glass ? await window.glass.getClickState() : null,
      pickPage: document.querySelectorAll('.page[data-page=pick]').length,
      pickSearch: window.glass
        ? await window.glass.searchSongs('孤勇者', 'qqmusic')
            .then((r) => (r && r.ok) ? ('ok:' + r.list.length) : ('err:' + (r && r.error)))
            .catch((e) => 'ex:' + e.message)
        : 'no-bridge',
      pickKugou: window.glass
        ? await window.glass.searchSongs('孤勇者', 'kugou')
            .then((r) => (r && r.ok) ? ('ok:' + r.list.length) : ('err:' + (r && r.error)))
            .catch((e) => 'ex:' + e.message)
        : 'no-bridge',
      pickApple: window.glass
        ? await window.glass.searchSongs('Blinding Lights', 'applemusic')
            .then((r) => (r && r.ok) ? ('ok:' + r.list.length) : ('err:' + (r && r.error)))
            .catch((e) => 'ex:' + e.message)
        : 'no-bridge',
      fitState: typeof window.getFitState === 'function' ? window.getFitState() : null,
      lyricSrc: document.getElementById('pLyricSrc').textContent,
      lyricState: typeof window.getLyricState === 'function' ? window.getLyricState() : null,
      glow: (() => { const g = document.querySelector('#curGlyphs .glyph');
        return g ? { shadow: getComputedStyle(g).textShadow,
                     hasBox: getComputedStyle(g).boxShadow,
                     afterMask: getComputedStyle(g, '::after').webkitMaskImage || getComputedStyle(g, '::after').maskImage } : null; })()
    }))()`;
    win.webContents.executeJavaScript(probe).then((dom) => {
      const out = {
        ok: true, at: new Date().toISOString(), electron: process.versions.electron,
        packaged: app.isPackaged, hotkeys,
        config: (() => { const safe = { ...config }; delete safe.spotifyClientSecret; return safe; })(),
        smtc: d, dom,
        winApi: { ...winCalls }, trayRebuilds,
        tray: (() => {
          try {
            const m = buildTrayMenu();
            return { present: !!tray, items: m.items.length,
                     lastState: layerVisible ? 'visible' : 'hidden' };
          } catch (e) { return { error: e.message }; }
        })(),
        autoFit: autoFitState,
        windowProbe: lastWindowInfo ? { rect: lastWindowInfo.rect, rectPhysical: lastWindowInfo.rectPhysical,
                                        title: lastWindowInfo.title, className: lastWindowInfo.className } : null,
        lyrics: lastLyrics ? { ok: lastLyrics.ok, source: lastLyrics.source,
          provider: lastLyrics.provider, wordSync: !!lastLyrics.wordSync,
          lines: (lastLyrics.lines || []).length, synced: lastLyrics.synced,
          cached: lastLyrics.cached, elapsedMs: lastLyrics.elapsedMs || 0,
          error: lastLyrics.error || null } : null
      };
      const target = process.env.GL_SMOKE_OUT || path.join(USER_DIR, 'app-smoke.json');
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(out, null, 2), 'utf8');
      } catch (e) { console.error('[smoke] write failed', e); }
      console.log('[smoke]', JSON.stringify(out));
      if (process.env.GL_SMOKE === '1') setTimeout(() => app.quit(), 1500);
    }).catch((e) => console.error('[smoke]', e));
  }, 2200);
}

/* ---------------- lyrics: platform-aware providers ---------------- */

function currentPlatformFor(d) {
  const forced = String(process.env.GL_FORCE_PLATFORM || '').toLowerCase();
  return forced || lyricsEngine.platformFromApp(d && d.app);
}

function ensureLyrics(d) {
  if (d) lastSmtc = d;
  if (!d || !d.ok || !d.active) return;
  currentPlatform = currentPlatformFor(d);
  if (effectiveLyricSource() === 'off') {
    if (win && !win.isDestroyed()) win.webContents.send('lyrics', { ok: false, error: 'lyrics-disabled' });
    return;
  }
  const key = lyricsEngine.trackKey(d);
  if (!key || key === '|') return;
  if (key === lastTrackKey && lastLyrics) return;
  if (lyricsInFlight && key === lyricsRequestKey) return;  // no repeated requests every 500ms
  lastTrackKey = key;
  lyricsRequestKey = key;
  lyricsInFlight = true;
  // Instant feedback: the old lyrics belong to the previous song — tell the UI we're fetching.
  if (win && !win.isDestroyed()) win.webContents.send('lyrics-loading', { title: d.title, artist: d.artist });

  lyricsEngine.fetchLyrics({
    title: d.title, artist: d.artist, album: d.album, duration: d.duration, app: d.app
  }, path.join(USER_DIR, 'lyrics-cache'), {
    preferred: effectiveLyricSource(),
    platform: currentPlatform
  }).then((r) => {
    if (lyricsRequestKey !== key) return;  // user skipped to another track; drop stale result
    lastLyrics = r;
    if (win && !win.isDestroyed()) win.webContents.send('lyrics', { ...r, offsetMs: config.lyricOffsetMs });
    console.log('[lyrics]', r.ok
      ? `${r.provider} · ${r.source} · ${r.lines.length} lines · wordSync=${r.wordSync} · ${r.elapsedMs || 0}ms`
      : `${r.error} (${r.elapsedMs || 0}ms)`);
  }).catch((e) => {
    console.error('[lyrics]', e);
    if (win && !win.isDestroyed()) win.webContents.send('lyrics', { ok: false, error: e.message });
  }).finally(() => {
    lyricsInFlight = false;
  });
}

/** Pre-open DNS+TLS to the lyric hosts so the first song of a session is not 200-400ms
 *  slower than the rest. Failures are silent: this is only a latency optimisation. */
function warmUpLyricHosts() {
  const hosts = [
    'https://c.y.qq.com/', 'https://music.163.com/', 'https://mobiles.kugou.com/',
    'https://itunes.apple.com/', 'https://lrclib.net/'
  ];
  setTimeout(() => {
    for (const u of hosts) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        // Clear the abort timer as soon as the probe settles. Otherwise five 4s timers
        // stay alive after every request has already finished.
        fetch(u, { method: 'HEAD', signal: ctrl.signal })
          .catch(() => {})
          .finally(() => clearTimeout(timer));
      } catch { /* ignore */ }
    }
  }, 2500);
}

function refreshLyrics() {
  lastTrackKey = '';
  lastLyrics = null;
  if (lastSmtc) ensureLyrics(lastSmtc);
}

function startBridge() {
  const b = BACKEND.media;
  bridge = spawn(b.cmd, b.args(b.script), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = '';
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let d = parseMediaLine(line);
      if (!d) continue;
      if (d.ok === false) {
        // Backend dependency missing (playerctl / Automation permission): surface once.
        if (d.error && d.error !== lastBackendError) {
          lastBackendError = d.error;
          console.error('[smtc] backend error:', d.error);
        }
        continue;
      }
      lastBackendError = '';
      bridgeRestarts = 0;
      // Test hook: pin a known track so the real-lyrics pipeline can be verified deterministically.
      const forcedTrack = String(process.env.GL_FORCE_TRACK || '');
      if (forcedTrack && d.active) {
        const [ft, fa, fd] = forcedTrack.split('|');
        d = { ...d, title: ft, artist: fa || '', album: '',
              duration: Number(fd) || 231, position: 12, status: 'PLAYING', statusValue: 3 };
      }
      if (win && !win.isDestroyed()) win.webContents.send('smtc', { ...d, platform: currentPlatformFor(d) });
      maybeSmoke(d);
      ensureLyrics(d);
      broadcastTrayPanel();
    }
  });
  bridge.stderr.on('data', (d) => console.error('[smtc]', d.toString().trim()));
  bridge.on('exit', (code) => {
    console.log('[smtc] bridge exit', code);
    bridge = null;
    if (quitting) return;
    const delay = Math.min(15000, 1500 * Math.pow(2, Math.min(bridgeRestarts, 3)));
    bridgeRestarts++;
    setTimeout(startBridge, delay);
  });
}

function runControl(action) {
  const a = normalizeAction(action);
  if (!a) return;
  const b = BACKEND.control;
  const p = spawn(b.cmd, b.args(b.script, a), { windowsHide: true });
  p.stdout.on('data', (d) => console.log('[control]', d.toString().trim()));
  p.stderr.on('data', (d) => console.error('[control]', d.toString().trim()));
}

ipcMain.handle('get-config', () => config);
ipcMain.handle('get-platform', () => currentPlatform);
ipcMain.handle('get-hotkeys', () => ({ ...hotkeys }));
ipcMain.handle('tray-panel-state', () => trayPanelSnapshot());
ipcMain.handle('tray-panel-config', (_e, { key, value } = {}) => {
  const sources = ['auto', 'qqmusic', 'netease', 'kugou', 'lrclib', 'off'];
  if (key === 'lyricSource' && sources.includes(value)) return setConfigValue({ lyricSource: value });
  if (['autoFit', 'hideWhenNoGame', 'openAtLogin'].includes(key)) return setConfigValue({ [key]: !!value });
  return config;
});
ipcMain.on('tray-panel-action', (_e, action) => {
  if (action === 'close') closePinnedTray();
  else if (action === 'toggle-layer') setLayerVisible(!layerVisible);
  else if (action === 'toggle-panel') setPanel(!panelOpen);
  else if (['prev', 'next', 'toggle'].includes(action)) runControl(action);
  else if (action === 'quit') app.quit();
});

/** Version + platform + the newest changelog entries, for the in-app About page.
 *  changelog.json is generated from CHANGELOG.md by tools/gen_changelog.mjs and shipped
 *  with the app, so the About page never shows a stale hardcoded version again. */
ipcMain.handle('app-info', () => {
  const info = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    recent: []
  };
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'changelog.json'), 'utf8');
    const doc = JSON.parse(raw);
    if (Array.isArray(doc.versions)) {
      info.recent = doc.versions.slice(0, 3).map((v) => ({
        version: v.version,
        date: v.date || '',
        highlights: (v.highlights || []).slice(0, 4)
      }));
    }
  } catch { /* changelog is optional at runtime */ }
  return info;
});
ipcMain.handle('set-hotkey', (_e, { action, accel }) => setHotkey(action, accel));
ipcMain.handle('set-config', (_e, patch) => setConfigValue(patch || {}));
ipcMain.handle('get-lyrics', () => lastLyrics);
// Pick page: text search on the public platform APIs, no account required.
ipcMain.handle('search-songs', async (_e, { query, platform }) => {
  try {
    const p = ['netease', 'kugou', 'applemusic', 'spotify', 'qishui'].includes(platform) ? platform : 'qqmusic';
    const creds = { clientId: config.spotifyClientId, clientSecret: config.spotifyClientSecret };
    const list = await lyricsEngine.searchSongs(query, p, creds);
    if (p === 'spotify' && !list.length && !config.spotifyClientId) {
      return { ok: false, error: 'spotify-needs-credentials', list: [] };
    }
    return { ok: true, list };
  } catch (e) {
    // 401/403 from Spotify means wrong/expired credentials — tell the user what to fix.
    const msg = String(e.message || '');
    const error = /spotify-token-(401|403)/.test(msg) ? 'spotify-bad-credentials' : msg;
    return { ok: false, error, list: [] };
  }
});
// There is no public "play this exact song" API. We try the client's own URL scheme to
// open its search page, and ALWAYS copy the song name so the user can paste it manually.
ipcMain.handle('play-song', async (_e, song) => {
  const text = `${song.title || ''} ${song.artist || ''}`.trim();
  if (!text) return { ok: false };
  clipboard.writeText(text);
  let deepLink = false;
  try {
    if (song.platform === 'netease') {
      await shell.openExternal('orpheus://search?q=' + encodeURIComponent(text));
      deepLink = true;
    } else if (song.platform === 'kugou') {
      await shell.openExternal('kugou://' + encodeURIComponent(text));
      deepLink = true;
    } else if (song.platform === 'spotify') {
      await shell.openExternal('spotify:search:' + encodeURIComponent(text));
      deepLink = true;
    } else if (song.platform === 'applemusic') {
      await shell.openExternal('music://music.apple.com/search?term=' + encodeURIComponent(text));
      deepLink = true;
    } else if (song.platform === 'qishui') {
      deepLink = false;    // no stable public URL scheme; clipboard fallback only
    } else {
      await shell.openExternal('qqmusic://qq.com/ui/search?w=' + encodeURIComponent(text));
      deepLink = true;
    }
  } catch { deepLink = false; }
  return { ok: true, copied: true, deepLink, text };
});
ipcMain.on('refresh-lyrics', () => refreshLyrics());
ipcMain.on('control', (_e, action) => runControl(action));
ipcMain.on('close-panel', () => setPanel(false));
ipcMain.on('set-edit-mode', (_e, on) => setEditMode(on));
// Safety net #3: renderer clicked outside the panel -> collapse it (next click hits the game).
ipcMain.on('dismiss-overlay', () => {
  if (panelOpen) setPanel(false);
  if (editMode) setEditMode(false);
});
ipcMain.on('quit-app', () => app.quit());
ipcMain.on('cycle-layout', () => win && win.webContents.send('cycle-layout'));
ipcMain.handle('get-click-state', () => ({
  clickThrough: lastIgnore === true, panelOpen, editMode,
  trayPanelPinned: !!(trayPanel && !trayPanel.isDestroyed())
}));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => setLayerVisible(true));
  app.whenReady().then(() => {
    // macOS: an overlay must not occupy the Dock or steal Cmd+Tab focus.
    if (process.platform === 'darwin' && app.dock) {
      try { app.dock.hide(); } catch { /* older mac builds */ }
    }
    createWindow();
    createTray();
    registerHotkeys();
    applyLogin();
    startBridge();
    startWindowProbe();
    if (process.env.GL_FORCE_MENU_OPEN === '1') setTimeout(() => setPanel(true), 1500);
    // Regression hook for the "overlay blocks game clicks" bug: open the panel (simulating a
    // stuck UI), then let the window probe force it closed when the game is foreground again.
    if (process.env.GL_TEST_STUCK === '1') {
      setTimeout(() => { setPanel(true); }, 2000);
      setTimeout(() => { setPanel(false); }, 3000);   // simulate "click outside panel"
      setTimeout(() => {
        const st = { panelOpen, editMode, clickThrough: lastIgnore === true };
        console.log('[stuck-test]', JSON.stringify(st));
        const target = process.env.GL_STUCK_OUT || path.join(USER_DIR, 'stuck-test.json');
        try { fs.writeFileSync(target, JSON.stringify(st, null, 2), 'utf8'); } catch (e) { console.error(e); }
        if (process.env.GL_SMOKE === '1') setTimeout(() => app.quit(), 300);
      }, 4500);
    }
    // Lyric-offset hotkey path: OS-level key dispatch cannot be synthesised from a
    // sandboxed test runner, so this exercises everything downstream of it — the nudge,
    // config persistence, the lyric-offset IPC and the toast text in the renderer —
    // then restores the user's original offset.
    // Persistent-tray regression: open the same panel used by tray right-click, force the
    // exact state updates that used to dismiss native menus, then verify it stays visible
    // and the fullscreen lyric window remains click-through.
    if (process.env.GL_TEST_TRAY_PIN === '1') {
      setTimeout(() => openPinnedTray(), 1800);
      setTimeout(() => {
        setLayerVisible(false);
        setLayerVisible(true);
        setConfigValue({ autoFit: !!config.autoFit, hideWhenNoGame: !!config.hideWhenNoGame });
        rebuildTray();
      }, 3000);
      setTimeout(async () => {
        const p = trayPanel;
        const state = {
          ok: !!(p && !p.isDestroyed() && p.isVisible()),
          visibleAfterRefresh: !!(p && !p.isDestroyed() && p.isVisible()),
          overlayClickThrough: lastIgnore === true && !panelOpen && !editMode,
          bounds: p && !p.isDestroyed() ? p.getBounds() : null,
          dom: null,
          closeVerified: false
        };
        if (p && !p.isDestroyed()) {
          try { state.dom = await p.webContents.executeJavaScript('window.getTrayPanelState()'); }
          catch (e) { state.dom = { error: e.message }; }
        }
        closePinnedTray();
        await new Promise((r) => setTimeout(r, 150));
        state.closeVerified = !trayPanel;
        state.ok = state.ok && state.overlayClickThrough && state.closeVerified &&
          !!(state.dom && state.dom.pinned);
        console.log('[tray-pin-test]', JSON.stringify(state));
        const target = process.env.GL_TRAY_PIN_OUT || path.join(USER_DIR, 'tray-pin-test.json');
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, JSON.stringify(state, null, 2), 'utf8');
        } catch (e) { console.error(e); }
        if (process.env.GL_TRAY_PIN_QUIT === '1') setTimeout(() => app.quit(), 200);
      }, 6500);
    }

    // Window-churn measurement: counts Win32 window calls (and tray rebuilds) during an
    // idle 8s window. A fullscreen always-on-top window must sit at 0 while nothing
    // changes — every extra call re-raises it above other apps' menus.
    if (process.env.GL_TEST_CHURN === '1') {
      setTimeout(async () => {
        const snap = () => ({ ...winCalls, tray: trayRebuilds });
        const a = snap();
        await new Promise((r) => setTimeout(r, 8000));
        const b = snap();
        const delta = {};
        for (const k of Object.keys(b)) delta[k] = b[k] - a[k];
        const st = { delta, before: a, after: b,
                     state: { layerVisible, panelOpen, editMode, clickThrough: lastIgnore, topLevel },
                     fit: { active: autoFitState.active, reason: autoFitState.reason },
                     win: lastWindowInfo ? { process: lastWindowInfo.process, title: lastWindowInfo.title,
                                             visible: lastWindowInfo.visible, minimized: lastWindowInfo.minimized,
                                             rect: lastWindowInfo.rect } : null };
        console.log('[churn-test]', JSON.stringify(st));
        const target = process.env.GL_CHURN_OUT || path.join(USER_DIR, 'churn-test.json');
        try { fs.writeFileSync(target, JSON.stringify(st, null, 2), 'utf8'); } catch (e) { console.error(e); }
        if (process.env.GL_CHURN_QUIT === '1') setTimeout(() => app.quit(), 300);
      }, 3500);
    }

    if (process.env.GL_TEST_OFFSET === '1') {
      setTimeout(async () => {
        const before = Number(config.lyricOffsetMs) || 0;
        const a = nudgeLyricOffset(100);
        const b = nudgeLyricOffset(100);
        const read = async (js) => {
          try { return await win.webContents.executeJavaScript(js); } catch { return null; }
        };
        // The toast IPC and executeJavaScript travel on different channels; give the
        // last toast a moment to land before reading it back.
        await new Promise((r) => setTimeout(r, 200));
        const toastText = await read("document.getElementById('toast').textContent");
        const toastShown = await read("document.getElementById('toast').classList.contains('show')");
        const state = { before, step1: a, step2: b, toastText, toastShown, persisted: null, restored: null };
        try {
          const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
          state.persisted = Number(onDisk.lyricOffsetMs);
        } catch { /* ignore */ }
        state.restored = nudgeLyricOffset(before - b);
        console.log('[offset-test]', JSON.stringify(state));
        const target = process.env.GL_OFFSET_OUT || path.join(USER_DIR, 'offset-test.json');
        try { fs.writeFileSync(target, JSON.stringify(state, null, 2), 'utf8'); } catch (e) { console.error(e); }
        // GL_OFFSET_QUIT lets this run standalone so it never races the smoke probe's quit.
        if (process.env.GL_OFFSET_QUIT === '1') setTimeout(() => app.quit(), 300);
      }, 3200);
    }
    // Heartbeat: alt-tab / focus churn can silently drop the click-through flag.
    setInterval(ensureClickThrough, 2000);
    warmUpLyricHosts();
    console.log('[app] ready', TITLE);
  });
}

app.on('will-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  if (bridge) { try { bridge.kill(); } catch { /* already gone */ } }
  if (windowProbe) { try { windowProbe.kill(); } catch { /* already gone */ } }
});
