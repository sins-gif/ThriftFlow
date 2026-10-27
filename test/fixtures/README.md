# 测试夹具（fixtures）

## `synthetic-long-session.jsonl`

**这是人工构造的合成日志，不是任何人的真实对话。**

它存在的唯一目的：让 `audit` / `prescribe` / `compare` 在**任何机器上、无网络、无真实会话**的条件下都能跑通并被验证。

> **`selftest.ts` 不在其列**：它做的是「样本内/外」切分，硬性要求 `$DSH_HOME/sessions`
> 下至少 2 个真实会话（`selftest.ts:155`），单份夹具无法代替。想让 CI 也跑回归，
> 需要补一份快照断言测试或第二个合成会话——目前**没有**做。

### 为什么必须有它

真实会话日志（`$DSH_HOME/sessions/**/session.v3.jsonl.zstd`）**永远不入库**：

1. **隐私**：里面有完整对话、代码片段、本机路径。
2. **体积**：单文件可达 17.8 MB，且持续变动；一旦进了历史就删不干净。
3. **可复现性**：别人 clone 之后没有你的日志，CI 就跑不了任何一条命令。

所以仓库里只放一份合成夹具（986 KB，约为真实会话 17.8 MB 的 1/18），真实数据在本地跑、只把**聚合结果**写进 README。

### 它刻意覆盖的病理形态

| 特征 | 取值 |
|---|---|
| 规模 | 1,320 事件 / 34 轮 / **400 次模型调用** |
| 上下文行程 | 9.2k → 800k（1M 窗口的 **79.9%**） |
| 缓存 | 整体命中 **99.3%**，但**显式包含未命中台阶**（首轮 0%、第 7 轮 60%、第 24 轮 92%） |
| 压缩 | **强制压缩 1 次**（`compaction/start` → `summary` → `end` + `prune`） |
| 工具 | 24 次 `tool/call` / `tool/result`，含**超预算截断**（`prescribe` 计得截断省下 94,500 tok） |
| reasoning | 占 completion 的 **45.0%** |

### 生成真值是已知的，且故意与内置常数不同

夹具按以下真值生成（τ0=350 ms、α_L=6.0 µs、α_M=21 µs、α_O=4.0 ms），而 `model.ts` 的**内置常数**来自真实会话（486 ms / 5.950 µs / 20.992 µs / 4.032 ms）。

所以拿内置常数去算这份夹具，残差**必然非零**——这是设计意图，不是 bug：

```
实际模型时间  4258.18 s
预测模型时间  4330.78 s   残差 +1.7%（判定口径 |残差| < 10% → 通过）
逐轮 MAPE 1.8%
```

真值可自证：对夹具的 399 个干净步骤重做 OLS，会回收出
`τ0≈342 ms / α_L≈5.997 µs / α_M≈21.571 µs / α_O≈4.004 ms`，与生成真值吻合。

### 怎么用

```bash
node replay.ts    test/fixtures/synthetic-long-session.jsonl   # 审计
node prescribe.ts test/fixtures/synthetic-long-session.jsonl   # 处方
node thriftflow.ts compare test/fixtures/synthetic-long-session.jsonl   # 策略对照
```

> 这三条覆盖解析、zstd/明文分流、折叠、审计、处方、对照六条链路。
> `selftest.ts` 不在此列——原因见开头。
