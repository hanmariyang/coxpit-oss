// Auth prompt bridge — the prompt window is a data: URL page (no node access);
// this preload is its only channel back to the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coxpitAuth', {
  submit: (user, pass) => ipcRenderer.send('coxpit-auth-submit', { user, pass }),
  cancel: () => ipcRenderer.send('coxpit-auth-cancel'),
  useLocal: () => ipcRenderer.send('coxpit-use-local'),   // 탈출구 — 격리 로컬 데몬으로
});
