# 第二十二轮：父会话收尾提示的状态路由

## 实际问题

`onTurnStopping` 原先只检查 executing/fixing，并提示“完成实施/修复，再审查”。真实模型故障两次后，Reviewer 已在原 child/thread 等待，但父会话收到新的实施/审查指令；Planner waiting 则完全没有恢复指引。review-only 启动失败也被要求完成一个不存在的 approved plan。

公开 hook 的真实 WorkflowStore 查询返回前置屏障还证明：cancel、stop、owner/task/attempt 替换，以及 running/resume-flight 变化后，旧读取仍发出提示。主任务独立复现路由组 **4 红/3 正常对照**、归属组 **3 红/1 正常对照**。

## 实施

- 读取 active workflow 前后检查 stopped；返回后验证调用 Agent 归属，并同步检查真实 SQLite row 的 revision。跨 await 改动后的旧快照不接管新记录。
- running process、active/auxiliary turn、review/input/resume flight、活跃 callback 均不产生重复 nudge。活动 submission 保持既有后台等待。
- 同线程等待优先路由：先 status，只有 available 才 resume；interruption_unconfirmed 可重试原 turn 清理，running 等待，其他不可用原因精确报告。保留原 child/thread，不由父会话代写结果或创建替代。
- executing review-only 直接提示原 workflow 的 review，使用现有实现与范围；真实 fixing 保持修复已接受 findings 的语义。
- 正常 planned executing/fixing 与 Bridge submit 路由保持；waiting_input、waiting_review_decision 与 unresolved contract conflict 仍不诱导父模型擅自继续。
- 同 workflow/parent turn 只发送一次；被跳过的旧记录或 busy 状态不消费 nudge key。hook 不发模型请求、不写 durable 状态，不把 waiting 本身当可恢复证明。

## 本地证据

```powershell
pnpm exec tsx --test --test-timeout=15000 test/workflow-stopping-route.test.ts test/workflow-stopping-ownership.test.ts
```

修复后 **11/11**。route 测试使用真实 Manager、SQLite、native ChildSessionFactory/Session，脚本化模型仅注入结果。模型故障等待后，hook 前后的完整 record/resource snapshot 和原 recovery 对象不变；按提示手动 resume 继续原 thread/child，首次应用 verdict 只消耗一 cycle。普通实施、fixing 与实际持有的 Bridge callback 是正向/静默对照。

ownership 用实际 activeForSession 读完后 hold 返回，分别在窗口内改变 cancel/stop/owner/task/attempt/process 状态；整行/revision 不变，无 steer，也不消费 nudge key。resume-flight 分支只改变 runtime map、原 row/revision 完全不变，独立证明 busy 检查，不由 row revision guard 遮蔽。

该夹具原先在 finally release 一个注入的 flight 后立即关 store，异步 load 报 store closed；已保存并 await 同一 flight 再关闭，未修改生产超时或取消结果。类型检查通过。相关恢复/接纳/状态/auto-trigger/中断组合 **102/102**。完整最终门禁另以实际执行记录为准。

## 固定来源与边界

[XState 固定机制研究](../research/github-workflow-action-routing-patterns-2026-10-06.md)核验当前 snapshot/candidate/guard 决定可接纳动作、can 不执行动作、非重入事件不重复 invoke、退出后的 promise 结果过滤。MIT 许可与固定 SHA `38dcaffb20ec7f3cbb10e6161d8f0ebacca33701` 见研究。上游测试只读，未执行；未引入 XState 或复制代码。

SQLite revision 检查拒绝已完成的跨 await 改动，不等于锁住未来工作区或其他进程；实际工具仍必须执行其 admission/owner/evidence 检查。hook 只提示，不直接执行恢复，也不能证明远端模型已停止。旧 corrupt 历史没有自动迁移，正式模型 UI 恢复不由本地脚本网关代替验收。

## 首次门禁暴露的投递夹具窗口

首次完整 verify **864/864**、异步警告 0。随后的第一次 release 为 **863/864**，唯一失败是旧 bridge-runtime 双 runtime 归属路由用例：350ms 后 B 已认领自己的命令（processing），但 followup 尚未投递；测试在确认实际 receipt 之前断言 delivered count。该 case 的默认 lease 是 60s，不是此前低 TTL 用例，不能归因于租约过期。

失败日志 `%TEMP%/dsh-twentysecond-final-gates-d00db7e2-cdf1-4707-99c4-dd7d25b8ad0f/summary.json` 保留。独立原 pattern 1/1 通过仅说明通常调度可完成，不代替本次失败的证据；生产 TTL、routing 和命令投递代码尚未因此改变。

确定性本地 probe 在真实 wfB.save 已提交后持有其返回 350ms：A 保持 inbox/attempt0/epoch0；B processing/epoch1，但 followup0、无 receipt。释放同一 handler 后 B receipt delivered、followup1，A followup0。只调整夹具将原 waitForReceipt(B) 移到投递断言前，替代 350ms 的固定等待；保留后续 300ms 负控及所有归属、次数、epoch、verdict 断言。没有加大生产 TTL、重新 enqueue 或跳过路由门禁。修改后完整 bridge-runtime 文件 **48/48**，类型与空白检查通过，临时 probe 代码删除、证据日志保留。

## 最终门禁与正式重载

最后生产/测试冻结后，从头完成门禁：

| 门禁 | 实际结果 |
|---|---|
| `pnpm verify` | **864/864**，158.81 秒 |
| 连续两次 `pnpm release:check` | 各 **864/864**，105.12/102.54 秒；离线 doctor 与包审计通过 |
| `pnpm host:check` | 安装 DSH **0.1.7-rc.2**，九工具、peer/sidebar 契约通过 |
| `pnpm host:recovery:check` | **11/11 场景**，实际安装服务与 scripted-local 网关，browserUIVerified=false |
| 异步与差异 | 三次全量失败/取消/跳过均 0；全部门禁异步警告 0；`git diff --check` 通过 |

最终日志 `%TEMP%/dsh-twentysecond-final-gates-df20b74f-ff4c-4bf9-94de-cd6a353eeec3/summary.json`。本轮新增 11 个回归；没有正式模型调用，也未结束测试进程。

正式重载前核验 PID **55256** 完整命令/可执行文件、3080 listener 与当前 session 状态；409 sessions，无 running/waiting。只重启已确认服务，新 PID **51152**，认证交换 **303**、健康 **HTTP 200**，listener owner 匹配；重查仍 409 sessions，无 running/waiting。

复用 Playwright `dsh-recovery-20261005`，页面标题 **DeepSeek Harness**。唯一 console 错误仍是 wallpaper-engine 背景音频 **404**，无 workflow 错误；未改该插件。receipt `%TEMP%/dsh-twentysecond-reload-receipt.json` 保存新旧 PID 及构建 SHA256；token/cookie/旧聊天未输出。

历史 corrupt 会话未迁移，真实模型故障 UI 恢复未由脚本或页面健康替代验收。变更留在工作区，未 commit/push/publish，持续优化目标保持 active。
