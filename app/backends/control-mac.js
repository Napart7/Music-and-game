// macOS playback control (JXA, single shot). argv[0] = action from the main process.
function run(argv) {
  var action = String((argv && argv[0]) || 'toggle');
  var players = ['Spotify', 'Music'];
  for (var i = 0; i < players.length; i++) {
    var name = players[i];
    try {
      var app = Application(name);
      if (!app.running()) continue;
      if (action === 'play') app.play();
      else if (action === 'pause') app.pause();
      else if (action === 'toggle') app.playpause();
      else if (action === 'next') app.nextTrack();
      else if (action === 'prev') app.previousTrack();
      else return JSON.stringify({ ok: false, error: 'unknown-action' });
      return JSON.stringify({ ok: true, app: name, action: action });
    } catch (e) {
      // Automation permission denied or app busy — try the next player.
    }
  }
  return JSON.stringify({ ok: false, error: 'no-running-player' });
}
