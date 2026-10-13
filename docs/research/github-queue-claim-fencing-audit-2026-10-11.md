# Bridge queue claim fencing audit

状态：第104轮完整验收并正式加载；保留现有 claim fencing，补充非法 retry deadline 的写入前校验。verify/release各1677/1677、host/11恢复/diff通过，正式DSH PID47864认证HTTP200。

## GitHub 对照

GitHub/agent-reach 检索了 LangGraph、Microsoft Agent Framework、OpenAI Agents JS 和 DeerFlow 的 lease、claim、checkpoint 处理。可复用的共同边界是：claim 必须有 owner/generation，过期任务才能被接管，旧 owner 的结果不能覆盖新 owner。

本轮以 agent-reach 的 GitHub CLI 后端追加核对 [OpenObserve SQLite scheduler](https://github.com/openobserve/openobserve/blob/c99e0278985e59477d2b4ad2622914c5ecde5e44/src/infra/src/scheduler/sqlite.rs#L30-L59)（固定 commit `c99e0278985e59477d2b4ad2622914c5ecde5e44`，AGPL-3.0）。领取递增 `claim_epoch`，heartbeat/完成更新同时匹配 id、epoch 和 processing 状态；`keep_alive_claim` 在执行 SQL 前拒绝非法或溢出的 timeout。只参考条件写入和参数校验边界，未复制或运行外部代码。

## 本项目现状

`QueueRepositorySql` 已实现同一组更严格的约束：

- `claim_epoch` 永不归零，每次接管递增。
- `claim_owner` 和 `claim_epoch` 同时参与 ack、retry、dead-letter、renew 的条件更新。
- 过期 `processing` 行才能被重新 claim；旧 owner 的更新返回 `false`。
- 路由 eligibility 在 claim 事务内判断，错误或不匹配的 runtime 不会偷取请求。
- Bridge heartbeat 丢失 lease 后停止继续写入；数据库锁错误也进入 owner-loss 路径。

这些机制已经覆盖本轮 GitHub 对照的核心 fencing 语义，继续保留现有 lease/claim 协议。

## 本轮发现与回归

旧 `BridgeStore.retry()` 直接将 `Date.parse(nextAttemptAt)` 交给 SQLite。`not-a-date` 被解析成 NaN、绑定成 NULL；原行被改成 retry、attempts 增加、owner/lease 清空，但 `claimCandidates()` 要求非 NULL deadline，导致该行不再可领取。

现在在调用 fenced SQL 前检查解析结果有限性；非法时间抛出 `invalid bridge retry deadline`，claim、attempts、owner/lease 和原 deadline 全部保持。合法 deadline 与原 fencing 条件不变。heartbeat 回归改用原生 Date mock，仍验证相同 200ms TTL 的续租，以及时钟推进到 TTL 后的过期行为。

固定原构建与候选构建的同一探针分别得到 RED 0/1、GREEN 1/1；BridgeStore 26/26、typecheck 通过。完整门禁 `isolated-q7X0V5` 的verify/release各1677/1677；首次门禁的输入漂移、进程清理未确认和挂起夹具证据独立保留，未据此认定资源争用是已确认原因。

此修复阻止新的非法写入；没有迁移或重写现存正式队列行。

证据入口：`src/infrastructure/queue-repository.ts`、`src/coordination.ts`、`src/bridge-store.ts`、`src/bridge-runtime.ts` 及对应 bridge/queue 测试。正式 DSH 的 queue 哈希在第103轮仍为119行不变。
