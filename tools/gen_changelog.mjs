#!/usr/bin/env node
/**
 * Generate app/changelog.json from the repository CHANGELOG.md.
 *
 * Why: the in-app "About → 最近更新" card must show the same history as GitHub.
 * Keeping one hand-written source (CHANGELOG.md) and generating the runtime copy
 * removes the usual "docs say one thing, the app says another" drift.
 *
 * Usage:
 *   node tools/gen_changelog.mjs           # write app/changelog.json
 *   node tools/gen_changelog.mjs --check   # verify it is up to date (exit 1 if not)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'CHANGELOG.md');
const OUT = path.join(ROOT, 'app', 'changelog.json');
const MAX_PER_VERSION = 5;
const MAX_CHARS = 96;

/** Strip the small amount of markdown used in the changelog bullets. */
function clean(line) {
  return line
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // [text](url) -> text
    .replace(/`([^`]+)`/g, '$1')               // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')         // bold
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s) {
  if (s.length <= MAX_CHARS) return s;
  return s.slice(0, MAX_CHARS - 1).replace(/[，,、\s]+$/, '') + '…';
}

export function buildChangelog(markdown) {
  const versions = [];
  let cur = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const head = raw.match(/^##\s+\[?v?(\d+\.\d+\.\d+)\]?\s*[-–—]\s*(\d{4}-\d{2}-\d{2})/);
    if (head) {
      cur = { version: head[1], date: head[2], highlights: [] };
      versions.push(cur);
      continue;
    }
    if (/^##\s+/.test(raw)) { cur = null; continue; }   // section without a version
    if (!cur) continue;
    if (/^\s*[-*]\s+/.test(raw)) {
      const text = clean(raw);
      if (text) cur.highlights.push(text);
    }
  }
  return {
    generatedFrom: 'CHANGELOG.md',
    versions: versions.map((v) => ({
      version: v.version,
      date: v.date,
      highlights: v.highlights.slice(0, MAX_PER_VERSION).map(truncate)
    }))
  };
}

const md = fs.readFileSync(SRC, 'utf8');
const doc = buildChangelog(md);
const json = JSON.stringify(doc, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== json) {
    console.error('app/changelog.json 与 CHANGELOG.md 不一致，请运行: node tools/gen_changelog.mjs');
    process.exit(1);
  }
  console.log(`changelog 同步 OK（${doc.versions.length} 个版本）`);
} else {
  fs.writeFileSync(OUT, json, 'utf8');
  console.log(`写入 app/changelog.json（${doc.versions.length} 个版本，最新 ${doc.versions[0]?.version}）`);
}
