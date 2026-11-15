// macOS media backend (JXA, run by `osascript -l JavaScript`).
// Emits ONE JSON object per line on stdout every 500 ms — the same contract the Windows
// WinRT bridge uses, so the main process never branches on platform again.
// Supports Apple Music (Music.app) and Spotify desktop via AppleScript automation.
ObjC.import('Foundation');

function sleepMs(ms) { $.NSThread.sleepForTimeInterval(ms / 1000); }

var STATUS = {
  playing: ['PLAYING', 3],
  paused: ['PAUSED', 2],
  stopped: ['STOPPED', 4]
};

function num(v, fallback) {
  var n = Number(v);
  return isFinite(n) ? n : (fallback || 0);
}

function readPlayer(appName, bundleHint) {
  var app;
  try {
    app = Application(appName);
    if (!app.running()) return null;
  } catch (e) { return null; }
  var stateStr = 'stopped';
  try { stateStr = String(app.playerState()); } catch (e) { return null; }
  var mapped = STATUS[stateStr] || ['STOPPED', 4];
  var track = null;
  try { track = app.currentTrack(); } catch (e) { track = null; }
  var out = {
    ok: true, active: mapped[0] !== 'STOPPED', app: appName, player: appName,
    title: '', artist: '', album: '', status: mapped[0], statusValue: mapped[1],
    position: 0, duration: 0, hasCover: false, coverUrl: null
  };
  if (track) {
    try { out.title = String(track.name()); } catch (e) {}
    try { out.artist = String(track.artist()); } catch (e) {}
    try { out.album = String(track.album()); } catch (e) {}
    // Music.app reports seconds; Spotify reports milliseconds.
    var dur = 0;
    try { dur = Number(track.duration()); } catch (e) {}
    if (appName === 'Spotify') dur = dur > 10000 ? dur / 1000 : dur;
    out.duration = num(dur, 0);
    try { out.position = num(app.playerPosition(), 0); } catch (e) {}
    if (appName === 'Spotify') {
      try {
        var art = track.artworkUrl();
        if (art) { out.coverUrl = String(art); out.hasCover = true; }
      } catch (e) {}
    }
  } else {
    out.status = mapped[0] === 'PLAYING' ? 'NONE' : mapped[0];
    out.active = false;
  }
  return out;
}

function pickBest() {
  var candidates = [];
  var spotify = readPlayer('Spotify', 'com.spotify.client');
  if (spotify) candidates.push(spotify);
  var music = readPlayer('Music', 'com.apple.Music');
  if (music) candidates.push(music);
  if (!candidates.length) {
    return {
      ok: true, active: false, status: 'NONE', statusValue: -1, app: '',
      title: '', artist: '', album: '', position: 0, duration: 0, hasCover: false
    };
  }
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].status === 'PLAYING') return candidates[i];
  }
  return candidates[0];
}

while (true) {
  var payload;
  try {
    payload = pickBest();
  } catch (e) {
    payload = { ok: false, error: 'jxa:' + (e && e.message ? e.message : 'unknown') };
  }
  console.log(JSON.stringify(payload));
  sleepMs(500);
}
