'use strict';

/**
 * DSH Desktop — DeepSeek Harness 桌面壳
 * 主进程：拉起 dsh 服务（ELECTRON_RUN_AS_NODE 子进程）→ 窗口加载本地工作台 → 托盘常驻
 *
 * 架构（类千问办公 Launcher + 版本目录）：
 *   - 安装器只含轻量散文件 + node_modules 单文件归档（秒装）
 *   - 首次启动：解压归档到 ~/.dsh/runtime/<版本>\（有初始化提示）
 *   - 数据独立：DSH_HOME = ~/.dsh/data（日志/记忆/运行时全在 ~/.dsh 下）
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell, clipboard, Notification, ipcMain } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const updater = require('./updater');
const channels = require('./channels');

const PORT = 3080;
const BASE = `http://127.0.0.1:${PORT}`;

// 冒烟测试模式：--smoke-test 时不开窗口/托盘，只做运行时+更新源自检后退出（CI/发布验证用）
const SMOKE_TEST = process.argv.includes('--smoke-test') || process.env.DSH_SMOKE === '1';

// 数据根目录：用户主目录下的 .dsh（类 .qwenworkcn / .workbuddy 约定）
//   ~/.dsh/runtime/<版本>/  运行时（首次启动自解压）
//   ~/.dsh/data/            dsh 数据（DSH_HOME）
//   ~/.dsh/appdata/         Electron userData（前端 localStorage/缓存）
//   ~/.dsh/logs/            日志
//   ~/.dsh/.env             IM 渠道凭据等
const DSH_ROOT = path.join(os.homedir(), '.dsh');
// Electron userData 归入 ~/.dsh（须在 app ready 前设置；
// 否则前端 localStorage 残留旧版污染路径，目录选择器初始位置解析错乱）
// 冒烟测试用独立 userData，避免与运行中实例的单实例锁冲突
app.setPath('userData', path.join(DSH_ROOT, SMOKE_TEST ? 'smoke-appdata' : 'appdata'));
const RUNTIME_ROOT = path.join(DSH_ROOT, 'runtime');
const RUNTIME_VER = app.getVersion();

// 运行时目录解析
//  - dev 模式：项目内 dsh-runtime（保留散 node_modules）
//  - 打包模式：~/.dsh/runtime/<版本>\（首次启动自解压）
const DEV_RUNTIME = path.join(__dirname, '..', 'dsh-runtime');
const RUNTIME_DIR = app.isPackaged ? path.join(RUNTIME_ROOT, RUNTIME_VER) : DEV_RUNTIME;

// 归档位置（打包模式下 node_modules 单文件）
const ARCHIVE_ZIP = path.join(process.resourcesPath, 'dsh-runtime', 'dsh-node_modules.zip');

const DSH_ENTRY = path.join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
// 打包模式 patch 在 resources/dsh-runtime；dev 模式在项目 dsh-runtime
const PATCH_FILE = app.isPackaged
  ? path.join(process.resourcesPath, 'dsh-runtime', 'patch-web.yaml')
  : path.join(DEV_RUNTIME, 'patch-web.yaml');
const DATA_DIR = path.join(DSH_ROOT, 'data');
const LOG_DIR = path.join(DSH_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'dsh.log');
const ENV_FILE = path.join(DSH_ROOT, '.env');
// 市场：随包数据（resources/dsh-runtime/market） + 本地安装登记（~/.dsh/market）
const MARKET_DIR = path.join(DSH_ROOT, 'market');
const INSTALLED_FILE = path.join(MARKET_DIR, 'installed.json');
const MARKET_SRC = app.isPackaged
  ? path.join(process.resourcesPath, 'dsh-runtime', 'market')
  : path.join(DEV_RUNTIME, 'market');

let mainWindow = null;
let initWindow = null;
let marketWindow = null;
let tray = null;
let dshProc = null;
let shuttingDown = false;

/* ---------- 日志 ---------- */
function log(msg) {
  const line = `${new Date().toISOString()} - ${msg}`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) { /* 忽略日志错误 */ }
}

/* ---------- 运行时初始化（首次启动解压） ---------- */
function ensureJunction() {
  // loader 从 profile 目录解析插件依赖：data/node_modules -> 运行时 node_modules
  const linkPath = path.join(DATA_DIR, 'node_modules');
  if (fs.existsSync(linkPath)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    fs.symlinkSync(RUNTIME_DIR + '\\node_modules', linkPath, 'junction');
    log('data/node_modules junction created');
  } catch (e) {
    log('junction failed (will copy instead): ' + e.message);
    try {
      fs.cpSync(path.join(RUNTIME_DIR, 'node_modules'), linkPath, { recursive: true });
    } catch (e2) { log('copy fallback failed: ' + e2.message); }
  }
}

function showInitWindow(text) {
  if (initWindow && !initWindow.isDestroyed()) { initWindow.setTitle('DSH Desktop'); return initWindow; }
  initWindow = new BrowserWindow({
    width: 520,
    height: 320,
    resizable: false,
    frame: false,
    center: true,
    backgroundColor: '#ffffff'
  });
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <style>
      body{margin:0;font-family:"Segoe UI","Microsoft YaHei",sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#fff;color:#1f2328}
      .logo{width:72px;height:72px;border-radius:16px;background:#0f6fff;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:26px;margin-bottom:22px}
      h2{font-size:17px;font-weight:600;margin:0 0 8px}
      p{font-size:13px;color:#656d76;margin:0 0 24px;text-align:center;padding:0 32px}
      .bar{width:260px;height:4px;border-radius:2px;background:#eaeef2;overflow:hidden}
      .bar i{display:block;height:100%;width:35%;border-radius:2px;background:#0f6fff;animation:slide 1.2s ease-in-out infinite}
      @keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(290%)}}
    </style></head><body>
    <div class="logo">DSH</div>
    <h2>正在初始化组件</h2>
    <p>${text}<br>首次启动需解压运行时组件，约需 1 分钟，请稍候…</p>
    <div class="bar"><i></i></div>
  </body></html>`;
  initWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return initWindow;
}

function closeInitWindow() {
  if (initWindow && !initWindow.isDestroyed()) { initWindow.destroy(); initWindow = null; }
}

async function ensureRuntime() {
  if (fs.existsSync(DSH_ENTRY)) {
    log('runtime ready: ' + RUNTIME_DIR);
    return true;
  }
  // 旧版数据迁移：%APPDATA%\dsh-desktop\runtime\ 已解压过则复制过来（省一次解压）
  if (app.isPackaged) {
    try {
      const legacyRuntime = path.join(app.getPath('userData'), 'runtime', RUNTIME_VER);
      if (fs.existsSync(path.join(legacyRuntime, 'node_modules')) && !fs.existsSync(RUNTIME_DIR)) {
        log('migrating legacy runtime from ' + legacyRuntime);
        fs.cpSync(legacyRuntime, RUNTIME_DIR, { recursive: true });
      }
    } catch (e) { log('legacy runtime migration skipped: ' + e.message); }
  }
  if (fs.existsSync(DSH_ENTRY)) {
    log('runtime ready (migrated): ' + RUNTIME_DIR);
    return true;
  }
  if (!app.isPackaged) {
    log('FATAL: dev runtime entry missing: ' + DSH_ENTRY);
    return false;
  }
  // 打包模式：解压归档到版本目录
  showInitWindow('正在解压 DeepSeek Harness 运行时');
  log('extracting runtime archive -> ' + RUNTIME_DIR);
  const t0 = Date.now();
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const tarExe = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
      : 'C:\\Windows\\System32\\tar.exe';
    if (!fs.existsSync(ARCHIVE_ZIP)) {
      log('FATAL: runtime archive missing: ' + ARCHIVE_ZIP);
      return false;
    }
    const r = spawnSync(tarExe, ['-xf', ARCHIVE_ZIP, '-C', RUNTIME_DIR], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5 * 60 * 1000
    });
    if (r.status !== 0) {
      log('extract failed: status=' + r.status + ' ' + (r.stderr || '').toString().slice(0, 500));
      return false;
    }
    log(`extract done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return fs.existsSync(DSH_ENTRY);
  } catch (e) {
    log('extract error: ' + e.message);
    return false;
  }
}

/* ---------- dsh 服务生命周期 ---------- */
function loadEnvFile() {
  // 数据目录 .env：用户可配置 DINGTALK_APP_KEY / DINGTALK_APP_SECRET 等
  if (!fs.existsSync(ENV_FILE)) return;
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { log('env load failed: ' + e.message); }
}

function startDsh() {
  if (dshProc && !dshProc.killed) return dshProc;

  if (!fs.existsSync(DSH_ENTRY)) {
    log('FATAL: dsh entry missing: ' + DSH_ENTRY);
    dialog.showErrorBox('DSH Desktop', 'dsh 运行时缺失，请重新安装应用。');
    app.quit();
    return null;
  }
  ensureJunction();
  loadEnvFile();

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logFd = fs.openSync(LOG_FILE, 'a');

  log('spawning dsh ...');
  dshProc = spawn(process.execPath, [
    DSH_ENTRY, '--profile', 'web', '--patch', PATCH_FILE
  ], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: DATA_DIR,
      // 目录选择器 worker 用捆绑的官方 node.exe（koffi FFI 在 Electron V8 下崩溃）
      DSH_DIALOG_NODE_BIN: path.join(RUNTIME_DIR, 'node.exe')
      // 注意：绝不要覆盖 HOME / USERPROFILE —— dsh 的原生目录选择器
      // 依赖 Windows Known Folders（桌面/文档等），覆盖后全部解析错乱
    },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true
  });

  dshProc.on('exit', (code, signal) => {
    log(`dsh exited (code=${code}, signal=${signal})`);
    dshProc = null;
    if (!shuttingDown) {
      retryCount += 1;
      if (retryCount <= 3) {
        log(`dsh down, respawning (attempt ${retryCount}) ...`);
        setTimeout(() => startDsh(), 1500);
      }
    }
  });
  dshProc.on('error', (err) => {
    log('dsh spawn error: ' + err.message);
    dshProc = null;
  });
  return dshProc;
}

let retryCount = 0;

function stopDsh() {
  shuttingDown = true;
  if (dshProc) {
    try { dshProc.kill(); } catch (_) {}
    dshProc = null;
  }
}

function isServerUp() {
  return new Promise((resolve) => {
    const req = http.get(BASE + '/', { timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await isServerUp()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/* ---------- 窗口 & 托盘 ---------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'DSH Desktop',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL(BASE);

  // 固定窗口标题（dsh 页面标题不覆盖）
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    mainWindow.setTitle('DSH Desktop');
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BASE)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    if (!shuttingDown) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  // 托盘图标：优先 PNG（32x32，Windows 托盘渲染最稳），打包版从 resources/dsh-runtime
  const trayPng = app.isPackaged
    ? path.join(process.resourcesPath, 'dsh-runtime', 'tray.png')
    : path.join(__dirname, '..', 'dsh-runtime', 'tray.png');
  const icoPath = app.isPackaged
    ? path.join(process.resourcesPath, 'dsh-runtime', 'icon.ico')
    : path.join(__dirname, '..', 'build', 'icon.ico');
  let icon = nativeImage.createFromPath(fs.existsSync(trayPng) ? trayPng : icoPath);
  if (icon.isEmpty()) icon = nativeImage.createFromPath(icoPath);
  log('tray icon: ' + (fs.existsSync(trayPng) ? trayPng : icoPath) + ' (empty=' + icon.isEmpty() + ')');
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('DSH Desktop');

  const menu = Menu.buildFromTemplate([
    { label: '打开工作台', click: () => { showWindow(); } },
    { label: '欢迎', click: () => { openWelcome(); } },
    { label: '访问地址', click: () => { shell.openExternal(BASE); } },
    { label: '技能与插件市场', click: () => { openMarket(); } },
    { type: 'separator' },
    {
      label: '开机自启', type: 'checkbox', checked: isAutoLaunch(),
      click: (item) => { setAutoLaunch(item.checked); }
    },
    {
      label: '右键"用 DSH Desktop 打开"', type: 'checkbox', checked: openWithMenuExists(),
      click: (item) => { setOpenWithMenu(item.checked); }
    },
    { type: 'separator' },
    { label: '内置浏览器', click: () => { openBrowser(); } },
    { label: '捕获屏幕', click: () => { takeSnapshot(); } },
    {
      label: 'IM 渠道',
      submenu: buildChannelSubmenu()
    },
    { label: '检查更新', click: () => { checkForUpdate(false); } },
    { label: '设置', click: () => { openSettings(); } },
    { label: '导出诊断信息', click: () => { exportDiagnostics(); } },
    { label: '打开数据目录', click: () => { shell.openPath(DSH_ROOT); } },
    { label: '打开日志目录', click: () => { shell.openPath(LOG_DIR); } },
    { type: 'separator' },
    { label: '关于', click: () => { showAbout(); } },
    { label: '退出', click: () => {
      shuttingDown = true;
      stopDsh();
      app.quit();
    } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showWindow());
}

function buildChannelSubmenu() {
  const items = [];
  for (const ch of channels.channelStatus()) {
    items.push({
      label: `${ch.enabled ? '●' : ch.configured ? '◐' : '○'} ${ch.name}${ch.enabled ? '（已启用）' : ch.configured ? '（部分配置）' : ''}`,
      enabled: false
    });
  }
  items.push({ type: 'separator' });
  items.push({ label: '配置 IM 渠道…', click: () => openSettings() });
  return items;
}

function rebuildTrayMenu() {
  if (!tray) return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开工作台', click: () => { showWindow(); } },
      { label: '欢迎', click: () => { openWelcome(); } },
      { label: '访问地址', click: () => { shell.openExternal(BASE); } },
      { label: '技能与插件市场', click: () => { openMarket(); } },
      { type: 'separator' },
      {
        label: '开机自启', type: 'checkbox', checked: isAutoLaunch(),
        click: (item) => { setAutoLaunch(item.checked); }
      },
      {
        label: '右键"用 DSH Desktop 打开"', type: 'checkbox', checked: openWithMenuExists(),
        click: (item) => { setOpenWithMenu(item.checked); }
      },
      { type: 'separator' },
      { label: '内置浏览器', click: () => { openBrowser(); } },
      { label: '捕获屏幕', click: () => { takeSnapshot(); } },
      { label: 'IM 渠道', submenu: buildChannelSubmenu() },
      { label: '检查更新', click: () => { checkForUpdate(false); } },
      { label: '设置', click: () => { openSettings(); } },
      { label: '导出诊断信息', click: () => { exportDiagnostics(); } },
      { label: '打开数据目录', click: () => { shell.openPath(DSH_ROOT); } },
      { label: '打开日志目录', click: () => { shell.openPath(LOG_DIR); } },
      { type: 'separator' },
      { label: '关于', click: () => { showAbout(); } },
      { label: '退出', click: () => {
        shuttingDown = true;
        stopDsh();
        app.quit();
      } }
    ]));
  } catch (e) { log('rebuild tray failed: ' + e.message); }
}

function showWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ---------- P1 壳产品化：自启 / 关于 / 拖拽 / 市场 ---------- */
function isAutoLaunch() {
  try { return app.getLoginItemSettings().openAtLogin; } catch (_) { return false; }
}
function setAutoLaunch(enable) {
  try {
    app.setLoginItemSettings({ openAtLogin: enable });
    log('auto launch set: ' + enable);
  } catch (e) { log('auto launch failed: ' + e.message); }
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '关于 DSH Desktop',
    message: 'DSH Desktop',
    detail: [
      `版本: v${app.getVersion()}`,
      `dsh 引擎: 0.1.0-rc.6`,
      `服务地址: ${BASE}`,
      '',
      `数据目录: ${DSH_ROOT}`,
      `日志目录: ${LOG_DIR}`,
      `运行时: ${RUNTIME_DIR}`,
      '',
      `Electron ${process.versions.electron} · Node ${process.versions.node}`
    ].join('\n'),
    buttons: ['好']
  });
}

function handleDroppedFiles(paths) {
  if (!paths || !paths.length) return;
  const list = paths.join('\r\n');
  clipboard.writeText(list);
  log('files dropped (copied to clipboard): ' + paths.join(', '));
  if (Notification.isSupported()) {
    new Notification({
      title: 'DSH Desktop',
      body: '已复制文件路径，可直接粘贴到对话中使用'
    }).show();
  }
}

function setupDragDrop(win) {
  // 拖文件进窗口：拦截 file:// 导航，复制路径到剪贴板
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) return;
    e.preventDefault();
    try {
      const p = decodeURIComponent(url.replace(/^file:\/\//, ''));
      const clean = p.replace(/^\/[A-Za-z]:/, (m) => m.slice(1)); // /C:/x -> C:/x
      handleDroppedFiles([clean]);
    } catch (err) { log('drop parse error: ' + err.message); }
  });
}

/* ---------- 技能/插件市场 ---------- */
function readInstalled() {
  try { return JSON.parse(fs.readFileSync(INSTALLED_FILE, 'utf8')); } catch (_) { return {}; }
}
function listMarket(type) {
  const file = path.join(MARKET_SRC, type === 'plugin' ? 'plugin-market.json' : 'skill-market.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return []; }
}
function installMarketItem(type, id) {
  const item = listMarket(type).find((i) => i.id === id);
  if (!item) return { ok: false, message: '条目不存在: ' + id };
  fs.mkdirSync(MARKET_DIR, { recursive: true });
  const installed = readInstalled();
  installed[type + ':' + id] = { id, name: item.name, version: item.version, installedAt: new Date().toISOString() };
  fs.writeFileSync(INSTALLED_FILE, JSON.stringify(installed, null, 2), 'utf8');
  // 内置 IM 渠道插件：随包携带，安装=登记 + 引导去设置配置凭据
  if (type === 'plugin' && /^channel-/.test(id)) {
    log('market install (builtin channel): ' + id);
    return { ok: true, message: `「${item.name}」为内置渠道插件，请到 设置 → IM 渠道 配置凭据，重启后生效` };
  }
  // 技能：复制 SKILL.md 技能包到 DSH_HOME/skills/<id>/（dsh 启动即加载，对话输 / 可调用）
  if (type === 'skill') {
    const srcRoot = path.join(MARKET_SRC, 'skills', id);
    if (fs.existsSync(srcRoot)) {
      const target = path.join(DATA_DIR, 'skills', id);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(srcRoot, target, { recursive: true });
      log('skill installed -> ' + target);
    }
  }
  log(`market install: ${type}:${id}`);
  const hint = type === 'skill'
    ? `已安装「${item.name}」到技能库。重启应用后，在对话输入框输入 / 即可看到并调用`
    : `已安装「${item.name}」，重启后生效`;
  return { ok: true, message: hint };
}
function openMarket() {
  if (marketWindow && !marketWindow.isDestroyed()) { marketWindow.show(); marketWindow.focus(); return; }
  marketWindow = new BrowserWindow({
    width: 940,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    title: '技能与插件市场',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'dsh-runtime', 'icon.ico')
      : path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  marketWindow.loadFile(path.join(__dirname, 'market.html'));
  marketWindow.on('closed', () => { marketWindow = null; });
}
function registerMarketIpc() {
  ipcMain.handle('market:list', (_e, type) => ({
    items: listMarket(type),
    installed: readInstalled()
  }));
  ipcMain.handle('market:install', (_e, type, id) => installMarketItem(type, id));
  ipcMain.handle('market:uninstall', (_e, type, id) => uninstallMarketItem(type, id));
  ipcMain.handle('market:openDir', () => shell.openPath(MARKET_DIR));
}

// 卸载：移除登记 + 删除技能目录
function uninstallMarketItem(type, id) {
  try {
    const installed = readInstalled();
    delete installed[type + ':' + id];
    fs.writeFileSync(INSTALLED_FILE, JSON.stringify(installed, null, 2), 'utf8');
    if (type === 'skill') {
      fs.rmSync(path.join(DATA_DIR, 'skills', id), { recursive: true, force: true });
    }
    log(`market uninstall: ${type}:${id}`);
    return { ok: true, message: `已卸载「${id}」，重启后生效` };
  } catch (e) { return { ok: false, message: e.message }; }
}

/* ---------- 欢迎页 / 主题 / 右键打开 ---------- */
let welcomeWindow = null;
function openWelcome() {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) { welcomeWindow.show(); welcomeWindow.focus(); return; }
  welcomeWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 640,
    minHeight: 480,
    title: 'DSH Desktop',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'dsh-runtime', 'icon.ico')
      : path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  welcomeWindow.loadFile(path.join(__dirname, 'welcome.html'));
  welcomeWindow.on('closed', () => { welcomeWindow = null; });
}

function registerWelcomeIpc() {
  ipcMain.handle('welcome:openWorkspace', () => { showWindow(); });
  ipcMain.handle('welcome:openMarket', () => { openMarket(); });
  ipcMain.handle('welcome:openDataDir', () => shell.openPath(DSH_ROOT));
  ipcMain.handle('welcome:openSettings', () => { openSettings(); return { ok: true }; });
  ipcMain.handle('welcome:showAbout', () => showAbout());
}

// UI 现代化：注入品牌主题 CSS（dsh web UI 加载完成后）
function applyTheme(win) {
  let css = '';
  try { css = fs.readFileSync(path.join(__dirname, 'theme.css'), 'utf8'); } catch (_) {}
  if (!css) return;
  win.webContents.on('did-finish-load', () => {
    win.webContents.insertCSS(css).catch(() => {});
  });
}

/* ---------- 壳层桥：dsh web UI 的本地操作兜底 ---------- */
function settingsFilePath() {
  return path.join(DATA_DIR, 'settings.yaml');
}
function registerShellBridge() {
  ipcMain.handle('shell:openSettingsFile', () => {
    try {
      const f = settingsFilePath();
      if (!fs.existsSync(f)) fs.writeFileSync(f, '# dsh settings\n', 'utf8');
      shell.openPath(f);
      log('shell bridge: open settings file ' + f);
      return { ok: true };
    } catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('shell:openDataDir', () => { shell.openPath(DSH_ROOT); return { ok: true }; });
  ipcMain.handle('shell:openLogsDir', () => { shell.openPath(LOG_DIR); return { ok: true }; });
  ipcMain.handle('shell:openMarket', () => { openMarket(); return { ok: true }; });
  ipcMain.handle('shell:openWelcome', () => { openWelcome(); return { ok: true }; });
  ipcMain.handle('shell:openSettingsWindow', () => { openSettings(); return { ok: true }; });
  ipcMain.handle('shell:getVersion', () => ({ version: app.getVersion(), base: BASE, engine: '0.1.0-rc.6' }));
  // 右侧面板：已安装技能（~/.dsh/data/skills 目录）
  ipcMain.handle('shell:listSkills', () => {
    try {
      const dir = path.join(DATA_DIR, 'skills');
      if (!fs.existsSync(dir)) return [];
      const names = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
        .map((d) => d.name);
      return names;
    } catch (_) { return []; }
  });
  // 右侧面板：服务状态
  ipcMain.handle('shell:serverStatus', async () => ({ up: await isServerUp(), port: PORT }));
  // 产物：列出工作区目录（~/.dsh/workspace）最近修改的文件
  ipcMain.handle('shell:listArtifacts', () => {
    try {
      const dir = path.join(DSH_ROOT, 'workspace');
      if (!fs.existsSync(dir)) return { root: dir, files: [] };
      const files = fs.readdirSync(dir, { withFileTypes: true })
        .map((d) => {
          const p = path.join(dir, d.name);
          let s = null; try { s = fs.statSync(p); } catch (_) {}
          return { name: d.name, dir: d.isDirectory(), mtime: s ? s.mtimeMs : 0, size: s ? s.size : 0 };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 8);
      return { root: dir, files };
    } catch (_) { return { root: path.join(DSH_ROOT, 'workspace'), files: [] }; }
  });
  ipcMain.handle('shell:openWorkspace', () => {
    const dir = path.join(DSH_ROOT, 'workspace');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  });
  // 更新检查（0.3.0 GitHub Releases）
  ipcMain.handle('shell:checkUpdate', () => checkForUpdate(true));
  ipcMain.handle('shell:updateState', () => updateState);
  ipcMain.handle('shell:updateDownload', () => startUpdateDownload());
  ipcMain.handle('shell:updateInstall', () => {
    const st = updateState;
    if (st.status === 'ready' && st.info) {
      const dest = path.join(updater.UPDATE_DIR, `dsh-desktop-${st.info.latest}-setup.exe`);
      if (fs.existsSync(dest)) { runInstaller(dest); return { ok: true }; }
    }
    return { ok: false, message: '安装包未就绪' };
  });
  ipcMain.handle('shell:updateSource', (_e, patch) => {
    if (patch && typeof patch === 'object') {
      const r = updater.writeSource({ owner: String(patch.owner || '').trim(), repo: String(patch.repo || '').trim() });
      return r;
    }
    return { ok: true, source: updater.readSource() };
  });
  ipcMain.handle('shell:updateOpenDir', () => {
    fs.mkdirSync(updater.UPDATE_DIR, { recursive: true });
    shell.openPath(updater.UPDATE_DIR);
    return { ok: true };
  });
  // IM 渠道状态与凭据（脱敏）
  ipcMain.handle('shell:channelStatus', () => channels.channelStatus());
  ipcMain.handle('settings:getChannels', () => channels.channelStatus());
  ipcMain.handle('settings:saveChannel', (_e, id, values) => {
    const r = channels.saveChannel(id, values);
    if (r.ok) { log('channel saved: ' + id); rebuildTrayMenu(); }
    return r;
  });
  ipcMain.handle('settings:clearChannel', (_e, id) => {
    const r = channels.clearChannel(id);
    if (r.ok) { log('channel cleared: ' + id); rebuildTrayMenu(); }
    return r;
  });
  // 设置窗口数据
  ipcMain.handle('settings:get', () => ({
    version: app.getVersion(),
    engine: '0.1.0-rc.6',
    base: BASE,
    dshRoot: DSH_ROOT,
    logDir: LOG_DIR,
    dataDir: DATA_DIR,
    runtimeDir: RUNTIME_DIR,
    autoLaunch: isAutoLaunch(),
    openWith: openWithMenuExists(),
    hotkey: !!readDesktopSettings().hotkey,
    updateSource: updater.readSource(),
    updateState,
    channels: channels.channelStatus()
  }));
  ipcMain.handle('settings:setAutoLaunch', (_e, v) => { setAutoLaunch(!!v); return { ok: true }; });
  ipcMain.handle('settings:setOpenWith', (_e, v) => { setOpenWithMenu(!!v); return { ok: true }; });
  ipcMain.handle('settings:setHotkey', (_e, v) => { applyHotkey(!!v); writeDesktopSettings({ hotkey: !!v }); return { ok: true }; });
  ipcMain.handle('settings:setDingtalk', (_e, appKey, appSecret) => setDingtalkCreds(appKey, appSecret));
  // 0.1.6/0.1.7 新增桥
  ipcMain.handle('shell:openBrowser', (_e, url) => { openBrowser(url); return { ok: true }; });
  ipcMain.handle('shell:takeSnapshot', () => takeSnapshot());
  ipcMain.handle('shell:listWorkspaces', () => listWorkspaces());
  ipcMain.handle('shell:exportDiagnostics', () => exportDiagnostics());
  ipcMain.handle('shell:openExternal', (_e, url) => { if (url) shell.openExternal(url); return { ok: true }; });
}

// 注入：把 dsh 页面"打开配置文件"按钮改为走壳层（绕开服务端 powershell 链，100% 可用）
function patchOpenConfigButton(win) {
  const js = `
(() => {
  const tryPatch = () => {
    if (typeof window.__dshShell === 'undefined') return false;
    let patched = 0;
    document.querySelectorAll('button').forEach((btn) => {
      if (btn.dataset.dshPatched) return;
      const t = (btn.textContent || '').trim();
      if (t === '打开配置文件' || t === 'Open configuration file') {
        btn.dataset.dshPatched = '1';
        const orig = btn.onclick;
        btn.onclick = (e) => {
          e.preventDefault(); e.stopPropagation();
          window.__dshShell.openSettingsFile().then((r) => {
            if (!r || !r.ok) console.warn('shell openSettingsFile failed', r);
          });
          return false;
        };
        patched++;
      }
    });
    return patched > 0;
  };
  if (tryPatch()) return;
  const obs = new MutationObserver(() => tryPatch());
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 120000);
})();
`;
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(js, true).catch(() => {});
  });
}

// 右侧面板：三栏布局（对齐千问办公）——技能 / 快捷操作 / 服务状态
function injectSidePanel(win) {
  const NS = 'dsh-side-panel';
  const js = `
(() => {
  if (document.getElementById('${NS}') || typeof window.__dshShell === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = \`
/* 三栏集成：dsh 内容区给右侧面板让位（不遮挡，正常流收窄） */
body { padding-right: 272px !important; transition: padding-right .15s ease; }
body.dshp-collapsed-body { padding-right: 34px !important; }
#${NS}{position:fixed;top:0;right:0;bottom:0;width:272px;z-index:1000;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base,#fff);border-left:1px solid var(--dsw-alias-border-l1,#e5e7eb);
  color:var(--dsw-alias-label-primary,#1f2328);}
#${NS} *{box-sizing:border-box;}
#${NS} .dshp-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);}
#${NS} .dshp-title{font-size:14px;font-weight:600;}
#${NS} .dshp-fold{border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary,#656d76);font-size:14px;padding:2px 6px;border-radius:6px;}
#${NS} .dshp-fold:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5);}
#${NS} .dshp-body{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px;}
#${NS} .dshp-sec{background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:10px 12px;}
#${NS} .dshp-sec h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#656d76);display:flex;align-items:center;gap:6px;}
#${NS} .dshp-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4D6BFE);display:inline-block;}
#${NS} .dshp-item{font-size:13px;padding:5px 8px;border-radius:6px;color:var(--dsw-alias-label-primary,#1f2328);display:flex;align-items:center;gap:7px;cursor:default;line-height:1.5;}
#${NS} .dshp-item .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#${NS} .dshp-empty{font-size:12px;color:var(--dsw-alias-label-caption,#8b949e);padding:4px 8px;line-height:1.6;}
#${NS} .dshp-btn{display:block;width:100%;text-align:center;border:1px solid var(--dsw-alias-brand-primary,#4D6BFE);color:var(--dsw-alias-brand-primary,#4D6BFE);background:transparent;
  border-radius:8px;padding:6px 0;font-size:12px;cursor:pointer;margin-top:6px;transition:background .15s;}
#${NS} .dshp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5);}
#${NS} .dshp-row{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#656d76);padding:3px 4px;line-height:1.5;}
#${NS} .dshp-row b{color:var(--dsw-alias-label-primary,#1f2328);font-weight:600;}
#${NS} .dshp-up{color:var(--dsw-alias-state-success-primary,#2da44e);}
#${NS} .dshp-down{color:var(--dsw-alias-state-error-primary,#d1242f);}
#${NS}.dshp-collapsed{width:34px;}
#${NS}.dshp-collapsed .dshp-body{display:none;}
#${NS}.dshp-collapsed .dshp-head{padding:12px 0;justify-content:center;border-bottom:none;}
\`;
  document.head.appendChild(style);
  const panel = document.createElement('aside');
  panel.id = '${NS}';
  panel.innerHTML = \`
<div class="dshp-head"><span class="dshp-title">任务监控</span><button class="dshp-fold" title="折叠">»</button></div>
<div class="dshp-body">
  <div class="dshp-sec"><h4><span class="dshp-dot"></span>产物</h4><div data-part="artifacts"><div class="dshp-empty">加载中…</div></div><button class="dshp-btn" data-act="workspace">打开工作区目录</button></div>
  <div class="dshp-sec"><h4><span class="dshp-dot"></span>工作区</h4><div data-part="workspaces"><div class="dshp-empty">加载中…</div></div></div>
  <div class="dshp-sec"><h4><span class="dshp-dot"></span>已安装技能</h4><div data-part="skills"><div class="dshp-empty">加载中…</div></div><button class="dshp-btn" data-act="market">打开技能与插件市场</button></div>
  <div class="dshp-sec"><h4><span class="dshp-dot"></span>快捷操作</h4>
    <div class="dshp-item" data-act="browser" style="cursor:pointer;"><span>🌐</span><span class="nm">内置浏览器</span></div>
    <div class="dshp-item" data-act="config" style="cursor:pointer;"><span>⚙️</span><span class="nm">打开配置文件</span></div>
    <div class="dshp-item" data-act="data" style="cursor:pointer;"><span>📁</span><span class="nm">数据目录 ~/.dsh</span></div>
    <div class="dshp-item" data-act="logs" style="cursor:pointer;"><span>🗒️</span><span class="nm">日志目录</span></div>
    <div class="dshp-item" data-act="settings" style="cursor:pointer;"><span>🛠️</span><span class="nm">设置</span></div>
    <div class="dshp-item" data-act="welcome" style="cursor:pointer;"><span>🏠</span><span class="nm">欢迎页</span></div>
  </div>
  <div class="dshp-sec"><h4><span class="dshp-dot"></span>IM 渠道</h4><div data-part="channels"><div class="dshp-empty">加载中…</div></div><button class="dshp-btn" data-act="channels">配置 IM 渠道</button></div>
  <div class="dshp-sec"><h4><span class="dshp-dot"></span>服务状态</h4><div data-part="status"><div class="dshp-empty">检测中…</div></div></div>
</div>\`;
  document.body.appendChild(panel);

  const fold = panel.querySelector('.dshp-fold');
  fold.addEventListener('click', () => {
    panel.classList.toggle('dshp-collapsed');
    document.body.classList.toggle('dshp-collapsed-body', panel.classList.contains('dshp-collapsed'));
    fold.textContent = panel.classList.contains('dshp-collapsed') ? '«' : '»';
  });

  // 工作区列表
  window.__dshShell.listWorkspaces().then((ws) => {
    const box = panel.querySelector('[data-part="workspaces"]');
    if (!ws || !ws.length) { box.innerHTML = '<div class="dshp-empty">暂无工作区</div>'; return; }
    box.innerHTML = ws.map((w) => '<div class="dshp-item" title="' + w.path + '"><span>📁</span><span class="nm">' + w.title + '</span><span style="font-size:10px;color:var(--dsw-alias-label-caption,#8b949e);">' + (w.sessionIds || 0) + ' 会话</span></div>').join('');
  });

  // 产物列表
  window.__dshShell.listArtifacts().then((a) => {
    const box = panel.querySelector('[data-part="artifacts"]');
    if (!a || !a.files || !a.files.length) { box.innerHTML = '<div class="dshp-empty">工作区暂无产物</div>'; return; }
    box.innerHTML = a.files.map((f) => {
      const icon = f.dir ? '📂' : '📄';
      const size = f.dir ? '' : ' · ' + (f.size > 1048576 ? (f.size / 1048576).toFixed(1) + 'MB' : f.size > 1024 ? (f.size / 1024).toFixed(0) + 'KB' : f.size + 'B');
      return '<div class="dshp-item" title="' + f.name + '"><span>' + icon + '</span><span class="nm">' + f.name + '</span><span style="font-size:10px;color:var(--dsw-alias-label-caption,#8b949e);">' + size + '</span></div>';
    }).join('');
  });
  // 技能列表
  window.__dshShell.listSkills().then((names) => {
    const box = panel.querySelector('[data-part="skills"]');
    if (!names || !names.length) { box.innerHTML = '<div class="dshp-empty">暂无已安装技能<br>（去市场安装，重启后在对话输入 / 调用）</div>'; return; }
    box.innerHTML = names.map((n) => '<div class="dshp-item"><span>✦</span><span class="nm">' + n + '</span></div>').join('');
  });
  // IM 渠道状态
  window.__dshShell.channelStatus().then((chs) => {
    const box = panel.querySelector('[data-part="channels"]');
    if (!chs || !chs.length) { box.innerHTML = '<div class="dshp-empty">无渠道</div>'; return; }
    box.innerHTML = chs.map((c) => {
      const dot = c.enabled ? '🟢' : (c.configured ? '🟡' : '⚪');
      return '<div class="dshp-item" title="' + c.desc + '"><span>' + dot + '</span><span class="nm">' + c.name + '</span></div>';
    }).join('');
  });
  // 服务状态 + 版本
  Promise.all([window.__dshShell.serverStatus(), window.__dshShell.getVersion()]).then(([st, ver]) => {
    const box = panel.querySelector('[data-part="status"]');
    const up = st && st.up;
    box.innerHTML = '<div class="dshp-row"><span>服务</span><b class="' + (up ? 'dshp-up' : 'dshp-down') + '">' + (up ? '运行中' : '未启动') + '</b></div>' +
      '<div class="dshp-row"><span>端口</span><b>' + (st ? st.port : '-') + '</b></div>' +
      '<div class="dshp-row"><span>版本</span><b>v' + (ver ? ver.version : '?') + '</b></div>' +
      '<div class="dshp-row"><span>引擎</span><b>' + (ver ? ver.engine : '?') + '</b></div>';
  });
  // 按钮
  panel.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', () => {
      const a = el.dataset.act;
      if (a === 'market') window.__dshShell.openMarket();
      else if (a === 'config') window.__dshShell.openSettingsFile();
      else if (a === 'data') window.__dshShell.openDataDir();
      else if (a === 'logs') window.__dshShell.openLogsDir();
      else if (a === 'welcome') window.__dshShell.openWelcome();
      else if (a === 'settings') window.__dshShell.openSettings();
      else if (a === 'workspace') window.__dshShell.openWorkspace();
      else if (a === 'browser') window.__dshShell.openBrowser();
      else if (a === 'channels') window.__dshShell.openSettings();
    });
  });
})();
`;
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(js, true).catch((e) => log('side panel inject failed: ' + e.message));
    win.webContents.executeJavaScript('setTimeout(() => { console.log("DSH_PANEL_STATE:" + (document.getElementById("dsh-side-panel") ? "mounted" : "missing")); }, 3000);', true).catch(() => {});
  });
  win.webContents.on('console-message', (_e, _level, message) => {
    if (String(message).startsWith('DSH_PANEL_STATE')) log('side panel: ' + message);
  });
}
function openWithMenuExists() {
  try {
    const r = spawnSync('reg', ['query', 'HKCU\\Software\\Classes\\*\\shell\\DSH Desktop'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return r.status === 0;
  } catch (_) { return false; }
}
function setOpenWithMenu(enable) {
  if (!app.isPackaged) { log('open-with skipped in dev'); return; }
  try {
    if (enable) {
      const exe = process.execPath;
      spawnSync('reg', ['add', 'HKCU\\Software\\Classes\\*\\shell\\DSH Desktop', '/ve', '/d', '用 DSH Desktop 打开', '/f']);
      spawnSync('reg', ['add', 'HKCU\\Software\\Classes\\*\\shell\\DSH Desktop\\command', '/ve', '/d', `"${exe}" --open-file "%1"`, '/f']);
      log('open-with menu enabled');
    } else {
      spawnSync('reg', ['delete', 'HKCU\\Software\\Classes\\*\\shell\\DSH Desktop', '/f']);
      log('open-with menu disabled');
    }
  } catch (e) { log('open-with reg failed: ' + e.message); }
}

// 处理 --open-file 参数（右键"用 DSH Desktop 打开"传入）
function handleOpenFileArg() {
  const idx = process.argv.indexOf('--open-file');
  if (idx !== -1 && process.argv[idx + 1]) {
    const p = process.argv[idx + 1];
    setTimeout(() => {
      handleDroppedFiles([p]);
      showWindow();
    }, 1200);
  }
}

/* ---------- 0.1.5 设置窗口 ---------- */
let settingsWindow = null;
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 680,
    height: 640,
    minWidth: 560,
    minHeight: 520,
    title: 'DSH Desktop 设置',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'dsh-runtime', 'icon.ico')
      : path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

/* ---------- 0.1.6 内置浏览器 / 屏幕快照 ---------- */
let browserWindow = null;
function openBrowser(url) {
  if (browserWindow && !browserWindow.isDestroyed()) {
    if (url) browserWindow.webContents.send('browser:goto', url);
    browserWindow.show(); browserWindow.focus();
    return;
  }
  browserWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: 'DSH 浏览器',
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'dsh-runtime', 'icon.ico')
      : path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  });
  browserWindow.loadFile(path.join(__dirname, 'browser.html'));
  browserWindow.on('closed', () => { browserWindow = null; });
}

// 屏幕快照：PowerShell 截全屏 -> ~/.dsh/snapshots/<时间戳>.png，复制路径并通知
function takeSnapshot() {
  const dir = path.join(DSH_ROOT, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png');
  try {
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${file.replace(/'/g, "''")}');`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 20000 });
    if (r.status === 0 && fs.existsSync(file)) {
      clipboard.writeText(file);
      if (Notification.isSupported()) new Notification({ title: 'DSH Desktop', body: '屏幕快照已保存并复制路径，可粘贴到对话中分析' }).show();
      log('snapshot saved: ' + file);
      return { ok: true, file };
    }
    return { ok: false, message: '截图失败' };
  } catch (e) { return { ok: false, message: e.message }; }
}

/* ---------- 0.3.0 更新检查（GitHub Releases） ---------- */
let updateState = { status: 'idle', info: null, progress: null, message: '' };

function broadcastUpdate() {
  for (const w of [mainWindow, settingsWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send('update:state', updateState);
  }
}

async function checkForUpdate(silent = true) {
  updateState = { ...updateState, status: 'checking', message: '正在检查更新…' };
  broadcastUpdate();
  const info = await updater.checkForUpdates(app.getVersion());
  updateState = { status: info.ok ? 'idle' : 'error', info, progress: null, message: info.ok ? '' : (info.message || '检查失败') };
  broadcastUpdate();
  log(`update check: ok=${info.ok} hasUpdate=${info.hasUpdate} current=${info.current} latest=${info.latest}`);
  if (silent) return info;
  if (!info.ok) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning', title: '检查更新', message: '检查更新失败',
      detail: (info.message || '') + '\n更新源: ' + (info.source || ''),
      buttons: ['好']
    });
    return info;
  }
  if (info.hasUpdate) {
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'info', title: '发现新版本', message: `DSH Desktop v${info.latest} 可用`,
      detail: (info.notes || '').slice(0, 1200) + `\n\n当前版本 v${info.current}`,
      buttons: ['下载并安装', '稍后']
    });
    if (r.response === 0) startUpdateDownload();
  } else {
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: '检查更新', message: '当前已是最新版本',
      detail: `DSH Desktop v${app.getVersion()} · 更新源 ${info.source}`, buttons: ['好']
    });
  }
  return info;
}

async function startUpdateDownload() {
  const info = updateState.info;
  if (!info || !info.hasUpdate || updateState.status === 'downloading') return { ok: false, message: '无可用更新或正在下载' };
  updateState = { ...updateState, status: 'downloading', progress: { received: 0, total: info.size || 0, percent: 0 } };
  broadcastUpdate();
  const r = await updater.downloadAndInstall(info, (p) => {
    updateState = { ...updateState, progress: p };
    broadcastUpdate();
  });
  if (r.ok && r.quit) {
    updateState = { ...updateState, status: 'ready', message: '下载完成，即将安装…' };
    broadcastUpdate();
    log('installer ready: ' + r.installer);
    setTimeout(() => runInstaller(r.installer), 1200);
  } else {
    updateState = { ...updateState, status: 'error', message: r.message };
    broadcastUpdate();
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, { type: 'error', title: '更新失败', message: r.message, buttons: ['好'] });
    }
  }
  return r;
}

function runInstaller(installerPath) {
  try {
    log('launching installer: ' + installerPath);
    spawn(installerPath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
    // 安装器静默覆盖安装后自行拉起新版本；先退出本实例释放文件锁
    setTimeout(() => {
      shuttingDown = true;
      stopDsh();
      app.quit();
    }, 2000);
  } catch (e) {
    log('installer launch failed: ' + e.message);
    dialog.showErrorBox('DSH Desktop', '无法启动安装器：' + e.message);
  }
}

/* ---------- 0.1.4 启动自检 ---------- */
function startupSelfCheck() {
  const issues = [];
  // 1) 运行时完整性
  if (app.isPackaged) {
    try {
      const sharpOk = spawnSync(path.join(RUNTIME_DIR, 'node.exe'), ['-e',
        `try{require(${JSON.stringify(path.join(RUNTIME_DIR, 'node_modules', 'sharp'))});process.exit(0)}catch(e){process.exit(1)}`
      ], { timeout: 15000, encoding: 'utf8' });
      if (sharpOk.status !== 0) issues.push('sharp 运行时组件异常');
    } catch (_) { issues.push('运行时自检失败'); }
  }
  if (issues.length) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning', title: 'DSH Desktop 自检提示',
      message: '检测到以下问题', detail: issues.join('\n'), buttons: ['知道了']
    });
  }
}

/* ---------- 0.1.7 工作区列表 / 诊断导出 ---------- */
function listWorkspaces() {
  try {
    const f = path.join(DATA_DIR, 'storages', 'workspace.json');
    if (!fs.existsSync(f)) return [];
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const ws = (data.tables && data.tables.workspaces) || {};
    return Object.values(ws)
      .map((w) => ({ title: w.title || 'workspace', path: w.path || '', sessionIds: (w.sessionIds || []).length }))
      .sort((a, b) => (b.sessionIds || 0) - (a.sessionIds || 0));
  } catch (_) { return []; }
}

// 诊断导出：日志+配置+版本 -> 桌面 zip
function exportDiagnostics() {
  try {
    const desktop = app.getPath('desktop');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zip = path.join(desktop, `dsh-diagnostics-${stamp}.zip`);
    const tmp = path.join(app.getPath('temp'), `dsh-diag-${stamp}`);
    fs.mkdirSync(tmp, { recursive: true });
    fs.copyFileSync(LOG_FILE, path.join(tmp, 'dsh.log'));
    const ver = { version: app.getVersion(), engine: '0.1.0-rc.6', electron: process.versions.electron, node: process.versions.node, dshRoot: DSH_ROOT };
    fs.writeFileSync(path.join(tmp, 'version.json'), JSON.stringify(ver, null, 2), 'utf8');
    const upd = path.join(DSH_ROOT, 'update.json');
    if (fs.existsSync(upd)) fs.copyFileSync(upd, path.join(tmp, 'update.json'));
    const tarExe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'C:\\Windows\\System32\\tar.exe';
    const r = spawnSync(tarExe, ['-a', '-cf', zip, '-C', tmp, '.'], { timeout: 30000 });
    if (r.status !== 0) throw new Error('zip failed');
    if (Notification.isSupported()) new Notification({ title: 'DSH Desktop', body: '诊断信息已导出：' + zip }).show();
    log('diagnostics exported: ' + zip);
    return { ok: true, file: zip };
  } catch (e) { return { ok: false, message: e.message }; }
}

/* ---------- 0.1.8 全局快捷键 / 应用菜单 / IM 配置 ---------- */
const DESKTOP_SETTINGS_FILE = path.join(DSH_ROOT, 'desktop-settings.json');
function readDesktopSettings() {
  try { return JSON.parse(fs.readFileSync(DESKTOP_SETTINGS_FILE, 'utf8')); } catch (_) { return {}; }
}
function writeDesktopSettings(patch) {
  const s = { ...readDesktopSettings(), ...patch };
  try { fs.writeFileSync(DESKTOP_SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch (_) {}
  return s;
}
let hotkeyRegistered = false;
function applyHotkey(enable) {
  const { globalShortcut } = require('electron');
  try {
    if (enable && !hotkeyRegistered) {
      globalShortcut.register('CommandOrControl+Alt+D', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide(); else showWindow();
      });
      hotkeyRegistered = true;
      log('hotkey Ctrl+Alt+D enabled');
    } else if (!enable && hotkeyRegistered) {
      globalShortcut.unregister('CommandOrControl+Alt+D');
      hotkeyRegistered = false;
    }
  } catch (e) { log('hotkey failed: ' + e.message); }
}
function setupAppMenu() {
  const template = [
    { label: '文件', submenu: [
      { label: '退出', click: () => { shuttingDown = true; stopDsh(); app.quit(); } }
    ]},
    { label: '编辑', role: 'editMenu' },
    { label: '窗口', submenu: [
      { label: '打开工作台', click: () => showWindow() },
      { label: '设置', click: () => openSettings() },
      { label: '技能与插件市场', click: () => openMarket() },
      { label: '内置浏览器', click: () => openBrowser() },
      { role: 'togglefullscreen' }
    ]},
    { label: '帮助', submenu: [
      { label: '欢迎页', click: () => openWelcome() },
      { label: '检查更新', click: () => checkForUpdate(false) },
      { label: '导出诊断信息', click: () => exportDiagnostics() },
      { label: '关于', click: () => showAbout() }
    ]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
// IM 渠道凭据（钉钉）写 ~/.dsh/.env（0.3.0 起统一走 channels 模块）
function setDingtalkCreds(appKey, appSecret) {
  const values = {};
  if (appKey) values.DINGTALK_APP_KEY = appKey;
  if (appSecret) values.DINGTALK_APP_SECRET = appSecret;
  const r = channels.saveChannel('channel-dingtalk', values);
  if (r.ok) rebuildTrayMenu();
  return r;
}

/* ---------- 应用生命周期 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    registerMarketIpc();
    registerWelcomeIpc();
    registerShellBridge();
    // 1) 确保运行时就绪（打包版首次启动解压）
    const ok = await ensureRuntime();
    closeInitWindow();
    if (!ok) {
      dialog.showErrorBox('DSH Desktop', '运行时初始化失败，请查看日志后重新安装。');
      app.quit();
      return;
    }
    // 冒烟测试：不开窗口/托盘/服务，做自检后退出（发布验证用）
    if (SMOKE_TEST) {
      log('=== smoke test start ===');
      const results = { runtime: true };
      try {
        const info = await updater.checkForUpdates(app.getVersion());
        results.update = { ok: info.ok, current: info.current, latest: info.latest, hasUpdate: info.hasUpdate };
        log('smoke update: ' + JSON.stringify(results.update));
      } catch (e) { results.update = { ok: false, error: e.message }; }
      try {
        const cs = channels.channelStatus();
        results.channels = cs.map((c) => c.id + ':' + (c.enabled ? 'on' : c.configured ? 'partial' : 'off'));
        log('smoke channels: ' + results.channels.join(', '));
      } catch (e) { results.channels = ['error:' + e.message]; }
      log('=== smoke test done: ' + JSON.stringify(results) + ' ===');
      console.log('SMOKE_RESULT ' + JSON.stringify(results));
      app.exit(0);
      return;
    }
    // 2) 若已有 dsh 实例在跑，直接用；否则拉起
    if (await isServerUp()) {
      log('existing dsh server found on ' + PORT);
      dshProc = null;
    } else {
      startDsh();
    }
    const up = await waitForServer(120);
    if (!up) {
      dialog.showErrorBox('DSH Desktop', 'dsh 服务启动超时，请查看日志目录。');
    }
    createWindow();
    setupDragDrop(mainWindow);
    applyTheme(mainWindow);
    patchOpenConfigButton(mainWindow);
    injectSidePanel(mainWindow);
    createTray();
    setupAppMenu();
    // 快捷键初始化（设置里保存过则启用）
    if (readDesktopSettings().hotkey) applyHotkey(true);
    // 首次启动：自动启用右键"用 DSH Desktop 打开" + 显示欢迎页
    const welcomeFlag = path.join(DSH_ROOT, '.welcome-shown');
    if (!fs.existsSync(welcomeFlag)) {
      try { fs.writeFileSync(welcomeFlag, new Date().toISOString(), 'utf8'); } catch (_) {}
      if (app.isPackaged && !openWithMenuExists()) setOpenWithMenu(true);
      setTimeout(() => openWelcome(), 1200);
    }
    // 启动自检（静默，仅打包版）
    if (app.isPackaged) setTimeout(() => startupSelfCheck(), 3000);
    // 启动后静默检查更新：有新版本弹系统通知（点击打开设置更新中心）
    setTimeout(async () => {
      const info = await checkForUpdate(true);
      if (info && info.ok && info.hasUpdate && Notification.isSupported()) {
        const n = new Notification({
          title: 'DSH Desktop 有新版本',
          body: `v${info.latest} 可用（当前 v${info.current}），点击打开更新中心`
        });
        n.on('click', () => openSettings());
        n.show();
        log('startup update notify: latest=' + info.latest);
      }
    }, 8000);
    handleOpenFileArg();
  });

  app.on('window-all-closed', () => {
    // 托盘常驻，不退出
  });

  app.on('before-quit', () => {
    shuttingDown = true;
    stopDsh();
  });
}
