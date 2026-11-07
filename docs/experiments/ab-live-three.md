# 真机三臂 A/B（headless CLI）

日期：2026-11-07 13:45 +08:00  
模型：DeepSeek Flash（同一 API）  
数据：`docs/experiments/ab-live-three.json`

## 方法

- 三个独立会话，同一组 prompt：8 段长资料（每段约 6.5k token，含固定事实）+ 5 个针对早期事实的追问。
- `no-plugin`：不装插件。
- `default`：插件，`foldAbove=30000`、`keep=2`、`ratio=8`、`cadence=10`。
- `aggressive`：插件，`foldAbove=10000`、`keep=1`、`ratio=5`、`cadence=3`。
- 两个插件臂 `toolDeny=[]`，工具可见性一致。
- 所有 prompt 都要求不调用工具；实际运行中三臂 tool call 均为 **0**。
- 正确性按固定事实精确匹配，5 题。

## 结果

| 臂 | 正确 | input | cache read | output | tool calls |
|---|---:|---:|---:|---:|---:|
| no-plugin | 5/5 | 41,032 | 547,072 | 108 | 0 |
| default | 5/5 | 62,163 | 581,248 | 1,272 | 0 |
| aggressive | 5/5 | 52,109 | 587,648 | 651 | 0 |

合计 prompt tokens（input + cache read）：

| 臂 | 合计 | 相对 no-plugin |
|---|---:|---:|
| no-plugin | 588,104 | — |
| default | 643,411 | +9.4% |
| aggressive | 639,757 | +8.8% |

default 比 aggressive 多 3,654 prompt tokens（+0.6%），输出多 621 token。

## 解释

- **没有折叠发生。** 本次 headless CLI 会话里找不到任何 `已折叠` 占位；因此这些数字是**固定开销对照**，不是长会话折叠后的“最省”结论。
- 插件默认/省电臂都比 no-plugin 贵：多出的 5 个工具 schema、每轮 summary 指令、模型写出的 summary/attach 标记，合计约 **+9% prompt tokens**；aggressive 的摘要比 default 短，所以略便宜，但仍高于 no-plugin。
- 三臂质量都是 5/5，工具调用都是 0，说明这轮没有出现“插件导致答错/多调用工具”的问题。
- 要测“折叠后是否更省”，必须让宿主真正发出 `agent/turn-stopping`（桌面端/`dsh web`），或者用强制折叠的测试配置；headless CLI 这一轮没有走到折叠分支。
