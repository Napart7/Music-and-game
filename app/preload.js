// Safe IPC bridge. The renderer never gets Node or Electron APIs directly.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glass', {
  onSmtc: (cb) => ipcRenderer.on('smtc', (_e, d) => cb(d)),
  onPanel: (cb) => ipcRenderer.on('panel', (_e, on) => cb(on)),
  onVisible: (cb) => ipcRenderer.on('visible', (_e, on) => cb(on)),
  onConfig: (cb) => ipcRenderer.on('config', (_e, c) => cb(c)),
  onCycleLayout: (cb) => ipcRenderer.on('cycle-layout', () => cb()),
  onAutoFit: (cb) => ipcRenderer.on('auto-fit', (_e, d) => cb(d)),
  onLyrics: (cb) => ipcRenderer.on('lyrics', (_e, d) => cb(d)),
  onLyricOffset: (cb) => ipcRenderer.on('lyric-offset', (_e, v) => cb(v)),
  refreshLyrics: () => ipcRenderer.send('refresh-lyrics'),
  getLyrics: () => ipcRenderer.invoke('get-lyrics'),
  control: (action) => ipcRenderer.send('control', action),
  setClickable: (on) => ipcRenderer.send('set-clickable', on),
  getConfig: () => ipcRenderer.invoke('get-config'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  quitApp: () => ipcRenderer.send('quit-app'),
  closePanel: () => ipcRenderer.send('close-panel')
});
