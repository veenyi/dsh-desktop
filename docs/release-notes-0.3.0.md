# DSH Desktop v0.3.0 发布说明

DSH Desktop —— DeepSeek Harness 桌面客户端：目标 / 计划 / 子智能体 / 技能市场 / 定时任务 / 多 IM 渠道 / GitHub 自动更新。

## 本版本新增

### IM 渠道（对齐 Octop 多通道能力）
- 钉钉（Stream 长连接，双向对话）✅ 已有
- **飞书**（长连接 WebSocket，无需公网，双向对话）🆕
- **Discord**（Gateway v10，频道/私信双向对话）🆕
- **QQ 机器人**（官方网关，群@/私聊双向对话）🆕
- **企业微信**（群机器人 webhook 推送 + 可选回调入站）🆕
- 设置 → IM 渠道 可视化配置；托盘菜单实时显示渠道状态；右侧面板新增 IM 渠道区块
- 凭据只保存在本机 `~/.dsh/.env`，界面与日志全程脱敏

### 更新中心（GitHub Releases 通道）
- 检查更新：读取 GitHub Releases（默认源 veenyi/dsh-desktop，可在设置修改 owner/repo）
- 一键下载（带进度）+ sha256 校验 + 静默安装，装完自动重启
- 启动后后台静默检查，发现新版本弹系统通知
- 发布脚本 `scripts/publish.cjs`：`npm run dist` 后 `npm run publish` 即发布更新包

### 技能市场扩充（Octop 风格）
新增 6 个技能：周报生成 / 会议纪要 / 翻译润色 / 浏览器自动化 / 定时任务编排 / IM 群助手运营
市场支持搜索过滤；插件市场新增 4 个渠道条目（内置，引导到设置配置）

### 工程与安全
- 冒烟测试模式 `--smoke-test`（发布自检：运行时 / 更新源 / 渠道状态）
- 数据脱敏：无任何硬编码凭据；日志只记录"已/未配置"；诊断包不含 .env
- 渠道插件零新增 npm 依赖（Node 24 原生 WebSocket/fetch）
