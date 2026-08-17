/**
 * 壳侧浏览器操作 HTTP 服务（dsh browser-* 工具通过它操作 webview）
 * 端口 3082（避免与 dsh 3080 冲突），本地 127.0.0.1 监听 + token 鉴权。
 *
 * v2 增强：
 * - click/type 多级 fallback：CSS 选择器 → 文本匹配 → 坐标（click）
 * - ax：CDP Accessibility.getFullAXTree 扁平化为可交互元素列表（self-healing 定位）
 * - guard：人工接管检测（验证码/登录/支付/两步验证）
 * - navigate 带 30s 超时，网络错误附指引（防止 AI 反复重试被墙站点挂死）
 */
const http = require('http');

let browserWindow = null;   // 由 main.js 注入
let webviewWC = null;       // webview 的 webContents
const TOKEN = process.env.DSH_BROWSER_TOKEN || 'fnos-dsh-browser-local';
const PORT = 3082;
const NAV_TIMEOUT = 30000;

function setBrowserWindow(win) { browserWindow = win; }
function setWebviewWC(wc) { webviewWC = wc; }

function auth(req) {
  return (req.headers['x-browser-token'] || '') === TOKEN;
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function wc() {
  return webviewWC || (browserWindow ? browserWindow.webContents : null);
}

async function execute(js) {
  const target = wc();
  if (!target) throw new Error('浏览器未打开');
  const result = await target.executeJavaScript(js, true);
  return result;
}

/** 页面内文本归一化 */
const NORM_JS = `const __norm = s => (s || '').replace(/\\s+/g, ' ').trim();`;

const handlers = {
  // 读取页面文本（AI 观察）
  async read() {
    const text = await execute(`(() => {
      const main = document.querySelector('main, article, #content, [role="main"]') || document.body;
      const t = (main.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12000);
      const title = document.title || '';
      const url = location.href;
      return JSON.stringify({ title, url, text: t.slice(0, 12000) });
    })()`);
    return JSON.parse(text);
  },
  // 截图（base64 PNG）
  async screenshot() {
    const target = wc();
    if (!target) throw new Error('浏览器未打开');
    const img = await target.capturePage();
    const png = img.toPNG();
    return { mime: 'image/png', data: png.toString('base64') };
  },
  // 导航（30s 超时 + 网络错误指引）
  async navigate(body) {
    const target = wc();
    if (!target) throw new Error('浏览器未打开');
    const url = body.url;
    if (!/^(https?|data):/i.test(url)) throw new Error('URL 必须以 http(s):// 或 data: 开头: ' + url.slice(0, 80));
    await Promise.race([
      target.loadURL(url).catch(e => {
        const code = (e && (e.code || e.errno || e.message)) || String(e);
        throw new Error(`导航失败 ${url}: ${code}。若为 ERR_CONNECTION_* / ERR_NAME_NOT_RESOLVED / ERR_SSL* 说明目标站点不可达或网络受限，不要反复重试同一 URL——请换一个可访问的站点，或停止并向用户说明。`);
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`导航超时(${NAV_TIMEOUT / 1000}s): ${url} 不可达。不要重试，请换可访问的站点或停止并向用户说明。`)), NAV_TIMEOUT))
    ]);
    // 等页面初始化，便于立刻读 DOM
    await new Promise(r => setTimeout(r, 800));
    return { ok: true, url };
  },
  // 后退/前进/刷新
  async back() { const t = wc(); if (t) await t.goBack(); return { ok: true }; },
  async forward() { const t = wc(); if (t) await t.goForward(); return { ok: true }; },
  async reload() { const t = wc(); if (t) await t.reload(); return { ok: true }; },
  // 点击：selector → text（DOM 文本匹配）→ x/y 坐标，逐级 fallback
  async click(body) {
    const target = wc();
    if (!target) throw new Error('浏览器未打开');
    if (body.selector) {
      try {
        await execute(`(() => { const el = document.querySelector(${JSON.stringify(body.selector)}); if (!el) throw new Error('selector not found'); el.scrollIntoView({block:'center'}); el.click(); return 'ok'; })()`);
        return { ok: true, via: 'selector' };
      } catch (e) {
        if (!/not found|failed to execute|script failed/i.test(e.message)) throw e;
        /* 元素未找到 → 尝试文本；页面跳转中断 → 视为点击成功 */
        if (/failed to execute|script failed/i.test(e.message)) return { ok: true, via: 'selector', note: '点击已生效，页面跳转中断了脚本' };
      }
    }
    if (body.text) {
      try {
        await execute(`(() => {
          ${NORM_JS}
          const q = ${JSON.stringify(String(body.text))};
          const all = [...document.querySelectorAll('a, button, [role="button"], [role="tab"], input[type=submit], input[type=button], summary, label, [onclick], [class*="btn"]')];
          const byExact = all.filter(el => { const t = __norm(el.innerText) || __norm(el.value) || __norm(el.placeholder) || __norm(el.getAttribute('aria-label')); return t && t === q; });
          const byInc = all.filter(el => { const t = __norm(el.innerText) || __norm(el.getAttribute('aria-label')) || __norm(el.placeholder) || __norm(el.value); return t && t.includes(q); });
          const el = byExact[0] || byInc[0];
          if (!el) throw new Error('未找到文本为「' + q + '」的可点击元素');
          el.scrollIntoView({block:'center'});
          el.click();
          return 'ok';
        })()`);
        return { ok: true, via: 'text' };
      } catch (e) {
        if (/未找到|not found/i.test(e.message)) throw e;
        return { ok: true, via: 'text', note: '点击已生效，页面跳转中断了脚本' };
      }
    }
    if (typeof body.x === 'number' && typeof body.y === 'number') {
      await execute(`(() => { const el = document.elementFromPoint(${body.x}, ${body.y}); if (el) el.click(); return 'ok'; })()`);
      return { ok: true, via: 'coords' };
    }
    throw new Error('click 需要 selector / text / x,y 之一');
  },
  // 填表：selector 或 text 定位输入框（匹配 placeholder/aria-label/name/id/label 关联）
  async type(body) {
    const target = wc();
    if (!target) throw new Error('浏览器未打开');
    if (!body.selector && !body.target_text) throw new Error('type 需要 selector 或 target_text（定位输入框的文本）');
    const value = String(body.inputText !== undefined ? body.inputText : (body.text || ''));
    let elExpr;
    if (body.selector) {
      elExpr = `document.querySelector(${JSON.stringify(body.selector)})`;
    } else {
      elExpr = `(() => {
        ${NORM_JS}
        const q = ${JSON.stringify(String(body.target_text))};
        const inputs = [...document.querySelectorAll('input, textarea, [contenteditable=true]')];
        const hit = inputs.find(i => __norm(i.placeholder).includes(q) || __norm(i.getAttribute('aria-label')).includes(q) || __norm(i.name).includes(q) || __norm(i.id).includes(q) || __norm(i.getAttribute('data-testid')).includes(q));
        if (hit) return hit;
        const lab = [...document.querySelectorAll('label')].find(l => __norm(l.innerText).includes(q));
        if (lab && lab.htmlFor) { const byFor = document.getElementById(lab.htmlFor); if (byFor && ['INPUT','TEXTAREA','SELECT'].includes(byFor.tagName)) return byFor; }
        if (lab) { const inside = lab.querySelector('input, textarea'); if (inside) return inside; }
        throw new Error('未找到与「' + q + '」相关的输入框');
      })()`;
    }
    await execute(`(() => {
      const el = ${elExpr};
      if (!el) throw new Error('输入框不存在');
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable) {
        if (el.isContentEditable) { el.textContent = ${JSON.stringify(value)}; el.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:${JSON.stringify(value)}})); }
        else { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }
      }
      return 'ok';
    })()`);
    return { ok: true };
  },
  // 滚动
  async scroll(body) {
    const dy = body.dy || 0, dx = body.dx || 0;
    await execute(`window.scrollBy(${dx}, ${dy})`);
    return { ok: true };
  },
  // 按键（Enter/Escape 等）
  async key(body) {
    await execute(`(() => {
      const key = ${JSON.stringify(body.key || 'Enter')};
      const el = document.activeElement || document.body;
      el.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles:true}));
      el.dispatchEvent(new KeyboardEvent('keyup', {key, bubbles:true}));
      return 'ok';
    })()`);
    return { ok: true };
  },
  // 获取当前 URL（工具确认导航结果）
  async url() {
    const u = await execute(`location.href`);
    return { url: u };
  },
  // 等待加载
  async wait(body) {
    const ms = Math.min(body.ms || 1500, 10000);
    await new Promise(r => setTimeout(r, ms));
    return { ok: true };
  },
  // 查找元素（DOM 可点击目标列表，给 AI 参考）
  async elements() {
    const list = await execute(`(() => {
      const els = [];
      document.querySelectorAll('a, button, input, textarea, [role="button"], select').forEach((el, i) => {
        if (els.length > 60) return;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        const t = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 60);
        if (!t) return;
        els.push({ i, tag: el.tagName, text: t, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
      });
      return JSON.stringify(els);
    })()`);
    return { elements: JSON.parse(list) };
  },
  // AX 树可交互元素（CDP Accessibility.getFullAXTree 优先，Electron 无 AX 时 DOM 兜底）
  async ax() {
    const target = wc();
    if (!target) throw new Error('浏览器未打开');
    const interactive = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'tab', 'searchbox', 'slider', 'switch']);
    // 通道 1：CDP AX 树（Electron 默认惰性构建，可能为空）
    let axOut = [];
    try {
      const dbg = target.debugger;
      const wasAttached = dbg.isAttached();
      if (!wasAttached) dbg.attach('1.3');
      try {
        await dbg.sendCommand('Accessibility.enable').catch(() => {});
        await new Promise(r => setTimeout(r, 300));
        const r = await dbg.sendCommand('Accessibility.getFullAXTree');
        const tree = r.tree || r.nodes || [];
        const walk = (n) => {
          const role = n.role && n.role.value;
          const name = n.name && n.name.value;
          const b = n.bounds;
          if (b && role && interactive.has(role) && b.width >= 4 && b.height >= 4 && name) {
            const cx = Math.round(b.x + b.width / 2);
            const cy = Math.round(b.y + b.height / 2);
            const dup = axOut.some(o => o.text === name && Math.abs(o.x - cx) <= 6 && Math.abs(o.y - cy) <= 6);
            if (!dup && axOut.length < 80) axOut.push({ role, text: String(name).slice(0, 80), x: cx, y: cy, w: Math.round(b.width), h: Math.round(b.height) });
          }
          for (const c of (n.children || [])) walk(c);
        };
        for (const n of tree) walk(n);
      } finally {
        if (!wasAttached) { try { dbg.detach(); } catch {} }
      }
    } catch {}
    if (axOut.length) return { elements: axOut, count: axOut.length, source: 'ax' };
    // 通道 2：DOM 遍历（tagName/role → 语义 role + 文本 + 中心坐标）
    const list = await execute(`(() => {
      const els = [];
      const roleOf = (el) => {
        const r = el.getAttribute('role');
        if (r) return r;
        const t = el.tagName;
        if (t === 'A') return 'link';
        if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
        if (t === 'TEXTAREA') return 'textbox';
        if (t === 'SELECT') return 'combobox';
        if (t === 'INPUT') return (el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox');
        return 'button';
      };
      document.querySelectorAll('a, button, input, textarea, select, summary, [role="button"], [role="tab"], [role="link"], [role="checkbox"], [role="menuitem"]').forEach((el) => {
        if (els.length > 80) return;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        const t = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || el.tagName).trim().slice(0, 80);
        if (!t) return;
        els.push({ role: roleOf(el), text: t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
      });
      return JSON.stringify(els);
    })()`);
    return { elements: JSON.parse(list), count: JSON.parse(list).length, source: 'dom' };
  },
  // 人工接管检测：验证码/登录/支付/两步验证 → 需要用户手动操作
  async guard() {
    const info = await execute(`(() => {
      const url = location.href || '';
      const raw = ((document.body && document.body.innerText) || '').slice(0, 2500);
      const text = raw.replace(/\\s+/g, ' ');
      const hit = (re) => { try { return new RegExp(re, 'i').test(text) || new RegExp(re, 'i').test(url); } catch { return false; } };
      let out = { needed: false };
      if (hit('captcha|recaptcha|验证码|安全验证|人机验证|拖动滑块|请完成.{0,6}验证')) out = { needed: true, why: '页面出现验证码/人机验证，需要人工完成' };
      else if (hit('g-recaptcha|cf-challenge|challenge-platform')) out = { needed: true, why: '页面出现人机挑战（reCAPTCHA/Cloudflare），需要人工完成' };
      else if (hit('/login|/signin|/auth|/accounts') && hit('登录|sign\\s*?in|log\\s*?in|continue|验证')) out = { needed: true, why: '页面要求登录，需要人工输入账号密码' };
      else if (hit('确认订单|立即支付|提交订单|确认支付|支付密码|checkout|付款')) out = { needed: true, why: '页面涉及支付/订单确认，需要人工确认' };
      else if (hit('两步验证|二次验证|2fa|authenticator|动态口令|身份验证器')) out = { needed: true, why: '页面要求两步验证，需要人工操作' };
      return JSON.stringify(out);
    })()`);
    return JSON.parse(info);
  },
};

const server = http.createServer(async (req, res) => {
  if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
  const url = new URL(req.url, 'http://localhost');
  const name = url.pathname.replace('/browser/', '');
  try {
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
    if (!handlers[name]) return json(res, 404, { error: 'unknown action: ' + name });
    const result = await handlers[name](body);
    json(res, 200, result);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

function start() {
  server.listen(PORT, '127.0.0.1', () => console.log(`[browser-server] listening on 127.0.0.1:${PORT}`));
}
function stop() { try { server.close(); } catch {} }

module.exports = { start, stop, setBrowserWindow, setWebviewWC, PORT, TOKEN };
