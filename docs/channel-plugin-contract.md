# dsh IM 渠道插件开发契约

> 供新增 IM 渠道插件（飞书 / 企业微信 / Discord / QQ）遵循的统一接口与约束。
> 参考实现：`dsh-runtime/plugins/dsh-channel-dingtalk/lib/index.js`（必读）。

## 1. 插件形态

每个渠道一个独立目录：`dsh-runtime/plugins/dsh-channel-<name>/`

```
dsh-channel-<name>/
├── package.json          # name=@deepseek-ai/dsh-channel-<name>, type=module, exports=./lib/index.js
└── lib/index.js          # ESM，导出 { name, inject, Config, apply }
```

`package.json` 模板：

```json
{
  "name": "@deepseek-ai/dsh-channel-<name>",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "exports": { ".": "./lib/index.js" },
  "dependencies": {}
}
```

`lib/index.js` 顶部约定：

```js
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";

const name = "channel-<name>";
const inject = ["agents", "sessions", "agentDefaultModel"];
const Config = z.object({ enabled: z.boolean().default(false), ...各凭据字段 z.string().default("") });
```

## 2. 运行时约束（重要）

- **零新增 npm 依赖**：只能用 Node 内置能力 + 已存在的 dsh 包。
  运行时 Node 为 v24（`globalThis.WebSocket`、`fetch`、`crypto` 均可用）。
- **绝不硬编码凭据**：全部从 `config` 读取（由 `patch-web.yaml` 经 `!!js process.env.X` 注入）。
- **导入必须安全**：任何可选依赖/动态导入失败只能记日志并优雅降级（参考 dingtalk 的 `import("dingtalk-stream").then(...).catch(...)` 模式），禁止让 dsh 启动崩溃。
- **连接必须可重连**：WebSocket 断开/心跳超时后自动重连，带指数退避；日志记录连接状态。
- **消息处理串行化**：同一 sender 的并发消息要排队（busy Set），进行中时回复"[系统] 上一条消息还在处理中"。
- **会话隔离**：每个远端用户（sender id）一个持久 dsh session，sessionId 形如 `SessionId("<name>-<senderId>")`。
- **回复提取**：复用 dingtalk 的 `extractReply`（从 session.events 找最后一个 assistant 文本块），超长回复截断到渠道限制内。
- 日志统一 `ctx.logger?.(name) ?? console`，**日志中不得输出完整凭据/Token**（只输出是否已配置）。

## 3. apply(ctx, config) 骨架

```js
function apply(ctx, config) {
  const log = ctx.logger?.(name) ?? console;
  if (!config.enabled || !必备凭据齐全) { log.info("<name> channel disabled (missing config)"); return; }
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const defaultModel = ctx.get("agentDefaultModel");
  const sessionByUser = new Map();
  const agentBySession = new Map();
  const busy = new Set();

  async function ensureAgent(senderId) { /* 同 dingtalk：创建/复用 agent */ }
  async function handleMessage(senderId, text, replyFn) {
    try {
      const agent = await ensureAgent(senderId);
      const sid = sessionByUser.get(senderId);
      if (busy.has(sid)) { await replyFn("[系统] 上一条消息还在处理中，请稍后再发。"); return; }
      busy.add(sid);
      try {
        await agent.whenIdle();
        const firstSeq = agent.session.seq;
        agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
        await agent.whenIdle();
        await sessions.flush(agent.session);
        const reply = extractReply(agent.session, firstSeq);
        await replyFn(reply || "[系统] 未生成回复。");
      } finally { busy.delete(sid); }
    } catch (error) {
      log.error(`turn failed: ${error?.message ?? String(error)}`);
      await replyFn(`[系统] 处理失败：${error?.message ?? String(error)}`);
    }
  }
  startReceiveLoop(ctx, config, handleMessage, log);  // 渠道专属
}
```

## 4. 渠道专属部分（各插件自实现）

`startReceiveLoop` 负责：建立连接（WS/长连接）、鉴权、心跳、监听入站文本消息、
把 `(senderId, text, replyFn)` 交给 `handleMessage`。

- 回复函数 `replyFn(text)`：按渠道 API 把纯文本发回原会话/原频道。
- 出站消息（如企业微信仅支持 webhook 推送）可作为"推送通道"：暴露 `pushText(text)`
  供上层（定时任务等）调用，同时入站回调按渠道能力实现（无公网则明确降级为仅出站并注释说明）。

## 5. 交付要求

- 交付 `lib/index.js` + `package.json` + `PROTOCOL.md`（渠道鉴权流程/心跳/消息事件摘要，300-600 字）。
- 代码通过 Node 语法自检：`node --check`（ESM 用 `node --input-type=module --check < file` 或复制到 .mjs 检查）。
- 不要求真机联调（无真实凭据），但协议实现必须基于官方文档，标注文档 URL。
