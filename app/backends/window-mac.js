// macOS foreground-window probe (JXA). Emits the same JSON shape as window-probe.ps1:
// {ok, rect:[x,y,w,h], process, className, title, minimized, visible, desktop}
// Requires Accessibility permission for the terminal / app that launches GlassLyrics.
ObjC.import('Foundation');

function sleepMs(ms) { $.NSThread.sleepForTimeInterval(ms / 1000); }

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

function probe() {
  var se;
  try { se = Application('System Events'); } catch (e) {
    return { ok: false, error: 'system-events-unavailable' };
  }
  var frontmost;
  try {
    frontmost = se.applicationProcesses.whose({ frontmost: true })();
  } catch (e) {
    return { ok: false, error: 'accessibility-permission' };
  }
  if (!frontmost || !frontmost.length) {
    return { ok: true, visible: false, desktop: true, process: '', className: '', title: '' };
  }
  var proc = frontmost[0];
  var name = '';
  try { name = String(proc.name()); } catch (e) {}
  var wins = [];
  try { wins = proc.windows(); } catch (e) { wins = []; }
  if (!wins || !wins.length) {
    return { ok: true, visible: false, minimized: true, process: name, className: name, title: '' };
  }
  var w = wins[0];
  var pos = [0, 0], size = [0, 0], title = '';
  try { pos = w.position(); } catch (e) {}
  try { size = w.size(); } catch (e) {}
  try { title = String(w.name()); } catch (e) {}
  var x = Number(pos[0]) || 0, y = Number(pos[1]) || 0;
  var ww = Number(size[0]) || 0, hh = Number(size[1]) || 0;
  if (!ww || !hh) {
    return { ok: true, visible: false, minimized: true, process: name, className: name, title: title };
  }
  // A window filling the whole screen and owned by Finder/Dock is the desktop.
  var desktop = (name === 'Finder' || name === 'Dock');
  return {
    ok: true, visible: true, minimized: false, desktop: desktop,
    rect: [x, y, ww, hh], rectPhysical: [x, y, ww, hh],
    process: name, className: name, title: title
  };
}

while (true) {
  var out;
  try { out = probe(); } catch (e) {
    out = { ok: false, error: 'jxa:' + (e && e.message ? e.message : 'unknown') };
  }
  emit(out);
  sleepMs(400);
}
