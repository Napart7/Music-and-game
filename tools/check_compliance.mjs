// Cross-platform compliance + syntax gate (runs on Linux/macOS/Windows in CI).
// Replaces the old PowerShell-only check so one workflow can verify all three OSes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const failures = [];
const ok = (name) => console.log('PASS  ' + name);
const bad = (name, detail) => { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + '  [' + detail + ']'); };

/* 1) required files (same list the release workflow needs on every OS) */
const required = [
  'README.md', 'LICENSE', 'docs/技术方案.md', 'docs/使用说明.md', 'docs/第三方声明.md',
  'docs/平台适配.md', 'docs/跨平台适配.md', 'docs/自检报告-v1.2.md', 'docs/性能自检-v1.3.md',
  'docs/更新说明-v1.4.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'app/changelog.json',
  'app/main.js', 'app/preload.js', 'app/tray-preload.js', 'app/tray-panel.html',
  'app/playback-clock.js', 'app/lyrics.js', 'app/providers.js', 'app/window-classify.js',
  'app/backends/index.js', 'app/backends/parse.js',
  'app/backends/media-mac.js', 'app/backends/control-mac.js', 'app/backends/window-mac.js',
  'app/backends/media-linux.sh', 'app/backends/control-linux.sh', 'app/backends/window-linux.sh',
  'app/smtc-bridge.ps1', 'app/smtc-control.ps1', 'app/window-probe.ps1',
  'app/renderer/index.html', 'tools/verify_providers.mjs', 'tools/verify_backends.mjs',
  'tools/verify_classify.mjs'
];
for (const f of required) {
  fs.existsSync(path.join(ROOT, f)) ? ok('存在 ' + f) : bad('缺少文件 ' + f);
}

/* 2) no secrets, no GPL sources */
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'dist-prev'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const files = walk(ROOT);
const secretNames = /(^|[\\/])(\.env|.*\.key|.*\.pem|netease_cookie\.txt|qqmusic_cookie\.txt)$/i;
const foundSecrets = files.filter((f) => secretNames.test(f));
foundSecrets.length ? bad('发现敏感文件', foundSecrets.join(',')) : ok('无敏感文件');

const sourceExt = /\.(js|mjs|cjs|ts|py|ps1|sh)$/i;
const gplMark = /me\/sorihiko\/dango|LDDC\/core/;
const hits = files.filter((f) => sourceExt.test(f))
  .filter((f) => { try { return gplMark.test(fs.readFileSync(f, 'utf8')); } catch { return false; } });
hits.length ? bad('检测到 GPL 源码引用', hits.join(',')) : ok('无 GPL 源码引用');

/* 3) syntax: JS/MJS everywhere (node --check is portable) */
const jsFiles = files.filter((f) => /\.(js|mjs|cjs)$/.test(f) && !f.includes('node_modules'));
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status === 0) continue;
  // ESM files are not accepted by --check on some Node versions; fall back to eval parse.
  bad('语法错误 ' + path.relative(ROOT, f), (r.stderr || '').split('\n')[0]);
}
ok(`JS 语法检查完成（${jsFiles.length} 个文件）`);

/* 3a) every top-level app/*.js must be packed (a missing entry crashes the packaged app) */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'package.json'), 'utf8'));
  const packed = new Set((pkg.build?.files) || []);
  const appJs = fs.readdirSync(path.join(ROOT, 'app'))
    .filter((f) => f.endsWith('.js') && f !== 'package.json');
  const missing = appJs.filter((f) => !packed.has(f));
  if (missing.length) bad('打包清单缺少 ' + missing.join(', '), 'app/package.json build.files');
  else ok(`app/*.js 已全部加入打包清单（${appJs.length} 个）`);
}

/* 3b) app/changelog.json must match CHANGELOG.md (the About page reads it) */
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'gen_changelog.mjs'), '--check'],
    { encoding: 'utf8' });
  if (r.status === 0) ok('CHANGELOG 与 app/changelog.json 同步');
  else bad('CHANGELOG 未同步', (r.stderr || r.stdout || '').trim().split('\n')[0]);
}

/* 4) POSIX scripts must be LF and start with a shebang */
for (const f of files.filter((x) => x.endsWith('.sh'))) {
  const buf = fs.readFileSync(f);
  const hasCRLF = buf.includes(Buffer.from('\r\n'));
  const head = buf.slice(0, 20).toString('utf8');
  if (hasCRLF) bad('shell 脚本含 CRLF ' + path.relative(ROOT, f));
  if (!head.startsWith('#!')) bad('shell 脚本缺少 shebang ' + path.relative(ROOT, f));
}
ok('shell 脚本换行符 / shebang 检查完成');

/* 5) renderer inline scripts parse (external scripts are checked as app/*.js above) */
for (const name of ['app/renderer/index.html', 'app/tray-panel.html']) {
  try {
    const html = fs.readFileSync(path.join(ROOT, name), 'utf8');
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    if (!blocks.length) throw new Error('no inline <script> block');
    for (const m of blocks) new Function(m[1]);
    ok('内联脚本可解析 ' + name);
  } catch (e) { bad('渲染层脚本解析失败 ' + name, e.message); }
}

console.log('\n' + (failures.length ? failures.length + ' 项失败' : '全部通过'));
process.exit(failures.length ? 1 : 0);
