'use strict';

/**
 * publish.cjs — 发布 DSH Desktop 更新包到 GitHub Releases
 *
 * 用法：
 *   node scripts/publish.cjs                    # 发布 package.json 版本
 *   node scripts/publish.cjs --repo veenyi/dsh-desktop
 *   node scripts/publish.cjs --notes notes.md   # 发布说明文件（可选，默认取 release/notes-<v>.md 或自动生成）
 *   node scripts/publish.cjs --no-upload        # 只生成本地 latest.json 不上传
 *
 * 凭据（脱敏：绝不硬编码）：
 *   优先读取环境变量 GH_TOKEN / GITHUB_TOKEN，其次 ~/.dsh/.env 的 GITHUB_TOKEN 行。
 *
 * 产物（release/ 下）：
 *   dsh-desktop-<version>-setup.exe   NSIS 安装器（electron-builder 产出）
 *   latest.json                       客户端更新元数据（version / sha256 / size / url）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;
const RELEASE_DIR = path.join(ROOT, 'release');

// 参数解析
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}
const REPO = arg('--repo', 'veenyi/dsh-desktop');
const NOTES_FILE = arg('--notes', '');
const DO_UPLOAD = !argv.includes('--no-upload');

const INSTALLER = path.join(RELEASE_DIR, `dsh-desktop-${VERSION}-setup.exe`);
const TAG = `v${VERSION}`;

// ---------- 凭据 ----------
function readToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    const envFile = path.join(os.homedir(), '.dsh', '.env');
    if (fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*GITHUB_TOKEN\s*=\s*(.*?)\s*$/);
        if (m) return m[1].replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) { /* ignore */ }
  return '';
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function ghRequest(method, url, { token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, {
      method,
      headers: {
        'User-Agent': 'dsh-desktop-publish',
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
        try { resolve(text ? JSON.parse(text) : {}); } catch (_) { resolve(text); }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function uploadAsset(uploadUrl, filePath, token) {
  return new Promise((resolve, reject) => {
    const name = path.basename(filePath);
    const size = fs.statSync(filePath).size;
    const url = uploadUrl.replace('{?name,label}', '') + `?name=${encodeURIComponent(name)}`;
    const u = new URL(url);
    const req = https.request(u, {
      method: 'POST',
      headers: {
        'User-Agent': 'dsh-desktop-publish',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': size
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`upload HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
        try { resolve(JSON.parse(text)); } catch (_) { resolve(text); }
      });
    });
    req.on('error', reject);
    const stream = fs.createReadStream(filePath);
    stream.pipe(req);
    stream.on('error', (e) => { req.destroy(e); });
  });
}

async function main() {
  console.log(`=== publish dsh-desktop v${VERSION} -> ${REPO} ===`);
  if (!fs.existsSync(INSTALLER)) {
    console.error('FATAL: installer not found: ' + INSTALLER);
    console.error('先运行 npm run dist 生成安装包。');
    process.exit(1);
  }
  const sha = await sha256File(INSTALLER);
  const size = fs.statSync(INSTALLER).size;
  console.log(`installer: ${path.basename(INSTALLER)} (${(size / 1048576).toFixed(1)} MB, sha256 ${sha.slice(0, 12)}…)`);

  // 生成 latest.json
  const latest = {
    version: VERSION,
    notes: '',
    publishedAt: new Date().toISOString(),
    installer: {
      name: path.basename(INSTALLER),
      url: '', // 上传后回填
      size,
      sha256: sha
    }
  };
  if (NOTES_FILE && fs.existsSync(NOTES_FILE)) latest.notes = fs.readFileSync(NOTES_FILE, 'utf8').trim();
  const latestPath = path.join(RELEASE_DIR, 'latest.json');
  fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2), 'utf8');
  console.log('latest.json written: ' + latestPath);

  // 发布说明正文：追加 sha256 供客户端从 API 直接校验（无需下载 latest.json）
  const defaultNotes = `DSH Desktop v${VERSION} 发布。\n\n安装：下载 dsh-desktop-${VERSION}-setup.exe 运行即可；已安装用户可在 设置 → 更新中心 一键更新。`;
  const releaseBody = (latest.notes || defaultNotes) + `\n\nsha256: ${sha}`;

  if (!DO_UPLOAD) {
    console.log('[--no-upload] 跳过上传，仅生成本地 latest.json');
    return;
  }

  const token = readToken();
  if (!token) {
    console.error('FATAL: 未找到 GH_TOKEN / GITHUB_TOKEN（环境变量或 ~/.dsh/.env）。');
    process.exit(1);
  }
  const [owner, repo] = REPO.split('/');
  console.log('creating/updating release ' + TAG + ' …');

  // 查已有 release
  let release;
  try {
    const list = await ghRequest('GET', `https://api.github.com/repos/${owner}/${repo}/releases`, { token });
    release = (Array.isArray(list) ? list : []).find((r) => r.tag_name === TAG);
  } catch (e) { console.log('  (list releases: ' + e.message + ')'); }

  const notes = releaseBody;
  if (release) {
    release = await ghRequest('PATCH', `https://api.github.com/repos/${owner}/${repo}/releases/${release.id}`, {
      token, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: TAG, name: TAG, body: notes, prerelease: false })
    });
    console.log('  release updated: ' + release.html_url);
  } else {
    release = await ghRequest('POST', `https://api.github.com/repos/${owner}/${repo}/releases`, {
      token, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: TAG, name: TAG, body: notes, prerelease: false })
    });
    console.log('  release created: ' + release.html_url);
  }

  // 上传资产（同名先删）
  for (const a of release.assets || []) {
    if (a.name === path.basename(INSTALLER) || a.name === 'latest.json') {
      try { await ghRequest('DELETE', a.url, { token }); console.log('  removed old asset ' + a.name); } catch (e) { console.log('  (remove ' + a.name + ': ' + e.message + ')'); }
    }
  }
  console.log('uploading installer …');
  const up1 = await uploadAsset(release.upload_url, INSTALLER, token);
  console.log('  installer uploaded: ' + (up1.browser_download_url || up1.name));
  console.log('uploading latest.json …');
  latest.installer.url = up1.browser_download_url || `https://github.com/${owner}/${repo}/releases/download/${TAG}/${path.basename(INSTALLER)}`;
  fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2), 'utf8');
  const up2 = await uploadAsset(release.upload_url, latestPath, token);
  console.log('  latest.json uploaded: ' + (up2.browser_download_url || up2.name));

  console.log('=== publish done: ' + release.html_url + ' ===');
}

main().catch((e) => {
  console.error('publish failed: ' + e.message);
  process.exit(1);
});
