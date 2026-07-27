---
name: workflow-authoring
description: 根据业务请求和现有 Blueprint 模式创建独立的 tutti.flow.v1 Bundle。
---

# 持久化 Flow 编写

在 `draft.flow/` 中创建完整 Flow Bundle。Bundle 是编写阶段的模版产物，运行时必须
完全独立；绝不能从 Blueprint 继承代码。

编写前阅读 `dsl-reference.md`、`patterns.md` 和 `blueprint-guide.md`。

## 工作循环

1. 将请求转换为一个持久化 Cycle：根节点、等待点、终态结果以及下一个 Cycle。
2. 按能力搜索一次 Blueprint，并使用 `blueprints get --include-script` 检查结构最接近
   的完整 Bundle。
3. 判断哪些工作是确定性的（`script`）、外部写操作（`effect`）、外部状态观察
   （`gate`）、智能工作（`agent`）或产品原生决策（`human`）。
4. 编写 `draft.flow/flow.js` 以及 `scripts/` 下引用的文件。仅在声明 Memory 时添加
   `memory.template.md`。
5. 在不执行任何 Bundle 代码的情况下验证：

   `tutti --json dynamic-workflows authoring validate --job-id <job-id> --directory draft.flow --review-mode agent`

6. 修复每个错误，等待独立审查，并处理所有发现：

   `tutti --json dynamic-workflows authoring review wait --job-id <job-id>`

7. 将审查后的 Bundle 作为不可变 Draft 提交：

   `tutti --json dynamic-workflows authoring submit --job-id <job-id> --directory draft.flow`

8. 只有响应包含 `accepted: true` 和 `versionStatus: "draft"` 时才算完成交付。Publish
   和 Activate 由用户决定；不要执行这两项操作。

## 不可妥协的规则

- `flow.js` 是声明式文件，不得包含 import 或运行时执行。
- Script、Gate、Effect 和 Finally 代码必须位于 Bundle 文件中。
- 每个 Effect 都有稳定的幂等键，并同时导出 `apply()` 和 `reconcile()`。
- Gate 每次只检查一次并返回 `waiting`；不得 sleep 或轮询。
- Schedule 从检查点恢复 Cycle；它不负责选择节点。
- 跨 Cycle 知识只能存放在 Markdown Memory 中。已完成的 Agent 会话不是隐藏 Memory。
- Loop 和 Map 是单个 Cycle 内的有界复合节点。
- 每个控制结果都必须如实到达 `completeCycle` 或 `cancelCycle`。
- Secrets 必须声明并绑定到提供方连接或环境变量名，而且只能注入通过
  `secrets: ["NAME"]` 明确列出它们的 Code 节点。不得插入 Agent 提示词，也不得
  出现在节点输出中。
- 如果 `meta.requiresCwd` 为 true，调用方必须在激活前配置项目 cwd。
- 使用清晰的节点 id 和 label：图、当前位置、Attempt 和审查历史都是面向用户的
  产品界面。
