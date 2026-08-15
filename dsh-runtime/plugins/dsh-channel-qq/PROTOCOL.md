# dsh-channel-qq 协议说明

基于 QQ 开放平台官方机器人 API（WebSocket 网关）。协议实现以官方文档为准：

- WebSocket 方式（网关 / 鉴权 / 心跳 / 事件）：https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html
- 群 @机器人消息事件：https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html
- 群消息（全量模式）：https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html
- 发送群聊消息：https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html

## 网关与鉴权

- 网关地址：生产 `wss://api.sgroup.qq.com/websocket`，沙箱 `wss://sandbox.api.sgroup.qq.com/websocket`（由 `config.sandbox` 切换，默认生产）。
- 连接后服务端先发 OP 10 `HELLO`（`d.heartbeat_interval`），客户端据此启动心跳定时器，随后发 OP 2 `IDENTIFY`：
  ```json
  {"op":2,"d":{"token":"Bot <appId>.<botToken>","intents":<intents>,"shard":[0,1]}}
  ```
- token 格式：`Bot <appId>.<clientSecret>`，本插件用 `config.botToken` 充当 clientSecret。

## Intents

- 默认监听群 / C2C 事件：`1 << 25` = 33554432（`GROUP_AND_C2C_EVENT`）。
- `config.useGuild=true` 时监听频道公域消息：`1 << 30` = 1073741824（`PUBLIC_GUILD_MESSAGES`）。

## 心跳与重连

- 每隔 `heartbeat_interval` ms 发 `{op:1, d:lastSeq}`；OP 11 `HEARTBEAT_ACK` 忽略。
- 断线 / 报错 / 关闭后指数退避重连（1s → 2s → 4s … 上限 32s），重连后重新 `IDENTIFY`（未实现 OP 7 RESUME，见疑点）。
- 收到 `READY` 后重置退避并记录 seq。

## 入站消息事件

- 群 @消息：OP 0 `DISPATCH`，`t === "GROUP_AT_MESSAGE_CREATE"`，`d` 含 `id`、`group_openid`、`author.member_openid`、`content`（需剥离 `<@机器人id>` 前缀）、`timestamp`。sender 用 `author.member_openid`。
- C2C 私聊：`t === "C2C_MESSAGE_CREATE"`，`d` 含 `id`、`openid`、`author.user_openid`、`content`。sender 用 `author.user_openid`（兼容 `openid`）。

## 回复（出站）

- 群：`POST {host}/v2/groups/<group_openid>/messages`，`Authorization: Bot <appId>.<botToken>`，body `{content, msg_type:0, msg_id:<原消息 id>}`。
- C2C：`POST {host}/v2/users/<openid>/messages`，同 body / header；沙箱环境 host 换为 `sandbox.api.sgroup.qq.com`。

## 待核实疑点

1. **token 格式**：网关 IDENTIFY 的 token 与消息接口的 `Authorization` 是否共用同一 `Bot <appId>.<clientSecret>` 值，还是以各自独立字段。当前以 `config.botToken` 统一使用（代码 TODO(qq-token)）。
2. **intents 数值 / 事件名**：`1<<25`（`GROUP_AND_C2C_EVENT`）与 `1<<30`（`PUBLIC_GUILD_MESSAGES`）及 `GROUP_AT_MESSAGE_CREATE`、`C2C_MESSAGE_CREATE` 事件名取自官方与公开 SDK；建议以 https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html 二次核对（代码 TODO(qq-intents)）。
3. **消息接口字段**：`msg_type:0` 表示纯文本；`content` 在不同版本可能为字符串或文本块数组，本实现两者兼容（代码 TODO(qq-msg-api)、TODO(qq-content)）。
4. **C2C 字段**：`openid` / `author.user_openid` 的确切字段名以官方文档为准（代码 TODO(qq-c2c-fields)）。
5. **RESUME**：未实现 OP 7 RESUME，断线一律重新 IDENTIFY，生产环境可优化以降低冷启动（代码 TODO(qq-resume)）。
6. **token 未从日志输出**：日志仅记录 `已配置/未配置` 与连接状态，不输出 token。
