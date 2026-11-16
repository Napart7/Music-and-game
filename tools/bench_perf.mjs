// User-perspective performance benchmark (headless browser + CDP).
// Measures frame-time distribution in the scenarios a real user sits in:
//   idle demo lyrics / real word-sync lyrics / floating rows / low-end mode /
//   menu open / drag-edit mouse storm.
// Output: n, avg, p50, p95, max frame time and the share of frames slower than 25ms.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { ROOT, resolveEdge, toFileUrl, profileDir, CHROMIUM_ARGS } from './cdp-env.mjs';

const EDGE = resolveEdge();
const FILE_URL = toFileUrl(path.join(ROOT, 'app', 'renderer', 'index.html'));
const PROFILE = profileDir('bench');
const PORT = 9338;

const proc = spawn(EDGE, [
  ...CHROMIUM_ARGS,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1600,1000', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

let ws = null;
const pending = new Map();
let seq = 0;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 15000);
  });
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.result?.value;
}

const SAMPLE = `(async () => {
  const t = [];
  await new Promise((res) => {
    const start = performance.now();
    function f(now) { t.push(now); if (now - start < 2000) requestAnimationFrame(f); else res(); }
    requestAnimationFrame(f);
  });
  const d = [];
  for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
  d.sort((a, b) => a - b);
  const sum = d.reduce((a, b) => a + b, 0);
  return {
    n: d.length,
    fps: +(1000 / (sum / d.length)).toFixed(1),
    avg: +(sum / d.length).toFixed(2),
    p50: +d[Math.floor(d.length * 0.5)].toFixed(2),
    p95: +d[Math.floor(d.length * 0.95)].toFixed(2),
    max: +d[d.length - 1].toFixed(2),
    over25: d.filter((x) => x > 25).length,
    jank: +((d.filter((x) => x > 25).length / d.length) * 100).toFixed(1)
  };
})()`;

const results = [];
const bench = async (name, setup) => {
  if (setup) await ev(setup);
  await sleep(400);
  const m = await ev(SAMPLE);
  results.push({ name, ...m });
  console.log(`${name.padEnd(26)} fps=${String(m.fps).padStart(5)} avg=${m.avg}ms p95=${m.p95}ms max=${m.max}ms jank=${m.jank}%`);
};

try {
  let target = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!target) throw new Error('CDP endpoint not ready' + (browserErr ? ' :: ' + browserErr.slice(-300) : ''));
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: FILE_URL });
  for (let i = 0; i < 100; i++) {
    const ready = await ev("document.querySelectorAll('#curGlyphs .glyph').length").catch(() => 0);
    if (ready > 0) break;
    await sleep(150);
  }
  await sleep(600);

  console.log('\n=== frame-time distribution (2s each, headless, software raster) ===');
  await bench('A. 演示歌词 · 默认', "document.body.dataset.layout='split'");

  await ev(`window.applyLyrics({ ok: true, provider: '网易云音乐', source: 'netease-yrc', wordSync: true,
    lines: [
      { time: 0, text: '都是勇敢的', words: [{s:0,e:1},{s:1,e:2},{s:2,e:3},{s:3,e:4},{s:4,e:5}] },
      { time: 4, text: '你额头的伤口', words: [{s:4,e:5},{s:5,e:6},{s:6,e:7},{s:7,e:8}] },
      { time: 8, text: '你的不同 你犯的错', words: [] }
    ]})`);
  await ev("window.applyTrack({status:'PLAYING',position:2.2,duration:200})");
  await bench('B. 真实逐字歌词', null);

  await bench('C. 漂浮 6 行 + 全动效', `(() => {
    const r = document.querySelector('[data-cfg=floatLines]'); r.value='6'; r.dispatchEvent(new Event('input'));
  })()`);

  await bench('D. 低配模式', `(() => {
    const c = document.querySelector('[data-cfg=perfLow]'); c.checked=true; c.dispatchEvent(new Event('input'));
  })()`);

  await bench('E. 菜单打开（毛玻璃）', `(() => {
    window.setPanel(true);
  })()`);

  await bench('F. 拖动模式 + 鼠标风暴', `(async () => {
    window.setPanel(false);
    const c = document.querySelector('[data-cfg=perfLow]'); c.checked=false; c.dispatchEvent(new Event('input'));
    window.setEditMode(true);
    const s = document.querySelector('.side.left');
    // simulate 60 mousemove events per second for 2s while dragging
    let i = 0;
    const id = setInterval(() => {
      const r = s.getBoundingClientRect();
      s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 10, clientY: r.top + 10 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 200 + (i % 40), clientY: 300 + (i % 30) }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      i++;
      if (i > 120) clearInterval(id);
    }, 16);
  })()`);
  await ev("window.setEditMode(false)");

  // Worst case: force a line rebuild every 150ms (real songs switch every 3-6s).
  await bench('G. 高频切句压力 x6.7/s', `(async () => {
    let i = 0;
    window.__benchTimer = setInterval(() => { window.renderLine(i % 8); i++; }, 150);
  })()`);
  await ev("clearInterval(window.__benchTimer)");

  // H/I: identical workload, shatter OFF vs ON. Goes through the real tick() path so
  // launchShatterGhosts() actually runs (renderLine() alone bypasses it).
  const shatterStorm = `(async () => {
    window.applyTrack({ status:'PLAYING', position:2, duration:200 });
    let i = 0;
    window.__benchTimer = setInterval(() => {
      window.applyTrack({ status:'PLAYING', position:[2,6,10][i % 3], duration:200 });
      i++;
    }, 150);
  })()`;
  await bench('H. 切句 x6.7/s · 破碎关', shatterStorm);
  await ev("clearInterval(window.__benchTimer)");
  await ev(`(() => {
    const c = document.querySelector('[data-cfg=shatter]');
    c.checked = true; c.dispatchEvent(new Event('input'));
  })()`);
  await bench('I. 切句 x6.7/s · 破碎开', shatterStorm);
  await ev("clearInterval(window.__benchTimer)");
  await ev(`(() => {
    const c = document.querySelector('[data-cfg=shatter]');
    c.checked = false; c.dispatchEvent(new Event('input'));
  })()`);
} catch (e) {
  console.error('BENCH FAILED:', e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  try { proc.kill(); } catch { /* ignore */ }
}

if (results.length) {
  const worst = results.reduce((a, b) => (a.p95 > b.p95 ? a : b));
  console.log(`\nworst p95: ${worst.name} (${worst.p95}ms)`);
}
