# 交接（HANDOFF）

给下一个对话的自己或别人：这份文件是当前状态的唯一入口。看完就不用去翻 300 多轮的历史。

最后更新：2026-11-05 · commit `b476f60` · 未推送 10 个提交

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
| 折叠时机（轮次关闭前） | 已修 | `agent/turn-stopping` 而不是 `turn/end` |
| attach / summary 标记 | 已修，解析后从正文剥离 | `hooks.ts: stripMarkers` |
| 设置页（首屏 2 行 + 高级） | 重写过 | `client/client.js` |
| 预设（只建树/保留/默认/学习/工程/极省） | 可用 | `src/plugin/presets.ts` |
| 全局 / 本对话作用域 | 可用 | `settings.ts`、`service.effective(sessionId)` |
| 诊断命令 | 可用 | `/prompt` `/fold` `/usage` `/retrieve` `/tree` |

```text
pnpm run test   → 231 passed
pnpm run typecheck
pnpm run build && node scripts/stage.mjs  然后复制 plugin/ 到 profile
```

## 关键设计（别改错）

- **折叠阈值量的是"待折块"**，不是整段历史：块 ≥ `foldAboveTokens`(默认 40000) 且 ≥
  `foldBlockRatio`(5) × 保留窗口，且距上次折叠 ≥ `foldCadence`(3) 轮。推导见
  `docs/experiment-context-cache.md` 实验 38/39。
- **折叠必须在 `agent/turn-stopping` 里追加**（此时轮次还开着）。宿主读取日志时会校验
  "surface 替换必须在打开的轮次内"，在 `turn/end` 之后追加会让日志**下次读取时**被判损坏。
- **轮次号由插件自己数**：宿主 0.2.1-rc.5 不再给 surface 事件标 turn，插件在 user 消息处自增
  （`service.applyEvent`），`seqTurns` 记录每个事件属于哪一轮。
- **插件追加事件的 reentrancy**：在 `session/event` 回调里同步 append 会被宿主拒绝，必须
  在 turn-stopping 或 setTimeout 里做。

## 已知问题（按优先级）

1. **当前会话 3d7b782b 里还有 16 条正文标记**（`[attach:…]` / `[summary: …]`）。它正在被宿主写，
   不能边写边改。退出桌面端后执行：
   `node scripts/clean-marker-text.mjs --session 3d7b782b --write`
   脚本按帧改写并备份，改完用宿主 `session/page` 验证能加载。
2. **3 个损坏会话**（与折叠无关）：
   - `afebc0a3`：`tool/result is outside an open turn` —— 异步任务在 turn/end 后结算的结果。
     修复需要在偏离点插一个合成 `turn/start`；我试过整体重排/删帧都破坏了 per-frame 提交标记，
     没敢再动。**修复方式必须逐帧、且每次改完用宿主验证加载。**
   - `69ea4cc5`、`e8734fe5`：`session event at seq 40 lacks an identified message`，原因未查。
3. 40 个会话的历史标记已清理（备份为同目录 `.bak-<时间>`）；41 个实验会话已移到
   `~/.dsh/sessions-test-backup-2026-11-05T15-55-50-643Z/`（含 manifest.json，搬回来即恢复）。
4. `~/.dsh/token-tree/settings.json` 现在只有 `{}`：之前的 18 条测试会话覆盖已清掉。

## 实验与数据

- `docs/experiment-context-cache.md`：全部实测记录（50+ 节，含失败实验）。
  **文档里的数字都有前提和样本量，引用时一起引。**
- `docs/experiments/*.json`：标注集（18 条学习 / 8 条同义改写 / 15 条必须跳转）与探针结果。
- 关键负结果：检索没有召回增益（父回答进结果 23%、rank1 11%）；BM25 / jieba / BGE 都没有显著提升；
  BGE 在长回答上因 512 token 截断反而更差。

## 规矩（务必遵守）

1. **不发布、不推 tag**，除非这一条对话里明确说"发布"。push 也只在你被要求时做。
2. **不要在桌面端运行时覆盖插件目录**（会让渲染进程加载到不匹配的 bundle）。
3. **改会话日志前先备份**；改完必须用宿主 `session/page` 验证能加载；正在写的会话不要改。
4. 结论先读代码/日志再下，别凭印象（这个对话里我因此错过两次：折叠损坏归因、标记清理范围）。
5. 用户要求：**回答里不要输出 `[attach:…]` / `[summary: …]`**。

## 下一步建议

1. 清掉 3d7b782b 的标记（需要应用关闭）；
2. 修 `afebc0a3` 那类"回合外 tool/result"，或至少在宿主侧确认是否还有新的产生路径；
3. `69ea4cc5` / `e8734fe5` 的 `lacks an identified message` 排查；
4. 决定是否推送这 10 个提交（README 审计、诊断命令、设置页重写、预设合并、作用域修复、标记剥离…）。
