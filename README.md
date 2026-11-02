# 盆栽 / Bonsai

[English](README.en.md) · 简体中文

**DeepSeek Harness 的对话树编辑器，外加两个真的能省 token 的开关。**

一段对话被画成一棵树：问题、回答、工具结果都是节点，可以分叉、改挂、隐藏、回收、跳回某一点继续长。
树上还挂着精确到 token 的记账，以及两种"把不该再发的东西挡在模型视野之外"的手段。

```text
dsh-bonsai · DeepSeek Harness 插件 · 零运行时依赖 · MIT · Node ≥ 24
```

## 先看证据

所有数字都来自本仓库 `docs/experiment-context-cache.md` 里的实测，不是估算。

| 能力 | 状态 | 实测 |
|---|---|---|
| **隐藏工具** | 可选（默认不藏） | 37 → 28 个工具：**10,453 → 7,076 token/轮（−32%）** |
| **折叠历史** | 默认开启，40,000 token 起 | 真机 A/B：prompt/步 **−9.2%**，但新增输入 **+202%**（缓存失效）；短会话折算后**更贵** |
| 折叠对缓存的影响 | — | 每次折叠改写前缀 → 缓存命中失效，这是它真正的代价（实验 23） |
| 图形化树编辑 / 回收站 | 完成 | 分叉、改挂、隐藏、恢复、跳转、分支对比；**取消的回合自动移出** |
| 规则编辑器 | 完成 | 手写/自动识别的规则以胶囊列出，可增删改，随检索提示发给模型 |
| 精确 token 记账 | 完成 | 官方 tokenizer；没有词表时用账单反推 |
| 检索增益（`retrieve_context`） | **未证明** | 5 次实验里没有测出召回收益，默认不注入 |

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

## 两个省 token 的开关

### 1. 隐藏工具（可选，最直接）

prompt 里 83% 的字符是工具定义。设置页「隐藏工具」会从宿主拿到真实工具清单，勾选后按 agent 生效：

```text
37 个工具、34,271 字符 → 28 个、21,224 字符
prompt  10,453 → 7,076 token（−32%，每轮都省）
```

默认一个都不藏，因为藏掉的是**能力**。名单必须写对：宿主会校验工具名，有一个不认识的就整批拒绝（设置页会把原文错误显示出来）。

### 2. 折叠历史（默认开启）

> **折叠省的是 prompt 体积，不是账单。** 真机 A/B（同工具、同问题，ABBA 各 2 次）：prompt/步
> 10,345 → 9,392（−9.2%），但新增输入 3,674 → 11,112（+202%）—— 每次折叠都改写 prompt 前缀，
> 之前的缓存随之失效。按"缓存读 ≈ 输入价 1/10"折算，6 轮会话里开折叠反而**贵约 23%**。
>
> 所以折叠适合**长会话**（折叠次数相对回合很少，被折内容又大），不适合三五轮就折一次的短对话。
> 这也是默认阈值取 40,000 而不是更低的原因。详见 `docs/experiment-context-cache.md` 实验 23。

会话历史由宿主从日志派生。插件追加一条 `surfaceOp: { op: 'replace', startSeq, endSeq }` 事件，被覆盖的区间就不再进入 `deriveMessages()` —— **原始日志一个字节都没改**，树里也仍然是全文。

```text
默认：超过 40,000 token 开始折叠，保留最近 3 轮，按整轮折叠
保留：60,000 起折、留 4 轮
节省：20,000 起折、留 2 轮，并隐藏 9 个少用的重工具
```

设置页顶部有三个预设，也可以逐项调：

| 预设 | 折叠阈值 | 保留轮数 | 隐藏工具 |
|---|---|---|---|
| **保留** | 60,000 | 4 | 无（最接近原生行为） |
| **平衡**（默认） | 40,000 | 3 | 无 |
| **节省** | 20,000 | 2 | 9 个少用的重工具 |

| 设置 | 默认 | 作用 |
|---|---|---|
| `foldAboveTokens` | `40000` | 超过就折叠；`0` 关闭 |
| `foldKeepTurns` | `3` | 最近这么多轮原样保留 |
| `foldScope` | `turns` | `turns` 整轮折叠，`tools` 只折叠工具输出 |

折叠后的占位行会告诉模型原文在哪：

> `[已折叠] 之前的 1 轮对话已从上下文移除以节省 token；原文完整保存在对话树中，需要细节时调用 retrieve_context 取回。`

## 把落点判断交给模型

模型每轮会收到最多 10 条候选（只有**问题**，没有回答正文），并可以在回答最后点名：

```text
[attach:nX]    依赖候选里的某一条（含代词指代）
[attach:root]  这是新话题，挂到根
[attach:here]  要求/元指令（"我来问，你来看对不对"），留在当前线上
```

提示里还有一句：**问题问的是某条回答里提到的子概念时，挂那条回答**。这一句让"讲了 A，其中提到 B
和 C，再分别问 B、C"都挂回 A —— 实测 3/5 → 5/5（同一 5 次追问）；没有它时两问会串成 B→C 的链。

插件只接受**本轮真的发过**的 id：模型编的节点号一律忽略，标记从正文剥掉，不进树也不进下一轮。

## 长内容怎么给

长回答不摘要（摘要会改写代码与数字），按大小分三档：

```text
≤ 800 token    原文
800–3000       逐字节选：开头 + 与问题匹配的整句（不重写）
> 3000         一行"它是什么" + 原文行数 + 指向树
```

长档只给标识是**有意的**：代码、数字、原文措辞必须回树里读（`retrieve_context`），
提示里也会告诉模型"节选不等于原文"。

## 设置

全部可运行时改，存 `~/.dsh/token-tree/settings.json`（只存你改过的键）；优先级 **设置文件 > profile 配置**。

| 键 | 默认 | 作用 |
|---|---|---|
| `autoInject` | `false` | 每回合把检索结果整块推进上下文（约 +428 token/轮） |
| `retrievalHint` | `true` | 只加一行提示，约 57 token/轮 |
| `hintAboveTokens` | `12000` | 对话达到这个 token 数才发提示 |
| `autoReflect` | `true` | 回合结束评估失败、写反思、回溯更优兄弟分支 |
| `admitRelevance` | `0.3` | 检索准入阈值，空手时自动放宽一次 |
| `toolDeny` | `[tree_mark, tree_focus]` | 要隐藏的工具名（用勾选面板填）；这两个在 201 个会话里从未被调用 |
| `foldAboveTokens` | `40000` | 折叠阈值，`0` = 关闭 |
| `foldKeepTurns` | `3` | 保留最近轮数 |
| `foldScope` | `turns` | 折叠范围 |
| `attachChoices` | `10` | 每轮给模型看的候选问题数量（只给问题，不给正文）；`0` 关闭 |
| `attachPrompt` | `any` | `any`：依赖写 `[attach:nX]`、新话题写 `[attach:root]`、元指令写 `[attach:here]`；`follow`：只问指代 |
| `attachGate` | `always` | `uncertain`：只在本地没把握时才发候选块（实测按会话类型两极分化，0%–100%） |
| `attachSummary` | `false` | 让模型在回答末尾写"方面摘要"，显示在候选列表里；实测无收益，默认关 |
| `mandatoryContext` | `true` | 把一个回合的"父回答 + 它的提问"强制放进检索结果；这是接线保证（≈99%），不是打分检索的增益 |
| `fileRegion` | `auto` | 检索返回本会话读过文件的当前内容（auto/digest/content/off） |
| `tokenizerVersion` | `auto` | `auto` / `3` / `4` / `off`（估算 + 账单校准） |
| `locale` | `auto` | 界面语言：`auto` / `zh` / `en` |

接口：`GET /api/token-tree/settings` 返回 `{ effective, overrides, path, availableTools, fold, toolRestriction, lastAssembly, … }`；
`POST` 同一路径写 `{ key: value }`（`null` 表示清除覆盖）；`POST /api/token-tree/preset` 一次写入整包预设。

## 它怎么工作

```text
用户提问
  │
  ├─ 本地：打分 + 指代闸 + 新话题闸 → 给出默认父节点
  │
  ├─ 注入（每轮第一步）：检索提示（体积达标才出现）+ 候选问题块（≤10 条，只给问题）
  │
  ├─ 模型回答；可以在最后写：
  │     [attach:nX]   依赖候选里的某一条
  │     [attach:root] 这是新话题，挂到根
  │
  └─ 插件：有标记就改挂（只接受本轮发过的 id），没有就用本地默认
```

**模型每轮实际看到什么**

- 宿主发来的对话历史（回答全文），直到折叠/压缩把它削短；
- 折叠：估算 prompt 超过 `foldAboveTokens`（默认 40,000）时，把"保留最近 3 轮"之外的历史换成占位行；
- 候选块的 10 条**问题**（不含回答正文）；
- 需要别处的正文时，调 `retrieve_context` 从树里取。

所以"模型只看得到上一轮正文"只在**折叠已经触发**的长会话里成立；短会话里它看到的是完整历史。

- 树完全由 `user/message`、`assistant/message`、`tool/result` 重放得到，不追加自定义事件；
- 推理内容**计入 token 但不保存**（一个回答实测 9,454 输出 token 对 369 字符正文，只存后者会让所有阈值失真）；
- 折叠只写一条 `surfaceOp: replace`，日志 append-only。

## 诚实的边界

- **检索本身没测出增益。** 按生产顺序（消息入树后再检索）重放 219 个问题：父回答进检索结果 **23%**、排第一 **11%**；实验二的注入组与对照组答对 5/5 vs 5/5。`mandatoryContext` 把它抬到 ≈99% 是**强制注入**，不是检索变准。
- **折叠会让模型看不到被折叠的内容。** 实测中它诚实回答"会话里没有这段"，而不是编造 —— 但它也不一定去调 `retrieve_context`。
- **开场轮永远不折叠**：第一个 surface 节点是系统提示词，只能由系统消息重写。
- **压缩 ≠ 丢信息**：树里存全文，压缩只是把提示词削短。

## 开发

```powershell
pnpm install
pnpm run build      # TypeScript → dist/ + lib/client.js
pnpm test           # 201 个用例（后端 176 + 浏览器端 25）
pnpm run check      # 类型检查 + 测试
```

零成本自查（不需要模型）：

| 命令 | 作用 |
|---|---|
| `node scripts/bench-retrieval.mjs` | 检索召回 vs token 成本 |
| `node scripts/probe-tree-of.mjs <session>` | 离线重放某个会话的树 |
| `node scripts/probe-attach.mjs <session>` | 每次挂父决策的分数 |
| `node scripts/probe-fold-estimate.mjs <session>` | 折叠能省多少 |
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
| `tests/` | 201 个用例，含 jsdom 挂载真实 React 的客户端测试 |
| `docs/experiment-context-cache.md` | 全部实测记录（1–15） |

## License

MIT © 2026 STRlantian

