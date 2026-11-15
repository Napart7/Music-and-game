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
  lrclib: P.lrclib
};
// Bump when provider behaviour changes so stale low-quality caches are re-fetched once.
// v3: results now carry a `cover` (album art URL) from the same platform.
const CACHE_VERSION = 'v3';

function trackKey(t) {
  return `${P.cleanArtist(t.artist).toLowerCase()}|${P.cleanTitle(t.title).toLowerCase()}`;
}

function cacheName(t, preferred) {
  return crypto.createHash('sha1')
    .update(`${P.cleanArtist(t.artist)}|${P.cleanTitle(t.title)}|${P.cleanTitle(t.album)}|` +
            `${Math.round(t.duration || 0)}|${preferred || 'auto'}|${CACHE_VERSION}`)
    .digest('hex').slice(0, 24) + '.json';
}

/** Provider order for the current platform and the user's preferred source. */
function resolveOrder(platform, preferred) {
  const all = ['qqmusic', 'netease', 'lrclib'];
  if (preferred === 'off') return [];
  if (all.includes(preferred)) return [preferred, ...all.filter((p) => p !== preferred)];
  if (platform === 'qqmusic') return ['qqmusic', 'netease', 'lrclib'];
  if (platform === 'netease') return ['netease', 'qqmusic', 'lrclib'];
  return ['lrclib', 'netease', 'qqmusic'];
}

/** Map an SMTC SourceAppUserModelId to a platform id. */
function platformFromApp(app) {
  const s = String(app || '').toLowerCase();
  if (/qqmusic|qq music|tencent.*?music|weixin.*?music/.test(s)) return 'qqmusic';
  if (/cloudmusic|netease|music\.163|163music/.test(s)) return 'netease';
  return 'other';
}

function readCache(cacheDir, t, preferred) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cacheDir, cacheName(t, preferred)), 'utf8'));
    if (j && Array.isArray(j.lines) && j.lines.length) return { ...j, cached: true, source: j.source };
  } catch { /* miss */ }
  return null;
}

function writeCache(cacheDir, t, preferred, result) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, cacheName(t, preferred)),
      JSON.stringify({ ...result, fetchedAt: new Date().toISOString() }), 'utf8');
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
  if (hit) return { ...hit, platform, preferred, tried: [] };

  const tried = [];
  let lastErr = null;
  // In auto mode prefer REAL word-level timing: a QQ Music session still tries Netease YRC
  // before settling for line-level LRC. An explicit user choice is respected immediately.
  const qualityFirst = preferred === 'auto';
  let fallback = null;
  for (const name of order) {
    try {
      const r = await PROVIDERS[name](t);
      const usable = !!(r && r.ok && r.lines.length);
      tried.push({ provider: name, ok: usable, wordSync: !!(r && r.wordSync) });
      if (usable) {
        const result = { ...r, platform, preferred, tried, cached: false };
        if (!qualityFirst || r.wordSync) {
          writeCache(cacheDir, t, preferred, result);
          return result;
        }
        if (!fallback) fallback = result;    // keep the first usable line-level result
      }
    } catch (e) {
      tried.push({ provider: name, ok: false, error: e.message });
      lastErr = e.message;
    }
  }
  if (fallback) {
    fallback.tried = tried;
    writeCache(cacheDir, t, preferred, fallback);
    return fallback;
  }
  return { ok: false, error: lastErr || 'not-found', platform, preferred, tried,
           title: t.title, artist: t.artist };
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
  searchSongs: P.searchSongs,
  // re-exported for the regression suite / renderer utilities
  parseLrc: P.parseLrc,
  parseYrc: P.parseYrc,
  plainToLines: P.plainToLines,
  cleanTitle: P.cleanTitle,
  cleanArtist: P.cleanArtist,
  providers: PROVIDERS
};
