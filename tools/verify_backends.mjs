// Cross-platform contract regression: the three OS backends must produce the SAME shape.
// Runs with plain Node on Windows / macOS / Linux (no Electron, no network).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const parse = require(path.join(ROOT, 'app/backends/parse.js'));
const { backendFor, trayIconName } = require(path.join(ROOT, 'app/backends/index.js'));
const PlaybackClock = require(path.join(ROOT, 'app/playback-clock.js'));

const resolveStub = (n) => '/res/' + n;
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push([true, name, '']); }
  catch (e) { results.push([false, name, e.message]); }
};

/* ---------- media line contract: Windows / macOS / Linux samples ---------- */
const winLine = JSON.stringify({ ok: true, active: true, app: 'QQMusic.exe', title: '孤勇者',
  artist: '陈奕迅', album: '孤勇者', status: 'PLAYING', statusValue: 4,
  position: 12.345, duration: 256.789, hasCover: true });

const macLine = JSON.stringify({ ok: true, active: true, app: 'Spotify', player: 'Spotify',
  title: 'Starboy', artist: 'The Weeknd', album: 'Starboy', status: 'PAUSED', statusValue: 5,
  position: 41, duration: 230, hasCover: true, coverUrl: 'https://i.scdn.co/image/abc' });

const linuxLine = JSON.stringify({ ok: true, active: true, app: 'spotify', player: 'spotify',
  title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours',
  status: 'PLAYING', statusValue: 4, position: 12.5, duration: 200.4,
  hasCover: true, coverUrl: 'file:///tmp/art.jpg' });

await check('Windows 媒体行解析', () => {
  const d = parse.parseMediaLine(winLine);
  assert.equal(d.title, '孤勇者');
  assert.equal(d.status, 'PLAYING');
  assert.equal(d.statusValue, 4);
  assert.equal(d.position, 12.345);
});

await check('macOS 媒体行解析（coverUrl）', () => {
  const d = parse.parseMediaLine(macLine);
  assert.equal(d.app, 'Spotify');
  assert.equal(d.status, 'PAUSED');
  assert.equal(d.statusValue, 5);
  assert.equal(d.cover, 'https://i.scdn.co/image/abc');
});

await check('Linux 媒体行解析（MPRIS）', () => {
  const d = parse.parseMediaLine(linuxLine);
  assert.equal(d.status, 'PLAYING');
  assert.equal(d.statusValue, 4);
  assert.equal(d.duration, 200.4);
  assert.equal(d.cover, 'file:///tmp/art.jpg');
});

await check('三端字段集合一致', () => {
  const keys = (l) => Object.keys(parse.parseMediaLine(l)).sort().join(',');
  assert.equal(keys(winLine), keys(macLine));
  assert.equal(keys(winLine), keys(linuxLine));
});

await check('无播放时 active=false 且不崩溃', () => {
  const d = parse.parseMediaLine(JSON.stringify({ ok: true, active: false, status: 'NONE' }));
  assert.equal(d.active, false);
  assert.equal(d.status, 'NONE');
});

await check('未知状态不会被当成播放中', () => {
  const d = parse.parseMediaLine(JSON.stringify({ ok: true, status: 'BOGUS', title: 'x' }));
  assert.equal(d.status, 'UNKNOWN');
  assert.equal(d.active, false);
  assert.equal(d.statusValue, -1);
});

await check('coverUrl 归一为 cover（mac/Linux 封面链路）', () => {
  const d = parse.parseMediaLine(JSON.stringify({ ok: true, status: 'PLAYING',
    coverUrl: 'https://i.scdn.co/image/abc' }));
  assert.equal(d.cover, 'https://i.scdn.co/image/abc');
  assert.equal(d.hasCover, true);
});

await check('依赖缺失错误行被识别', () => {
  const d = parse.parseMediaLine(JSON.stringify({ ok: false, error: 'playerctl-missing' }));
  assert.equal(d.ok, false);
  assert.equal(d.error, 'playerctl-missing');
});

await check('非 JSON 噪声行返回 null', () => {
  assert.equal(parse.parseMediaLine('playerctl: command not found'), null);
  assert.equal(parse.parseMediaLine(''), null);
});

await check('采样时间戳与播放速率被保留', () => {
  const d = parse.parseMediaLine(JSON.stringify({ ok: true, status: 'PLAYING', position: 10,
    sampledAtMs: 10000, playbackRate: 1.25 }));
  assert.equal(d.sampledAtMs, 10000);
  assert.equal(d.playbackRate, 1.25);
});

await check('旧后端缺时间戳时回退到接收时刻', () => {
  const before = Date.now();
  const d = parse.parseMediaLine(JSON.stringify({ ok: true, status: 'PLAYING', position: 10 }));
  assert.ok(d.sampledAtMs >= before && d.sampledAtMs <= Date.now());
  assert.equal(d.playbackRate, 1);
});

/* ---------- renderer playback clock ---------- */
await check('播放中补偿采集/IPC 传输耗时', () => {
  const p = PlaybackClock.estimatePosition({ position: 10, duration: 100, status: 'PLAYING',
    sampledAtMs: 10000, playbackRate: 1 }, 10400, 250);
  assert.ok(Math.abs(p - 10.65) < 0.00001);
});

await check('暂停样本不会向后推算', () => {
  const p = PlaybackClock.estimatePosition({ position: 10, duration: 100, status: 'PAUSED',
    sampledAtMs: 10000 }, 12000, 8000);
  assert.equal(p, 10);
});

await check('超过旧版 2 秒上限仍连续推进', () => {
  const p = PlaybackClock.estimatePosition({ position: 10, duration: 100, status: 'PLAYING',
    sampledAtMs: 10000 }, 10000, 4500);
  assert.equal(p, 14.5);
});

await check('采样时钟未来值不产生倒退', () => {
  const p = PlaybackClock.estimatePosition({ position: 10, duration: 100, status: 'PLAYING',
    sampledAtMs: 11000 }, 10000, 500);
  assert.equal(p, 10.5);
});

await check('位置不会越过歌曲时长', () => {
  const p = PlaybackClock.estimatePosition({ position: 99, duration: 100, status: 'PLAYING',
    sampledAtMs: 10000 }, 10000, 5000);
  assert.equal(p, 100);
});

await check('倍速播放按播放速率推进', () => {
  const p = PlaybackClock.estimatePosition({ position: 10, duration: 100, status: 'PLAYING',
    sampledAtMs: 10000, playbackRate: 2 }, 10000, 1000);
  assert.equal(p, 12);
});

await check('缺时间戳兼容旧数据且不做虚假补偿', () => {
  const p = PlaybackClock.estimatePosition({ position: 10, duration: 100, status: 'PLAYING' },
    50000, 1000);
  assert.equal(p, 11);
});

/* ---------- window probe contract ---------- */
const winWin = JSON.stringify({ ok: true, rect: [10, 20, 800, 600], rectPhysical: [15, 30, 1200, 900],
  process: 'Warframe.x64', className: 'Warframe', caption: 'Warframe', visible: true });
const macWin = JSON.stringify({ ok: true, rect: [0, 25, 1440, 875], process: 'Game', title: 'Game', visible: true });
const linuxWin = JSON.stringify({ ok: true, rect: [0, 0, 1920, 1080], process: 'game', className: 'game.Game',
  title: 'Game', visible: true });
const wayland = JSON.stringify({ ok: true, visible: false, desktop: true, error: 'wayland-no-window-api' });

await check('Windows 窗口行解析（caption → title）', () => {
  const d = parse.parseWindowLine(winWin);
  assert.equal(d.title, 'Warframe');
  assert.deepEqual(d.rect, [10, 20, 800, 600]);
  assert.deepEqual(d.rectPhysical, [15, 30, 1200, 900]);
});

await check('macOS 窗口行解析', () => {
  const d = parse.parseWindowLine(macWin);
  assert.deepEqual(d.rect, [0, 25, 1440, 875]);
  assert.equal(d.process, 'Game');
});

await check('Linux 窗口行解析', () => {
  const d = parse.parseWindowLine(linuxWin);
  assert.deepEqual(d.rect, [0, 0, 1920, 1080]);
  assert.equal(d.className, 'game.Game');
});

await check('Wayland 降级行（desktop=true，不抛错）', () => {
  const d = parse.parseWindowLine(wayland);
  assert.equal(d.desktop, true);
  assert.equal(d.visible, false);
  assert.equal(d.error, 'wayland-no-window-api');
});

/* ---------- playback action aliases ---------- */
await check('播放动作跨平台归一', () => {
  assert.equal(parse.normalizeAction('playpause'), 'toggle');
  assert.equal(parse.normalizeAction('TOGGLE'), 'toggle');
  assert.equal(parse.normalizeAction('next'), 'next');
  assert.equal(parse.normalizeAction('volume'), null);
});

/* ---------- backend routing per OS ---------- */
await check('win32 路由到 PowerShell 脚本', () => {
  const b = backendFor('win32', resolveStub);
  assert.equal(b.id, 'win32');
  assert.equal(b.media.cmd, 'powershell.exe');
  assert.ok(b.media.script.endsWith('smtc-bridge.ps1'));
  assert.ok(b.control.args('/x/smtc-control.ps1', 'play').includes('-Action'));
  assert.equal(b.capabilities.loginItem, 'electron');
});

await check('darwin 路由到 osascript + JXA', () => {
  const b = backendFor('darwin', resolveStub);
  assert.equal(b.media.cmd, 'osascript');
  assert.deepEqual(b.media.args('/x/media-mac.js'), ['-l', 'JavaScript', '/x/media-mac.js']);
  assert.equal(b.control.args('/x/c.js', 'next')[3], 'next');
  assert.equal(b.capabilities.loginItem, 'electron');
  assert.equal(b.capabilities.windowProbe, 'accessibility');
});

await check('linux 路由到 bash + playerctl 脚本', () => {
  const b = backendFor('linux', resolveStub);
  assert.equal(b.media.cmd, 'bash');
  assert.equal(b.capabilities.loginItem, 'xdg-autostart');
  assert.equal(b.capabilities.windowProbe, 'x11');
  assert.deepEqual(b.control.args('/x/c.sh', 'prev'), ['/x/c.sh', 'prev']);
});

await check('托盘图标按平台选择格式', () => {
  assert.ok(trayIconName('win32').endsWith('.ico'));
  assert.ok(trayIconName('darwin').endsWith('.png'));
  assert.ok(trayIconName('linux').endsWith('.png'));
});

/* ---------- SMTC status enum: the exact defect that froze the lyric clock ----------
 * Windows.Media.Control uses 4=Playing / 5=Paused. The old bridge used the unrelated
 * Windows.Media.MediaPlaybackStatus values (3=Playing / 4=Paused), so a playing track
 * was reported as STOPPED, rate became 0 and lyrics could only step once per 500ms poll.
 * These checks read the shipped scripts so an implementation/test "self-consistent" error
 * can never slip through again. */
const OFFICIAL = { 0: 'CLOSED', 1: 'OPENED', 2: 'CHANGING', 3: 'STOPPED', 4: 'PLAYING', 5: 'PAUSED' };

await check('SMTC 枚举常量与官方一致', () => {
  assert.deepEqual(parse.STATUS_VALUE,
    { CLOSED: 0, OPENED: 1, CHANGING: 2, STOPPED: 3, PLAYING: 4, PAUSED: 5, NONE: -1 });
});

await check('Windows 桥接脚本的 statusNames 与官方一致', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'smtc-bridge.ps1'), 'utf8');
  const m = src.match(/\$statusNames\s*=\s*@\{([^}]+)\}/);
  assert.ok(m, 'statusNames map not found in smtc-bridge.ps1');
  const map = {};
  for (const hit of m[1].matchAll(/(\d+)\s*=\s*'([A-Z]+)'/g)) map[Number(hit[1])] = hit[2];
  assert.deepEqual(map, OFFICIAL);
});

/* The 1.5.1 enum fix corrected the emitted labels but left two numeric guards behind:
 * `$sv -eq 3` gated the sourceAge compensation and `PlaybackStatus -eq 3` gated toggle.
 * 3 means STOPPED in the real SMTC enum, so a playing track lost its timestamp
 * compensation and the renderer saw a ~0.3s sawtooth at every 500ms poll. These
 * source-level checks make that class of drift impossible to reintroduce. */
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'app', 'smtc-bridge.ps1'), 'utf8');
const controlSrc = fs.readFileSync(path.join(ROOT, 'app', 'smtc-control.ps1'), 'utf8');

await check('桥接的时间戳补偿按 PLAYING 语义触发，且标签先于补偿计算', () => {
  assert.match(bridgeSrc, /if \(\$name -eq 'PLAYING'\)/);
  const label = bridgeSrc.indexOf('$name = if ($statusNames.ContainsKey($sv))');
  const comp = bridgeSrc.indexOf('$sourceAge');
  assert.ok(label >= 0 && comp > label, 'playback label must be computed before compensation');
  assert.match(bridgeSrc, /\$position\s*\+=\s*\$sourceAge\s*\*\s*\$rate/);
});

await check('时间戳补偿限制陈旧度上限，暂停或拖动后不会大跳', () => {
  assert.match(bridgeSrc, /\$sourceAge\s*-gt\s*0\s*-and\s*\$sourceAge\s*-lt\s*2/);
});

await check('播放控制 toggle 使用与 parse.js 一致的 PLAYING 值', () => {
  const m = controlSrc.match(/\$SMTC_PLAYING\s*=\s*(\d+)/);
  assert.ok(m, 'SMTC_PLAYING constant missing');
  assert.equal(Number(m[1]), parse.STATUS_VALUE.PLAYING);
  assert.match(controlSrc, /PlaybackStatus\s*-eq\s*\$SMTC_PLAYING/);
});

await check('所有 Windows 桥接脚本都不含裸枚举数值判断', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'app')).filter((x) => x.endsWith('.ps1'))) {
    const src = fs.readFileSync(path.join(ROOT, 'app', f), 'utf8');
    assert.doesNotMatch(src, /(?:PlaybackStatus|\$sv)\s*-eq\s*\d+/, f);
  }
});

await check('macOS / Linux 后端的 statusValue 也对齐官方枚举', () => {
  const mac = fs.readFileSync(path.join(ROOT, 'app', 'backends', 'media-mac.js'), 'utf8');
  const lin = fs.readFileSync(path.join(ROOT, 'app', 'backends', 'media-linux.sh'), 'utf8');
  assert.match(mac, /playing:\s*\['PLAYING',\s*4\]/);
  assert.match(mac, /paused:\s*\['PAUSED',\s*5\]/);
  assert.match(mac, /stopped:\s*\['STOPPED',\s*3\]/);
  assert.match(lin, /Playing\)\s*status="PLAYING";\s*sval=4/);
  assert.match(lin, /Paused\)\s*status="PAUSED";\s*sval=5/);
  assert.match(lin, /Stopped\)\s*status="STOPPED";\s*sval=3/);
});

await check('数值枚举优先：状态标签写错时自动纠正', () => {
  // This is the real-world shape: statusValue comes straight from WinRT, status is a label.
  const d = parse.parseMediaLine(JSON.stringify({
    ok: true, active: true, status: 'STOPPED', statusValue: 4,
    title: 'x', position: 10, duration: 200
  }));
  assert.equal(d.status, 'PLAYING');
  assert.equal(d.statusValue, 4);
  assert.equal(d.active, true);
});

await check('本机 QQ 音乐采样形态（statusValue=4）判定为播放中', () => {
  const d = parse.parseMediaLine(JSON.stringify({
    ok: true, active: true, app: 'Tencent.QQMusic', status: 'PLAYING', statusValue: 4,
    position: 166.713, duration: 197.403, sampledAtMs: 1794828629476, playbackRate: 1
  }));
  const p = PlaybackClock.estimatePosition(d, 1794828629476, 250);
  assert.ok(Math.abs(p - (166.713 + 0.25)) < 0.01, 'position=' + p);
});

/* ---------- status watchdog: a stuck non-PLAYING status must not freeze lyrics ---------- */
const sample = (o = {}) => parse.parseMediaLine(JSON.stringify({
  ok: true, active: true, title: '孤勇者', artist: '陈奕迅', status: 'STOPPED', statusValue: 3,
  position: 10, duration: 200, sampledAtMs: 1000, ...o
}));

await check('状态自愈：连续推进两次才纠回 PLAYING', () => {
  const r = parse.createPlaybackStatusWatchdog();
  assert.equal(r(sample({ position: 10, sampledAtMs: 1000 })).status, 'STOPPED');
  assert.equal(r(sample({ position: 10.5, sampledAtMs: 1500 })).status, 'STOPPED');
  const d = r(sample({ position: 11, sampledAtMs: 2000 }));
  assert.equal(d.status, 'PLAYING');
  assert.equal(d.statusValue, 4);
});

await check('状态自愈：暂停（位置冻结）不误判', () => {
  const r = parse.createPlaybackStatusWatchdog();
  const paused = { status: 'PAUSED', statusValue: 5 };
  r(sample({ ...paused, position: 10, sampledAtMs: 1000 }));
  assert.equal(r(sample({ ...paused, position: 10, sampledAtMs: 1500 })).status, 'PAUSED');
  assert.equal(r(sample({ ...paused, position: 10.02, sampledAtMs: 2000 })).status, 'PAUSED');
});

await check('状态自愈：切歌 / seek 不误判', () => {
  const a = parse.createPlaybackStatusWatchdog();
  a(sample({ position: 10, sampledAtMs: 1000 }));
  assert.equal(a(sample({ title: '另一首', position: 10.5, sampledAtMs: 1500 })).status, 'STOPPED');
  const b = parse.createPlaybackStatusWatchdog();
  b(sample({ position: 10, sampledAtMs: 1000 }));
  assert.equal(b(sample({ position: 80, sampledAtMs: 1500 })).status, 'STOPPED');
});

await check('状态自愈：纠回后播放时钟按壁钟平滑推进', () => {
  const r = parse.createPlaybackStatusWatchdog();
  r(sample({ position: 10, sampledAtMs: 1000 }));
  r(sample({ position: 10.5, sampledAtMs: 1500 }));
  const d = r(sample({ position: 11, sampledAtMs: 2000 }));
  assert.equal(d.status, 'PLAYING');
  assert.ok(Math.abs(PlaybackClock.estimatePosition(d, 2000, 250) - 11.25) < 0.01);
  assert.ok(Math.abs(PlaybackClock.estimatePosition(d, 2000, 500) - 11.5) < 0.01);
});

/* ---------- path semantics ---------- */
await check('打包资源路径按平台语义拼接', () => {
  assert.equal(path.posix.join('/res', 'backends/media-linux.sh'), '/res/backends/media-linux.sh');
  assert.equal(path.win32.join('C:\\res', 'smtc-bridge.ps1'), 'C:\\res\\smtc-bridge.ps1');
});

let pass = 0;
for (const [good, name, detail] of results) {
  if (good) pass++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
