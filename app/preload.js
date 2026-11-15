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
  onLyricsLoading: (cb) => ipcRenderer.on('lyrics-loading', (_e, d) => cb(d)),
  onLyricOffset: (cb) => ipcRenderer.on('lyric-offset', (_e, v) => cb(v)),
  refreshLyrics: () => ipcRenderer.send('refresh-lyrics'),
  getLyrics: () => ipcRenderer.invoke('get-lyrics'),
  searchSongs: (query, platform) => ipcRenderer.invoke('search-songs', { query, platform }),
  playSong: (song) => ipcRenderer.invoke('play-song', song),
  control: (action) => ipcRenderer.send('control', action),
  setEditMode: (on) => ipcRenderer.send('set-edit-mode', on),
  onEditMode: (cb) => ipcRenderer.on('edit-mode', (_e, on) => cb(on)),
  dismissOverlay: () => ipcRenderer.send('dismiss-overlay'),
  getClickState: () => ipcRenderer.invoke('get-click-state'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getHotkeys: () => ipcRenderer.invoke('get-hotkeys'),
  setHotkey: (action, accel) => ipcRenderer.invoke('set-hotkey', { action, accel }),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  quitApp: () => ipcRenderer.send('quit-app'),
  closePanel: () => ipcRenderer.send('close-panel')
});
