# 模块化与状态模型重构 — 阶段记录（2026-09-25 起）

来源：Codex 侧发起并批准的桥接计划（工作流 `00a043f3-d1fe-459d-a598-1bbcbd8f2823`）。
节奏（用户确认）：**分阶段提交 + 每阶段门禁**（`pnpm typecheck` / 相关测试 / `pnpm test`，最终 `pnpm verify` + `pnpm release:check` + `pnpm host:check`）。

**基线**：`8ea523b`（1.1.4 已发布）。本次重构**必须保留**该版本的全部行为，尤其是每轮归还 Reviewer 订阅、`thread/unsubscribe`-only 释放、无 signal 清理的有界期限与备注 flush 机制。

## 阶段总览

| # | 阶段 | 范围 | 状态 |
|---|---|---|---|
| 1 | **ports / facades** | 声明端口层，不改任何行为；`src/index.ts` 仍是唯一 composition root | ✅ 完成（本次提交） |
| 2 | WorkflowManager 内部拆分 | planner-flow / review-flow / submission-flow / lifecycle + 窄 `WorkflowContext`，保留 active-turn、heartbeat、stop、cancel、recovery 的单一所有权 | 🟡 流程边界已提取；内部状态机仍在 facade 内，后续继续拆分 |
| 3 | App Server 拆分 | process-transport / thread-gateway / turn-gateway / reviewer-gateway；JSON-RPC、子进程与 waiter 状态不得泄漏到业务流程 | 🟡 process-transport 已提取；gateway 拆分待继续 |
| 4 | Bridge Runtime 拆分 | queue-pump / session-router / delivery-coordinator / terminal-relay-guard；Bridge 依赖窄 port | 🟡 queue/session/delivery 边界已提取；terminal guard 待继续 |
| 5 | CoordinationStore 拆分 | coordination-database / lease-repository / queue-repository / workflow-repository / live-session-repository / legacy-import；共享同一 SQLite 连接与事务 | ⏳ 未开始 |
| 6 | 状态模型 v2 | `WorkflowRecord` 升 schemaVersion 2（identity/planning/execution/review/submission/bridge/desktop）+ 纯函数 v1→v2 迁移；迁移前备份 coord.sqlite；未知版本/损坏记录进入可诊断错误；对外 status/show/CLI/DSH tool 由 serializer 保持兼容 | ⏳ 未开始（风险最高） |
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

新增 `src/application/planner-flow.ts`、`review-flow.ts`、`submission-flow.ts` 和
`lifecycle-flow.ts`。`WorkflowManager` 现在组合这四个 application flow，并保留原有
public facade 供 DSH tools、BridgeRuntime 和 npm consumers 使用；每个 flow 只接收对应
的 port，legacy state machine 仍由 manager 单独持有。这样先固定了依赖方向和兼容边界，
后续提交可以逐个把内部方法移入 flow，而不需要一次性改写所有状态/取消/恢复逻辑。

**阶段门禁**：`pnpm typecheck`、`pnpm test`（434/434）通过。此阶段尚未声称完成
Planner/Review/Submission/Lifecycle 内部状态机的物理拆分。

## 阶段 3（process transport）— 当前提交

新增 `src/infrastructure/process-transport.ts`，集中管理 Codex App Server 子进程的
stdio spawn、逐行读取、优雅关闭和有界 kill escalation。`CodexAppServerClient` 继续
持有 JSON-RPC pending/waiter/turn 状态，但不再直接创建或关闭 OS child；这为后续
thread-gateway、turn-gateway 和 reviewer-gateway 提供了稳定的进程传输 seam。

**阶段门禁**：`pnpm typecheck`、App Server/Callback 定向测试（63/63）通过。

## 阶段 4（bridge flow boundaries）— 当前提交

新增 `src/application/bridge/queue-pump.ts`、`session-router.ts` 和
`delivery-coordinator.ts`。`BridgeRuntime` 保留原有公开入口，但 queue pump、活跃会话
刷新和 durable callback recovery 已经通过窄 port 进入独立模块；terminal relay guard
仍由 runtime 单一持有，留待下一次拆分，避免改变其取消/teardown 顺序。

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

**门禁**：`pnpm typecheck` 通过（含编译期一致性证明）；全量测试与 `release:check` 见本次提交说明。

**剩余风险**：无运行时风险（纯声明）。唯一需要注意的是阶段 2 起必须真正让流程依赖端口而不是整个 facade，否则端口会退化成文档。

## 每阶段必须保持的不变量

- 1.1.0 专用 Reviewer（绝不 resume Planner/起源任务）；1.1.1 瞬时重试分类与预算；1.1.2 可见创建/命名/`reviewerThreadOrigin` 惰性迁移/未绑定释放/共享别名不改名；1.1.3 控制类 RPC 重试与自锁规避；1.1.4 每轮归还订阅、`thread/unsubscribe`-only、有界清理与备注 flush。
- `WorkflowStore` 同步 CAS 与取消抑制；队列 claim epoch/owner fencing；workflow revision CAS；SQLite DELETE journal + synchronous FULL；Bridge 确定性中继 exactly-once；App Server stop/idle fence；`show --json` 字段稳定；npm 导出与 bridge wire 不变。
