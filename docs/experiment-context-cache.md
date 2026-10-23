# 上下文与缓存影响实验（A/B）

目的：回答一个具体问题 —— **这套树的注入，对上下文开销和 prompt 缓存命中到底有多大影响？**

## 方法

三个脚本，两步跑完，全程本地：

| 脚本 | 作用 |
|---|---|
| `scripts/ab-drive.mjs` | 以浏览器同样的网关协议（`session/create` / `session/prompt` / `session/page`）驱动一个 web 实例跑固定问题 |
| `scripts/bench-cache.mjs` | 解码会话日志，从 `assistant/message.usage` 取真实用量，算每轮命中率与注入量 |
| `scripts/ab-run.ps1` | headless 版本（当前环境下用不了，见"已知限制"） |

步骤：

```powershell
# 1) 两个隔离 profile：一个不装插件，一个装
dsh --profile aboffw --from-default-profile web
dsh --profile abonw  --from-default-profile web
dsh plugin --profile abonw add file:D:\dsh-token-tree\plugin

# 2) 各起一个实例
dsh --profile aboffw --no-open --port 19501
dsh --profile abonw  --no-open --port 19502

# 3) 同一组问题，各跑 8 轮
node scripts/ab-drive.mjs --port 19501 --token <token> --label baseline
node scripts/ab-drive.mjs --port 19502 --token <token> --label plugin

# 4) 对比
node scripts/bench-cache.mjs <baseline-session-dir>
node scripts/bench-cache.mjs <plugin-session-dir>
```

问题列表刻意**混合跳脱与关联**：哈希表 3 连问 → 天气（跳脱，触发工具）→ 回到哈希表 2 连问 → 线段树（跳脱）→ 树状数组（关联）→ 跨分支汇总。只问一个话题测不出挂接决策，只跳话题测不出检索。

## 实测结果（2026-10-21，deepseek-flash）

### 汇总

| 指标 | 基线（无插件） | 插件 | 变化 |
|---|---|---|---|
| 轮数 / 步数 | 8 / 10 | 8 / 11 | +1 步 |
| 注入块 | 0 | 7 | — |
| 注入 token（合计） | 0 | 2,719 | 388/轮 |
| 新增 input token | 11,751 | 29,216 | **+149%** |
| 缓存读取 token | 143,744 | 232,320 | +62% |
| 输出 token | 745 | 1,362 | +83% |
| 命中率 | 91.78% | 91.69% | **−0.09 pt** |

### 逐轮（input / cached）

```text
基线                          插件
t1   286 /   8832            t1  6102 /  4352   ← 首轮含系统提示整段
t2   230 /   8960            t2   257 / 10368
t3   161 /   9088            t3   300 / 10624
t3   372 /   9344            t3   383 / 11008
t3  9803 /   9728  ← 工具    t3 10465 / 11392   ← 工具
                              t3  9367 / 22016   ← 多跑了一步
t4   166 /  19456            t4   520 / 31616
t5   218 /  19456            t5   416 / 32128
t6   156 /  19584            t6   417 / 32512
t7   208 /  19584            t7   456 / 32896
t8   151 /  19712            t8   533 / 33408
```

## 结论

1. **不伤缓存**：命中率 91.78% → 91.69%，差 0.09 个百分点，在噪声内。原因是注入追加在**消息末尾**，system + 历史的公共前缀没变。
2. **但注入块本身永远不被缓存**：它每轮都在末尾新增，所以每轮多出约 250–400 个"全新 input"token。这正好等于注入量，符合预期。
3. **主要成本来自步数，不是注入**：插件那次在工具轮多跑了一步，一步就是约 9.4k 的新 prompt。8 轮里 1 步 = 总开销差距的一半以上。
4. 长上下文场景下（本仓库主会话 39 万 token）命中率仍在 99.9%，说明结构本身不破坏缓存；成本随会话变长线性增长的是"缓存读取"，而缓存读取单价远低于新 input。

## 已知限制

- `scripts/ab-run.ps1`（headless 路线）在此环境不可用：账号凭据只允许"桌面端/网页端"这个目的地使用，headless 进程被拒绝（`ACCOUNT_SIGN_IN_REQUIRED` / `MISSING_CREDENTIAL`）。
- 样本只有 8 轮 × 2 次，步数差异会显著影响汇总值；要可比，需固定在**无工具**的问题集上，或重复多次取中位数。
- `session/follow` 是流式端点，普通 HTTP POST 打不开（"stream methods must be opened through the stream carrier"）；驱动器目前只靠 `session/page` 轮询 `turn/end` 判断完成。

## 花费

19 次 assistant 调用，约 4.1 万 input、2.1k output，按 deepseek-flash 定价远低于 1 元。

## 下一步可做

## 实验二：长上下文召回（19 轮）

设计：先以对话形式给出 **14 条独特事实**（项目代号、数据库文件名、认证容差、备份时间、错误码起点、连接池/限流…），再问 **5 个只能回引早期信息**的问题。两臂同一脚本、同一问题集。

```powershell
node scripts/ab-drive.mjs --set recall --port 19501 --token <token> --label rbase
node scripts/ab-drive.mjs --set recall --port 19502 --token <token> --label rplug
node scripts/bench-cache.mjs <session-dir>
```

### 结果

| 指标 | 基线 | 插件 |
|---|---|---|
| 轮数 | 19 | 19 |
| **召回正确** | **5/5** | **5/5** |
| 新增 input | 4,265 | 9,166（+115%） |
| 缓存读取 | 175,104 | 253,184 |
| 注入 token | 0 | 7,700（428/轮） |
| 命中率 | 97.62% | 96.51%（**−1.11 pt**） |

两臂的答案完全一致（`data/qingsong.db` / `30` / `03:15` / `40001` / `20 与 60 次每分钟`）。

### 结论

- **质量没有变差，也没有变好**：19 轮、约 2.5 万 token 的上下文里，全量历史本来就装得下，模型不需要"选择性召回"。
- **成本确实更高**：新增 input 翻倍，且命中率掉约 1 个百分点 —— 因为注入块每轮都是**全新的尾部内容**，永远不会命中上一轮的缓存前缀。
- 所以这个规模下，插件是**纯成本、零收益**。收益要等"历史塞不下、必须丢弃"的时候才可能出现，而本 harness 的 `compaction-basic` 在 web profile 里默认 `disabled`，短期内造不出那个场景。

### 顺手发现的坑

- 早期把提示写成"记一个事实：…"时，模型把它理解为**写文件**动作，在仓库里生成了一个乱码 `AGENTS.md`（已删除）。现在的提示改成陈述式，并显式禁止调用工具/改文件。
- `session/page` 是**滑动窗口**，按 `turn/end` 计数会失效（窗口外的事件会掉出去），必须按**最大 seq** 判断新回合。

## 花费

- 实验一：19 次调用，约 4.1 万 input。
- 实验二：38 次调用，约 43 万 input（多数命中缓存）。
- 两次合计按 flash 定价约 **¥1 左右**，在 5 元预算内。

## 实验三：工具优先模式（不注入大块，只给一行提示）

动机：既然每轮注入 400+ token 的块"纯成本"，那就把检索改成**模型主动调用工具**，每轮只追加一行提示（约 57 token），让它知道旧历史要自己取。

### 实现

- `autoInject: false`（默认）、`retrievalHint: true`（默认）；
- 提示只在树里有 ≥6 个节点时出现，避免首轮噪音；
- 一条真实的提示：

```text
[token-tree] Older turns may be summarised or trimmed. Before answering anything that
depends on earlier details, call retrieve_context (weighted over this conversation's
tree) to pull them back; do not guess from the summary.
```

> 坑：`cordis/bundle.patch.yml` 里原本硬编码了 `autoInject: true`，会覆盖代码默认值。第一次跑"工具优先"实验时注入的仍是 400+ token 的大块，就是这个原因。已改成 `autoInject: false`。

### 结果（19 轮，同一组 14 事实 + 5 召回问题）

| 指标 | 基线（无插件） | 工具优先 |
|---|---|---|
| 召回 | 5/5 | **5/5** |
| 注入 token / 轮 | 0 | **57**（大块模式是 428） |
| 新增 input | 4,157 | **3,926（−5.6%）** |
| 缓存读取 | 176,000 | 207,104 |
| 命中率 | 97.69% | **98.14%（+0.45 pt）** |

结论：**工具优先把注入成本从 428 → 57 token/轮（−87%），召回不变，命中率不降反升。** 大块自动注入在这个规模下确实是纯成本。

### 但这次没证明"收益"

`compaction-basic` 虽然在配置里 `disabled: false`、`maxTokens: 8000`，但两臂日志里**没有任何 `compaction/*` 事件** —— 压缩根本没触发，历史始终完整。所以：

- 模型从头到尾**一次也没调用** `retrieve_context`（没必要，全历史都在）；
- 提示行的价值（"把被压缩掉的事实取回来"）**尚未被验证**。

要验证，得先让压缩真的发生（可能需要更低的 `maxTokens`、或压缩只在溢出重试时生效）。这是 harness 侧配置问题，不是插件问题。

## 压缩（compaction）的触发条件

读 `@deepseek-ai/dsh-compaction-basic/lib/index.js` 得到的确切规则。压缩有两条触发路径：

1. **每步压力检查**：`agent/pre-step` 时调用 `compactIfNeeded(agent, "pressure")`；
2. **请求溢出恢复**：`agent/request-error` 且 `code === CONTEXT_WINDOW_EXCEEDED` 时压缩后重试。

压力路径的判据（`resolveCompactSpec`）：

```text
messageBudget  = contextWindow − request.maxTokens          ← 预留补全额度
pressureBudget = messageBudget − headroomTokens
thresholdTokens = floor(min(contextWindow × thresholdRatio, pressureBudget))
retainTokens    = floor(messageBudget × retainRatio)        ← 保留逐字尾部
触发条件        = 会话估算 token ≥ thresholdTokens
约束            = retainTokens < thresholdTokens（否则直接报配置错误）
```

实测环境参数：

| 变量 | 值 | 来源 |
|---|---|---|
| `contextWindow` | **1,000,000** | `request/context` 事件 |
| `request.maxTokens`（预留补全） | **256,000** | `request/header.config.maxTokens` |
| `thresholdRatio` 默认 | 0.8 | 插件默认 |
| 推导出的阈值 | `(1,000,000−256,000) × 0.8 ≈ 595,200` | — |

所以 2.5 万 token 的会话差了两个数量级，**永远不会触发**。这也解释了为什么把 `maxTokens: 8000` 写进配置毫无效果 —— 那个字段是"单次摘要的最大 token"，不是上下文窗口。

要在便宜的规模触发，配方是**调比例而不是调窗口**：

```yaml
- id: compaction-basic
  name: "@deepseek-ai/dsh-compaction-basic"
  disabled: false
  config:
    thresholdRatio: 0.01     # 阈值 ≈ 7,440 token
    retainRatio: 0.005       # 保留尾部 ≈ 3,720，必须 < 阈值
```

按此配置，14 条事实喂到第 5～6 轮就会触发第一次压缩。

### 但压缩仍未真正触发（2026-10-22 复核）

| 事实 | 证据 |
|---|---|
| headless profile 里 `compaction-basic` **是启用的** | `--dump-config` 无 `disabled: true` |
| web profile 里被 **web-app 层禁用** | dump 注释 `patched by @deepseek-ai/dsh-web-app` + `disabled: true` |
| 用 profile 补丁重新启用**能进合成配置** | dump 显示 `disabled: false` 且带 `thresholdRatio: 0.01` |
| 但会话里**依然没有** `compaction/*` 事件 | 19 轮、累计 prompt ≈ 18 万 token，0 事件 |

所以配方本身是对的（阈值 ≈ 1 万），但插件实例**没有真正跑起来**。最可疑的是 `compaction` 是一个 `cordis:group`（`isolate: { compaction: true }`）：组内那个隔离实例才是 agent 使用的，而它仍处于 disabled；顶层补丁只复用了同名行。

要真正验证，得改 **web-app bundle 层**（`@deepseek-ai/dsh-web-app` 的 patch），而不是 profile 层；或改用 headless profile（但本机 CLI 鉴权被账号策略挡住）。这件事**搁置**，等找到 web-app 层的可配置入口再继续。

### 更正（2026-10-22，桌面版实测：压缩确实会触发）

上面的"未触发"结论只对 `web` profile 成立。在**桌面版**里压缩一直是开着的，而且这次长会话里跑了两次：

```
$ node scripts/inspect-compaction.mjs --session <session-dir>

records: 11410
compaction/prune: 13
compaction/start: 2
compaction/summary: 2
compaction/end: 2

prunes: 13   prunedTokens: 73838
compactions: [ { turn: 30, seq: 4822 }, { turn: 71, seq: 10797 } ]
```

| 事实 | 证据 |
|---|---|
| 桌面版里压缩 **是启用的** | 同一份桌面会话日志里有 `compaction/start`、`summary`、`end` 各 2 次 |
| 触发点是**上下文压力**，与跳转无关 | 发生在 turn 30 与 turn 71 的回合边界，跳转不产生任何 `compaction/*` 事件 |
| 另有 **13 次 prune**，共清掉 **73,838 token** 的旧摘要 | `compaction/prune.data.shadowedTokenCount` 求和 |
| 结论修正 | "web-app 层禁用"只影响 `web` profile；桌面版走的是另一套 bundle，压缩正常工作 |

所以之前"看不到压缩"的原因是**环境选错了**（`web` profile），不是插件或配置的问题。

**对插件的意义**：压缩确实会发生 —— 一旦发生，旧消息被摘要替换、**前缀缓存必然失效**，而树的价值（把早期事实按主题捞回来）才第一次有真实用武之地。上面第四节那套压缩配方因此可以保留，只在需要复现的实验 profile 里用。

复现命令：

```powershell
node scripts/inspect-compaction.mjs                                  # 最新会话
node scripts/inspect-compaction.mjs --session C:\Users\ASUS\.dsh\sessions\<...>  # 指定会话
```

## 实验 4：压缩之后还能召回吗（2026-10-22）

### 先解决"怎么按需压缩"

`/compact` **不是普通消息**。把它当 prompt 发出去，模型会当作问题回答（第一版实验就是这么失败的：`compaction/end` 事件 0 个）。

真正的入口是 `commands/execute`：

```js
rpc('commands/execute', { agentId: sessionId, line: '/compact', submittedAttachments: [] })
// → { kind: 'success', text: 'Compacted 24 history items (~2216 tokens).', sourceEventSeq: 115 }
```

它是 `@deepseek-ai/dsh-command-compact` 暴露的手动压缩命令，内部调 `ctx.compaction.compactNow(agent, signal, commandId)`，**完全绕过阈值**。
这意味着压缩从"等上下文压力"变成"随时可复现的动作"，实验条件终于可控了。

### 两次基线（只有压缩，没有插件）

| 轮次 | 事实形态 | `/compact` 结果 | 压缩后 5 题召回 |
|---|---|---|---|
| baseline | "请记住"清单式 | `Compacted 24 items (~2,216 tok)` | **5/5** |
| baseline2 | 埋在叙述里（日志、压测报告、运维同步） | `Compacted 29 items (~4,945 tok)` | **5/5** |

**结论（重要且不利于本插件）**：在这个规模下，压缩摘要**把事实都保住了**。
即使事实是顺带提到的（`kuroshio_user.db`、`45 秒`、`03:20`、`41000`、`90 次/分`），
摘要仍然逐条保留，模型无需检索即可答对。

这与前三次实验的结论一致：**在几千到两万 token 的上下文里，树带来的是成本，不是召回收益**。
树的"逐字保留原始节点"这个优势，只有在摘要**开始丢信息**时才兑现 —— 也就是事实数量多到摘要必须压缩成纲要的时候。

### 还没做的那一步

把事实规模拉到**摘要一定会丢**的量级（例如 30 条分散事实 + 噪声轮次），再比较：

- 基线（无插件）：压缩后逐题作答的命中率；
- 树（插件开）：允许 `retrieve_context` 后的命中率与工具调用次数。

成本估计：约 30–60k token/臂，两臂合计约 ¥1～2（在既定预算内）。
脚本已就绪：`scripts/ab-compact.mjs --filler N --tools`。

### 30 条事实的那一版：基线直接打满

```
$ node scripts/ab-compact.mjs --port 19522 --token … --label base30 --facts 30 --ask 10 --filler 10

[base30] /compact → success: Compacted 82 history items (~2133 tokens).
[base30] recall after compact: 10/10
[base30] retrieve_context calls: 0
```

30 条分散事实（6 个模板 × 5 组编号）、10 轮填充、一次 `/compact`，之后抽 10 题：**10/10 全中**。

基线已经在天花板，再跑"树"臂只可能持平或更贵（多出工具调用），因此**没有再跑**。

### 三轮实验合起来的结论

| 事实规模 | 压缩量 | 基线召回 | 是否值得跑树臂 |
|---|---|---|---|
| 5 条（清单式） | 24 项 / 2,216 tok | 5/5 | 否（天花板） |
| 5 条（埋叙述里） | 29 项 / 4,945 tok | 5/5 | 否（天花板） |
| 30 条（模板生成） | 82 项 / 2,133 tok | 10/10 | 否（天花板） |

**这个 harness 的压缩摘要相当忠实**：它保留了具体文件名、数字、时间、目录名，甚至编号变体。
在能负担得起的规模（≤ 数万 token）里，压缩**没有制造出"事实丢失"的场景**，所以树没有可测的用武之地。

诚实结论：**加权对话树在当前 harness 的上下文策略下没有可测收益**。
它换来的东西（逐字节点、主题召回、人工分叉）要等到"摘要必须丢细节"的规模才有价值 ——
那一档需要会话长度远超本次实验的量级（估计数十万 token、上百轮），单次成本已超出本项目预算。

如果未来要做，最省的验证方式是**离线合成**：把真实长会话喂给 `retrieveContext`
（已有 `scripts/bench-retrieval.mjs`，100% recall @217 token vs 全量 4,182 token），
再与"摘要 + 保留尾部"的召回去比，不需要模型在环。

### 顺带的产品改动：自动提示改为按需出现

既然短对话里这些机制都是纯成本，每回合的检索提示（`retrievalHint`）也改成了条件触发：

```ts
if (state.compacted !== true && tree.nodes.size < this.config.hintMinNodes) return undefined
```

- 会话**被压缩过**（`compaction/start|end` 事件）→ 立刻恢复提示：此时旧事实真的可能不在上下文里；
- 或节点数 ≥ `hintMinNodes`（默认 40，约 20 轮）→ 提示；
- 否则**一行都不发**，短对话零额外 token。

对应测试：`tests/plugin.test.ts` 的 "with injection off the hook appends one short retrieval hint instead"。

## 实验 5：可审计的复测（2026-10-22，用户质疑后重做）

前几轮有两处方法学问题，先记下来：

1. README 曾把实验 3 的 4,157 抄进实验 2（实验 2 实际是基线 4,265 / 插件 9,166），已改；
2. 复核用的脚本一开始用"消息里是否含 token-tree 字样"和 `data.message.source` 判断注入，**两个都错**：工作区路径 `D:\dsh-token-tree` 出现在普通消息里，而日志的真实形状是 `data.source.kind`。按错误口径，基线和插件组都显示"注入 1 次"。

所以这一轮换了做法，脚本是 `scripts/ab-rigorous.mjs`：

- **交替排程** A/B/B/A/A/B，避免"先跑完一组再跑另一组"的时间漂移；
- 每题按**植入值精确子串匹配**判分，逐题打印；
- token 数取自每条 `assistant/message.data.usage` 求和；
- 注入数按 `data.source.kind === 'token-tree'` 统计，并额外交叉验证 `request/context` 里是否出现 `retrieve_context` 字样；
- 全部原始数据落到 `docs/experiments/*.json`（含 session id），可自行用 `scripts/bench-cache.mjs` 复算。

### 轮次 A：默认配置（`hintMinNodes: 40`）

| 组 | 跑数 | 正确 | 新增 input / run | 命中率 | 实际注入 |
|---|---|---|---|---|---|
| 基线（无插件） | 3 | **15/15** | 3,057 | 97.94% | 0 |
| 插件 | 3 | **15/15** | 3,198 | 98.11% | **0** |

10 条事实 → 约 21 个节点 < 40，**提示被门控住，一行都没发**。所以两组的差异只能算噪声（+4.6%），
这正好验证了默认配置的行为：**短会话里插件成本严格为 0**。

### 轮次 B：强制发提示（profile 里 `hintMinNodes: 1`）

| 组 | 跑数 | 正确 | 新增 input / run | 命中率 | 实际注入 |
|---|---|---|---|---|---|
| 基线（无插件） | 2 | **10/10** | 3,017 | 98.01% | 0 |
| 插件 | 2 | **10/10** | **2,978（−1.3%）** | 98.30% | **15/run ≈ 57 tok/行** |

注入确实到达了模型：每个插件 run 的会话日志里有 15 条 `source.kind = token-tree` 的用户消息，
且 `request/context` 记录里出现 `retrieve_context` 字样 **27 次**（基线组 0 次）。

### 这一轮能说和不能说

- 能说：**召回没有差异**（基线 25/25、插件 25/25，共 10 个 run）；提示本身约 57 token/行，
  在实测用量里没有造成可辨识的输入增长（−1.3% 属噪声）；默认门控让短会话零成本。
- 不能说：树能让模型答对更多题。这次仍然没有构造出"历史装不下"的场景，所以那部分
  依旧是**未证实**，不是"已证伪"。
- 树的价值仍集中在两块已确认的东西上：**结构编辑/导航 UI**，以及**离线检索质量**
  （`bench-retrieval.mjs`：200 节点树 recall@12 = 100%，217 token vs 全量 4,182）。

## 实验 6：阈值该定在多少（离线，零模型成本）

提出的想法：每轮不拼接全部，只取匹配度 > 0.5 的前若干个；找不到再回退到更早的对话。

`node scripts/bench-retrieval.mjs --sweep`（200 节点 / 40 分支 / 预算 400 / topK 12）：

| 相关性下限 | recall | 每查询返回节点 | 空结果率 |
|---|---|---|---|
| 0.12（当前默认） | **20/20** | 12.0 | 0% |
| 0.20 | **20/20** | 9.7 | 0% |
| 0.30 | 8/20 | 4.0 | 0% |
| 0.40 | 0/20 | 1.2 | 0% |
| **0.50** | **0/20** | 0.2 | **90%** |
| 0.60 | 0/20 | 0.0 | 100% |
| 0.70 | 0/20 | 0.0 | 100% |

注意：这个 `threshold` 卡的是**合成得分**（相关度与路径权重混合后的值），不是原始余弦。
换个口径再看 `--cosine`（原始余弦，目标节点）：

| 指标 | 数值 |
|---|---|
| 目标节点的平均余弦 | **0.43** |
| 单题目标余弦区间 | 0.33 ～ 0.55 |
| 余弦 ≥ 0.5 的节点数 | 每题 0 ～ 4 个 |

**所以"匹配度 > 0.5"会让检索在九成查询里空手而归**，回退逻辑会变成主路径。
原因不是算法差，是这套局部哈希嵌入的余弦本身就不高（0.33～0.55 就是"相关"的量级）。

### 结论：可以更好，但要换结构而不是抬阈值

| 你的想法 | 判断 | 依据 / 改法 |
|---|---|---|
| 每轮额外跑一个"简短总结" | ⚠️ 分情况 | 用**模型**生成 = 每轮多一次调用，正是实验 1 证明最贵的那种；用**本地确定性摘要**（首句 / 关键词 / 截断）则可行：**用摘要匹配、返回原文** |
| 不跑总结，直接用提问 | ✅ 就是现状 | 节点文本本身含问题与回答 |
| 只取匹配度 > 0.5 的前几条 | ❌ 数据不支持 | 合成得分口径下 90% 空；余弦口径下均值仅 0.43 |
| 分两闸：先准入再排序 | ✅ 推荐 | 准入用**原始余弦 ≥ 0.30**（召回仍 20/20），排序用现有合成得分，最后按预算裁剪 |
| 找不到就回退更早的对话（工具调用） | ⚠️ 顺序要改 | 工具结果是**最贵、复用率最低**的内容；回退阶梯应为：置顶/约束 → 祖先链（root→focus） → 最近 N 轮 → 最后才是旧工具结果 |

可实施的默认组合（建议）：`准入余弦 0.30` + `排序用合成得分` + `预算 400～600 token` +
`回退阶梯按上面的顺序`。验收方式就是重跑 `--sweep` 与 `--cosine`，不需要模型在环。

### 实现与验收（2026-10-22）

准入阈值做成了可配置项：`weights.admitRelevance`（默认 **0.3**），运行时也能在「设置 → 检索准入阈值」改。
它只决定**谁有资格进入排序**，排序本身仍用原来的合成得分；置顶节点和 `mustIncludeIds` 直接跳过准入。

`node scripts/bench-retrieval.mjs --admit-sweep`（200 节点 / 40 分支 / 预算 400 / topK 12）：

| 准入阈值 | 召回 | 每次返回节点 | 空结果率 |
|---|---|---|---|
| 0（关闭） | 20/20 | 12.0 | 0% |
| 0.20 | 20/20 | 10.8 | 0% |
| 0.25 | 20/20 | 8.4 | 0% |
| **0.30** | **20/20** | **7.2** | **0%** |
| 0.35 | 18/20 | 4.4 | 10% |
| 0.40 | 10/20 | 2.0 | 40% |
| 0.50 | 6/20 | 1.2 | 70% |

**0.3 是拐点**：召回不降，返回节点从 12.0 降到 7.2（少约 40% 上下文）。

回退按提出的思路实现为"**空格重试**"：准入后如果一个候选都没有，自动以 `admitRelevance: 0` 重跑一次，
并在结果里标 `counts.relaxed = true`。**空缓冲被视为失败，而不是"精确"**。

一个必须记下的风险：0.3 是在**关键词式查询**上标定的。自然语句查询的相关节点余弦常见只有 **0.28～0.29**
（测试里 `attention token weight` 对相关内容只有 0.290），刚好会被 0.3 挡掉，而某个无关节点反而过关。
所以：

- 想要更稳，用 **0.2～0.25**（召回仍 20/20，节点 8.4～10.8）；
- 想要更省，0.3 可用，但要接受"偶尔挡掉真正相关的那条"；
- 0.4 以上不建议。

对应测试：`tests/retrieve.test.ts` 的 "admission prefers precision but never returns an empty buffer"
（覆盖：精确命中被准入、无关节点被拒、空手时 relaxed 重试、置顶绕过准入）。

### 本地摘要参与匹配（`summary` + `summaryMatch`）

长节点（> 40 token）写入时生成**首句摘要**（≤ 40 字）并单独存一份摘要嵌入；检索时
`relevance = max(cos(原文), cos(摘要))`，命中后仍返回**原文**。全程本地，无额外模型调用。

`node scripts/bench-summary.mjs`（6 个主题，事实放长节点首句，后面接大段无关填充）：

| 配置 | recall | 中位排名 |
|---|---|---|
| 短节点 + 摘要开 | 6/6 | 1 |
| 长节点 + 摘要**关** | **1/6** | 3 |
| 长节点 + 摘要**开** | **6/6** | **1** |
| 长节点 + 摘要关 + 无准入 | 6/6 | 4 |
| 长节点 + 摘要开 + 无准入 | 6/6 | 1 |
| 超长(×20，约 3,000 token) + 摘要关 | 2/6 | 8 |
| 超长(×20) + 摘要开 | 4/6 | 1 |

要点：
- 摘要必须**只取首句**。先前的"前 120 字"把第二句填充也带了进来，余弦从 0.31 掉到 0.18，几乎无效。
- 长节点靠原文匹配时余弦只有 0.13（远低于准入线），所以**摘要不是锦上添花，是这类节点能否被召回的前提**。
- 边界：若首句本身带很长的元信息前缀（"项目背景记录（无需操作…）：备份窗口固定在 03:15。"），摘要会连前缀一起截，命中率下降。

### 回退阶梯：最终只保留"放宽准入"一级

原计划是"置顶/约束 → 祖先链 → 最近 N 轮 → 旧工具结果"。实测发现**祖先链这一级不可达**：
凡是能让"放宽准入"也为空的场景（所有分支被忽略或隐藏），祖先链会被同一组标记跳过，永远返回空。
因此最终只有一级回退——**准入后为空就去掉门槛重跑一次**，结果里标 `counts.relaxed = true`。
由于排序本身含路径权重，放宽后重排出来的天然是离当前节点最近的节点（等价于"更早/更近的对话"），
不必再写一条祖先链逻辑。代码里保留了这段结论的注释，避免以后重复实现。

### 端到端验证（工具路径）

`node scripts/e2e-retrieve.mjs --port <p> --token <t>`：3 条带大段填充的事实 → 强制模型调用 `retrieve_context`：

```text
retrieve_context calls: 1
tool result: Retrieved 2 node(s), 107/2000 tokens, 6 dropped, injected=true.
             - n8 question w=0.7171 tokens=46
             - n3 answer w=0.3723 tokens=61
```

**2 个节点进上下文、6 个被丢弃**，模型照抄了返回的节点编号 —— 准入与摘要链路在实际会话里生效。

## 实验 7：新模式对命中率 / 缓存 / 输入的影响（2026-10-22）

三臂，同一批问题、交替顺序 **A/B/C/C/B/A**，每臂 2 跑；脚本 `scripts/ab-retrieval.mjs`，
原始数据 `docs/experiments/round3-retrieval.json`（含 session id）。

| 臂 | 配置 | 正确 | 新增 input/run | 缓存命中 | 检索调用 | 返回节点 | 返回 token |
|---|---|---|---|---|---|---|---|
| A | 不检索（凭历史回答） | **8/8** | **2,687** | 96.82% | 0 | 0 | 0 |
| B | 旧模式（准入 0、摘要关） | **8/8** | 6,167 | 96.09% | 8 | 55 | 6,178 |
| C | **新模式（准入 0.3、摘要开）** | **8/8** | **4,520** | **97.07%** | 8 | **32** | **2,578** |

**新模式 vs 旧模式**（这才是这次改动的效果）：

- 新增 input **−27%**（6,167 → 4,520）；
- 缓存命中 **+0.98 pt**（96.09% → 97.07%）；
- 返回节点 **−42%**（55 → 32），返回 token **−58%**（6,178 → 2,578）。

**检索 vs 不检索**（诚实的一面）：

- 命中率**没有差别**（三臂都 8/8）—— 会话只有 4 条事实、几千 token，历史本来就在上下文里；
- 但每次检索要多一次工具往返，所以"检索"整体仍比"不检索"贵 **+68%（4,520 vs 2,687）**。

结论：**这次改动显著降低了检索路径的成本（−27% 输入、−58% 注入 token、缓存命中还更高），
但它改变不了"短会话里根本不需要检索"这个前提**。收益仍然只在"历史装不下"的场景里才可能出现。

## 实验 8：用官方 tokenizer 决定"要不要注入"（2026-10-22）

用户提供了 `deepseek_v4_tokenizer.zip`（HF `tokenizer.json`，128k vocab / 127,741 merges / 字节级 BPE）。
仓库里没有 JS tokenizer，随附的 Python 也没有 `transformers`，所以直接实现了一个**纯 JS 读取器**
（`src/core/tokenizer.ts`，无原生依赖、无网络），只做计数、不做编码。

### 先验证它准不准

`node scripts/tokenizer-check.mjs --tokenizer ...`：

| 文本 | 字符 | tokens | 字符/token | 旧估算(chars/2.5) | 官方/估算 |
|---|---|---|---|---|---|
| 英文散文 | 70 | 12 | 5.83 | 28 | 0.43 |
| 中文散文 | 28 | 17 | 1.65 | 12 | **1.42** |
| 中英混合 | 36 | 24 | 1.50 | 15 | 1.60 |
| 代码 | 30 | 18 | 1.67 | 12 | 1.50 |
| JSON | 62 | 19 | 3.26 | 25 | 0.76 |

- 所有 piece 都在词表内（未知 0），合并按 merges 排名执行，特殊 token 先切分；
- 结论：**英文被低估 57%，中文被高估 42%** —— 一个常数确实不可能同时服务两种语言。

### 性能（每回合都要数一遍上下文）

`node scripts/tokenizer-perf.mjs`：加载 116 ms；20k 字符 27 ms；60k 74 ms；200k 254 ms。
因此实现里按**消息 id 增量缓存**：每回合只为新消息付费。

### 决策怎么改

| 之前 | 现在 |
|---|---|
| 节点数 ≥ 40 才发提示（代理指标） | 有 tokenizer 时：**实测上下文 ≥ `hintAboveTokens`（默认 12,000）** 才发 |
| | 无 tokenizer 时：仍按节点数，行为不变 |
| 会话被压缩过 → 立即发 | 同左（压缩本身就说明历史已经丢了） |

配置：`tokenizerPath`（默认指向 `~/.dsh/token-tree/deepseek_v4_tokenizer/tokenizer.json`）、`hintAboveTokens`。
接口可观测：`GET /api/token-tree/settings` 返回 `tokenizer: { path, state }`，实测 `state: "ready"`。

### 谁更准：用账单口径对账

判据不是"谁看起来合理"，而是 **provider 实际计费**：每一步的 `usage.inputTokens + cacheReadTokens + cacheWriteTokens`
就是这次请求的 prompt 大小。取"只新增 1 问 + 1 答"的回合（单步、无工具调用），delta 就应当等于这两段文本的 token 数。

`node scripts/token-accuracy.mjs`：

| 会话 | 可比步数 | 官方 tokenizer MAE | 旧估算 MAE |
|---|---|---|---|
| `79f59106` | 7 | **47.7** | 83.3 |
| `fcff813b` | 3 | **32.3** | 178.7 |

逐步看（`fcff813b`，中文为主）：

| 步骤 | 计费 Δ | 官方计数 | 旧估算 |
|---|---|---|---|
| 1 | 462 | 397（−14%） | 606（**+31%**） |
| 2 | 426 | 396（−7%） | 608（**+43%**） |
| 3 | 420 | 422（+0.5%） | 630（**+50%**） |

**结论：官方 tokenizer 准，旧估算系统性地高估中文约 45%**（它把每个汉字当 1 token，实际约 1.6 汉字/token）。

两点保留：
1. 偏差不为零的部分（官方那 −7%～−14%）来自我重建请求时漏掉的框架级内容（系统提示、工具定义、运行时上下文），不是分词错误；
2. 这是**我们自己实现的 JS 读取器**，没能和 HF 参考实现在本机逐字节对拍（环境里没有 `transformers`）。但它对计费用的贴合在几个百分点内，这正是预算判断需要的性质。

另有一个方法上的坑值得记下：`37bfb65c` 这类会话里每步都有框架注入的运行时上下文/技能目录消息，我的重建只取 `source.kind === 'user'`，
于是 delta 里混进了没被计入的文本，两边的误差都会爆到 1000+ —— 那是重建口径的问题，不是分词器的问题。

### 字符级比例会不会变，能不能在线学

**会变，而且幅度很大**：同一个汉字在不同上下文里可能独占一个 token，也可能并进更大的词；英文更明显
（`a` 是 1 token，`attention` 也是 1 token）。实测同一批文本的字符/token 从 **1.50（中英混合）到 5.83（英文散文）**，
差了近 4 倍。所以"一个常数"必然错，但**分成宽字符（CJK/全角）与窄字符两类**就能贴近。

`src/core/ratio.ts` 用**在线最小二乘**拟合 `tokens ≈ a·宽字符 + b·窄字符`：每次拿到精确计数就 `observe()` 一次，
从先验 `a=0.6, b=0.2` 起步，样本越多越准。它的定位是**只做预筛，不做最终判断**：

- 预筛：估算值远低于阈值（< 0.6×阈值）时直接跳过，不数整个上下文；
- 逼近阈值时仍用官方 tokenizer 精确计数；
- 每次精确计数都会回喂给比例，形成闭环。

三者在真实计费口径下的对账（`scripts/token-accuracy.mjs`）：

| 会话 | 可比步数 | 官方 MAE | 学习比例 MAE | 旧单常数 MAE |
|---|---|---|---|---|
| `79f59106` | 7 | **47.7** | 51.9 | 83.3 |
| `fcff813b` | 3 | **32.3** | 44.7 | **178.7** |

结论：
- **官方最准**（残差主要来自重建请求时漏掉的框架级内容）；
- **学习比例紧随其后**（中文为主的会话 44.7 vs 官方 32.3），并且**第一步就有值**（从先验起步）；
- **旧单常数最差**，中文会话里高估近 1 倍。

### 宿主里的实际表现

配置 `tokenizerPath` 后，第一次 `agent/pre-step` 会加载（116 ms）并把样本喂给比例：

```text
start:       {"wide":0.6,"narrow":0.2,"observations":0}      state: unknown
after turn1: {"wide":0.6,"narrow":0.2204,"observations":4}   state: ready
after turn2: {"wide":0.639,"narrow":0.2204,"observations":5}
```

同时 `recountNodeTokens()` 把树上所有节点的 `tokens` 由估算改成实测 ——
**节点预算、注入块长度、payload 里的 token 数从此都是计费等价的值**。

一个实现细节值得记下：最初把预筛写在精确计数之前，结果短会话永远走不到计数，`state` 一直是 `unknown`、
比例永远停在先验。改成预筛阶段也先**加载并对最新 1–3 条消息**学习（`warmRatio`），两个问题一起消失。

### 模型升级后 tokenizer 会不会失准

**会。** `tokenizer.json` 与模型版本绑定：词表变了（增删 token、改预分词正则），同一段文本的 token 数就变，
典型幅度几个百分点，遇到新词表 + 中文/代码较多的文本可以到 10%+。这对本插件的影响面是：

| 用途 | 对漂移的敏感度 |
|---|---|
| 提示阈值（`hintAboveTokens`） | 低 —— 阈值本身漂移 ±10% 只是"早/晚一轮" |
| 节点预算（`tokenBudget`） | 低 —— 差几成不影响选择顺序 |
| 判断"能否塞进某个硬上限" | **高** —— 需要留 10% 余量 |

所以显式加了一个**漂移监测**（`TokenTreeService.observeBilling`），思路是拿"账单增量"比"计数增量"：

```text
ratio = Δ(billed input+cacheRead+cacheWrite) / Δ(counted)
```

只用增量是因为账单里还有系统提示、工具定义、运行时上下文这些我们不统计的固定开销 —— 用绝对值比会得到
26 倍这种荒谬数字（第一版就这么错的）。连续 3 个样本的均值落到 [0.85, 1.2] 之外时打一条 warn，
建议更新 `tokenizerPath`。`GET /api/token-tree/settings` 里暴露 `drift: { samples, ratio }`。

**它只告警，不自动修复**：真正跟上新模型只能换 `tokenizer.json`（配置项可换，不用改代码）。
另需注意：学习比例拟合的是"字符 → 我们的 tokenizer"，**不会自动跟随账单**，所以漂移时它一起漂。

对应测试：`tests/tokenizer.test.ts` 的 "the drift monitor compares billed growth against counted growth"
（模拟账单按 1.1× 增长，断言监测结果 ≈ 1.1）。

### 按模型版本自动选 tokenizer

每代模型有自己的一套词表，所以插件不再接受"一个文件路径"，而是接受**一个版本号**，自己去目录里找文件
（`src/plugin/tokenizer-select.ts`）：

| 配置 | 含义 |
|---|---|
| `tokenizerVersion: auto`（默认） | 选磁盘上**最新的**代数 |
| `tokenizerVersion: 4` / `'v4'` | 指定代数；没装就回退到最新，并在日志/settings 里说明 |
| `tokenizerVersion: deepseek-r1` | 从模型名解析：`r1` 归到 **v3** 词表 |
| `tokenizerVersion: off` | 彻底关掉精确计数，回到估算 |
| `tokenizerPath` | 显式文件，优先级最高（兼容旧配置） |

目录布局（默认 `$DSH_HOME/token-tree`）：

```text
token-tree/
  deepseek_v3_tokenizer/tokenizer.json
  deepseek_v4_tokenizer/tokenizer.json
```

宿主实测（`GET /api/token-tree/settings`）：

```json
"tokenizer": {"path":null,"state":"ready","version":4,"available":[3,4],"requested":"auto"}
```

### 模拟一场对话：v3 与 v4 的差别、以及旧估算错在哪

`node scripts/simulate-conversation.mjs --dir <token-tree> --threshold 150`，10 轮中英混合对话
（含报错、配置 JSON、工具输出）：

| 轮 | 文本长度 | 精确(v4) | 精确(v3) | 学习比例 | 旧估算 |
|---|---|---|---|---|---|
| 1 | 93 | 28 | 28 | 24 | 34 |
| 2 | 85 | 38 | 38 | 35 | 50 |
| 3 | 43 | 27 | 27 | 25 | 34 |
| 7 | 212 | **84** | **84** | 59 | **53** |
| 10 | 50 | 36 | 36 | 26 | 35 |
| 合计 | — | **323** | **323** | — | — |

三个结论：

1. **v3 与 v4 在这批文本上计数完全相同**（divergence 0）—— 两代共用同一套词表。
   所以"按版本选文件"目前是**保险**而不是立刻的收益；一旦哪天词表真的变了，它才生效。
2. **旧估算在中文段落高估**（34 vs 28、50 vs 38），**在 JSON/代码上低估**（53 vs 84），
   方向还不一致，所以无法用系数修正。
3. 阈值 150 时：**精确计数在第 6 轮触发，旧估算在第 4 轮就触发** —— 两轮的差距，等于白白多发两行提示。

再模拟"tokenizer 过期"（账单按 1.3× 计数）：漂移监测得到 `1.30` → **触发告警**。
这也说明为什么报警要留着：v3/v4 一样不代表下一代一样。

一个使用注意：漂移监测只在**真的做了精确计数**时采样（即上下文接近或超过阈值），
短会话里 `samples` 会一直是 0 —— 这是设计如此，不是坏了。

## 实验 9：最终配置的端到端效果（2026-10-22）

配置：`autoInject: false`、`retrievalHint: true`、`hintAboveTokens: 12000`、
`admitRelevance: 0.3`、`summaryMatch: true`、tokenizer v4（auto）。

两段，各两跑、交替顺序、脚本判分，账单数字取自 provider 的 `usage`：

### 段一：默认配置（短会话）

| 组 | 正确 | 新增 input/跑 | 缓存命中 | 提示行 | 最终上下文 |
|---|---|---|---|---|---|
| A 不装插件 | **8/8** | 2,461 | 97.89% | 0 | 10,037 |
| C 插件 | **8/8** | 2,507 | **98.10%** | **0** | 11,220 |

差异在噪声内（+1.9% 输入、+0.21pt 命中），**提示一行都没发** —— 短会话零成本，符合设计。

### 段二：把阈值降到 40（强制每轮发提示）

| 组 | 正确 | 新增 input/跑 | 缓存命中 | 提示行 | 最终上下文 |
|---|---|---|---|---|---|
| A 不装插件 | **8/8** | 2,483 | 97.85% | 0 | 9,851 |
| C 插件 | **8/8** | **2,351（−5%）** | **98.24%（+0.39pt）** | **20**（≈10/跑） | 11,652 |

提示真的注入了（每跑 10 行，共 20 行），成本影响很小：最终上下文 +18%（10 行 × 57 token = 570，
其余差异来自回答长度波动），输入甚至略低（噪声，n=2）。**命中率略升**：提示是稳定前缀，
不破坏缓存。

### 段二之前踩到的真 bug

第一次跑段二时 **0 行提示**，查出来是门槛算错了对象：`agent/pre-step` 的 `decision.messages`
**只含最新那条消息**（实测首轮 394 token），拿它和 12,000 的门槛比，永远不触发 ——
也就是说**提示功能在长会话里也是死的**，只是短会话本来就该"不发"，才没有暴露。

修法：门槛改成 **对话路径上的节点 token 之和**（`conversationTokens`，数据本来就存在树上、
加载 tokenizer 后是实测值），不再依赖 `decision.messages`。修完后宿主实测：

```text
lastHint: {"counted":100,"above":40,"fired":true,"reason":"conversation over threshold"}   hint lines: 1
lastHint: {"counted":90,"above":300,"fired":false,"reason":"conversation under threshold"} hint lines: 0
```

顺带加了一个诊断字段 `settings.lastHint = {counted, above, fired, reason}`，
以后"提示为什么没发"可以直接查，不用猜。

### 结论

- **默认配置下插件是隐形且免费的**：短会话 0 注入、成本与不装插件持平。
- **提示真的发出来时**：≈57 token/轮，对缓存命中略有正贡献，对输入量基本无感。
- 召回仍是 8/8 vs 8/8 —— 这些会话还没到"历史装不下"的程度，所以**收益仍未被证明**，
  能证明的是"成本可控"。



















## 实验 10：压缩之后，树还能不能救回细节（2026-10-22）

这是"检索到底有没有价值"的判决实验。两组装**同一个脚本**：把 4 个**精确字符串**塞进工具风格的
长 dump（探针超时 1733ms、sha256 前缀 9f2c41ab77de、灰度批次 rbx-2291、回滚阈值 0.42%），
再接 6 轮无关对话把它们推远，**手动 `/compact`**，然后逐个追问，要求只答原串。

| 组 | 正确 | input/跑 | 提示行 | 真的调用 retrieve_context |
|---|---|---|---|---|
| A 不装插件 | **8/8** | 4,790 | 0 | 0 |
| C 插件（提示阈值 200） | **8/8** | 6,995 | 13 | **0** |

**结论：依然无法证明收益，而且这次插件更贵。**

1. **压缩摘要把 4 个精确串全都保住了**（连 12 位十六进制前缀都对），所以基线天花板就是 8/8 ——
   没有可改善的空间。这是**天花板效应**，不是机制无效。
2. **提示发了 13 次，模型一次都没调用检索工具**（两次跑都是 0）。提示在真实使用中是**惰性的**。
3. 成本上插件 +46% input（含跑间方差：C 两次是 5,218 / 8,772）。

### 那到底什么情况下树才有用

只有当**上下文真的装不下**时才有意义，而当前 harness 的压缩摘要太忠实，装得下。
要造出收益场景必须人为降级摘要（改 `retainRatio` 或截断摘要），那不是真实配置，
测出来的数字也没有说服力。

所以到此为止，**诚实的结论**是：

- 树的确定价值 = 图形化编辑（分叉/改挂/隐藏/跳转）+ 精确 token 记账；
- 检索/反思这一路的成本是**可测的**（+46% 输入），收益**未被证明**；
- 默认配置因此保持 `autoInject: false`、提示阈值 12,000（短会话零成本），
  让它在不需要时不花钱、需要时不添乱。

## 实验 11：hook 里到底能不能"用检索替代拼接"（2026-10-23）

设计初衷是"检索一个子集替代全量历史"。要成立，插件必须**拿到并能改写完整历史**。
在 `agent/pre-step` 里实测两件事。

### 1. `decision.messages` 只是新增消息

| 轮次 | 收到的 messages | 字符数 | 来源 kind |
|---|---|---|---|
| 1 | 3 条 | 1,749 | user, runtime-context, skill-catalog |
| 2 | **1 条** | 15 | user |
| 3 | **1 条** | 15 | user |
| 4 | **1 条** | 22 | user |
| 5 | **1 条** | 22 | user |

同期树里累计约 150 token，且模型确实能接着上文回答 —— 所以历史不是从这里来的。

### 2. `decision` 只有两个字段

| 轮次 | 字段 | messages 大小 | 条数 |
|---|---|---|---|
| 1 | kind, messages | 3,536 字节 | 3 |
| 2 | kind, messages | 220 字节 | 1 |
| 3 | kind, messages | 220 字节 | 1 |

没有任何 history / context 容器。宿主把历史拼进 prompt 发生在 hook **之后**，
插件既看不到也改不到。宿主自己减少上下文靠压缩（包内可见 `contextFold` 相关符号；
桌面版实测触发过 2 次、共 73,838 token）。

### 结论

- 准确说法：**插件能改"这一步要追加的新消息"，不能改 prompt 里的历史**。
- 所以"检索替代拼接"在当前扩展点**不可实现**，不是没做。
- 注入只能增加 input：实测 +115%（19 轮）到 +149%（8 轮）；命中率变化在 ±0.5pt 噪声内。
- 唯一能真正减少 input 的杠杆是**按实测 token 提前触发 `/compact`**。
- 诊断字段：`settings.lastPrompt = {count, chars, kinds}`、`settings.lastDecision = {keys, sizes}`，
  日后可随时复核这两条结论。

## 压缩本身要花多少（2026-10-23，真实会话日志）

压缩不是免费的：`compaction/summary` 前面必然有一次带 `usage` 的 assistant 消息。
扫了 120 个会话、69 个 compaction 事件、12 次 summary，全部有账单：

| 会话 | prompt token | 输出 | 其中命中缓存 |
|---|---|---|---|
| 38b5a580 | 11,453 | 58 | 11,264（98.3%） |
| 56272a95 | 81,084 | 1,054 | 80,640（99.5%） |
| 37bfb65c | 726,962 | 760 | 726,784（99.98%） |
| d5bdaca3 | 15,130 | 4 | 14,976 |
| fa42cc54 | 11,046 | 2 | 10,880 |

平均 prompt **196,886 token**，就是整段历史；两次事件间隔约 2 秒。

两种机制要分清：

- `compaction/prune`：**不调模型**，机械丢弃（工具输出等），事件里带 `shadowedTokenCount`。
- `compaction/summary`：**调模型**，读全量历史写 checkpoint（`## Primary Request and Intent ...`）。
  `/compact` 与 `compactNow` 走这条（通常先 prune 再 summary）。

推论：

1. 自动压缩每次触发 = 一次全历史调用。钱不多（99% 是缓存读），但是真实开销与一次往返延迟。
2. 它省下的也主要是**便宜的缓存 token**（会话命中率 97–99%），所以"省钱"的边际收益很小；
   压缩真正的价值是**别撞上下文上限**、降低延迟。
3. 因此默认冷却定为 **10 分钟**，且默认关闭（阈值 0）。压得太勤只是反复付调用费。
4. 细节不丢：树里存原文，压缩后的第一条提示带"折叠节点索引"指路。
