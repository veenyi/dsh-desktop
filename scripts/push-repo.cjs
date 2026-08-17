'use strict';
// 一次性工具：把项目源码推送到 GitHub 仓库（Contents API，规避 git 协议网络问题）
// 用法：GH_TOKEN=<token> node scripts/push-repo.cjs [--dry]
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
const OWNER = 'veenyi';
const REPO = 'dsh-desktop';
const BRANCH = 'main';
const TOKEN = process.env.GH_TOKEN || '';
const DRY = process.argv.includes('--dry');

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'release', 'dist', 'out', 'testdata']);
const EXCLUDE_FILES = new Set([
  'dsh-node_modules.zip', 'node.exe', 'package-lock.json', // dsh-runtime 锁文件随 npm 重新生成
  'desktop-settings.json', 'update.json', '.env'
]);
const EXCLUDE_PATTERNS = [
  /\.log$/, /^test-open.*\.cjs$/, /^screen.*\.png$/, /^desktop-.*\.png$/,
  /^tray-.*\.png$/, /^exe-icon-.*\.png$/, /^screen\d*\.png$/
];

function walk(dir, base) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const rel = path.posix.join(base, ent.name);
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      out.push(...walk(abs, rel));
    } else {
      if (EXCLUDE_FILES.has(ent.name)) continue;
      if (EXCLUDE_PATTERNS.some((re) => re.test(ent.name))) continue;
      out.push({ rel, abs });
    }
  }
  return out;
}

function api(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, {
      method,
      headers: {
        'User-Agent': 'dsh-desktop-push',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${TOKEN}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        try { resolve(text ? JSON.parse(text) : {}); } catch (_) { resolve(text); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function main() {
  if (!TOKEN) { console.error('FATAL: GH_TOKEN not set'); process.exit(1); }
  const files = walk(ROOT, '');
  console.log(`files to push: ${files.length}`);
  // 兼容 .gitignore 的根目录 png 例外：已用 EXCLUDE_PATTERNS 覆盖
  let ok = 0, skip = 0;
  for (const f of files) {
    if (f.rel === '.gitignore') { /* keep */ }
    const content = fs.readFileSync(f.abs).toString('base64');
    const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(f.rel)}`;
    let sha = null;
    try {
      const existing = await api('GET', apiUrl);
      if (existing && existing.sha) sha = existing.sha;
    } catch (_) { /* not exists */ }
    const payload = { message: 'DSH Desktop v0.3.0 source', content, branch: BRANCH };
    if (sha) payload.sha = sha;
    if (DRY) { console.log(`[dry] ${f.rel}`); ok++; continue; }
    try {
      await api('PUT', apiUrl, payload);
      ok++;
      console.log(`[ok] ${f.rel}`);
    } catch (e) {
      skip++;
      console.log(`[skip] ${f.rel}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`done: ok=${ok} skip=${skip}`);
}

main().catch((e) => { console.error('failed: ' + e.message); process.exit(1); });
