import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cortexDesktop', Object.freeze({
  getConnection: () => ipcRenderer.invoke('cortex:connection'),
  chooseDirectory: () => ipcRenderer.invoke('cortex:directory'),
  vaultStatus: () => ipcRenderer.invoke('cortex:vault-status'),
  saveSecret: (id: string, secret: string) => ipcRenderer.invoke('cortex:vault-save', id, secret),
  loadSecret: (id: string) => ipcRenderer.invoke('cortex:vault-load', id),
  deleteSecret: (id: string) => ipcRenderer.invoke('cortex:vault-delete', id),
}));
