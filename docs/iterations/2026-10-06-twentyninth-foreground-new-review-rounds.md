# 第二十九轮：前台新审查与原会话继续的边界

日期：2026-10-06。仓库 `D:\工作文件\projict\dsh-cc\dsh-codex-workflow`，HEAD `abb6174d283ced56590bee90b3511948e494b3f0`。保留历轮工作区修改，无 commit、push 或发布。本轮只修前台恢复／新业务接纳，不把新 Reviewer 冒称为原线程继续。

## 真实复现与原因

使用真实 `WorkflowManager`、Codex SDK 和原生 DSH 子会话，连接隔离本地协议进程；没有调用正式上游模型或向用户会话发消息。

| 现场证据 | 缺陷 | 修复入口 |
|---|---|---|
| planned／review_only 两类旧 manager 与 SDK 实际停止，SQL 等待记录不变；原文件真正变成 v2；fresh manager 的公开 `review(originalId)` 拒绝且资源数为 0 | 新业务接纳被迫依赖已丢失的原恢复 handle | `ReviewExecution.prepareNewReviewAfterWorkspaceChange` 从持久原 evidence scope 验变更 |
| 原 SDK 模型等待超时，真实 interruption RPC 失败且原 writer 仍 active；改 v2 后 review 又新增模型 3、thread 2、child 1，丢掉原 handle | 新轮清理绕过原 turn 的中断确认 | 确认原 thread/turn ACK 后才 claim、清理和开启新轮 |
| 另一真实 manager 持有 SQL review lease 时，公开 resume 仍新增模型 3、thread 1、cycle 1，原 row 改变 | 直接恢复未经过 review admission | 原线程继续也取得 `review:${workflowId}` 租约，已有同 workflow fence 则复用 |
| 相同材料的不同新轮意图错误 join；非法非布尔 flag 被接纳；工具丢掉 flag | 材料 identity 无法区分执行意图 | `ReviewRequestInput` 控制字段、独立 flight identity、布尔检查和工具透传 |
| held old cleanup 期间改 approved plan，仍创建新模型且改 row | cleanup 后未完整验证 approval | 捕获并重核 plan／scope，派发前拒绝漂移 |
| A timeout／failed ACK 后 SQL review lease 已释放，但原 SDK writer 仍活着；空 runtime 的 B（同 SQL／SDK／parent）真 v2／explicit 新轮仍新增模型 3、thread 2、child 1 | 当前管理器查无原资源被误当作原物理进程已终止 | typed interruption 捕获原 backend PID 并持久化安全 marker；所有无精确 ACK 的新轮路径核实际 PID |

真实原探针日志保留在 TEMP：`dsh-foreground-lost-context-new-round-probe-20261006.log`、`dsh-foreground-changed-review-unconfirmed-writer-probe-20261006.log`、`dsh-foreground-resume-live-lease-probe-20261006.log`。本轮源码基线在 `dsh-twentyninth-source-baseline-6b108792-e17e-4b0f-a2db-00b6a3bcfeaa`；没有依赖目录 Junction，不操作历史诊断快照。

## 实现边界

- 冷进程只从持久 `latestReviewEvidence.kind/fingerprint/changedFiles` 核原选择的真实变化；不重建旧 input、identity、thread 或 child。无原证据／未变化默认保留原 row，无法继续时明确报告。
- 暖进程继续验证原捕获 identity、settings、输入和 evidence；部分损坏的 handle 不降级成冷进程新轮。残留 active turn、child 或 auxiliary 资源阻止无 handle 替代。
- `newReviewRound: true` 仅代表用户明确请求独立业务审查，不能当作故障恢复；它进入并发意图 key，不进入 SDK 材料或持久 review input。普通 `resume` 不接受该 flag。
- pending interruption 在真实原 pair 上确认；失败或 held ACK 时不清 handle、不释放 child/pin、不写等待 row、不启动模型。已实际退出的原线程不用向替代进程发送旧 ID。
- typed interruption 的原 launcher PID 来自 SDK 已捕获的 `owner.pid`；只在未确认分支读取原进程树并存安全 `processIds`。观察期间 launcher 已退出、没有完整树或查询失败都保持 unknown。既有 retryState 的可选 `interruption` marker 自动序列化，不新增 SQLite schema 或持久 ephemeral thread ID。缺 PID 仍写空 marker。没有完整原 turn handle／SDK 不可用时，必须所有捕获 PID 都经 OS `ESRCH` 确认不存在；live、unknown 或权限错误均拒绝，显式新轮不能绕过。PID 复用保守拒绝，不用于恢复任何旧线程。
- async evidence、ACK、prepared CAS 和旧资源 cleanup 后都重核 scope。review-only 的后续轮次使用 `review(existingWorkflowId, ...)`；不创建第二个 workflow。
- 新轮重新选择未持久固定的设置；原失败不消耗业务 cycle。新轮仍使用既有 evidence、authority、verdict、cycle-limit 和取消／stop 流程。

参考 [固定上游机制研究](../research/github-foreground-new-review-round-patterns-2026-10-06.md)：Temporal 明确区分原 execution 与新 run，TanStack Query 区分原 retryer 与新 options。只借鉴边界，没有新增框架依赖或运行上游测试。

## 已执行验证

新增 16 场景：核心 12、意图／工具 3、approval cleanup race 1。核心正式回归先 4/7 通过、3 个失败；其余 root 意图／工具 3 个与 approval race 1 个均先观察失败再修正。公开 resume 的真实原探针另有失败证据。独立 review 提出的第二 Manager 绕过 ACK 反例随后实际跑红，新增资源计数与旧 writer 活跃均有协议证据。

独立核心 **8/8**，包括 failed→held→confirmed ACK、cold 两 mode 真实变化／同内容拒绝、明确新轮和真实 SQL live lease；日志 `dsh-foreground-round29-repository-green-20261006.log`。source 核心与原新轮组合 **22/22**，root 原恢复相关 **69/69**、入口相关 **52/52**，类型检查通过。

原独立探针修后 cold／warm ACK／public resume 均为 CONTROL，保持拒绝的 row／resource 身份；root 相关组合 **179/179**，异步警告 0。新增跨 Manager 场景修后单例通过，显式／隐式请求均零新增模型资源，实际原进程退出后 fresh process 的新轮成功。

独立跨 Manager 扩展涵盖不同 SDK、空／无效 PID marker、缺失 runtime ACK turn、SDK 可用性投影故障，均保留原 row／child／pin 且新增资源为 0。此处投影注入不冒称实际 shutdown 门控。单 PID 版本与中断组合独立 **29/29**，日志 `dsh-round29-independent-core-interruption-fd7cf4bb-5558-42f7-866c-3f6934d04808.log`。

正式 Windows 无模型 `initialize` 实测证明 original ChildProcess 为 `cmd.exe`，真正 server 位于 `cmd.exe → node.exe → codex.exe` 链；因此单 launcher PID 不足。只读 tree helper 真实捕获 native backend，正常 SDK stop 后全部 8 个捕获 PID 为 `ESRCH`；所有诊断进程已清理，没有停止 DSH／其它进程。证据 `dsh-twentyninth-tree-capture-proof.state.json`。该实验未运行 thread 或模型，也未输出登录配置。修改后 SDK／foreground／model interruption 组合 **24/24**；完整封装链行为回归另行核验。

封装链回归先暴露诊断 fixture 的 liveness 问题：普通 inherit 子进程在 Windows 随 launcher 随后退出，不能作为仍活后端。最终明确使用 detached／EOF keepalive 的诊断后端，真实原 writer 在 launcher 退出后保持 alive；隐式／显式新轮均零新增资源，全部捕获 PID 确认退出后仅一个可见 Reviewer。核心 **10/10**、类型检查通过，日志 `dsh-round29-wrapper-final-core-287587a4-d07c-4a5f-919e-79ca9a7f492a.log`；不把诊断 keepalive 或 SDK 可用性投影注入描述成正式 NPM CLI shutdown 故障。

第一轮完整门禁在当时冻结的 943 场景上通过：verify 167.54s，release:check 两次 169.99s／173.75s，异步警告均 0，host／host:recovery／diff check 均为 0。结果 `dsh-twentyninth-final-gates-297b21b0-fa9b-407d-aaef-93e227897e5b/summary.json`。这没有覆盖随后确认的两个窗口，因此不作为最终验收。

最后独立 review 的两个时序窗口已实际跑红：CIM 查询进程确已启动后 launcher 退出、仍活后端的新轮被错误接纳；真实 ACK 后 caller abort 留下过时 durable marker，错误阻挡 v2 新轮。日志 `dsh-round29-capture-ack-abort-red-593a0b69-283a-454f-b77d-2f0fe03e69a7.log`。修复前者保留 typed unknown 等待屏障，即使原通道已丢失也不能降为无 guard 的 failed；后者在原租约／scope CAS 中保存确认并同步 runtime，caller abort 不撤销真实清理。修后相关组合 **64/64**、类型检查通过；原进程树未知时仍明确不可恢复，不补造旧句柄。

以上是本地确定性故障验证，不是正式模型费用统计或真实模型 UI 故障验收。完整门禁与正式启动在执行后记录实际结果。继续轮实时核查旧正式 PID 52788 已不存在、3080 无监听；认证 metadata 查询为 ECONNREFUSED，重复实际进程与 listener 检查亦无原服务。没有将观察超时当退出，也未停止或重启用户活动。

## 最终门禁与正式启动

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 945/945，163.45s，异步警告 0 |
| `pnpm release:check` 第一次 | 945/945，155.85s，doctor／pack audit 通过，异步警告 0 |
| `pnpm release:check` 第二次 | 945/945，170.38s，doctor／pack audit 通过，异步警告 0 |
| `pnpm host:check` | 退出 0，3.67s |
| `pnpm host:recovery:check` | 退出 0，6.22s |
| `git diff --check` | 退出 0 |

最终结果：`%TEMP%/dsh-twentyninth-final-gates-5e2588e1-d6c3-454d-baa1-a646b177b68a/summary.json`。新增两个时序回归纳入最终 945 场景；此前 943 的通过仅保留为前一版验证证据。没有缩短宿主 deadline、重写既有等待身份或将未知进程改称已结束。

最后即时确认旧 PID 不存在、端口空闲且没有另一 DSH launch 后，按原授权启动正式服务，未执行 kill。实际新 PID **29828**，`127.0.0.1:3080` listener 归该进程，认证 HTTP **200**；web profile 的 Junction 指向当前 D 盘仓库。启动 receipt `%TEMP%/dsh-twentyninth-reload-receipt.json` 保存八个相关构建 SHA256，包括 process transport、typed interruption、review execution 和 admission。

- 认证 metadata：总数仍 **411**，runningIds=[]、waitingWorkflowCount=0；页面载入后 availableCount=1。原 parent `session-1f26c68f-4026-41e2-bca9-0d0b5812fe55` 精确 ID 核对为存在，没有读取其聊天。
- 首次目标检查遗漏脚本第三参数，显示 false；补入该精确 ID 后结果 true。没有将参数错误误报为会话丢失。未迁移或删除历史会话。
- 原 Playwright handle 已权威报 not open，按同名称新开浏览器并加载新私有认证。页面标题 **DeepSeek Harness**，warnings=0；唯一 error 为既有 wallpaper-engine 背景音频 404，未改该插件。
- 私有 stdout、stderr、认证 state 与浏览器 snapshot 保存在 TEMP／已忽略的诊断目录；不输出 token、cookie、登录配置或旧聊天。正式真实上游模型故障未注入，隔离协议／安装宿主验证与 UI health 区分记录。

本轮代码、回归、文档与正式构建已更新；持续优化目标仍 active，没有 commit、push 或发布。
