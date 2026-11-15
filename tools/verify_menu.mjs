// Regression for the liquid-glass main menu, glyph-emitted glow and real word-level timing.
// Runs app/renderer/index.html in headless Edge via CDP; no Electron and no network needed.
import { resolveEdge, toFileUrl, profileDir, CHROMIUM_ARGS } from './cdp-env.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EDGE = resolveEdge();
const FILE_URL = toFileUrl(path.join(ROOT, 'app', 'renderer', 'index.html'));
const PROFILE = profileDir('menu');
const PORT = 9336;

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
  await sleep(400);

  /* ---------------- main menu ---------------- */
  check('逐字 Glyph 已渲染', ready > 0, `glyphs=${ready}`);
  const menu0 = await ev('window.getMenuState()');
  check('主菜单存在且默认关闭', menu0.open === false && menu0.pages === 7 && menu0.navs === 7, JSON.stringify(menu0));
  await ev('window.setPanel(true)');
  const menu1 = await ev('window.getMenuState()');
  check('主菜单可唤出', menu1.open === true && (await ev("document.body.dataset.menuOpen")) === '1');

  const glass = await ev(`(() => {
    const p = document.getElementById('panel');
    const s = getComputedStyle(p);
    return { blur: s.backdropFilter || s.webkitBackdropFilter, radius: s.borderRadius,
             border: s.borderTopWidth, shadow: s.boxShadow,
             before: getComputedStyle(p, '::before').backgroundImage,
             after: getComputedStyle(p, '::after').boxShadow };
  })()`);
  check('液态玻璃：背景模糊', /blur\(/.test(glass.blur), glass.blur);
  check('液态玻璃：大圆角与边缘', parseFloat(glass.radius) >= 20 && parseFloat(glass.border) >= 1,
    `${glass.radius} / ${glass.border}`);
  check('液态玻璃：折射渐变层', /gradient/.test(glass.before), glass.before.slice(0, 60));
  check('液态玻璃：内边缘高光', /inset/.test(glass.after), glass.after.slice(0, 60));

  await ev("document.querySelector('#menuNav [data-tab=visual]').click()");
  check('导航切换到视觉页', (await ev('window.getMenuState().tab')) === 'visual' &&
    (await ev("document.querySelector('.page[data-page=visual]').classList.contains('active')")) === true);
  await ev("document.querySelector('#menuNav [data-tab=lyrics]').click()");
  check('导航切换到歌词页', (await ev('window.getMenuState().tab')) === 'lyrics');
  await sleep(450);   // opacity transition is .35s
  check('菜单打开时歌词淡出', (await ev("parseFloat(getComputedStyle(document.querySelector('.side.left')).opacity)")) < 0.3);

  /* ---------------- glow comes from the glyphs ---------------- */
  const glow = await ev(`(() => {
    const g = document.querySelector('#curGlyphs .glyph');
    const s = getComputedStyle(g);
    const a = getComputedStyle(g, '::after');
    return { box: s.boxShadow, text: s.textShadow, stroke: s.webkitTextStrokeWidth,
             clip: a.clipPath, mask: a.webkitMaskImage || a.maskImage,
             afterText: a.textShadow, layer: !!document.querySelector('.glow-layer'),
             blurLayer: !!document.getElementById('curGlow') };
  })()`);
  check('字形自带多层发散辉光', (glow.text.match(/rgb|rgba/g) || []).length >= 3, glow.text.slice(0, 90));
  check('不存在独立模糊发光层', glow.layer === false && glow.blurLayer === false);
  check('没有矩形 box-shadow 底板', glow.box === 'none', glow.box);
  check('高亮层用柔边遮罩而非硬裁剪', /gradient/.test(glow.mask) && glow.clip === 'none',
    `mask=${glow.mask.slice(0, 60)} clip=${glow.clip}`);
  check('高亮层同样由字形发光', /rgb/.test(glow.afterText), glow.afterText.slice(0, 80));
  check('保留黑色描边', parseFloat(glow.stroke) > 0, glow.stroke);

  /* ---------------- visual controls ---------------- */
  await ev("document.querySelector('.tint[data-value=pink]').click()");
  check('辉光四色可切换', (await ev("getComputedStyle(document.documentElement).getPropertyValue('--glow-rgb').trim()")) === '255,97,158');
  await ev("(() => { const r=document.querySelector('[data-cfg=glowStrength]'); r.value='0.8'; r.dispatchEvent(new Event('input')); })()");
  check('辉光强度滑块生效', (await ev("getComputedStyle(document.documentElement).getPropertyValue('--glow-strength').trim()")) === '0.8');
  await ev("(() => { const r=document.querySelector('[data-cfg=fontScale]'); r.value='1.2'; r.dispatchEvent(new Event('input')); })()");
  check('字号滑块生效', (await ev("getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim()")) === '1.2');
  await ev("document.querySelector('#layoutSeg [data-layout=center]').click()");
  check('布局按钮切换', (await ev('document.body.dataset.layout')) === 'center');
  await ev("document.querySelector('#layoutSeg [data-layout=split]').click()");

  /* ---------------- source routing + platform ---------------- */
  await ev("document.querySelector('#sourceSeg [data-value=netease]').click()");
  check('歌词源按钮高亮切换',
    (await ev("document.querySelector('#sourceSeg [data-value=netease]').classList.contains('on')")) === true);
  await ev("window.applyTrack({title:'孤勇者',artist:'陈奕迅',album:'孤勇者',status:'PLAYING',position:22.5,duration:256,app:'cloudmusic.exe',platform:'netease'})");
  check('显示网易云平台', (await ev("document.getElementById('pPlatform').textContent")) === '网易云音乐');
  check('进度条按 SMTC 更新', parseFloat(await ev("document.getElementById('pBar').style.width")) > 0);
  const covState = await ev(`window.applyTrack({title:'孤勇者',artist:'陈奕迅',status:'PLAYING',position:22.5,duration:256,platform:'netease'})`);
  const cov1 = await ev(`(() => { window.setCover('data:image/png;base64,iVBORw0KGgo=');
    const c = document.getElementById('pCover'), ph = document.getElementById('pCoverPh');
    return { hidden: c.hidden, src: c.src.slice(0, 30), ph: getComputedStyle(ph).display }; })()`);
  check('封面 URL 正常显示', cov1.hidden === false && cov1.src.startsWith('data:image/png'), JSON.stringify(cov1));
  await ev("window.applyTrack({title:'无封面曲',artist:'x',status:'STOPPED',position:1,duration:99,platform:'netease',active:false})");
  const cov2 = await ev(`(() => { const c = document.getElementById('pCover'), ph = document.getElementById('pCoverPh');
    return { hidden: c.hidden, ph: getComputedStyle(ph).display }; })()`);
  check('无封面时回落占位符', cov2.hidden === true && cov2.ph !== 'none', JSON.stringify(cov2));
  await ev("window.applyTrack({platform:'qqmusic'})");
  check('显示 QQ 音乐平台', (await ev("document.getElementById('pPlatform').textContent")) === 'QQ 音乐');

  /* ---------------- real word-level timeline ---------------- */
  const words = [
    { time: 0, text: '第一句', words: [{ s: 0, e: 1 }, { s: 1, e: 2 }, { s: 2, e: 3 }] },
    { time: 10, text: '第二句', words: [{ s: 10, e: 11 }, { s: 11, e: 12 }, { s: 12, e: 13 }] },
    { time: 20, text: '第三句', words: [{ s: 20, e: 21 }, { s: 21, e: 22 }, { s: 22, e: 23 }] }
  ];
  const applied = await ev(`window.applyLyrics(${JSON.stringify({
    ok: true, provider: '网易云音乐', source: 'netease-yrc', synced: true,
    wordSync: true, lines: words, offsetMs: 0
  })})`);
  check('YRC 歌词被接受', applied.mode === 'real' && applied.wordSync === true, JSON.stringify(applied));
  check('状态显示真实逐字', /YRC 真实逐字/.test(await ev("document.getElementById('pWordSync').textContent")));
  // The menu now pauses the lyric animation (it is invisible behind the panel), so the
  // timeline is verified the way a user sees it: with the menu closed.
  await ev("window.setPanel(false)");
  await ev("window.applyTrack({status:'PLAYING',position:10.4,duration:40})");
  await sleep(300);
  const st = await ev('window.getLyricState()');
  check('进入绝对逐字时间轴模式', st.wordSync === true && st.charMode === 'absolute', JSON.stringify(st));
  check('按绝对时间定位到第二句', st.currentIdx === 1, `idx=${st.currentIdx}`);
  const ps = await ev("[...document.querySelectorAll('#curGlyphs .glyph')].map(g=>g.style.getPropertyValue('--p'))");
  check('第一个字正在扫光', parseFloat(ps[0]) > 0, JSON.stringify(ps));
  check('未开始的字保持未点亮', parseFloat(ps[1]) < 0, JSON.stringify(ps));

  /* ---------------- close menu ---------------- */
  await ev("document.getElementById('menuClose').click()");
  check('关闭按钮收起主菜单', (await ev('window.getMenuState().open')) === false);

  /* ---------------- click-through safety nets ("overlay blocks game clicks") ---------------- */
  await ev("window.setPanel(true)");
  await ev("document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
  check('点面板外自动收起菜单', (await ev('window.getMenuState().open')) === false);
  await ev("window.setEditMode(true)");
  await ev("document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
  check('点空白自动退出拖动模式', (await ev("document.body.dataset.edit")) === '0');
  await ev("window.setEditMode(true)");
  await ev("document.querySelector('.side.left').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
  check('点歌词本身不退出拖动模式', (await ev("document.body.dataset.edit")) === '1');
  await ev("window.setEditMode(false)");

  /* ---------------- rebindable hotkeys ---------------- */
  const hkCount = await ev("document.querySelectorAll('#hkList .hotkey').length");
  check('热键列表渲染 8 个动作', hkCount === 8, `rows=${hkCount}`);
  await ev("window.applyHotkey('panel', 'Control+Alt+K')");
  const hk1 = await ev("document.querySelector('#hkList [data-hk=panel]').textContent");
  check('热键重绑定生效', /Control \+ Alt \+ K/.test(hk1), hk1);
  await ev("window.applyHotkey('panel', 'Control+Alt+P')");
  const hkEmpty = await ev("(() => { window.applyHotkey('next',''); return document.querySelector('#hkList [data-hk=next]').textContent; })()");
  check('热键可清空为未设置', hkEmpty.includes('未设置'), hkEmpty);

  /* ---------------- free lyric placement ---------------- */
  await ev("window.applyLyricPos({left:{x:12,y:30},right:null})");
  const pos1 = await ev(`(() => { const s = getComputedStyle(document.querySelector('.side.left'));
    return { leftPct: parseFloat(s.left) / window.innerWidth * 100,
             topPct: parseFloat(s.top) / window.innerHeight * 100,
             custom: document.querySelector('.side.left').dataset.customPos }; })()`);
  check('自定义歌词位置生效', pos1.custom === '1' && Math.abs(pos1.leftPct - 12) < 0.5 &&
    Math.abs(pos1.topPct - 30) < 0.5, JSON.stringify(pos1));
  await ev("window.setEditMode(true)");
  await sleep(450);   // opacity transition is .35s
  const ed = await ev(`(() => { const s = getComputedStyle(document.querySelector('.side.left'));
    return { edit: document.body.dataset.edit, pe: s.pointerEvents, opacity: s.opacity }; })()`);
  check('拖动编辑模式：歌词可点且不淡出', ed.edit === '1' && ed.pe === 'auto' && parseFloat(ed.opacity) === 1, JSON.stringify(ed));
  await ev("window.resetLyricPos()");
  const pos2 = await ev("document.querySelector('.side.left').dataset.customPos");
  check('重置位置恢复默认', pos2 === '0', `custom=${pos2}`);
  await ev("window.setEditMode(false)");

  /* ---------------- style sliders ---------------- */
  await ev("(() => { const r=document.querySelector('[data-cfg=lineHeight]'); r.value='1.9'; r.dispatchEvent(new Event('input')); })()");
  check('行距滑块生效', (await ev("getComputedStyle(document.documentElement).getPropertyValue('--lh').trim()")) === '1.9');
  await ev("(() => { const r=document.querySelector('[data-cfg=sideWidth]'); r.value='32'; r.dispatchEvent(new Event('input')); })()");
  check('侧栏宽度滑块生效', (await ev("getComputedStyle(document.documentElement).getPropertyValue('--side-w').trim()")) === '32vw');
  check('选歌页存在', (await ev("document.querySelectorAll('.page[data-page=pick]').length")) === 1);

  /* ---------------- floating lyric rows ---------------- */
  const rows1 = await ev("window.getfloatRows()");
  check('漂浮多行渲染（默认 4 行）', rows1.left === 4 && rows1.drift === 'drift', JSON.stringify(rows1));
  await ev("(() => { const r=document.querySelector('[data-cfg=floatLines]'); r.value='6'; r.dispatchEvent(new Event('input')); })()");
  await sleep(600);   // rows rebuild on the next tick
  const rows2 = await ev("window.getfloatRows()");
  check('漂浮行数可调到 6', rows2.left === 6, JSON.stringify(rows2));
  const fstyles = await ev(`(() => {
    const rows = [...document.querySelectorAll('.side.left .float-row')];
    return { ops: rows.map(r => r.style.getPropertyValue('--fo')),
             fss: rows.map(r => r.style.getPropertyValue('--fs')),
             durs: [...new Set(rows.map(r => r.style.getPropertyValue('--dur')))],
             anims: rows.map(r => getComputedStyle(r).animationName) };
  })()`);
  check('透明度/字号按距离渐变', new Set(fstyles.ops).size >= 3 && new Set(fstyles.fss).size >= 3,
    JSON.stringify({ ops: fstyles.ops, fss: fstyles.fss }));
  check('各行漂移速度不同', fstyles.durs.length >= 3, 'durs=' + fstyles.durs.join(','));
  check('漂移动画由合成器运行', fstyles.anims.every(a => a === 'drift'), JSON.stringify(fstyles.anims));
  await ev("(() => { const c=document.querySelector('[data-cfg=floatDrift]'); c.checked=false; c.dispatchEvent(new Event('input')); })()");
  await sleep(300);
  const driftOff = await ev("getComputedStyle(document.querySelector('.side.left .float-row')).animationName");
  check('漂移动画可关闭', driftOff === 'none', driftOff);
  await ev("(() => { const c=document.querySelector('[data-cfg=floatDrift]'); c.checked=true; c.dispatchEvent(new Event('input')); })()");

  /* ---------------- perf: zero idle writes, quantised sweep, low-end mode ---------------- */
  await ev("(() => { const c=document.querySelector('[data-cfg=wiggle]'); c.checked=false; c.dispatchEvent(new Event('input')); })()");
  await ev("window.applyTrack({status:'PAUSED',position:10.4,duration:40})");
  await sleep(2600);   // let pop/slam settle AND the 2s paused-position ramp finish
  const w0 = await ev("({...window.__w})");
  await sleep(800);
  const w1 = await ev("({...window.__w})");
  const idleWrites = (w1.p - w0.p) + (w1.pop - w0.pop) + (w1.slam - w0.slam) + (w1.wx - w0.wx) + (w1.wy - w0.wy);
  check('暂停时零无效重绘', idleWrites === 0, JSON.stringify({ w0, w1 }));
  const pVals = await ev("[...document.querySelectorAll('#curGlyphs .glyph')].map(g=>g.style.getPropertyValue('--p'))");
  check('扫光量化为整数百分点', pVals.every(v => v === '-8%' || /^\d+%$/.test(v)), JSON.stringify(pVals));
  await ev("(() => { const c=document.querySelector('[data-cfg=perfLow]'); c.checked=true; c.dispatchEvent(new Event('input')); })()");
  const perf = await ev(`(() => { const g = document.querySelector('#curGlyphs .glyph');
    const s = getComputedStyle(g).textShadow;
    return { perf: document.body.dataset.perf, layers: (s.match(/rgba/g) || []).length }; })()`);
  check('低配模式辉光减到 2 层', perf.perf === 'low' && perf.layers <= 2, JSON.stringify(perf));
  const fps = await ev(`(async () => { window.__w.frames = 0; await new Promise(r => setTimeout(r, 1000)); return window.__w.frames; })()`);
  check('低配模式帧率限到 ~30', fps > 18 && fps < 42, 'frames/s=' + fps);
  await ev("(() => { const c=document.querySelector('[data-cfg=perfLow]'); c.checked=false; c.dispatchEvent(new Event('input')); })()");
  await ev("(() => { const c=document.querySelector('[data-cfg=wiggle]'); c.checked=true; c.dispatchEvent(new Event('input')); })()");

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
