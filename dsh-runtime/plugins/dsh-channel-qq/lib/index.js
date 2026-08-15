/**
 * @deepseek-ai/dsh-channel-qq
 * dsh 定制：QQ 官方机器人 IM 渠道插件（官方 WebSocket 网关）。
 *
 * 通过 QQ 开放平台官方 WebSocket 网关（与 Discord 相似的手握手势）接收机器人在
 * 群 / C2C 私聊 / 频道中的入站文本消息，归一化后驱动 dsh Agent 对话，再将最终
 * assistant 回复通过 HTTP 消息接口回传原会话。每个 QQ 用户对应一个持久 dsh session。
 *
 * 协议细节以 https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html
 * 等官方文档为准；不确定的字段在代码中以 TODO 标注，并在 PROTOCOL.md 列出疑点。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
const name = "channel-qq";

/** Core services required before the IM channel can drive a turn. */
const inject = ["agents", "sessions", "agentDefaultModel"];

/** 生产 / 沙箱 WebSocket 网关与消息发送域名。 */
const WS_GATEWAY_PROD = "wss://api.sgroup.qq.com/websocket";
const WS_GATEWAY_SANDBOX = "wss://sandbox.api.sgroup.qq.com/websocket";
const MSG_HOST_PROD = "https://api.sgroup.qq.com";
const MSG_HOST_SANDBOX = "https://sandbox.api.sgroup.qq.com";

/** 意图常量：群/C2C 事件（默认）与频道公域消息（useGuild 开启）。 */
const INTENT_GROUP_AND_C2C_EVENT = 1 << 25;   // 33554432
const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30; // 1073741824

/** 入站消息事件。 */
const EVENT_GROUP_AT_MESSAGE_CREATE = "GROUP_AT_MESSAGE_CREATE";
const EVENT_C2C_MESSAGE_CREATE = "C2C_MESSAGE_CREATE";

/** 配置 schema（通过 profile 的 patch-web.yaml 经 !!js process.env.X 注入）。 */
const Config = z.object({
	enabled: z.boolean().default(false),
	appId: z.string().default(""),
	botToken: z.string().default(""),
	sandbox: z.boolean().default(false),
	useGuild: z.boolean().default(false)
});

/** 从 session 事件流提取最终 assistant 文本（复用钉钉模板）。 */
function extractReply(session, firstSeq) {
	let started = false;
	let text = "";
	for (const event of session.events) {
		if (event.seq < firstSeq) continue;
		if (event.type === "turn/start") { started = true; continue; }
		if (!started) continue;
		if (event.type === "assistant/message") {
			const joined = event.data.message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			if (joined !== "") text = joined;
		}
	}
	return text;
}

/** 剥离 @机器人 前缀：形如 "<@user_openid> 文本" 或 "@<机器人id> 文本"。 */
function stripMention(content) {
	if (typeof content !== "string") return "";
	let text = content.trim();
	// 仅剥离标准 QQ 文本格式 `<@user_openid> ` 前缀，不冒险做宽泛正则，避免误删正文。
	text = text.replace(/^<@\d+>\s*/, "").trim();
	return text;
}

/** HTTP 消息接口鉴权头（Authorization: Bot <appId>.<botToken>）。 */
function msgAuthHeader(appId, botToken) {
	// TODO(qq-token): QQ 消息接口鉴权头标准写法为 `Bot <appId>.<clientSecret>`，
	//   此处用 config.botToken 充当 clientSecret；如官方对网关 token 与消息 token
	//   要求不同凭据，需在此处拆分配置。
	return `Bot ${appId}.${botToken}`;
}

/** 通过 QQ 消息接口回复文本：根据目标类型选择群 / C2C 端点。 */
async function replyQQ(apiHost, appId, botToken, target, msgId, text) {
	if (!target || !msgId) return;
	let path;
	if (typeof target === "object" && target.group_openid) {
		path = `/v2/groups/${target.group_openid}/messages`;
	} else {
		path = `/v2/users/${String(target).replace("user:", "")}/messages`;
	}
	// TODO(qq-msg-api): 官方消息体字段 msg_type=0(纯文本)；如后续支持 markdown/ark
	//   需调整 msg_type 与 content 结构。
	await fetch(`${apiHost}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: msgAuthHeader(appId, botToken)
		},
		body: JSON.stringify({ content: text, msg_type: 0, msg_id: String(msgId) })
	});
}

function apply(ctx, config) {
	const log = ctx.logger?.(name) ?? console;

	if (!config.enabled || !config.appId || !config.botToken) {
		log.info("qq channel disabled (missing enabled/appId/botToken)");
		return;
	}

	const intent = config.useGuild ? INTENT_PUBLIC_GUILD_MESSAGES : INTENT_GROUP_AND_C2C_EVENT;
	const gatewayUrl = config.sandbox ? WS_GATEWAY_SANDBOX : WS_GATEWAY_PROD;
	const apiHost = config.sandbox ? MSG_HOST_SANDBOX : MSG_HOST_PROD;
	// 网关 IDENTIFY token：`Bot <appId>.<clientSecret>`
	// TODO(qq-token): token 格式以官方文档为准；若网关 token 与消息 token 不同需拆分。
	const gatewayToken = `Bot ${config.appId}.${config.botToken}`;

	log.info(`qq channel enabled ${config.sandbox ? "(sandbox)" : "(production)"} intents=${intent}`);

	const agents = ctx.get("agents");
	const sessions = ctx.get("sessions");
	const defaultModel = ctx.get("agentDefaultModel");

	const sessionByUser = new Map();
	const agentBySession = new Map();
	const busy = new Set();

	async function ensureAgent(senderId) {
		let sid = sessionByUser.get(senderId);
		if (sid !== void 0) {
			const cached = agentBySession.get(sid);
			if (cached) return cached;
		}
		sid = sid ?? SessionId(`qq-${senderId}`);
		sessionByUser.set(senderId, sid);
		const selection = defaultModel.currentSelection();
		const { agent } = await agents.create({
			sessionId: sid,
			meta: { cwd: process.cwd() },
			agentOptions: { provider: selection?.provider, model: selection?.model },
			setup: (agentCtx) => {
				installModelSelection(agentCtx, { current: selection, assembled: void 0 });
			}
		});
		await agent.whenIdle();
		agentBySession.set(sid, agent);
		return agent;
	}

	async function handleMessage(senderId, text, replyFn) {
		try {
			const agent = await ensureAgent(senderId);
			const sid = sessionByUser.get(senderId);
			if (busy.has(sid)) {
				await replyFn("[系统] 上一条消息还在处理中，请稍后再发。");
				return;
			}
			busy.add(sid);
			try {
				await agent.whenIdle();
				const firstSeq = agent.session.seq;
				agent.followup(createUserMessage({
					content: [{ type: "text", text }],
					source: { kind: "user" }
				}));
				await agent.whenIdle();
				await sessions.flush(agent.session);
				const reply = extractReply(agent.session, firstSeq);
				await replyFn(reply || "[系统] 未生成回复。");
			} finally {
				busy.delete(sid);
			}
		} catch (error) {
			log.error(`qq turn failed: ${error?.message ?? String(error)}`);
			await replyFn(`[系统] 处理失败：${error?.message ?? String(error)}`);
		}
	}

	// ---- 官方 WebSocket 网关连接 / 鉴权 / 心跳 / 重连 ----
	let ws = null;
	let wsReady = false;
	let lastSeq = null;
	let heartbeatTimer = null;
	let reconnectDelay = 1000;
	let reconnectTimer = null;

	function sendRaw(op, payload) {
		if (ws && ws.readyState === ws.OPEN) {
			ws.send(JSON.stringify({ op, d: payload }));
		}
	}

	function startHeartbeat(intervalMs) {
		stopHeartbeat();
		heartbeatTimer = setInterval(() => {
			sendRaw(1, lastSeq);
		}, intervalMs);
	}

	function stopHeartbeat() {
		if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
	}

	function scheduleReconnect(reason) {
		if (reconnectTimer) return;
		log.info(`qq reconnecting in ${reconnectDelay}ms: ${reason}`);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, reconnectDelay);
	}

	function disconnect(reason) {
		stopHeartbeat();
		wsReady = false;
		lastSeq = null;
		if (ws) {
			const w = ws;
			ws = null;
			// 安全关闭，避免触发 onerror/onclose 重复调度重连。
			w.onerror = () => {};
			w.onclose = () => {};
			w.onmessage = () => {};
			try { w.close(4900, reason); } catch { /* ignored */ }
		}
		if (reconnectDelay < 32000) reconnectDelay *= 2;
		scheduleReconnect(reason);
	}

	function connect() {
		if (ws) return;
		log.info("qq connecting to gateway");
		try {
			ws = new globalThis.WebSocket(gatewayUrl);
		} catch (error) {
			log.error(`qq websocket create failed: ${error?.message ?? String(error)}`);
			if (reconnectDelay < 32000) reconnectDelay *= 2;
			scheduleReconnect("websocket create failed");
			return;
		}

		ws.onopen = () => { log.info("qq gateway connected"); };

		ws.onclose = () => { disconnect("websocket closed"); };

		ws.onerror = () => { disconnect("websocket error"); };

		ws.onmessage = (event) => {
			let frame;
			try { frame = JSON.parse(String(event.data)); } catch { return; }
			const op = frame.op;
			const d = frame.d;

			if (op === 10) {
				// HELLO：服务端告知 heartbeat_interval，客户端随后发送 IDENTIFY。
				const interval = Number(d?.heartbeat_interval ?? 45000);
				log.info(`qq hello heartbeat_interval=${interval}`);
				startHeartbeat(interval);
				// TODO(qq-intents): shard 字段值以官方为准；单实例按 [0,1] 注册。
				sendRaw(2, {
					token: gatewayToken,
					intents: intent,
					shard: [0, 1]
				});
				return;
			}

			if (op === 11) {
				// HEARTBEAT_ACK：忽略。
				return;
			}

			if (op === 0) {
				// 收到第一条 DISPATCH（READY）时重置退避并记录 seq。
				// TODO(qq-resume): 未实现 RESUME(OP7)，断线后统一重新 IDENTIFY；
				//   生产环境可补 READY 缓存 + RESUME 以降低冷启动。
				if (frame.t === "READY") {
					reconnectDelay = 1000;
					log.info("qq gateway identified (READY)");
				}
				if (typeof d?.s === "number") lastSeq = d.s;
				if (typeof d?.seq === "number") lastSeq = d.seq;
				wsReady = true;
				dispatchMessage(frame.t, frame.d);
				return;
			}

			// 其他 OP 暂忽略，避免未知 OP 导致异常。
		};
	}

	// 消息分发：仅处理当前版本关注的入站文本事件。
	function dispatchMessage(t, d) {
		if (t === EVENT_GROUP_AT_MESSAGE_CREATE) {
			const groupOpenid = d?.group_openid;
			const senderId = d?.author?.member_openid ?? groupOpenid;
			// TODO(qq-content): content 为文本消息块数组或字符串视版本而定；
			//   当前兼容 { content: "..." } 与 { content: [{type:1, text}] } 两类。
			const raw = d?.content;
			const text = Array.isArray(raw)
				? raw.map((b) => b?.text ?? "").join("")
				: (typeof raw === "string" ? raw : "");
			const content = stripMention(text);
			const msgId = d?.id;
			if (!senderId || !content) return;
			const replyFn = (reply) =>
				replyQQ(apiHost, config.appId, config.botToken, { group_openid: groupOpenid }, msgId, reply).catch((e) =>
					log.error(`qq group reply failed: ${e?.message ?? String(e)}`)
				);
			handleMessage(senderId, content, replyFn).catch((e) =>
				log.error(`qq handler error: ${e?.message ?? String(e)}`)
			);
			return;
		}

		if (t === EVENT_C2C_MESSAGE_CREATE) {
			// TODO(qq-c2c-fields): openid / user_openid 字段名以官方文档为准。
			const openid = d?.openid ?? d?.author?.user_openid;
			const senderId = d?.author?.user_openid ?? openid;
			const raw = d?.content;
			const content = Array.isArray(raw)
				? raw.map((b) => b?.text ?? "").join("")
				: (typeof raw === "string" ? raw : "");
			const msgId = d?.id;
			if (!senderId || !content) return;
			const replyFn = (reply) =>
				replyQQ(apiHost, config.appId, config.botToken, openid, msgId, reply).catch((e) =>
					log.error(`qq c2c reply failed: ${e?.message ?? String(e)}`)
				);
			handleMessage(senderId, content, replyFn).catch((e) =>
				log.error(`qq handler error: ${e?.message ?? String(e)}`)
			);
			return;
		}
	}

	connect();
}

export { Config, apply, inject, name };
