# 模块化与状态模型重构 — 阶段记录（2026-09-25 起）

来源：Codex 侧发起并批准的桥接计划（工作流 `00a043f3-d1fe-459d-a598-1bbcbd8f2823`）。
节奏（用户确认）：**分阶段提交 + 每阶段门禁**（`pnpm typecheck` / 相关测试 / `pnpm test`，最终 `pnpm verify` + `pnpm release:check` + `pnpm host:check`）。

**基线**：`8ea523b`（1.1.4 已发布）。本次重构**必须保留**该版本的全部行为，尤其是每轮归还 Reviewer 订阅、`thread/unsubscribe`-only 释放、无 signal 清理的有界期限与备注 flush 机制。

## 阶段总览

| # | 阶段 | 范围 | 状态 |
|---|---|---|---|
| 1 | **ports / facades** | 声明端口层，不改任何行为；`src/index.ts` 仍是唯一 composition root | ✅ 完成（本次提交） |
| 2 | WorkflowManager 内部拆分 | planner-flow / review-flow / submission-flow / lifecycle + 窄 `WorkflowContext`，保留 active-turn、heartbeat、stop、cancel、recovery 的单一所有权 | ✅ Planner、Review、Submission 主状态机已移入 execution modules；facade 只保留兼容入口和少量 CAS delivery helpers |
| 3 | App Server 拆分 | process-transport / thread-gateway / turn-gateway / reviewer-gateway；JSON-RPC、子进程与 waiter 状态不得泄漏到业务流程 | 🟡 process-transport + Reviewer gateway 已提取；thread/turn gateway 待继续 |
| 4 | Bridge Runtime 拆分 | queue-pump / session-router / delivery-coordinator / terminal-relay-guard；Bridge 依赖窄 port | 🟡 queue/session/delivery/terminal guard 已提取；runtime 现在只通过 `BridgeQueuePort` 与 `BridgeDeliveryPort` 调用队列和工作流交付 |
| 5 | CoordinationStore 拆分 | coordination-database / lease-repository / queue-repository / workflow-repository / live-session-repository / legacy-import；共享同一 SQLite 连接与事务 | ✅ Lease/LiveSession/Queue/Workflow SQL 与 legacy import 已移入 infrastructure；CoordinationStore 只保留生命周期门禁和 ops/prune 编排 |
| 6 | 状态模型 v2 | `WorkflowRecord` 升 schemaVersion 2（identity/planning/execution/review/submission/bridge/desktop）+ 纯函数 v1→v2 迁移；迁移前备份 coord.sqlite；未知版本/损坏记录进入可诊断错误；对外 status/show/CLI/DSH tool 由 serializer 保持兼容 | 🟡 serializer、幂等迁移、启动备份和可诊断错误已完成；完整外部门禁待最终收口 |
| 7 | 测试与清理 | 先提取 fixture 再拆 suite；删除前做全仓引用检查；`lifecycle-acceptance.mjs` / `review-only-acceptance.mjs` 与两个无引用 fixture 待清理 | 🟡 清理已完成（见下）；suite 拆分未开始 |

## 阶段 7（清理）— 已完成的部分

**删除前做了全仓引用检查**（`src/`、`test/`、`scripts/`、`package.json`、README/CHANGELOG/docs），只删除**确定过时/无引用**的内容：

| 删除项 | 引用证据 |
|---|---|
| `scripts/lifecycle-acceptance.mjs`（55 KB） | 仅 `package.json` 的 `lifecycle:accept` 脚本引用；该 harness 驱动 1.1.0 之前的 CLI 可见布局 |
| `scripts/review-only-acceptance.mjs` | 仅 `package.json` 的 `review-only:accept` 脚本引用 |
| `test/fixtures/e2e-low-effort.patch.yml` | 全仓**零引用** |
| `test/fixtures/no-desktop.patch.yml` | 全仓**零引用** |

同步更新了活跃入口：`package.json` 移除两个脚本；README 两处改为「这些手工 harness 已移除，改用自动化门禁 + 一轮真实审查」；`docs/release-checklist.md` 的验收步骤改为当前路径（`pnpm verify` / `pnpm release:check` / `pnpm host:check` + 一轮真实 `review_only` 或 DSH-led 审查 + 一次真实 bridge 中继），并把旧脚本内容明确标为历史记录。历史性文档（CHANGELOG 旧条目、带日期的取证文档）不改写。

**未做**：测试套件拆分（先提取 fixture 再拆 suite）——留待后续阶段，避免与阶段 2–6 的模块边界同时变动。

## 阶段 1（ports / facades）— 已完成

**改动文件**：`src/ports.ts`（新增）。

**做法**：每个端口用 `Pick<具体 facade, …>` **从适配器派生**，因此端口不可能与实现漂移——facade 一旦改名或改形，端口与未来所有消费者立刻编译失败，而不是静默不一致。另加 `assertPortsSatisfied(...)`：一个**永不执行**的编译期一致性证明，把五个 facade 各自赋给它应满足的端口。

## 阶段 2（flow boundaries）— 当前提交

新增 `src/application/planner-flow.ts`、`review-flow.ts`、`submission-flow.ts`、
`lifecycle-flow.ts`、`planner-execution.ts`、`review-observation.ts`、
`review-execution.ts`、`submission-execution.ts` 和
`workflow-runtime-state.ts`。`WorkflowManager` 仍是兼容 facade，DSH tools、BridgeRuntime
和 npm consumers 的 public surface 不变；Planner 的建 workflow/建线程/可见回合/继续输入
状态机已由 `PlannerExecution` 持有，审查观测、心跳、陈旧判定和 finish 状态由
`ReviewObservation`、`ReviewExecution`、`SubmissionExecution` 持有。active turns、foreground/background tasks、recovery、heartbeat
和 teardown 的可变状态仍集中在 runtime state，避免拆分后出现第二份取消所有权。

**阶段门禁**：此前门禁为 `pnpm typecheck`、`pnpm test`（438/438）；Planner/Review
抽取后的当前全量门禁为 439/439，详见最终验证记录。

## 阶段 3（process transport）— 当前提交

新增 `src/infrastructure/process-transport.ts`，集中管理 Codex App Server 子进程的
stdio spawn、逐行读取、优雅关闭和有界 kill escalation；新增
`src/application/app-server/model-selection-gateway.ts`，把协作模式、模型列表缓存和
默认模型选择从 client 移出。`CodexAppServerClient` 继续持有 JSON-RPC pending/waiter/
turn 状态，但不再直接创建或关闭 OS child；这为 thread-gateway、turn-gateway 和
reviewer-gateway 提供了稳定的进程传输 seam。

**阶段门禁**：`pnpm typecheck`、App Server/Callback 定向测试（63/63）通过。

Reviewer 生命周期现在通过 `src/application/app-server/reviewer-gateway.ts` 进入，
覆盖创建、配置、恢复、重命名、释放和外部 handoff；Planner 线程恢复仍直接使用
Codex client，避免把 Planner 和 Reviewer 的生命周期混在同一个 gateway 里。
`thread-gateway.ts` 与 `turn-gateway.ts` 也已声明并覆盖各自的窄 port；下一步是把
WorkflowManager/CallbackDispatcher 的具体调用已经迁移到这些 gateway，去掉了流程对 App
Server facade 的直接调用；JSON-RPC waiter 和进程生命周期仍由 client 单独持有。

## 阶段 6（状态 envelope / migration core）— 当前提交

新增 `src/state/workflow-schema.ts`。新写入的 workflow JSON 使用
`schemaVersion: 2`，按 identity/planning/execution/review/submission/bridge/desktop
分组；读取仍返回现有 flat `WorkflowRecord`，因此 DSH tools、CLI、bridge wire 和
facade 不变。旧 flat v1 记录会通过纯函数迁移，v2 迁移幂等，未知 schema 版本会明确报错。
本提交还让 CoordinationStore/CLI 的 raw JSON 读取走同一 serializer。

未知 schema 和损坏 JSON 现在会 fail closed，并把 workflow id 包进明确错误；CLI、
CoordinationStore 和 WorkflowStore 都通过同一 serializer 读取 envelope。最终 release/host
门禁仍在整体重构完成后统一执行。

## 阶段 5（repository seams）— 当前提交

新增 `src/application/coordination/repositories.ts`，为 Queue、Lease、LiveSession 和
Workflow persistence 提供窄 repository adapters，并新增
`src/infrastructure/coordination-repositories.ts`。Lease 与 LiveSession 的真实 SQL、事务
和映射已移入 infrastructure repository，CoordinationStore 只保留 open/close 门禁和兼容
入口；queue、workflow SQL 和 legacy file-queue migration 已移入 infrastructure，只有 prune
ops 仍由 facade 编排，继续保持同一 SQLite 连接、DELETE journal 和事务语义。

## 阶段 4（bridge flow boundaries）— 当前提交

新增 `src/application/bridge/queue-pump.ts`、`bridge-queue.ts`、`session-router.ts` 和
`delivery-coordinator.ts`。`BridgeRuntime` 保留原有公开入口，但 queue pump、队列 claim/
ack/retry/dead-letter、活跃会话刷新和 durable callback recovery 已经通过窄 port 进入独立
模块；terminal relay guard 现在由 `terminal-relay-guard.ts` 单独持有，runtime 只负责启动和
teardown 委托，避免改变其取消/teardown 顺序。

**阶段门禁**：`pnpm typecheck` 和 `normal bridge pump` 定向测试通过；完整套件继续作为
阶段提交前的门禁。

| 端口 | 适配器 | 覆盖 |
|---|---|---|
| `CodexThreadPort` | `CodexAppServerClient` | 线程生命周期：创建/恢复/释放/命名/元数据 |
| `CodexTurnPort` | `CodexAppServerClient` | 回合生命周期：start/continue/interrupt、读回、fork 转换、模型解析、health、start/stop |
| `PlannerPort` | `WorkflowManager` | 规划流入口（start/continue/startExternalPlan/onTurnStopping/decide） |
| `ReviewPort` | `WorkflowManager` | 审查流入口（review/reviewOnly/applyExternalVerdict/assertVerdictStillValid） |
| `SubmissionPort` | `WorkflowManager` | 提交与投递（submit/recoverCallbacks/commitVerdictDelivery/commitSubmissionNoticeDelivery） |
| `LifecyclePort` | `WorkflowManager` | 观察、取消、teardown（status/cancel/stop） |
| `BridgeWorkflowPort` | `BridgeRuntime` | 队列泵与 session 注册表（start/stop/pump/refreshSessions） |
| `WorkflowRepository` | `WorkflowStore` | 持久化工作流记录（CAS 更新、按 session/bridge 请求查询） |
| `QueueRepository` | `CoordinationStore` | 命令队列（enqueue/claim/ack/retry/dead-letter/quarantine/recover） |
| `LeaseRepository` | `CoordinationStore` | 回调租约（获取/续租/释放/归属判定/fencing） |
| `LiveSessionRepository` | `CoordinationStore` | 可路由的活跃 DSH 会话 |
| `CoordinationDatabasePort` | `CoordinationStore` | 共享 SQLite（close/isClosed/journalMode/integrityCheck/sqliteVersion） |

**门禁**：`pnpm typecheck` 通过（含编译期一致性证明）；Lease/LiveSession SQL 委托和
Bridge queue/delivery port 迁移由全量测试覆盖，最终 `release:check` / `host:check` 仍需收口。

**剩余风险**：Review/Submission 主状态机和 queue/workflow/prune SQL 仍待最后一轮迁移；
当前新模块已接入生产调用链，不是只声明端口。

## 每阶段必须保持的不变量

- 1.1.0 专用 Reviewer（绝不 resume Planner/起源任务）；1.1.1 瞬时重试分类与预算；1.1.2 可见创建/命名/`reviewerThreadOrigin` 惰性迁移/未绑定释放/共享别名不改名；1.1.3 控制类 RPC 重试与自锁规避；1.1.4 每轮归还订阅、`thread/unsubscribe`-only、有界清理与备注 flush。
- `WorkflowStore` 同步 CAS 与取消抑制；队列 claim epoch/owner fencing；workflow revision CAS；SQLite DELETE journal + synchronous FULL；Bridge 确定性中继 exactly-once；App Server stop/idle fence；`show --json` 字段稳定；npm 导出与 bridge wire 不变。

## 直接执行收口记录（2026-09-25）

本轮取消后台 DSH 重构任务后由 Codex 直接完成并提交：

- `ef13816`：Planner execution、Review observation、Bridge queue/delivery ports、Lease/LiveSession SQL。
- `d982445`：App Server model-selection gateway、turn gateway 的 round pin/unpin 接入。
- `f7b04ce`：`QueueRepositorySql`，CoordinationStore 只保留队列生命周期门禁和兼容 facade。
- `pnpm verify`：439 tests passed，typecheck/build 通过。
- `pnpm release:check`：`RELEASE_CHECK_OK`，打包审计和 offline doctor 通过。
- `pnpm host:check`：`ok=true`，DSH `0.1.7-rc.2`、插件 `1.1.5`、8 tools、卸载成功、peer compatible。

仍明确保留在后续范围的只有 CoordinationStore 的 prune/legacy-import 编排，以及
WorkflowManager 中少量外部 verdict 的 CAS delivery helpers；它们没有被用空壳 adapter 冒充
完成，Planner/Review/Submission 主调用链和取消/恢复所有权已经由上述模块实际承载。
