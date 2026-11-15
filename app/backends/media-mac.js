// macOS media backend (JXA, run by `osascript -l JavaScript`).
// Emits ONE JSON object per line on stdout every 500 ms — the same contract the Windows
// WinRT bridge uses, so the main process never branches on platform again.
// Supports Apple Music (Music.app) and Spotify desktop via AppleScript automation.
ObjC.import('Foundation');

function sleepMs(ms) { $.NSThread.sleepForTimeInterval(ms / 1000); }

// osascript's console.log is not guaranteed to reach stdout on every macOS build;
// write the line ourselves so the main process always receives the JSON contract.
function emit(obj) {
  var json = JSON.stringify(obj);
  try {
    var str = $.NSString.alloc.initWithUTF8String(json + '\n');
    var data = str.dataUsingEncoding($.NSUTF8StringEncoding);
    $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
  } catch (e) {
    console.log(json);
  }
}

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
    // One `properties()` round-trip instead of six separate AppleEvents; fall back to
    // per-property reads if a given app does not expose the batch form.
    var props = null;
    try { props = track.properties(); } catch (e) { props = null; }
    function prop(key, getter) {
      try {
        if (props && props[key] !== undefined && props[key] !== null) return props[key];
      } catch (e) {}
      try { return getter(); } catch (e) { return null; }
    }
    var tName = prop('name', function () { return track.name(); });
    var tArtist = prop('artist', function () { return track.artist(); });
    var tAlbum = prop('album', function () { return track.album(); });
    var tDur = prop('duration', function () { return track.duration(); });
    out.title = tName == null ? '' : String(tName);
    out.artist = tArtist == null ? '' : String(tArtist);
    out.album = tAlbum == null ? '' : String(tAlbum);
    // Music.app reports seconds; Spotify reports milliseconds.
    var dur = Number(tDur) || 0;
    if (appName === 'Spotify') dur = dur > 10000 ? dur / 1000 : dur;
    out.duration = num(dur, 0);
    try { out.position = num(app.playerPosition(), 0); } catch (e) {}
    if (appName === 'Spotify') {
      var art = prop('artworkUrl', function () { return track.artworkUrl(); });
      if (art) { out.coverUrl = String(art); out.hasCover = true; }
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
  emit(payload);
  sleepMs(500);
}
