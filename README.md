# 惜流 ThriftFlow

dsh 的**上下文成本治理**：一个回放分析器 + 一个策略求解器。

它回答三个问题，且每个答案都能用你自己的会话日志复算：

- 时间和 token 到底花在哪；
- 压缩阈值、保留量、摘要长度该取多少；
- 改这三个值能省多少，风险在哪。

数学说明书：[`docs/model.zh.md`](docs/model.zh.md)（唯一权威是 `model.ts`）。

## 快速开始

无依赖，Node ≥ 22.18（用原生 type-stripping 直接跑 `.ts`）：

```bash
node replay.ts mock_log.jsonl   # 成本审计报告（合成日志，可直接跑通）
node replay.ts <session.v3.jsonl.zstd>  # 审计一个真实会话（自动识别 zstd 多帧）
node replay.ts --limit=3        # 不带文件：审计 $DSH_HOME 下最大的 3 个会话

node prescribe.ts mock_log.jsonl # 处方：Diff 建议表 + 预计节省 + 可粘贴的 patch
node prescribe.ts --limit=1      # 对最大的真实会话开处方

node selftest.ts          # 回放 25 个最大会话：拟合 + 样本内/外残差
node selftest.ts --tables # 策略表：γ、s、ρ 三条曲线的数值
node selftest.ts --policy # 政策级预测（不读逐步 token）
```

读的是 `$DSH_HOME/sessions/**/session.v3.jsonl.zstd`（默认 `~/.dsh/sessions`）。

`mock_log.jsonl` 是**合成日志**（1,320 行 / 34 turn / 400 次调用 / 2 次压缩，约 1 MB），
用已知真值 `τ0=350ms, α_L=6.0µs, α_M=21µs, α_O=4.0ms` 生成：上下文从 9.2k 涨到 800k
触发压缩、缓存命中 99.3%、峰值 798.8k——刻意复刻真实会话的病理形状。
它与 `model.ts` 的内置常数故意不同，所以残差非零（+1.7%）但应通过判定。

## 当前结论（实测，2026-10）

| | dsh 默认（θ=0.8W, ρ=0.16W） | 模型推荐（绝对值） |
|---|---|---|
| 3,233 步总时间 | 6.03 h | **3.77 h** |
| prompt 总量 | 1.55 B token | **0.15 B token** |
| 每步 | 6.71 s | 4.19 s |

模型对总时间的预测残差：**样本外 5.7%（仅 flash）/ 7.7%（全部模型）**，目标 10%。

## 文件

| 文件 | 职责 |
|---|---|
| `model.ts` | 求解器：常数、band\*/θ\*、成本泛函、三条判据、OLS 标定。纯函数，无 I/O |
| `replay.ts` | 会话日志回放 + **成本审计 CLI**：zstd 多帧/明文 jsonl 解压、折叠成轮次记录、打印报告 |
| `prescribe.ts` | **处方 CLI**：调用 `recommend()`，把推荐值摆成 Diff 表，折算成"分钟 / 万 token"，并输出可粘贴的 patch |
| `selftest.ts` | 回归自测：回放、拟合、残差、策略表 |
| `mock_log.jsonl` | 合成日志（400 步，已知真值），用于验证 CLI 全链路 |
| `docs/model.zh.md` | 推导、判据、常数证据等级、已知局限 |

## 不做的事

- 不做"统一截断工具输出"的插件：`dsh-spill-policy` 已常开，改阈值即可。
- 不做"循环守卫"：`dsh-repeat-tool-reminder` 已默认启用。
- 不做"动态工具集"：schema 只占 1.6%，而换工具集会击穿 prefix cache（实测命中 99.7%）。
- 不做硬性步数上限：重启任务要重新灌入全部上下文，通常更贵。
