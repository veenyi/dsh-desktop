'use strict';
// 主工作台窗口 preload：暴露壳层能力到 dsh web UI（页面来自 127.0.0.1，跨进程桥）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__dshShell', {
  openSettingsFile: () => ipcRenderer.invoke('shell:openSettingsFile'),
  openDataDir: () => ipcRenderer.invoke('shell:openDataDir'),
  openLogsDir: () => ipcRenderer.invoke('shell:openLogsDir'),
  openMarket: () => ipcRenderer.invoke('shell:openMarket'),
  openWelcome: () => ipcRenderer.invoke('shell:openWelcome'),
  openSettings: () => ipcRenderer.invoke('shell:openSettingsWindow'),
  openWorkspace: () => ipcRenderer.invoke('shell:openWorkspace'),
  openBrowser: () => ipcRenderer.invoke('shell:openBrowser'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  takeSnapshot: () => ipcRenderer.invoke('shell:takeSnapshot'),
  getVersion: () => ipcRenderer.invoke('shell:getVersion'),
  listSkills: () => ipcRenderer.invoke('shell:listSkills'),
  listArtifacts: () => ipcRenderer.invoke('shell:listArtifacts'),
  listWorkspaces: () => ipcRenderer.invoke('shell:listWorkspaces'),
  serverStatus: () => ipcRenderer.invoke('shell:serverStatus'),
  channelStatus: () => ipcRenderer.invoke('shell:channelStatus'),
  browserChat: (payload) => ipcRenderer.invoke('shell:browserChat', payload),
  browserAction: (name, args) => ipcRenderer.invoke('shell:browserAction', name, args),
  // 多功能加号
  listSessions: () => ipcRenderer.invoke('shell:listSessions'),
  listScheduledTasks: () => ipcRenderer.invoke('shell:listScheduledTasks'),
  saveScheduledTask: (task) => ipcRenderer.invoke('shell:saveScheduledTask', task),
  deleteScheduledTask: (id) => ipcRenderer.invoke('shell:deleteScheduledTask', id),
  asr: (wavB64) => ipcRenderer.invoke('shell:asr', wavB64),
  onScheduledTask: (cb) => {
    const listener = (_e, t) => cb(t);
    ipcRenderer.on('scheduled:task', listener);
    return () => ipcRenderer.removeListener('scheduled:task', listener);
  }
});

// 设置窗口 preload 桥
contextBridge.exposeInMainWorld('settings', {
  get: () => ipcRenderer.invoke('settings:get'),
  setAutoLaunch: (v) => ipcRenderer.invoke('settings:setAutoLaunch', v),
  setOpenWith: (v) => ipcRenderer.invoke('settings:setOpenWith', v),
  setHotkey: (v) => ipcRenderer.invoke('settings:setHotkey', v),
  setDingtalk: (k, s) => ipcRenderer.invoke('settings:setDingtalk', k, s),
  // IM 渠道
  getChannels: () => ipcRenderer.invoke('settings:getChannels'),
  saveChannel: (id, values) => ipcRenderer.invoke('settings:saveChannel', id, values),
  clearChannel: (id) => ipcRenderer.invoke('settings:clearChannel', id),
  channelQr: (action, params) => ipcRenderer.invoke('settings:channelQr', action, params),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  decryptQqSecret: (enc, key) => ipcRenderer.invoke('decrypt:qqSecret', enc, key),
  // 更新中心
  checkUpdate: () => ipcRenderer.invoke('shell:checkUpdate'),
  updateState: () => ipcRenderer.invoke('shell:updateState'),
  updateDownload: () => ipcRenderer.invoke('shell:updateDownload'),
  updateInstall: () => ipcRenderer.invoke('shell:updateInstall'),
  updateSource: (patch) => ipcRenderer.invoke('shell:updateSource', patch),
  updateOpenDir: () => ipcRenderer.invoke('shell:updateOpenDir'),
  onUpdateState: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  }
});
