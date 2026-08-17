'use strict';
// 窗口 preload：暴露只读/操作能力到页面（市场窗口 + 欢迎页共用）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('market', {
  list: (type) => ipcRenderer.invoke('market:list', type),
  install: (type, id) => ipcRenderer.invoke('market:install', type, id),
  uninstall: (type, id) => ipcRenderer.invoke('market:uninstall', type, id),
  openDir: () => ipcRenderer.invoke('market:openDir')
});

contextBridge.exposeInMainWorld('welcome', {
  openWorkspace: () => ipcRenderer.invoke('welcome:openWorkspace'),
  openMarket: () => ipcRenderer.invoke('welcome:openMarket'),
  openDataDir: () => ipcRenderer.invoke('welcome:openDataDir'),
  openSettings: () => ipcRenderer.invoke('welcome:openSettings'),
  showAbout: () => ipcRenderer.invoke('welcome:showAbout'),
  version: () => ipcRenderer.invoke('shell:getVersion')
});
