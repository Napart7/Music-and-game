#!/usr/bin/env node
/**
 * Window-classification contract tests (no Electron needed).
 *
 * Regression guard for the v1.4.1 bug: "opening another app made the overlay clamp onto it
 * and cover its menus". The overlay must never claim a window that belongs to a known
 * desktop app, an OS/GPU overlay, a launcher, or a game launcher's web helper.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { classifyWindow, NON_GAME_PROCESSES, NON_GAME_PATTERN } = require(path.join(ROOT, 'app', 'window-classify.js'));

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

/** Screen used by most cases: 1920x1080. */
const SCREEN = { width: 1920, height: 1080 };
const win = (process, opts = {}) => ({
  ok: true, visible: true, minimized: false, desktop: false,
  process, title: opts.title === undefined ? 'Some Window' : opts.title, ...opts
});
const ctx = (rect, extra = {}) => ({ rect, display: SCREEN, exclude: [], forced: '', ...extra });

/* ---------------- desktop apps must never be captured ---------------- */
for (const p of ['QQ', 'QQNT', 'QQProtect', 'WeChat', 'Weixin', 'TIM', 'thunder', 'Photoshop',
                 'vlc', 'PotPlayerMini64', 'bilibili', 'msedge', 'chrome', 'idea64']) {
  const r = classifyWindow(win(p), ctx([0, 0, 1920, 1080]));
  check(`桌面应用不吸附：${p}`, r.isGame === false, r.reason);
}

/* ---------------- OS / GPU overlays (fullscreen + topmost) ---------------- */
for (const p of ['NVIDIA Overlay', 'NVIDIA Share', 'nvcontainer', 'nvsphelper64',
                 'GameBar', 'XboxGameBar', 'amdow', 'RadeonSoftware']) {
  const r = classifyWindow(win(p), ctx([0, 0, 1920, 1080]));
  check(`系统/显卡覆盖层不吸附：${p}`, r.isGame === false, r.reason);
}

/* ---------------- launchers and their web helpers ---------------- */
for (const p of ['steam', 'steamwebhelper', 'wegame', 'EpicGamesLauncher', 'Battle.net',
                 'SomeUpdater', 'MyLauncher']) {
  const r = classifyWindow(win(p), ctx([0, 0, 1920, 1080]));
  check(`启动器不吸附：${p}`, r.isGame === false, r.reason);
}

/* ---------------- real games still work ---------------- */
for (const [p, detail] of [['eldenring', 'large'], ['Warframe.x64', 'large'],
                           ['Terraria', 'windowed'], ['Minecraft.Windows', 'windowed']]) {
  const rect = detail === 'large' ? [0, 0, 1920, 1080] : [400, 200, 1200, 700];
  const r = classifyWindow(win(p, { title: 'Game' }), ctx(rect));
  check(`游戏能识别：${p}`, r.isGame === true, `${r.reason} ratio=${r.ratio}`);
}

/* ---------------- geometry heuristics ---------------- */
let r = classifyWindow(win('SomeUnknownGame', { title: 'Whatever' }), ctx([0, 0, 1920, 1080]));
check('未知进程全屏 -> 视作游戏', r.isGame === true && r.reason === 'large-window', JSON.stringify(r));

r = classifyWindow(win('SomeUnknownApp', { title: '' }), ctx([0, 0, 1400, 800]));  // 54% of screen
check('无标题过半屏窗口 -> 视作游戏', r.isGame === true, JSON.stringify(r));

r = classifyWindow(win('SomeUnknownApp', { title: '迅雷' }), ctx([253, 183, 1201, 701]));
check('有标题的中等窗口 -> 不吸附', r.isGame === false && r.reason === 'small-or-captioned', JSON.stringify(r));

r = classifyWindow(win('SomeUnknownApp', { title: 'x' }), ctx([0, 0, 1920, 1040]));
check('几乎全屏 -> 视作游戏', r.isGame === true, JSON.stringify(r));

r = classifyWindow(win('SomeUnknownApp', { title: 'x' }), ctx([0, 0, 300, 200]));
check('过小窗口 -> 不吸附', r.isGame === false && r.reason === 'too-small', JSON.stringify(r));

/* ---------------- state guards ---------------- */
r = classifyWindow(win('eldenring', { minimized: true }), ctx([0, 0, 1920, 1080]));
check('最小化窗口 -> 不吸附', r.isGame === false && r.reason === 'desktop-or-hidden', JSON.stringify(r));

r = classifyWindow(win('eldenring', { visible: false }), ctx([0, 0, 1920, 1080]));
check('不可见窗口 -> 不吸附', r.isGame === false, JSON.stringify(r));

r = classifyWindow(win('explorer', { desktop: true }), ctx([0, 0, 1920, 1080]));
check('桌面 -> 不吸附', r.isGame === false, JSON.stringify(r));

r = classifyWindow({ ok: false }, ctx(null));
check('探针失焦 -> 不吸附', r.isGame === false && r.reason === 'no-window', JSON.stringify(r));

r = classifyWindow(win('GlassLyrics'), ctx([0, 0, 1920, 1080]));
check('自身窗口 -> 不吸附', r.isGame === false && r.reason === 'self', JSON.stringify(r));

/* ---------------- user exclusion list ---------------- */
r = classifyWindow(win('AnyGame'), ctx([0, 0, 1920, 1080], { exclude: ['AnyGame.exe'] }));
check('排除列表生效（带 .exe）', r.isGame === false && r.excluded === true, JSON.stringify(r));

r = classifyWindow(win('AnyGame'), ctx([0, 0, 1920, 1080], { exclude: ['anygame'] }));
check('排除列表生效（小写无后缀）', r.isGame === false && r.excluded === true, JSON.stringify(r));

/* ---------------- test hooks ---------------- */
r = classifyWindow(win('whatever'), ctx([10, 10, 100, 100], { forced: '*' }));
check('测试钩子 * 强制为游戏', r.isGame === true && r.reason === 'forced-any', JSON.stringify(r));

r = classifyWindow(win('QQ'), ctx([0, 0, 1920, 1080], { forced: 'qq' }));
check('强制钩子优先于黑名单', r.isGame === true, JSON.stringify(r));

/* ---------------- no display info ---------------- */
r = classifyWindow(win('Unknown'), { rect: [0, 0, 1920, 1080], display: null, minW: 320, minH: 240 });
check('拿不到显示器信息 -> 不吸附', r.isGame === false && r.reason === 'display-lookup-failed', JSON.stringify(r));

/* ---------------- table sanity ---------------- */
check('黑名单规模合理（>80）', NON_GAME_PROCESSES.size > 80, 'size=' + NON_GAME_PROCESSES.size);
check('覆盖层正则匹配 nvidia overlay', NON_GAME_PATTERN.test('nvidia overlay'));
check('覆盖层正则不误伤普通游戏', !NON_GAME_PATTERN.test('eldenring'));

/* ---------------- v1.5.4: window shape signals (Windows only) ---------------- */
// The old area-only rule claimed any borderless fullscreen window. These are real
// Win32 shapes captured from this machine; an explicit field is required for each veto,
// so macOS/Linux payloads keep the geometry fallback.
const shape = (o = {}) => ({
  ok: true, visible: true, minimized: false, desktop: false,
  process: 'UnknownHost', title: 'Some Window', className: '',
  caption: false, toolWindow: false, thickFrame: false, ...o
});
const FULL = [0, 0, 1920, 1080];
const shapeCtx = (extra = {}) => ctx(FULL, extra);

r = classifyWindow(shape({ process: 'UnknownCoreHost', className: 'Windows.UI.Core.CoreWindow',
  title: 'Windows 输入体验' }), shapeCtx());
check('输入法全屏窗口 -> 系统窗口类否决', r.isGame === false && r.reason === 'system-window-class', JSON.stringify(r));

r = classifyWindow(shape({ process: 'UnknownGpuPanel', className: 'CEF-OSC-WIDGET',
  toolWindow: true }), shapeCtx());
check('显卡覆盖层工具窗口 -> 否决', r.isGame === false && r.reason === 'tool-window', JSON.stringify(r));

r = classifyWindow(shape({ process: 'FancyApp', className: 'Chrome_WidgetWin_1',
  caption: true }), shapeCtx());
check('最大化的 Chromium 应用 -> 应用窗口类否决', r.isGame === false && r.reason === 'app-window-class', JSON.stringify(r));

r = classifyWindow(shape({ process: 'MysteryApp', caption: true }), shapeCtx());
check('未知但带标题栏的窗口 -> 否决', r.isGame === false && r.reason === 'captioned-app', JSON.stringify(r));

r = classifyWindow(shape({ title: '2026 年度报告.docx - WPS' }), shapeCtx());
check('文档标题 -> 应用标题否决', r.isGame === false && r.reason === 'app-title', JSON.stringify(r));

r = classifyWindow(shape({ title: '项目设置 - Visual Studio' }), shapeCtx());
check('应用后缀标题 -> 否决', r.isGame === false && r.reason === 'app-title', JSON.stringify(r));

r = classifyWindow(shape({ process: 'IndieTitle', className: 'UnityWndClass', caption: true }),
  ctx([200, 100, 1200, 700]));
check('Unity 窗口化游戏 -> 引擎类正向识别', r.isGame === true && r.reason === 'game-window-class', JSON.stringify(r));

r = classifyWindow(shape({ process: 'EldenRing', className: 'Chrome_WidgetWin_1', caption: true }), shapeCtx());
check('已知游戏优先于应用框架否决', r.isGame === true && r.reason === 'process-hint', JSON.stringify(r));

r = classifyWindow(shape({ process: 'RustDesk', title: 'RustDesk' }), ctx([200, 100, 1200, 700]));
check('进程名按整词匹配，RustDesk 不会被 rust 误认', r.isGame === false && r.reason !== 'process-hint', JSON.stringify(r));

r = classifyWindow(shape({ process: 'ARMUtility', title: 'ARM Utility' }), ctx([200, 100, 1200, 700]));
check('短游戏名不做子串匹配（arma）', r.isGame === false && r.reason !== 'process-hint', JSON.stringify(r));

/* ---------------- v1.5.4: user allow list ---------------- */
r = classifyWindow(shape({ process: 'MyIndieGame', className: 'Chrome_WidgetWin_1', caption: true }),
  shapeCtx({ allow: ['MyIndieGame.exe'] }));
check('白名单：带标题栏的独立游戏可强制跟随', r.isGame === true && r.reason === 'allowlisted-game', JSON.stringify(r));

r = classifyWindow(shape({ process: 'notion', caption: true }),
  shapeCtx({ allow: ['notion'] }));
check('白名单优先于内置黑名单', r.isGame === true, JSON.stringify(r));

r = classifyWindow(shape({ process: 'MyIndieGame', toolWindow: true }),
  shapeCtx({ allow: ['MyIndieGame'] }));
check('白名单不覆盖工具窗口硬否决', r.isGame === false && r.reason === 'tool-window', JSON.stringify(r));

r = classifyWindow(shape({ process: 'MyIndieGame' }),
  shapeCtx({ allow: ['MyIndieGame'], exclude: ['MyIndieGame.exe'] }));
check('跳过名单优先于白名单', r.isGame === false && r.excluded === true, JSON.stringify(r));

r = classifyWindow(shape({ process: 'MyIndieGame' }), ctx([10, 10, 100, 100], { allow: ['MyIndieGame'] }));
check('白名单仍受最小尺寸约束', r.isGame === false && r.reason === 'too-small', JSON.stringify(r));

r = classifyWindow(shape({ process: 'GlassLyrics' }), shapeCtx({ allow: ['GlassLyrics'] }));
check('白名单不会把自身窗口当游戏', r.isGame === false && r.reason === 'self', JSON.stringify(r));

r = classifyWindow(shape({ process: 'BrandNewApp', className: 'Chrome_WidgetWin_1',
  title: 'BrandNewApp' }), shapeCtx());
check('未收录的新应用全屏窗口 -> 应用框架类否决',
  r.isGame === false && r.reason === 'app-window-class', JSON.stringify(r));

/* ---------------- v1.5.4: probe -> parser -> classifier chain ---------------- */
const { parseWindowLine } = require(path.join(ROOT, 'app', 'backends', 'parse.js'));
const probeLine = JSON.stringify({ ok: true, rect: [0, 0, 1707, 1067],
  process: 'UnknownCoreHost', className: 'Windows.UI.Core.CoreWindow', title: 'Windows 输入体验',
  caption: false, toolWindow: false, thickFrame: false, visible: true, minimized: false, desktop: false });
const parsed = parseWindowLine(probeLine);
check('探针解析保留 caption/toolWindow/thickFrame',
  parsed.caption === false && parsed.toolWindow === false && parsed.thickFrame === false,
  JSON.stringify(parsed));
r = classifyWindow(parsed, { rect: parsed.rect, display: { width: 1707, height: 1067 }, minW: 320, minH: 240 });
check('端到端：全屏输入法窗口经真实链路被否决',
  r.isGame === false && r.reason === 'system-window-class', JSON.stringify(r));

const boolCaption = parseWindowLine(JSON.stringify({ ok: true, rect: FULL,
  process: 'FancyApp', title: '', caption: true, toolWindow: false, visible: true }));
check('布尔 caption 不会被写成标题 "true"', boolCaption.title === '' && boolCaption.caption === true,
  JSON.stringify(boolCaption));
r = classifyWindow(boolCaption, ctx(FULL));
check('端到端：带标题栏的空标题应用被否决',
  r.isGame === false && r.reason === 'captioned-app', JSON.stringify(r));

const crossPlatform = parseWindowLine(JSON.stringify({ ok: true, rect: FULL,
  process: 'Unknown', className: '', title: 'Whatever', visible: true, minimized: false, desktop: false }));
check('macOS/Linux 负载不产生窗口样式字段',
  !('caption' in crossPlatform) && !('toolWindow' in crossPlatform), JSON.stringify(crossPlatform));
r = classifyWindow(crossPlatform, ctx(FULL));
check('跨平台回退到几何判定', r.isGame === true && r.reason === 'large-window', JSON.stringify(r));

/* ---------------- v1.5.4: real foreground windows captured on this machine ---------------- */
// Screen was 1707x1067 logical DIPs at 150% scaling. A misclassification here is exactly
// what the user sees: the overlay clamping onto a browser, an IME or a GPU overlay.
const REAL_SCREEN = { width: 1707, height: 1067 };
const REAL = [
  ['TextInputHost', 'Windows.UI.Core.CoreWindow', 'Windows 输入体验', [0, 0, 1707, 1067], 0, 0, false],
  ['NVIDIA Overlay', 'CEF-OSC-WIDGET', 'NVIDIA GeForce Overlay', [0, 0, 1706, 1067], 0, 1, false],
  ['explorer', 'Progman', 'Program Manager', [0, 0, 1707, 1067], 0, 1, false],
  ['explorer', 'Shell_TrayWnd', '', [0, 1065, 1707, 52], 0, 1, false],
  ['WorkBuddy', 'Chrome_WidgetWin_1', 'WorkBuddy', [218, 100, 1114, 738], 1, 0, false],
  ['QQ', 'Chrome_WidgetWin_1', 'Start Genshi…等6个会话', [383, 201, 1141, 667], 1, 0, false],
  ['steamwebhelper', 'SDL_app', 'Steam', [0, 0, 158, 26], 1, 0, false],
  ['Warframe.x64', 'WarframePublicEvolutionGfxD3D11', 'Warframe', [78, 47, 1564, 949], 1, 0, true]
];
let realGames = 0;
for (const [process, className, title, rect, caption, toolWindow, expected] of REAL) {
  const info = { ok: true, visible: true, minimized: false, desktop: false,
    process, className, title, caption: !!caption, toolWindow: !!toolWindow };
  const got = classifyWindow(info, { rect, display: REAL_SCREEN, minW: 320, minH: 240 });
  if (got.isGame) realGames++;
  check(`真机窗口：${process} / ${className} ${expected ? '应跟随' : '不跟随'}`,
    got.isGame === expected, `${got.reason} ratio=${got.ratio}`);
}
check('真机采样中恰好 1 个窗口是游戏', realGames === 1, 'count=' + realGames);

/* ---------------- source-level anti-drift guards ---------------- */
// A classifier that never receives the probe fields is dead code. These three files must
// keep the whole chain wired; behaviour tests above also run on a synthetic payload.
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const probeSrc = readSrc('app/window-probe.ps1');
const parseSrc = readSrc('app/backends/parse.js');
const mainSrc = readSrc('app/main.js');
check('探针输出 className / caption / toolWindow / thickFrame',
  /className\s*=/.test(probeSrc) && /caption\s*=/.test(probeSrc) &&
  /toolWindow\s*=/.test(probeSrc) && /thickFrame\s*=/.test(probeSrc));
check('探针读取 WS_EX_TOOLWINDOW 样式位', /WS_EX_TOOLWINDOW|0x00000080/.test(probeSrc));
check('解析器转发窗口样式字段且隔离旧版字符串 caption',
  /\['caption', 'toolWindow', 'thickFrame'\]/.test(parseSrc) && /legacyTitle/.test(parseSrc));
check('主进程把用户白名单传给分类器', /allow:\s*config\.gameProcesses/.test(mainSrc));
check('主进程在白名单变化时重新判定', /'gameProcesses'/.test(mainSrc));

let pass = 0;
for (const c of checks) {
  if (c.ok) pass++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`);
}
console.log(`\n${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
