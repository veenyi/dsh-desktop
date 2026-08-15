# DSH Desktop

DeepSeek Harness 桌面客户端：内置 dsh 工作台，本地优先，数据只留在你的电脑。

## 功能

- **工作台**：对话 / 目标模式（/goal）/ 子智能体 / 计划模式 / 工作区
- **技能市场**：网页搜索、文件操作、周报、会议纪要、浏览器自动化等 19 个技能包，对话输入 `/` 调用
- **IM 渠道**：钉钉 / 飞书 / Discord / QQ 机器人 / 企业微信，IM 里直接对话推进任务
- **更新中心**：GitHub Releases 通道，一键检查 / 下载 / 安装新版本
- **桌面集成**：托盘常驻、开机自启、全局快捷键、右键"用 DSH Desktop 打开"、屏幕快照、文件拖拽、内置浏览器

## 安装

从 Releases 下载 `dsh-desktop-<version>-setup.exe` 运行；已安装用户可在 设置 → 更新中心 一键更新。

## 使用

| 入口 | 说明 |
|---|---|
| 对话输入 `/` | 查看并调用已安装技能 |
| 设置 → IM 渠道 | 配置机器人凭据（`~/.dsh/.env`，脱敏存储） |
| 设置 → 更新中心 | 检查 / 安装新版本 |
| 托盘右键 | 打开工作台 / 市场 / IM 渠道状态 / 更新 / 自启开关 |

数据目录：`~/.dsh/`（runtime / data / logs / appdata / market）。

## 构建与发布

```bash
npm install                # 安装 electron / electron-builder
npm run build:runtime      # 构建 dsh 运行时（合并渠道插件 + 市场数据 + patch）
npm run dist               # 打包 NSIS 安装器 → release/
npm run publish            # 发布到 GitHub Releases（需 GH_TOKEN 环境变量或 ~/.dsh/.env 的 GITHUB_TOKEN）
```

更新机制：客户端读取本仓库 Releases 的 `latest.json`（版本 / sha256 / 大小 / 下载地址），下载校验后静默安装。

## 脱敏说明

- 不硬编码任何凭据；机器人凭据仅存本机 `~/.dsh/.env`
- 日志 / 界面不输出凭据值；诊断导出不含 `.env`
- 客户端更新检查走 GitHub 公开 Releases API，无需 Token

## License

MIT
