# 设计说明

本文回答四件事：需求如何映射到代码、数据结构长什么样、权重怎么算、检索与控制循环怎么跑。
挂载与调试见 [mounting.md](mounting.md)，验收证据见 [acceptance.md](acceptance.md)。

## 1. 需求 → 实现映射

| 需求 | 实现位置 |
|---|---|
| 节点：问题/回答/工具结果/反思，含内容、嵌入、父子、时间戳、类型、元数据 | `src/core/types.ts` `MemoryNode`；`src/plugin/service.ts` 把会话事件折叠成节点 |
| 边：非负 cost，越大越差 | `MemoryEdge`，`src/core/weight.ts` 计算，`MemoryTree.adjustEdge` 动态调整 |
| 语义跳跃/时间间隔/分支切换/用户标记 综合 | `computeEdgeCost()` |
| 路径成本：父链求和；跨分支 Dijkstra | `MemoryTree.pathCost()` / `distancesFrom()` |
| 路径权重 `exp(-λ·cost)` | `pathWeight()` |
| 主题相关度 = 余弦相似度 | `src/core/embedding.ts` `cosine()`，`retrieveContext()` |
| 综合权重：线性或乘积 + 祖先链加成 | `combineScore()` + `ancestorBoost` / `pinBoost` |
| 阈值 + Top-k + token 预算贪心（权重/token） | `retrieveContext()` 的三段筛选与预算 pass |
| 低权重节点摘要压缩后加入 | `materialize()`：`weight < compressBelow` 时用 `summary` 或截断 |
| 工具失败加边权 + 写反思；成功降边权 | `TokenTreeService.ingestToolResult()`、`supervise()` |
| 用户置顶/忽略分支 | `MemoryTree.mark()` + `tree_mark` 工具 |
| 感知：当前节点、目标/子目标 | `currentId`，`goal` 类型节点（`tree_reflect` 的 `kind: "goal"`） |
| 决策/执行/观察 | 仍由 Harness 的 agent-loop 决策与执行；插件通过 `tools/*`、`session/event` 观察并改树 |
| 评估—反思—回溯 | `src/core/reflect.ts` + `TokenTreeService.supervise()` + `agent/turn-stopping` |
| 最大步数/超时/预算 | `LoopPolicy`（`maxSteps`/`timeoutMs`/`maxReflections`/`maxBacktracks`）+ 检索 `tokenBudget` |
| 插件契约 name/inject/apply/Config | `src/index.ts`、`src/plugin/config.ts` |
| `ctx.tools.register(defineTool(...))` | `src/plugin/tools.ts` 生成 `ToolDefinition` 等价结构，经 `ctx.tools.register` 注册 |
| `ctx.on` 监听会话事件 | `src/plugin/hooks.ts` |
| `ctx.effect` 清理资源 | `src/index.ts`：卸载时释放全部会话树 |

## 2. 数据结构

### 节点

```ts
type NodeKind = 'question' | 'answer' | 'tool_result' | 'reflection' | 'note' | 'goal'

interface MemoryNode {
  id: string                  // 会话内唯一，n1, n2, ...
  kind: NodeKind
  content: string             // 全文：用于嵌入，也用于预算充足时的注入
  summary?: string            // 压缩形式：预算紧张时使用
  embedding: number[]         // 单位长度向量
  parentId: string | null     // 根为 null
  children: string[]          // 插入顺序；下标即分支序号
  timestamp: number           // epoch ms
  tokens: number              // estimateTokens(content)
  metadata: {
    toolName?: string; toolCallId?: string
    ok?: boolean; error?: string
    step?: number; turn?: number
    pinned?: boolean           // 用户置顶
    ignored?: boolean          // 用户忽略
    branch?: number            // 在兄弟中的序号
    [key: string]: JsonValue | undefined
  }
}
```

### 边

```ts
interface EdgeCostComponents {
  semanticJump: number   // 1 - cos，clamp [0,1]
  timeGap: number        // log1p(Δt/τ)，clamp [0, timeGapCap]
  branchSwitch: number   // 0 | 1
  userMark: number       // +1 忽略 / -0.5 置顶 / 0
}

interface MemoryEdge {
  id: string             // `${from}->${to}`
  from: string; to: string
  cost: number           // clamp 到 [minCost, maxCost]
  components: EdgeCostComponents
  createdAt: number; updatedAt: number
  updates: number        // 被观测调整过几次
  lastReason?: string    // 'tool/failure' | 'tool/success' | 'user/ignore' | ...
}
```

### 树

```ts
class MemoryTree {
  readonly sessionId: string
  readonly params: WeightParams        // 合并后的权重参数
  readonly nodes: Map<string, MemoryNode>
  readonly edges: Map<string, MemoryEdge>
  readonly rootId: string              // 合成根（kind: 'note'）
  currentId: string                    // Agent 当前所在节点

  addNode(input): MemoryNode           // 建节点 + 连边 + 定价 + 移光标
  link(parentId, childId): MemoryEdge  // 原子连边，父节点已有子节点时计分支惩罚
  pathCost(from, to): { cost, path }   // 不对称 Dijkstra
  distancesFrom(from): Map<string, number>
  ancestors(id) / isAncestor(a, b) / lca(a, b) / subtree(id)
  adjustEdge(from, to, delta, reason): MemoryEdge
  mark(id, { pinned?, ignored? }): MemoryNode
  summarizeBranches(parentId): BranchSummary[]
  stats() / toJSON() / fromJSON()
}
```

根节点是合成的 `note`（`session root`），让「整段对话」有一个统一祖先，路径成本才有共同的起点。

## 3. 边权公式与默认参数

```
cost(p→c) = clamp(  wSemantic · semanticJump
                  + wTime     · timeGap
                  + wBranch   · branchSwitch
                  + wUser     · userMark , minCost, maxCost )

semanticJump = clamp01(1 - cos(embedding_p, embedding_c))
timeGap      = clamp(log1p(max(0, t_c - t_p) / timeScaleMs), 0, timeGapCap)
branchSwitch = 1 if 父节点在连这条边之前已有子节点 else 0
userMark     = ignored ? +1 : pinned ? -0.5 : 0
```

设计意图：

- `timeGap` 取对数，避免长间隔一边倒：2 小时与 2 分钟在成本上不会差 60 倍。
- `branchSwitch` 让「在同一问题下另起一条分支」比「顺着当前线索继续」更贵，直接对应缓存里"分支切换"的负面代价。
- `userMark` 是唯一能把成本压回去的项；`minCost = 0` 保证 pinned 分支仍可通行。
- 动态更新是**增量**：`failureDelta` / `successDelta` 在既有 cost 上加减，再 clamp；`updates` 与 `lastReason` 记录来由。

### 默认参数

| 参数 | 默认 | 含义 |
|---|---|---|
| `wSemantic` | 1.0 | 语义跳跃权重 |
| `wTime` | 0.15 | 时间间隔权重 |
| `wBranch` | 0.6 | 分支切换权重 |
| `wUser` | 0.4 | 用户标记权重 |
| `timeScaleMs` | 60000 | 时间尺度 τ |
| `timeGapCap` | 5 | 时间项上限 |
| `minCost` / `maxCost` | 0 / 10 | 边权夹逼区间 |
| `descentPenalty` | 0.35 | 沿边**下行**时额外成本 |
| `lambda` | 0.5 | 路径权重衰减 λ |
| `alpha` | 0.6 | 相关度占比（linear）/ 指数（product） |
| `combine` | `linear` | `linear` 或 `product` |
| `ancestorBoost` | 1.15 | 祖先链加成 |
| `pinBoost` | 1.5 | 置顶加成 |
| `threshold` | 0.12 | 权重下限 |
| `topK` | 12 | 候选上限 |
| `tokenBudget` | 2000 | 缓冲区 token 预算 |
| `compressBelow` | 0.25 | 低于此权重改用摘要 |
| `compressedTokens` | 48 | 无摘要时的截断长度 |
| `failureDelta` | 0.75 | 失败加价 |
| `successDelta` | 0.25 | 成功减价 |
| `ignorePenalty` | 1.5 | 忽略分支的边权惩罚 |

### 循环护栏

| 参数 | 默认 |
|---|---|
| `maxSteps` | 12 |
| `maxReflections` | 4 |
| `maxBacktracks` | 3 |
| `timeoutMs` | 120000 |
| `failureThreshold` | 2 |
| `minBranchValue` | 0.05 |
| `stallScore` | 0.2 |

## 4. 路径成本

两个方向单价不同：

- 子 → 父：`edge.cost`（这条边在对话里真的走过）
- 父 → 子：`edge.cost + descentPenalty`（进入已经离开的分支，就是缓存负面效应的来源）

于是：

- `pathCost(node, rootId)` 退化为「沿父链求和」（需求里的经典路径长度）；
- `pathCost(currentId, candidate)` 是从"我现在在哪"出发的真实代价，跨分支会经过 LCA 并且为每一段下行付费。

实现是单源 Dijkstra（节点规模是对话量级，几百个；复杂度 `O(V²)`），`distancesFrom()` 一次算出全部候选距离，供检索复用。

## 5. `retrieve_context` 伪代码

```text
retrieveContext(tree, {query, originId = tree.currentId, budget, topK, threshold}):

  q        ← embed(query)
  distance ← tree.distancesFrom(originId)          # 一次 Dijkstra

  candidates ← []
  for node in tree.nodes:
      if node 是根 and 未显式要求:            drop('root')
      if node.id in exclude:                  drop('excluded')
      if kinds 限制不匹配:                     drop('kind')
      if node.tokens == 0:                    drop('empty')
      if node.metadata.ignored and not forced: drop('ignored')

      relevance    ← clamp01(cosine(q, node.embedding))
      pathCost     ← distance[node.id]
      pathWeight   ← exp(-λ · pathCost)
      ancestorBoost← node 是 origin 的祖先 ? ancestorBoost : 1
      pinBoost     ← node.pinned ? pinBoost : 1
      weight       ← combine(relevance, pathWeight) · ancestorBoost · pinBoost

      if weight < threshold and not forced:    drop('threshold')
      (text, tokens, compressed) ← materialize(node, weight)
      candidates.add({node, weight, relevance, pathCost, pathWeight, text, tokens})

  # 1) Top-k：must-include 先占位，其余按权重降序
  compelled ← candidates where must
  optional  ← candidates − compelled, sorted by weight desc
  capped    ← compelled + optional[0 : topK − |compelled|]
  optional[topK−|compelled| :] → drop('top-k')

  # 2) 预算贪心：按 weight / tokens 性价比降序，must 优先
  selected   ← []
  tokensUsed ← 0
  for c in sort(capped, by (must desc, weight/tokens desc)):
      if tokensUsed + c.tokens > budget:  drop('budget'); continue
      selected.add(c); tokensUsed += c.tokens

  return {selected sorted by weight desc, dropped, tokensUsed, counts}
```

`materialize(node, weight)`：当 `weight < compressBelow` 且节点有 `summary`（或全文超过 `compressedTokens`）时，用摘要 / 截断文本，`compressed = true`——这就是「低权重节点摘要压缩后加入」。

复杂度：`O(V²)`（Dijkstra）+ `O(V log V)`（排序）。

## 6. 控制循环

插件不替换 `ctx.agentLoop`，而是挂三个官方扩展点：

```text
# ① 感知：会话日志 → 树（session/event，事件提交后触发）
on session/event(session, event):
    turn/start        → 重置本回合观测、计数、计时
    step/start        → 记录 step
    user/message      → 只有 source.kind == 'user' 才是学员输入；再分两类：
                          classifyTurn(text) == 'constraint'
                              → 不进树：constraints ← applyConstraint(...)（"不再…" 会作废旧要求）
                                并置 skipNextAnswer = true（"收到，之后…" 不属于对话）
                          'topic'
                              → parent ← pickQuestionParent(...)   # 见下
                                addNode(kind='question', parent, setCurrent=true)
                        其余来源（runtime-context / skill-catalog / agent-instructions /
                        agent-message / subagent-settled / tool-jobs / 本插件注入）是
                        Harness 自己的记账，直接忽略，不建节点
    assistant/message → 若 skipNextAnswer 则丢弃（它是上一条要求的确认）并复位
                        否则 addNode(kind='answer', parent=current, setCurrent=true)
    tool/call         → 记录 callId → (toolName, arguments)
    tool/result       → addNode(kind='tool_result', parent=current, setCurrent=false)
                        edge ← adjustIncomingEdge(node, isError ? +failureDelta : −successDelta)
                        log  "edge a->b cost x -> y (tool/failure …)"
                        observations.push({step, toolName, argsKey, ok, error})

pickQuestionParent(text, embedding):          # 语义挂载，把"追问某名词"接回它被提到的地方
    default ← current                          # 默认仍是链式：接在最后一个回答后面
    score(n) = 0.45 · max(0, cos(q, n.emb))    # 语义
             + 0.55 · maxIdf(share(q, n)) / maxIdf(q)   # 词面：最稀有的共同词，按问题内 IDF 归一
    best ← argmax over n where n.kind == 'answer' and n != default
    if best.score ≥ attachThreshold and best.score ≥ score(default) + attachMargin:
        return best                            # 分叉：挂在真正解释了该名词的那条回答下
    if 默认块足够实质 and score(default) < newTopicBelow:
        return root                            # 换话题：新起一条顶层分支
    return default
```

词面为什么不用对称重合：`介绍` 几乎和每段话都重合，长回答又会把短问题的词稀释掉。改成「问题里最稀有的那个共同词」后，`线段树` 这种只在一两处出现的词权重很高，`介绍` 几乎不计分。

**为什么"要求"不进树**：「以后都限制在 100 字以内」不是话题，而是对话的后缀生效条件；它会过期（"不再受 100 字限制"），会互相覆盖，也会影响之后每一条回答。把它建成节点既污染树、又丢掉"现在到底哪条还有效"。所以它进 `constraints` 列表（新覆盖旧），并且它的"收到"确认也不进树。生效中的要求会出现在三处：`/tree` 头部、面板顶部的要求条、以及注入给模型的 `[token-tree constraints]` 前缀 —— 最后这条才是它真正起作用的地方。

这两条形状规则是实跑一段真实会话后修出来的：不区分来源时，一次会话里 18 条 `user/message` 只有 6 条是学员提问，其余是 Harness 记账；而让工具结果移动光标时，279 个节点会退化成一棵 278 层的直线。改完之后同一段会话是 6 个问题、14 个回答、259 个工具叶子，深度 21。

**为什么还需要语义挂载**：即使用户提问不移动工具光标，只要新问题永远挂在最后一个回答下，对话维度上仍然是一条链。真实的学习对话是"对上一段解释里的名词继续追问"，所以新问题要挂回**引入了该名词的那条回答**，同一答案下的多个追问才会成为兄弟分支。只让 `answer` 当候选，是因为问题本身不引入名词；词面项去掉停用词和单字中文后再算，否则"What is a token?" 会和"What is attention?" 因为共用句型而虚高。

实测（学习对话 vs 实现对话）：

```text
n2 [question] 什么是注意力机制？
  n3 [answer] 注意力用查询和键的相似度…其中 token 是基本单位。
    n4 [question] 其中的 token 是什么？          ← 挂在 n3
    n6 [question] 注意力里的查询和键分别是什么意思？ ← 也挂在 n3，成为兄弟分支
```

而"每轮都是一个新的实现请求"的对话（例如本次开发会话）里，语义分数达不到 `attachThreshold`，结构会诚实地保持一条链 —— 这不是 bug，是内容本身没有分叉。


# ② 检索：每回合第一步注入加权记忆块（agent/pre-step，waterfall）
on agent/pre-step(payload, next):
    decision ← await next()
    if not autoInject or decision.kind != 'enter' or payload.step > 1: return decision
    query ← 最后一条非注入用户消息的文本
    block ← retrieve(session, query, injectBudgetTokens) 渲染
    if block: return { ...decision, messages: [...decision.messages, injected(block)] }
    return decision

# ③ 评估—反思—回溯：回合即将结束（agent/turn-stopping，串行）
on agent/turn-stopping(payload):
    if not autoReflect: return
    e ← evaluateProgress(observations, loopPolicy)
    if e.verdict in {progress, done}: return
    if 超时 / 步数 / 反思数超限: return                # 护栏
    addNode(kind='reflection', text=describeFailure(...), setCurrent=false)
    if 回溯次数未超限 and (plan ← chooseBacktrack(current, policy)) != null:
        moveTo(plan.targetId)
        addNode(kind='reflection', text=describeBacktrack(plan), setCurrent=false)
        guidance ← "Backtracked to <id>: <reason>…"
    agent.inject(guidanceMessage)                      # 同回合再走一步
```

`evaluateProgress` 的判定：

```text
consecutiveFailures = 尾部连续 ok==false 的个数
repeated            = 最后两次都是同一个 tool+args 的失败
score               = Σ 0.6^age · (+1 ok / −0.6 fail) / Σ 0.6^age   （最近 6 次）

failed  : consecutiveFailures ≥ failureThreshold
stalled : repeated 或 score < stallScore
done    : 目标节点已标记完成
progress: 其余
```

`chooseBacktrack` 从失败节点向上爬：在每个祖先处，对**除失败子树外**的每个子分支打分

```text
branchValue(b) = Σ_{n ∈ subtree(b)} exp(-λ·depth(n)) · signal(n)
                 · exp(-λ · edgeCost(parent→b)) / (1 + log1p(|subtree(b)|))

signal: pinned +1.2 / ignored −1.5 / reflection −0.6
        tool_result(ok) +0.4 / tool_result(fail) −0.6 / goal +0.5 / answer +0.2 / question +0.15
```

取最高分；若该层没有分支超过 `minBranchValue`，继续向上爬一层（`escalated++`），直到根。

## 7. 动态更新规则

| 触发 | 效果 |
|---|---|
| 工具失败（`tool/result.isError`） | 入边 `+failureDelta`，`lastReason = 'tool/failure'`；写失败观测 |
| 工具成功 | 入边 `−successDelta`（夹到 `minCost`），`lastReason = 'tool/success'` |
| 用户忽略分支（`tree_mark` / `mark`） | `metadata.ignored = true`，入边 `+ignorePenalty`；检索直接丢弃该节点 |
| 用户置顶分支 | `metadata.pinned = true`，入边 `−ignorePenalty/2`；检索乘 `pinBoost` |
| 回合失败/停滞 | 反思节点（不移动光标）+ 可能的回溯节点（移动光标）|
| 节点数超 `maxNodesPerSession` | 裁剪「最冷且不在当前路径上、未被置顶」的根分支 |

边权每次变化都写一条 `info` 日志（`logEdgeUpdates: true`）：

```text
token-tree: edge n7->n8 cost 1.002 -> 1.752 (tool/failure, delta +0.75, updates 1, session …)
```

## 8. 为什么这样接，而不是替换 agent-loop

需求里允许「参考 dsh-agent-loop 把评估—反思—回溯实现为自定义循环插件」。实际选择：

1. **替换 `ctx.agentLoop` 需要复刻整个 driver**（pre-step、request 冻结、流式、工具管线、取消、持久化），成本极高且随版本漂移。
2. **Harness 明确把 `agent/turn-stopping` 设计成"想再来一步就在这里 inject"**，`agent/pre-step` 是文档化的改写入口。用这两个入口实现监督循环，行为等价而无需维护 fork。
3. 需要"自己决定下一步动作"的部分已经由模型完成；插件提供的是**上下文与护栏**，不是替代推理。

如果确实要替换循环，接缝是 `TokenTreeService.supervise()`：它只依赖 `AgentLike.inject()` 与树，返回 `SupervisionOutcome`，可以被任何 driver 调用。

## 9. 与参考插件的关系

需求提到 `dsh-mindmap` / `dsh-infinite-canvas`（取对话树）、`dsh-memory-bridge` / `dsh-context`（记忆存储与注入）、`dsh-agent-loop`（循环）。本机安装里**不存在**这些包（`harness/packages` 与桌面版 `app.asar` 中均无），因此按相同职责自建，并保留替换接缝：

| 若要用参考插件 | 替换点 |
|---|---|
| `dsh-mindmap` 提供树结构 | 只替换 `TokenTreeService.ingest*` 的节点来源，`MemoryTree` 接口不变 |
| `dsh-memory-bridge` / `dsh-context` 提供存储与注入 | 替换 `TokenTreeService.stateOf()` 的持久化与 `memoryBlock()` 的注入通道 |
| `dsh-agent-loop` 自定义循环 | 直接调用 `service.supervise(agent, turn)`，丢弃 `hooks.ts` 的 turn-stopping 订阅 |
| 真实嵌入模型 | 注入 `embedding`（`addNode({embedding})` / `RetrieveOptions.queryEmbedding`），默认的本地 hashing 嵌入不再使用 |

## 10. 已知限制

- 本地嵌入是确定性 hashing（词 + CJK 字符/二元组），只适合"是否同一话题"的粗判；语义细粒度区分请接真实 embedding。
- 树完全在内存里，进程重启后由日志重放重建；不回写会话日志（避免仓外事件类型污染持久化）。
- 回溯是**单步**决策（选一个更优兄弟分支），不做多步规划。
- 节点裁剪是按分支粒度的粗粒度策略，不做代价最优的删减。
