const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('AtlasDesktop', Object.freeze({
  getRelease: () => ipcRenderer.invoke('atlas:release'),
  onRelease: (callback) => {
    const receive = (_event, value) => callback(value);
    ipcRenderer.on('atlas:release-changed', receive);
    return () => ipcRenderer.removeListener('atlas:release-changed', receive);
  },
  onBeforeQuit: (callback) => {
    const prepare = async (_event, id) => {
      try { await callback(); } finally { ipcRenderer.send('atlas:ready-to-quit', id); }
    };
    ipcRenderer.on('atlas:prepare-quit', prepare);
    return () => ipcRenderer.removeListener('atlas:prepare-quit', prepare);
  },
  quit: () => ipcRenderer.send('atlas:quit'),
}));
