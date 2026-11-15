'use strict';
/**
 * "Is the foreground window a game?" — pure logic, no Electron imports.
 *
 * Kept separate from main.js so it can be unit-tested (tools/verify_classify.mjs).
 * The heuristic is deliberately conservative about *what a game looks like* and
 * aggressive about known desktop apps: a false positive makes the overlay clamp onto
 * some other program and sit above its menus, which is far more annoying than missing
 * the auto-fit for an unusual game (the user can still use whole-screen mode).
 */

// Definitely-not-a-game processes (lowercase, no .exe).
const NON_GAME_PROCESSES = new Set([
  // shells / terminals / editors
  'explorer', 'workbuddy', 'code', 'cursor', 'devenv', 'idea64', 'pycharm64', 'webstorm64',
  'sublime_text', 'powershell', 'pwsh', 'cmd', 'windowsterminal', 'conhost', 'notepad',
  'taskmgr', 'regedit', 'mmc', 'applicationframehost', 'searchapp', 'searchhost',
  'shellexperiencehost', 'startmenuexperiencehost', 'systemsettings',
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
const NON_GAME_PATTERN = /(overlay|nvcontainer|nvsphelper|nvidia\s*share|radeon|gamebar|launcher|updater|installer|webhelper)/;

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

const SELF_PROCESSES = new Set(['glasslyrics', 'glasslyrics-portable', 'electron']);

/**
 * @param {{ok:boolean, process?:string, title?:string, desktop?:boolean,
 *          minimized?:boolean, visible?:boolean}} info  probe payload
 * @param {{rect?:number[], display?:{width:number,height:number}, minW?:number, minH?:number,
 *          exclude?:string[], forced?:string}} ctx
 * @returns {{isGame:boolean, ratio:number|null, reason:string, excluded?:boolean}}
 */
function classifyWindow(info, ctx) {
  const { rect, display, minW = 640, minH = 400, exclude = [], forced = '' } = ctx || {};
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
  if (NON_GAME_PROCESSES.has(p) || NON_GAME_PROCESSES.has(bare)) {
    return { isGame: false, ratio: null, reason: 'non-game-app' };
  }
  if (NON_GAME_PATTERN.test(p)) {
    return { isGame: false, ratio: null, reason: 'overlay-or-launcher' };
  }

  const excluded = (exclude || []).some((x) => {
    const n = String(x || '').toLowerCase().replace(/\.exe$/, '').trim();
    return n && (n === p || n === bare);
  });
  if (excluded) return { isGame: false, ratio: null, excluded: true, reason: 'excluded-by-config' };

  const w = Array.isArray(rect) ? rect[2] : 0;
  const h = Array.isArray(rect) ? rect[3] : 0;
  if (!(w >= minW && h >= minH)) return { isGame: false, ratio: null, reason: 'too-small' };
  if (!display || !display.width || !display.height) {
    return { isGame: false, ratio: null, reason: 'display-lookup-failed' };
  }

  const ratio = (w * h) / (display.width * display.height);
  const hinted = GAME_HINTS.some((k) => p.includes(k)) ||
    /minecraft|terraria|elden ring|sekiro|dark souls/i.test(String(info.title || ''));
  const isGame = hinted || ratio >= 0.72 || (ratio >= 0.5 && !info.title);
  return {
    isGame,
    ratio: +ratio.toFixed(3),
    reason: hinted ? 'process-hint' : (isGame ? 'large-window' : 'small-or-captioned')
  };
}

module.exports = { classifyWindow, NON_GAME_PROCESSES, NON_GAME_PATTERN, GAME_HINTS };
