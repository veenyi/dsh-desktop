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
const browserServer = require('./browser-server.cjs');
const channels = require('./channels');

const PORT = 3080;
const BASE = `http://127.0.0.1:${PORT}`;

// 引擎版本：从 runtime 核心包动态读取（上游 rc.7 后核心包为 rc.7）
function engineVersion() {
  try {
    return require(path.join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh-agent', 'package.json')).version || '0.1.0-rc.6';
  } catch { return '0.1.0-rc.6'; }
}

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
//  - 打包模式：~/.dsh/runtime/current\（固定目录，避免版本号变化触发每次重解压；
//    仅当归档 zip 更新（时间戳变）时重解压，.dsh-extracted-at 记录解压时间）
const DEV_RUNTIME = path.join(__dirname, '..', 'dsh-runtime');
const RUNTIME_DIR = app.isPackaged ? path.join(RUNTIME_ROOT, 'current') : DEV_RUNTIME;

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
  const target = RUNTIME_DIR + '\\node_modules';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(linkPath)) {
    // 校验桥目标是否仍是当前运行时（跨版本升级后旧桥会失效：
    // 例如升级后仍指向旧 runtime → 新引擎加载不到 IM 渠道插件 → ERR_MODULE_NOT_FOUND → 服务起不来）
    let ok = false;
    try {
      const real = fs.realpathSync(linkPath);
      ok = real.toLowerCase() === target.toLowerCase();
      if (!ok) log(`stale junction target (${real}), rebuilding -> ${target}`);
    } catch (e) {
      log('junction unresolvable (' + e.message + '), rebuilding');
    }
    if (ok) return;
    try {
      fs.rmSync(linkPath, { recursive: true, force: true });
    } catch (e) {
      log('stale junction remove failed: ' + e.message);
      return;
    }
  }
  try {
    fs.symlinkSync(target, linkPath, 'junction');
    log('data/node_modules junction created -> ' + target);
  } catch (e) {
    // 悬空 junction 等残留：existsSync 对悬空链接返回 false，symlinkSync 会报 EEXIST → 删除后重试
    if (e.code === 'EEXIST') {
      try {
        fs.rmSync(linkPath, { recursive: true, force: true });
        fs.symlinkSync(target, linkPath, 'junction');
        log('data/node_modules junction recreated -> ' + target);
        return;
      } catch (e2) { log('junction recreate failed: ' + e2.message); }
    } else {
      log('junction failed (will copy instead): ' + e.message);
    }
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
  // 打包模式：仅当归档 zip 比解压时间新时才重解压（版本号变化不再触发重解压）
  if (app.isPackaged) {
    try {
      const zipMtime = fs.existsSync(ARCHIVE_ZIP) ? fs.statSync(ARCHIVE_ZIP).mtimeMs : 0;
      const marker = path.join(RUNTIME_DIR, '.dsh-extracted-at');
      const extractedAt = fs.existsSync(marker) ? (Number(fs.readFileSync(marker, 'utf8')) || 0) : 0;
      if (fs.existsSync(DSH_ENTRY) && zipMtime <= extractedAt) {
        log('runtime ready: ' + RUNTIME_DIR);
        return true;
      }
      if (fs.existsSync(DSH_ENTRY) && zipMtime > extractedAt) {
        log('runtime archive updated, re-extracting over current');
      }
    } catch (e) { log('runtime marker check: ' + e.message); }
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
    try { fs.writeFileSync(path.join(RUNTIME_DIR, '.dsh-extracted-at'), String(Date.now()), 'utf8'); } catch { /* ignore */ }
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
    try { fs.writeFileSync(path.join(RUNTIME_DIR, '.dsh-extracted-at'), String(Date.now()), 'utf8'); } catch { /* ignore */ }
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
  ipcMain.handle('shell:getVersion', () => ({ version: app.getVersion(), base: BASE, engine: engineVersion() }));
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
  // IM 扫码配置（微信 iLink / Telegram Nous / 企业微信授权）
  const telegramPairings = new Map(); // pairingId -> { poll_token }
  ipcMain.handle('settings:channelQr', async (_e, action, params) => {
    const p = params || {};
    try {
      // ── 微信个人号（腾讯 iLink 官方接口）──
      if (action === 'weixin_qr') {
        const res = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3', { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error('iLink ' + res.status);
        const d = await res.json().catch(() => ({}));
        const qrcode = String(d.qrcode || '').trim();
        if (!qrcode) throw new Error('未取到微信二维码，请检查网络后重试');
        // 用短 scan URL 作为二维码内容（deep link 可能超长导致二维码渲染失败）
        return { ok: true, qrcode, qr_payload: 'https://ilinkai.weixin.qq.com/ilink/bot/scan?qrcode=' + encodeURIComponent(qrcode) };
      }
      if (action === 'weixin_status') {
        const res = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(p.qrcode || ''), { signal: AbortSignal.timeout(35000) });
        if (!res.ok) throw new Error('iLink status ' + res.status);
        const d = await res.json().catch(() => ({}));
        const status = String(d.status || d.result || 'wait').toLowerCase();
        if (status === 'confirmed') {
          const token = String(d.bot_token || '').trim();
          const accountId = String(d.ilink_bot_id || '').trim();
          const baseUrl = String(d.baseurl || '').trim();
          if (token) {
            channels.saveChannel('channel-weixin', { WEIXIN_TOKEN: token, WEIXIN_ACCOUNT_ID: accountId, WEIXIN_BASE_URL: baseUrl });
            return { ok: true, status, account_id: accountId, token: '***' };
          }
        }
        return { ok: true, status };
      }
      // ── Telegram 扫码创建机器人（Nous 托管）──
      if (action === 'telegram_qr') {
        const url = process.env.TELEGRAM_ONBOARDING_URL || 'https://setup.hermes-agent.nousresearch.com';
        const res = await fetch(url + '/v1/telegram/pairings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ bot_name: String(p.botName || 'DSH Desktop Agent').slice(0, 64) }),
          signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) throw new Error('onboarding service ' + res.status);
        const d = await res.json().catch(() => ({}));
        const pairingId = String(d.pairing_id || '').trim();
        const pollToken = String(d.poll_token || '').trim();
        if (!pairingId || !pollToken) throw new Error('incomplete onboarding response');
        telegramPairings.set(pairingId, { poll_token: pollToken });
        return { ok: true, pairing_id: pairingId, qr_payload: String(d.qr_payload || d.deep_link || '').trim() };
      }
      if (action === 'telegram_status') {
        const held = telegramPairings.get(p.pairingId || '');
        if (!held) return { ok: false, error: 'pairing 不存在或已过期，请重新生成二维码' };
        const url = process.env.TELEGRAM_ONBOARDING_URL || 'https://setup.hermes-agent.nousresearch.com';
        const res = await fetch(url + '/v1/telegram/pairings/' + encodeURIComponent(p.pairingId), {
          headers: { 'Authorization': 'Bearer ' + held.poll_token, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) throw new Error('onboarding status ' + res.status);
        const d = await res.json().catch(() => ({}));
        const status = String(d.status || 'waiting').toLowerCase();
        if (status === 'ready' || status === 'claimed') {
          const token = String(d.token || '').trim();
          if (token) {
            telegramPairings.delete(p.pairingId);
            channels.saveChannel('channel-telegram', { TELEGRAM_BOT_TOKEN: token, TELEGRAM_ALLOWED_USERS: '' });
            return { ok: true, status: 'ready', saved: true, bot_username: String(d.bot_username || ''), owner_user_id: String(d.owner_user_id || '') };
          }
        }
        return { ok: true, status };
      }
      if (action === 'telegram_apply') {
        const token = String(p.token || '').trim();
        if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Bot Token 格式不正确');
        const allowed = String(p.allowedUsers || '').trim();
        channels.saveChannel('channel-telegram', { TELEGRAM_BOT_TOKEN: token, TELEGRAM_ALLOWED_USERS: allowed });
        return { ok: true, message: 'Telegram 渠道已配置，重启后生效' };
      }
      // ── 企业微信授权扫码（基于已配置的 CorpID/AgentID/Secret 生成授权二维码）──
      if (action === 'wecom_qr') {
        const env = channels.readEnv();
        const corpId = String(env.WECOM_CORP_ID || '').trim();
        const agentId = String(env.WECOM_AGENT_ID || '').trim();
        const secret = String(env.WECOM_SECRET || '').trim();
        if (!corpId || !agentId || !secret) {
          return { ok: false, error: '请先填写 Corp ID / Agent ID / 应用 Secret，再使用扫码授权' };
        }
        const redirect = 'http://127.0.0.1:3080/api/channels/wecom/qr/callback';
        const url = 'https://open.weixin.qq.com/connect/oauth2/authorize' +
          '?appid=' + encodeURIComponent(corpId) +
          '&redirect_uri=' + encodeURIComponent(redirect) +
          '&response_type=code&scope=snsapi_base' +
          '&agentid=' + encodeURIComponent(agentId) +
          '&state=dsh_wecom_' + Date.now() + '#wechat_redirect';
        return { ok: true, qr_payload: url, warn: '企业微信授权回调需要公网可信域名，本地环境若无法完成授权，请直接手动配置下方凭据' };
      }
      // ── QQ 官方扫码绑定（q.qq.com create_bind_task / poll_bind_result，AES-256-GCM 凭据解密）──
      if (action === 'qq_qr_create') {
        const key = String(p.key || '').trim();
        if (!key) return { ok: false, error: '缺少绑定密钥 key' };
        const portal = process.env.QQ_PORTAL_HOST || 'q.qq.com';
        const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'DSH-Desktop/0.3.9 (QQBot onboard)' };
        const r = await fetch(`https://${portal}/lite/create_bind_task`, {
          method: 'POST', headers, body: JSON.stringify({ key }), signal: AbortSignal.timeout(15000)
        });
        if (!r.ok) throw new Error('create_bind_task HTTP ' + r.status);
        const d = await r.json().catch(() => ({}));
        if (d.retcode !== 0) throw new Error(d.msg || 'create_bind_task failed');
        const taskId = (d.data || {}).task_id;
        if (!taskId) throw new Error('create_bind_task 未返回 task_id');
        const qrPayload = 'https://q.qq.com/qqbot/openclaw/connect.html?task_id=' + encodeURIComponent(taskId) + '&_wv=2&source=hermes';
        return { ok: true, task_id: taskId, qr_payload: qrPayload };
      }
      if (action === 'qq_qr_poll') {
        const taskId = String(p.task_id || '').trim();
        if (!taskId) return { ok: false, error: '缺少 task_id' };
        const portal = process.env.QQ_PORTAL_HOST || 'q.qq.com';
        const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'DSH-Desktop/0.3.9 (QQBot onboard)' };
        const r = await fetch(`https://${portal}/lite/poll_bind_result`, {
          method: 'POST', headers, body: JSON.stringify({ task_id: taskId }), signal: AbortSignal.timeout(15000)
        });
        if (!r.ok) throw new Error('poll_bind_result HTTP ' + r.status);
        const d = await r.json().catch(() => ({}));
        if (d.retcode !== 0) throw new Error(d.msg || 'poll_bind_result failed');
        const dd = d.data || {};
        const st = Number(dd.status || 0);
        const status = st === 2 ? 'completed' : st === 3 ? 'expired' : 'pending';
        return { ok: true, status, app_id: String(dd.bot_appid || ''), encrypt_secret: String(dd.bot_encrypt_secret || ''), user_openid: String(dd.user_openid || '') };
      }
      return { ok: false, error: '未知扫码动作: ' + action };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
  // QQ 扫码凭据解密（AES-256-GCM：IV(12) ‖ ciphertext ‖ AuthTag(16)，base64 编码）
  ipcMain.handle('decrypt:qqSecret', (_e, encryptedB64, keyB64) => {
    try {
      const nodeCrypto = require('node:crypto');
      const key = Buffer.from(String(keyB64 || ''), 'base64');
      const raw = Buffer.from(String(encryptedB64 || ''), 'base64');
      if (key.length !== 32) throw new Error('密钥长度不正确（需 32 字节 AES-256）');
      if (raw.length < 29) throw new Error('密文过短');
      const iv = raw.subarray(0, 12);
      const authTag = raw.subarray(raw.length - 16);
      const ciphertext = raw.subarray(12, raw.length - 16);
      const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plain.toString('utf8');
    } catch (e) {
      throw new Error('解密失败: ' + String(e?.message || e));
    }
  });
  // ── 语音识别（本地 whisper.cpp，离线可用）──
  ipcMain.handle('shell:asr', async (_e, wavB64) => {
    const tmpWav = path.join(app.getPath('temp'), 'dsh-asr-' + Date.now() + '.wav');
    try {
      if (!wavB64 || wavB64.length < 2000) return { ok: false, error: '音频太短，请再说一次' };
      fs.writeFileSync(tmpWav, Buffer.from(wavB64, 'base64'));
      const whisperDir = app.isPackaged
        ? path.join(process.resourcesPath, 'whisper')
        : path.join(__dirname, '..', '..', 'whisper');
      const cli = path.join(whisperDir, 'whisper-cli.exe');
      const model = path.join(whisperDir, 'ggml-base.bin');
      if (!fs.existsSync(cli) || !fs.existsSync(model)) return { ok: false, error: 'whisper 组件缺失（whisper-cli.exe / ggml-base.bin）' };
      const r = spawnSync(cli, ['-m', model, '-f', tmpWav, '-l', 'zh', '-otxt', '-np', '--no-prints'], { timeout: 90000, encoding: 'utf8' });
      const outTxt = tmpWav + '.txt';
      let text = '';
      if (fs.existsSync(outTxt)) text = fs.readFileSync(outTxt, 'utf8').trim();
      if (!text && r.stdout) text = String(r.stdout).trim();
      return { ok: !!text, text: text || (r.stderr || '').slice(0, 200) };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      try { fs.unlinkSync(tmpWav); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpWav + '.txt'); } catch { /* ignore */ }
    }
  });
  // ── 多功能加号：会话列表 / 定时任务 ──
  ipcMain.handle('shell:listSessions', async () => {
    try {
      const res = await fetch('http://127.0.0.1:3080/api/session.list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 't' + Date.now(), method: 'session.list', payload: {} })
      });
      const d = await res.json().catch(() => ({}));
      const items = (d.result?.value?.items) || [];
      return items.map((it) => ({
        sessionId: it.sessionId,
        title: String(it.projections?.values?.title || it.title || it.sessionId || '').slice(0, 40),
        workspace: String(it.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '',
        mtime: it.updatedAt || 0
      })).sort((a, b) => b.mtime - a.mtime).slice(0, 50);
    } catch { return []; }
  });
  const SCHED_FILE = path.join(DATA_DIR, 'scheduled-tasks.json');
  function readSched() { try { return JSON.parse(fs.readFileSync(SCHED_FILE, 'utf8')) || []; } catch { return []; } }
  function writeSched(tasks) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SCHED_FILE, JSON.stringify(tasks, null, 2), 'utf8'); }
  ipcMain.handle('shell:listScheduledTasks', () => readSched());
  ipcMain.handle('shell:saveScheduledTask', (_e, task) => {
    const tasks = readSched();
    tasks.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...(task || {}), createdAt: Date.now() });
    writeSched(tasks);
    return { ok: true, tasks };
  });
  ipcMain.handle('shell:deleteScheduledTask', (_e, id) => {
    writeSched(readSched().filter((t) => t.id !== id));
    return { ok: true, tasks: readSched() };
  });
  // 定时任务调度器（每 30s 检查，到点系统通知 + 打开主窗口）
  setInterval(() => {
    try {
      const now = Date.now();
      const tasks = readSched();
      const due = tasks.filter((t) => t.nextRunAt && t.nextRunAt <= now);
      if (!due.length) return;
      const keep = tasks.filter((t) => !(t.nextRunAt && t.nextRunAt <= now));
      for (const t of due) {
        try {
          new Notification({ title: '⏰ DSH 定时任务', body: String(t.text || '定时任务到点') }).show();
        } catch { /* 通知失败不阻塞 */ }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          try { mainWindow.webContents.send('scheduled:task', t); } catch { /* ignore */ }
        }
        if (t.repeat) { t.nextRunAt = now + Number(t.repeat); keep.push(t); }
        log('scheduled task fired: ' + String(t.text || '').slice(0, 40));
      }
      writeSched(keep);
    } catch { /* ignore */ }
  }, 30000);
  // 设置窗口数据
  ipcMain.handle('settings:get', () => ({
    version: app.getVersion(),
    engine: engineVersion(),
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
  ipcMain.handle('shell:browserChat', async (_e, payload) => {
    try {
      const body = JSON.stringify({ message: (payload&&payload.message)||'', aiEnabled: !!(payload&&payload.aiEnabled), continue: !!(payload&&payload.continue) });
      const r = await new Promise((resolve, reject) => {
        const req = http.request({ host:'127.0.0.1', port:3080, path:'/api/browser/chat', method:'POST', headers:{ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body), 'x-browser-token': browserServer.TOKEN } }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){reject(new Error('dsh 响应解析失败: '+d.slice(0,200)))}}); });
        req.on('error', reject); req.write(body); req.end();
      });
      return r;
    } catch(e) { return { ok:false, error: 'browserChat: ' + e.message }; }
  });
  ipcMain.handle('shell:browserAction', async (_e, name, args) => {
    try {
      const method = ['navigate','click','type','scroll','key','wait'].includes(name) ? 'POST' : 'GET';
      const body = JSON.stringify(args||{});
      const r = await new Promise((resolve, reject) => {
        const req = http.request({ host:'127.0.0.1', port:3082, path:'/browser/'+name, method, headers:{ 'Content-Type':'application/json', 'x-browser-token': browserServer.TOKEN, ...(method==='POST'?{'Content-Length':Buffer.byteLength(body)}:{}) } }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){reject(new Error('响应解析失败'))}}); });
        req.on('error', reject); if(method==='POST') req.write(body); req.end();
      });
      return r;
    } catch(e) { return { ok:false, error: 'browserAction: ' + e.message }; }
  });
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
/* 三栏集成：dsh 内容区给右侧面板让位（不遮挡，正常流收窄）
   注意：面板 z-index 必须低于 dsh 弹窗（overlay=1000），保证设置等弹窗浮最上层 */
body { padding-right: 272px !important; transition: padding-right .15s ease; }
body.dshp-collapsed-body { padding-right: 0 !important; }
#${NS}{position:fixed;top:0;right:0;bottom:0;width:272px;z-index:900;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base,#fff);border-left:1px solid var(--dsw-alias-border-l1,#e5e7eb);
  color:var(--dsw-alias-label-primary,#1f2328);transition:width .15s ease,border .15s ease;}
#${NS} *{box-sizing:border-box;}
#${NS} .dshp-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);}
#${NS} .dshp-title{font-size:14px;font-weight:600;}
#${NS} .dshp-fold{border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary,#656d76);font-size:14px;padding:2px 6px;border-radius:6px;}
#${NS} .dshp-fold:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5);}
#${NS} .dshp-body{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px;}
#${NS} .dshp-sec{background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:10px 12px;}
#${NS} .dshp-sec h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#656d76);display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;}
#${NS} .dshp-sec h4::after{content:'▾';margin-left:auto;font-size:10px;color:var(--dsw-alias-label-caption,#8b949e);}
#${NS} .dshp-sec.collapsed h4::after{content:'▸';}
#${NS} .dshp-sec.collapsed > *:not(h4){display:none;}
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
/* 千问式折叠：完全收起（宽度 0），浮动展开按钮常驻右上角 */
#${NS}.dshp-collapsed{width:0;border-left:none;overflow:hidden;}
#${NS}.dshp-collapsed .dshp-head{padding:0;border-bottom:none;}
#${NS}.dshp-collapsed .dshp-body,#${NS}.dshp-collapsed .dshp-mini{display:none;}
#dsh-side-expand{position:fixed;top:64px;right:0;z-index:901;width:30px;height:30px;border:none;border-radius:8px 0 0 8px;
  background:var(--dsw-alias-bg-layer-1,#f0f2f5);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-right:none;
  cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary,#656d76);display:none;align-items:center;justify-content:center;
  box-shadow:-2px 2px 8px rgba(0,0,0,.06);}
#dsh-side-expand:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5);color:var(--dsw-alias-label-primary,#1f2328);}
#dsh-side-expand.show{display:flex;}
\`;
  document.head.appendChild(style);
  const panel = document.createElement('aside');
  panel.id = '${NS}';
  panel.innerHTML = \`
<div class="dshp-head"><span class="dshp-title">任务监控</span><button class="dshp-fold" title="折叠">»</button></div>
<div class="dshp-body">
  <div class="dshp-sec"><h4><span class="dshp-dot"></span>💡 智能建议</h4><div data-part="suggestions"><div class="dshp-empty">分析中…</div></div></div>
  <div class="dshp-sec"><h4><span class="dshp-dot"></span>产物</h4><div data-part="artifacts"><div class="dshp-empty">加载中…</div></div><button class="dshp-btn" data-act="workspace">打开工作区目录</button></div>
  <div class="dshp-sec"><h4><span class="dshp-dot"></span>快捷操作</h4>
    <div class="dshp-item" data-act="browser" style="cursor:pointer;"><span>🌐</span><span class="nm">内置浏览器</span></div>
    <div class="dshp-item" data-act="config" style="cursor:pointer;"><span>⚙️</span><span class="nm">打开配置文件</span></div>
    <div class="dshp-item" data-act="data" style="cursor:pointer;"><span>📁</span><span class="nm">数据目录 ~/.dsh</span></div>
    <div class="dshp-item" data-act="logs" style="cursor:pointer;"><span>🗒️</span><span class="nm">日志目录</span></div>
    <div class="dshp-item" data-act="settings" style="cursor:pointer;"><span>🛠️</span><span class="nm">设置</span></div>
    <div class="dshp-item" data-act="welcome" style="cursor:pointer;"><span>🏠</span><span class="nm">欢迎页</span></div>
  </div>
  <div class="dshp-sec"><h4><span class="dshp-dot"></span>服务状态</h4><div data-part="status"><div class="dshp-empty">检测中…</div></div></div>
</div>\`;
  document.body.appendChild(panel);
  // 面板事件隔离：仅拦截点击面板自身空白区域（防止穿透联动 dsh），子元素（折叠按钮等）正常交互
  panel.addEventListener('click', (e) => { if (e.target === panel) e.stopPropagation(); }, true);
  panel.addEventListener('mousedown', (e) => { if (e.target === panel) e.stopPropagation(); }, true);
  // 千问式浮动展开按钮（折叠时显示）
  const expandBtn = document.createElement('button');
  expandBtn.id = 'dsh-side-expand';
  expandBtn.title = '展开任务监控';
  expandBtn.textContent = '«';
  document.body.appendChild(expandBtn);

  const fold = panel.querySelector('.dshp-fold');
  const syncPanelState = () => {
    const collapsed = panel.classList.contains('dshp-collapsed');
    document.body.classList.toggle('dshp-collapsed-body', collapsed);
    fold.textContent = collapsed ? '«' : '»';
    fold.title = collapsed ? '展开' : '折叠';
    expandBtn.classList.toggle('show', collapsed);
    expandBtn.textContent = collapsed ? '«' : '»';
    // 左右面板互不影响：右侧折叠/展开后若 dsh 左侧栏被联动改变，自动恢复
    const sideBtn = () => document.querySelector('[aria-label="收起侧边栏"], [aria-label="展开侧边栏"]');
    const before = sideBtn() ? sideBtn().getAttribute('aria-label') : null;
    setTimeout(() => {
      try {
        const now = sideBtn() ? sideBtn().getAttribute('aria-label') : null;
        if (before !== null && now !== null && now !== before) {
          const b = sideBtn();
          if (b) b.click();
        }
      } catch { /* ignore */ }
    }, 350);
  };
  fold.addEventListener('click', () => {
    panel.classList.toggle('dshp-collapsed');
    syncPanelState();
  });
  expandBtn.addEventListener('click', () => {
    panel.classList.remove('dshp-collapsed');
    syncPanelState();
  });
  // 各分区标题点击折叠/展开（产物/工作区/技能/快捷操作/服务状态）
  panel.querySelectorAll('.dshp-sec h4').forEach((h) => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  });

  // ── 智能建议：基于最近会话 + 关键词方向 + 功能提示 ──
  const getTextarea = () => document.querySelector('textarea[data-phase], textarea[class*="input"], [data-input-scroll] textarea');
  const insertToInput = (txt) => {
    const ta = getTextarea();
    if (!ta) return false;
    ta.focus();
    const start = ta.selectionStart || ta.value.length;
    ta.value = ta.value.slice(0, start) + txt + ta.value.slice(ta.selectionEnd || ta.value.length);
    ta.selectionStart = ta.selectionEnd = start + txt.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  window.__dshShell.listSessions().then((sessions) => {
    const box = panel.querySelector('[data-part="suggestions"]');
    if (!box) return;
    const sugs = [];
    const list = (sessions || []).slice(0, 6);
    if (list.length) {
      const recent = list.slice(0, 2);
      recent.forEach((s) => sugs.push({ icon: '🔄', text: '继续：' + (s.title || '会话').slice(0, 16), act: 'ref:' + (s.sessionId || '') }));
    }
    const all = list.map((s) => s.title || '').join(' ');
    if (/打包|部署|FPK|package|deploy|release|dist/i.test(all)) sugs.push({ icon: '🎯', text: '最近在做打包部署，试试 /goal 设定目标', act: 'cmd:goal' });
    if (/IM|渠道|微信|QQ|钉钉|飞书|telegram|discord/i.test(all)) sugs.push({ icon: '📡', text: 'IM 渠道支持扫码配置：+ → IM 频道', act: 'settings' });
    if (/UI|界面|皮肤|样式|布局|美化/i.test(all)) sugs.push({ icon: '🎨', text: '试试皮肤中心换皮肤：设置 → 皮肤中心', act: 'settings' });
    if (/语音|录音|识别/i.test(all)) sugs.push({ icon: '🎙️', text: '语音输入已支持：点输入框旁麦克风', act: 'none' });
    sugs.push({ icon: '⏰', text: '可添加定时任务：+ → 添加定时任务', act: 'none' });
    sugs.push({ icon: '⌘', text: '快捷命令：⚡ 或输入 / 查看', act: 'none' });
    box.innerHTML = sugs.slice(0, 5).map((it) => '<div class="dshp-item" data-sug="' + it.act + '" style="cursor:pointer;"><span>' + it.icon + '</span><span class="nm">' + it.text + '</span></div>').join('');
    box.querySelectorAll('[data-sug]').forEach((el) => {
      el.addEventListener('click', () => {
        const act = el.dataset.sug;
        if (act.indexOf('ref:') === 0) {
          insertToInput('[引用会话：' + act.slice(4) + '] 请结合该会话的上下文继续：');
        } else if (act === 'settings') window.__dshShell.openSettings();
        else if (act.indexOf('cmd:') === 0) { insertToInput('/' + act.slice(4) + ' '); }
      });
    });
  });

  // 工作区 / 已安装技能区块已按用户要求移除
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
  // IM 渠道已移至左侧「IM 频道」入口（设置窗口配置），此处不再渲染
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

/** 注入：设置→模型 添加模型时，输入模型 ID 自动关联填充显示名称 */
function injectModelNameAutoFill(win) {
  const js = `
(() => {
  if (window.__dshModelAutoFill) return;
  window.__dshModelAutoFill = true;
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.value || t.value.trim() === '') return;
    if ((t.placeholder === '模型 ID' || t.getAttribute('aria-label') === '模型 ID' || /模型.?ID/.test(t.getAttribute('placeholder') || '')) && !t.dataset.dshAutoFilled) {
      const form = t.closest('[class*="modal"], [class*="dialog"], [class*="panel"], form') || t.parentElement?.parentElement;
      const nameInput = form ? form.querySelector('input[placeholder="显示名称"], input[placeholder*="留空时使用模型"]') : null;
      if (nameInput && !nameInput.value.trim()) {
        try {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(nameInput, t.value.trim());
          nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        } catch { /* ignore */ }
      }
    }
  }, true);
})();
`;
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(js, true).catch(() => {});
  });
}
/** 左侧导航注入：插件模式 / IM 频道 独立菜单按钮（对齐 dsh sidebar 风格） */
function injectLeftNav(win) {
  const js = `
(() => {
  if (document.getElementById('dsh-left-nav')) return;
  const style = document.createElement('style');
  style.textContent = \`
#dsh-left-nav{padding:6px 8px;display:flex;flex-direction:column;gap:2px;flex:none;}
#dsh-left-nav .dshln-btn{display:flex;align-items:center;gap:10px;width:100%;padding:7px 8px;border:none;background:transparent;border-radius:10px;cursor:pointer;font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328);transition:background .15s;}
#dsh-left-nav .dshln-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5);}
#dsh-left-nav .dshln-btn .ic{width:28px;height:28px;flex:none;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f0f2f5);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#656d76);}
#dsh-left-nav .dshln-btn:hover .ic{background:var(--dsw-alias-interactive-bg-hover,#eef1f5);color:var(--dsw-alias-label-primary,#1f2328);}
#dsh-left-nav .dshln-btn .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* 侧栏折叠（窄图标列）时隐藏自定义导航按钮，避免图标错位 */
[data-sidebar-collapsed] #dsh-left-nav{display:none !important;}
\`;
  document.head.appendChild(style);
  const nav = document.createElement('div');
  nav.id = 'dsh-left-nav';
  const ICON_PLUGIN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/></svg>';
  const ICON_CHANNEL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  nav.innerHTML = '<button class="dshln-btn" data-act="market"><span class="ic">' + ICON_PLUGIN + '</span><span class="nm">插件模式</span></button>' +
                  '<button class="dshln-btn" data-act="channels"><span class="ic">' + ICON_CHANNEL + '</span><span class="nm">IM 频道</span></button>';
  nav.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'market') window.__dshShell && window.__dshShell.openExternal('https://github.com/topics/dsh-plugin');
    else if (b.dataset.act === 'channels') window.__dshShell && window.__dshShell.openSettings();
  });
  // 侧栏折叠（窄图标列）时隐藏自定义按钮，避免图标错位
  const syncCollapse = () => {
    const collapsed = document.querySelector('[data-sidebar-collapsed], [data-sidebar-collapsed="true"]');
    nav.style.display = collapsed ? 'none' : '';
  };
  syncCollapse();
  const mo2 = new MutationObserver(syncCollapse);
  mo2.observe(document.body, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
  const tryMount = () => {
    if (document.body.contains(nav)) return true;
    const newBtn = document.querySelector('[class*="newSession"], [class*="NewSession"]');
    const anchor = newBtn ? newBtn.parentElement : document.querySelector('aside, [class*="sidebarCol"], [class*="Sidebar"]');
    if (anchor) { anchor.insertBefore(nav, newBtn ? newBtn.nextSibling : anchor.firstChild); return true; }
    return false;
  };
  if (!tryMount()) {
    const mo = new MutationObserver(() => { if (tryMount()) mo.disconnect(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }
})();
`;
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(js, true).catch(() => {});
  });
}

/** 输入区注入：语音输入按钮 + 命令气泡菜单（对齐 composer 风格） */
function injectComposerTools(win) {
  const js = `
(() => {
  if (document.getElementById('dsh-voice-btn')) return;
  const style = document.createElement('style');
  style.textContent = \`
.dsct-btn{width:30px;height:30px;border:none;background:transparent;border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#656d76);transition:background .15s;}
.dsct-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5);}
.dsct-btn.rec{background:var(--dsw-alias-state-error-primary,#d1242f);color:#fff;animation:dshpulse 1.2s infinite;}
#dsh-cmd-btn{position:relative;}
#dsh-cmd-quick{position:relative;}
@keyframes dshpulse{0%,100%{opacity:1}50%{opacity:.5}}
#dsh-multi-pop,#dsh-quick-pop{position:absolute;bottom:36px;left:0;min-width:210px;background:#fff;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;box-shadow:var(--dsw-shadow-lv2,0 4px 16px rgba(0,0,0,.12));padding:6px;z-index:9999;}
#dsh-multi-pop[hidden],#dsh-quick-pop[hidden],#dsh-multi-modal[hidden]{display:none;}
.dshmp-title{font-size:11px;color:var(--dsw-alias-label-caption,#8b949e);padding:4px 10px 6px;font-weight:600;}
.dshmp-item{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:8px 10px;border:none;background:transparent;border-radius:8px;cursor:pointer;font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328);}
.dshmp-item:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f5);}
#dsh-multi-modal{position:fixed;inset:0;background:rgba(20,24,35,.45);display:flex;align-items:center;justify-content:center;z-index:9999;}
#dsh-multi-modal .dshmm-box{background:var(--dsw-alias-bg-base,#fff);border-radius:14px;width:400px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.18);}
#dsh-multi-modal .dshmm-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);}
#dsh-multi-modal .dshmm-head b{font-size:14px;}
#dsh-multi-modal .dshmm-close{border:none;background:transparent;cursor:pointer;font-size:14px;color:var(--dsw-alias-label-tertiary,#656d76);}
#dsh-multi-modal .dshmm-body{padding:12px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;}
#dsh-multi-modal .dshmm-item{display:flex;flex-direction:column;gap:2px;text-align:left;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-2,#fff);border-radius:10px;cursor:pointer;font-family:inherit;}
#dsh-multi-modal .dshmm-item:hover{border-color:var(--dsw-alias-border-l3,#cbd5e1);background:var(--dsw-alias-interactive-bg-hover,#eef1f5);}
#dsh-multi-modal .dshmm-item b{font-size:13px;color:var(--dsw-alias-label-primary,#1f2328);}
#dsh-multi-modal .dshmm-item small{font-size:11px;color:var(--dsw-alias-label-caption,#8b949e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
\`;
  document.head.appendChild(style);
  const getTextarea = () => document.querySelector('textarea[data-phase], textarea[class*="input"], [data-input-scroll] textarea');
  const insertText = (txt) => {
    const ta = getTextarea();
    if (!ta) return;
    ta.focus();
    const start = ta.selectionStart || ta.value.length;
    ta.value = ta.value.slice(0, start) + txt + ta.value.slice(ta.selectionEnd || ta.value.length);
    ta.selectionStart = ta.selectionEnd = start + txt.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // ── 多功能加号 ➕：附件 / 引用会话 / 定时任务 / 命令菜单 ──
  const cmdBtn = document.createElement('button');
  cmdBtn.className = 'dsct-btn';
  cmdBtn.id = 'dsh-cmd-btn';
  cmdBtn.title = '更多功能（附件/引用会话/定时任务）';
  cmdBtn.textContent = '+';
  cmdBtn.style.fontSize = '16px';
  cmdBtn.style.fontWeight = '600';
  // ── 快捷命令按钮 ⚡：弹出与多功能菜单同款卡片（官方命令列表）──
  const cmdQuick = document.createElement('button');
  cmdQuick.className = 'dsct-btn';
  cmdQuick.id = 'dsh-cmd-quick';
  cmdQuick.title = '快捷命令（/model、/goal 等）';
  cmdQuick.textContent = '⚡';
  cmdQuick.style.fontSize = '14px';
  // 同款卡片菜单（与多功能菜单样式一致）
  const quickPop = document.createElement('div');
  quickPop.id = 'dsh-quick-pop';
  quickPop.className = 'dshmp-card';
  quickPop.hidden = true;
  quickPop.innerHTML =
    '<div class="dshmp-title">快捷命令</div>' +
    [
      ['compact', '压缩较早的对话历史'],
      ['export', '将会话日志下载为 ZIP 压缩包'],
      ['feedback', '记录关于此会话的反馈'],
      ['goal', '设置或查看长任务的执行目标'],
      ['permission', '切换权限预设（沙箱模式 + 审批策略）'],
      ['plan', '进入或退出计划模式'],
      ['model', '选择本会话使用的模型']
    ].map(([c, d]) => '<button class="dshmp-item dshmp-cmd" data-cmd="' + c + '"><b style="width:72px;flex:none;font-weight:600;">' + c + '</b><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#656d76);">' + d + '</span></button>').join('');
  cmdQuick.appendChild(quickPop);
  cmdQuick.addEventListener('click', (e) => {
    e.stopPropagation();
    quickPop.hidden = !quickPop.hidden;
  });
  quickPop.addEventListener('click', (e) => {
    const it = e.target.closest('[data-cmd]');
    if (!it) return;
    quickPop.hidden = true;
    const ta = getTextarea();
    if (ta) {
      ta.focus();
      ta.value = (ta.value || '') + '/' + it.dataset.cmd + ' ';
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  // 多功能菜单面板
  const pop = document.createElement('div');
  pop.id = 'dsh-multi-pop';
  pop.hidden = true;
  pop.innerHTML =
    '<div class="dshmp-title">多功能</div>' +
    '<button class="dshmp-item" data-act="attach"><span>📎</span><span>添加附件</span></button>' +
    '<button class="dshmp-item" data-act="ref"><span>💬</span><span>引用会话</span></button>' +
    '<button class="dshmp-item" data-act="sched"><span>⏰</span><span>添加定时任务</span></button>' +
    '<button class="dshmp-item" data-act="cmd"><span>⌘</span><span>命令菜单</span></button>' +
    '<div id="dshmp-pop" hidden></div>';
  cmdBtn.appendChild(pop); // 挂到 ⚡ 按钮内，菜单相对按钮弹出（勿挂 body，会定位到视口左下角）
  // 隐藏 file input（添加附件用）
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = 'image/*,.pdf,.txt,.md,.doc,.docx,.xls,.xlsx,.csv,.json,.js,.py,.zip';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);
  // 通用弹窗容器（会话列表 / 定时任务表单）
  const modal = document.createElement('div');
  modal.id = 'dsh-multi-modal';
  modal.hidden = true;
  modal.innerHTML = '<div class="dshmm-box"><div class="dshmm-head"><b id="dshmm-title"></b><button class="dshmm-close">✕</button></div><div class="dshmm-body" id="dshmm-body"></div></div>';
  document.body.appendChild(modal);
  const insertText2 = (txt) => {
    const ta = getTextarea();
    if (!ta) return;
    ta.focus();
    const start = ta.selectionStart || ta.value.length;
    ta.value = ta.value.slice(0, start) + txt + ta.value.slice(ta.selectionEnd || ta.value.length);
    ta.selectionStart = ta.selectionEnd = start + txt.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // 附件：file input → drop 到输入区（触发官方附件 intake）
  const triggerAttach = () => {
    fileInput.value = '';
    fileInput.click();
  };
  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    if (!files || !files.length) return;
    try {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 1, clientY: 1 }));
    } catch (e) {
      const names = [...files].map((f) => f.name).join('、');
      insertText2('[附件] ' + names + ' ');
    }
  });
  // 引用会话：列表弹窗
  const openRefModal = async () => {
    const body = document.getElementById('dshmm-body');
    document.getElementById('dshmm-title').textContent = '引用工作区会话';
    body.innerHTML = '<div style="padding:8px;color:var(--dsw-alias-label-secondary,#656d76);font-size:12px;">加载中…</div>';
    modal.hidden = false;
    try {
      const sessions = (window.__dshShell && await window.__dshShell.listSessions()) || [];
      if (!sessions.length) { body.innerHTML = '<div style="padding:14px;color:var(--dsw-alias-label-secondary,#656d76);font-size:12px;">暂无历史会话</div>'; return; }
      body.innerHTML = sessions.map((s, i) =>
        '<button class="dshmm-item" data-i="' + i + '"><b>' + (s.title || '会话').slice(0, 26) + '</b><small>' + (s.workspace ? '工作区：' + s.workspace + ' · ' : '') + (s.sessionId || '').slice(0, 14) + '…</small></button>'
      ).join('');
      body.querySelectorAll('.dshmm-item').forEach((el) => el.addEventListener('click', () => {
        const s = sessions[Number(el.dataset.i)];
        insertText2('[引用会话：' + (s.title || '会话').slice(0, 26) + '（工作区 ' + (s.workspace || '?') + '，sessionId ' + (s.sessionId || '') + '）] 请结合该会话的上下文继续：');
        modal.hidden = true;
      }));
    } catch (e) { body.innerHTML = '<div style="padding:14px;color:var(--dsw-alias-state-error-primary,#d1242f);font-size:12px;">加载失败：' + e.message + '</div>'; }
  };
  // 定时任务：表单弹窗
  const openSchedModal = async () => {
    const body = document.getElementById('dshmm-body');
    document.getElementById('dshmm-title').textContent = '添加定时任务';
    body.innerHTML =
      '<div style="display:flex;flex-direction:column;gap:10px;padding:6px 2px;">' +
      '<div style="font-size:12px;color:var(--dsw-alias-label-secondary,#656d76);">任务内容（到点提醒）：</div>' +
      '<input id="dshsched-text" placeholder="例如：每天 9 点提醒我整理日报" style="padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;font-size:13px;outline:none;">' +
      '<div style="font-size:12px;color:var(--dsw-alias-label-secondary,#656d76);">执行时间（unix 毫秒，可选）：</div>' +
      '<input id="dshsched-at" type="number" placeholder="留空则 1 分钟后执行" style="padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;font-size:13px;outline:none;">' +
      '<div style="font-size:12px;color:var(--dsw-alias-label-secondary,#656d76);">重复间隔（毫秒，0=单次）：</div>' +
      '<input id="dshsched-repeat" type="number" value="0" placeholder="0 = 只执行一次" style="padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;font-size:13px;outline:none;">' +
      '<button class="dshmp-item" id="dshsched-save" style="justify-content:center;background:var(--dsw-alias-button-primary-fill,#4D6BFE);color:#fff;">保存任务</button>' +
      '<div id="dshsched-list" style="border-top:1px solid var(--dsw-alias-border-l1,#e5e7eb);padding-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#656d76);"></div>' +
      '</div>';
    modal.hidden = false;
    const renderSched = async () => {
      try {
        const tasks = (window.__dshShell && await window.__dshShell.listScheduledTasks()) || [];
        const box = document.getElementById('dshsched-list');
        if (!box) return;
        box.innerHTML = tasks.length ? '已设任务：<br>' + tasks.map((t, i) =>
          '<span style="display:flex;justify-content:space-between;gap:8px;margin-top:4px;">' +
          '<span>' + String(t.text || '').slice(0, 24) + '</span>' +
          '<a href="javascript:void 0" data-del="' + t.id + '" style="color:var(--dsw-alias-state-error-primary,#d1242f);">删除</a></span>'
        ).join('') : '暂无定时任务';
        box.querySelectorAll('[data-del]').forEach((a) => a.addEventListener('click', async () => {
          await window.__dshShell.deleteScheduledTask(a.dataset.del);
          renderSched();
        }));
      } catch { /* ignore */ }
    };
    renderSched();
    document.getElementById('dshsched-save').addEventListener('click', async () => {
      const text = document.getElementById('dshsched-text').value.trim();
      if (!text) { alert('请输入任务内容'); return; }
      const at = Number(document.getElementById('dshsched-at').value);
      const repeat = Number(document.getElementById('dshsched-repeat').value) || 0;
      const nextRunAt = at > Date.now() ? at : Date.now() + 60000;
      await window.__dshShell.saveScheduledTask({ text, nextRunAt, repeat });
      modal.hidden = true;
      alert('定时任务已保存');
    });
  };
  cmdBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
  });
  pop.addEventListener('click', async (e) => {
    const it = e.target.closest('[data-act]');
    if (!it) return;
    const act = it.dataset.act;
    pop.hidden = true;
    if (act === 'cmd') { cmdQuick.click(); }
    else if (act === 'attach') triggerAttach();
    else if (act === 'ref') openRefModal();
    else if (act === 'sched') openSchedModal();
  });
  document.addEventListener('click', (e) => {
    if (!cmdBtn.contains(e.target) && !pop.contains(e.target) && !modal.contains(e.target)) { pop.hidden = true; }
  });
  modal.querySelector('.dshmm-close').addEventListener('click', () => { modal.hidden = true; });
  // ── 语音按钮 🎙️：放在发送按钮旁（右侧 trailing 区），本地 whisper 识别 ──
  const voiceBtn = document.createElement('button');
  voiceBtn.className = 'dsct-btn';
  voiceBtn.id = 'dsh-voice-btn';
  voiceBtn.title = '语音输入（本地识别）';
  voiceBtn.textContent = '🎙️';
  let mediaRec = null;
  let mediaChunks = [];
  let mediaStream = null;
  // webm/opus → 16k 单声道 wav（whisper 需要）
  const toWavB64 = async (blob) => {
    const ab = await blob.arrayBuffer();
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuf = await actx.decodeAudioData(ab);
    const targetRate = 16000;
    const srcRate = audioBuf.sampleRate;
    const samples = audioBuf.getChannelData(0);
    // 重采样到 16k
    const ratio = srcRate / targetRate;
    const outLen = Math.ceil(samples.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) out[i] = samples[Math.min(Math.floor(i * ratio), samples.length - 1)];
    // 编码 WAV 16-bit PCM
    const buf = new ArrayBuffer(44 + out.length * 2);
    const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + out.length * 2, true); ws(8, 'WAVE');
    ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, targetRate, true); v.setUint32(28, targetRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, out.length * 2, true);
    for (let i = 0; i < out.length; i++) { const s = Math.max(-1, Math.min(1, out[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true); }
    await actx.close();
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  };
  voiceBtn.addEventListener('click', async () => {
    if (mediaRec && mediaRec.state === 'recording') {
      mediaRec.stop();
      voiceBtn.classList.remove('rec');
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaChunks = [];
      mediaRec = new MediaRecorder(mediaStream);
      mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) mediaChunks.push(e.data); };
      mediaRec.onstop = async () => {
        try { mediaStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
        voiceBtn.textContent = '⏳';
        try {
          const blob = new Blob(mediaChunks, { type: 'audio/webm' });
          if (!blob.size || blob.size < 2000) {
            alert('录音太短了，请按住 🎙️ 说话至少 1 秒');
            voiceBtn.textContent = '🎙️';
            voiceBtn.classList.remove('rec');
            return;
          }
          const wavB64 = await toWavB64(blob);
          if (!wavB64 || wavB64.length < 2000) {
            alert('音频处理失败（录音过短），请重试，说话 2 秒以上');
            voiceBtn.textContent = '🎙️';
            voiceBtn.classList.remove('rec');
            return;
          }
          const res = (window.__dshShell && await window.__dshShell.asr(wavB64)) || {};
          if (res.ok && res.text) insertText(res.text);
          else alert('语音识别失败：' + (res.error || '未能识别出文字，请说得慢一点再试'));
        } catch (err) { alert('语音识别失败：' + (err.message || '音频处理异常，请重试')); }
        voiceBtn.textContent = '🎙️';
        voiceBtn.classList.remove('rec');
      };
      mediaRec.start();
      voiceBtn.classList.add('rec');
    } catch (e) { alert('无法访问麦克风：' + (e.message || e)); }
  });
  // ── 挂载：⌘ 到加号区（.tools），🎙️ 到发送按钮旁（.trailing）──
  const mountCmd = () => {
    if (document.body.contains(cmdBtn)) return true;
    const addBtn = document.querySelector('[aria-label*="commands" i], [class*="add"]');
    const toolsRow = addBtn ? (addBtn.closest('[class*="tools"], [class*="row"]') || addBtn.parentElement) : null;
    const composer = document.querySelector('[data-composer-card]');
    const anchor = toolsRow || (composer && composer.querySelector('[class*="row"]')) || null;
    if (anchor) {
      // + = 多功能（放官方加号位置，官方 + 隐藏避免重复）；⚡ = 快捷命令（在旁）
      if (addBtn) addBtn.style.display = 'none';
      anchor.insertBefore(cmdBtn, addBtn ? addBtn.nextSibling : null);
      if (document.body.contains(cmdQuick)) return true;
      anchor.insertBefore(cmdQuick, cmdBtn.nextSibling);
      return true;
    }
    return false;
  };
  const mountVoice = () => {
    if (document.body.contains(voiceBtn)) return true;
    const sendBtn = document.querySelector('[aria-label*="send" i], [class*="send"], [class*="primary"]') ||
      document.querySelector('[data-composer-card] [class*="trailing"], [data-composer-card] [class*="right"]');
    const trailing = sendBtn ? (sendBtn.closest('[class*="trailing"], [class*="right"]') || sendBtn.parentElement) : null;
    const composer = document.querySelector('[data-composer-card]');
    const anchor = trailing || (composer && composer.querySelector('[class*="trailing"], [class*="right"], [class*="row"]')) || null;
    if (anchor) {
      // 麦克风插到发送按钮左侧（千问式：在发送按钮之前）
      const target = sendBtn && sendBtn.closest('[class*="trailing"], [class*="right"]') ? sendBtn : null;
      if (target) anchor.insertBefore(voiceBtn, target);
      else anchor.appendChild(voiceBtn);
      return true;
    }
    return false;
  };
  const okCmd = mountCmd();
  const okVoice = mountVoice();
  if (!okCmd || !okVoice) {
    const mo = new MutationObserver(() => {
      const c = mountCmd(); const v = mountVoice();
      if (c && v) mo.disconnect();
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
})();
`;
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(js, true).catch(() => {});
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
      preload: path.join(__dirname, 'shell-preload.js'),
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
  browserServer.setBrowserWindow(browserWindow);
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
  browserWindow.webContents.on('did-attach-webview', (_e, wc) => { browserServer.setWebviewWC(wc); });
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
    const ver = { version: app.getVersion(), engine: engineVersion(), electron: process.versions.electron, node: process.versions.node, dshRoot: DSH_ROOT };
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
    browserServer.start();
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
    // 1.5) 修复跨版本升级后可能失效的 data/node_modules junction（升级后旧桥指向旧 runtime 会崩引擎）
    ensureJunction();
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
    injectLeftNav(mainWindow);
    injectComposerTools(mainWindow);
    injectModelNameAutoFill(mainWindow);
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
