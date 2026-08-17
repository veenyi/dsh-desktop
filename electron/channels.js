'use strict';

/**
 * DSH Desktop IM 渠道管理模块
 *
 * 渠道注册表 + ~/.dsh/.env 凭据读写（脱敏：只记录"已配置/未配置"，绝不记录值）。
 * 渠道插件运行在 dsh 运行时（node_modules/@deepseek-ai/dsh-channel-*），
 * 由 dsh-runtime/patch-web.yaml 的 insert 条目注入（enabled = 对应 env 已配置）。
 * 本模块只负责：展示状态 / 写入凭据 / 生成 patch 段（构建时用）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DSH_ROOT = path.join(os.homedir(), '.dsh');
const ENV_FILE = path.join(DSH_ROOT, '.env');

/**
 * 渠道注册表（id 与 patch-web.yaml 的 insert id 一致）
 * fields: { env, label, secret, placeholder }
 * qrLogin: 该渠道支持扫码配置（设置窗口显示「扫码配置」按钮）
 * note: 无扫码接口渠道的说明文案（诚实标注，避免用户误以为可扫码）
 */
const CHANNELS = [
  {
    id: 'channel-weixin',
    name: '微信个人号',
    icon: '💬',
    desc: '微信个人号机器人 · 腾讯 iLink 扫码登录 · 双向对话',
    qrLogin: true,
    qr: { kind: 'weixin', btn: '微信扫码登录', hint: '用微信扫描二维码完成登录（腾讯 iLink 官方接口），Token 自动填入。' },
    fields: [
      { env: 'WEIXIN_TOKEN', label: 'Token（扫码后自动填入）', secret: true },
      { env: 'WEIXIN_ACCOUNT_ID', label: 'Account ID（扫码后自动填入）', secret: false },
      { env: 'WEIXIN_BASE_URL', label: 'Base URL（扫码后自动填入）', secret: false }
    ]
  },
  {
    id: 'channel-telegram',
    name: 'Telegram',
    icon: '✈️',
    desc: 'Telegram Bot · 扫码创建机器人 · 长轮询收发',
    qrLogin: true,
    qr: { kind: 'telegram', btn: '扫码创建机器人', hint: '用 Telegram 扫描二维码创建机器人，Bot Token 自动填入。' },
    fields: [
      { env: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token（扫码后自动填入）', secret: true },
      { env: 'TELEGRAM_ALLOWED_USERS', label: '允许的用户 ID（可选，逗号分隔）', secret: false }
    ]
  },
  {
    id: 'channel-dingtalk',
    name: '钉钉',
    icon: '🐜',
    desc: '钉钉机器人 · 长连接（Stream）· 双向对话',
    qrLogin: true,
    qr: { kind: 'link', url: 'https://open.dingtalk.com/', btn: '🔗 打开官方后台创建',
      hint: '用桌面浏览器打开钉钉开发者后台，创建企业内部机器人后把 AppKey / AppSecret 填入本机。',
      manualHint: '步骤：① 用桌面浏览器打开钉钉开发者后台 ② 创建企业内部应用并启用机器人能力 ③ 在应用凭证页获取 AppKey 与 AppSecret ④ 复制填到下方字段。' },
    note: '钉钉机器人须在开发者后台人工创建（无自动创建/配对 API），凭据填回本机即可启用。',
    
    fields: [
      { env: 'DINGTALK_APP_KEY', label: 'AppKey', secret: true },
      { env: 'DINGTALK_APP_SECRET', label: 'AppSecret', secret: true }
    ]
  },
  {
    id: 'channel-feishu',
    name: '飞书',
    icon: '🪶',
    desc: '飞书机器人 · 长连接（WebSocket）· 双向对话',
    qrLogin: true,
    qr: { kind: 'link', url: 'https://open.feishu.cn/app', btn: '🔗 打开官方后台创建',
      hint: '用桌面浏览器打开飞书开放平台，创建自建应用后把 App ID / App Secret 填入本机。',
      manualHint: '步骤：① 用桌面浏览器打开飞书开放平台 ② 创建自建应用并开通机器人权限 ③ 在凭证配置页获取 App ID 与 App Secret ④ 复制填到下方字段。' },
    note: '飞书机器人须在开放平台人工创建（无自动创建/配对 API），凭据填回本机即可启用。',
    
    fields: [
      { env: 'FEISHU_APP_ID', label: 'App ID', secret: false },
      { env: 'FEISHU_APP_SECRET', label: 'App Secret', secret: true }
    ]
  },
  {
    id: 'channel-discord',
    name: 'Discord',
    icon: '🎮',
    desc: 'Discord Bot · Gateway（WebSocket）· 双向对话',
    qrLogin: true,
    qr: { kind: 'link', url: 'https://discord.com/developers/applications', btn: '🔗 打开官方后台创建',
      hint: '用桌面浏览器打开 Discord Developer Portal，创建应用并启用 Bot 后把 Bot Token 填入本机。',
      manualHint: '步骤：① 用桌面浏览器打开 Discord Developer Portal ② 创建应用并在 Bot 页创建机器人、复制 Token ③ 复制填到下方字段。' },
    note: 'Discord 机器人须在开发者门户人工创建，Bot Token 填回本机即可启用。',
    
    fields: [
      { env: 'DISCORD_TOKEN', label: 'Bot Token', secret: true }
    ]
  },
  {
    id: 'channel-wecom',
    name: '企业微信',
    icon: '💼',
    desc: '群机器人 webhook 推送 + 可选回调入站（本地监听，需公网可达）',
    qrLogin: true,
    note: '可先用下方 Corp ID/Agent ID/Secret 配置应用，再用「扫码授权」生成企业微信授权二维码完成绑定。',
    qr: { kind: 'wecom', btn: '扫码授权', hint: '扫码用企业微信授权自建应用（需先填写 Corp ID/Agent ID/Secret）。' },
    fields: [
      { env: 'WECOM_WEBHOOK_KEY', label: '群机器人 Webhook Key/URL', secret: true },
      { env: 'WECOM_CORP_ID', label: 'Corp ID（入站可选）', secret: false },
      { env: 'WECOM_AGENT_ID', label: 'Agent ID（入站可选）', secret: false },
      { env: 'WECOM_SECRET', label: '应用 Secret（入站可选）', secret: true },
      { env: 'WECOM_CALLBACK_TOKEN', label: '回调 Token（入站可选）', secret: true },
      { env: 'WECOM_CALLBACK_AES_KEY', label: 'EncodingAESKey（入站可选）', secret: true }
    ]
  },
  {
    id: 'channel-qq',
    name: 'QQ 机器人',
    icon: '🐧',
    desc: 'QQ 官方机器人 · 腾讯 dsh-qqbot 官方插件 · 扫码绑定 · 单聊/群聊',
    qrLogin: true,
    qr: { kind: 'qq', btn: '扫码绑定机器人',
      hint: '用手机 QQ 扫描下方二维码，即可自动绑定一个已授权的 QQ 机器人（腾讯官方 dsh-qqbot 插件）。扫码成功后 App ID / AppSecret 会自动填入。' },
    note: '扫码绑定后凭据自动保存，重启应用后经腾讯官方插件（@tencent-connect/dsh-qqbot）接入，支持单聊/群聊独立记忆。',

    fields: [
      { env: 'QQBOT_APPID', label: 'App ID（扫码后自动填入）', secret: false },
      { env: 'QQBOT_SECRET', label: 'AppSecret（扫码后自动填入）', secret: true }
    ]
  }
];

/** 读取 .env → { KEY: value }（内存使用，不落日志） */
function readEnv() {
  const out = {};
  try {
    if (!fs.existsSync(ENV_FILE)) return out;
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* ignore */ }
  return out;
}

/** 渠道状态（脱敏：仅布尔/标签，不含值） */
function channelStatus() {
  const env = readEnv();
  return CHANNELS.map((ch) => {
    const fields = ch.fields.map((f) => ({
      env: f.env, label: f.label, secret: f.secret,
      set: !!(env[f.env] || '').trim()
    }));
    const configured = fields.some((f) => f.set);
    const requiredAll = fields.every((f) => f.set); // 全部字段填齐才算 enabled（仅展示用）
    return {
      id: ch.id, name: ch.name, icon: ch.icon || '', desc: ch.desc,
      qrLogin: !!ch.qrLogin, qr: ch.qr || null, note: ch.note || '',
      configured, enabled: configured && requiredAll, fields
    };
  });
}

/** 保存某个渠道的凭据（只写非空值；空值保持原样，清空走 clearChannel） */
function saveChannel(id, values) {
  const ch = CHANNELS.find((c) => c.id === id);
  if (!ch) return { ok: false, message: '未知渠道: ' + id };
  try {
    const env = readEnv();
    for (const f of ch.fields) {
      const v = String(values?.[f.env] ?? '').trim();
      if (v) env[f.env] = v;
    }
    writeEnv(env);
    return { ok: true, message: `「${ch.name}」凭据已保存，重启应用后生效（需已在对应平台创建机器人）` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/** 清空某个渠道的凭据 */
function clearChannel(id) {
  const ch = CHANNELS.find((c) => c.id === id);
  if (!ch) return { ok: false, message: '未知渠道: ' + id };
  try {
    const env = readEnv();
    for (const f of ch.fields) delete env[f.env];
    writeEnv(env);
    return { ok: true, message: `「${ch.name}」凭据已清除` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/** 写 .env（保持其他行） */
function writeEnv(env) {
  fs.mkdirSync(DSH_ROOT, { recursive: true });
  const lines = [];
  for (const [k, v] of Object.entries(env)) {
    if (!k || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    lines.push(`${k}=${String(v)}`);
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', 'utf8');
}

/** 生成 patch-web.yaml 的 insert 段（构建时由 build-runtime.cjs 调用） */
function patchInsertBlock() {
  return [
    {
      id: 'channel-weixin',
      name: '@deepseek-ai/dsh-channel-weixin',
      config: {
        enabled: "!!js (process.env.WEIXIN_TOKEN ?? '') !== ''",
        token: '!!js process.env.WEIXIN_TOKEN ?? \'\'',
        accountId: '!!js process.env.WEIXIN_ACCOUNT_ID ?? \'\'',
        baseUrl: '!!js process.env.WEIXIN_BASE_URL ?? \'\''
      }
    },
    {
      id: 'channel-telegram',
      name: '@deepseek-ai/dsh-channel-telegram',
      config: {
        enabled: "!!js (process.env.TELEGRAM_BOT_TOKEN ?? '') !== ''",
        token: '!!js process.env.TELEGRAM_BOT_TOKEN ?? \'\'',
        allowedUsers: '!!js process.env.TELEGRAM_ALLOWED_USERS ?? \'\''
      }
    },
    {
      id: 'channel-dingtalk',
      name: '@deepseek-ai/dsh-channel-dingtalk',
      config: {
        enabled: "!!js (process.env.DINGTALK_APP_KEY ?? '') !== ''",
        appKey: '!!js process.env.DINGTALK_APP_KEY ?? \'\'',
        appSecret: '!!js process.env.DINGTALK_APP_SECRET ?? \'\''
      }
    },
    {
      id: 'channel-feishu',
      name: '@deepseek-ai/dsh-channel-feishu',
      config: {
        enabled: "!!js (process.env.FEISHU_APP_ID ?? '') !== ''",
        appId: '!!js process.env.FEISHU_APP_ID ?? \'\'',
        appSecret: '!!js process.env.FEISHU_APP_SECRET ?? \'\''
      }
    },
    {
      id: 'channel-discord',
      name: '@deepseek-ai/dsh-channel-discord',
      config: {
        enabled: "!!js (process.env.DISCORD_TOKEN ?? '') !== ''",
        token: '!!js process.env.DISCORD_TOKEN ?? \'\''
      }
    },
    {
      id: 'channel-wecom',
      name: '@deepseek-ai/dsh-channel-wecom',
      config: {
        enabled: "!!js (process.env.WECOM_WEBHOOK_KEY ?? '') !== '' || ((process.env.WECOM_CORP_ID ?? '') !== '' && (process.env.WECOM_AGENT_ID ?? '') !== '' && (process.env.WECOM_SECRET ?? '') !== '')",
        webhookKey: '!!js process.env.WECOM_WEBHOOK_KEY ?? \'\'',
        corpId: '!!js process.env.WECOM_CORP_ID ?? \'\'',
        agentId: '!!js process.env.WECOM_AGENT_ID ?? \'\'',
        secret: '!!js process.env.WECOM_SECRET ?? \'\'',
        callbackToken: '!!js process.env.WECOM_CALLBACK_TOKEN ?? \'\'',
        encodingAESKey: '!!js process.env.WECOM_CALLBACK_AES_KEY ?? \'\''
      }
    },
    {
      id: 'im-qqbot',
      name: '@tencent-connect/dsh-qqbot',
      config: {
        enabled: "!!js (process.env.QQBOT_APPID ?? '') !== ''",
        appId: '!!js process.env.QQBOT_APPID ?? \'\'',
        appSecret: '!!js process.env.QQBOT_SECRET ?? \'\''
      }
    }
  ];
}

module.exports = { CHANNELS, readEnv, writeEnv, channelStatus, saveChannel, clearChannel, patchInsertBlock };
