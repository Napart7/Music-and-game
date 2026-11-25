'use strict';
/**
 * "Is the foreground window a game?" — pure logic, no Electron imports.
 *
 * Kept separate from main.js so it can be unit-tested (tools/verify_classify.mjs).
 *
 * An area-only rule cannot tell a borderless game from a fullscreen IME candidate window,
 * an input-method helper, a GPU overlay or a maximised editor: all of them fill the screen
 * and have no title bar. Windows therefore also reports the window class, caption style
 * and tool-window flag, and those signals are used as *hard vetoes* before geometry is
 * considered. macOS/Linux probes do not report them, so every shape rule fires only on
 * an explicit value and the geometry fallback stays exactly as it was on those platforms.
 *
 * Bias: a false positive makes the overlay clamp onto another program and cover its menus.
 * Missing the auto-fit for an unusual game is recoverable (whole-screen mode still works).
 */

// Definitely-not-a-game processes (lowercase, no .exe).
const NON_GAME_PROCESSES = new Set([
  // shells / terminals / editors
  'explorer', 'workbuddy', 'code', 'cursor', 'devenv', 'idea64', 'pycharm64', 'webstorm64',
  'sublime_text', 'powershell', 'pwsh', 'cmd', 'windowsterminal', 'conhost', 'notepad',
  'taskmgr', 'regedit', 'mmc', 'applicationframehost', 'searchapp', 'searchhost',
  'shellexperiencehost', 'startmenuexperiencehost', 'systemsettings',
  // OS input / text services: their candidate windows are fullscreen and borderless
  'textinputhost', 'ctfmon', 'chsime', 'microsoftime', 'imebroker', 'inputmethod',
  'sogousmartassistant', 'sogouime', 'sogoucloud', 'sogoutool', 'qqpinyin', 'baiduime',
  'msctf', 'tabletinputservice', 'ttvoice',
  // browsers
  'chrome', 'chrome_proxy', 'msedge', 'firefox', 'opera', 'brave', 'vivaldi', 'arc',
  '360se', '360chrome', 'qqbrowser', 'sogouexplorer', '2345explorer', 'liebao', 'maxthon',
  // music / media
  'qqmusic', 'cloudmusic', 'spotify', 'applemusic', 'itunes', 'music', 'microsoftmediaplayer',
  'vlc', 'potplayermini', 'potplayermini64', 'mpc-hc', 'mpc-hc64', 'mpc-be', 'foobar2000',
  'aimp', 'bilibili', 'douyin',
  // chat / meeting
  'wechat', 'weixin', 'wechatapp', 'wecom', 'wxwork', 'qq', 'qqnt', 'qqprotect', 'tim',
  'discord', 'telegram', 'slack', 'feishu', 'lark', 'dingtalk', 'zoom', 'teams', 'skype', 'zalo',
  // office / creative
  'wps', 'et', 'wpp', 'excel', 'winword', 'powerpnt', 'outlook', 'onenote', 'msaccess', 'visio',
  'acrobat', 'photoshop', 'illustrator', 'premiere', 'afterfx', 'notion', 'typora', 'obsidian',
  // capture / streaming / GPU panels (these are fullscreen AND topmost — worst offenders)
  'obs', 'obs32', 'obs64', 'streamlabs', 'snipaste', 'snippingtool', 'sharex',
  'nvidia overlay', 'nvidia share', 'nvidiashare', 'nvcontainer', 'nvsphelper64', 'nvapp',
  'amdow', 'amdow64', 'radeonsoftware', 'gamebar', 'gamebarftserver', 'xboxgamebar',
  // launchers / stores
  'steam', 'steamwebhelper', 'wegame', 'epicgameslauncher', 'battle.net', 'origin',
  'eadesktop', 'ubisoftconnect', 'uplay', 'galaxyclient', 'riotclientservices',
  // misc utilities
  'thunder', 'baidunetdisk', '7zfm', 'everything', 'ccleaner', 'electron'
]);

// Fallback pattern for overlay/launcher/updater style names we did not enumerate.
const NON_GAME_PATTERN = /(overlay|nvcontainer|nvsphelper|nvidia\s*share|radeon|gamebar|launcher|updater|installer|webhelper|smartassistant|inputhost|imebroker)/;

// Known game executables (substring match). Unknown games still match via window geometry
// or an engine window class. Deliberately no bare `javaw` / `unity` / `unreal`: those are
// runtimes and editors too, and would claim every Java or engine-based desktop app.
const GAME_HINTS = [
  'terraria', 'eldenring', 'sekiro', 'darksouls', 'liesofp', 'warframe', 'minecraft',
  'hollow_knight', 'hades', 'stardew', 'valheim', 'cyberpunk', 'witcher', 'palworld', 'helldivers',
  'rdr2', 'gtav', 'gta5', 'cs2', 'dota2', 'pathofexile', 'baldursgate', 'bg3', 'monsterhunter',
  'nierautomata', 'celeste', 'deadcells', 'riskofrain', 'factorio', 'rimworld', 'satisfactory',
  'subnautica', 'raft', '7daystodie', 'arma', 'rust', 'genshin', 'honkai', 'zenless', 'wuthering',
  'arknights', 'rpgmaker', 'noita', 'slaythespire', 'balatro', 'brotato',
  'teardown', 'beamng', 'assetto', 'forza', 'eu4', 'ck3', 'hoi4', 'stellar', 'civilization',
  'totalwar', 'mountandblade', 'bannerlord', 'vampiresurvivors', 'deeprock', 'helldivers2'
];

// OS shell, input-method, status and GPU-overlay window classes. Reported by
// window-probe.ps1; absent on macOS/Linux (the geometry fallback covers those).
const SYSTEM_CLASS_PATTERN =
  /(windows\.ui\.|corewindow|progman|workerw|shell_traywnd|thumbnaildevice|sopy_|sg_ichat|ime(candidate|wnd|window|ui)|ctf(mon|ime|wnd)|tooltips_class32|#32768|cef-osc-widget|nvidia|dwm)/i;

// Desktop application UI frameworks. A Chromium/Qt/WPF window is an app even when
// maximised to the whole screen with its title bar hidden by the shell.
const APP_CLASS_PATTERN =
  /(chrome_widgetwin|qt\d+qwindowicon|qt5qwindow|qwindowicon|windows\.forms|hwndwrapper|wpf|xlmain|opusapp|wordwindowclass|sunawtframe|standardwindow|taoquick)/i;

// Game engine / runtime window classes: positive evidence even for a windowed game
// whose process name is not in GAME_HINTS.
const GAME_CLASS_PATTERN =
  /(unitywndclass|unrealwindow|unrealclient|glfw|sdl_app|valve001|godot|ogre|irrlicht|allegro|love2d|vulkanwindow)/i;

// Document / web-page style titles. Games use plain names; a document extension or
// " - <known app>" suffix belongs to a desktop application.
const DOC_TITLE_PATTERN =
  /\.(docx?|xlsx?|pptx?|pdf|txt|md|csv|json|xml|log|zip|rar|7z|mp4|mkv|avi|png|jpe?g|psd|ai|exe|msi)(\s|$|\)|[-—])/i;
const APP_SUFFIX_TITLE_PATTERN =
  /\s+[-—]\s+(microsoft|google|visual studio|workbuddy|notion|obsidian|edge|chrome|firefox|photoshop|premiere|obs\b|steam|epic|battle\.net|微信|qq|wps|office|word|excel|powerpoint)/i;
const SYSTEM_TITLE_PATTERN = /(主窗口|输入体验|资源管理器|此电脑|回收站|命令提示符|任务管理器)/;

const SELF_PROCESSES = new Set(['glasslyrics', 'glasslyrics-portable', 'electron']);

/** Match a process name (with or without .exe) against a user-supplied list. */
function inList(list, p, bare) {
  return (list || []).some((x) => {
    const n = String(x || '').toLowerCase().replace(/\.exe$/, '').trim();
    return n && (n === p || n === bare);
  });
}

/**
 * @param {{ok:boolean, process?:string, title?:string, className?:string,
 *          caption?:boolean, toolWindow?:boolean, thickFrame?:boolean,
 *          desktop?:boolean, minimized?:boolean, visible?:boolean}} info  probe payload
 * @param {{rect?:number[], display?:{width:number,height:number}, minW?:number, minH?:number,
 *          exclude?:string[], allow?:string[], forced?:string}} ctx
 * @returns {{isGame:boolean, ratio:number|null, reason:string, excluded?:boolean}}
 */
function classifyWindow(info, ctx) {
  const { rect, display, minW = 640, minH = 400, exclude = [], allow = [], forced = '' } = ctx || {};
  if (!info || !info.ok) return { isGame: false, ratio: null, reason: 'no-window' };
  const p = String(info.process || '').toLowerCase();
  const bare = p.replace(/\.exe$/, '');
  if (info.desktop || info.minimized || !info.visible) {
    return { isGame: false, ratio: null, reason: 'desktop-or-hidden' };
  }

  // Test hooks (env GL_FORCE_GAME_PROCESS): '*' = any window, else a process name.
  if (forced === '*') return { isGame: true, ratio: null, reason: 'forced-any' };
  const f = String(forced || '').toLowerCase().replace(/\.exe$/, '');
  if (f && (p === f || bare === f)) return { isGame: true, ratio: null, reason: 'forced-by-test' };

  if (SELF_PROCESSES.has(p) || SELF_PROCESSES.has(bare)) {
    return { isGame: false, ratio: null, reason: 'self' };
  }
  // An explicit "this is my game" list outranks the built-in tables: small indie titles,
  // launchers renamed by the user and captioned windowed games are all recoverable here.
  const allowed = inList(allow, p, bare);
  if (!allowed) {
    if (NON_GAME_PROCESSES.has(p) || NON_GAME_PROCESSES.has(bare)) {
      return { isGame: false, ratio: null, reason: 'non-game-app' };
    }
    if (NON_GAME_PATTERN.test(p)) {
      return { isGame: false, ratio: null, reason: 'overlay-or-launcher' };
    }
  }

  // Exclusion is a "never show lyrics here" intent, so it wins over the allow list too.
  if (inList(exclude, p, bare)) {
    return { isGame: false, ratio: null, excluded: true, reason: 'excluded-by-config' };
  }

  const w = Array.isArray(rect) ? rect[2] : 0;
  const h = Array.isArray(rect) ? rect[3] : 0;
  if (!(w >= minW && h >= minH)) return { isGame: false, ratio: null, reason: 'too-small' };
  if (!display || !display.width || !display.height) {
    return { isGame: false, ratio: null, reason: 'display-lookup-failed' };
  }

  /* ---- Windows shape vetoes: only when the probe actually reported the field ---- */
  const cls = String(info.className || '').toLowerCase();
  const title = String(info.title || '');
  const ratio = (w * h) / (display.width * display.height);
  // OS helpers / GPU overlays are never game windows, even if the owning process was
  // allow-listed (an IME candidate can belong to the same process as the game).
  if (info.toolWindow === true) {
    return { isGame: false, ratio: null, reason: 'tool-window' };
  }
  if (cls && SYSTEM_CLASS_PATTERN.test(cls)) {
    return { isGame: false, ratio: null, reason: 'system-window-class' };
  }
  if (allowed) return { isGame: true, ratio: +ratio.toFixed(3), reason: 'allowlisted-game' };

  // Match a whole process token (or the start of a longer one) instead of a bare
  // substring: 'rust' must not claim RustDesk, 'arma' must not claim an ARM utility.
  const tokens = bare.split(/[^a-z0-9]+/).filter(Boolean);
  const hinted = GAME_HINTS.some((k) => tokens.some((t) =>
    t === k || (k.length >= 5 && t.startsWith(k)))) ||
    /minecraft|terraria|elden ring|sekiro|dark souls|hollow knight/i.test(title);
  // Strong positive evidence wins over application-framework vetoes: a known game may
  // still use Chromium/Qt for its launcher overlays, and old Java Minecraft builds use
  // SunAwtFrame. Tool windows and OS classes above are never overridden.
  if (hinted) return { isGame: true, ratio: +ratio.toFixed(3), reason: 'process-hint' };
  if (cls && GAME_CLASS_PATTERN.test(cls)) {
    return { isGame: true, ratio: +ratio.toFixed(3), reason: 'game-window-class' };
  }
  if (cls && APP_CLASS_PATTERN.test(cls)) {
    return { isGame: false, ratio: null, reason: 'app-window-class' };
  }
  if (DOC_TITLE_PATTERN.test(title) || APP_SUFFIX_TITLE_PATTERN.test(title) ||
      SYSTEM_TITLE_PATTERN.test(title)) {
    return { isGame: false, ratio: null, reason: 'app-title' };
  }
  // A standard title bar belongs to a desktop app. An unknown, captioned window is never
  // claimed just because it was maximised. Windowed games with a caption are still found
  // by the process hint or engine class above.
  if (info.caption === true) {
    return { isGame: false, ratio: +ratio.toFixed(3), reason: 'captioned-app' };
  }
  const isGame = ratio >= 0.72 || (ratio >= 0.5 && !title);
  return {
    isGame,
    ratio: +ratio.toFixed(3),
    reason: isGame ? 'large-window' : 'small-or-captioned'
  };
}

module.exports = {
  classifyWindow, NON_GAME_PROCESSES, NON_GAME_PATTERN, GAME_HINTS,
  SYSTEM_CLASS_PATTERN, APP_CLASS_PATTERN, GAME_CLASS_PATTERN,
  DOC_TITLE_PATTERN, APP_SUFFIX_TITLE_PATTERN, SYSTEM_TITLE_PATTERN
};
