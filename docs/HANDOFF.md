# 交接（HANDOFF）

给下一个对话的自己或别人：这份文件是当前状态的唯一入口。看完就不用去翻 300 多轮的历史。

最后更新：2026-11-07 · 当前 HEAD · 未推送 32 个提交

## 这是什么

DSH 插件 **盆栽 / dsh-bonsai**：对话树的编辑与压缩。给一段对话建树（每个问题挂到它依赖的回答下），
历史变大时把旧轮次折叠成占位符，模型需要细节时用 `retrieve_context` 取回原文；另有一条"少发前缀"
的省 token 路线（工具裁剪、候选块、检索提示）。

仓库：`D:\dsh-token-tree`，发布名 `dsh-bonsai`，实际安装位置
`C:\Users\ASUS\.dsh\profiles\desktop\node_modules\dsh-bonsai`（重启桌面端生效）。

## 现在能用的功能

| 功能 | 状态 | 关键位置 |
|---|---|---|
| 对话树 / 图视图 / 分支锚定 | 可用 | `client/client.js`、`src/plugin/blocks.ts` |
| 折叠（按待折块触发） | 可用 | `src/plugin/fold.ts`、`hooks.ts` |
| 折叠被注入消息误判 | 已修：先记 `seq→turn` 再跳过 token-tree/compact-checkpoint | `fold.ts: planTurnFold` |
| 折叠时机（轮次关闭前） | 已修 | `agent/turn-stopping` 而不是 `turn/end` |
| attach / summary 标记 | 已修：只删结尾，合成 step 写入，保留非文本 block | `hooks.ts: stripMarkers`、`markers.ts` |
| 设置页（首屏 2 行 + 高级） | 重写过 | `client/client.js` |
| 预设（只建树/日常默认/写代码/保上下文/极省） | 可用；切换时整包清除旧键；按钮下方带一行说明 | `src/plugin/presets.ts` |
| 全局 / 本对话作用域 | 大部分可用；tokenizer 是全局设置 | `settings.ts`、`service.effective(sessionId)` |
| 可选 BGE 检索 | config `bge:true`；chunk meanAll 只作用于 `retrieve_context`；失败回落 hash | `bge.ts`、`service.retrieveAsync` |
| 两阶段检索 | `retrieve_context` 默认返回索引，传 `nodeId` 取详情 | `tools.ts` |
| 每轮摘要 | `attachSummary` 默认 `true`；模型标记优先，缺失时 200 字启发式 | `service.summaryInstruction`、`hooks.ts` |
| 提示时机 | 第一次折叠后才发 `retrievalHint`；`hintAboveTokens` 只作诊断 | `service.baseHint`、`hasFolded` |
| 诊断命令 | 可用 | `/prompt` `/fold` `/usage` `/retrieve` `/tree` |

```text
pnpm run test   → 252 passed（类型检查单独跑）
pnpm run typecheck
pnpm run build && node scripts/stage.mjs  然后复制 plugin/ 到 profile
```

## 关键设计（别改错）

- **折叠阈值量的是"待折块"**，不是整段历史：块 ≥ `foldAboveTokens`(默认 30000) 且 ≥
  `foldBlockRatio`(8) × 保留窗口(2 轮)，且距上次折叠 ≥ `foldCadence`(10) 轮。参数扫描见
  `docs/experiments/fold-param-sweep.md`，推导见 `docs/experiment-context-cache.md` 实验 38/39。
- **折叠必须在 `agent/turn-stopping` 里追加**（此时轮次还开着）。宿主读取日志时会校验
  "surface 替换必须在打开的轮次内"，在 `turn/end` 之后追加会让日志**下次读取时**被判损坏。
- **标记剥离也必须包在一个打开的 step 里**：`assistant/message` 的 surface 替换要求当前
  step 打开；turn-stopping 时宿主已经写了 `step/end`，所以剥离会临时 append
  `step/start → replacement → step/end`。只删结尾标记，保留 tool-call/图片/reasoning 等
  非文本 block，代码围栏里的示例不动。
- **轮次号由插件自己数**：宿主 0.2.1-rc.5 不再给 surface 事件标 turn，插件在 user 消息处自增
  （`service.applyEvent`），**先自增再写 `seqTurns`**；`seqTurns` 记录每个事件属于哪一轮。
- **surface replacement 不入树**：插件自己 append 的折叠/标记替换是 view 操作，`applyEvent`
  直接跳过；否则重放会把同一个答案/工具结果再加一个节点，token 和检索都会被放大。
- **插件追加事件的 reentrancy**：在 `session/event` 回调里同步 append 会被宿主拒绝，必须
  在 turn-stopping 或 setTimeout 里做。

## 已知问题（按优先级）

1. **当前会话 3d7b782b 的正文标记**：dry run 命中 19 个 frame / 39 处正则，但只有 **2 条**
   回答真的以标记结尾；其余是 fenced code block 和正文引用。`clean-marker-text.mjs` 已改成
   只删结尾标记、跳过 code fence；仍然**不要**在 app 运行时清理活跃会话。
   退出桌面端后先 `--session 3d7b782b`（dry run）确认只剩 2 个 frame，再 `--write`；
   改完用宿主加载验证。不要无参数 `--write` 全量扫。
2. **3 个损坏会话**：
   - `afebc0a3`：`tool/result is outside an open turn`。不是异步任务原始结果：解码后 seq 47/58
     是带 `surfaceOp: replace` 的 `tool/result`，在 `turn/end` 之后，和折叠 bug 同类。
     修复需逐帧，在偏离点插合成 `turn/start`；每次改完用宿主验证加载。
   - `69ea4cc5`、`e8734fe5`：`session event at seq 40 lacks an identified message`。
     原因是 seq 40 的 `user/message` 带 `source.kind='token-tree'` 但没有 `id`；`360db97`
     已给 fold 生成的 user message 补 `id`。旧日志仍坏，需要单独修或放弃。
3. 历史标记清理情况：只有 **20** 个 `.bak-*`，dry run 仍有 **5** 个会话命中；之前“40 个已清理”
   的说法不准确。41 个实验会话已移到
   `~/.dsh/sessions-test-backup-2026-11-05T15-55-50-643Z/`（含 manifest.json，搬回来即恢复）。
4. `~/.dsh/token-tree/settings.json` 现在只有 `{}`：18 条会话覆盖和 11 个全局键都已清掉。

## 实验与数据

- `docs/experiment-context-cache.md`：全部实测记录（53 节，含失败实验）。
  **文档里的数字都有前提和样本量，引用时一起引。**
- `docs/experiments/*.json`：标注集（18 条学习 / 8 条同义改写 / 15 条必须跳转）与探针结果。
- 关键结果：整体检索没有显示召回增益（父回答进结果 23%、rank1 11%）；BM25 / jieba 没有显著提升。
  BGE 的**答案排序**有明显增益（40 题 BGE chunk meanAll rank1 17/top3 22 vs hash 4/14，
  MRR 0.541 vs 0.292；同义改写 5/8 vs 1/8，跳转 11/15 vs 3/15），但学习标注只有 1/17，
  不能替代挂树规则；长回答仍受 512 token 截断，且模型依赖不适合零依赖默认包。
  见 `docs/experiments/bge-vs-hash-embedding.md`。
- semanticJump 的 40 条反事实边标注：BGE whole 85.0% vs hash 62.5% vs chunk meanAll 72.5%；
  边相似度适合整段向量，不适合检索用的 chunk 平均。边权暂未默认接 BGE。
  见 `docs/experiments/semantic-jump-results.md`。
- 真机三臂 A/B（web，折叠已修复）：5/5 全对、tool calls 全 0；default prompt token **-15.4%**、
  aggressive **-36.3%**（相对 no-plugin），aggressive 比 default 少 **24.8%**。
  折叠次数 default 7、aggressive 10。见 `docs/experiments/ab-live-fold-fixed.md`。
  旧的 headless 对照见 `docs/experiments/ab-live-three.md`（未折叠，不作结论）。

## 规矩（务必遵守）

1. **不发布、不推 tag**，除非这一条对话里明确说"发布"。push 也只在你被要求时做。
2. **不要在桌面端运行时覆盖插件目录**（会让渲染进程加载到不匹配的 bundle）。
3. **改会话日志前先备份**；改完必须用宿主 `session/page` 验证能加载；正在写的会话不要改。
4. 结论先读代码/日志再下，别凭印象（这个对话里我因此错过两次：折叠损坏归因、标记清理范围）。
5. 用户要求：**回答里不要输出 `[attach:…]` / `[summary: …]`**。

## 下一步建议

1. 退出桌面端后清 3d7b782b 的 **2** 个真实标记 frame（先 dry run 确认 19 → 2）；
2. 修 `afebc0a3` 那类“回合外 tool/result”（逐帧插合成 turn，改完用宿主加载验证）；
3. `69ea4cc5` / `e8734fe5` 旧日志已无法靠当前代码恢复（`360db97` 只防再产生）；
4. 复核本轮新加的回归测试：marker 结尾/围栏、fold turn 归属、surface replacement 去重、
   replay edits、node cap、settings scope、preset 整包、rule 持久化；
5. 决定是否推送这 32 个提交（README 审计、诊断命令、设置页重写、预设合并、作用域修复、标记剥离、调参…）。
