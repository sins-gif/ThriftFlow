# ThriftFlow（惜流）

**Agent 运行时的上下文成本治理平面。** 拿你自己的会话日志，算出钱和时间花在哪，再算出一个更好的阈值写回去。

`thresholdRatio: 0.8` 这个默认值，在 1M 窗口下等于「几乎不压缩」：上下文涨到 800k 才动手，而那时每一轮 prefill 都在按最大值计费。

## 🚨 两个反直觉的结论

推导基于真实会话日志（3,233 步、平均上下文 423k、峰值 793k、实测 5.69 h）。**每一条都能用你的日志复算。**

1. **最优压缩阈值与窗口大小无关。**
   `band*` 的闭式解里没有 `W`：
   `(θ-ρ)* = √( 2g·[α_M(2ρ+s) + α_O·s] / (γ·α_L) )`
   它取决于增长速率 `g` 与摘要成本 `α_O·s` 的博弈，而不是窗口有多大。`0.8·W` 不是「调大了一点」，是**错误地缩放**。
2. **决定阈值的是摘要「生成」成本，不是被摘要的上下文大小。**
   读入成本随 θ 线性增长，作为带内边际成本被求导吃掉了。所以**摘要越短，阈值可以越低**——压阈值要先压摘要长度。

## ⚡ 核心机制

- **`model.ts`**：拟合自真实日志的时间方程（单个 3,233 步会话 OLS，**R² = 0.764**；用 `fit()` 在 25 会话上重拟合 R² = 0.818）
  `ms = 486 + 5.950·cached_tok(µs) + 20.992·fresh_tok(µs) + 4.0321·output_tok(ms)`
  **样本内**残差 −0.0%（3,233 步会话：20485.85 s 实测 vs 20484.56 s 预测）；
  **样本外** MAPE **7.3%**（24 个未参与拟合的会话），目标 10%，判定通过。
  两个数差这么远是正常的——前者是拟合值，后者才是泛化能力。纯函数，无 I/O。
- **`audit`**：黑匣子审计。输入日志，输出时间分解、缓存命中、压缩判定、逐轮残差。
- **`prescribe`**：输出最优配置 Diff + 预计节省 + 可直接粘贴的 patch。
- **`compare`**：策略投影 before/after；`--after-apply` 则按 apply 生效时间切实测。
- **`apply`**：一键写入宿主配置（备份 / 校验 / `--restore` 回滚）。

## 📊 真实数据（3,233 步会话，deepseek-flash，1M 窗口）

| 指标 | 当前 `0.8W` | 处方 `θ*=64,993` |
|---|---|---|
| 压缩阈值 | 800,000 | **64,993**（= 0.065W） |
| 保留量 `retainTokens` | 160,000 | 30,000 |
| `maxInlineBytes` | 50,000 | 4,500 |
| 平均上下文（稳态） | 480,000 tok | **47,497 tok**（−90.1%） |
| 每步耗时（稳态） | 6.677 s | **4.174 s**（−37.5%） |
| 压缩周期 | 2,723 步 | 149 步 |

本会话实测：**13.68 亿 prompt token，缓存命中 99.7%**，墙钟 5.69 h（6.34 s/步）。
按稳态投影，每步省 2.5 s、平均上下文降 90%——**这是方程换参数的投影，不是跑了一遍的实测**。

> **口径说明**：上表是**策略投影**（同一套方程换参数），不是跑了一遍新配置的 A/B。
> 当前侧投影 6.00 h vs 实测 5.69 h，模型误差 5.4%。
> `compare --after-apply` 才是实测；本机 after 组目前只有 20 步，**低于 50 步阈值，工具拒绝报数**——不编。
> 我自己 applied 的值就躺在这张表里：`~/.dsh/.thriftflow/applied.json`（θ=64,993 / ρ=30,000 / maxInlineBytes=4,500）。

## 🚀 快速开始

零第三方依赖，Node ≥ 22.18（原生 type-stripping 直接跑 `.ts`）：

```bash
# 1. 审计：时间/token 花在哪（mock_log.jsonl 是合成日志，可直接跑通）
node thriftflow.ts audit mock_log.jsonl
node thriftflow.ts audit                      # 不带参数：审计最大的 3 个真实会话

# 2. 处方：最优配置 Diff + 预计节省 + 可粘贴 patch
node thriftflow.ts prescribe                  # 默认对最大的真实会话开方
node thriftflow.ts prescribe mock_log.jsonl

# 3. 落地：写进 dsh 配置（先 --dry-run 看要改哪三处）
node thriftflow.ts apply --dry-run
node thriftflow.ts apply --from=<your-session.zstd>

# 4. 事后验证：按生效时间切实测 before/after
node thriftflow.ts compare --after-apply

# 回归自测
node selftest.ts                              # 25 个最大会话：拟合 + 样本内外残差
node selftest.ts --tables                     # γ / s / ρ 三条曲线
```

`apply` 支持 `--restore=<ts>` 回滚；成功后写 `.thriftflow/applied.json`，作为 `compare --after-apply` 的切分锚点。

数学推导与证据等级：[`docs/model.zh.md`](docs/model.zh.md)。唯一权威是 `model.ts`。

## ⚠️ 踩坑笔记

- **`maxInlineBytes` 不能凭感觉设小。** 它的正确取值是 `min(8KB, 盈亏平衡点)`，盈亏平衡点 = 「一个工具结果在压缩周期里被持有 `n_c/2` 步」的成本 ÷ 「重取一次」的成本。
  同一个公式在两次会话上给出 **4.5KB** 和 **54KB**——差 12 倍。**低于平衡点就是纯亏**：省下的 token 不够付重取的钱。别抄别人的常数，跑 `prescribe` 让日志说话。
- **会话日志是 zstd 多帧拼接。** Node 的 `zstdDecompressSync` 只解第一帧，会得到 1 行「空会话」。必须按 magic `28 B5 2F FD` 切帧（最长会话 10,309 帧）。
- **`γ`（降智惩罚）默认按 1 处理，未标定。** 它只影响 ρ 的余地和总成本，不改变闭式解的形式。γ=2 时 θ*→65.5k、8.44 s/步。要把它降到 1，靠可回取（定位符 / 原文冷存），不靠摘要器措辞。
- **常数只对 `deepseek-flash` 家族成立。** 唯一一个 `deepseek-v4-pro` 会话残差 −53.1%，换模型必须重拟合。

## 不做的事

- 不做「统一截断工具输出」的插件：`dsh-spill-policy` 已常开，改阈值即可。
- 不做「循环守卫」：`dsh-repeat-tool-reminder` 已默认启用。
- 不做「动态工具集」：schema 只占 1.6%，换工具集却会击穿 prefix cache（本会话实测命中 99.7%）。
- 不做硬性步数上限：重启任务要重新灌入全部上下文，通常更贵。

## 已知局限

- 政策级预测 MAPE **13.7%**（未达 10%）：会话起始上下文已很大时会破坏 `steady` 假设。
- `s` 与 `α_M·θ` 未独立标定（`compaction/summary` 事件不带 usage），压缩项预测偏高 +17.5%。
- 工具执行时间约占墙钟 20%，未建模。

详见 [`docs/model.zh.md` §12](docs/model.zh.md)。
