# 挂载与调试

本机环境（下文命令都以此为基准）：

- 桌面版：`C:\Users\ASUS\AppData\Local\Programs\DeepSeek Harness`
- CLI：`C:\Users\ASUS\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
- DSH 主目录：`C:\Users\ASUS\.dsh`（可用 `DSH_HOME` 覆盖）
- 插件产物：`D:\dsh-token-tree\dist\index.js`（ESM，零外部 import）

## 0. 构建

```powershell
cd D:\dsh-token-tree
pnpm install            # 有 registry 时
pnpm run build          # 或：node scripts/build.mjs
```

`scripts/build.mjs` 会优先用项目自己的 `typescript`，否则退回 `harness/node_modules/typescript`（本机 registry 不可达时仍可构建）。

## 1. 挂载方式

### 方式 A：`--patch` 覆盖层（最轻，适合验证）

[`cordis/token-tree.patch.yml`](../cordis/token-tree.patch.yml) 里是一个 `insert` 行，`name` 用相对路径（相对 patch 文件），loader 会转成 `file://` URL：

```yaml
- insert:
    - id: token-tree
      name: ../dist/index.js
      config:
        autoInject: true
        autoReflect: true
        logEdgeUpdates: true
```

```powershell
$dsh = "C:\Users\ASUS\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 看合成后的插件树（不启动）
& $dsh --profile demo --from-default-profile web --dump-config `
       --patch 'D:\dsh-token-tree\cordis\token-tree.patch.yml'

# 真的启动
& $dsh --profile demo --patch 'D:\dsh-token-tree\cordis\token-tree.patch.yml' --no-open --port 19403
```

> `--from-default-profile` 只在 profile 首次创建时使用；profile 已存在时再加会报 `already exists`。

### 方式 B：home 层常驻（本机采用，支持热加载）

`C:\Users\ASUS\.dsh\cordis.patch.yml` 是"主目录补丁层"，优先级高于 profile 层，且 **Desktop 从不改写它**。写入后 `dsh-hmr` 会重载配置，正在运行的会话直接拿到新工具，无需重启。

```powershell
# 内容（绝对路径形式，因为不再相对某个 patch 文件）
# - insert:
#     - id: token-tree
#       name: file:///D:/dsh-token-tree/dist/index.js
#       config: { autoInject: false, autoReflect: false, logEdgeUpdates: true }
```

本机当前就是用这个文件挂载的（`autoInject`/`autoReflect` 关闭，只提供工具，不打扰会话）。
删除该文件即可整体卸载。

### 方式 C：profile 层

```yaml
# C:\Users\ASUS\.dsh\profiles\desktop\cordis.patch.yml 末尾追加
- insert:
    - id: token-tree
      name: file:///D:/dsh-token-tree/dist/index.js
```

profile 的 `cordis.patch.yml` 只在缺失时由 Harness 创建，已存在则不会重写，所以手写行会保留。

### 方式 D：作为 bundle 安装（推荐给桌面版，需要先完全退出桌面版）

本包在 `package.json` 里声明了 `dsh.bundle.patch`，因此 `dsh plugin add` 一步就完成
「写入依赖 → 把包名追加进 `dsh.profile.bundles`」两件事，不需要再手写 `insert` 行。

> **不要直接 `link:` 仓库根目录。** profile 会把 `link:` 的目标当作 linked root 扫描；
> 而仓库根目录里还有 `harness/`（源码仓库、自带 pnpm workspace，且未构建）。
> 一旦这样装，整个应用会改从源码树加载 `@deepseek-ai/*`，导致
> `typert-loader: … ERR_MODULE_NOT_FOUND`、`3 required plugins did not activate`，
> 桌面版直接起不来（欢迎页卡在 "Web request failed"），而且删 bundle、重装都无效——
> 因为 linkage 还在 `node_modules` 里。

```powershell
# 0) 先删掉方式 B 的临时行，避免同一个 id 出现两次
Remove-Item 'C:\Users\ASUS\.dsh\cordis.patch.yml' -Force -ErrorAction SilentlyContinue

# 1) 打一个只含构建产物、不含 harness 的 staging 目录（会先构建）
cd D:\dsh-token-tree
node scripts/stage.mjs        # 产出 D:\dsh-token-tree\plugin

# 2) 完全退出 DeepSeek Harness（托盘 → 退出），确认进程已消失
Get-Process | Where-Object { $_.ProcessName -like '*DeepSeek*' }

# 3) 用 file:（拷进 profile）而不是 link:
$dsh = 'C:\Users\ASUS\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add 'file:D:\dsh-token-tree\plugin'
& $dsh plugin --profile desktop list

# 4) 重新打开桌面版
```

`file:` 安装是**拷贝**：profile 里不会再出现指向本仓库的链接，扫描自然进不去源码树。
改代码后重新 `node scripts/stage.mjs` 并重复第 3 步即可刷新。

**装之前先自证安全**（不需要碰你的正式 profile）：脚本会建临时 DSH home、装 staged 包、
真起一次 web 服务，检查首页 / 客户端半包 / tree RPC，然后清理。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-boot.ps1
# 期望：page served PASS / client half wired PASS / tree rpc answers PASS / RESULT PASS
```

因为 `link:` 是指向源码目录的联接，**改代码后只需 `node scripts/build.mjs` 并重启桌面版**，不必重装。
桌面版运行期间 `dsh plugin` 会被拒（profile 由 Electron 独占管理），所以第 1 步必须先退出。

## 2. 验证步骤（本机实测）

### ① 产物可独立导入，导出的就是插件契约

```powershell
node -e "import('file:///D:/dsh-token-tree/dist/index.js').then(m => console.log(Object.keys(m).sort().join(', '), m.name, JSON.stringify(m.inject)))"
# → Config, TokenTreeService, apply, inject, name   dsh-bonsai   ["tools"]
```

### ② patch 行被正确合成

```powershell
& $dsh --profile demo --dump-config --patch 'D:\dsh-token-tree\cordis\token-tree.patch.yml'
```

实测输出末尾：

```yaml
# == D:\dsh-token-tree\cordis\token-tree.patch.yml
- id: token-tree
  name: file:///D:/dsh-token-tree/dist/index.js
  config:
    autoInject: true
    autoReflect: true
    ...
```

### ③ 加载器确实导入模块并执行 `Config` 校验

用一份故意写坏的配置启动（[`cordis/token-tree.invalid.yml`](../cordis/token-tree.invalid.yml)）：

```powershell
& $dsh --profile demo --patch 'D:\dsh-token-tree\cordis\token-tree.invalid.yml' --no-open --port 19402
```

实测 stderr：

```text
dsh: warning: 1 entry did not activate
token-tree (file:///D:/dsh-token-tree/dist/index.js): ValidationError: invalid config:
  - must be a finite number (at weights.lambda)
    at resolveConfig (.../@deepseek-ai/cordis/lib/index.js:960:27)
```

这一行同时证明了：模块被导入、`Config` 被识别为 Standard Schema、校验在 `apply` 前执行。

### ④ 合法配置启动零告警 = `apply` 与工具注册成功

```powershell
& $dsh --profile demo --patch 'D:\dsh-token-tree\cordis\token-tree.patch.yml' --no-open --port 19403
```

实测 stderr 只有 Node 的 `DEP0180` 弃用提示，**没有** `did not activate`。
`ctx.tools.register` 会在注册时校验 `output.schema`，注册失败会让 `apply` 抛出并触发 `did not activate`；没有告警即代表 5 个工具均已进入工具表。

### ⑤ 工具可被模型调用

模型回合里直接调用（工具已注册到 `ctx.tools`，会出现在下一回合的工具表）：

```text
tree_query            → 当前节点、子分支边权、到根累计成本、分支评分
retrieve_context      → 加权检索结果 + 注入
tree_reflect          → 写反思节点
tree_backtrack        → 兄弟分支回溯（dryRun 可只看计划）
tree_mark             → 置顶/忽略分支
```

### ⑥ 边权更新在日志里可见

`logEdgeUpdates: true` 时，每次工具结果都会写一条 info：

```text
token-tree: edge n7->n8 cost 1.002 -> 1.752 (tool/failure, delta +0.75, updates 1, session session-…)
token-tree: supervisor failed on session session-… (turn 3, reflections 1, backtracks 1, plan n5)
token-tree: mounted — 5 tools (retrieve_context, tree_query, tree_reflect, tree_backtrack, tree_mark), autoInject=true, …
```

同一会话里再调一次 `tree_query`，输出里的 `incoming.cost` / `incoming.lastReason` 会反映这次变化。

### ⑦ 桌面版内的可见验证

以 bundle 方式装好并重开桌面版后，任选其一确认：

1. **设置 → 插件**：列表里出现 `dsh-bonsai`（bundle）及其实例行 `token-tree`，状态为已启用。
2. **头部「树」按钮**（客户端半包）：会话头部按钮区出现一个「树」按钮，点开是块树面板。它依赖三件事同时成立：
   - 包里有 `dsh.client: { platform: "web" }` 与 `exports["./client"]`（已配），构建后产物在 `lib/client.js`；
   - Loader 行名是**裸包名** `dsh-bonsai`（`link:` 安装才有；文件 URL 行没有 package.json，扫描不到）；
   - 宿主把客户端模块登记进启动图。可在浏览器控制台看 `__DSH_BOOT__` 里是否有 `{"id":"dsh-bonsai",...}`，
     或用带 token 的地址直接取：
     ```powershell
     $s = Invoke-WebRequest 'http://127.0.0.1:<port>/?token=<token>' -UseBasicParsing -SessionVariable s
     Invoke-WebRequest 'http://127.0.0.1:<port>/plugins/??dsh-bonsai/client.js&rev=<rev>' -WebSession $s
     ```
     命中应返回 200 和我们这份 bundle；同时 `GET /api/token-tree/tree?session=<id>` 返回
     `{sessionId,focusId,stats,blocks}`（未带 cookie 时是 401，说明路由存在但被 `/api` 的鉴权挡住）。
3. **`/tree` 命令**：在输入框敲 `/tree` 回车（命令面板里也会出现 "Show the weighted conversation tree of this session"），
   会话里直接渲染出树，例如：
   ```text
   token-tree · 358 nodes, 357 edges, depth 27, mean edge cost 1.41 · 126561 tokens
   kinds: tool_result=331  answer=19  question=7  note=1
   focus: n325 (current)

     n1 [note] session root
       n2 [question] cost=1.00 +4 tools (3 failed) 编写deepseek harness插件。要求如下：
         n7 [question] cost=1.59 +6 tools (3 failed) 请基于以下需求…
         …
         ▶ n325 [answer] cost=1.72 +33 tools (1 failed) 方案定了：先做 `/tree` 命令…

   focus → root: cost 34.21 over 26 hop(s)
   top branches: n2:357
   ```
   命令结果不进模型历史；`/tree n118` 可指定焦点节点。
3. **新会话直接调用工具**：说一句"用 `tree_query` 看看当前对话树"，能拿到
   `Tree: N nodes, M edges, depth D … Current node nX` 的返回，说明工具确实进了工具表。
4. **闭环验证**：让模型执行一个必定失败的工具（例如读一个不存在的文件），再调 `tree_query`，
   返回里 `incoming.cost` 已按 `failureDelta` 上升且 `incoming.lastReason = "tool/failure"`；
   对应日志行 `token-tree: edge a->b cost x -> y (tool/failure, …)`。
5. **注入验证**（打开 `autoInject` 后）：新回合的第一条用户消息后会跟一条 `[token-tree memory] …`
   注入块，来源标记为 `token-tree`，不会被当成新问题重复建节点。

## 3. 干净环境验证（不碰你自己的 profile）

`DSH_HOME` 指向工作区内目录，profile 与日志都落在里面，删目录即复原：

```powershell
$env:DSH_HOME = 'D:\dsh-token-tree\.dsh-home'
$dsh = "C:\Users\ASUS\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh --profile ttcheck --from-default-profile web --dump-config --patch 'D:\dsh-token-tree\cordis\token-tree.patch.yml'
& $dsh --profile ttcheck --patch 'D:\dsh-token-tree\cordis\token-tree.patch.yml' --no-open --port 19401
```

## 4. 卸载

| 挂载方式 | 卸载 |
|---|---|
| home 层 | 删除 `C:\Users\ASUS\.dsh\cordis.patch.yml` 中的 `token-tree` 行或整个文件 |
| profile 层 | 删除对应 `insert` 行 |
| `--patch` | 不传该参数即可 |
| 方式 D | `& $dsh plugin --profile desktop remove dsh-bonsai`（先退出桌面版） |

需要在保留行的前提下临时关闭：

```yaml
- id: token-tree
  disabled: true
```

## 5. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `1 entry did not activate` + `ValidationError: invalid config` | `config` 字段类型/键名错误 | 按报错路径改 `cordis.yml`；未知键也会报 |
| `1 entry did not activate` + `ERR_MODULE_NOT_FOUND` | `name` 路径写错，或 `dist/` 未构建 | 确认 `D:\dsh-token-tree\dist\index.js` 存在；相对路径是相对 **patch 文件** |
| `ERR_UNSUPPORTED_DIR_IMPORT` | `name` 指到了目录 | 指向具体文件 `…/dist/index.js` |
| `ERR_UNSUPPORTED_ESM_URL_SCHEME` | 用了 pnpm 的 `link:` / `file:` 前缀 | loader 只认绝对路径、`file://` URL、包名 |
| 工具不出现 | 挂载层没生效 / 会话未进入下一回合 | `--dump-config` 确认行存在；工具表在新回合才重建 |
| 边权没有变化 | `logEdgeUpdates: false`，或不是 `tool/result` 事件 | 打开日志开关；确认工具调用真的失败（`isError`） |
| 上下文被塞满 | `tokenBudget` / `injectBudgetTokens` 过大 | 调小，或用 `weights.threshold` 提高门槛 |

## 6. 可观测性

- **挂载**：`token-tree: mounted — 5 tools …, autoInject=…, autoReflect=…, lambda=…, alpha=…, budget=…`
- **注入**：`token-tree: injecting memory block for session … (turn N)`
- **边权**：`token-tree: edge a->b cost x -> y (tool/failure|tool/success|user/ignore|reflect/manual, delta ±d, updates n)`
- **监督**：`token-tree: supervisor failed|stalled on session … (turn N, reflections R, backtracks B, plan nX)`
- **裁剪**：`token-tree: pruned k node(s) from branch nX (session …)`
- **工具面**：`tree_query` 返回 `incoming.cost`、`incoming.components`、`incoming.lastReason`、`children[].edgeCost`、`pathToRoot[].cumulative`
