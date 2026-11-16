// Long-run degradation benchmark. Reproduces "the lyrics get choppy after the app has
// been running for a while" by replaying an accelerated playback session and sampling
// frame time, JS heap, DOM nodes and live event listeners at fixed virtual-time marks.
//
//   node tools/bench_longrun.mjs                 # 60 virtual minutes, shatter OFF
//   GL_LONGRUN_SHATTER=1 node ...              # same, shatter ON
//   GL_LONGRUN_MIN=120 node ...                # 120 virtual minutes
//
// One real playback heartbeat is 500ms; the replay fires one every HEARTBEAT_MS so
// N virtual minutes compress into N * 60000 / (500 / HEARTBEAT_MS) ms of wall time.
// Marks are comparable because every sample uses the same 2s frame-time window.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { ROOT, resolveEdge, toFileUrl, profileDir, CHROMIUM_ARGS } from './cdp-env.mjs';

const EDGE = resolveEdge();
const FILE_URL = toFileUrl(path.join(ROOT, 'app', 'renderer', 'index.html'));
const PROFILE = profileDir('longrun');
const PORT = 9341;
const VIRTUAL_MIN = Math.max(6, Number(process.env.GL_LONGRUN_MIN || 60));
const SHATTER = process.env.GL_LONGRUN_SHATTER === '1';
const HEARTBEAT_MS = 25;                 // 20x realtime
const SPEEDUP = 500 / HEARTBEAT_MS;
const MARKS = 6;

const proc = spawn(EDGE, [
  ...CHROMIUM_ARGS,
  '--enable-precise-memory-info',
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
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
    p95: +d[Math.floor(d.length * 0.95)].toFixed(2),
    max: +d[d.length - 1].toFixed(2),
    jank: +((d.filter((x) => x > 25).length / d.length) * 100).toFixed(1)
  };
})()`;

const SNAPSHOT = `(() => ({
  heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(2) : null,
  nodes: document.querySelectorAll('*').length,
  ghosts: document.querySelectorAll('.shatter-ghost').length,
  glyphs: document.querySelectorAll('#curGlyphs .glyph').length,
  floatRows: document.querySelectorAll('.float-row').length,
  frames: window.__w.frames,
  styleWrites: window.__w.p + window.__w.pop + window.__w.wx + window.__w.wy + window.__w.slam,
  lineIdx: window.getLyricState().currentIdx
}))()`;

const rows = [];
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
  if (!target) throw new Error('CDP endpoint not ready');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Memory.enable');
  await send('Page.navigate', { url: FILE_URL });
  for (let i = 0; i < 100; i++) {
    const ready = await ev("document.querySelectorAll('#curGlyphs .glyph').length").catch(() => 0);
    if (ready > 0) break;
    await sleep(150);
  }
  await sleep(600);

  // A realistic 100-line synced lyric. applyLyrics() also replaces LINES/lyricTimes.
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push({ time: i * 4, text: '第' + (i + 1) + '句歌词测试文本一二三四', words: [] });
  await ev(`window.applyLyrics({ ok:true, provider:'netease', source:'lrc', wordSync:false,
    lines:${JSON.stringify(lines)}, offsetMs:0 })`);
  await ev(`window.applyTrack({ status:'PLAYING', position:0, duration:400,
    title:'长跑测试', artist:'bench' })`);
  if (SHATTER) await ev(`(() => { const c=document.querySelector('[data-cfg=shatter]');
    c.checked=true; c.dispatchEvent(new Event('input')); })()`);

  console.log(`=== long-run replay: ${VIRTUAL_MIN} virtual min @ ${SPEEDUP}x, shatter=${SHATTER} ===`);
  console.log('mark   virtMin  fps   p95    max   jank%  heapMB  nodes  listeners  ghosts  frames');

  const totalHeartbeats = Math.round(VIRTUAL_MIN * 60000 / 500);
  const perMark = Math.ceil(totalHeartbeats / MARKS);

  async function measure(label, virtMin) {
    const ft = await ev(SAMPLE);
    const snap = await ev(SNAPSHOT);
    const dom = await send('Memory.getDOMCounters');
    const listeners = dom.result?.jsEventListeners ?? -1;
    rows.push({ label, virtMin, ...ft, ...snap, listeners });
    console.log(
      String(label).padEnd(6) + String(virtMin).padStart(6) +
      String(ft.fps).padStart(7) + String(ft.p95).padStart(7) + String(ft.max).padStart(7) +
      String(ft.jank).padStart(7) + String(snap.heapMB).padStart(8) +
      String(snap.nodes).padStart(7) + String(listeners).padStart(11) +
      String(snap.ghosts).padStart(8) + String(snap.frames).padStart(9));
  }

  await measure('start', 0);

  // Replay: every heartbeat advances the playhead by 0.5s (real-time rate), and every
  // 400 heartbeats (~3.3 virtual min) a new song is loaded via the real applyLyrics path.
  // The heartbeat runs as a page-side interval so no single CDP evaluate call ever blocks
  // for a whole mark (a 60-min mark takes ~30s and would trip the CDP timeout).
  for (let mark = 1; mark <= MARKS; mark++) {
    const from = (mark - 1) * perMark;
    const to = Math.min(totalHeartbeats, mark * perMark);
    await ev(`(() => {
      let i = ${from};
      const to = ${to};
      clearInterval(window.__lrTimer);
      window.__lrHeartbeats = 0;
      window.__lrTimer = setInterval(() => {
        if (i >= to) { clearInterval(window.__lrTimer); return; }
        if (i > 0 && i % 400 === 0) {
          window.applyLyrics({ ok:true, provider:'netease', source:'lrc', wordSync:false,
            lines: Array.from({length:100}, (_,k)=>({time:k*4, text:'曲目'+(i/400)+'第'+k+'句歌词', words:[]})),
            offsetMs:0 });
        }
        window.applyTrack({ status:'PLAYING', position:(i % 400) * 0.5, duration:200,
          title:'曲目' + Math.floor(i/400), artist:'bench', sampledAtMs: Date.now(), playbackRate:1 });
        window.__lrHeartbeats++;
        i++;
      }, ${HEARTBEAT_MS});
    })()`);
    await sleep((to - from) * HEARTBEAT_MS + 250);
    await ev('clearInterval(window.__lrTimer)');
    const done = await ev('window.__lrHeartbeats');
    if (done < to - from) console.log(`  (mark ${mark}: ${done}/${to - from} heartbeats delivered)`);
    await measure('m' + mark, +(to * 500 / 60000).toFixed(1));
  }

  const a = rows[0], z = rows[rows.length - 1];
  console.log('\n=== delta (start -> end) ===');
  console.log(JSON.stringify({
    p95: +(z.p95 - a.p95).toFixed(2),
    max: +(z.max - a.max).toFixed(2),
    jank: +(z.jank - a.jank).toFixed(1),
    heapMB: +(z.heapMB - a.heapMB).toFixed(2),
    nodes: z.nodes - a.nodes,
    listeners: z.listeners - a.listeners,
    ghosts: z.ghosts - a.ghosts
  }));
} catch (e) {
  console.error('LONGRUN FAILED:', e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  try { proc.kill(); } catch { /* ignore */ }
}
