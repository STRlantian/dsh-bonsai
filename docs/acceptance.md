# 验收

四项验收标准逐条给出**可复现命令**与**实测输出**。全部命令在 `D:\dsh-token-tree` 下执行。

```powershell
node --test --test-isolation=none "tests/**/*.test.ts"   # 36 passed
node scripts/demo.ts                                     # 端到端演示
```

> 本机命令行沙箱禁止 `node --test` 的默认子进程隔离（`spawn EPERM`），所以测试脚本使用 `--test-isolation=none`；`package.json` 的 `test` 脚本已按此配置。

---

## 验收 1：能构建对话树并计算任意两节点路径成本

**用例**：`tests/graph.test.ts`（9 条）

| 用例 | 断言要点 |
|---|---|
| `links children, records branch ordinals, and sums parent-chain cost` | `pathCost(叶, 根)` 恰等于沿线边权之和；分支序号按插入顺序 |
| `walking down an edge costs the descent penalty` | 上行 = `edge.cost`，下行 = `edge.cost + descentPenalty` |
| `cross-branch distance routes through the lowest common ancestor` | 跨分支路径 = `a→LCA→b`，成本 = 两条边 + 一次下行惩罚 |
| `edge cost is the weighted sum of its four signals` | 成本 = 四项加权和（夹逼后） |
| `a second child under the same parent pays the branch-switch penalty` | 第二个子节点 `branchSwitch = 1` |
| `adjustEdge moves the cost inside the clamp and records the reason` | 增量更新、夹逼、`updates`/`lastReason` |
| `stats and serialization round-trip without repricing` | 快照往返不重算边权 |

**演示输出**（`node scripts/demo.ts` 第 1–2 节）：

```text
nodes: 6, edges: 5, depth: 4
  n1(note) -> n2(question)  cost=0.825  [jump 0.823 time 0.017 branch 0 user 0]
  n2(question) -> n3(answer)  cost=0.704  [jump 0.701 time 0.017 branch 0 user 0]
  ...
token answer -> root: cost 3.338 over n5 <- n4 <- n3 <- n2 <- n1
token answer -> weather note: cost 4.398 over n5 <- n4 <- n3 <- n2 <- n6
(the second path walks down one edge, so it pays descentPenalty 0.35)
```

---

## 验收 2：按权重 + 预算选出上下文节点，无关远距离节点被过滤

**用例**：`tests/retrieve.test.ts`（8 条）

| 用例 | 断言要点 |
|---|---|
| `relevance dominates: the on-topic ancestor outranks the off-topic one` | 相关节点权重更高、排在最前 |
| `the current node costs nothing to reach and scores highest` | `pathCost = 0`、`pathWeight = 1` |
| `a far unrelated node is filtered by the weight floor` | 无关节点进入 `dropped`，`reason = 'threshold'` |
| `the token budget bounds the buffer` | `tokensUsed ≤ budget`，超出部分 `reason = 'budget'` |
| `cheap-and-relevant nodes are spent before expensive long ones` | 按 `weight/tokens` 性价比填充 |
| `a low-scoring node is compressed before it is admitted` | 低权重节点压缩，`compressed = true`，占位 token 变小 |
| `user marks decide inclusion: ignored is dropped, must-include survives the floor` | 忽略即丢弃；强制包含可越过阈值 |
| `the rendered block is compact and names every selected node` | 注入块格式稳定 |

**演示输出**（第 3 节）：

```text
[token-tree memory] 4/6 nodes, 112/120 tokens, origin n4
- (n4 question w=0.6475 path=0) 其中的 token 是什么？如何被切分？
- (n5 answer w=0.3908 path=1.1564) token 是模型处理的最小文本单位，…
selected:
  n4 question  w=0.647 rel=0.412 path=0.000 tokens=15
  n5 answer    w=0.391 rel=0.277 path=1.156 tokens=32
  n2 question  w=0.305 rel=0.158 path=1.706 tokens=21
  n3 answer    w=0.300 rel=0.031 path=1.002 tokens=44
rejected: belowThreshold=1 overCap=0 overBudget=0
with a 24-token budget only 1 node(s) fit: n4
```

被 `belowThreshold` 丢掉的正是那条"天气/水果"的无关远距离便签。

---

## 验收 3：工具失败后边权增加、反思节点写入、可回溯到兄弟分支

**用例**：`tests/reflect.test.ts`（9 条）、`tests/plugin.test.ts`（10 条）

| 用例 | 断言要点 |
|---|---|
| `two consecutive failures are a failure` | 连续 2 次失败 → `failed` |
| `an identical retry is a stall, not a failure` | 相同工具 + 相同参数的重复失败 → `stalled` |
| `branch scoring prefers the pinned, successful branch` | 分支评分偏好成功/置顶分支 |
| `a failed branch backtracks to the better sibling` | 回溯目标 = 更优兄弟分支 |
| `with no sibling worth taking the search climbs one level` | 无兄弟可用时向上爬一层（`escalated = 1`） |
| `a dead tree yields no plan` | 无路可走返回 `null`（不会死循环） |
| `a failed tool raises its edge cost and writes a failed observation` | `lastReason='tool/failure'`，成本增加，观测记录失败；随后成功会 `tool/success` 回落 |
| `the supervisor reflects, backtracks to the better sibling, and queues guidance` | 反思节点写入、`currentId` 移到更优分支、`agent.inject` 收到监督指令、日志含 `supervisor failed` |

**演示输出**（第 4–6 节）：

```text
edge n7->n8: 1.002 -> 1.752 (tool/failure)

verdict: failed (score -0.60) — same failed call web_search twice; 2 consecutive failure(s); …
reflection node: n9
backtrack plan: n8 -> n5 (escalated 1)
  branch n5 scores 0.0789 (1 nodes, 0 failure(s))
  reflection node n10; current is now n5

current node n12, pinned retry n11
top recalled: n11 w=0.733, n12 w=0.515, n4 w=0.282
tree now has 12 nodes and 11 edges
```

---

## 验收 4：插件可通过 patch 加载，工具可被模型调用，日志可见边权更新

### 4a. 产物契约

```text
$ node -e "import('file:///D:/dsh-token-tree/dist/index.js').then(m => console.log(Object.keys(m).sort().join(', '), m.name, JSON.stringify(m.inject)))"
Config, TokenTreeService, apply, inject, name   dsh-bonsai   ["tools"]
```

无 `default` 导出（函数插件必须如此，否则 loader 会丢掉 `name/inject/apply`），无任何外部 `import`。

### 4b. patch 合成

```yaml
# == D:\dsh-token-tree\cordis\token-tree.patch.yml
- id: token-tree
  name: file:///D:/dsh-token-tree/dist/index.js
```

### 4c. 真实加载器加载 + 配置校验

```text
$ dsh --profile demo --patch …token-tree.invalid.yml --no-open --port 19402
dsh: warning: 1 entry did not activate
token-tree (file:///D:/dsh-token-tree/dist/index.js): ValidationError: invalid config:
  - must be a finite number (at weights.lambda)
```

```text
$ dsh --profile demo --patch …token-tree.patch.yml --no-open --port 19403
dsh web: http://127.0.0.1:19403/?token=…
（无 did not activate 告警 → apply 执行成功、5 个工具注册成功）
```

`ctx.tools.register` 在注册时校验 `output.schema`（不支持的 JSON Schema 会抛出），因此"零告警"同时证明工具 schema 合法。

### 4d. 工具可被模型调用

五个工具注册在全局工具层，模型回合的工具表在每一步重新装配：

| 工具 | 入参（必填） |
|---|---|
| `retrieve_context` | `query` |
| `tree_query` | — |
| `tree_reflect` | `note` |
| `tree_backtrack` | — |
| `tree_mark` | `nodeId` |

本机已通过 home 层 patch（`C:\Users\ASUS\.dsh\cordis.patch.yml`）挂载到桌面版会话，当前会话的下一回合即可直接调用。

### 4e. 日志可见边权更新

```text
token-tree: mounted — 5 tools (retrieve_context, tree_query, tree_reflect, tree_backtrack, tree_mark), autoInject=true, autoReflect=true, lambda=0.5, alpha=0.6, budget=2000
token-tree: injecting memory block for session session-… (turn 2)
token-tree: edge n7->n8 cost 1.002 -> 1.752 (tool/failure, delta +0.75, updates 1, session session-…)
token-tree: edge n11->n12 cost 0.930 -> 0.680 (tool/success, delta -0.25, updates 1, session session-…)
token-tree: supervisor failed on session session-… (turn 3, reflections 1, backtracks 1, plan n5)
```

`tree_query` 的输出同时把边权暴露给模型：`incoming.cost` / `incoming.lastReason` / `children[].edgeCost` / `pathToRoot[].cumulative`。

---

## 汇总

| # | 验收标准 | 结论 |
|---|---|---|
| 1 | 能构建对话树并计算任意两节点路径成本 | 通过（9 用例 + demo 1–2 节） |
| 2 | 能按权重 + 预算选出上下文节点，无关远距离节点被过滤 | 通过（8 用例 + demo 3 节） |
| 3 | 工具失败后边权增加、反思节点写入、可回溯到兄弟分支 | 通过（9 + 10 用例 + demo 4–6 节） |
| 4 | 插件可通过 patch 加载，工具可被模型调用，日志可见边权更新 | 加载/校验/注册/日志已实测；模型调用在挂载后的下一回合生效 |
