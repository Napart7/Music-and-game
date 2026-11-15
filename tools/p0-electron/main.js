// P0 minimal probe: is an Electron transparent always-on-top window REALLY transparent
// when composited over the desktop? This is the go/no-go gate for the whole project.
const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

const TITLE = 'GlassLyricsElectronP0';
if (process.env.GL_P0_NOGPU === '1') app.disableHardwareAcceleration();

let win = null;
let clickThrough = true;

function create() {
  win = new BrowserWindow({
    width: 1200,
    height: 700,
    x: 100,
    y: 100,
    title: TITLE,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  // Keep the native window title stable so the pixel-check script can FindWindowW it.
  win.on('page-title-updated', (e) => e.preventDefault());
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'probe.html'));

  win.webContents.on('did-finish-load', () => {
    fs.writeFileSync(path.join(__dirname, 'ready.json'), JSON.stringify({
      title: TITLE,
      gpuDisabled: process.env.GL_P0_NOGPU === '1',
      electron: process.versions.electron,
      bounds: win.getBounds()
    }, null, 2));
    console.log('[P0] ready');
  });

  globalShortcut.register('Control+Alt+P', () => {
    clickThrough = !clickThrough;
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
    console.log('[P0] clickThrough =', clickThrough);
  });
  globalShortcut.register('Control+Alt+Q', () => app.quit());

  // ShowWindow(SW_HIDE) does not reliably hide a layered Electron window.
  // Expose a tiny local control port so the pixel-check script can use win.hide()/show().
  control = net.createServer((sock) => {
    sock.on('data', (buf) => {
      const cmd = buf.toString().trim();
      if (cmd === 'hide') win.hide();
      else if (cmd === 'show') win.show();
      else if (cmd === 'quit') app.quit();
      sock.end(cmd === 'ping' ? 'pong' : 'ok');
    });
  });
  control.listen(17891, '127.0.0.1', () => console.log('[P0] control port 17891'));
}

let control = null;
app.whenReady().then(create);
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (control) control.close();
});
