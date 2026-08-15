---
name: subagent
description: general-purpose / Explore 子智能体协作
---

# 子智能体

用子智能体并行处理独立子任务，主线程统筹。

## 要点
1. 独立任务（调研/搜索/审查）派给 general-purpose 子智能体
2. 代码检索/定位用 Explore 子智能体，快速且省上下文
3. 给子智能体的任务要自包含：目标、约束、输出格式
4. 汇总子智能体结果时交叉校验，标注每个结论的来源
