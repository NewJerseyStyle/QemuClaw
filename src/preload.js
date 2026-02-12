// src/preload.js - contextBridge for secure IPC
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Terminal
  terminalWrite: (data) => ipcRenderer.send('terminal-input', data),
  onTerminalData: (cb) => ipcRenderer.on('terminal-output', (event, data) => cb(data)),
  terminalResize: (cols, rows) => ipcRenderer.send('terminal-resize', { cols, rows }),

  // Setup
  completeSetup: (config) => ipcRenderer.send('setup-complete', config),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  onLoadConfig: (cb) => ipcRenderer.on('load-config', (event, data) => cb(data)),

  // VM
  getVMStatus: () => ipcRenderer.invoke('get-vm-status'),

  // Download
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (event, data) => cb(data)),

  // Boot status
  onBootStatus: (cb) => ipcRenderer.on('boot-status', (event, data) => cb(data)),

  // Cleanup
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
