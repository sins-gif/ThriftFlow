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
node selftest.ts          # 回放 25 个最大会话：拟合 + 样本内/外残差
node selftest.ts --tables # π 策略表：γ、s、ρ 三条曲线的数值
node selftest.ts --policy # 政策级预测（不读逐步 token）
```

读的是 `$DSH_HOME/sessions/**/session.v3.jsonl.zstd`（默认 `~/.dsh/sessions`）。

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
| `replay.ts` | 会话日志回放：zstd 多帧解压 + 事件折叠成逐步观测量 |
| `selftest.ts` | CLI：回放、拟合、残差、策略表 |
| `docs/model.zh.md` | 推导、判据、常数证据等级、已知局限 |

## 不做的事

- 不做"统一截断工具输出"的插件：`dsh-spill-policy` 已常开，改阈值即可。
- 不做"循环守卫"：`dsh-repeat-tool-reminder` 已默认启用。
- 不做"动态工具集"：schema 只占 1.6%，而换工具集会击穿 prefix cache（实测命中 99.7%）。
- 不做硬性步数上限：重启任务要重新灌入全部上下文，通常更贵。
