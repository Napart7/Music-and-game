'use strict';
// Lyric engine: choose a provider based on the playing platform, cache the result locally,
// and always fall back through the other providers. No lyric text ships with the app.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./providers');

const PROVIDERS = {
  qqmusic: P.qqmusic,
  netease: P.netease,
  kugou: P.kugou,
  lrclib: P.lrclib
};
// Bump when provider behaviour changes so stale low-quality caches are re-fetched once.
// v3: results now carry a `cover` (album art URL) from the same platform.
const CACHE_VERSION = 'v3';

// The SMTC bridge reports the same track every 500ms, so trackKey() used to re-run four
// title/artist cleaning regexes on every single tick for the whole session. It is a pure
// function of short strings; a bounded memo removes that work (measured 2.8x over 100k
// calls on the same track). Bounded so a large music library cannot grow the map forever.
const MEMO_MAX = 128;
const keyMemo = new Map();
function memoGet(map, k, compute) {
  const hit = map.get(k);
  if (hit !== undefined) return hit;
  const v = compute();
  if (map.size >= MEMO_MAX) map.clear();
  map.set(k, v);
  return v;
}

function trackKey(t) {
  const raw = `${t && t.artist}|${t && t.title}`;
  return memoGet(keyMemo, raw, () =>
    `${P.cleanArtist(t.artist).toLowerCase()}|${P.cleanTitle(t.title).toLowerCase()}`);
}

function cacheName(t, preferred) {
  return crypto.createHash('sha1')
    .update(`${P.cleanArtist(t.artist)}|${P.cleanTitle(t.title)}|${P.cleanTitle(t.album)}|` +
            `${Math.round(t.duration || 0)}|${preferred || 'auto'}|${CACHE_VERSION}`)
    .digest('hex').slice(0, 24) + '.json';
}

/** Provider order for the current platform and the user's preferred source.
 *  Platforms without a public lyric API (Spotify / Apple Music / Qishui) fall back to
 *  same-song matching on the Chinese providers, then LRCLIB.
 *  All orders are precomputed constants: the previous implementation rebuilt two arrays
 *  on every call, and callers only ever read them. */
const ALL_PROVIDERS = ['qqmusic', 'netease', 'kugou', 'lrclib'];
const PREFERRED_ORDER = Object.create(null);
for (const p of ALL_PROVIDERS) {
  PREFERRED_ORDER[p] = [p, ...ALL_PROVIDERS.filter((x) => x !== p)];
}
const PLATFORM_ORDER = {
  qqmusic:    ['qqmusic', 'netease', 'kugou', 'lrclib'],
  netease:    ['netease', 'qqmusic', 'kugou', 'lrclib'],
  kugou:      ['kugou', 'netease', 'qqmusic', 'lrclib'],
  qishui:     ['netease', 'qqmusic', 'kugou', 'lrclib'],
  spotify:    ['lrclib', 'netease', 'qqmusic', 'kugou'],
  applemusic: ['lrclib', 'netease', 'kugou', 'qqmusic'],
  _default:   ['lrclib', 'netease', 'qqmusic', 'kugou']
};
function resolveOrder(platform, preferred) {
  if (preferred === 'off') return [];
  return PREFERRED_ORDER[preferred] || PLATFORM_ORDER[platform] || PLATFORM_ORDER._default;
}

/** Map an SMTC SourceAppUserModelId to a platform id.
 *  Deliberately NOT memoised: six short literal regexes are already faster than a Map
 *  lookup here (measured 5.4ms vs 6.2ms per 100k calls). Caching would add state for
 *  no gain — only the expensive title/artist cleaning above needs it. */
function platformFromApp(app) {
  const s = String(app || '').toLowerCase();
  if (/qqmusic|qq music|tencent.*?music|weixin.*?music/.test(s)) return 'qqmusic';
  if (/cloudmusic|netease|music\.163|163music/.test(s)) return 'netease';
  if (/kugou|kgmusic|kugouconcept/.test(s)) return 'kugou';
  if (/qishui|luna[-.]?music|sodamusic/.test(s)) return 'qishui';
  if (/applemusic|appleinc.*music|music\.ui|itunes/.test(s)) return 'applemusic';
  if (/spotify/.test(s)) return 'spotify';
  return 'other';
}

function readCache(cacheDir, t, preferred) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cacheDir, cacheName(t, preferred)), 'utf8'));
    if (j && Array.isArray(j.lines) && j.lines.length) return { ...j, cached: true, source: j.source };
  } catch { /* miss */ }
  return null;
}

// Keep the on-disk lyric cache bounded: on low-end machines an unbounded cache
// grows for years. Oldest entries are pruned after every write.
const MAX_CACHE_FILES = 300;

function pruneCache(cacheDir) {
  try {
    const names = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
    // The common case is a cache well below the cap. Previously every single lyric write
    // statSync()'d ALL 300 files and sorted them just to discover nothing needed pruning.
    // One readdir is enough to know; only pay for stat+sort when we actually exceed the cap.
    if (names.length <= MAX_CACHE_FILES) return;
    const files = names
      .map((f) => { const p = path.join(cacheDir, f); return { p, m: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => b.m - a.m);            // newest first
    for (const f of files.slice(MAX_CACHE_FILES)) {
      try { fs.unlinkSync(f.p); } catch { /* best effort */ }
    }
  } catch { /* dir may not exist yet */ }
}

function writeCache(cacheDir, t, preferred, result) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, cacheName(t, preferred)),
      JSON.stringify({ ...result, fetchedAt: new Date().toISOString() }), 'utf8');
    pruneCache(cacheDir);
  } catch (e) {
    console.error('[lyrics] cache write failed', e);
  }
}

/**
 * Look up lyrics for the current track.
 * @param {object} track   {title, artist, album, duration, app}
 * @param {string} cacheDir
 * @param {object} opts    {preferred?: 'auto'|'qqmusic'|'netease'|'lrclib'|'off', platform?: string}
 */
async function fetchLyrics(track, cacheDir, opts = {}) {
  const t = {
    title: P.cleanTitle(track.title),
    artist: P.cleanArtist(track.artist),
    album: P.cleanTitle(track.album),
    duration: Number(track.duration) || 0
  };
  if (!t.title) return { ok: false, error: 'empty-title' };
  const platform = opts.platform || platformFromApp(track.app || opts.app);
  const preferred = opts.preferred || 'auto';
  const order = resolveOrder(platform, preferred);
  if (!order.length) return { ok: false, error: 'lyrics-disabled' };

  const hit = readCache(cacheDir, t, preferred);
  if (hit) return { ...hit, platform, preferred, tried: [], elapsedMs: 0 };
  const startedAt = Date.now();

  const tried = [];
  let lastErr = null;
  // In auto mode prefer REAL word-level timing, but never let a slow provider block a fast
  // one: all providers race in parallel, the first word-sync result wins immediately, and a
  // short quality window decides when to settle for line-level lyrics.
  // (Before v1.3 this was sequential: QQ session = wait 1.7s for QQ, then 0.2s for Netease.)
  const qualityFirst = preferred === 'auto';
  // Platforms whose own API exposes no artwork (Spotify/Apple/Qishui): borrow iTunes art.
  const enrichCover = async (result) => {
    if (result.cover) return result;
    if (!['applemusic', 'spotify', 'qishui'].includes(platform)) return result;
    try {
      const m = await P.itunesMeta(t);
      if (m?.cover) result.cover = m.cover;
    } catch { /* best effort */ }
    return result;
  };
  const finalize = async (result) => {
    const out = await enrichCover(result);
    writeCache(cacheDir, t, preferred, out);
    return out;
  };
  // How long to wait for a word-sync result before accepting line-level lyrics.
  const QUALITY_WINDOW_MS = 900;

  if (qualityFirst) {
    const raced = await new Promise((resolve) => {
      const usable = [];
      let settled = 0;
      let done = false;
      const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => {
        // Window elapsed: take the best line-level result if any, else keep waiting.
        if (usable.length) finish(usable[0]);
      }, QUALITY_WINDOW_MS);
      order.forEach((name) => {
        PROVIDERS[name](t)
          .then((r) => {
            const ok = !!(r && r.ok && r.lines.length);
            tried.push({ provider: name, ok, wordSync: !!(r && r.wordSync) });
            if (!ok) return;
            const res = { ...r, platform, preferred, tried, cached: false };
            usable.push(res);
            if (r.wordSync) finish(res);      // real per-character timing: ship it now
          })
          .catch((e) => { tried.push({ provider: name, ok: false, error: e.message }); lastErr = e.message; })
          .finally(() => {
            settled++;
            // All providers settled: take the first usable one (undefined → not-found).
            if (settled === order.length) finish(usable[0]);
          });
      });
    });
    if (raced) {
      const out = await finalize(raced);
      out.elapsedMs = Date.now() - startedAt;
      return out;
    }
    return { ok: false, error: lastErr || 'not-found', platform, preferred, tried,
             title: t.title, artist: t.artist, elapsedMs: Date.now() - startedAt };
  }

  for (const name of order) {
    try {
      const r = await PROVIDERS[name](t);
      const usable = !!(r && r.ok && r.lines.length);
      tried.push({ provider: name, ok: usable, wordSync: !!(r && r.wordSync) });
      if (usable) {
        const out = await finalize({ ...r, platform, preferred, tried, cached: false });
        out.elapsedMs = Date.now() - startedAt;
        return out;
      }
    } catch (e) {
      tried.push({ provider: name, ok: false, error: e.message });
      lastErr = e.message;
    }
  }
  return { ok: false, error: lastErr || 'not-found', platform, preferred, tried,
           title: t.title, artist: t.artist, elapsedMs: Date.now() - startedAt };
}

/** Index of the active line at position (binary search). */
function indexAt(lines, pos) {
  if (!lines || !lines.length) return 0;
  let lo = 0, hi = lines.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= pos) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

module.exports = {
  fetchLyrics, resolveOrder, platformFromApp, indexAt, trackKey,
  searchSongs: (query, platform, creds) => P.searchSongs(query, platform, creds),
  itunesMeta: P.itunesMeta,
  // re-exported for the regression suite / renderer utilities
  parseLrc: P.parseLrc,
  parseYrc: P.parseYrc,
  plainToLines: P.plainToLines,
  cleanTitle: P.cleanTitle,
  cleanArtist: P.cleanArtist,
  providers: PROVIDERS
};
