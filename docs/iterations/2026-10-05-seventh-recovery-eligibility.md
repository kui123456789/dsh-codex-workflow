# 2026-10-05 第七轮：恢复资格与入口一致性

本轮修复 Reviewer 等待时的资格诊断、Planner 可恢复失败兼容入口的恢复路由，以及取消与执行收尾之间的重复 child disposal。固定源码研究见[恢复资格机制核验](../research/github-recovery-eligibility-patterns-2026-10-05.md)。以下记录区分源码、安装宿主隔离检查和正式运行界面。

## 本轮实施范围

### Reviewer：在 status 中提前检查证据是否仍适用

等待继续的 Reviewer 仍持有原运行句柄时，status 只读取当前工作区证据。工作区已变化时提前返回不可继续的 `workspace_changed` 原因，保留原 Reviewer、DSH child 和 Codex thread；状态查询不释放运行或创建替代子智能体。

证据扫描包含 await。返回后再次核验 workflow 归属、是否已有驱动中的 owner/running、cancel/stop 状态和原 handle 身份。最终结果应反映扫描结束时仍有效的状态，不能把扫描前的等待资格应用到已经取消、停止或更换的运行。

实测可观察结果：工作区变化时 `continuation.available` 为 false，`continuation.reason` 为 `workspace_changed`；没有额外模型回合，原句柄保持。证据不变时继续沿用既有资格规则。缺少证据或读取失败报告固定 `evidence_unavailable`，不暴露原始异常。原有合法空 fingerprint 仍遵循既有 resume 规则。

只有当前进程中等待继续的 Reviewer 候选才扫描工作区；Planner 和正在运行的 Reviewer 不扫描。这是只读文件系统／Git 取证，会产生 I/O，没有模型 RPC。状态只描述本次观测，resume 执行前仍校验实际证据。

### Planner：两个恢复入口共享同一驱动机制

Planner continue 中处理可恢复失败的兼容分支统一委托 Manager.resume，共享默认 instruction、按 workflow 的 single-flight、原线程可用性检查和 stop controller。

该改动收拢的是恢复入口。用户回答澄清问题后的正常规划语义继续遵循既有流程；兼容入口不会直接绕过 resume 调用旧运行对象。原线程不可用时明确报告；继续仍复用原 child/thread，不补建替代 Planner。

红色复现使用真实 Manager 与 SQLite：一次 continue 的初始 owned read 在失败前看到 running，随后模型失败进入 waiting，旧分支直接调用私有 Planner resume。此时线程可用性检查被绕过，模型调用由 2 增为 3；stop 也没有把生命周期取消信号传到这次恢复。普通 parked 并发已有 facade 保护，不能把它误报为本轮新增缺陷。

### Child：取消与收尾只领取一次清理责任

新回归统计原始 `dispose()` 调用次数，发现 cancel 的生命周期清理与恢复执行的 finally 各调用一次，实际为 2。child 自身的幂等行为曾掩盖这个重复调用。

`WorkflowRuntimeState.disposingChildren` 使用 WeakSet 保存一次性清理领取标记。Manager 与 Lifecycle 在调用 dispose 前同步领取；原 child 的后续路径跳过重复调用。该标记不持久化，也不强引用已完成的 child；仍在等待恢复且尚未清理的原句柄不受影响。已有 foreground/cleanup promises 继续负责等待实际异步清理。

## 源码参考与适用边界

| 参考案例 | 本轮借鉴的原则 | 未新增的能力 |
|---|---|---|
| LangGraph 已有状态与恢复意图双条件 | 等待记录、业务资格与原句柄分别验证 | 图任务 checkpoint、完成节点输出缓存、跨进程模型恢复 |
| Temporal 具体执行身份与 handle 存在性分开 | 持久 ID 不能代替当前运行可用性；入口共享精确检查 | Temporal 执行链、服务端启动幂等或替换策略 |
| OpenHands runtime/catalog 分层与锁内再次检查 | await 后重核运行身份和生命周期，避免使用过期资格 | 重建 ephemeral runtime、新 catalog 或 lease 框架 |

本项目已有的 continuation 合并、线程保留和清理机制是本轮的复用基础，不以第三方案例再次宣称为新增实现。源码研究只核验固定提交，没有复制代码或在本机运行上游测试。

## 红绿与最终门禁

| 检查 | 预期覆盖 | 当前状态 |
|---|---|---|
| Reviewer 工作区变化回归 | 等待状态提前 `workspace_changed`；只读取证；原 child/thread 保留；模型请求不增加 | 新 `recovery-eligibility.test.ts` **1/1 红 → 绿**；恢复原文件内容后重新变为 eligible，取证不释放原线程 |
| Reviewer 扫描竞态回归 | await 期间 owner/running/cancel/stop/handle 变化，最终资格不使用旧快照 | `recovery-status` 与真实 Manager 两套组合 **29/29 通过**，含缺 reader、缺 fingerprint、取证失败及空 fingerprint |
| Planner 兼容 continue 回归 | 公共 resume 默认 instruction 和可用性规则被实际复用 | 新 `continue-recovery-admission.test.ts` 初次 **3/6 失败**；修入口后 **5/6**，补共同清理 claim 后 **6/6 通过** |
| Planner 两入口并发与生命周期回归 | continue/resume 共用 single-flight；缺线程不调用模型；取消和 stop 控制一致 | 两入口、所有权与实际一次 dispose 断言通过；合并既有 workflow-resume 共 **64/64**，清理与 usage 边界窄审 **18/18** |
| `pnpm typecheck` | 类型检查 | **通过**，包含两项新 context wiring 与清理 WeakSet |
| `pnpm test` / `pnpm verify` | 本仓库完整回归及通过/失败/跳过数量 | **639/639 通过**，失败 0、跳过 0；约 47.2 秒 |
| `pnpm release:check` | 发布、离线 doctor 与包审计 | **连续两次通过**，每次 **639/639**、失败 0、跳过 0；离线 doctor、包审计及临时 tarball 清理通过 |
| `pnpm host:check` / `pnpm host:recovery:check` | 实际安装宿主的隔离兼容与原线程恢复检查 | **均通过**；DSH `0.1.7-rc.2`、九个工具、卸载及 peer/sidebar 契约；四个恢复／清理场景均一个 child 和一次可见 thread 创建，无 pending tools |
| 实际 DSH 产物加载及 UI | 最新产物加载、等待诊断和原侧栏会话 | **本轮未重载正式 DSH**；现有 PID 45264 仍运行第六轮已实测版本，构建产物为本轮最新源码 |
| 真实模型或费用对照 | 原 child/thread 继续及 Token/费用测量 | **本轮无新增真实模型调用**；源码／隔离宿主验证不用于推断费用下降 |

## 验收记录规则

测试结果保留实际计数、失败断言与最终日志位置；安装宿主的隔离检查和正式 DSH UI 分别记录。缺失原线程、工作区变化和显式取消不得通过新建 Planner/Reviewer 掩盖。没有修改正式 DSH 配置或生产会话日志。

系统临时目录日志：`dsh-seventh-targeted-tests.log`、`dsh-seventh-verify.log`；发布与宿主门禁在 `dsh-seventh-final-gates-17cad389-e201-477f-ad72-1537f1281acf/`。这些计数只证明本轮冻结的 639 测试基线，不替随后改动提供验证。

## 后续接续缺口

沿显式审查路径核查时，发现现有 `review` 的 waiting 分支仍把相同输入导向 `resume`，不同输入则直接拒绝。工作区变化后，状态不再允许恢复旧审查，因此缺少直接开始新业务审查的路径。需要在原审查 scope 下确认实际证据变化，释放旧轮次，再由显式 `review` 开始新 Reviewer；没有证据变化仍沿用原恢复规则。这个缺口由后续独立迭代修复和验证，不计入上述绿灯。
