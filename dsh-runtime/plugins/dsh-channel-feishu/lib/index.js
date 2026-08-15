/**
 * @deepseek-ai/dsh-channel-feishu
 * DSH Desktop 定制：飞书（Feishu/Lark）长连接模式 IM 渠道插件（单聊 MVP）。
 *
 * 通过飞书开放平台"长连接"能力（WebSocket 出站长连接，无需公网回调）接收机器人消息，
 * 归一化后驱动 dsh Agent 对话，再把最终 assistant 回复回传飞书会话。
 * 每个飞书用户（sender_id.open_id）对应一个持久 dsh session。
 *
 * 协议与字段以飞书开放平台官方文档为准，详见 PROTOCOL.md。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
const name = "channel-feishu";

/** Core services required before the IM channel can drive a turn. */
const inject = ["agents", "sessions", "agentDefaultModel"];

/** 配置 schema（通过 profile 的 cordis.patch.yml 或 --patch 注入）。 */
const Config = z.object({
	enabled: z.boolean().default(false),
	appId: z.string().default(""),
	appSecret: z.string().default("")
});

/** 飞书 IM 文本消息最大单条字符数限制（保守截断，留出容错余量）。 */
const MAX_TEXT_LEN = 6500;

/** 获取 tenant_access_token。 */
async function getTenantToken(appId, appSecret) {
	const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ app_id: appId, app_secret: appSecret })
	});
	const body = await res.json();
	if (body?.code !== 0) {
		throw new Error(`tenant token failed: ${body?.msg ?? JSON.stringify(body)}`);
	}
	return body?.tenant_access_token;
}

/** 获取长连接端点。 */
async function getWsEndpoint(appId, appSecret) {
	const res = await fetch("https://open.feishu.cn/open-apis/ws_endpoint", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ app_id: appId, app_secret: appSecret })
	});
	const body = await res.json();
	if (body?.code !== 0) {
		throw new Error(`ws endpoint failed: ${body?.msg ?? JSON.stringify(body)}`);
	}
	const data = body?.data ?? {};
	if (!data?.url || !data?.ticket) {
		throw new Error("ws endpoint response missing url/ticket");
	}
	return data;
}

/** 从 session 事件流提取最终 assistant 文本（复用钉钉模板逻辑）。 */
function extractReply(session, firstSeq) {
	let started = false;
	let text = "";
	for (const event of session.events) {
		if (event.seq < firstSeq) continue;
		if (event.type === "turn/start") { started = true; continue; }
		if (!started) continue;
		if (event.type === "assistant/message") {
			const joined = (event.data?.message?.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			if (joined !== "") text = joined;
		}
	}
	return text;
}

/** 通过飞书发送消息接口回复文本给指定 open_id。 */
async function replyFeishu(tenantToken, openId, text) {
	if (!tenantToken || !openId) return;
	await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${tenantToken}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			receive_id: openId,
			msg_type: "text",
			content: JSON.stringify({ text: text.slice(0, MAX_TEXT_LEN) })
		})
	});
}

/** 处理一条来自飞书用户入站的文本消息。 */
async function handleMessage(agents, sessions, defaultModel, sessionByUser, agentBySession,
		busy, tenantToken, senderId, text, replyFn, log) {
	try {
		const agent = await ensureAgent(agents, sessions, defaultModel, sessionByUser, agentBySession, senderId);
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
		log.error(`feishu turn failed: ${error?.message ?? String(error)}`);
		await replyFn(`[系统] 处理失败：${error?.message ?? String(error)}`);
	}
}

/** 为远端用户创建/复用 dsh agent。 */
async function ensureAgent(agents, sessions, defaultModel, sessionByUser, agentBySession, senderId) {
	let sid = sessionByUser.get(senderId);
	if (sid !== void 0) {
		const cached = agentBySession.get(sid);
		if (cached) return cached;
	}
	sid = sid ?? SessionId(`feishu-${senderId}`);
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

/** 解析 data 事件并归一化为 (senderId, text)。 */
function parseDataEvent(dataStr, handleMessageFn, log) {
	let parsed;
	try { parsed = typeof dataStr === "string" ? JSON.parse(dataStr) : dataStr; } catch {
		log.error("feishu data event parse failed");
		return;
	}
	if (parsed?.type !== "im.message.receive_v1") return;
	const event = parsed?.event;
	if (!event) return;
	const openId = event?.sender?.sender_id?.open_id;
	if (!openId) return;
	const message = event?.message;
	if (!message || message.message_type !== "text") return;
	const chatId = message?.chat_id ?? "";
	let text = "";
	try {
		const content = typeof message.content === "string"
			? JSON.parse(message.content)
			: message.content;
		text = content?.text ?? "";
	} catch {
		log.error(`feishu message content parse failed [chat=${chatId}]`);
		return;
	}
	if (!text) return;
	handleMessageFn(openId, text, chatId).catch((e) =>
		log.error(`feishu handler error [chat=${chatId}]: ${e?.message ?? String(e)}`)
	);
}

/** 飞书渠道专属：建立长连接、鉴权、心跳、监听入站文本消息。 */
function startReceiveLoop(ctx, config, log) {
	const agents = ctx.get("agents");
	const sessions = ctx.get("sessions");
	const defaultModel = ctx.get("agentDefaultModel");

	const sessionByUser = new Map();
	const agentBySession = new Map();
	const busy = new Set();

	const state = {
		appId: config.appId,
		appSecret: config.appSecret,
		tenantToken: "",
		tenantTokenExpiresAt: 0,
		connected: false,
		reconnectMs: 1000,
		reconnectTimer: null,
		ws: null
	};

	const replyFn = (senderId, chatId) => (text) => {
		replyFeishu(state.tenantToken, senderId, text).catch((e) =>
			log.error(`feishu reply failed [chat=${chatId}]: ${e?.message ?? String(e)}`)
		);
	};

	async function handleMessageFn(senderId, text, chatId) {
		handleMessage(agents, sessions, defaultModel, sessionByUser, agentBySession,
			busy, state.tenantToken, senderId, text, replyFn(senderId, chatId), log);
	}

	/** 处理一个入站消息帧（WebSocket message 事件回调）。 */
	function onWsMessage(raw) {
		let frame;
		try { frame = JSON.parse(raw); } catch {
			log.error("feishu frame parse failed");
			return;
		}
		if (frame?.type === "data") {
			parseDataEvent(frame.data, handleMessageFn, log);
		} else if (frame?.type === "pong") {
			// 服务端心跳响应帧，视为存活信号，无需处理。
		}
		// 忽略未知帧类型（如连接协商等），避免误处理。
	}

	/** 关闭旧连接并清理定时器。 */
	function closeWs() {
		if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
		if (state.ws) {
			try { state.ws.onmessage = null; state.ws.onclose = null; state.ws.onerror = null; } catch { /* ignore */ }
			try { state.ws.close(); } catch { /* ignore */ }
			state.ws = null;
			state.connected = false;
		}
		state.reconnectMs = 1000;
	}

	/** 刷新 tenant_access_token。 */
	async function refreshToken() {
		const token = await getTenantToken(state.appId, state.appSecret);
		const now = Date.now();
		state.tenantToken = token;
		// token 有效期通常 2 小时，提前 5 分钟刷新。
		state.tenantTokenExpiresAt = now + 65 * 60 * 1000;
	}

	/** 建立一次长连接（WS 出站）。 */
	async function connect() {
		if (state.connected || !globalThis.WebSocket) return;
		let url;
		try {
			await refreshToken();
			const endpoint = await getWsEndpoint(state.appId, state.appSecret);
			url = `${endpoint.url}${endpoint.url.includes("?") ? "&" : "?"}ticket=${endpoint.ticket}`;
		} catch (e) {
			log.error(`feishu connect setup failed: ${e?.message ?? String(e)}`);
			scheduleReconnect();
			return;
		}

		let ws;
		try { ws = new globalThis.WebSocket(url); } catch (e) {
			log.error(`feishu websocket create failed: ${e?.message ?? String(e)}`);
			scheduleReconnect();
			return;
		}
		closeWs();
		state.ws = ws;

		ws.addEventListener("open", () => {
			state.connected = true;
			state.reconnectMs = 1000;
			log.info("feishu long-connection connected");
			try {
				ws.send(JSON.stringify({ type: "client_register", client_type: 4 }));
			} catch (e) {
				log.error(`feishu register send failed: ${e?.message ?? String(e)}`);
			}
		});

		ws.addEventListener("message", (event) => {
			const raw = typeof event.data === "string" ? event.data : "";
			onWsMessage(raw);
		});

		ws.addEventListener("close", () => {
			log.info("feishu long-connection closed");
			state.connected = false;
			scheduleReconnect();
		});

		ws.addEventListener("error", () => {
			log.error("feishu long-connection error");
		});
	}

	/** 指数退避重连调度。 */
	function scheduleReconnect() {
		if (state.connected || state.reconnectTimer) return;
		state.reconnectTimer = setTimeout(() => {
			state.reconnectTimer = null;
			connect().catch((e) =>
				log.error(`feishu reconnect failed: ${e?.message ?? String(e)}`)
			);
		}, state.reconnectMs);
		state.reconnectMs = Math.min(state.reconnectMs * 2, 60000);
	}

	// 定时刷新 token，避免重连时 token 过期。
	setInterval(async () => {
		if (Date.now() >= state.tenantTokenExpiresAt - 300000) {
			try { await refreshToken(); } catch (e) {
				log.error(`feishu token refresh failed: ${e?.message ?? String(e)}`);
			}
		}
	}, 5 * 60 * 1000);

	connect().catch((e) =>
		log.error(`feishu initial connect failed: ${e?.message ?? String(e)}`)
	);
}

function apply(ctx, config) {
	const log = ctx.logger?.(name) ?? console;

	if (!config.enabled) {
		log.info("feishu channel disabled");
		return;
	}
	if (!config.appId) {
		log.info("feishu channel missing appId (FEISHU_APP_ID)");
		return;
	}
	if (!config.appSecret) {
		log.info("feishu channel missing appSecret (FEISHU_APP_SECRET)");
		return;
	}
	log.info("feishu channel enabled (credentials configured)");

	startReceiveLoop(ctx, config, log);
}

export { Config, apply, inject, name };
