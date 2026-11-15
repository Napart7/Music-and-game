// P1 regression: lyric parsing (pure Node) + renderer timeline behaviour (headless Edge CDP).
import { resolveEdge, toFileUrl, profileDir, CHROMIUM_ARGS } from './cdp-env.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const L = require(path.join(ROOT, 'app', 'lyrics.js'));

const EDGE = resolveEdge();
const FILE_URL = toFileUrl(path.join(ROOT, 'app', 'renderer', 'index.html'));
const PROFILE = profileDir('lyrics');
const PORT = 9335;

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

// --- pure functions ---
const parsed = L.parseLrc('[00:10.32]First line\n[00:16.22][00:20.68]Second line\n[01:02]Third line');
check('LRC 多时间戳解析', parsed.length === 4 && parsed[0].time === 10.32 && parsed[3].time === 62,
  JSON.stringify(parsed));
check('LRC 按时间排序', parsed.every((v, i) => i === 0 || v.time >= parsed[i - 1].time));
check('曲名清洗去掉 Explicit/方括号', L.cleanTitle('True Love (Explicit) [Remastered]') === 'True Love',
  L.cleanTitle('True Love (Explicit) [Remastered]'));
check('艺人清洗取主艺人', L.cleanArtist('P!NK/Lily Allen feat. Someone') === 'P!NK',
  L.cleanArtist('P!NK/Lily Allen feat. Someone'));
check('indexAt 二分定位', L.indexAt([{ time: 10 }, { time: 16 }, { time: 20 }], 17) === 1);
const plain = L.plainToLines('a\nb\nc', 12);
check('无时间轴歌词均分', plain.length === 3 && plain[0].time > 0 && plain[2].time < 12,
  JSON.stringify(plain));
check('trackKey 大小写与噪声无关',
  L.trackKey({ title: 'True Love (Explicit)', artist: 'P!NK/Lily Allen' }) ===
  L.trackKey({ title: 'true love', artist: 'p!nk' }),
  L.trackKey({ title: 'True Love (Explicit)', artist: 'P!NK/Lily Allen' }));

// --- renderer ---
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
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
}

try {
  let target = null;
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch { /* not ready */ }
    await sleep(250);
  }
  if (!target) throw new Error('CDP endpoint not ready');

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
  await sleep(400);
  check('页面加载且逐字 Glyph 渲染', ready > 0, `glyphs=${ready}`);
  check('状态胶囊提示已移除',
    (await ev("document.getElementById('hud') === null && document.getElementById('fit') === null")) === true);

  const mock = {
    ok: true, source: 'lrclib-synced', provider: 'LRCLIB', synced: true, cached: false,
    lines: [
      { time: 0, text: '第一句歌词' },
      { time: 10, text: '第二句歌词' },
      { time: 20, text: '第三句歌词' }
    ], offsetMs: 0
  };
  const applied = await ev(`window.applyLyrics(${JSON.stringify(mock)})`);
  check('真实歌词替换演示占位', applied.mode === 'real' && applied.lines === 3, JSON.stringify(applied));

  const st = await ev("window.getLyricState()");
  check('时间轴被载入', st.mode === 'real' && st.times.length === 3 && st.times[1] === 10, JSON.stringify(st.times));
  check('右侧标签改为下一句', (await ev("document.querySelector('.side.right .side-label').textContent")) === '下一句 / 状态');
  check('面板显示真实歌词来源', /LRCLIB · 整行时间轴 · 3 行 · 逐字为推算/.test(
    await ev("document.getElementById('pLyricSrc').textContent")));

  // Drive the SMTC timeline: position 12s must select line index 1.
  await ev("window.applyTrack({title:'T',artist:'A',album:'B',status:'PLAYING',position:12,duration:30})");
  await sleep(300);
  const idx = await ev("window.getLyricState().currentIdx");
  check('按真实时间轴定位到第二句', idx === 1, `currentIdx=${idx}`);
  check('当前行文字来自真实歌词',
    (await ev("document.getElementById('curGlyphs').textContent")) === '第二句歌词');

  // Offset calibration must shift the active line.
  await ev("window.setLyricOffset(-5000); window.applyTrack({status:'PLAYING',position:12,duration:30,recvAt:0})");
  await sleep(300);
  check('时间轴偏移生效', (await ev("window.getLyricState().currentIdx")) === 0);
  await ev("window.setLyricOffset(0)");

  // Failure path falls back to demo lines without crashing.
  const failed = await ev("window.applyLyrics({ok:false,error:'not-found'})");
  check('未找到歌词时回退演示占位', failed.mode === 'demo' && failed.lines === 8, JSON.stringify(failed));
  check('回退时右侧标签复原', (await ev("document.querySelector('.side.right .side-label').textContent")) === '翻译 / 状态');

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
