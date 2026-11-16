'use strict';
/* Shared playback-clock math. Works in Node (unit tests) and the isolated renderer. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlaybackClock = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function finite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * Estimate the source position at render time.
   * `position` was captured at sampledAtMs; account for bridge + IPC age once at receipt,
   * then use the renderer's monotonic clock. Paused/stopped states never advance.
   */
  function estimatePosition(sample, receivedWallMs, monotonicElapsedMs) {
    if (!sample || typeof sample !== 'object') return 0;
    const raw = Math.max(0, finite(sample.position, 0));
    const duration = Math.max(0, finite(sample.duration, 0));
    const sampledAt = finite(sample.sampledAtMs, 0);
    const receivedAt = finite(receivedWallMs, 0);
    // A missing timestamp means "captured on receipt" for backwards compatibility. A
    // future timestamp can result from clock resolution and contributes zero age.
    const transportAge = sampledAt > 0 && receivedAt > 0
      ? Math.min(10000, Math.max(0, receivedAt - sampledAt)) / 1000 : 0;
    const elapsed = Math.max(0, finite(monotonicElapsedMs, 0)) / 1000;
    const playing = String(sample.status || '').toUpperCase() === 'PLAYING';
    const rate = playing ? Math.min(4, Math.max(.25, finite(sample.playbackRate, 1))) : 0;
    let position = raw + (transportAge + elapsed) * rate;
    if (duration > 0) position = Math.min(position, duration);
    return position;
  }

  return { estimatePosition };
}));
