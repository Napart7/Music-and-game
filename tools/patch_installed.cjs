'use strict';
/**
 * Patch an already-installed GlassLyrics with the current source tree.
 *
 *   node tools/patch_installed.cjs [installDir]
 *
 * installDir defaults to GL_INSTALL_DIR, then D:\软件\GlassLyrics on Windows.
 * Rebuilds resources/app.asar from app/package.json -> build.files, backs up the
 * old one, and refreshes the scripts shipped as extraResources. The app must be
 * restarted afterwards; this script never kills running processes.
 *
 * Purely a local convenience helper. It is not part of the packaged app and it
 * does not touch the git working tree.
 */
const fs = require('node:fs');
const path = require('node:path');
const asar = require('../app/node_modules/@electron/asar');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const TMP = path.join(__dirname, '.tmp');
const SRC = path.join(TMP, 'patch-asar-src');
const OUT = path.join(TMP, 'patch-app.asar');

const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const patterns = pkg.build.files;
const extra = pkg.build.extraResources.map((e) => e.from);

function collect() {
  const files = [];
  for (const p of patterns) {
    if (p.includes('*')) {
      const dir = p.split('/')[0];
      const walk = (rel) => {
        const abs = path.join(APP, rel);
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
          const r = path.join(rel, e.name);
          if (e.isDirectory()) walk(r);
          else if (e.isFile()) files.push(r);
        }
      };
      walk(dir);
    } else files.push(p);
  }
  return [...new Set(files)].sort();
}

function copyInto(files, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  for (const rel of files) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(APP, rel), to);
  }
}

function resolveInstallDir(argv) {
  if (argv[2]) return argv[2];
  if (process.env.GL_INSTALL_DIR) return process.env.GL_INSTALL_DIR;
  if (process.platform === 'win32') return 'D:\\软件\\GlassLyrics';
  return '/Applications/GlassLyrics.app/Contents/Resources';
}

(async () => {
  const install = resolveInstallDir(process.argv);
  const res = fs.existsSync(path.join(install, 'resources'))
    ? path.join(install, 'resources') : install;
  const target = path.join(res, 'app.asar');
  if (!fs.existsSync(target)) {
    console.error('Not an installed GlassLyrics (no app.asar): ' + target);
    console.error('Pass the install directory explicitly: node tools/patch_installed.cjs <dir>');
    process.exit(1);
  }

  fs.mkdirSync(TMP, { recursive: true });
  const files = collect();
  copyInto(files, SRC);
  await asar.createPackage(SRC, OUT);

  const buf = fs.readFileSync(OUT);
  const version = pkg.version;
  const ok = buf.toString('utf8').includes('"version": "' + version + '"');
  if (!ok) { console.error('Built asar failed version check'); process.exit(1); }

  const bak = target + '.bak-' + version + '-previous';
  if (!fs.existsSync(bak)) fs.copyFileSync(target, bak);
  fs.copyFileSync(OUT, target);

  // extraResources live outside the asar; keep Windows PowerShell bridges and
  // the mac/linux backend scripts in sync too.
  for (const from of extra) {
    const src = path.join(APP, from);
    const dest = path.join(res, from);
    if (fs.statSync(src).isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const e of fs.readdirSync(src)) fs.copyFileSync(path.join(src, e), path.join(dest, e));
    } else fs.copyFileSync(src, dest);
  }

  console.log('patched ' + target);
  console.log('  version ' + version + ', ' + files.length + ' files, ' +
    (buf.length / 1048576).toFixed(2) + ' MB');
  console.log('  backup  ' + bak);
  console.log('  extraResources synced: ' + extra.join(', '));
  console.log('Restart GlassLyrics to load it. Running processes were left alone.');
})();
