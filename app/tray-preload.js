'use strict';
// Deliberately small bridge for the persistent tray panel. No generic IPC sender is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glassTray', {
  getState: () => ipcRenderer.invoke('tray-panel-state'),
  onState: (cb) => ipcRenderer.on('tray-panel-state', (_e, state) => cb(state)),
  setConfig: (key, value) => ipcRenderer.invoke('tray-panel-config', { key, value }),
  action: (action) => ipcRenderer.send('tray-panel-action', action)
});
