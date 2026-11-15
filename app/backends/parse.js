'use strict';
// Platform-neutral contract for backend output.
// Every OS backend (Windows WinRT script / macOS JXA / Linux MPRIS) prints ONE JSON object
// per line on stdout. This module normalises those lines so the rest of the app never
// branches on platform again. Unit-tested in tools/verify_backends.mjs.

const STATUS_VALUE = { CLOSED: 0, OPENED: 1, PAUSED: 2, PLAYING: 3, STOPPED: 4, CHANGING: 5, NONE: -1 };

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
  const status = known ? rawStatus : 'UNKNOWN';
  const statusValue = known
    ? (Number.isFinite(Number(d.statusValue)) ? Number(d.statusValue) : STATUS_VALUE[status])
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
    hasCover: !!d.hasCover || !!(d.cover || d.coverUrl),
    cover: d.cover || d.coverUrl || null,
    coverChanged: !!d.coverChanged,
    platformId: platformId || d.platformId || '',
    error: d.ok === false ? String(d.error || 'backend-error') : undefined
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
  return {
    ok: d.ok !== false,
    rect,
    rectPhysical: Array.isArray(d.rectPhysical) ? d.rectPhysical.map(num) : null,
    process: String(d.process || ''),
    title: String(d.title || d.caption || ''),
    className: String(d.className || ''),
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

module.exports = { normalizeMedia, parseMediaLine, parseWindowLine, normalizeAction, STATUS_VALUE };
