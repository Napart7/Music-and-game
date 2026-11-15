// Regression test for renderer-side auto-fit (no Electron needed).
// Loads app/renderer/index.html in headless Edge and calls the exposed fit functions directly.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { ROOT, resolveEdge, toFileUrl, profileDir, CHROMIUM_ARGS } from './cdp-env.mjs';

const EDGE = resolveEdge();
const FILE_URL = toFileUrl(path.join(ROOT, 'app', 'renderer', 'index.html'));
const PROFILE = profileDir('fit');
const PORT = 9334;

const proc = spawn(EDGE, [
  ...CHROMIUM_ARGS,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1600,1000', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
// Surface launch failures (missing libs / container issues) instead of a bare "CDP not ready".
let browserErr = '';
proc.stderr.on('data', (d) => { browserErr += d.toString(); if (browserErr.length > 4000) browserErr = browserErr.slice(-4000); });
proc.on('exit', (code) => { if (code) console.error('[browser] exited', code, browserErr.slice(-600)); });

let ws = null;
const pending = new Map();
const errors = [];
let seq = 0;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 10000);
  });
}

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  }
  return r.result?.result?.value;
}

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

try {
  let target = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!target) throw new Error('CDP endpoint not ready' + (browserErr ? ' :: ' + browserErr.slice(-300) : ''));

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: FILE_URL });

  let ready = 0;
  for (let i = 0; i < 100; i++) {
    ready = await ev("document.querySelectorAll('#curGlyphs .glyph').length").catch(() => 0);
    if (ready > 0) break;
    await sleep(150);
  }
  await sleep(500);
  check('覆盖层逐字 Glyph 已渲染', ready > 0, `glyphs = ${ready}`);

  const defaultScale = await ev("getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim()");
  check('默认 UI 缩放为 1', defaultScale === '1', `--ui-scale = ${defaultScale}`);

  // Simulate a captured 1707x1067 game window.
  const big = await ev(`window.applyAutoFit({active:true, process:'Terraria', reason:'process-hint',
    rect:[0,0,1707,1067], bounds:{x:0,y:0,width:1707,height:1067}, scale:1.5})`);
  check('大窗口缩放为 1.000', big.scale === '1.000', `scale = ${big.scale}`);
  check('大窗口不进紧凑模式', big.compact === '0', `compact = ${big.compact}`);
  const noHud = await ev("document.getElementById('hud') === null && document.getElementById('fit') === null");
  check('画面无状态胶囊且内部仍记录捕捉', noHud === true && big.state === 'captured', `noHud=${noHud} state=${big.state}`);
  check('捕捉成功时不淡出', big.dimmed === false, `dimmed = ${big.dimmed}`);
  const pFitBig = await ev("document.getElementById('pFit').textContent");
  check('面板显示跟随中', /1707×1067 跟随中/.test(pFitBig), `pFit = ${pFitBig}`);

  // Simulate a small windowed game.
  const small = await ev(`window.applyAutoFit({active:true, process:'Terraria', reason:'process-hint',
    rect:[100,80,1024,640], bounds:{x:100,y:80,width:1024,height:640}, scale:1.5})`);
  check('小窗口自动缩小 UI', parseFloat(small.scale) < 1, `scale = ${small.scale}`);
  check('小窗口进入紧凑模式', small.compact === '1', `compact = ${small.compact}`);
  await ev("document.body.dataset.compact='0'");
  const normalSideW = parseFloat(await ev("getComputedStyle(document.querySelector('.side.left')).width"));
  await ev("document.body.dataset.compact='1'");
  const compactSideW = parseFloat(await ev("getComputedStyle(document.querySelector('.side.left')).width"));
  check('紧凑模式侧栏收窄', compactSideW < normalSideW, `${normalSideW}px -> ${compactSideW}px`);

  // Ultra-wide: scale must be clamped.
  const wide = await ev(`window.applyAutoFit({active:true, process:'EldenRing', reason:'large-window',
    rect:[0,0,3840,1600], bounds:{x:0,y:0,width:3840,height:1600}, scale:1})`);
  check('超宽窗口缩放有上限', parseFloat(wide.scale) <= 1.25, `scale = ${wide.scale}`);
  check('超宽窗口不进紧凑模式', wide.compact === '0');

  // Non-game foreground, auto-hide disabled -> dim instead of hard cut.
  await ev("window.syncConfig({hideWhenNoGame:false, autoFit:true, openAtLogin:false, layout:'split'})");
  const noGame = await ev(`window.applyAutoFit({active:false, reason:'non-game-app', process:'WorkBuddy',
    rect:[0,0,1707,1067], bounds:{x:0,y:0,width:1707,height:1067}, scale:1.5})`);
  check('切出游戏且未开自动隐藏时淡出', noGame.dimmed === true, `dimmed = ${noGame.dimmed}`);
  check('未捕捉时状态记为 idle', noGame.state === 'idle', `state = ${noGame.state}`);

  // Auto-hide enabled -> no dim (main process hides the whole window).
  await ev("window.syncConfig({hideWhenNoGame:true, autoFit:true, openAtLogin:true, layout:'center'})");
  const hidden = await ev(`window.applyAutoFit({active:false, reason:'non-game-app', process:'WorkBuddy',
    rect:[0,0,1707,1067], bounds:{x:0,y:0,width:1707,height:1067}, scale:1.5})`);
  check('开自动隐藏时不再淡出', hidden.dimmed === false, `dimmed = ${hidden.dimmed}`);

  // Excluded process (anti-cheat preference).
  const excluded = await ev(`window.applyAutoFit({active:false, excluded:true, reason:'excluded-by-config',
    process:'Warframe.x64', rect:[0,0,1707,1067], bounds:{x:0,y:0,width:1707,height:1067}, scale:1.5})`);
  check('排除窗口状态记为 excluded', excluded.state === 'excluded', `state = ${excluded.state}`);

  // Config sync to checkboxes.
  const boxes = await ev(`({
    autoFit: document.getElementById('autoFit').checked,
    hideNoGame: document.getElementById('hideNoGame').checked,
    autoStart: document.getElementById('autoStart').checked
  })`);
  check('自动捕捉勾选框同步', boxes.autoFit === true);
  check('切出隐藏勾选框同步', boxes.hideNoGame === true);
  check('开机自启勾选框同步', boxes.autoStart === true);

  // Central safe zone must stay clear in both normal and compact modes.
  const overlap = async () => ev(`(() => {
    const W = window.innerWidth, H = window.innerHeight;
    const a = { left: W*0.35, right: W*0.65, top: H*0.28, bottom: H*0.72 };
    const l = document.querySelector('.side.left').getBoundingClientRect();
    const r = document.querySelector('.side.right').getBoundingClientRect();
    const hit = (b) => !(a.left >= b.right || a.right <= b.left || a.top >= b.bottom || a.bottom <= b.top);
    return { left: hit(l), right: hit(r) };
  })()`);
  await ev("document.body.dataset.layout='split'; document.body.dataset.compact='0'");
  const o1 = await overlap();
  check('常规布局中央区不被歌词压住', !o1.left && !o1.right, JSON.stringify(o1));
  await ev("document.body.dataset.compact='1'");
  const o2 = await overlap();
  check('紧凑布局中央区仍留空', !o2.left && !o2.right, JSON.stringify(o2));

  check('运行期无 JS 异常', errors.length === 0, errors.join(' | ') || 'none');
} catch (e) {
  check('测试执行未中断', false, String(e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  try { proc.kill(); } catch { /* ignore */ }
}

let pass = 0;
for (const c of checks) {
  if (c.ok) pass++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`);
}
console.log(`\n${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
