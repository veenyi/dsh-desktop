'use strict';

/**
 * DSH Desktop 更新模块（GitHub Releases 通道）
 *
 * 机制：
 *   - 更新源 = GitHub 公开仓库的 Releases（无需 Token，公开仓库即可）
 *     默认 veenyi/dsh-desktop；可在 ~/.dsh/update.json 覆盖（owner/repo）
 *   - 检查：GET /repos/{owner}/{repo}/releases/latest → 比对 tag 语义版本
 *   - 元数据：优先取 release 资产里的 latest.json（含 sha256），兜底取 release body
 *   - 下载：重定向跟随 → ~/.dsh/updates/<文件名>，进度回调
 *   - 安装：校验 sha256 → 静默运行 NSIS 安装器（/S）→ 退出本应用
 *
 * 脱敏：不携带任何凭据；日志只记录 owner/repo 与版本号，不记录用户数据。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const DSH_ROOT = path.join(os.homedir(), '.dsh');
const UPDATE_CFG = path.join(DSH_ROOT, 'update.json');
const UPDATE_DIR = path.join(DSH_ROOT, 'updates');

const DEFAULT_OWNER = 'veenyi';
const DEFAULT_REPO = 'dsh-desktop';
const GH_API = 'https://api.github.com';
const GH_UA = 'dsh-desktop-updater';

function log(msg) {
  const line = `${new Date().toISOString()} - updater: ${msg}`;
  try {
    fs.mkdirSync(path.join(DSH_ROOT, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(DSH_ROOT, 'logs', 'dsh.log'), line + '\n');
  } catch (_) { /* ignore */ }
}

/** 读取更新源配置（~/.dsh/update.json，兼容旧格式） */
function readSource() {
  try {
    if (fs.existsSync(UPDATE_CFG)) {
      const u = JSON.parse(fs.readFileSync(UPDATE_CFG, 'utf8'));
      // 旧格式：{ latestVersion, url, notes } → 保留兼容
      if (u.owner && u.repo) return { owner: String(u.owner), repo: String(u.repo) };
      if (u.url && /github\.com\/([^/]+)\/([^/]+)/.test(u.url)) {
        const m = u.url.match(/github\.com\/([^/]+)\/([^/]+)/);
        return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
      }
    }
  } catch (e) { log('read source failed: ' + e.message); }
  return { owner: DEFAULT_OWNER, repo: DEFAULT_REPO };
}

function writeSource(patch) {
  const cur = readSource();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(UPDATE_CFG), { recursive: true });
    fs.writeFileSync(UPDATE_CFG, JSON.stringify(next, null, 2), 'utf8');
    return { ok: true, source: next };
  } catch (e) { return { ok: false, message: e.message }; }
}

/** 语义版本比较：a>b → 1, a==b → 0, a<b → -1（容忍 v 前缀；预发布版本 < 正式版） */
function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v || '').replace(/^v/i, '');
    const [core, pre] = s.split('-');
    return {
      nums: core.split('.').map((n) => parseInt(n, 10) || 0),
      pre: (pre || '').split('.').filter(Boolean)
    };
  };
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const x = pa.nums[i] || 0, y = pb.nums[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  // 核心版本相同：无预发布 > 有预发布；都有则按段比较
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i] || '', y = pb.pre[i] || '';
    if (x === y) continue;
    if (x === '') return -1;
    if (y === '') return 1;
    const xn = parseInt(x, 10), yn = parseInt(y, 10);
    if (!Number.isNaN(xn) && !Number.isNaN(yn)) return xn > yn ? 1 : -1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function ghGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': GH_UA, Accept: 'application/vnd.github+json' },
      timeout: 20000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return ghGet(res.headers.location).then(resolve, reject);
      }
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 8 * 1024 * 1024) req.destroy(new Error('response too large')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

/** 检查更新。currentVersion 由调用方传入（app.getVersion()）。 */
async function checkForUpdates(currentVersion) {
  const src = readSource();
  try {
    const rel = await ghGet(`${GH_API}/repos/${src.owner}/${src.repo}/releases/latest`);
    const tag = String(rel.tag_name || '').replace(/^v/i, '');
    const notes = String(rel.body || '').trim();
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const installer = assets.find((a) => /dsh-desktop-[\d.]+-setup\.exe$/i.test(a.name));
    const metaAsset = assets.find((a) => /^latest\.json$/i.test(a.name));

    let sha256 = '';
    if (metaAsset) {
      try {
        const meta = await ghGet(metaAsset.url); // API asset URL 返回资产对象，取 browser_download_url
        const url = meta.browser_download_url;
        if (url) {
          const raw = await ghGet(url);
          if (raw && raw.version && raw.installer && raw.installer.sha256) {
            sha256 = String(raw.installer.sha256);
            if (raw.version && compareVersions(raw.version, tag) !== 0) log(`latest.json version mismatch (${raw.version} vs ${tag})`);
          }
        }
      } catch (e) { log('latest.json fetch failed: ' + e.message); }
    }

    const latest = tag || (installer ? installer.name.replace(/^dsh-desktop-/, '').replace(/-setup\.exe$/i, '') : '');
    const hasUpdate = latest !== '' && compareVersions(latest, currentVersion) > 0;
    return {
      ok: true,
      current: currentVersion,
      latest,
      hasUpdate,
      notes: notes || '（发布说明见 GitHub Release）',
      source: `https://github.com/${src.owner}/${src.repo}/releases/latest`,
      downloadUrl: installer ? installer.browser_download_url : '',
      size: installer ? installer.size : 0,
      sha256,
      publishedAt: rel.published_at || '',
      tag: rel.tag_name || ''
    };
  } catch (e) {
    log(`check failed (${src.owner}/${src.repo}): ${e.message}`);
    return { ok: false, current: currentVersion, latest: '', hasUpdate: false, message: e.message, source: `https://github.com/${src.owner}/${src.repo}/releases` };
  }
}

/** 下载安装包到 ~/.dsh/updates/，onProgress({received, total, percent}) */
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const doGet = (u, redirects) => {
      const req = https.get(u, { headers: { 'User-Agent': GH_UA, Accept: 'application/octet-stream' }, timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return doGet(res.headers.location, redirects - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('download HTTP ' + res.statusCode));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let received = 0;
        const out = fs.createWriteStream(dest + '.part');
        res.on('data', (c) => {
          received += c.length;
          if (typeof onProgress === 'function') onProgress({ received, total, percent: total ? (received / total) : 0 });
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            if (total && received !== total) return reject(new Error('size mismatch: ' + received + '/' + total));
            fs.renameSync(dest + '.part', dest);
            resolve({ path: dest, size: received });
          });
        });
        out.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('download timeout')); });
    };
    doGet(url, 5);
  });
}

/** 计算文件 sha256 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * 下载并安装最新版本。
 * @param {object} info  checkForUpdates 的返回
 * @param {function} onProgress
 * @returns {{ok:boolean,message:string,quit?:boolean}}
 */
async function downloadAndInstall(info, onProgress) {
  if (!info || !info.hasUpdate || !info.downloadUrl) {
    return { ok: false, message: '没有可安装的更新' };
  }
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    const name = path.basename(new URL(info.downloadUrl).pathname) || `dsh-desktop-${info.latest}-setup.exe`;
    const dest = path.join(UPDATE_DIR, name);
    log(`downloading ${info.latest} -> ${dest}`);
    await downloadFile(info.downloadUrl, dest, onProgress);
    if (info.sha256) {
      const actual = await sha256File(dest);
      if (actual.toLowerCase() !== info.sha256.toLowerCase()) {
        fs.rmSync(dest, { force: true });
        log('sha256 mismatch, aborted install');
        return { ok: false, message: '安装包校验失败（sha256 不匹配），已删除，请重试' };
      }
      log('sha256 verified');
    }
    return { ok: true, message: '下载完成，正在安装…', installer: dest, quit: true };
  } catch (e) {
    log('download/install error: ' + e.message);
    try { fs.rmSync(path.join(UPDATE_DIR, path.basename(info.downloadUrl)), { force: true }); } catch (_) {}
    return { ok: false, message: '更新失败：' + e.message };
  }
}

module.exports = {
  DSH_ROOT, UPDATE_CFG, UPDATE_DIR,
  DEFAULT_OWNER, DEFAULT_REPO,
  readSource, writeSource, compareVersions,
  checkForUpdates, downloadAndInstall, sha256File
};
