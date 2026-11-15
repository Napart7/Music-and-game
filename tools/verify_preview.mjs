import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE_URL = 'file:///C:/Users/Napart/WorkBuddy/2026-11-14-20-17-39/GameLyricOverlay/src/preview.html';
const PROFILE = 'C:/Users/Napart/AppData/Local/Temp/glasslyrics/cdp-profile';
const PORT = 9333;

const proc = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1600,1000', 'about:blank'
], { stdio: 'ignore', windowsHide: true });

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
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch { /* endpoint not up yet */ }
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
  for (let i = 0; i < 60; i++) {
    ready = await ev("document.querySelectorAll('#curGlyphs .glyph').length").catch(() => 0);
    if (ready > 0) break;
    await sleep(150);
  }
  await sleep(700);

  check('逐字 Glyph 已渲染', ready > 0, `#curGlyphs .glyph = ${ready}`);

  await ev("switchTrack(0)");
  await sleep(80);
  const noDup = await ev("document.getElementById('prevLine').textContent.trim() !== document.getElementById('curGlyphs').textContent.trim()");
  check('首句不重复显示上一句', noDup === true);

  const color = await ev("getComputedStyle(document.querySelector('#curGlyphs .glyph')).color");
  check('文字色对齐 jar 的 #F7E1D7', /247, 225, 215/.test(color), `color = ${color}`);

  const stroke = await ev("getComputedStyle(document.querySelector('#curGlyphs .glyph')).getPropertyValue('-webkit-text-stroke')");
  check('黑色描边对齐 jar 的 0.45 alpha', /0\.45/.test(stroke), `stroke = ${stroke}`);

  const after = await ev("getComputedStyle(document.querySelector('#curGlyphs .glyph'),'::after').content");
  check('逐字扫光高亮层存在', after && after !== 'none' && after !== 'normal', `content = ${after}`);

  const pStyle = await ev("document.querySelector('#curGlyphs .glyph').style.getPropertyValue('--p')");
  check('逐字进度在推进', /%$/.test(pStyle || ''), `--p = ${pStyle}`);

  const glowCount = await ev("document.querySelectorAll('#curGlow .glyph').length");
  check('DeepGlow 发光层与主层同步', glowCount === ready, `glow glyphs = ${glowCount}`);
  const glowFilter = await ev("getComputedStyle(document.getElementById('curGlow')).filter");
  check('DeepGlow 多级模糊生效', /blur/.test(glowFilter), `filter = ${glowFilter}`);

  const uneven = await ev("(() => { const d=[]; for(let i=1;i<charStarts.length;i++) d.push(+(charStarts[i]-charStarts[i-1]).toFixed(4)); return new Set(d).size > 1; })()");
  check('charTimes 为逐字非均匀时间轴', uneven === true);

  const popStyle = await ev("document.querySelector('#curGlyphs .glyph').style.getPropertyValue('--pop')");
  check('wordPop 逐字弹跳在生效', parseFloat(popStyle) >= 1, `--pop = ${popStyle}`);
  const wx = await ev("document.querySelector('#curGlyphs .glyph').style.getPropertyValue('--wx')");
  check('8fps wiggle 字摆动在生效', /px$/.test(wx || ''), `--wx = ${wx}`);

  const noOverlap = await ev(`(() => {
    const a = document.querySelector('.safe').getBoundingClientRect();
    const b = document.querySelector('#curLine').getBoundingClientRect();
    return !(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
  })()`);
  check('中央视野区与歌词不重叠', noOverlap === true, `noOverlap = ${noOverlap}`);

  const safeVisible = await ev("getComputedStyle(document.querySelector('.safe')).display !== 'none'");
  check('中央保留区标线默认显示', safeVisible === true);

  const beforeTitle = await ev("document.getElementById('islandTitle').textContent");
  await ev("document.getElementById('nextBtn').click()");
  await sleep(120);
  const afterTitle = await ev("document.getElementById('islandTitle').textContent");
  check('下一首按钮真的换曲目', beforeTitle !== afterTitle, `${beforeTitle} -> ${afterTitle}`);

  const lyricChanged = await ev("document.getElementById('curGlyphs').textContent.length > 0");
  check('换曲目后歌词同步刷新', lyricChanged === true);

  const tracksCount = await ev("document.querySelectorAll('#tracks .track').length");
  check('播放器面板列出 4 首曲目', tracksCount === 4, `count = ${tracksCount}`);

  await ev("document.querySelectorAll('#tracks .track')[2].click()");
  await sleep(120);
  const picked = await ev("document.getElementById('islandTitle').textContent");
  check('点击面板曲目可切换', picked === '屏幕微光', `picked = ${picked}`);

  await ev("(() => { const s=document.getElementById('search'); s.value='折叠'; s.dispatchEvent(new Event('input')); })()");
  await sleep(80);
  const filtered = await ev("document.querySelectorAll('#tracks .track').length");
  check('搜索过滤生效', filtered === 1, `filtered = ${filtered}`);
  await ev("(() => { const s=document.getElementById('search'); s.value=''; s.dispatchEvent(new Event('input')); })()");

  await ev("document.getElementById('layoutBtn').click()");
  const layout = await ev("document.body.dataset.layout");
  check('布局可切换到居中', layout === 'center', `layout = ${layout}`);
  await ev("document.getElementById('layoutBtn').click(); document.getElementById('layoutBtn').click(); document.getElementById('layoutBtn').click()");
  check('布局可循环回双侧', (await ev("document.body.dataset.layout")) === 'split');

  await ev("document.getElementById('guidesBtn').click()");
  check('中央标线可隐藏', (await ev("document.body.classList.contains('hide-guides')")) === true);

  await ev("document.getElementById('tintBtn').click()");
  const tint = await ev("document.documentElement.style.getPropertyValue('--glow-rgb')");
  check('glowTint 四色可切换', tint === '255, 97, 158', `--glow-rgb = ${tint}`);

  await ev("document.getElementById('popBtn').click()");
  check('wordPop 可关闭', (await ev("document.getElementById('popBtn').textContent")).includes('关'));
  await ev("document.getElementById('popBtn').click()");

  await ev("document.getElementById('wiggleBtn').click()");
  check('wiggle 可关闭', (await ev("document.getElementById('wiggleBtn').textContent")).includes('关'));
  await ev("document.getElementById('wiggleBtn').click()");

  await ev("document.getElementById('flashBtn').click()");
  check('textFlash 整句砸入可开启', (await ev("document.getElementById('flashBtn').textContent")).includes('开'));
  await ev("document.getElementById('flashBtn').click()");

  await ev("(() => { const s=document.getElementById('glowStrength'); s.value='1.2'; s.dispatchEvent(new Event('input')); })()");
  const gs = await ev("document.documentElement.style.getPropertyValue('--glow-strength')");
  check('glowStrength 可调', gs === '1.2', `--glow-strength = ${gs}`);

  await ev("document.getElementById('strokeBtn').click()");
  check('黑色描边可关闭', (await ev("document.body.classList.contains('no-stroke')")) === true);
  await ev("document.getElementById('strokeBtn').click()");

  await ev("document.getElementById('playBtn').click()");
  const paused = await ev("document.getElementById('playBtn').textContent");
  check('播放/暂停可切换', paused === '▶', `button = ${paused}`);

  check('运行期无 JS 异常', errors.length === 0, errors.join(' | ') || 'none');
} catch (err) {
  check('测试执行完成', false, err.message);
} finally {
  if (ws) ws.close();
  proc.kill();
}

console.log('\n=== preview.html 交互回归测试 ===');
let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`);
  if (!c.ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exitCode = failed ? 1 : 0;
