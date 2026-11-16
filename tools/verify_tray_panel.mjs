// Persistent tray panel DOM/IPC regression. No real configuration or player is touched.
import { resolveEdge, toFileUrl, profileDir, CHROMIUM_ARGS } from './cdp-env.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 9338;
const proc = spawn(resolveEdge(), [
  ...CHROMIUM_ARGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir('tray-panel')}`,
  '--window-size=500,760', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let browserErr = '';
proc.stderr.on('data', (d) => { browserErr += d.toString(); browserErr = browserErr.slice(-4000); });
let ws;
let seq = 0;
const pending = new Map();
const errors = [];
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error('CDP timeout: ' + method)); }, 10000);
  });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
}

try {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); }
    catch { /* browser starting */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('CDP endpoint not ready ' + browserErr.slice(-300));
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__actions = []; window.__configs = [];
    const initial = { config:{lyricSource:'auto',autoFit:true,hideWhenNoGame:false,openAtLogin:false},
      layerVisible:true,panelOpen:false,pinned:true,track:{title:'测试歌曲',artist:'测试歌手',status:'PLAYING'} };
    window.glassTray = { getState:()=>Promise.resolve(initial), onState:(cb)=>{window.__onState=cb;},
      action:(a)=>window.__actions.push(a), setConfig:(key,value)=>{window.__configs.push({key,value});return Promise.resolve({});} };
  ` });
  await send('Page.navigate', { url: toFileUrl(path.join(ROOT, 'app', 'tray-panel.html')) });
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    ready = await ev("!!window.getTrayPanelState && window.getTrayPanelState()?.pinned === true").catch(() => false);
    if (!ready) await sleep(100);
  }
  check('常驻菜单通过独立 IPC 初始化', ready);
  check('正在播放信息可见', (await ev("document.getElementById('track').textContent")) === '测试歌曲');

  await ev("document.getElementById('toggleLayer').click(); document.querySelector('[data-action=toggle]').click()");
  check('覆盖层与播放操作走受限 IPC',
    (await ev("JSON.stringify(window.__actions)")) === JSON.stringify(['toggle-layer', 'toggle']));
  check('点击选项不自行隐藏菜单', await ev("getComputedStyle(document.getElementById('trayPanel')).display !== 'none'"));

  await ev("window.__onState({config:{lyricSource:'netease',autoFit:false,hideWhenNoGame:true,openAtLogin:true},layerVisible:false,panelOpen:true,pinned:true,track:null})");
  const state = await ev(`({layer:document.getElementById('toggleLayer').textContent,
    panel:document.getElementById('togglePanel').textContent,source:document.getElementById('source').value,
    autoFit:document.querySelector('[data-key=autoFit]').checked,hide:document.querySelector('[data-key=hideWhenNoGame]').checked,
    login:document.querySelector('[data-key=openAtLogin]').checked})`);
  check('后台状态变化只更新内容不收起', state.layer === '显示歌词覆盖层' && state.panel === '收起主菜单' &&
    state.source === 'netease' && !state.autoFit && state.hide && state.login, JSON.stringify(state));

  await ev("(() => { const s=document.getElementById('source');s.value='kugou';s.dispatchEvent(new Event('change')); })()");
  await ev("(() => { const c=document.querySelector('[data-key=autoFit]');c.checked=true;c.dispatchEvent(new Event('change')); })()");
  check('来源与开关修改发送到主进程', (await ev("JSON.stringify(window.__configs)")) ===
    JSON.stringify([{ key: 'lyricSource', value: 'kugou' }, { key: 'autoFit', value: true }]));

  await ev("document.getElementById('close').click(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
  check('关闭按钮与 Esc 都显式请求关闭', (await ev("window.__actions.filter(a=>a==='close').length")) === 2);
  check('菜单没有失焦自动关闭处理器', await ev("(() => { window.dispatchEvent(new Event('blur')); return window.__actions.filter(a=>a==='close').length===2 && !!window.getTrayPanelState(); })()"));
  check('页面无外部网络依赖', (await ev("performance.getEntriesByType('resource').filter(r=>/^https?:/.test(r.name)).length")) === 0);
  check('运行期无 JS 异常', errors.length === 0, errors.join(' | ') || 'none');
} catch (e) {
  check('测试执行未中断', false, String(e && e.stack || e));
} finally {
  try { ws && ws.close(); } catch {}
  try { proc.kill(); } catch {}
}
let pass = 0;
for (const c of checks) {
  if (c.ok) pass++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}`);
}
console.log(`\n${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
