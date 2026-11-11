# 检索压力测试：retrieval-heavy-v1

这是一套**强制折叠、强制检索**的 36 轮对话。前 13 轮埋入精确事实，中间 10 轮完全无关，后面再更新事实，最后 7 轮集中追问。

数据：[retrieval-heavy.json](retrieval-heavy.json)

## 为什么需要检索

- 第 2–13 轮埋事实
- 第 14–23 轮聊早餐，把距离拉开
- 第 24–29 轮做三次更新
- 第 30–36 轮提问

运行时把折叠设成：

```yaml
- id: token-tree
  config:
    attachChoices: 10
    candidateSource: retrieve
    autoInject: false
    retrievalHint: true
    autoFold: false
    foldPolicy: always
    foldKeepTurns: 1
    foldScope: turns
    foldCadence: 0
```

`candidateSource: retrieve` 把挂树候选和检索索引合并成同一张表：三臂都拿到同一份加权检索结果（id、kind、权重、token、问题/摘要），local 只用它检索，marker/tool 还可以把它当落点候选。这样“候选表”不再是 marker/tool 独有的检索捷径。

`foldPolicy: always` + `foldKeepTurns: 1` 会尽快把早期事实折掉。到第 30 轮时，模型不能再靠可见 prompt 答，必须调用 `retrieve_context`。

## 埋入的事实

| 轮 | 事实 |
|---:|---|
| 2 | 代号青禾；主 `ap-east-1`，备 `ap-south-1` |
| 3 | 缓存 TTL 37 分钟；重试 4 次；端口 7419 |
| 4 | SLA 99.95%；p95 240ms |
| 5 | 发布 2026-03-14；负责人林岚 |
| 6 | 保留 45 天；核心表 `ledger_events`；归档表 `ledger_archive` |
| 7 | 北辰要求 `ap-east-1`；南屿接受 `ap-south-1` 备份 |
| 8 | 2/18 事故根因时钟偏移 4.5 秒，排除网络分区 |
| 9 | 合同 7.3：跨境备份加密；密钥 90 天轮换 |
| 10 | 发布前三天关闭 `fold_v3` |
| 11 | HNSW recall 0.94；IVF 0.88，选 HNSW |
| 12 | 预算 1200，已花 860 |
| 13 | v2 端口 7419 废弃；v3 改 7421 |
| 25 | staging 和 production 都用 7421 |
| 26 | 新增监控 `fold_latency_p95` |
| 27 | 保留期 45 → 30 天 |
| 28 | 北辰后来也同意 `ap-south-1` 备份 |
| 29 | SLA/p95 没变 |

## 问题与答案键

| 轮 | 问题 | 必含事实 | 来源轮 |
|---:|---|---|---|
| 30 | 当前缓存 TTL、重试预算、端口 | 37 分钟 / 4 次 / 7421 | 3, 13, 25 |
| 31 | 2/18 事故根因与排除项 | 时钟偏移 / 4.5 秒 | 8 |
| 32 | 北辰和南屿当前驻留要求 | 北辰 / ap-east-1 / ap-south-1 / 南屿 | 7, 28 |
| 33 | HNSW/IVF recall、选型理由、预算余额 | 0.94 / 0.88 / 340 | 11, 12 |
| 34 | 密钥轮换、当前保留期、SLA/p95 | 90 天 / 30 天 / 99.95% / 240ms | 9, 27, 4 |
| 35 | v2 端口、当前端口、fold_v3、指标 | 7419 / 7421 / 关闭 / fold_latency_p95 | 13, 10, 26 |
| 36 | 三次变更的时间顺序 | 端口 → 保留期 → 北辰备份 | 13, 27, 28 |

共 23 个必含事实点。

## 评分

### 准确率

- 每个必含事实 1 分，共 23 分
- 当前值写错，扣该点：
  - 端口写 7419 而不是 7421
  - 保留期写 45 而不是 30
  - 预算剩 1200 而不是 340
  - `fold_v3` 写成开启
- 第 36 轮顺序错（例如先写北辰再写端口）扣 1 分
- 允许解释性文字；“不是网络分区”不算错

```text
accuracy = 得分 / 23
```

### 检索命中

对第 30–36 轮，检查 `retrieve_context` 的结果里是否出现来源轮：

```text
source_hit = 命中来源轮的 check 数 / 7
```

目标：

- `accuracy >= 0.90`
- `source_hit >= 6/7`

只答对但没检索到来源轮，说明模型靠猜/残留上下文；只检索到但答错，说明检索结果没被正确使用。

## 运行

用 `tokentree` 的 headless 副本 `ab-tokentree`，不要在 `desktop` 跑。`tokentree` 本身是 **web** profile，不接受 `--json`，所以不能用来跑 CLI 批量对话：

```powershell
# 必须在同一个 PowerShell 窗口里设置；脚本只从环境变量读，不接收明文 key 参数
$env:DEEPSEEK_API_KEY = '<your-key>'
.\scripts\experiment-retrieval-heavy.ps1
```

脚本会读取 JSON 里的 `setup.patch`，默认跑 **3 个 arm**：

```text
local  · 本地启发式挂载
marker · 输出末尾 [attach:...] 标记
tool   · 调用 tree_attach 工具
```

每个 arm 使用独立 session，跑完全相同的 36 轮；逐轮调用 `dsh --profile ab-tokentree --permission-mode read-only --json`。三个 arm 共用同一个 profile，脚本在每个 arm 的基础 patch **同一个 `config` 块里**加入 `attachMode` 和 `attachChoices`，在 **mount 时**固定模式：

- `local`：不注册 `tree_attach`，`attachChoices=10` + `candidateSource=retrieve`；模型不参与挂树，但能用同一张检索表按 nodeId 直取。
- `marker`：不注册 `tree_attach`，`attachChoices=10` + `candidateSource=retrieve`；模型在结尾写 summary 和 `[attach:目标]`。
- `tool`：注册 `tree_attach`，`attachChoices=10` + `candidateSource=retrieve`；模型通过工具挂树。

不能另写第二个 `- id: token-tree` patch：同 id 的 `config` 是整体替换，不是深合并，会把 fold/retrieve 设置全部冲掉。也不能在 `settings.json` 里切换 `attachMode`：工具是否注册看的是 mount 时的 `config.attachMode`，会话级覆盖只改提示，不会撤掉已经注册的 `tree_attach`。

折叠不是按阈值块工作的：数据里的 `setup.patch` 明确写了 `foldPolicy: always`，除 `foldKeepTurns` 外每轮结束都折，`foldAboveTokens` / `foldBlockRatio` 不参与。这是为了让早期事实不可见、强制模型检索；如果要测阈值块，得把 `foldPolicy` 改成 `threshold` 并重新调阈值。

脚本还会：

- 建一个临时 `DSH_HOME`，把 profile 目录 junction 进去；插件的 `settings.json` 和 session 日志都落在临时目录，真实 `~/.dsh/token-tree/settings.json` 不会再覆盖测试 patch。
- `ab-tokentree` 的 credentials 服务是关闭的，key 直接走启动环境 `$env:DEEPSEEK_API_KEY`；脚本也会把 key 种进临时 `.credentials.yaml`，方便以后换到启用了 credentials 服务的 profile。
- 在临时设置里把 `read` / `write` / `edit` / `glob` / `grep` / `pwsh` 全部 `toolDeny`，模型只能走 `retrieve_context`；tool 模式额外有 `tree_attach`。
- 每个 arm 用一个固定的空 cwd；DSH 的 Session 绑定创建时的 cwd，逐轮换目录会被宿主拒绝。文件隔离靠 `toolDeny`，不靠换 cwd。
- 临时目录里的 junction 用 `rmdir` 删除，不用 `Remove-Item -Recurse`，避免误删真实 profile。

只想跑一个 arm：

```powershell
.\scripts\experiment-retrieval-heavy.ps1 -AttachModes marker
```

跑其中两个（逗号分开；`[string[]]` 参数直接传数组也可以）：

```powershell
.\scripts\experiment-retrieval-heavy.ps1 -AttachModes local,marker
```

`summary.json` 每行包含：

```text
arm, sessionId, score/total, accuracy,
retrieveCalls, retrieveQueries, retrieveNodeIds,
attachCalls, markerAttachCalls, summaryMarkers, steps,
inputTokens, cacheReadTokens, outputTokens, missing
```

判断：

- `local`：`attachCalls=0`、`markerAttachCalls=0`，主要看检索 + 自动落点
- `marker`：`attachCalls=0`，但 `markerAttachCalls>0`，回答末尾应有 `[attach:...]`
- `tool`：`attachCalls>0`，落点由 `tree_attach` 完成
- 三个 arm 的 `accuracy` 应接近；如果 marker/tool 明显更低，说明额外挂载步骤干扰了回答

`candidateSource: retrieve` 下三臂看的是同一张检索表；如果某个 arm 的 `accuracy` 更低，优先看它的 `retrieveQueries/retrieveNodeIds` 是否明显更少，而不是归因于“候选表只帮了另外两个”。

## 结果：合并候选表后两轮（2026-11-11）

两轮都用同一份数据、同一个 `candidateSource: retrieve`，local 单独跑一轮，marker/tool 跑一轮：

| 轮次 | arm | 正确 | retrieve | query | nodeId | steps | input | cacheRead | output | 总成本* |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | local | 22/23 | 47 | 21 | 26 | 67 | 107,922 | 715,648 | 32,789 | 155,024 |
| A | marker | 23/23 | 47 | 21 | 26 | 71 | 95,455 | 724,480 | 22,817 | 132,762 |
| A | tool | 23/23 | 49 | 19 | 30 | 109 | 145,537 | 1,260,672 | 36,149 | 206,899 |
| B | local | 22/23 | 53 | 25 | 28 | 77 | 135,149 | 843,264 | 34,356 | 186,370 |
| B | marker | 23/23 | 43 | 21 | 22 | 63 | 94,328 | 584,704 | 24,404 | 130,426 |
| B | tool | 22/23 | 39 | 16 | 23 | 92 | 150,259 | 1,015,552 | 38,599 | 209,169 |

\* 相对成本：`input + 0.02 × cacheRead + 1 × output`，cacheWrite 两轮都是 0；output 按 1 计。不是美元账单，只用于同一套价格下的横向比较。

两轮平均：

| arm | 正确 | 平均 retrieve | 平均 steps | 平均总成本 |
|---|---:|---:|---:|---:|
| local | 44/46 | 50 | 72 | 170,697 |
| **marker** | **46/46** | **45** | **67** | **131,594** |
| tool | 45/46 | 44 | 100 | 208,034 |

结论：

- **合并候选表起作用了**：retrieve 从之前的 70/87/53 收敛到 47/47/49（A）和 53/43/39（B），三臂不再因为“谁有候选表”而产生巨大偏差。
- **marker 两轮全对且最便宜**：平均比 local 低 23%，比 tool 低 37%；平均 steps 也最少。
- **tool 没有稳定收益**：两轮 23/23、22/23，但 33–36 次工具 attach 把平均 steps 拉到 100，成本最高。
- **local 稳定 22/23，但错题不固定**：A 轮漏 T34 的“30 天”，B 轮漏 T30 的“7421”；都是更新类事实，query 被旧值锚定，检索到旧节点。
- **marker 的优势不是“少检索”**：A 轮 retrieve 与 local 完全相同（47），B 轮还比 local 少 10 次；它赢在 query 写法和直接按 id 取到正确节点。

这轮之后，默认 `attachMode` 改为 `marker`；settings 面板暴露 marker/local，tool 仍作为实验配置。

## 理论：同一对话不加插件

这里不是实测 baseline，而是按同一 36 轮对话做的代价模型：

- system + tool schemas：10,453 token（沿用 `default-vs-baseline` 的假设）
- 不加插件：全部历史可见，每轮一次模型请求，不调用 `retrieve_context`，不做折叠
- marker：用两轮实测的 `input/cacheRead/output`
- tokenizer：DeepSeek v4；每条消息 +4 token 开销
- 价格：命中 0.02/M、未命中 1/M、输出 **4/M**；只用于同价横向比较
- 不加插件的输出只算回答正文（marker 的 output 含检索工具/推理，按实际计），所以这里对不加插件更有利

| 轮次 | 方案 | prompt tokens | hit | miss | output | prompt 成本 | 总成本 | 相对 marker |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| A | no plugin | 519,767 | 501,506 | 18,261 | 7,486 | 28,291 | **58,235** | 0.29× |
| A | marker | 819,935 | 724,480 | 95,455 | 22,817 | 109,945 | 201,213 | 1× |
| B | no plugin | 540,919 | 520,906 | 20,013 | 9,358 | 30,431 | **67,863** | 0.33× |
| B | marker | 679,032 | 584,704 | 94,328 | 24,404 | 106,022 | 203,638 | 1× |

结论：

- 在这个 **36 轮、短消息、无工具输出** 的负载里，不加插件理论上比 marker 便宜 **3.0–3.5 倍**（按总成本）。
- marker 贵在两处：检索工具多出来的步骤，以及折叠/注入造成的 prefix cache 失效（miss 从 ~19k 涨到 ~95k）。
- 所以这套实验不能用来证明“插件省成本”；它证明的是“插件在强制折叠后仍能答对”。要证明省成本，需要长会话、大工具输出，让折叠省下的前缀超过检索/失效开销。

### 追平轮数

按当前平均每轮新增 token（A：`u=18.7, a=207.9`；B：`u=18.7, a=259.9`）和 marker 的实测每轮成本线性外推：

| 轮次 | 每轮新增 | marker 每轮成本 | 追平轮数 |
|---|---:|---:|---:|
| A | 226.6 | 5,589 | ≈1,900 |
| B | 278.6 | 5,657 | ≈1,500 |

不加插件的累积成本是二次的，marker 近似线性，所以理论上更长的对话最终会让插件更便宜。但这个结论有个硬边界：到 128k 上下文时，不加插件的轮数只有约 **420–520 轮**，还没到追平点。也就是说，在这套短消息数据上，插件在上下文窗口内追不平；只有消息更长、工具输出更大时，追平点才会提前。

## 对照（可选）

想证明“是检索在起作用”，再跑一组 baseline：

```yaml
- id: token-tree
  config:
    attachChoices: 0
    autoInject: false
    retrievalHint: false
    autoFold: false
    foldPolicy: always
    foldKeepTurns: 1
    foldScope: turns
    foldCadence: 0
```

还要在插件设置里把 `retrieve_context` 加进隐藏工具（`toolDeny`）。`toolDeny` 是运行时设置，不是 profile config，不能写在上面这段 patch 里；headless 没有 UI 时通过 settings API 设置。

baseline 看不到早期事实，也不能调 `retrieve_context`，准确率应明显低于检索组。两组用同一套 36 轮对话。

## 注意

- 这套数据故意让早期事实全部折叠；不折叠时它测的是长上下文，不是检索。
- **必须在空目录跑**：如果模型能 `grep`/`read` 到本仓库里的 `retrieval-heavy.json` 或本文，它会直接读到答案键，测出来是文件查找而不是检索。脚本把每个 arm 切到一个固定的空 cwd（DSH 的 Session 绑定创建 cwd，不能逐轮换），并用 `toolDeny` 禁止 `read`/`grep`/`pwsh`。
- 第 1 轮明确写了“只在对话里记录，不要创建、修改或读取任何文件”。早期版本没写这一句，模型会自己建 `qinghe/config.md`，后面直接读文件答题，结果作废。
- 评分忽略空白差异：`240ms` 和 `240 ms`、`90天` 和 `90 天` 视为同一个事实。
- 第 32、34、36 轮有多跳/更新，必须读来源轮，不能只读最近一轮。
- 第 30、35 轮有“旧值”干扰（7419、45 天），用来测是否会把废弃值当当前值。
- 只跑一次不够；建议至少 3 次，报告均值与方差。
