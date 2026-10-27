# TCC 库存扣减（CP · 不超卖）

一个可直接运行的最小完整实现：**Try 冻结 / Confirm 实扣 / Cancel 释放**，
配套本地消息表 + 最大努力通知、幂等状态机、崩溃恢复扫描。

> 与仓库里其他目录无关，可整目录删除。

```
tcc-inventory/
├── types.ts          # 核心接口定义：品牌 ID、记录、错误、端口、消息表结构
├── state-machine.ts  # 分支 15 格迁移表 + 事务迁移表 + 台账不变式（纯函数）
├── participant.ts    # 参与者：Try/Confirm/Cancel 三个幂等入口
├── coordinator.ts    # 协调者：begin/commit/abort + recover 崩溃恢复
├── outbox.ts         # 本地消息表 Relay：租约领取、指数退避、死信、重投
├── inmemory.ts       # 测试替身：串行事务、可序列化存储、故障注入网络
└── simulate.ts       # 39 项断言的可执行验证（含反面对照）
```

```bash
cd tcc-inventory && node simulate.ts
```

Node ≥ 22.18 原生跑 `.ts`（type stripping），无依赖、无构建。

---

## 1. 状态机

### 分支（参与者侧）

```
                 Try                Confirm
   INIT ───────────────▶ TRIED ───────────────▶ CONFIRMED
     │                     │                       │
     │ Cancel              │ Cancel                │ Cancel
     │ (空回滚)             ▼                       ▼
     └────────────▶ EMPTY_CANCELLED      拒绝 ALREADY_CONFIRMED
                    CANCELLED            （Confirm 不可逆）
                       │
                       │ Try（迟到）→ 拒绝 LATE_TRY_REJECTED
                       ▼
                    悬挂防御：回滚后绝不允许再冻结
```

15 格全部显式声明，`assertBranchTableComplete()` 在启动时自检，漏一格直接崩。
三类语义严格分开：

| 语义 | 落点 | 例子 |
| --- | --- | --- |
| 首次执行 | `apply` + 账务副作用 | `TRIED + CONFIRM → CONFIRMED/SETTLE` |
| 重复请求 | `noop`（返回同一结果） | `TRIED + TRY`、`CONFIRMED + CONFIRM` |
| 非法时机 | `reject`（带错误码） | `CONFIRMED + CANCEL`、`CANCELLED + TRY` |

### 事务（协调者侧）

```
TRYING ──▶ TRIED ──▶ CONFIRMING ──▶ CONFIRMED
   │                    ▲              ▲
   │                    └── 超时只回这条边（重试），没有回 CANCELLING 的边
   ├──▶ TRY_FAILED ──▶ CANCELLING ──▶ CANCELLED
   └────────────────────┘
```

`CONFIRMING` 只有一条出边 `CONFIRMED`——**状态机层面就不给你"Confirm 超时改判 Cancel"的权力**。

---

## 2. 三类异常的处理

| 异常 | 危险做法 | 本实现 |
| --- | --- | --- |
| 网络超时 | 当作失败去 Cancel / 回滚 | 超时 = 结果未知。同 `(xid, branchId)` 重试，由参与者状态机给出确定答复；Confirm 阶段只重试不反悔 |
| 重复请求 | 每来一次就扣一次 | 幂等键 `(xid, branchId)` + 唯一约束；状态机把重放路由到 `noop`；Confirm 重放不二次实扣 |
| 系统宕机 | 靠内存里的"待发集合" | 事务状态 + 待发消息同库同事务落盘；`recover()` 扫 `OPEN` 事务重放幂等指令 |

四个必须防住的边界：

1. **空回滚**：Cancel 先到 → 写 `EMPTY_CANCELLED` 墓碑，不碰库存。
2. **悬挂**：墓碑存在时迟到的 Try → `LATE_TRY_REJECTED`，绝不冻结。
3. **不可逆**：已 `CONFIRMED` 的分支收到 Cancel → `ALREADY_CONFIRMED`，绝不把实扣吐回可用池。
4. **台账守恒**：每次写库都过 `assertLedger`，`available + frozen + sold === total` 且分量非负。

## 3. 最大努力通知

```
commit() ──Confirm 拿不到答复──▶ INSERT outbox（与事务状态同一本地事务）
                                      │
                        Relay 扫描（租约 INFLIGHT + leaseUntil）
                                      │
              ┌───────────────────────┼───────────────────────┐
           OK/TERMINAL            可重试失败                终态冲突
              ▼                       ▼                       ▼
             SENT          PENDING + 指数退避(1s→60s,±50%抖动)   DEAD + 告警
                                      │                       │
                          租约过期可被重新领取          人工对账 replayDead()
                                                              │
                                                              ▼
                                                           重投 → SENT
```

投递语义是 **至少一次 + 参与者幂等 = 恰好一次效果**。
`DEAD` 不是终点：告警 + 人工对账 + `replayDead()` 重投，这才是"最大努力"。

关键 SQL（生产落库参考）：

```sql
-- Try：一条语句完成校验与冻结，天然无竞态
UPDATE stock SET available = available - ?, frozen = frozen + ?
 WHERE sku = ? AND available >= ?;          -- affected=0 → INSUFFICIENT_STOCK

-- 分支行：幂等键唯一约束是最后一道闸
INSERT INTO tcc_branch (xid, branch_id, sku, qty, status, version)
VALUES (?, ?, ?, ?, 'TRIED', 1)
ON DUPLICATE KEY UPDATE version = version;  -- 重复 Try 不再变更资源

-- 状态迁移用版本号 CAS，防止并发覆盖
UPDATE tcc_branch SET status = ?, version = version + 1
 WHERE xid = ? AND branch_id = ? AND version = ? AND status = ?;
```

## 4. CP 的代价（必须说清楚）

TCC 在 Confirm 阶段不可回滚，所以网络长时间抖动时只能把库存**继续锁在 frozen**：

- 一致性：保住。没有超卖，账实相等。
- 可用性：下降。`available` 被悬挂冻结压低，新事务可能因"库存不足"失败。
- 这正是 CAP 里的取舍：**宁可少卖/暂时卖不出去，也绝不多卖**。

配套的运维手段（本实现只做到接口层）：

- 悬挂冻结看板：`frozen` 超时未结清的分支数；
- 重试风暴防护：同步重试 ≤3 次 + 指数退避 + 抖动 + Relay 限批；
- 抖动期间对新事务 Try 限流/快速失败，保住 Confirm 通道带宽；
- T+1 全量对账：`tcc_branch` 汇总 vs `stock` 台账，差异必告警。
