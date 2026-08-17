'use strict';

/**
 * build-runtime.cjs — 构建 dsh-runtime（Windows 桌面版运行时）
 *
 * 流程：
 *   1. 从 fnos-dsh 仓库复制定制补丁（patches/）+ 自定义插件（plugins/）
 *   2. Windows 本机 npm install（全新依赖，保证 koffi/sharp 等 native 包
 *      用 Windows prebuilt，不用 Linux 构建的 node_modules）
 *   3. 应用补丁（复制覆盖 node_modules 定制文件 + 装入自定义插件）
 *   4. 生成桌面版 patch-web.yaml（host 127.0.0.1，钉钉渠道凭据走 .env）
 *   5. [--package 模式] node_modules 归档为单文件 dsh-node_modules.zip 并删除散文件
 *      —— 安装器只拷 1 个归档文件（秒装），应用首次启动自解压到版本目录
 *
 * 用法：
 *   node scripts/build-runtime.cjs            # 开发模式（保留散 node_modules）
 *   node scripts/build-runtime.cjs --package  # 打包模式（归档 node_modules）
 */
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'dsh-runtime');

// fnos-dsh 仓库源（定制补丁/插件的唯一事实来源）
// 脱敏：不硬编码本机路径，用环境变量 FNOs_DSH_SRC 指定；未配置则跳过补丁/插件合并
const SRC_APP = process.env.FNOs_DSH_SRC || '';
const SRC_PATCHES = SRC_APP ? path.join(SRC_APP, 'patches') : '';
const SRC_PLUGINS = SRC_APP ? path.join(SRC_APP, 'plugins') : '';

// 7za 优先（electron-builder 缓存，路径走 %LOCALAPPDATA% 不写死用户名），fallback 系统 tar
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || 'C:/Users/Default/AppData/Local';
const CANDIDATE_7ZA = [
  path.join(LOCAL_APP_DATA, 'electron-builder', 'Cache', '7zip@1.0.0', '7zip-win-x64-1nrf7', 'bin', '7za.exe'),
  path.join(LOCAL_APP_DATA, 'electron-builder', 'Cache', '7zip', '7zip-win-x64', 'bin', '7za.exe')
];
const SYSTEM_TAR = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'C:/Windows/System32/tar.exe';

const PACKAGE_MODE = process.argv.includes('--package');

function run(cmd, cwd) {
  console.log(`[run] ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log(`[copy] ${src} -> ${dst}`);
}

// 合并复制：目标已有文件被源覆盖，但保留目标中源没有的额外条目（本地新增渠道插件等）
function mergeDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log(`[merge] ${src} -> ${dst}`);
}

// 1) 准备运行时目录
fs.mkdirSync(RUNTIME, { recursive: true });
console.log('=== dsh-runtime build' + (PACKAGE_MODE ? ' (package mode)' : '') + ' ===');

// 2) 复制补丁与插件（不复制 node_modules）
//    注意：合并而非清空——保留 dsh-runtime/plugins 下本地新增的渠道插件
if (fs.existsSync(SRC_PATCHES)) copyDir(SRC_PATCHES, path.join(RUNTIME, 'patches'));
if (fs.existsSync(SRC_PLUGINS)) mergeDir(SRC_PLUGINS, path.join(RUNTIME, 'plugins'));
console.log(`[info] patches/plugins merged from ${SRC_APP}`);

// 3) Windows 本机 npm install
run('npm install --no-audit --no-fund --loglevel=error', RUNTIME);

// 3.5) sharp 健康检查（npm 增量更新可能损坏 @img/sharp-win32-x64 缺 index.cjs，
//      导致 dsh 的 attachment-local 插件加载失败 → dsh 启动 exit 1）
const sharpProbe = `
try { const s = require('./node_modules/sharp'); if (!s.versions || !s.versions.sharp) process.exit(1); }
catch (e) { console.log('SHARP_BROKEN: ' + e.message.slice(0, 80)); process.exit(2); }
`;
let probe = spawnSync(process.execPath, ['-e', sharpProbe], { cwd: RUNTIME, encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('[sharp] broken, reinstalling @img/sharp-win32-x64 ...');
  run('npm install @img/sharp-win32-x64@0.35.3 --no-audit --no-fund', RUNTIME);
  probe = spawnSync(process.execPath, ['-e', sharpProbe], { cwd: RUNTIME, encoding: 'utf8' });
}
console.log('[sharp] ' + (probe.status === 0 ? 'OK' : 'STILL BROKEN'));
if (probe.status !== 0) process.exit(1);

// 4) 应用定制补丁（等价 fnos-dsh/app/apply-patches.sh）
if (fs.existsSync(path.join(RUNTIME, 'patches', 'files', 'node_modules'))) {
  fs.cpSync(
    path.join(RUNTIME, 'patches', 'files', 'node_modules'),
    path.join(RUNTIME, 'node_modules'),
    { recursive: true }
  );
  console.log('[patches] node_modules overrides applied');
}
// 4) 渠道插件：plugins/dsh-channel-* -> node_modules/@deepseek-ai/（全部渠道通用）
{
  const pluginsDir = path.join(RUNTIME, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    const channelDirs = fs.readdirSync(pluginsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (d.name.startsWith('dsh-channel-') || d.name.startsWith('dsh-browser-') || d.name.startsWith('browser-agent') || d.name === 'dsh-browser-agent'))
      .map((d) => d.name);
    for (const ch of channelDirs) {
      const src = path.join(pluginsDir, ch);
      if (!fs.existsSync(path.join(src, 'package.json')) || !fs.existsSync(path.join(src, 'lib', 'index.js'))) {
        console.log('[patches] SKIP incomplete channel plugin: ' + ch);
        continue;
      }
      fs.mkdirSync(path.join(RUNTIME, 'node_modules', '@deepseek-ai'), { recursive: true });
      fs.cpSync(src, path.join(RUNTIME, 'node_modules', '@deepseek-ai', ch), { recursive: true });
      console.log('[patches] channel plugin installed: ' + ch);
    }
  }
}

// 4.5) 汉化（hanhua.cjs 批量替换硬编码英文）
run('node scripts/hanhua.cjs "' + path.join(ROOT, 'dsh-runtime') + '"', ROOT);

// 4.6) 捆绑官方 node.exe（目录选择器 worker 专用）
//      koffi 的 FFI 调用在 Electron V8 下崩溃，worker 必须用独立官方 Node 运行
const LOCAL_NODE = 'C:/Program Files/nodejs/node.exe';
if (fs.existsSync(LOCAL_NODE)) {
  fs.copyFileSync(LOCAL_NODE, path.join(RUNTIME, 'node.exe'));
  const v = execSync('node -e "console.log(process.version)"').toString().trim();
  console.log(`[package] bundled node.exe ${v}`);
} else {
  console.warn('[package] WARN: local node.exe not found, worker will fallback to process.execPath');
}

// 4.7) 复制托盘图标到运行时（打包版托盘从 resources/dsh-runtime/ 读取）
const ICON_SRC = path.join(ROOT, 'build', 'icon.ico');
if (fs.existsSync(ICON_SRC)) {
  fs.copyFileSync(ICON_SRC, path.join(RUNTIME, 'icon.ico'));
  console.log('[package] icon.ico copied to runtime');
}
const TRAY_PNG_SRC = path.join(ROOT, 'build', 'tray.png');
if (fs.existsSync(TRAY_PNG_SRC)) {
  fs.copyFileSync(TRAY_PNG_SRC, path.join(RUNTIME, 'tray.png'));
  console.log('[package] tray.png copied to runtime');
}

// 4.8) 生成技能/插件市场数据（随包，市场窗口读取）
const MARKET_OUT = path.join(RUNTIME, 'market');
fs.mkdirSync(MARKET_OUT, { recursive: true });
const skillMarket = [
  { id: 'web-search', name: '网页搜索', description: '联网搜索最新信息并汇总要点，适合时效性查询', version: '1.0.0', author: 'DSH' },
  { id: 'web-fetch', name: '网页抓取', description: '抓取指定网页内容并提炼核心信息', version: '1.0.0', author: 'DSH' },
  { id: 'file-ops', name: '文件操作', description: '读写本地文件、批量整理目录、格式转换', version: '1.0.0', author: 'DSH' },
  { id: 'goal-driver', name: '目标驱动', description: '/goal 长任务多轮自动推进，每轮结束校验', version: '1.0.0', author: 'DSH' },
  { id: 'subagent', name: '子智能体', description: 'general-purpose / Explore 子智能体协作', version: '1.0.0', author: 'DSH' },
  { id: 'doc-process', name: '文档处理', description: '阅读与生成 Word/PDF/Markdown，总结、润色、改写', version: '1.0.0', author: 'DSH' },
  { id: 'data-analysis', name: '数据分析', description: '处理 Excel/CSV，统计汇总、透视、可视化建议', version: '1.0.0', author: 'DSH' },
  { id: 'slide-deck', name: '幻灯片生成', description: '从内容大纲生成结构化 PPT 方案与逐页文案', version: '1.0.0', author: 'DSH' },
  { id: 'screen-capture', name: '屏幕分析', description: '读取截图/图片内容，识别界面元素与问题', version: '1.0.0', author: 'DSH' },
  { id: 'email-draft', name: '邮件起草', description: '根据要点生成正式商务邮件，含主题与称呼落款', version: '1.0.0', author: 'DSH' },
  { id: 'code-review', name: '代码审查', description: '审查代码改动：风格、逻辑、安全、性能问题', version: '1.0.0', author: 'DSH' },
  { id: 'competitor-analysis', name: '竞品分析', description: '拆解竞品功能/定价/优劣，输出对比结论', version: '1.0.0', author: 'DSH' },
  { id: 'schedule-planning', name: '日程规划', description: '把待办事项整理成时间表，排出优先级', version: '1.0.0', author: 'DSH' },
  // 0.3.0 新增（对齐 Octop 能力面）
  { id: 'weekly-report', name: '周报生成', description: '汇总一周工作产出，输出结构化周报', version: '1.0.0', author: 'DSH' },
  { id: 'meeting-minutes', name: '会议纪要', description: '从会议记录/录音转写提取决议、待办与风险', version: '1.0.0', author: 'DSH' },
  { id: 'translate-polish', name: '翻译润色', description: '中英互译与文本润色，保持语气与术语一致', version: '1.0.0', author: 'DSH' },
  { id: 'browser-automation', name: '浏览器自动化', description: '用内置浏览器+屏幕快照完成网页操作与信息采集', version: '1.0.0', author: 'DSH' },
  { id: 'schedule-tasks', name: '定时任务编排', description: '用自然语言描述周期任务，编排 /schedule 自动执行', version: '1.0.0', author: 'DSH' },
  { id: 'im-ops', name: 'IM 群助手运营', description: '在 IM 渠道（钉钉/飞书/企微等）回复消息、推送通知', version: '1.0.0', author: 'DSH' }
];
const pluginMarket = [
  { id: 'channel-dingtalk', name: '钉钉 IM 渠道', description: '接入钉钉机器人，IM 中直接对话推进任务（需配置 AppKey/Secret）', version: '1.0.0', author: 'DSH', builtin: true },
  { id: 'channel-feishu', name: '飞书 IM 渠道', description: '飞书机器人长连接接入，双向对话（需 App ID/Secret）', version: '1.0.0', author: 'DSH', builtin: true },
  { id: 'channel-discord', name: 'Discord IM 渠道', description: 'Discord Bot 接入，频道/私信双向对话（需 Bot Token）', version: '1.0.0', author: 'DSH', builtin: true },
  { id: 'channel-wecom', name: '企业微信 IM 渠道', description: '群机器人推送 + 可选回调入站（需 Webhook Key）', version: '1.0.0', author: 'DSH', builtin: true },
  { id: 'channel-qq', name: 'QQ 机器人 IM 渠道', description: 'QQ 官方机器人接入，群/私聊双向对话（需 AppID/Token）', version: '1.0.0', author: 'DSH', builtin: true },
  { id: 'mcp-client', name: 'MCP 客户端', description: '连接外部 MCP 服务器，扩展工具生态', version: '1.0.0', author: 'DSH' },
  { id: 'workflow', name: '工作流引擎', description: '可视化 DAG 工作流编排与自动执行', version: '1.0.0', author: 'DSH' }
];
fs.writeFileSync(path.join(MARKET_OUT, 'skill-market.json'), JSON.stringify(skillMarket, null, 2), 'utf8');
fs.writeFileSync(path.join(MARKET_OUT, 'plugin-market.json'), JSON.stringify(pluginMarket, null, 2), 'utf8');
console.log('[package] market data written (skills=' + skillMarket.length + ', plugins=' + pluginMarket.length + ')');

// 真实技能包：SKILL.md（YAML frontmatter: name + description），安装时复制到 DSH_HOME/skills/<id>/
const SKILL_DOCS = {
  'web-search': `# 网页搜索

用联网搜索工具获取最新信息，回答时效性/事实性问题。

## 要点
1. 用 web search 工具检索关键词，读取 3-5 个来源
2. 优先权威来源（官方文档、主流媒体），交叉验证
3. 回答时给出结论 + 关键来源 + 日期，注明不确定性
4. 若搜索无结果，换关键词或尝试英文检索再试
`,
  'web-fetch': `# 网页抓取

抓取指定网页内容并提炼信息。

## 要点
1. 用 web fetch 工具读取页面，必要时带抓取提示词
2. 大型页面分段读取，聚焦用户要的信息
3. 提炼成结构化要点（结论先行），保留关键原文引用
4. 页面加载失败时检查 URL 合法性，或改用搜索找镜像
`,
  'file-ops': `# 文件操作

读写本地文件、整理目录、格式转换。

## 要点
1. 先确认工作目录与目标路径，避免越权读写
2. 修改文件前先备份原文件（另存副本）
3. 批量操作用脚本执行，展示执行结果摘要
4. 大文件分块处理，避免一次性读入内存
5. 删除操作必须二次确认，绝不永久删除用户文件（用回收站）
`,
  'goal-driver': `# 目标驱动

用 /goal 设定长任务目标，agent 多轮自动推进直至完成。

## 要点
1. 目标要可测量：明确输入、输出、验收标准
2. 复杂目标拆成阶段性子目标，每轮结束校验进度
3. 中途受阻时说明阻碍并给出调整方案，不静默跳过
4. 完成后总结交付物位置与验收结果
`,
  'subagent': `# 子智能体

用子智能体并行处理独立子任务，主线程统筹。

## 要点
1. 独立任务（调研/搜索/审查）派给 general-purpose 子智能体
2. 代码检索/定位用 Explore 子智能体，快速且省上下文
3. 给子智能体的任务要自包含：目标、约束、输出格式
4. 汇总子智能体结果时交叉校验，标注每个结论的来源
`,
  'doc-process': `# 文档处理

阅读与生成 Word/PDF/Markdown 文档，总结、润色、改写、转换格式。

## 要点
1. 先读取文档全文（大文档分段），再判断任务：总结/润色/改写/转换
2. 输出 Word 用 .docx，轻量内容用 .md，正式交付用 .pdf
3. 总结给出结构：结论先行 + 分点要点 + 关键引用
4. 润色保留原意，调整语气与结构；改写明确目标读者
5. 交付文件放到工作区目录并告知路径
`,
  'data-analysis': `# 数据分析

处理 Excel/CSV 数据：统计汇总、透视、筛选、可视化建议。

## 要点
1. 先读表头与样例行，确认列含义与数据类型
2. 统计用公式/脚本计算：总量、均值、分布、环比
3. 透视汇总：按维度分组聚合，输出表格
4. 可视化建议：趋势用折线、占比用饼图/堆叠、对比用柱状
5. 输出结论 + 数据支撑 + 异常点说明，交付表格文件
`,
  'slide-deck': `# 幻灯片生成

从内容大纲生成结构化 PPT 方案与逐页文案。

## 要点
1. 先确认用途与受众：汇报/路演/教学，页数规模
2. 结构：封面 → 目录 → 分节正文 → 结论/行动项
3. 每页一观点：标题一句话结论，正文要点化（3-5 条）
4. 数据页配图表建议，引用页标注来源
5. 交付 PPT 文件到工作区并说明页结构
`,
  'screen-capture': `# 屏幕分析

读取截图/图片内容，识别界面元素、数据与问题。

## 要点
1. 用视觉能力读取图片：识别文字、布局、元素
2. 界面截图：描述布局 → 找问题（错位/缺失/文案）→ 给修复建议
3. 数据截图：提取表格数据，核对与整理
4. 代码截图：还原代码并指出问题
5. 输出结构化分析，必要时给操作步骤
`,
  'email-draft': `# 邮件起草

根据要点生成正式商务邮件。

## 要点
1. 确认收件人身份/关系与邮件目的（通知/请求/跟进/致谢）
2. 结构：主题（一句话含动作与时限）→ 称呼 → 背景 → 要点 → 行动项/时限 → 落款
3. 语气匹配关系：正式（对外/上级）vs 友好（同事/熟人）
4. 要点用编号或短句，避免大段；结尾明确期望回复
5. 输出主题 + 正文，供直接复制发送
`,
  'code-review': `# 代码审查

审查代码改动：风格、逻辑、安全、性能。

## 要点
1. 先看改动范围（diff/文件清单），再逐文件读关键逻辑
2. 检查项：命名与风格、边界与空值、异常处理、安全问题（注入/权限/密钥）、性能（循环/IO/内存）
3. 按严重度分级：必须修复 / 建议 / 可选
4. 每条意见给出行号与修复建议，不空泛评价
5. 输出审查结论 + 问题清单 + 优先级
`,
  'competitor-analysis': `# 竞品分析

拆解竞品功能、定价、优劣，输出对比结论。

## 要点
1. 明确分析维度：功能/定价/体验/生态/口碑
2. 信息收集：官网、文档、定价页、商店评论、行业报告
3. 用表格对比，标注信息来源与时间
4. 结论聚焦：我们可借鉴什么、需回避什么、差异化在哪
5. 输出结构化报告：概览 → 对比表 → 洞察 → 建议
`,
  'schedule-planning': `# 日程规划

把待办事项整理成时间表，排出优先级。

## 要点
1. 收集全部待办，标注截止时间与依赖
2. 按紧急/重要四象限分优先级
3. 排时间表：重要紧急优先，同类任务合并，留缓冲
4. 输出：优先级列表 + 时间表 + 风险提醒（撞期/超负荷）
5. 时间粒度匹配任务规模（分钟/小时/天）
`,
  'weekly-report': `# 周报生成

汇总一周工作产出，输出结构化周报。

## 要点
1. 先收集素材：本周任务/会话/交付物（可让用户粘贴或读取工作区文件）
2. 结构：本周完成 → 进行中 → 下周计划 → 风险与求助
3. 每条产出写明结果与影响，用数据支撑（完成项、数字、链接）
4. 语气客观简洁，按团队模板调整格式
5. 输出可直接粘贴的周报文本，必要时生成 .md 文件
`,
  'meeting-minutes': `# 会议纪要

从会议记录/转写提取决议、待办与风险。

## 要点
1. 先明确会议主题与参会人（无则推断）
2. 提取：结论/决议、待办（负责人+截止）、风险与遗留问题
3. 待办用表格：事项 | 负责人 | 截止 | 状态
4. 保持客观，不臆造；原文含糊处标注"待确认"
5. 输出结构化纪要文本，可生成 .md 文件
`,
  'translate-polish': `# 翻译润色

中英互译与文本润色，保持语气与术语一致。

## 要点
1. 先确认目标语言与用途（正式/口语/技术文档）
2. 术语保持一致：技术词、专有名词首次出现标注原文
3. 翻译不逐字直译，按目标语言习惯重排句子结构
4. 润色保留原意，调整语气、节奏与用词
5. 输出译文 + 关键术语对照表（可选）
`,
  'browser-automation': `# 浏览器自动化

用内置浏览器 + 屏幕快照完成网页操作与信息采集。

## 要点
1. 需要浏览器内操作时：打开内置浏览器（托盘/面板），引导用户或脚本访问目标页
2. 采集信息用网页抓取/搜索优先，避免无谓的浏览器操作
3. 需要视觉确认时：截屏（托盘"捕获屏幕"或面板快捷操作）后读取分析
4. 登录态、验证码等无法自动化的步骤明确告知用户手动完成
5. 交付：采集结果结构化输出，保存到工作区
`,
  'schedule-tasks': `# 定时任务编排

用自然语言描述周期任务，编排 /schedule 自动执行。

## 要点
1. 明确任务内容、执行周期（cron 或自然语言）与首次执行时间
2. 用 /schedule 命令创建/查看任务（对话输入 / 查看命令列表）
3. 任务描述要自包含：做什么、输出到哪、失败怎么办
4. 结合 IM 渠道：可让任务完成后推送到钉钉/飞书/企微群
5. 定期检查任务执行历史，清理失效任务
`,
  'im-ops': `# IM 群助手运营

在 IM 渠道（钉钉/飞书/Discord/QQ/企业微信）中回复消息、推送通知。

## 要点
1. 前置：设置 → IM 渠道 配置对应机器人凭据，重启应用
2. 回复群消息时先理解上下文（@ 提及/私聊），回答简洁、行动导向
3. 敏感信息（密码/Token/内部数据）绝不发到群里
4. 需要主动推送时：用定时任务编排，让任务完成后推送到群
5. 消息过长时摘要后分段发送，遵守各渠道长度限制
`
};
fs.mkdirSync(path.join(MARKET_OUT, 'skills'), { recursive: true });
for (const it of skillMarket) {
  const dir = path.join(MARKET_OUT, 'skills', it.id);
  fs.mkdirSync(dir, { recursive: true });
  const body = SKILL_DOCS[it.id] || '# 技能\n\n（待补充说明）\n';
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    `---\nname: ${it.id}\ndescription: ${it.description}\n---\n\n${body}`, 'utf8');
}
console.log('[package] skill bundles written (' + Object.keys(SKILL_DOCS).length + ' SKILL.md)');

// 5) 生成桌面版 patch-web.yaml（本机 127.0.0.1，多渠道凭据走数据目录 .env）
//    渠道 insert 段由 electron/channels.js 的注册表生成（与设置窗口展示一致）
const channelsMod = require('../electron/channels.js');
function renderInsertBlock(entries) {
  const lines = [];
  for (const e of entries) {
    lines.push(`    - id: ${e.id}`);
    lines.push(`      name: '${e.name}'`);
    lines.push('      config:');
    for (const [k, v] of Object.entries(e.config || {})) {
      lines.push(`        ${k}: ${v}`);
    }
  }
  return lines.join('\n');
}
const patchWeb = `# dsh-desktop patch overlay（桌面版）
# 本机应用：webserver 仅监听 127.0.0.1（比 NAS 版更安全）
- id: webserver
  config:
    host: 127.0.0.1
    port: 3080

# AI 智能浏览器插件（侧边面板 → dsh agent → 浏览器操作）
- insert:
    - id: browser-agent
      name: '@deepseek-ai/dsh-browser-agent'
      config:
        enabled: true

# Web UI 皮肤中心（@linxin666/dsh-skins 全家桶：skin-center + 全部皮肤资产）
- insert:
    - id: web-ui-skin-center
      name: '@linxin666/dsh-client-ui-skin-center'

# Web UI 功能全家桶（@linxin666/dsh-web-ui-all，跳过 aionui-panel 右侧面板与本项目冲突、皮肤中心已在上方）
- insert:
    - id: web-ui-compat
      name: '@linxin666/dsh-web-ui-all'
    - id: web-ui-settings
      name: '@linxin666/dsh-client-ui-web-ui-settings'
    - id: web-ui-community-plugins
      name: '@linxin666/dsh-client-ui-community-plugins'
    - id: web-ui-task-board
      name: '@linxin666/dsh-client-ui-task-board'
    - id: web-ui-git-graph
      name: '@linxin666/dsh-client-ui-git-graph'
    - id: web-ui-pet
      name: '@linxin666/dsh-pet'
    - id: web-ui-live-stats
      name: '@linxin666/dsh-live-stats'
    - id: web-ui-ssh
      name: '@linxin666/dsh-ssh'
    - id: web-ui-describe-image
      name: '@linxin666/dsh-tool-describe-image'
    - id: web-ui-liangshen
      name: '@linxin666/dsh-liangshen'

# IM 渠道插件（单聊 MVP）
# 凭据通过数据目录 ~/.dsh/.env 注入（设置 → IM 渠道 配置），未配置则禁用
- insert:
${renderInsertBlock(channelsMod.patchInsertBlock())}
`;
fs.writeFileSync(path.join(RUNTIME, 'patch-web.yaml'), patchWeb, 'utf8');
console.log('[patches] patch-web.yaml written (desktop: 127.0.0.1:3080, channels=' + channelsMod.patchInsertBlock().length + ')');

// 5.5) 上游 rc.7 替换：从 RC7_SRC（上游构建目录 packages/）覆盖官方包 lib/
//      上游 rc.7 未发 npm，须从源码构建后在此替换；RC7_SRC 未设置则跳过（用 npm 版 rc.6）
const RC7_SRC = process.env.RC7_SRC || '';
if (RC7_SRC && fs.existsSync(path.join(RC7_SRC, 'packages'))) {
  const nodeModulesAi = path.join(RUNTIME, 'node_modules', '@deepseek-ai');
  let rc7Replaced = 0;
  const rc7Walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === 'node_modules' || d.name.startsWith('.')) continue;
      const p = path.join(dir, d.name);
      const pf = path.join(p, 'package.json');
      if (fs.existsSync(pf)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pf, 'utf8'));
          if (pkg.name && pkg.name.startsWith('@deepseek-ai/')) {
            const target = path.join(nodeModulesAi, pkg.name.replace('@deepseek-ai/', ''));
            if (fs.existsSync(target)) {
              const lib = path.join(p, 'lib');
              if (fs.existsSync(lib)) fs.cpSync(lib, path.join(target, 'lib'), { recursive: true, force: true });
              fs.copyFileSync(pf, path.join(target, 'package.json'));
              rc7Replaced++;
            }
          }
        } catch { /* ignore */ }
      } else rc7Walk(p);
    }
  };
  rc7Walk(path.join(RC7_SRC, 'packages'));
  console.log('[rc7] upstream lib replaced: ' + rc7Replaced + ' official packages');
  // rc.7 替换覆盖了汉化文件 → 重跑汉化（命令菜单/权限/界面中文化）
  run('node scripts/hanhua.cjs "' + path.join(ROOT, 'dsh-runtime') + '"', ROOT);
  console.log('[rc7] hanhua re-applied after rc.7 replace');
} else {
  console.log('[rc7] RC7_SRC not set, keeping npm rc.6 packages');
}

// 6) 校验
const entry = path.join(RUNTIME, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
if (!fs.existsSync(entry)) {
  console.error('FATAL: dsh entry missing: ' + entry);
  process.exit(1);
}
const dshVer = JSON.parse(
  fs.readFileSync(path.join(RUNTIME, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
).version;

// 7) 清理：移除测试/运行期产物（testdata、日志），确保安装包干净
for (const name of ['testdata', 'logs', 'dsh-node_modules.zip']) {
  fs.rmSync(path.join(RUNTIME, name), { recursive: true, force: true });
}
console.log('[clean] testdata/logs removed');

// 8) package 模式：node_modules 归档为单文件 zip，然后删除散文件
//    —— 安装器只复制 1 个归档（秒装），应用首次启动自解压到版本目录
if (PACKAGE_MODE) {
  const nmDir = path.join(RUNTIME, 'node_modules');
  const zipPath = path.join(RUNTIME, 'dsh-node_modules.zip');
  if (!fs.existsSync(nmDir)) {
    console.error('FATAL: node_modules missing for packaging');
    process.exit(1);
  }
  const sevenZip = CANDIDATE_7ZA.find((p) => fs.existsSync(p));
  let archiveCmd;
  if (sevenZip) {
    archiveCmd = `"${sevenZip}" a -tzip -mx=5 -mmt=on "${zipPath}" node_modules node.exe`;
    console.log('[package] using 7za: ' + sevenZip);
  } else {
    // libarchive 按扩展名自动选 zip 格式
    archiveCmd = `"${SYSTEM_TAR}" -a -cf "${zipPath}" node_modules node.exe`;
    console.log('[package] using system tar (libarchive)');
  }
  console.log('[package] archiving node_modules -> dsh-node_modules.zip ...');
  const t0 = Date.now();
  run(archiveCmd, RUNTIME);
  console.log(`[package] archive done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const zSize = fs.statSync(zipPath).size;
  fs.rmSync(nmDir, { recursive: true, force: true });
  fs.rmSync(path.join(RUNTIME, 'node.exe'), { force: true }); // zip 内已有，避免重复打包
  console.log(`[package] node_modules archived (${(zSize / 1048576).toFixed(1)} MB) & removed`);
} else {
  console.log('[package] dev mode, node_modules kept (skip --package)');
}

console.log(`[ok] dsh runtime built, dsh version=${dshVer}`);
