#!/usr/bin/env node
/**
 * Window-classification contract tests (no Electron needed).
 *
 * Regression guard for the v1.4.1 bug: "opening another app made the overlay clamp onto it
 * and cover its menus". The overlay must never claim a window that belongs to a known
 * desktop app, an OS/GPU overlay, a launcher, or a game launcher's web helper.
 */
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

let pass = 0;
for (const c of checks) {
  if (c.ok) pass++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`);
}
console.log(`\n${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
