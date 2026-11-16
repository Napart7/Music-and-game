#!/usr/bin/env node
/**
 * Regression contract for the "line shatter" lyric effect.
 *
 * Goes through the REAL tick() path (applyTrack -> estimatePosition -> line change)
 * rather than calling renderLine() directly, so launchShatterGhosts() is exercised
 * exactly as it is in production.
 *
 * Checks: default off, off = zero ghosts, on = ghosts with a CSS flight animation,
 * ghosts auto-clean (no DOM leak), turning it off again stops it, no JS exceptions.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { ROOT, resolveEdge, toFileUrl, profileDir, CHROMIUM_ARGS } from './cdp-env.mjs';

const EDGE = resolveEdge();
const FILE_URL = toFileUrl(path.join(ROOT, 'app', 'renderer', 'index.html'));
const PROFILE = profileDir('shatter');
const PORT = 9342;

const proc = spawn(EDGE, [
  ...CHROMIUM_ARGS,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1600,1000', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

let browserErr = '';
proc.stderr.on('data', (d) => { browserErr += d.toString(); if (browserErr.length > 4000) browserErr = browserErr.slice(-4000); });

let ws = null;
const pending = new Map();
const errors = [];
let seq = 0;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 12000);
  });
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
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
    } catch { /* endpoint not up yet */ }
    await sleep(250);
  }
  if (!target) throw new Error('CDP endpoint not ready' + (browserErr ? ' :: ' + browserErr.slice(-300) : ''));

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
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
  check('渲染层已就绪', ready > 0, `glyphs=${ready}`);

  // Real word-synced lyrics with three line boundaries at 0 / 4 / 8 seconds.
  await ev(`window.applyLyrics({ ok:true, provider:'测试源', source:'test-yrc', wordSync:true, lines:[
    { time:0, text:'都是勇敢的', words:[{s:0,e:1},{s:1,e:2},{s:2,e:3},{s:3,e:4},{s:4,e:5}] },
    { time:4, text:'你额头的伤口', words:[{s:4,e:5},{s:5,e:6},{s:6,e:7},{s:7,e:8}] },
    { time:8, text:'你的不同 你犯的错', words:[] }
  ]})`);
  await ev("window.applyTrack({ status:'PLAYING', position:2, duration:200 })");
  await sleep(220);   // let tick() light up some characters (lastP > 0)

  const toggle = await ev("document.querySelector('[data-cfg=shatter]')");
  check('视觉页存在破碎开关', toggle !== null && toggle !== undefined);
  const defaultOff = await ev("document.querySelector('[data-cfg=shatter]').checked === false");
  check('破碎默认关闭，不影响低配机', defaultOff === true);

  // OFF: a line change must not create a single ghost node.
  await ev("window.applyTrack({ status:'PLAYING', position:6, duration:200 })");
  await sleep(140);
  const offGhosts = await ev("document.querySelectorAll('.shatter-ghost').length");
  check('关闭时换行零 DOM 开销', offGhosts === 0, `containers=${offGhosts}`);

  // ON through the real config path (checkbox -> input -> writeCfg -> cfg.shatter).
  await ev(`(() => {
    const c = document.querySelector('[data-cfg=shatter]');
    c.checked = true; c.dispatchEvent(new Event('input'));
  })()`);
  const cfgOn = await ev("document.querySelector('[data-cfg=shatter]').checked === true");
  check('开关写入渲染层配置', cfgOn === true);
  await sleep(220);   // light up the new line before the next boundary

  await ev("window.applyTrack({ status:'PLAYING', position:10, duration:200 })");
  await sleep(140);
  const onGhosts = await ev("document.querySelectorAll('.shatter-glyph').length");
  check('开启时换行生成飞散碎片', onGhosts > 0, `ghosts=${onGhosts}`);
  const containers = await ev("document.querySelectorAll('.shatter-ghost').length");
  check('整行只有一次 DOM 插入', containers === 1, `containers=${containers}`);
  const anim = await ev("(() => { const g=document.querySelector('.shatter-glyph'); return g ? getComputedStyle(g).animationName : ''; })()");
  check('碎片由 CSS 合成动画驱动', anim === 'shatter-fly', `animation=${anim}`);
  const positioned = await ev("(() => { const g=document.querySelector('.shatter-glyph'); return g ? getComputedStyle(g).position : ''; })()");
  check('碎片绝对定位，不撑动布局', positioned === 'absolute', `position=${positioned}`);

  // Auto cleanup: longest ghost = 80ms delay + 500ms duration, container dies at 620ms.
  await sleep(760);
  const leaked = await ev("document.querySelectorAll('.shatter-ghost').length");
  check('动画结束自动清理，无 DOM 泄漏', leaked === 0, `containers=${leaked}`);

  // Turning it off again must immediately stop creating ghosts.
  await ev(`(() => {
    const c = document.querySelector('[data-cfg=shatter]');
    c.checked = false; c.dispatchEvent(new Event('input'));
  })()`);
  await sleep(220);
  await ev("window.applyTrack({ status:'PLAYING', position:2, duration:200 })");
  await sleep(140);
  const offAgain = await ev("document.querySelectorAll('.shatter-ghost').length");
  check('再次关闭后立即停止破碎', offAgain === 0, `containers=${offAgain}`);

  check('运行期无 JS 异常', errors.length === 0, errors.length ? errors.slice(0, 2).join(' | ') : 'none');
} catch (e) {
  check('测试执行完成', false, e.message);
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  try { proc.kill(); } catch { /* ignore */ }
}

let pass = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`);
  if (c.ok) pass++;
}
console.log(`\n${pass}/${checks.length} passed`);
if (pass !== checks.length) process.exitCode = 1;
