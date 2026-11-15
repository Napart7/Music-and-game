// Cross-platform contract regression: the three OS backends must produce the SAME shape.
// Runs with plain Node on Windows / macOS / Linux (no Electron, no network).

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const parse = require(path.join(ROOT, 'app/backends/parse.js'));
const { backendFor, trayIconName } = require(path.join(ROOT, 'app/backends/index.js'));

const resolveStub = (n) => '/res/' + n;
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push([true, name, '']); }
  catch (e) { results.push([false, name, e.message]); }
};

/* ---------- media line contract: Windows / macOS / Linux samples ---------- */
const winLine = JSON.stringify({ ok: true, active: true, app: 'QQMusic.exe', title: '孤勇者',
  artist: '陈奕迅', album: '孤勇者', status: 'PLAYING', statusValue: 3,
  position: 12.345, duration: 256.789, hasCover: true });

const macLine = JSON.stringify({ ok: true, active: true, app: 'Spotify', player: 'Spotify',
  title: 'Starboy', artist: 'The Weeknd', album: 'Starboy', status: 'PAUSED', statusValue: 2,
  position: 41, duration: 230, hasCover: true, coverUrl: 'https://i.scdn.co/image/abc' });

const linuxLine = JSON.stringify({ ok: true, active: true, app: 'spotify', player: 'spotify',
  title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours',
  status: 'PLAYING', statusValue: 3, position: 12.5, duration: 200.4,
  hasCover: true, coverUrl: 'file:///tmp/art.jpg' });

await check('Windows 媒体行解析', () => {
  const d = parse.parseMediaLine(winLine);
  assert.equal(d.title, '孤勇者');
  assert.equal(d.status, 'PLAYING');
  assert.equal(d.statusValue, 3);
  assert.equal(d.position, 12.345);
});

await check('macOS 媒体行解析（coverUrl）', () => {
  const d = parse.parseMediaLine(macLine);
  assert.equal(d.app, 'Spotify');
  assert.equal(d.status, 'PAUSED');
  assert.equal(d.cover, 'https://i.scdn.co/image/abc');
});

await check('Linux 媒体行解析（MPRIS）', () => {
  const d = parse.parseMediaLine(linuxLine);
  assert.equal(d.status, 'PLAYING');
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

await check('依赖缺失错误行被识别', () => {
  const d = parse.parseMediaLine(JSON.stringify({ ok: false, error: 'playerctl-missing' }));
  assert.equal(d.ok, false);
  assert.equal(d.error, 'playerctl-missing');
});

await check('非 JSON 噪声行返回 null', () => {
  assert.equal(parse.parseMediaLine('playerctl: command not found'), null);
  assert.equal(parse.parseMediaLine(''), null);
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
