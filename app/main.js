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

// Definitely-not-a-game processes. Anything unrecognised but fullscreen/borderless is
// still treated as a game by the heuristic below, so an unknown single-player game works too.
const NON_GAME_PROCESSES = new Set([
  'explorer', 'workbuddy', 'code', 'cursor', 'chrome', 'msedge', 'firefox', 'opera', 'brave',
  'vivaldi', 'powershell', 'pwsh', 'cmd', 'windowsterminal', 'conhost', 'notepad', 'qqmusic',
  'cloudmusic', 'wechat', 'weixin', 'qq', 'discord', 'telegram', 'slack', 'feishu', 'dingtalk',
  'wps', 'et', 'wpp', 'excel', 'winword', 'powerpnt', 'outlook', 'obs64', 'spotify',
  'steamwebhelper', 'electron', 'glasslyrics', 'devenv', 'idea64', 'pycharm64', 'webstorm64',
  'sublime_text', 'applicationframehost', 'searchapp', 'shellexperiencehost', 'taskmgr',
  'regedit', 'mmc', 'chrome_proxy', 'zalo', 'tim'
]);

// Known game executables (substring match). Unknown games still match via window geometry.
const GAME_HINTS = [
  'terraria', 'eldenring', 'sekiro', 'darksouls', 'liesofp', 'warframe', 'javaw', 'minecraft',
  'hollow_knight', 'hades', 'stardew', 'valheim', 'cyberpunk', 'witcher', 'palworld', 'helldivers',
  'rdr2', 'gtav', 'gta5', 'cs2', 'dota2', 'pathofexile', 'baldursgate', 'bg3', 'monsterhunter',
  'nierautomata', 'celeste', 'deadcells', 'riskofrain', 'factorio', 'rimworld', 'satisfactory',
  'subnautica', 'raft', '7daystodie', 'arma', 'rust', 'genshin', 'honkai', 'zenless', 'wuthering',
  'arknights', 'rpgmaker', 'unity', 'unreal', 'noita', 'slaythespire', 'balatro', 'brotato',
  'teardown', 'beamng', 'assetto', 'forza', 'eu4', 'ck3', 'hoi4', 'stellar', 'civilization',
  'totalwar', 'mountandblade', 'bannerlord', 'vampiresurvivors', 'deeprock', 'helldivers2'
];

let win = null;
let tray = null;
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

function classifyWindow(info, scale) {
  if (!info || !info.ok) return { isGame: false, reason: 'no-window' };
  const p = String(info.process || '').toLowerCase();
  if (info.desktop || info.minimized || !info.visible) return { isGame: false, reason: 'desktop-or-hidden' };
  // Test hook: force a given foreground process to be treated as a game (no effect in normal use).
  const forced = String(process.env.GL_FORCE_GAME_PROCESS || '').toLowerCase().replace(/\.exe$/, '');
  if (forced && (p === forced || p.replace(/\.exe$/, '') === forced)) {
    return { isGame: true, ratio: null, reason: 'forced-by-test' };
  }
  if (p === 'glasslyrics' || p === 'electron') return { isGame: false, reason: 'self' };
  if (NON_GAME_PROCESSES.has(p)) return { isGame: false, reason: 'non-game-app' };
  const excluded = (config.excludeProcesses || []).some((x) => {
    const n = String(x).toLowerCase().replace(/\.exe$/, '');
    return n === p || n === p.replace(/\.exe$/, '');
  });
  if (excluded) return { isGame: false, excluded: true, reason: 'excluded-by-config' };

  const r = toLogicalRect(info, scale);
  const w = r[2], h = r[3];
  if (w < 320 || h < 240) return { isGame: false, reason: 'too-small' };
  try {
    const d = screen.getDisplayMatching({ x: r[0], y: r[1], width: w, height: h });
    const ratio = (w * h) / (d.bounds.width * d.bounds.height);
    const hinted = GAME_HINTS.some((k) => p.includes(k)) ||
                   /minecraft|terraria|elden ring|sekiro|dark souls/i.test(String(info.title || ''));
    const isGame = hinted || ratio >= 0.72 || (ratio >= 0.5 && !info.title);
    return { isGame, ratio: +ratio.toFixed(3),
             reason: hinted ? 'process-hint' : (isGame ? 'large-window' : 'small-or-captioned') };
  } catch {
    return { isGame: false, reason: 'display-lookup-failed' };
  }
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('[config] save failed', e);
  }
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
    }
  });
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    loaded = true;
    win.webContents.send('config', config);
  });
}

/* ---------------- click-through state machine ----------------
 * The overlay is a full-screen window: "clickable" is window-wide, so a panel or drag
 * mode left open swallows EVERY click on the screen (the reported "can't click the game"
 * bug). Every state change goes through applyClickThrough(), and there are three safety
 * nets: window blur, the window-probe heartbeat (game becomes foreground), and a click
 * outside the panel closing it. */
let lastIgnore = null;
function applyClickThrough(force) {
  if (!win || win.isDestroyed()) return;
  const clickable = panelOpen || editMode;
  if (!force && lastIgnore === !clickable) return;      // avoid redundant Win32 calls
  win.setIgnoreMouseEvents(!clickable, { forward: true });
  win.setFocusable(clickable);
  lastIgnore = !clickable;
}

/** Re-assert transparency periodically. Windows/Electron can lose the click-through flag
 *  after focus changes (alt-tab out and back) — that is the "overlay eats my clicks" bug. */
function ensureClickThrough() {
  if (!win || win.isDestroyed() || panelOpen || editMode) return;
  applyClickThrough(true);
}

function setPanel(on) {
  panelOpen = !!on;
  if (!win || win.isDestroyed()) return;
  applyClickThrough();
  win.webContents.send('panel', panelOpen);
  rebuildTray();
}

function setEditMode(on) {
  editMode = !!on;
  if (!win || win.isDestroyed()) return;
  if (editMode && panelOpen) panelOpen = false;   // lyrics must be visible & draggable
  applyClickThrough();
  win.webContents.send('panel', panelOpen);
  win.webContents.send('edit-mode', editMode);
}

function setLayerVisible(on) {
  on = !!on;
  // The window probe polls every 400ms; avoid hide/show churn (and tray rebuilds) when unchanged.
  if (layerVisible === on) return;
  layerVisible = on;
  if (!win || win.isDestroyed()) return;
  if (layerVisible) win.show();
  else win.hide();
  win.webContents.send('visible', layerVisible);
  // A freshly shown window may come back as clickable — re-assert transparency.
  applyClickThrough(true);
  rebuildTray();
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const handlers = {
    panel: () => setPanel(!panelOpen),
    toggle: () => setLayerVisible(!layerVisible),
    layout: () => win && win.webContents.send('cycle-layout'),
    fit: () => setConfigValue({ autoFit: !config.autoFit }),
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

function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'GlassLyrics', enabled: false },
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
  ]));
  tray.setToolTip('GlassLyrics · 不注入游戏进程');
}

function createTray() {
  let img = nativeImage.createFromPath(path.join(ROOT, trayIconName(process.platform)));
  if (img.isEmpty()) {
    // Last-resort inline 16×16 PNG so a missing icon never blocks startup on any OS.
    img = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR42u3OMQEAAAgDINc/9K3hWGSBVsQAAAABAAAAAAAKALgKwHcAAH9gQAAAABJRU5ErkJggg=='
    );
  }
  tray = new Tray(img);
  rebuildTray();
}

/* ---------------- auto-fit: follow the foreground game window ---------------- */

function broadcastFit() {
  if (win && !win.isDestroyed()) win.webContents.send('auto-fit', autoFitState);
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
  }
  autoFitState.active = false;
  autoFitState.bounds = bounds;
}

function applyWindowFit(info) {
  if (!win || win.isDestroyed() || !info || !info.rect) return;
  lastWindowInfo = info;
  const scale = displayScaleAt(info.rect[0], info.rect[1]);
  const cls = classifyWindow(info, scale);
  const r = toLogicalRect(info, scale);
  const wasActive = autoFitState.active;
  autoFitState = {
    active: false, reason: cls.reason, excluded: !!cls.excluded, ratio: cls.ratio ?? null,
    process: info.process, title: info.title, className: info.className,
    rect: r, bounds: lastAppliedBounds, scale
  };

  if (!config.autoFit) {
    autoFitState.reason = 'auto-fit-disabled';
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
    if (config.hideWhenNoGame) {
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

  const bounds = { x: bx, y: by, width: bw, height: bh };
  if (!sameBounds(lastAppliedBounds, bounds)) {
    win.setBounds(bounds);
    lastAppliedBounds = bounds;
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
      if (d.ok && d.rect) applyWindowFit(d);
      else if (d.error && d.error !== 'wayland-no-window-api') console.error('[winprobe]', d.error);
    }
  });
  windowProbe.stderr.on('data', (d) => console.error('[winprobe]', d.toString().trim()));
  windowProbe.on('exit', (code) => {
    console.log('[winprobe] exit', code);
    windowProbe = null;
    if (!quitting) setTimeout(startWindowProbe, 1500);
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
  return config;
}

function maybeSmoke(d) {
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
        packaged: app.isPackaged, hotkeys, config, smtc: d, dom,
        autoFit: autoFitState,
        windowProbe: lastWindowInfo ? { rect: lastWindowInfo.rect, rectPhysical: lastWindowInfo.rectPhysical,
                                        title: lastWindowInfo.title, className: lastWindowInfo.className } : null,
        lyrics: lastLyrics ? { ok: lastLyrics.ok, source: lastLyrics.source,
          provider: lastLyrics.provider, wordSync: !!lastLyrics.wordSync,
          lines: (lastLyrics.lines || []).length, synced: lastLyrics.synced,
          cached: lastLyrics.cached, error: lastLyrics.error || null } : null
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
  if (!d || !d.ok || !d.active) return;
  lastSmtc = d;
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

  lyricsEngine.fetchLyrics({
    title: d.title, artist: d.artist, album: d.album, duration: d.duration, app: d.app
  }, path.join(USER_DIR, 'lyrics-cache'), {
    preferred: effectiveLyricSource(),
    platform: currentPlatform
  }).then((r) => {
    if (lyricsRequestKey !== key) return;  // user skipped to another track; drop stale result
    lastLyrics = r;
    if (win && !win.isDestroyed()) win.webContents.send('lyrics', { ...r, offsetMs: config.lyricOffsetMs });
    console.log('[lyrics]', r.ok ? `${r.provider} · ${r.source} · ${r.lines.length} lines · wordSync=${r.wordSync}` : r.error);
  }).catch((e) => {
    console.error('[lyrics]', e);
    if (win && !win.isDestroyed()) win.webContents.send('lyrics', { ok: false, error: e.message });
  }).finally(() => {
    lyricsInFlight = false;
  });
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
    }
  });
  bridge.stderr.on('data', (d) => console.error('[smtc]', d.toString().trim()));
  bridge.on('exit', (code) => {
    console.log('[smtc] bridge exit', code);
    bridge = null;
    if (!quitting) setTimeout(startBridge, 1500);
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
  } catch (e) { return { ok: false, error: e.message, list: [] }; }
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
ipcMain.handle('get-click-state', () => ({ clickThrough: lastIgnore === true, panelOpen, editMode }));

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
    // Heartbeat: alt-tab / focus churn can silently drop the click-through flag.
    setInterval(ensureClickThrough, 2000);
    console.log('[app] ready', TITLE);
  });
}

app.on('will-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  if (bridge) { try { bridge.kill(); } catch { /* already gone */ } }
  if (windowProbe) { try { windowProbe.kill(); } catch { /* already gone */ } }
});
