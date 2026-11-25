'use strict';
// Platform-neutral contract for backend output.
// Every OS backend (Windows WinRT script / macOS JXA / Linux MPRIS) prints ONE JSON object
// per line on stdout. This module normalises those lines so the rest of the app never
// branches on platform again. Unit-tested in tools/verify_backends.mjs.

// Windows.Media.Control SMTC enum, shared by every backend so statusValue means the same
// thing on all three platforms. 4 = Playing, 5 = Paused (NOT the MediaPlaybackStatus enum).
const STATUS_VALUE = { CLOSED: 0, OPENED: 1, CHANGING: 2, STOPPED: 3, PLAYING: 4, PAUSED: 5, NONE: -1 };
const STATUS_BY_VALUE = Object.fromEntries(
  Object.entries(STATUS_VALUE).map(([k, v]) => [v, k])
);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Normalise a media payload from any backend into the SMTC-shaped object. */
function normalizeMedia(d, platformId) {
  if (!d || typeof d !== 'object') return null;
  const rawStatus = String(d.status || (d.active ? 'PLAYING' : 'NONE')).toUpperCase();
  // Unknown/garbage statuses must NOT count as "playing", otherwise a broken backend
  // would keep the lyric engine fetching for a track that is not really playing.
  const known = Object.prototype.hasOwnProperty.call(STATUS_VALUE, rawStatus);
  const rawValue = Number(d.statusValue);
  const numericStatus = Number.isFinite(rawValue) && d.statusValue !== undefined &&
    d.statusValue !== null && d.statusValue !== '' && STATUS_BY_VALUE[rawValue];
  // The numeric enum comes straight from the OS API; the string is only a label a backend
  // authors by hand. When they disagree, trust the number -- a wrong label used to report
  // Playing as STOPPED and freeze the lyric clock between polls.
  const status = !known ? 'UNKNOWN'
    : (numericStatus && STATUS_VALUE[rawStatus] !== rawValue ? numericStatus : rawStatus);
  const statusValue = known
    ? (Number.isFinite(rawValue) ? rawValue : STATUS_VALUE[status])
    : -1;
  return {
    ok: d.ok !== false,
    active: d.active !== false && known && status !== 'NONE' && status !== 'CLOSED',
    app: String(d.app || d.player || ''),
    title: String(d.title || ''),
    artist: String(d.artist || ''),
    album: String(d.album || ''),
    status,
    statusValue,
    position: num(d.position),
    duration: num(d.duration),
    // sampledAtMs is the capture time on the same machine, not the lyric line timestamp.
    // Main fills it at stdout receipt if an older/external backend does not provide it.
    sampledAtMs: Number.isFinite(Number(d.sampledAtMs)) ? Number(d.sampledAtMs) : Date.now(),
    playbackRate: num(d.playbackRate) > 0 ? num(d.playbackRate) : 1,
    hasCover: !!d.hasCover || !!(d.cover || d.coverUrl),
    cover: d.cover || d.coverUrl || null,
    coverChanged: !!d.coverChanged,
    platformId: platformId || d.platformId || '',
    error: d.ok === false ? String(d.error || 'backend-error') : undefined
  };
}

/**
 * Guard against a backend reporting a non-PLAYING status while its timeline keeps
 * advancing. Long-lived SMTC sessions on some players get stuck reporting STOPPED or
 * CHANGING mid-playback; the renderer then sets rate=0 and freezes the lyric clock, so
 * lyrics can only jump once per 500ms poll -- the "stuttering after a while" symptom.
 *
 * Two consecutive advancing samples on the SAME track are required before overriding,
 * so a genuine pause (position frozen), a seek (jump far larger than wall time) and a
 * track change (different title/artist) are never misread as playback.
 */
function createPlaybackStatusWatchdog() {
  let prev = null;
  let runs = 0;
  return function reconcile(d) {
    if (!d || d.ok === false || d.active === false) { prev = null; runs = 0; return d; }
    const sameTrack = prev && prev.title === d.title && prev.artist === d.artist;
    const couldPlay = d.status !== 'PLAYING' && d.status !== 'NONE' && d.status !== 'CLOSED';
    if (sameTrack && couldPlay) {
      const dt = (d.sampledAtMs - prev.sampledAtMs) / 1000;
      const dp = d.position - prev.position;
      if (dt >= 0.2 && dt <= 3 && dp >= 0.25 && dp <= dt * 1.6) {
        runs++;
        if (runs >= 2) {
          prev = { title: d.title, artist: d.artist, position: d.position, sampledAtMs: d.sampledAtMs };
          return { ...d, status: 'PLAYING', statusValue: 4 };
        }
      } else runs = 0;
    } else runs = 0;
    prev = { title: d.title, artist: d.artist, position: d.position, sampledAtMs: d.sampledAtMs };
    return d;
  };
}

/** Parse one stdout line from a media backend. Returns null for non-JSON noise. */
function parseMediaLine(line, platformId) {
  const s = String(line || '').trim();
  if (!s.startsWith('{')) return null;
  try { return normalizeMedia(JSON.parse(s), platformId); } catch { return null; }
}

/** Parse one stdout line from a window probe. */
function parseWindowLine(line) {
  const s = String(line || '').trim();
  if (!s.startsWith('{')) return null;
  let d;
  try { d = JSON.parse(s); } catch { return null; }
  if (!d || typeof d !== 'object') return null;
  const rect = Array.isArray(d.rect) ? d.rect.map(num) : null;
  // Legacy probes used `caption` as a text title. The current Windows probe emits it as a
  // WS_CAPTION boolean plus a separate `title`; never stringify a boolean into the title.
  const legacyTitle = typeof d.caption === 'string' ? d.caption : '';
  const flag = (v) => (typeof v === 'boolean' ? v : (v === 0 || v === 1 ? !!v : undefined));
  // Shape signals drive the game/app vetoes in window-classify.js. They are Windows-only:
  // macOS/Linux payloads simply omit them and keep the pure geometry fallback.
  const shape = {};
  for (const key of ['caption', 'toolWindow', 'thickFrame']) {
    const v = flag(d[key]);
    if (v !== undefined) shape[key] = v;
  }
  return {
    ok: d.ok !== false,
    rect,
    rectPhysical: Array.isArray(d.rectPhysical) ? d.rectPhysical.map(num) : null,
    process: String(d.process || ''),
    title: String(d.title || legacyTitle || ''),
    className: String(d.className || ''),
    ...shape,
    minimized: !!d.minimized,
    visible: d.visible !== false,
    desktop: !!d.desktop,
    // Wayland / permission errors arrive with ok:true + error (a degraded but valid state).
    error: d.error ? String(d.error) : (d.ok === false ? 'probe-error' : undefined)
  };
}

/** Normalise playback actions so backends can share one switch. */
function normalizeAction(action) {
  const a = String(action || '').toLowerCase();
  if (['play', 'pause', 'toggle', 'next', 'prev', 'playpause'].includes(a)) {
    return a === 'playpause' ? 'toggle' : a;
  }
  return null;
}

module.exports = { normalizeMedia, parseMediaLine, parseWindowLine, normalizeAction,
  STATUS_VALUE, createPlaybackStatusWatchdog };
