const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  pickFolder: (current) => ipcRenderer.invoke('pick-folder', current),
});
