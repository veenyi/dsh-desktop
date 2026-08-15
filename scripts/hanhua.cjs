// fnos-dsh 汉化脚本：批量替换 dsh 硬编码英文描述/标签（UTF-8）
// 用法: node hanhua.cjs <dir>
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2] || '.';

// 替换映射（精确字符串替换）
const REPLACEMENTS = [
  // 服务端命令描述
  ['"Compact older conversation history"', '"压缩较早的对话历史"'],
  ['"set or view the goal for a long-running task"', '"设置或查看长任务的执行目标"'],
  ['"record feedback about this session"', '"记录关于此会话的反馈"'],
  ['"Switch the permission preset (sandbox mode + approval policy)"', '"切换权限预设（沙箱模式 + 审批策略）"'],
  ['"Enter or leave plan mode"', '"进入或退出计划模式"'],
  ['"Download this Session log as a ZIP archive"', '"将会话日志下载为 ZIP 压缩包"'],
  // 客户端输入区权限显示：displayName → permissionValueLabel
  ['current === void 0 ? displayName(currentValue) : optionLabel(current)', 'current === void 0 ? permissionValueLabel(currentValue) : optionLabel(current)'],
];

// 需插入 permissionValueLabel 定义的文件（conversation client.js，optionLabel 函数后）
const CONV_FILE = path.join(ROOT, 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js');
const INSERT_AFTER = '			return option.value === FULL_ACCESS ? "Full access" : displayName(option.name);\n		}';
const INSERT_BLOCK = `			return option.value === FULL_ACCESS ? "Full access" : displayName(option.name);
		}
		function permissionValueLabel(value) {
			// fnos-dsh patch: 输入区权限值汉化
			const zh = { "read-only": "只读", "workspace-write": "工作区写入", "full-access": "完全访问", "danger-full-access": "完全访问" };
			return zh[value] ?? displayName(value);
		}`;

const files = [
  'node_modules/@deepseek-ai/dsh-command-compact/lib/index.js',
  'node_modules/@deepseek-ai/dsh-command-goal/lib/index.js',
  'node_modules/@deepseek-ai/dsh-command-feedback/lib/index.js',
  'node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js',
  'node_modules/@deepseek-ai/dsh-plan-mode/lib/index.js',
  'node_modules/@deepseek-ai/dsh-session-log-export/lib/index.js',
  'node_modules/@deepseek-ai/dsh-client-connection/lib/client.js',
  'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
];

let total = 0;
for (const rel of files) {
  const fp = path.join(ROOT, rel);
  if (!fs.existsSync(fp)) { console.log('SKIP (missing):', rel); continue; }
  let src = fs.readFileSync(fp, 'utf8');
  let changed = 0;
  for (const [from, to] of REPLACEMENTS) {
    let n = 0;
    while (src.includes(from)) { src = src.replace(from, to); n++; }
    if (n) { changed += n; console.log(`  ${rel}: '${from.slice(0, 50)}...' x${n}`); }
  }
  if (changed) { fs.writeFileSync(fp, src); total += changed; }
}

// conversation 插入 permissionValueLabel 定义
if (fs.existsSync(CONV_FILE)) {
  let src = fs.readFileSync(CONV_FILE, 'utf8');
  if (!src.includes('function permissionValueLabel')) {
    if (src.includes(INSERT_AFTER)) {
      src = src.replace(INSERT_AFTER, INSERT_BLOCK);
      fs.writeFileSync(CONV_FILE, src);
      console.log('  inserted permissionValueLabel into conversation client.js');
    } else {
      console.log('WARN: anchor not found for permissionValueLabel insertion');
    }
  } else {
    console.log('  permissionValueLabel already present');
  }
}
console.log('total replacements:', total);
