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
 */
const CHANNELS = [
  {
    id: 'channel-dingtalk',
    name: '钉钉',
    desc: '钉钉机器人 · 长连接（Stream）· 双向对话',
    fields: [
      { env: 'DINGTALK_APP_KEY', label: 'AppKey', secret: true },
      { env: 'DINGTALK_APP_SECRET', label: 'AppSecret', secret: true }
    ]
  },
  {
    id: 'channel-feishu',
    name: '飞书',
    desc: '飞书机器人 · 长连接（WebSocket）· 双向对话',
    fields: [
      { env: 'FEISHU_APP_ID', label: 'App ID', secret: false },
      { env: 'FEISHU_APP_SECRET', label: 'App Secret', secret: true }
    ]
  },
  {
    id: 'channel-discord',
    name: 'Discord',
    desc: 'Discord Bot · Gateway（WebSocket）· 双向对话',
    fields: [
      { env: 'DISCORD_TOKEN', label: 'Bot Token', secret: true }
    ]
  },
  {
    id: 'channel-wecom',
    name: '企业微信',
    desc: '群机器人 webhook 推送 + 可选回调入站（本地监听，需公网可达）',
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
    desc: 'QQ 官方机器人 · 网关（WebSocket）· 群/私聊',
    fields: [
      { env: 'QQ_APP_ID', label: 'App ID', secret: false },
      { env: 'QQ_BOT_TOKEN', label: 'Bot Token', secret: true }
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
      id: ch.id, name: ch.name, desc: ch.desc,
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
        enabled: "!!js (process.env.WECOM_WEBHOOK_KEY ?? '') !== ''",
        webhookKey: '!!js process.env.WECOM_WEBHOOK_KEY ?? \'\'',
        corpId: '!!js process.env.WECOM_CORP_ID ?? \'\'',
        agentId: '!!js process.env.WECOM_AGENT_ID ?? \'\'',
        secret: '!!js process.env.WECOM_SECRET ?? \'\'',
        callbackToken: '!!js process.env.WECOM_CALLBACK_TOKEN ?? \'\'',
        encodingAESKey: '!!js process.env.WECOM_CALLBACK_AES_KEY ?? \'\''
      }
    },
    {
      id: 'channel-qq',
      name: '@deepseek-ai/dsh-channel-qq',
      config: {
        enabled: "!!js (process.env.QQ_APP_ID ?? '') !== ''",
        appId: '!!js process.env.QQ_APP_ID ?? \'\'',
        botToken: '!!js process.env.QQ_BOT_TOKEN ?? \'\''
      }
    }
  ];
}

module.exports = { CHANNELS, readEnv, writeEnv, channelStatus, saveChannel, clearChannel, patchInsertBlock };
