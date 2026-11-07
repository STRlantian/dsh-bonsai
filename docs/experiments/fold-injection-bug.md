# 折叠不触发：注入消息导致的 turn 误判

日期：2026-11-07

## 症状

web/headless 会话里配置了 aggressive：

```text
foldAboveTokens: 10000
foldKeepTurns: 1
foldBlockRatio: 5
```

会话已经增长到 13 块、176,931 tokens，但：

- `已折叠` 占位：0
- hook 确实触发（诊断日志里每轮都有 `turn-stopping` 和 `fold-check`）
- `maybeFold` 已执行

## 根因

`planTurnFold()` 先按 turn 分组，再做“这一轮的 visible span 是否属于同一 turn”的连续性检查。

插件每轮会注入一条 `source.kind = "token-tree"` 的 user/message（summary 提示、候选问题等）。原代码在记录 `seq -> turn` **之前** 就跳过了这条消息：

```ts
if (sourceKind === "token-tree") continue
const turn = turnOf?.(event.seq) ?? ...
```

于是：

- 该注入消息仍在 `visible` 的 surface span 里；
- 但 `turnOfSeq` 没有它的映射；
- 连续性检查把整个 turn 判成 `foreign`，跳过；
- 所有含注入消息的 turn 都折不了。

所以不是阈值算错，也不是模型没到时机；是 **turn 分组把插件自己的注入消息当成了外来节点**。

## 修复

[fold.ts](src/plugin/fold.ts#L188-L201) 改为先解析并记录 turn，再跳过 `token-tree` / `compact-checkpoint` 内容：

```ts
const turn = turnOf?.(event.seq) ?? ...
if (turn > 0) {
  turnOfSeq.set(event.seq, turn)
  ...
}
if (sourceKind === "token-tree" || sourceKind === "compact-checkpoint") continue
```

注入消息现在会被算进该 turn 的 span，因此折叠时会和该 turn 一起被替换；它本来也会在下一轮重新生成，不属于需要保留的正文。

## 验证

回归测试：`tests/fold.test.ts` 增加“turn 内包含 token-tree 注入”用例。

真实 web 会话（aggressive，8 轮长资料）：

```text
修复前：foldPlaceholders = 0
修复后：foldPlaceholders = 4
```

对应 4 个 `surfaceOp.replace`，每个折叠 1 轮。

测试：**252/252** 通过；`tsc` 临时编译通过。
