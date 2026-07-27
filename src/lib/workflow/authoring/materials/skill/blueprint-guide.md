# Blueprint 指南

Blueprint 是不可变的编写模版，绝不是运行时依赖。每个公开 Blueprint 都是完整的
`tutti.flow.v1` Bundle。将最接近的 Bundle 复制到 `draft.flow/`，根据请求进行调整，
再提交最终的独立 Flow。

目录刻意保持精简。按能力搜索一次并检查最接近的结果。如果结构并不接近，则直接参考
`dsl-reference.md` 起草；不要强行套用无关模版。

## 命令

```bash
tutti --json dynamic-workflows blueprints list
tutti --json dynamic-workflows blueprints search \
  --query "scheduled issue approval pull request" \
  --category coding
tutti --json dynamic-workflows blueprints get \
  --blueprint-id <id> \
  --include-script
```

`get --include-script` 返回 `bundle.files`，其中包括 `flow.js`、代码节点模块、
Memory 模版和文档。

## 按执行形态选择

将用户请求与以下方面比较：

- Cycle 边界和完成条件；
- 周期性 Schedule 与直接调用；
- Script、Gate、Effect、Agent 和 Human 的职责；
- 结束 Tick 但不结束 Cycle 的等待点；
- 副作用幂等性和对账；
- 有界 Loop/Map 工作和并行度；
- Params、Inputs、Secrets、项目 cwd 和 Memory 要求；
- completed、rejected、failed 和 canceled 终态路径。

仅匹配关键词是不够的。不能因为两者都提到拉取请求，就将单仓库维护循环视为跨仓库发布
的安全模版。

## 调整检查清单

1. 复制完整 Bundle，而不是只复制 `flow.js`。
2. 根据实际场景重写元数据、schema 声明、节点 id、label、提示词、代码模块和终态行为。
3. 确定性工作放在 Script，观察放在 Gate，每个外部写操作都放在带 `reconcile()` 的
   幂等 Effect 中。
4. 确保每个 waiting Gate 都能观察到可能在计划 Tick 之间发生变化的状态。绝不能在
   Gate 内 sleep 或轮询。
5. 有意识地重建引用。Secrets 不得进入提示词、输出、日志或 Memory。
6. 保留有界运行时预算，并让每个控制结果都到达符合事实的终态。
7. 删除所有模版特有的名称和假设。
8. 提交前验证完整 Bundle 并运行独立语义审查。

## 当前场景模版

`large-file-governance-v1` 演示参考持久化自动化：定时代码仓库同步、确定性大文件发现、
Agent 规划、幂等 Issue 创建、审批 Gate、Agent 实现、幂等 PR 创建、合并 Gate、
Issue 关闭、Markdown Memory 更新，以及立即创建下一个 Cycle。其他 Issue 到 PR 的
治理循环可以调整其结构；如果目标系统或审批模型不同，则应完整替换其中的 GitHub 模块。
