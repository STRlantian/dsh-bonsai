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

- 按原始 token 计数，**aggressive 最少**：prompt token 比不加插件少 **36.3%**，比 default 少 **24.8%**。
  但按 `miss = 50 × hit` 的缓存价格折算，**default 最省**；见下一节。
- default 也省 **15.4%**，但它的 `keep=2`、`ratio=8` 让折叠发生得更晚，共折 7 次；aggressive 折 10 次。
- 三臂质量都是 5/5，工具调用都是 0；这轮没有出现折叠导致答错，也没有额外工具调用。
- 输出 token 上插件臂略高（summary/attach 标记）：base 386、default 681、aggressive 649；相对于节省的 prompt token，这个增量很小。

## 按 cache miss = 50 × hit 折算

只算输入侧，令 cache hit 单价为 1、miss 为 50：

```text
cost = inputTokens × 50 + cacheReadTokens × 1
```

| 臂 | input | cache read | 折算成本 | 相对 base |
|---|---:|---:|---:|---:|
| base | 59,144 | 568,832 | **3,526,032** | — |
| default | 54,111 | 477,440 | **3,182,990** | **-9.7%** |
| aggressive | 61,738 | 338,176 | **3,425,076** | **-2.9%** |

结论变了：**50× miss 下 default 最省，不是 aggressive。**

- default 比 base 省 **9.7%**
- aggressive 只比 base 省 **2.9%**
- aggressive 比 default **贵 7.6%**

原因是 aggressive 折得更频繁（10 次 vs 7 次），每次折叠都会让 keep 窗口重新按 miss 计价；它省下的 cache read 抵不过增加的 uncached input：

```text
default     input 54,111  cache 477,440
aggressive  input 61,738  cache 338,176
             +7,627 input   -139,264 cache
```

在 50× 下，多出的 7,627 miss token 值 381,350，远大于少掉的 139,264 hit token。

### 盈亏平衡点

default 与 aggressive 的 input/cache 差：

```text
r = (477,440 - 338,176) / (61,738 - 54,111)
  = 139,264 / 7,627
  ≈ 18.3
```

所以：

- **miss/hit > 18.3×**：default 更省（50× 属于这一档）；
- **miss/hit < 18.3×**：aggressive 更省。

base 与 default 的平衡点约 **18.2×**；base 与 aggressive 约 **88.9×**。

## 由 miss/hit 解最优折叠阈值

假设每次折叠恰好到达阈值 `T`（待折块），每轮新增 `t` token，保留 `K` 轮，miss/hit 比为 `r`。

折叠一次的代价：保留窗口 `K*t` 在折叠后要按 miss 重读一次，额外成本约：

```text
(r - 1) * K * t
```

折叠周期内，待折块从 0 长到 `T`，平均每轮被命中 `T/2` 个 token；周期长度 `T/t`，所以这部分成本是：

```text
(T/t) * T/2 = T²/(2t)
```

把折叠代价摊到每轮：

```text
cost/turn ≈ t*(r-1)*K / T + T/2 + 常数
```

对 `T` 求最小值：

```text
T* = t * sqrt(2*K*(r-1))
```

对应的最优比例：

```text
ratio* = T* / (K*t) = sqrt(2*(r-1)/K)
```

代入 `r=50`：

| 保留轮数 K | 最优 T*/t | 最优 ratio |
|---:|---:|---:|
| 1 | 9.9 | 9.9 |
| 2 | 14.0 | 7.0 |
| 3 | 17.1 | 5.7 |

所以：

- default `K=2, ratio=8` 的 ratio 门槛 `16t`，离最优 `14t` 不远；
- aggressive `K=1, ratio=5` 的门槛只有 `5t`，远低于最优 `9.9t`，折得太早，cache 失效成本超过了节省；
- 这也解释了 50× 下 default 反而更便宜。

注意这是**稳态、每轮 token 相同、每次恰好到阈值**的近似；实际还要受 `foldAboveTokens` 绝对下限、`foldCadence`、真实 turn token 波动和 cache 前缀实现影响。代码里对应：

- [optimalFoldThreshold](src/plugin/fold.ts)
- [optimalFoldRatio](src/plugin/fold.ts)



> output token 未计入上表；若 output 也按 hit 单价计，base/default/aggressive 分别再加 386/681/649，排序不变。若 output 有独立价格，按实际单价加即可。

## 限制

- 这是单轮 13 turn 的确定性事实召回 benchmark，不是完整产品评测。
- 总 token 是 input + cache read 的原始计数；实际账单还取决于 cache 命中价格。
- 三臂都用同一 web 宿主，但 base 没有插件工具；prompt 明确要求不调用工具，实际调用数都是 0。

## 会话

- base：`session-bb9c5cb7-3438-4d18-b59d-27d8e8d02831`
- default：`session-54920a2d-b0c4-4a8a-ab14-413fcf61c7a2`
- aggressive：`session-a9ecba6b-c2ae-4c6f-bfce-caff61ea3517`
