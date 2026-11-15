// Offline regression for the lyric provider layer. No network, no Edge, no Electron.
// Safe to run in CI on a clean checkout.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = require(path.join(ROOT, 'app', 'providers.js'));
const L = require(path.join(ROOT, 'app', 'lyrics.js'));

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

/* ---------------- YRC (real per-character timing) ---------------- */
const YRC = [
  '{"t":0,"c":[{"tx":"作词: "},{"tx":"唐恬"}]}',                       // metadata JSON row, must be skipped
  '[4890,4370](4890,270,0)词(5160,270,0)版(5430,270,0)权',
  '[22310,4300](22310,2880,0)都 (25190,310,0)是(25500,290,0)勇(25790,230,0)敢(26020,590,0)的',
  '[58740,5690](58740,270,0)他(59010,150,0)们(59160,740,0)说 (59900,230,0)要(60130,270,0)缝(60400,230,0)好(60630,260,0)你(60890,130,0)的(61020,670,0)伤 (61690,330,0)没(62020,280,0)有(62300,330,0)人(62630,390,0)爱(63020,620,0)小(63640,790,0)丑',
  '[92010,1780](92010,230,0)爱(92240,220,0)你(92460,240,0)和(92700,220,0)我(92920,240,0)那(93160,210,0)么(93370,420,0)像',
  '[100000,2000](100000,1000,0)括号(101000,1000,0)(测试)'              // ordinary brackets must not break parsing
].join('\n');

const yrc = P.parseYrc(YRC);
check('YRC 跳过 JSON 元信息行', yrc.length === 5, `rows=${yrc.length}`);
check('YRC 行时间是绝对秒', yrc[1].time === 22.31 && yrc[3].time === 92.01, JSON.stringify(yrc.map(x => x.time)));
check('YRC 每字时间戳与文字一一对应',
  yrc.every(l => l.words.length === [...l.text].length),
  JSON.stringify(yrc.map(l => [l.text.length, l.words.length])));
check('YRC 时间戳单调递增', yrc.every(l => l.words.every((w, i) => i === 0 || w.s >= l.words[i - 1].s)));
check('YRC 首字起始等于行起始', Math.abs(yrc[1].words[0].s - yrc[1].time) < 0.002,
  `${yrc[1].words[0].s} vs ${yrc[1].time}`);
check('YRC 歌词中的普通括号不被误判为时间戳', yrc[4].text.includes('(测试)'), yrc[4].text);
check('YRC 保留字间空格', yrc[1].text.includes('都 '), JSON.stringify(yrc[1].text));

/* ---------------- LRC / credits / translations ---------------- */
const lrc = P.parseLrc('[00:10.32]First line\n[00:16.22][00:20.68]Second line\n[01:02]Third line');
check('LRC 多时间戳解析', lrc.length === 4 && lrc[0].time === 10.32 && lrc[3].time === 62, JSON.stringify(lrc));
check('LRC 按时间排序', lrc.every((v, i) => i === 0 || v.time >= lrc[i - 1].time));

const withCredits = [
  { time: 0, text: '孤勇者 (《双城之战》主题曲) - 陈奕迅' },
  { time: 7, text: '作词 : 唐恬' },
  { time: 8, text: '作曲 : 钱雷' },
  { time: 22, text: '都是勇敢的' }
];
const cleaned = P.stripCredits(withCredits);
check('制作信息与标题行被过滤', cleaned.length === 1 && cleaned[0].text === '都是勇敢的', JSON.stringify(cleaned));

const trans = P.attachTranslations([{ time: 22.31, text: '都是勇敢的' }],
  [{ time: 22.40, text: 'All are brave' }]);
check('翻译按时间就近挂载', trans[0].tr === 'All are brave', JSON.stringify(trans));
check('偏离过远的翻译不误挂',
  P.attachTranslations([{ time: 10, text: 'A' }], [{ time: 60, text: 'B' }])[0].tr === undefined);

/* ---------------- search matching ---------------- */
const hits = [
  { songname: '孤勇者', songmid: 'MID1', interval: 256, singer: [{ name: '陈奕迅' }] },
  { songname: '孤勇者 (童声版)', songmid: 'MID2', interval: 256, singer: [{ name: '熊昱琦' }] }
];
const best = P.pickBest(hits, s => ({ name: s.songname, mid: s.songmid, dur: s.interval,
  artist: s.singer.map(x => x.name).join('/') }), { title: '孤勇者', artist: '陈奕迅', duration: 256 });
check('搜索结果优先精确标题 + 正确艺人', best && best.mid === 'MID1', JSON.stringify(best));
check('无关结果被拒绝',
  P.pickBest([{ songname: '完全不相关的歌' }], s => ({ name: s.songname }), { title: '孤勇者' }) === null);

/* ---------------- platform routing ---------------- */
check('QQ 音乐平台优先 QQ 歌词', L.resolveOrder('qqmusic', 'auto')[0] === 'qqmusic');
check('网易云平台优先网易云歌词', L.resolveOrder('netease', 'auto')[0] === 'netease');
check('其它播放器优先 LRCLIB', L.resolveOrder('other', 'auto')[0] === 'lrclib');
check('手动指定源覆盖平台推断', L.resolveOrder('netease', 'qqmusic')[0] === 'qqmusic');
check('关闭在线歌词返回空链', L.resolveOrder('qqmusic', 'off').length === 0);
check('平台识别 QQ 音乐', L.platformFromApp('QQMusic.exe') === 'qqmusic');
check('平台识别网易云', L.platformFromApp('NeteaseCloudMusic') === 'netease');
check('平台识别酷狗', L.platformFromApp('KuGou.exe') === 'kugou');
check('平台识别汽水音乐', L.platformFromApp('QishuiMusic.exe') === 'qishui');
check('平台识别 Apple Music', L.platformFromApp('AppleMusic.exe') === 'applemusic');
check('平台识别 Spotify', L.platformFromApp('Spotify.exe') === 'spotify');
check('平台识别其它', L.platformFromApp('SomePlayer.exe') === 'other');
check('酷狗源顺序', L.resolveOrder('kugou', 'auto')[0] === 'kugou');
check('汽水走中文同曲匹配', L.resolveOrder('qishui', 'auto')[0] === 'netease');
check('Spotify 先试 LRCLIB', L.resolveOrder('spotify', 'auto')[0] === 'lrclib');
check('Apple Music 先试 LRCLIB', L.resolveOrder('applemusic', 'auto')[0] === 'lrclib');
check('曲名清洗', P.cleanTitle('True Love (Explicit) [Remastered]') === 'True Love');
check('艺人清洗', P.cleanArtist('P!NK/Lily Allen feat. Someone') === 'P!NK');
check('trackKey 与噪声无关',
  L.trackKey({ title: 'True Love (Explicit)', artist: 'P!NK/Lily Allen' }) ===
  L.trackKey({ title: 'true love', artist: 'p!nk' }));
check('indexAt 二分定位', L.indexAt([{ time: 10 }, { time: 16 }, { time: 20 }], 17) === 1);

/* ---------------- disabled mode + cache round-trip ---------------- */
const dir = mkdtempSync(path.join(tmpdir(), 'glasslyrics-'));
try {
  const off = await L.fetchLyrics({ title: '孤勇者', artist: '陈奕迅', duration: 256 }, dir, { preferred: 'off' });
  check('关闭在线歌词时不发请求', off.ok === false && off.error === 'lyrics-disabled', JSON.stringify(off));
  const empty = await L.fetchLyrics({ title: '', artist: '' }, dir, {});
  check('空曲名直接拒绝', empty.ok === false && empty.error === 'empty-title');
} catch (e) {
  check('离线分支无异常', false, String(e));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

let pass = 0;
for (const c of checks) {
  if (c.ok) pass++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`);
}
console.log(`\n${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
