# 真机三臂 A/B（web host，已触发折叠）

日期：2026-11-07 14:10 +08:00  
宿主：`dsh web`（scratch profile，独立 `DSH_HOME`）  
模型：DeepSeek Flash

## 方法

- 同一组 prompt：8 段长资料（每段约 13k token，含固定事实）+ 5 个针对早期事实的追问。
- 三个独立会话：
  - `base`：不装插件，端口 19612。
  - `default`：插件 balanced 预设，`foldAbove=30000`、`keep=2`、`ratio=8`、`cadence=10`。
  - `aggressive`：插件 aggressive 预设，`foldAbove=10000`、`keep=1`、`ratio=5`、`cadence=3`。
- 两个插件臂都写回 `toolDeny=[]`，工具可见性一致。
- 所有 prompt 要求不调用工具；三臂实际 tool call 都是 **0**。
- 正确性按固定事实精确匹配，5 题。
- 折叠修复见 `fold-injection-bug.md`；修复前 web 会话折叠 0 次。

## 结果

| 臂 | 正确 | 折叠次数 | input | cache read | output | prompt 合计 |
|---|---:|---:|---:|---:|---:|---:|
| base | 5/5 | 0 | 59,144 | 568,832 | 386 | 627,976 |
| default | 5/5 | 7 | 54,111 | 477,440 | 681 | 531,551 |
| aggressive | 5/5 | 10 | 61,738 | 338,176 | 649 | 399,914 |

相对 base：

| 臂 | prompt 变化 | 总 token 变化 |
|---|---:|---:|
| default | **-15.4%** | **-15.3%** |
| aggressive | **-36.3%** | **-36.3%** |

aggressive 相对 default：

```text
prompt -24.8%
总 token -24.7%
```

## 结论

- 折叠真正发生后，**aggressive 最省**：prompt token 比不加插件少 **36.3%**，比 default 少 **24.8%**。
- default 也省 **15.4%**，但它的 `keep=2`、`ratio=8` 让折叠发生得更晚，共折 7 次；aggressive 折 10 次。
- 三臂质量都是 5/5，工具调用都是 0；这轮没有出现折叠导致答错，也没有额外工具调用。
- 输出 token 上插件臂略高（summary/attach 标记）：base 386、default 681、aggressive 649；相对于节省的 prompt token，这个增量很小。

## 限制

- 这是单轮 13 turn 的确定性事实召回 benchmark，不是完整产品评测。
- 总 token 是 input + cache read 的原始计数；实际账单还取决于 cache 命中价格。
- 三臂都用同一 web 宿主，但 base 没有插件工具；prompt 明确要求不调用工具，实际调用数都是 0。

## 会话

- base：`session-bb9c5cb7-3438-4d18-b59d-27d8e8d02831`
- default：`session-54920a2d-b0c4-4a8a-ab14-413fcf61c7a2`
- aggressive：`session-a9ecba6b-c2ae-4c6f-bfce-caff61ea3517`
