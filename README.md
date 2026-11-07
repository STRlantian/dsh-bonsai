# 盆栽 / Bonsai

[English](README.en.md) · 简体中文

**DeepSeek Harness 的对话树插件，先把两件最花钱的事做好：折叠历史、按需检索。**

一段对话被画成一棵树：问题、回答、工具结果都是节点，可以分叉、改挂、隐藏、回收、跳回某一点继续长。
树上挂着精确到 token 的记账；模型默认只看到折叠后的历史，需要旧细节时再通过 `retrieve_context`
把原文取回来。

```text
dsh-bonsai · DeepSeek Harness 插件 · 零运行时依赖 · MIT · Node ≥ 24
```

## 折叠历史

> **折叠省的是 prompt 体积，账单要看缓存价格。** 真机 web A/B（同工具、同问题、13 轮、5 题全对）：
> default 的 prompt token **−15.4%**，aggressive **−36.3%**；按 cache miss = 50× hit 折算，
> default 成本 **−9.7%**，aggressive **−2.9%**——**default 反而更省**，因为 aggressive 折得更频繁，
> 每次折叠都让保留窗口重新按 miss 计价。两者盈亏平衡点约 **18.3×**。
>
> 这是**有价格假设**的结论，不是“越早折越省”。记 `miss/hit = ρ`、保留窗口 `W`、待折块 `T`，
> 一次折叠赔约 `(ρ−1)·W`，之后靠省下的块慢慢回本；稳态最优阈值
> `T* = t·√(2K(ρ−1))`（`t` 每轮 token、`K` 保留轮数）。默认 `K=2, ratio=8` 在 ρ=50 时接近最优。
> 所以折叠适合**长会话**；短会话或 miss/hit 很低时，先别急着折。

会话历史由宿主从日志派生。插件追加一条 `surfaceOp: { op: 'replace', startSeq, endSeq }` 事件，
被覆盖的区间就不再进入 `deriveMessages()` —— **原始日志一个字节都没改**，树里也仍然是全文。

默认按 DeepSeek 的缓存价 `0.02`（命中）/ `1`（未命中）自动算阈值，保留最近 2 轮；两次折叠至少隔 10 轮。
公式：

```text
T* = avgTurnTokens × √(2 × keepTurns × (miss/hit − 1))
```

设置页仍保留手动模式：直接填待折块 token，`0` 关闭折叠。三个预设：

| 预设 | 行为 | 折叠 | 模型侧影响 | 隐藏工具 |
|---|---|---|---|---|
| **默认** | 通用起点；成本与上下文平衡 | 自动阈值 | 注入/提示/候选/摘要/反思 | 无 |
| **只建树** | 只记录完整树 | 关闭 | 全部关闭；工具仍可显式调用 | 无 |
| **关闭** | 对模型静默 | 关闭 | 全部关闭；插件工具也隐藏 | 6 个插件工具 |

折叠后的占位行会告诉模型原文在哪：

> `[已折叠] 之前的 1 轮对话已从上下文移除以节省 token；原文完整保存在对话树中，需要细节时先调用 retrieve_context 取候选索引，再用返回的 nodeId 取详情，不要凭印象编造。`

## 检索：按需取回

`retrieve_context` 是两阶段的：先返回节点索引（id、类型、问题/摘要、大小），不返回正文；
模型挑一个节点后，再用 `nodeId` 取全文或摘录。另一个工具 `tree_query` 可以直接看树和节点详情。

长回答不摘要（摘要会改写代码与数字），按大小分三档：

```text
≤ 800 token    原文
800–3000       逐字节选：开头 + 与问题匹配的整句（不重写）
> 3000         一行"它是什么" + 原文行数 + 指向树
```

长档只给标识是**有意的**：代码、数字、原文措辞必须回树里读，提示里也会告诉模型“节选不等于原文”。

检索默认使用本地 256 维 hash（零依赖、离线可用）。可选 BGE：

```yaml
config:
  bge: true
  bgeModel: Xenova/bge-small-zh-v1.5
  bgeChunkChars: 300
```

只在显式 `retrieve_context` 里启用：节点按 300 字切块，用 chunk `meanAll` 算相关性；
BGE 不可用、模型加载失败或调用失败时逐次回落到 hash。挂树、自动注入和边成本仍走原路径。
启用需要额外安装 `@huggingface/transformers` 并准备模型缓存。

**诚实的边界：检索本身没有测出召回增益。** 按生产顺序重放 219 个问题：父回答进检索结果
**23%**、排第一 **11%**；注入组与对照组答对 5/5 vs 5/5。`mandatoryContext` 把它抬到 ≈99%
是**强制注入**，不是检索变准。

## 先看证据

数字分两类，都在 `docs/experiment-context-cache.md` 里有记录：**实测**（真机 A/B、日志重放、计费字段）
与**模拟**（按声明的价格比估算成本）。每条后面注明属于哪类。

| 能力 | 状态 | 实测 |
|---|---|---|
| **折叠历史** | 默认开启；默认按 0.02/1 缓存价自动算阈值 | 真机 web A/B（13 轮）：default prompt **−15.4%**、aggressive **−36.3%**；按 miss=50×hit 折算，default 成本 **−9.7%**、aggressive **−2.9%**（default 最省）。每次折叠都会改写前缀，这是它的真实代价 |
| 折叠对缓存的影响 | — | 每次折叠改写前缀 → 缓存命中失效，这是它真正的代价（实验 23） |
| 检索（`retrieve_context`） | 可用；默认不自动注入 | 5 次实验里没有测出召回增益；需要旧细节时由模型显式调用 |
| **隐藏工具** | 可选，默认藏 `tree_mark` / `tree_focus`；设为 `[]` 全部显示 | 37 → 28 个工具：**10,453 → 7,076 token/轮（−32%）** |
| 图形化树编辑 / 回收站 | 完成 | 分叉、改挂、隐藏、恢复、跳转、分支对比；**取消的回合自动移出** |
| 精确 token 记账 | 完成 | 官方 tokenizer；没有词表时用账单反推 |

## 安装

需要 DeepSeek Harness（桌面版或 `dsh` CLI）。桌面版请**先完全退出**再装。

```powershell
dsh plugin --profile desktop add dsh-bonsai
```

重启后：输入框上方出现 **🌳 盆栽** 面板，会话标题栏出现「盆栽」按钮。

本地开发（不经过 npm）：

```powershell
pnpm install; pnpm run build; node scripts/stage.mjs
dsh plugin --profile desktop add "file:<仓库路径>/plugin"
```

> 别用 `link:` 指向仓库根目录 —— 桌面版会把根目录当成工作区扫描。

## 界面

- **输入框上方的 dock**：左画布右详情，不遮挡对话；点节点跳到对话里那一轮。
- **「盆栽」编辑器**：五个页签 —— 对话块 / 完整树 / 图形 / 回收站 / 设置。
- **拖一行到另一行**：改父节点，整棵子树跟着走；**删除**是软隐藏，回收站里能恢复。
- **「从这里继续」**：下一轮你输入的问题会挂到这个节点下（只影响一轮）。

## 把落点判断交给模型

模型每轮会收到最多 10 条候选（只有**问题**，没有回答正文），并在回答前调用工具：

```text
tree_attach(target="nX", summary="方面 1, 方面 2")
```

`target` 取值：

```text
"nX"    依赖候选里的某一条（含代词指代）
"root"  这是新话题，挂到根
"here"  要求/元指令（"我来问，你来看对不对"），留在当前线上
"auto"  保持自动落点（只想交摘要时用）
```

提示里还有一句：**问题问的是某条回答里提到的子概念时，挂那条回答**。这一句让“讲了 A，其中提到 B
和 C，再分别问 B、C”都挂回 A —— 实测 3/5 → 5/5（同一 5 次追问）；没有它时两问会串成 B→C 的链。

插件只接受**本轮真的发过**的 id：模型编的节点号一律忽略。落点和摘要走工具参数，不再写进回答正文，
所以不会留下 `[attach:...]` / `[summary:...]` 尾巴。

## 设置

全部可运行时改，存 `~/.dsh/token-tree/settings.json`（只存你改过的键）；优先级 **设置文件 > profile 配置**。
设置分两个范围：**全局**（所有对话）与**本对话**（只覆盖当前会话，清空某项即回落到全局）。

### 折叠与缓存价格

| 键 | 默认 | 作用 |
|---|---|---|
| `autoFold` | `true` | 默认用缓存价格自动算阈值；关闭后回到手填阈值 |
| `cacheHitPrice` | `0.02` | 缓存命中相对价格；和未命中都 >0 时启用自动阈值 |
| `cacheMissPrice` | `1` | 缓存未命中相对价格；需大于命中价 |
| `foldAboveTokens` | `30000` | 手动待折块下限；自动阈值优先，此项只作兜底 |
| `foldBlockRatio` | `8` | 待折块 ≥ 这个倍数 × 保留窗口；`0` 关闭相对规则 |
| `foldCadence` | `10` | 两次折叠至少间隔这么多轮（折叠会重写前缀缓存） |
| `foldTrigger` | `block` | `block` 按块判定；`history` 是旧行为 |
| `foldKeepTurns` | `2` | 最近这么多轮原样保留（公式里的“窗口”） |
| `foldScope` | `turns` | `turns` 整轮折叠，`tools` 只折叠工具输出 |

设置页的高级区里，**折叠阈值**是一行下拉 + 输入：

- `自动选阈值`：填命中/未命中价格，按实际平均每轮 token 算；
- `手动填阈值`：直接填待折块 token。

### 检索与落点

| 键 | 默认 | 作用 |
|---|---|---|
| `autoInject` | `false` | 每回合把检索结果整块推进上下文（约 +428 token/轮） |
| `retrievalHint` | `true` | 只加一行提示，约 57 token/轮 |
| `hintAboveTokens` | `30000` | 第一次折叠后发提示；值只作诊断，不再单独触发 |
| `admitRelevance` | `0.3` | 检索准入阈值，空手时自动放宽一次 |
| `mandatoryContext` | `true` | 强制把“父回答 + 它的提问”放进检索结果；这是接线保证（≈99%），不是打分增益 |
| `fileRegion` | `auto` | 检索返回本会话读过文件的当前内容（auto/digest/content/off） |
| `attachChoices` | `10` | 每轮给模型看的候选问题数量（只给问题，不给正文）；`0` 关闭 |
| `attachPrompt` | `any` | `any`：依赖用 `target="nX"`、新话题 `"root"`、元指令 `"here"`；`follow`：只问指代 |
| `attachGate` | `always` | `uncertain`：只在本地没把握时才发候选块 |
| `attachSummary` | `true` | 每轮要求模型在 `tree_attach` 里带“方面摘要”；没写时用前 200 字兜底 |

### 其他

| 键 | 默认 | 作用 |
|---|---|---|
| `autoReflect` | `true` | 回合结束评估失败、写反思、回溯更优兄弟分支 |
| `toolDeny` | `[tree_mark, tree_focus]` | 要隐藏的工具名（用勾选面板填） |
| `tokenizerVersion` | `auto` | `auto` / `3` / `4` / `off`（估算 + 账单校准） |
| `locale` | `auto` | 界面语言：`auto` / `zh` / `en` |

**隐藏工具**是可选的省 token 手段：prompt 里 83% 的字符是工具定义，勾选后按 agent 生效。
默认只藏 `tree_mark` / `tree_focus` 两个在 201 个真实会话里从未被调用、却占约 570 token/请求的工具；
想把能力全部还给模型，就在设置里勾选“全部显示”（写入 `toolDeny: []`）。名单必须写对：
宿主会校验工具名，有一个不认识的就整批拒绝。

接口：`GET /api/token-tree/settings` 返回 `{ effective, overrides, path, availableTools, fold, toolRestriction, lastAssembly, … }`；
`POST` 同一路径写 `{ key: value }`（`null` 表示清除覆盖）；`POST /api/token-tree/preset` 一次写入整包预设。

## 诊断命令

五个斜杠命令，都在会话里直接发，结果只给你看、不进模型历史：

| 命令 | 看什么 |
|---|---|
| `/tree` | 对话树（`/tree go n12` 把下一轮挂到 n12，`/tree clear` 取消） |
| `/prompt` | 上一轮提示词构成：系统提示各区字符数、工具占多少、hook 收到的消息形状 |
| `/fold` | 上一次折叠决策：折了几轮、待折块大小、阈值、是否被 cadence/比例挡下 |
| `/usage` | 上一轮计费：新输入 / 缓存命中 / 缓存写 各多少，以及命中率 |
| `/retrieve` | 上一次 `retrieve_context`：query、预算、用了多少 token、选中与丢弃的节点 |

空会话里每个命令都会回一行说明而不是报错；计费字段（`/usage`）是账单原文，
插件自己的 token 数在加载了词表时是精确值，没有词表时是估算/账单校准值。

## 它怎么工作

```text
用户提问
  │
  ├─ 本地：打分 + 指代闸 + 新话题闸 → 给出默认父节点
  │
  ├─ 注入（每轮第一步）：检索提示（体积达标才出现）+ 候选问题块（≤10 条，只给问题）
  │
  ├─ 模型回答前调用 tree_attach：
  │     target="nX"   依赖候选里的某一条
  │     target="root" 这是新话题，挂到根
  │     target="auto" 保持自动落点
  │
  └─ 插件：工具给了落点就改挂（只接受本轮发过的 id），没给就用本地默认
```

**模型每轮实际看到什么**

- 宿主发来的对话历史（回答全文），直到折叠/压缩把它削短；
- 折叠：待折块（“保留最近 2 轮”之外的历史）超过自动阈值、且不小于 `foldBlockRatio` × 窗口时，
  把这些轮次换成占位行，且两次折叠至少隔 `foldCadence` 轮；
- 候选块的 10 条**问题**（不含回答正文）；
- 需要别处的正文时，先调 `retrieve_context` 取候选索引，再用返回的 `nodeId` 或 `tree_query` 取详情。

所以“模型只看得到上一轮正文”只在**折叠已经触发**的长会话里成立；短会话里它看到的是完整历史。

- 树完全由 `user/message`、`assistant/message`、`tool/result` 重放得到，不追加自定义事件；
- 推理内容**计入 token 但不保存**（计费字段里的输出 token 远大于正文长度，只存正文会让所有阈值失真）；
- 折叠只写一条 `surfaceOp: replace`，日志 append-only。

## 诚实的边界

- **检索本身没测出增益。** 按生产顺序重放 219 个问题：父回答进检索结果 **23%**、排第一 **11%**；
  `mandatoryContext` 把它抬到 ≈99% 是**强制注入**，不是检索变准。
- **折叠会让模型看不到被折叠的内容。** 实测中它诚实回答“会话里没有这段”，而不是编造 ——
  但它也不一定去调 `retrieve_context`。
- **开场轮永远不折叠**：第一个 surface 节点是系统提示词，只能由系统消息重写。
- **压缩 ≠ 丢信息**：树里存全文，压缩只是把提示词削短。

## 证据的边界

所有数字都能用仓库里的脚本复现，但都有适用范围。引用时请连条件一起引：

| 结论 | 样本 | 条件 |
|---|---|---|
| 工具裁剪 −32% | 1 次真实装配（37→28 个工具） | 单机、当时的 profile 工具集 |
| 折叠 prompt：default −15.4%、aggressive −36.3% | 每臂 1 次、13 轮 | web host，5/5 正确，tool calls=0 |
| 折叠成本：default −9.7%、aggressive −2.9% | 同上 | **假设** cache miss=50×hit；不是账单 |
| 挂接命中 14/18 | 18 条人工标注（1 个会话） | 单一标注者 |
| 同义改写 3/8、跳跃集 6/15 | 8 条 / 15 条合成探针 | 同一会话、追加提问 |
| 检索无增益 | 219 个问题重放 | 单会话（37bfb65c）、生产顺序 |

**不做的断言**：没有说“任何场景都更省”；折叠在短会话或 miss/hit 很低时可能更贵。
反例与失败实验都留在 `docs/experiment-context-cache.md`：BM25、jieba 分词、BGE 向量、检索准入等。

价格比（缓存读 / 漏价）是**假设**而不是常量：默认 `K=2, ratio=8` 在 ρ=50 时接近最优
`T*/W = √(2(ρ−1)/K)=7`。实际价格不同时用设置页的自动阈值重算。

## 开发

```powershell
pnpm install
pnpm run build      # TypeScript → dist/ + lib/client.js
pnpm test           # 251 个用例
pnpm run check      # 类型检查 + 测试
```

零成本自查（不需要模型）：

| 命令 | 作用 |
|---|---|
| `node scripts/bench-retrieval.mjs` | 检索召回 vs token 成本 |
| `node scripts/probe-tree-of.mjs <session>` | 离线重放某个会话的树 |
| `node scripts/probe-attach.mjs <session>` | 每次挂父决策的分数 |
| `node scripts/probe-fold-estimate.mjs <session>` | 折叠能省多少 |
| `node scripts/sweep-fold-params.mjs 100` | 折叠参数网格（短/中/长三种会话） |
| `node scripts/experiment-default-vs-baseline.mjs 60 3500 default` | 日常默认 vs 全上下文的逐轮成本 |
| `node scripts/inspect-compaction.mjs` | 统计压缩事件 |

需要模型在环的实验脚本在 `scripts/ab-*.mjs` 与 `probe-*.mjs`，结果在 `docs/experiments/`。

## 发布

仓库里的版本**永远是测试版**（`x.y.z-test.N`），发布时脚本转成正式版：

```powershell
powershell -File scripts/release.ps1 -DryRun   # 演练
powershell -File scripts/release.ps1           # 发布并推进到下一个测试版
```

它会：校验 → 改成 `x.y.z` → `npm publish --tag latest` → 本地推进到 `x.y.(z+1)-test.0` → 提交、打 tag、推送。失败自动回滚。

## 目录

| 路径 | 内容 |
|---|---|
| `src/core/` | 纯算法：图、边权、路径成本、加权检索、评估与回溯 |
| `src/plugin/` | DSH 接线：`Config`、会话服务、工具、事件订阅、HTTP 路由、折叠规划 |
| `client/client.js` | 浏览器端：dock、编辑器、图形视图、回收站、规则栏、设置面板、预设选择器 |
| `tests/` | 251 个用例，含 jsdom 挂载真实 React 的客户端测试 |
| `docs/experiment-context-cache.md` | 全部实测记录（53 节，含失败实验） |

## License

MIT © 2026 STRlantian
