# 第二十七轮：共享 Reviewer 的消费者归属

## 真实复现

沿用第二十六轮运行态核验：正式 DSH PID 64788、3080 listener 匹配、409 sessions、无 running/waiting workflow。仓库仍在 main/abb6174，历轮未提交修改保留。本轮没有操作正式服务。

两个隔离 probe 使用真实 CodexAppServerClient、现有本地协议子进程、真实 AppServerCodexCallbackDispatcher，以及 Cordis 内的 SubagentRuntime/Projection 与 CodexChildSessionFactory。通过实际 SQL 撤销 A lease，再公开 recoverCallbacks 接纳 B；不是两个独立 fake callback。

| 路径 | 实际 RED 证据 |
|---|---|
| 旧租约取消共享 active flight | B join 原 operation，thread/child 都只有 1。释放被持有的原 A heartbeat renew 失败回调后，旧 onLost/finally 按共同 key 发出 2 次实际 interrupt，B 的 writer 从 1 变 0、状态变 retrying、原 child 被 dispose 1 次；模型回合仍只有 1。 |
| 旧收尾关闭已转交的 retained child | A 实际两次失败后保留原 Reviewer，最后 retrying CAS 已提交但返回被持有。B 接管并在同 thread/child 开始第三个 continuation 回合。释放 A 后，B 的真实 SQL lease 仍有效、writer=1、interrupt=0，但原 child map 项被删除、dispose=1、新增 turn/end=1。 |

日志分别为 `%TEMP%/dsh-shared-reviewer-cancel-probe-20261006.log` 与 `%TEMP%/dsh-shared-reviewer-child-probe-20261006.log`。原 child.finish/dispose 栈来自 SubmissionExecution 和 WorkflowManager；没有新建替代模型线程。隔离测试作者已删除临时 CJS probe 源码，脱敏证据保留。

## 仓库红例与观察路径

`test/bridge-shared-reviewer-ownership.test.ts` 将两核心场景转为真实 SDK/native/SQL 回归，修改生产源码前 **2/2 红**，类型检查通过。记录 `%TEMP%/dsh-bridge-shared-reviewer-ownership-red-20261006.log`；共享 fixture 不注册测试，可被独立观察测试复用。

主任务另补 `test/bridge-shared-reviewer-observation.test.ts`，在独立第二十六轮源码快照实际 **2/2 红**：

- 同 flight 已由 B 采用，协议子进程发出实际 `item/agentMessage/delta`，原 SDK 收到通知却仍路由旧 A hook，原 native child 收到该消息 0 次。
- 原英文输出触发中文显示契约 rewrite，第二个可读回合仍使用同 thread。其实际 onStarted 调用旧 A 的写入 hook，抛出 `SubmissionReviewContextError: submission review lease was lost`，没有转给 B。

该 rewrite 证明对应可读回合 onStarted，不是没有被提供的 conversion onEphemeralStarted。日志 `%TEMP%/dsh-twentyseventh-observation-red.log`；快照完整复制当前 src 后以已保存的六个第二十六轮源码覆盖，未把修改中的生产源码当旧红例。peer 依赖仍为同一锁定版本。协议 fixture 仅增加本地可选通知/完成文本/hold 参数，缺省行为不变。

## 原资源不可恢复的边界

主任务新增 `test/bridge-shared-reviewer-retirement.test.ts`，独立第二十六轮源码快照实际 **2/2 红**，日志 `%TEMP%/dsh-twentyseventh-retirement-red.log`：

- 同进程原 lease loss 已取消 writer、释放订阅、dispose child，后续 recovery 没有新模型，但把不可恢复报告成 `cancelled by user (latch)`/busy，继续 retrying。该例不是新线程缺陷，不混称 replacement。
- 新 manager/new real App Server process 消费同一实际 SQLite 记录时，原 `reviewerThreadOrigin=app-server-ephemeral` 仍被当成未运行审查，在新进程新建 thread 并执行 1 次可读模型。实际进程 PID 不同，模型未输出真实上游内容。

consumer-aware 路径须区分未创建、原 operation 活跃/保留和原资源已失去；进程本地证据不足时明确 unavailable，禁止重建 ephemeral Reviewer。legacy CLI/durable callback 的队列恢复契约另行保留。旧测试中两个独立 dispatcher 重跑同一 ephemeral 审查不能继续作为“同轮恢复”的正向验收，须按该测试真实保护的 SQL/progress 目的标明 legacy 范围。

## 范围与采用方向

模型 operation、lease consumer registration 与 native child 的当前 owner 是三层身份。threadRefs 只计 physical dispatcher.run，第二 send 直接 join 不增加 consumer；WeakSet 只防重复 child disposal，不保护同一个 child 从 A 交给 B。

本轮要保留原 thread/child，通过明确 consumer 句柄区分旧租约清理和整个 workflow 的取消。共享 operation 的 signal、progress/rewrite hooks 和 native child 收尾都必须跟随当前合法消费者。closing 的原 child 不能被重新采用；确已丢失或中止而无可恢复句柄的 operation 不自动创建替代线程。无 consumer 的旧 dispatcher 调用及显式取消/插件 stop 保留兼容语义。

固定机制研究见 [共享 consumer 归属](../research/github-shared-workflow-consumer-ownership-patterns-2026-10-06.md)：TanStack Query 按 observer 移除并复用公共请求，Effect RcMap 按 caller scope 保留原 entry。两者都不提供本项目 SQL 授权或模型中断 ACK；仅采用机制，不增加依赖或复制框架代码，上游测试只读未运行。

当前正在将上述强边界 probe 转为仓库回归，再实施与验收。第二十六轮源码快照在 `%TEMP%/dsh-twentyseventh-production-baseline`；正式服务仍运行第二十六轮构建。修后结果与重载将按实际执行补充。

## 实施与目标验证

- 新增 `SubmissionReviewConsumers`，consumer 持原 workflow/submission/owner/epoch/context/child；准备 B 不先撤销 A。dispatcher 先检查原请求签名，再同步采用 B、结束 A 的等待。旧消费者失去原资源取消和收尾权限。
- 同一 physical operation 保存独立 controller 与当前 observer。模型 options 里的钩子是稳定转发函数，跨接管仍调用当前 observer；已有 visible turn 和 usage source 回放绑定 B。legacy 无 consumer 调用保留旧 join 语义，不擅自变更第二调用者的 signal/hook。
- 每个 consumer 的 wait 可独立结束，只有当前 consumer 的中止才传给 physical controller；精确取消返回原 flight/retained cleanup 完成证明，私有清理等它结束后才释放 child。
- 原 child 关闭权限同步声明 closing，拒绝再采用，cleanup Promise 只执行一次。被拒绝的 checkpoint 交接可通过捕获的原 registration 显式退休已失权私有资源；不取得提交授权，不清已采用 B。
- 已运行 ephemeral submission 的进程本地原 consumer/flight/retained 缺失时明确 unavailable；同进程退休有 tombstone，fresh manager 没有原 registration 也不重建。新业务 submission 未运行时仍可正常创建。legacy callback 的独立进程恢复不套用 App Server consumer 契约。
- 显示 rewrite 追加短消息回合到原 native child，仍在同 Reviewer thread；没有重审工作区或重复原任务全文。

主任务独立最新组合：新增 13 场景与既有 legacy progress 3 场景，合计 **16/16**，类型检查通过；日志 `%TEMP%/dsh-twentyseventh-new-independent.log`。接口 5 场景、接管后显式 cancel/stop 2 场景为修后新增正向覆盖，不声称旧源码 RED。实际两核心、两观察、两不可恢复场景共 6 个先红例保留。

两个独立 dispatcher 的旧 callback progress fixture 通过明确 legacy adapter 去除 consumer 要求，继续检验实际 SQL 和旧 callback/display fencing，原断言保留 **3/3**。这不是 consumer-aware ephemeral 恢复的正向证据；后者由同真实 SDK/native/thread/child 的新增场景验证，未篡改生产 adapter 的能力标志。

完整门禁和正式重载以实际执行后追加结果为准。源码作者的兼容目标组合正在完成，正式 DSH 未改变。

### 首次完整门禁与旧等待契约

源码作者最终目标组合 **70/70**、类型检查通过。第一次完整 verify 的有序输出停在旧 `bridge-nested-progress-fencing` 文件；CIM 确认原 runner 83652 与该 worker 82556 都存活，其它 workers 已推进到后续测试。没有把观察超时当终止，也没有立即重启。

只读定位到旧测试第 173 行等待 `oldOwnerCancelled.entered`，该 gate 只由旧 callback 的公共取消触发。B 同 manager 采用原 completed checkpoint 后，本轮故意禁止 A 对共有 key 取消，故这个等待永远不可达。确认逻辑原因后核验 runner 的 PID/命令，只终止该测试树；正式 PID 64788 未动。原门禁退出 1、291.57s，结果保存在 `%TEMP%/dsh-twentyseventh-final-gates-22bbacfa-2119-4945-b437-a7688bb03e6d/summary.json`，不记为验收通过。

fixture 改为断言传入真实原 consumer 的 signal 已被合法接管撤销，且公共 callback cancel 在接管后和旧任务最终返回后都为 0。原所有 held alignment/reconciliation、SQL lease、完整 row/revision/events、队列、模型数、订阅与 pin 清理断言保留，独立 **4/4**，日志 `%TEMP%/dsh-twentyseventh-nested-consumer-gate-green.log`。另对 workflow 的 lease-loss/stop-recovery/single-flight 三个实际疑点仅定向运行 **3/3**，未发现取消 Promise 自等待环，生产源码没有因此改变。全部门禁随后从头重跑，首次未完成记录保留。

### 第二次完整验证与兼容修正

第二次 verify 正常结束 **909/914**、异步警告 0、213.49s。日志 `%TEMP%/dsh-twentyseventh-final-gates-c26d7251-35e7-4a4f-813d-998aff7703a1/summary.json` 保留为失败记录，后续 release/host 门禁未执行。

1. 旧 e2e 预期新 App Server 重启后重新执行同一 ephemeral 审查，违反本轮明确边界。保留首次 normalization failure 的 retrying/no notice/no cycle 断言；重启部分改为明确 failed/unavailable notice、attempt 仍 1、无 verdict/cycle，第二个模型输出的实际序列文件未被消费。定向 **1/1**，`%TEMP%/dsh-twentyseventh-e2e-ephemeral-restart-green.log`。同进程重用原审查及转换由其它真实回归继续保护。
2. 四个原 workflow legacy callback 恢复被 registry 无条件退休标记拦截，这是生产兼容回归，未通过改测试掩盖。consumer 模块默认 strict；SubmissionExecution 从固定 adapter 能力显式传入 requireOriginal，只有 legacy independent callback 豁免退休标记，closing/closed child/context/epoch 全部保留。原四测试 **4/4**，新增 13 原资源保护回归 **13/13**，类型检查通过，源码再次冻结。

第三次全部门禁从头执行，前两次未完成/失败记录保留，不以目标组合代替发布通过。

## 最终门禁与正式重载

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 914/914，252.35s，异步警告 0 |
| `pnpm release:check` 第一次 | 914/914，157.96s，离线 doctor/打包检查通过，异步警告 0 |
| `pnpm release:check` 第二次 | 914/914，220.80s，离线 doctor/打包检查通过，异步警告 0 |
| `pnpm host:check` | installed host ok，退出 0 |
| `pnpm host:recovery:check` | 11 个脚本化宿主故障/恢复场景通过，退出 0 |
| `git diff --check` | 退出 0 |

最终结果在 `%TEMP%/dsh-twentyseventh-final-gates-cc39949b-64b0-44ba-9085-a1bbaab570e1/summary.json`。之前的中止与 909/914 失败记录没有覆盖。最终新增 13 场景由 6 个先红例及 7 个修后接口/取消停止正向组成，没有冒领所有场景都先红。

重载前重新核验旧 PID 64788 的 executable/global entry/命令、127.0.0.1:3080 listener、409 sessions、runningIds=[]、waitingWorkflowCount=0。仅停止该已确认的 DSH 树，重载后：

- 新 PID **69208**，旧 PID 已退出；3080 listener 归新进程，认证 HTTP **200**。
- 新私有 state `%TEMP%/dsh-twentyseventh-formal.state.json`；会话总数仍 **409**，无 running/waiting workflow。
- 复用 `dsh-recovery-20261005` 浏览器，加载新认证后页面标题 **DeepSeek Harness**。控制台 1 条错误为既有 wallpaper-engine 背景音频 404，warnings=0。
- receipt `%TEMP%/dsh-twentyseventh-reload-receipt.json` 记录新旧 PID 及 workflow/App Server/Planner/AppServerCallback/SubmissionExecution/SubmissionReviewConsumers 构建 SHA256。workflow.js 的改动只涉及类型，构建 hash 与上轮相同；consumer/callback/execution 构建单独保存，未用不变的 workflow hash 冒领新逻辑验证。

没有修改正式 profile、credentials、用户数据或旧聊天，没有正式上游模型调用，历史 corrupt 会话没有迁移。真实上游模型故障 UI 仍需现场确认，脚本化宿主场景不是其替代。本轮没有 commit、push 或发布；持续迭代目标保持 active。

临时 CJS probe 已删除。旧源码红例快照的递归清理被自动审批拒绝，返回理由仅为 `blocked by policy`；该目录标记 `DIAGNOSTIC-SNAPSHOT.md` 后作为 TEMP 诊断备份保留。其 dependency junction 未递归删除，仓库依赖没有改变；正式 stdout/state 仅以私有文件保存，未输出 token/cookie/聊天内容。
