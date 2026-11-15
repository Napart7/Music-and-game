// Lyric-connection latency benchmark (real network, cold vs warm cache, per provider).
// Measures what a user actually feels: how long from "song changes" to "lyrics on screen".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const L = require(path.join(ROOT, 'app/lyrics.js'));

const CACHE = path.join(os.tmpdir(), 'gl-bench-cache-' + Date.now());
const TRACK = { title: '孤勇者', artist: '陈奕迅', album: '', duration: 265 };
const TRACK2 = { title: '夜曲', artist: '周杰伦', album: '', duration: 226 };

const ms = async (fn) => { const t = Date.now(); const r = await fn(); return { ms: Date.now() - t, r }; };

console.log('=== 冷缓存（首次命中一首新歌）===');
for (const p of ['qqmusic', 'netease', 'kugou', 'lrclib']) {
  const { ms: t, r } = await ms(() => L.fetchLyrics(TRACK, CACHE, { preferred: p, platform: p }));
  console.log(`${p.padEnd(8)} ${String(t).padStart(5)}ms  ${r.ok ? r.source + ' ' + r.lines.length + ' 行' : '失败 ' + r.error}`);
}

console.log('\n=== 热缓存（同一首已听过）===');
for (const p of ['qqmusic', 'netease', 'kugou']) {
  const { ms: t, r } = await ms(() => L.fetchLyrics(TRACK, CACHE, { preferred: p, platform: p }));
  console.log(`${p.padEnd(8)} ${String(t).padStart(5)}ms  cached=${r.cached}`);
}

console.log('\n=== auto 模式串行（QQ 播放 → QQ LRC 后继续等网易云 YRC）===');
{
  const { ms: t, r } = await ms(() => L.fetchLyrics(TRACK2, CACHE, { preferred: 'auto', platform: 'qqmusic' }));
  console.log(`auto    ${String(t).padStart(5)}ms  ${r.source} wordSync=${r.wordSync}`);
}

console.log('\n=== 并行竞速可行性：同时请求 qq + netease ===');
{
  const P = require(path.join(ROOT, 'app/providers.js'));
  const { ms: t, r } = await ms(() => Promise.allSettled([P.qqmusic(TRACK2), P.netease(TRACK2)]));
  const ok = r.filter((x) => x.status === 'fulfilled' && x.value).length;
  console.log(`parallel ${String(t).padStart(5)}ms  两个源都拿到=${ok}`);
}

try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch { /* ignore */ }
