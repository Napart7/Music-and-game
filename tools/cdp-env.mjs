// Shared CDP environment for the UI regression scripts.
// Why: the old scripts hard-coded `C:/Users/Napart/...` profiles and a Windows-only Edge
// path, so they could not run on CI or on macOS / Linux.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** file:// URL that works on Windows (D:\a\b) and POSIX (/home/u/b). */
export function toFileUrl(p) {
  const abs = path.resolve(p).replace(/\\/g, '/');
  return 'file://' + (abs.startsWith('/') ? '' : '/') + abs;
}

const CANDIDATES = [
  process.env.EDGE_PATH,
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

/** First existing Chromium-based browser; falls back to `msedge` on PATH. */
export function resolveEdge() {
  for (const p of CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* keep looking */ }
  }
  return 'msedge';
}

/** Per-suite throwaway profile in the OS temp dir (no user-dir hard-coding). */
export function profileDir(name) {
  return path.join(os.tmpdir(), 'glasslyrics', 'cdp-' + name);
}
