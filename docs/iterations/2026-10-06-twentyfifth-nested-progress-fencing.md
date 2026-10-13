# 第二十五轮：嵌套审查与 callback 进度归属

## 红例与证明范围

完成的可读 callback 已形成实际 checkpoint。A 私有 alignment 被持有，真实撤销租约后，同一 manager 的 B lease generation 通过公开 recovery 消费该实际结果，完成 received 和后台清理。A 随后返回失败，未带 guard 的 fallback `ReviewObservation.mark` 写了一次新 revision，并多调用一次 CLI 模型。另一个 late-seed 注册控制在 B waiting 状态时没有写入，保持绿色，不冒领红例。

实际 AppServerCallbackDispatcher A/B 的旧 callback hooks 在 SQL takeover 后仍发 parent live 并追加 native child continuation；接管前合法接收的小段进度，在 B 完成后 flush 仍发旧 parent。主任务独立复现 callback 组 **2 红/1 正常控制**。

复核还锁定合法终态的回归：实际 owned CAS 在第二次未解决 contract conflict 后把 phase 置 blocked，但 final guard 仍按初始 phase 判定，留下 processState=running、缺 review-end。真实公开 Bridge 流程确认 native/转换各一次、CLI align 两次/reconcile 一次、无 verdict/cycle，原租约/线程/child 均清理后，终态观察仍失败。

## 实施

- 采用显式 guard 参数，沿 alignment/reconciliation、私有 seed 创建前后、注册回合和 fallback mutation 传递。没有引入 ALS 新机制或第三方依赖。
- reconciliation 每次 transient retry 派发前重核，读取原回合后开始结构化转换前重核；不是只在 onStarted 已启动模型后拒绝。
- 新增 WorkflowStore 同步 SQLite snapshot 给 notification guard 使用；执行已完成初始化/导入，不在 hook 中写状态。
- callback progress、continuation、visible review 及 original-thread binding 核原 submission context/实际 lease；资源释放 hook 保持对原线程的清理。
- LiveRelay 在实际 emit 时再次检查 current owner，既有 pending 数据不能在接管后重新出现；close 清理自身 timer/pending，不获得新 owner 权限。
- updateCurrent 拒绝非当前 scope，而非 no-op 更新造成 revision/timestamp 漂移。
- 只在实际成功 updateCurrent outcome 后记录 ownedFinalPhase，允许该执行合法 terminal block 的最终观察；任意外部 phase 变更仍受原 identity/实际 lease 拒绝。
- 私有回合结束仅删除属于该 thread 的 active mapping，不删除新 helper 的映射。

## 验证

```powershell
pnpm exec tsx --test --test-concurrency=4 test/bridge-owned-final-phase.test.ts test/bridge-nested-progress-fencing.test.ts test/bridge-callback-progress-ownership.test.ts test/bridge-review-progress-fencing.test.ts
```

组合 **10/10**，类型检查通过。新增 nested 4、callback 3、owned terminal 1 共 8 回归；前轮 final-progress 2 为兼容控制。完整 raw row/revision、parent/native snapshots、SQL queue 与额外模型调用数保持严格。

backoff 和 post-reconciliation-conversion 两补充用例首次运行时源码已修复，记录为当前绿色覆盖，不声称旧源码红例。真实模型回合/返回被持有，B actual generation 完成后释放 A，第二 turn 或 conversion 的额外调用为 0。成功 owner progress、原已完成 result 的 validation-only recovery 与正常 terminal block 是正向控制。

相关权限/私有线程/Bridge pin/证据/接纳/配置组合 **69/69**；完整最后门禁另以实际运行记录为准。无正式模型调用，不把规范化 SDK 参数当上游真实模型执行证明。

## 固定来源与边界

[固定源码研究](../research/github-nested-workflow-progress-fencing-2026-10-06.md)核验 Temporal 显式传原 workflow lease 给嵌套更新，以及 Node ALS 跨 await/snapshot 保留原 scope；ALS 本身不检查 lease 或撤销回调。固定 SHA、Node 主体/组成许可和上游测试证明范围见研究；未运行上游测试、复制代码或添加依赖。

guard 校验当前授权，不锁住未来远端 RPC；已经在原授权下派发的模型回合仍需要其原 interruption/cleanup 机制。状态不是原资源恢复证明，历史 corrupt 未迁移，实际故障 UI 仍不能由本地脚本验收代替。未把本轮确认路径扩大为所有旧 callbacks 或嵌套写入均已审计。

## 首次门禁中的稳定结果等待

首次完整 verify **894/894**、异步警告 0。随后第一次 release **893/894**，唯一失败是旧 bridge-auxiliary-pin 用例在已接纳提交后用固定 5000ms 轮询等“稳定结果”。该用例通过注入 retry clock/sleep 验证 3000/6000ms logical backoff 期间原 pin，固定 physical 结果等待是另一条前提。

日志 `%TEMP%/dsh-twentyfifth-final-gates-ff4d4f57-7eb0-4d9f-87cf-4a79b115543d/summary.json` 保留为失败记录，不以本轮新用例通过冒领发布检查成功。生产 idle/turn/lease 配置没有因此改变，后续只在实际任务句柄和完成状态上核验夹具。

### 等待夹具修复

隔离探针只持有原 private alignment 6000ms。第 5 秒采样时仍为 sending/running，pin=1、queue=0、实际 SQL lease 剩余 54902ms；原固定观察截止点会误报。第 6006ms 释放后原流程正常 received，原 pin/backoff/清理/判定断言全部通过。这证明观察超时不能作为任务退出或 pin 丢失的证据。

`test/bridge-auxiliary-pin.test.ts` 改为等待该隔离 manager 已注册的 `runtime.backgroundTasks`，随后读取实际结果，严格断言非 queued/sending 且 submissionLeaseToken 已清空。原每阶段 pin、3000/6000ms logical backoff、reconciliation=3/alignment=2、nested pin=2、begins=ends=4、每个已知线程只释放一次、staged command 和最终 cycle=1 断言全部保留；创建失败控制也保留。

修改后独立验证该文件 **2/2**、类型检查通过。没有调整生产 timeout/idle/lease，也没有用增加观察秒数替代任务完成证明。探针日志 `%TEMP%/dsh-bridge-pin-settlement-probe-20261006.log`、独立验证日志 `%TEMP%/dsh-twentyfifth-pin-independent.log` 留作证据；临时探针源码已删除。完整门禁将从头重新执行，原失败记录继续保留。

## 最终门禁

修复等待夹具后从头运行：verify **894/894**，连续 release:check 两次均 **894/894**，三次异步警告均为 0；host:check、host:recovery:check、git diff --check 均退出 0。两次发布均完成离线 doctor 和打包白名单检查。实际结果在 `%TEMP%/dsh-twentyfifth-final-gates-7f642999-44db-4f61-856c-94caa2873421/summary.json`，前次失败记录未覆盖。

此时正式 DSH 仍为 PID 54588、127.0.0.1:3080，运行第二十四轮构建；没有把门禁成功写成已重载。并行只读探针另确认旧 heartbeat catch 和旧 callback finalizer 会停止接管后仍在运行的 B heartbeat，范围为定时器归属，不是 B 模型被取消。该问题进入下一轮独立红绿修复，完成后统一重载，避免两次重复重启。

后续已与第二十六轮统一重载至 PID 64788，认证 HTTP 200、3080 listener 与会话总数 409 已核验；本轮独立门禁与下一轮门禁分别保留。实际统一切换证据见 [第二十六轮记录](2026-10-06-twentysixth-heartbeat-ownership.md)。
