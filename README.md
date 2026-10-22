# 盆栽 / Bonsai — DSH 的对话树编辑器

一句话：**把一段对话画成树，然后手动修剪它** —— 分叉、改挂、隐藏、跳回某一点继续长。

```
dsh-bonsai   ·   DeepSeek Harness 插件   ·   零运行时依赖   ·   MIT
```

![status](https://img.shields.io/badge/status-0.1.0--experimental-orange)
![license](https://img.shields.io/badge/license-MIT-blue)

## 先说实话：什么被证明了，什么没有

| 能力 | 状态 |
|---|---|
| 图形化树编辑（分叉 / 改挂 / 隐藏 / 跳转 / 分支对比） | **日常在用，稳定** |
| 精确 token 记账（官方 tokenizer、预算折扣、漂移告警） | **稳定**，与账单口径对齐 |
| 加权检索 + 反思回溯（自动注入 / 提示词） | **默认关闭**；5 次实验里未测出召回收益，见 [实验记录](docs/experiment-context-cache.md) |

所以这个包的核心价值是**树的可视化与编辑**，检索是附带能力。默认配置下它**不会**往你的上下文里塞任何东西。

## 安装

要求：DeepSeek Harness（桌面版或 `dsh` CLI）。

```powershell
# 装到某个 profile（桌面版请先完全退出）
dsh plugin --profile desktop add dsh-bonsai
```

从本地源码安装（开发用）：

```powershell
node scripts/build.mjs
node scripts/stage.mjs                       # 产出自包含的 plugin/ 目录
dsh plugin --profile desktop add "file:<仓库路径>/plugin"
```

> 不要用 `link:` 指向仓库根目录：桌面版会把根目录当工作区扫描。用上面的 `plugin/` 拷贝。

重启后：会话输入框上方出现 **🌳 盆栽** 面板，右上角出现「盆栽」按钮。

## 界面语言

设置页签最后一行可以选：**自动 / 中文 / English**，存进 `~/.dsh/token-tree/settings.json`（键 `locale`）。

`自动` 跟随 **浏览器/系统语言**（`navigator.language`）。**不读宿主的 `<html lang>`**：那是模板里写死的
`en`，真正的中文是宿主在运行时改的，早期版本因此把中文界面显示成了英文。

结构性文案（页签、按钮、设置项、tokenizer 下拉、分支列表）已双语；少数操作提示（"已置顶 n12"这类）
仍是中文，避免碎片化翻译。

## 用起来是什么样

- **嵌入式面板**（输入框上方）：图形/列表两种视图，右侧是操作栏，不用离开对话区。
- **「盆栽」按钮**：打开独立编辑器，四个页签 —— 对话块 / 完整树 / 图形 / 设置。
  选中一个**有 2 个以上分支**的节点时，右侧详情里直接列出各分支的问题、回答、入边代价，
  每行一个「从这里继续」，不用再切页签。
- **点击节点**：跳到对话里对应的那一轮。
- **拖一行到另一行**：改父节点（整棵子树跟着走）；**删除**是软隐藏，可撤销。

## 配置

全部可运行时改（顶部「盆栽」→ 设置页签），也可以写进 profile 的 `cordis.patch.yml`：

| 开关 | 默认 | 作用 |
|---|---|---|
| `autoInject` | `false` | 每回合把检索结果整块推进上下文（实测约 +428 tok/轮） |
| `retrievalHint` | `true` | 只加一行提示，让模型自己决定是否检索（约 57 tok/轮） |
| `hintAboveTokens` | `12000` | 对话 token 达到该值才发提示 |
| `autoReflect` | `true` | 回合结束时评估失败、写反思、回溯更优兄弟分支 |
| `admitRelevance` | `0.3` | 检索准入的余弦阈值，空手时自动放宽一次 |
| `tokenizerVersion` | `auto` | 选哪一代 tokenizer，或 `off` 用估算 + 账单校准 |

没有对应 `tokenizer.json` 的模型（含闭源）：节点预算会按 `conservativeBudgetRatio`（默认 0.85）打折，
并用 provider 返回的 `usage` 做校准；偏差过大时打告警。

## 它怎么工作

把对话建模成带成本的树：问题、回答、工具结果、反思都是节点，父子边带非负 `cost`
（语义跳跃、时间间隔、分支切换、用户标记）。检索时把「路径成本 → `exp(-λ·cost)`」与主题相关度
合成权重，按阈值、Top-k、token 预算贪心选取；工具失败会抬升边权并写入反思节点。

不修改 DSH 主仓库，不追加自定义会话事件 —— 树完全由 `user/message`、`assistant/message`、
`tool/result` 重放得到，所以重载后仍可复现。

## 发布

```powershell
# 本机 npm 配的是镜像源，不能发布；脚本会显式指定官方源
powershell -File scripts/release.ps1 -DryRun   # 演练：构建 + 109 测试 + 打包清单
npm login --registry https://registry.npmjs.org/
powershell -File scripts/release.ps1           # 真发布（开了 2FA 就加 -Otp <code>）
```

`prepublishOnly` 会先跑构建、暂存与全部测试，任何一步失败都不会上传。

## 开发

```powershell
pnpm install
pnpm run build      # TypeScript → dist/ + lib/client.js
pnpm test           # 106 个用例（后端 101 + 浏览器端 5）
pnpm run check      # 类型检查 + 测试
```

数据位置：`~/.dsh/token-tree/`（`DSH_HOME` 决定根目录）—— `edits.jsonl` 是手工编辑记录，
`settings.json` 只存被覆盖的键，`deepseek_v<N>_tokenizer/` 放词表。

## 目录

## 目录

| 路径 | 内容 |
|---|---|
| [`src/core/`](src/core) | 纯算法：数据结构、边权、Dijkstra 路径成本、加权检索、评估/回溯策略 |
| [`src/plugin/`](src/plugin) | DSH 接线：`Config`、会话服务、5 个工具、事件订阅、三条 HTTP 路由 |
| [`client/client.js`](client/client.js) | 浏览器端：头部「树/图」按钮 + 输入框上方的嵌入式 dock（图形/列表 + 右侧操作栏） |
| [`tests/`](tests) | 81 个用例：图算法、检索、回溯策略、挂载、树形状、持久化、HTTP 路由、软删除 |
| [`scripts/demo.ts`](scripts/demo.ts) | 无框架的端到端演示（构建 → 检索 → 失败 → 反思 → 回溯） |
| [`scripts/inspect-session.ts`](scripts/inspect-session.ts) | 把已存会话日志重放成对话树并打印（离线查看当前树） |
| [`scripts/bench-retrieval.mjs`](scripts/bench-retrieval.mjs) | 检索质量基准：合成 200 节点树，量 recall@k 与 token 成本（零模型调用） |
| [`scripts/bench-cache.mjs`](scripts/bench-cache.mjs) | 从真实会话日志里算每轮 token 与缓存命中率 |
| [`scripts/install.ps1`](scripts/install.ps1) | 安装到 profile：staged 拷贝 + 冒烟验证 + 失败回滚 |
| [`scripts/verify-boot.ps1`](scripts/verify-boot.ps1) | 四项启动冒烟：页面、客户端、树路由、宿主的 rpc 未被遮蔽 |
| [`cordis/token-tree.patch.yml`](cordis/token-tree.patch.yml) | 可直接 `--patch` 的挂载行 |
| [`docs/design.md`](docs/design.md) | 需求复述、数据结构、公式、检索伪代码、主循环伪代码 |
| [`docs/mounting.md`](docs/mounting.md) | 挂载与调试：patch、启动命令、验证、卸载、排错 |
| [`docs/acceptance.md`](docs/acceptance.md) | 验收标准与实测证据 |
| [`docs/ui-design.md`](docs/ui-design.md) | 块树 UI 设计：块、自动/手动分叉、数据契约、分阶段计划 |
| [`docs/experiment-context-cache.md`](docs/experiment-context-cache.md) | 三次实测：注入成本、缓存命中、工具优先模式的结论 |
| [`docs/ui-mockup.html`](docs/ui-mockup.html) | 可在浏览器直接打开的交互原型 |

## 快速开始

```powershell
# 依赖与构建（本机 registry 不可达时，scripts/build.mjs 会退回仓库内的 TypeScript）
pnpm install
pnpm run build

# 单元测试
pnpm test

# 端到端演示（不需要 DSH，也不需要模型）
node scripts/demo.ts
```

挂载到正在运行的 Harness（临时、可撤销）：

```powershell
# 用仓库里的示例 patch 临时挂载（会把 autoInject 打开，看完记得撤）
dsh --profile <你的 profile> --patch "<仓库路径>/cordis/token-tree.patch.yml" --no-open --port 19403
```

常驻挂载与桌面版说明见 [docs/mounting.md](docs/mounting.md)。

安装到桌面版（正式，一条命令；需先完全退出桌面版）：

```powershell
# 先构建并暂存出自包含的 plugin/ 目录，再安装（不要用 link:，桌面版会把根目录当工作区扫描）
node scripts/build.mjs; node scripts/stage.mjs
powershell -File scripts/install.ps1 -Profile desktop -DshPath '<dsh 可执行文件路径>'
# 重开桌面版 → 会话输入框上方出现「🌳 树」；点开即为嵌入式图形视图
```

`install.ps1` 会：暂存拷贝、装进 profile、校验包完整、用一个临时 profile 真启动一次、失败则回滚。
桌面版 profile 由 Electron 独占，**必须**通过桌面版自带的 `dsh.cmd` 安装，npx 的 CLI 会拒绝。

## 架构

```text
session/event ──▶ TokenTreeService ──▶ MemoryTree (nodes/edges/current)
                  │  user/message      → question 节点
                  │  assistant/message → answer 节点
                  │  tool/result       → tool_result 节点 + 边权 ± Δ
                  │
agent/pre-step ───┴─▶ retrieve_context ──▶ 注入「[token-tree memory] …」块（每回合首步一次）
agent/turn-stopping ─▶ evaluate ─▶ reflect 节点 ─▶ chooseBacktrack ─▶ 注入监督指令，同回合再走一步
```

工具面（模型可调用）：

| 工具 | 作用 |
|---|---|
| `retrieve_context` | 加权检索 + 预算贪心，可选注入下一步 |
| `tree_query` | 查看当前节点、子分支边权、到根累计成本、分支评分 |
| `tree_reflect` | 写反思/目标节点，可抬升当前分支成本 |
| `tree_backtrack` | 评分兄弟分支并回溯（支持 `dryRun`） |
| `tree_mark` | 用户置顶/忽略分支（可逆） |

人可用的 `/tree` 命令（不需要模型回合，结果直接渲染在会话界面里）：

```text
/tree          → 当前会话的加权对话树（沿 root→focus 主线，工具结果折叠成 +N tools 徽标）
/tree n118     → 以某个节点为焦点查看
```

预览可以直接在命令行看到：`node scripts/inspect-session.ts --command`。

## 核心公式

```
cost(p→c) = clamp( wSemantic·(1-cos(e_p, e_c))
                 + wTime·log1p(Δt/τ)
                 + wBranch·[父节点已有其它子节点]
                 + wUser·(ignored ? +1 : pinned ? -0.5 : 0), minCost, maxCost )

pathCost(a,b) = 最短路（上行车边权 = cost，下行车边权 = cost + descentPenalty）
pathWeight    = exp(-λ · pathCost)
score         = combine(relevance, pathWeight) × ancestorBoost × pinBoost
                combine = linear:  α·rel + (1-α)·pw
                          product: rel^α · pw^(1-α)
```

默认参数（`cordis.yml` 可逐项覆盖）：`λ=0.5`、`α=0.6`、`combine=linear`、`threshold=0.12`、`topK=12`、`tokenBudget=2000`、`failureDelta=0.75`、`successDelta=0.25`、`descentPenalty=0.35`。完整表在 [docs/design.md](docs/design.md) 第 3 节。

## 配置

`Config` 以 Standard Schema（`~standard.validate`）导出，loader 在 `apply` 前校验；未知键或类型错误在加载期直接报错。所有字段可选：

```yaml
config:
  autoInject: false         # 默认不每回合自动注入（见下面的实测结论）
  retrievalHint: true       # 改为每回合一行提示，告诉模型何时该调 retrieve_context（约 57 token）
  autoReflect: true         # 回合结束时评估/反思/回溯
  includeSubagents: false   # 是否也给子 Agent 建树
  injectBudgetTokens: 600   # 自动注入块预算
  maxNodesPerSession: 400   # 单会话节点上限，超出后裁剪最冷分支
  logEdgeUpdates: true      # 边权变化写 info 日志
  attachments: semantic     # 新问题挂回"引入该名词的回答"；linear 则永远接在最后一条后面
  attachThreshold: 0.18     # 语义挂载所需的最低相似度（0.6·余弦 + 0.4·去停用词的词面重合）
  attachMargin: 0.08        # 还必须比"接在最后一条"高出这么多才改挂
  embeddingDimension: 256
  weights: { lambda: 0.5, alpha: 0.6, combine: linear, tokenBudget: 2000 }
  loop:    { maxSteps: 12, maxReflections: 4, maxBacktracks: 3, timeoutMs: 120000 }
```

**树为什么会分叉**：`attachments: semantic` 时，新问题会先和所有历史 `answer` 比相似度；只有明显高于"接在最后一条回答后面"（多出 `attachMargin`，且过 `attachThreshold`）才改挂到那条更早的回答下。于是"对上一段解释里的名词继续追问"会落在同一答案下成为兄弟分支，而"每轮换个话题的实现请求"如实保持一条链。

## 设置（运行时可改，不用重启）

`Config` 是加载时固定下来的，改一个开关要改 YAML 再重启 —— 对"看着树的时候想关掉注入"这类操作太重。所以有四个开关额外放在设置里：

| 开关 | 默认 | 作用 |
|---|---|---|
| `autoInject` | `false` | 每回合把检索结果作为一块推到上下文（约 428 tok/轮） |
| `retrievalHint` | `true` | 只加一行提示，让模型自己决定是否 `retrieve_context`（约 57 tok/轮） |
| `hintAboveTokens` | `12000` | **按实测 token 计数**的提示门槛（对话路径上的节点 token 之和）；达到才发提示 |
| `hintMinNodes` | `40` | 没有 tokenizer 时的回退门槛（节点数）；被压缩过的会话不受两者限制 |
| `autoReflect` | `true` | 回合结束时评估失败、写反思、回溯更优兄弟分支 |
| `admitRelevance` | `0.3` | 原始相关度（余弦）准入线：只决定谁有资格进入排序，空手时自动放宽一次 |
| `summaryMatch` | `true` | 匹配时可使用节点的首句摘要（返回的仍是原文） |
| `tokenizerVersion` | `auto` | 选哪一代 tokenizer：`auto` / `4` / `deepseek-r1`（=v3）/ `off` |

长节点（> 40 token）写入时会自动生成**首句摘要**并单独存一份嵌入；检索取"原文 / 摘要"里更高的相似度，
返回的仍是原文。这让"首句是主题、后面全是噪声"的工具输出能被命中（实测 recall 1/6 → 6/6，排名 3 → 1）。

- 界面入口：顶部「树」→「设置」页签；
- 存储：`~/.dsh/token-tree/settings.json`（`DSH_HOME` 决定根目录），只存被覆盖的键；
- 优先级：**设置文件 > profile 的 `config`**；点「恢复默认」会把该键从文件里删掉，回到配置值；
- 接口：`GET /api/token-tree/settings` 返回
  `{ base, overrides, effective, path, tokenizer:{path,state,version,available}, ratio, drift, lastHint }`，
  `POST` 传 `{ key: value }`，`null` 表示清除覆盖；
- 写入失败（只读 home）只记日志，本次运行仍然生效。

### 官方 tokenizer（按版本自动选）

`tokenizer.json` 与模型代次绑定，所以配置的是**版本**而不是路径：插件在 `tokenizerDir`（默认
`~/.dsh/token-tree`）下找 `deepseek_v<N>_tokenizer/tokenizer.json`。

```text
token-tree/
  deepseek_v3_tokenizer/tokenizer.json   # 世代形态：deepseek_v<N>_tokenizer
  deepseek_v4_tokenizer/tokenizer.json
  qwen2.5/tokenizer.json                 # 任意其他模型：目录名 = 模型名
  tokenizer.json                         # 或者放一个"默认"
```

**DSH 不只跑 DeepSeek**，所以不可能内置所有 tokenizer。规则是：

1. `modelId`（可选配置）先按**目录名**匹配（归一化后比较，`qwen2.5` ≈ `qwen-2.5`）；
2. 再从 `modelId` / `tokenizerVersion` 里解析世代（`v4`、`4`、`r1`→v3）并按世代匹配；
3. 都没有就 `auto` 取最新世代，或退回第一个可用项；
4. **一个都没有**时：用插件自己的估算 + 在线学习的字符比例，并由 `drift` 告警兜底。

每次选择都会在日志与 `settings.tokenizer.reason` 里说明是"精确匹配"还是"回退到了哪个"。

- 节点在**创建时**就用 tokenizer 计数（`node.tokens` 从写入那一刻就是实测值），
  加载 tokenizer 时还会把已有节点整体重算一次；
**预算会打折**：计数是估算时，`tokenBudget` 只按 `conservativeBudgetRatio`（默认 0.85）使用；
漂移监测不满意时再打 0.9 折。理由是"多注入一点"远好过"超了硬上限"。有 tokenizer 时因子为 1。
`settings.budget.factor` 可见当前折扣。
**没有 tokenizer 的模型（含所有闭源模型）**：插件用**账单反推比例** ——
`billed ≈ a·宽字符 + b·窄字符 + 固定开销`，三个系数用在线最小二乘从 provider 的 `usage` 拟合，
`settings.billing` 会显示 `{wide, narrow, overhead, observations, active}`。

一个实测出来的限制：**如果每轮的内容构成太相似，两个字符类无法被辨识**（回归会把权重全压到其中一类，
例如算出"narrow = 86 token/字符"）。所以只有在**相关性检查通过**（两类序列相关系数 < 0.95）且样本 ≥ 3 时才启用，
否则退回先验 0.6 / 0.2 —— 宁可保守，也不要一个"完美拟合但毫无意义"的系数。
- 另有 `ratio`（在线学习的宽/窄字符比例，只用于快速预筛）与 `drift`（账单增量 vs 计数增量，
  偏离 [0.85,1.2] 三次连续样本即告警"tokenizer 可能过期"）。


## 界面（三处入口，同一份数据）

| 入口 | 位置 | 用途 |
|---|---|---|
| 嵌入式 dock | 输入框**正上方**，对话区内部 | 默认展开图形视图：左侧画布 + 右侧操作栏；展开时左右各留 14px，不遮挡对话 |
| 头部「树」 | 会话标题栏 | 浮窗快速预览（沿 root→focus 主线） |
| 头部「图」 | 会话标题栏 | 全屏编辑器：对话块 / 完整树 / 图形三种视图 |

dock 与编辑器共享同一套 `/api/token-tree/*` 路由，任何一侧的修改另一侧立刻可见：

- **移动分支**：选中 → 「移动此分支」→ 点目标节点（两段式，避免与画布拖拽冲突）→ 可「撤销移动」；
- **隐藏分支**：确认后标记为隐藏，**不删数据**，随后可「撤销删除 <id>」恢复；隐藏状态写进编辑日志，重启后仍然隐藏；
- **置顶 / 忽略 / 从这里继续**：锚定只影响下一轮，用户回到输入框发出的那条问题会挂到锚定节点下；
- 图形节点默认**紧凑**（单行：编号 + 问题，宽度自适应截断），回答正文在右栏；可切「详细」看两行卡片；
- 点击节点会按 `data-chat-turn` **定位到对话里那一轮**（文本匹配只作兜底，且会跳过本插件自己的 `/tree` 输出）。

手工编辑持久化在 `~/.dsh/token-tree/edits.jsonl`（JSONL，一行一个操作，坏行跳过）。

## 实测结论（成本）

三次 A/B 都在 `deepseek-flash` 上跑，详见 [docs/experiment-context-cache.md](docs/experiment-context-cache.md)：

| 实验 | 注入 | 缓存命中 | 结论 |
|---|---|---|---|
| 1（8 轮，autoInject） | +149% 输入 | 91.78% → 91.69% | 树在小上下文里是**纯成本** |
| 2（19 轮，14 事实 + 5 回忆） | 7,700（428/轮） | 97.62% → 96.51%（−1.11pt） | 两边都 5/5，插件新增 input 4,265 → **9,166（+115%）** |
| 3（工具优先，默认配置） | **428 → 57 token/轮** | **98.14%（+0.45pt）** | 召回 5/5、新增 input 3,926（−5.6%），成本最低 |
| 4（`/compact` 后召回，30 事实） | 压缩 82 项 / 2,133 tok | — | 基线 **10/10**，摘要没丢事实，树无增益 |

检索本身的质量用零成本的 `node scripts/bench-retrieval.mjs` 量：200 节点合成树里 **recall@12 = 20/20（100%）**，每次 217 token；同一批事实若靠"全量历史"保住要 4,182 token（**省 95%**）。线性"只留最近"基线则是 0/20。

**诚实的边界**：在 19–25k 上下文规模下，树带来的是成本而非召回收益；收益要在历史**超出上下文预算**后才出现，而这条路径还没能在本机端到端验证（见下）。

## 适用场景

四轮实验的结论可以压成一句话：**树属于"长会话 + 细节找回 + 人工导航"的工具，不属于"短对话省钱"的工具。**

| 场景 | 值得用 | 理由 |
|---|---|---|
| 几十轮以上的长期项目，事实/决策散落各处 | ✅ | 树逐字保留节点，压缩摘要丢掉细节时它是唯一的原文来源 |
| 需要**分支对比**（"如果换个做法呢"） | ✅ | 分叉、改挂、隐藏、从这里继续，这是纯 UI 价值，与检索无关 |
| 频繁回头定位某轮对话 | ✅ | 图 + 轮次跳转（走宿主 TurnNavigator，可跨页）比滚动找快得多 |
| 10–20 轮的日常问答、写代码 | ❌ | 实测召回差异为 0，只多付注入/延迟 |
| 事实可以用工具重读（读文件、grep） | ❌ | 一次工具读取通常比检索更准，也更便宜 |
| 对延迟敏感 | ❌ | 工具优先模式会多一个 step（约 +0.5～1s） |

默认配置已经照顾了这些边界：

- `autoInject: false` —— 不做每回合的整块注入；
- `retrievalHint` 只在**会话被压缩过**或**实测对话 token ≥ 12,000** 时才发一行（约 57 token），短对话零额外成本；
- 想彻底安静：`retrievalHint: false`；想让召回强制走通：`autoInject: true`。

## 如何验证（不需要模型）

| 命令 | 作用 |
|---|---|
| `pnpm test`（或 `node --test`） | 96 个单元测试 |
| `node scripts/bench-retrieval.mjs` | 检索召回 vs token 成本（`--sweep` 阈值扫描、`--cosine` 余弦分布、`--admit-sweep` 准入扫描） |
| `node scripts/bench-summary.mjs` | 摘要匹配、空手回退 |
| `node scripts/tokenizer-check.mjs` | 分词器健全性（未知 piece、字符/token 比例） |
| `node scripts/tokenizer-perf.mjs` | 分词速度（决定要不要做预筛） |
| `node scripts/token-accuracy.mjs` | 三种估算器 vs 账单口径 |
| `node scripts/simulate-conversation.mjs` | 一场模拟对话的逐轮数字与门槛触发点 |
| `node scripts/inspect-compaction.mjs` | 从会话日志里统计压缩事件 |

客户端（`client/client.js`）现在也有自动化测试：`tests/client.test.ts` 用 jsdom + 真实 React
把浏览器半边挂起来（供应 `window.__ModuleLoader__`、`require`、`fetch` 桩），断言图/列表渲染、
设置页的 tokenizer 下拉、分支对比的列数与「从这里继续」发起的 `focus` 请求。
devDependencies 里的 `react`、`react-dom`、`jsdom` 只用于这组测试，不进发布包。

需要模型在环的实验脚本：`ab-final.mjs`（最终配置 A/C）、`ab-retrieval.mjs`（检索模式对比）、
`ab-rigorous.mjs`（工具优先 vs 基线）、`ab-compact.mjs`（压缩后召回）。

## 已知未完成

| 事项 | 状态 |
|---|---|
| 压缩后的召回增益 | **已结案（实验 10）**：压缩后追问 4 个精确串，基线 8/8、插件 8/8，提示发了 13 次但模型 0 次调用检索 → 天花板效应，收益无法证明；默认配置因此保持不注入 |
| 跳到很早的对话 | 已改为点击宿主轮次导航条（会按需加载历史页），不受虚拟化限制 |
| 删除 | 已改为可撤销的软删除（隐藏 + 恢复） |

## 后续可以完善的地方（按性价比）

1. **让节点预算也用实测 token 做增量更新** —— 现在是"加载 tokenizer 时一次性重算"，之后新节点仍用估算写入，
   直到下次重算。改成写入时就用 tokenizer（已有实例，成本是一次 O(文本长度) 计数）。
2. **漂移告警触发自动切换** —— 目前只告警；可以在检测到持续偏离时自动尝试另一代 tokenizer 并比较吻合度。
3. **检索收益的终极验证** —— 需要"历史确实装不下"的场景：可以把压缩摘要人为截断（或在测试 profile 里把
   `retainRatio` 调小），造出"摘要丢细节"的对照，再看树能否补回来。这是唯一还没证明的核心价值。
4. **分支对比 UI** —— 两个分支并排看 + 一键"让另一个分支回答同一问题"，这是当前环境里确定有价值的 UI 能力。
5. **设置项补齐** —— `tokenizerVersion`、`hintAboveTokens` 目前只在配置里；设置面板还没有它们的输入框。
6. **测试** —— 客户端（client.js）没有任何自动化测试，只有手测；可以考虑用 jsdom 覆盖渲染与交互。


## 设计取舍（要点）

- **不追加自定义会话事件**：仓外的未知事件类型会让持久化读取拒绝整条日志。树完全由 `user/message`、`assistant/message`、`tool/result` 重放得到，模型可见的注入块本身也会被 loop 记成 `user/message`。
- **不替换 `agentLoop`**：用 `agent/pre-step`（注入）、`tools/*`/`session/event`（观察）、`agent/turn-stopping`（继续一步）实现「评估—反思—回溯」，属于官方扩展点。
- **编译期零依赖**：`src/plugin/dsh.ts` 以结构化类型描述所用到的 Harness 结构，避免在无法 `pnpm add @deepseek-ai/*` 的机器上加载失败。

## 验收状态

| 验收项 | 状态 | 证据 |
|---|---|---|
| 构建对话树并计算任意两节点路径成本 | ✅ | `tests/graph.test.ts`，`scripts/demo.ts` 第 1–2 节 |
| 按权重+预算选上下文，无关远距离节点被过滤 | ✅ | `tests/retrieve.test.ts`，demo 第 3 节 |
| 工具失败后边权增加、反思节点写入、回溯兄弟分支 | ✅ | `tests/plugin.test.ts`，`tests/reflect.test.ts`，demo 第 4–6 节 |
| 插件可通过 patch 加载 | ✅ | 真实加载器导入 + `Config` 校验（见 [docs/acceptance.md](docs/acceptance.md)） |
| 工具可被模型调用、日志可见边权更新 | ✅ 注册与日志已实测；模型调用在挂载后的下一回合生效 | 工具注册于 `ctx.tools`，边权变化走 `logger.info`，见 [docs/acceptance.md](docs/acceptance.md) |

## 卸载

删除 `~/.dsh/cordis.patch.yml` 中的 `token-tree` 行（或整个文件），Harness 会热重载移除插件；也可在 profile 的 `cordis.patch.yml` 里加 `- id: token-tree \n  disabled: true`。
