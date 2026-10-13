# 第二十四轮：实际 Reviewer 参数与 Bridge 最终观察

## 实测故障

planned workflow 只保存 Planner 设置，Reviewer row 的 model/effort 可以为空。原 native 请求实际采用 config/resolved model A、low，但 waiting 后全局设为 B/high，手动恢复重新选择 B/high。自动 continuation 的 model 局部值不变，effort 却每次重新读取配置；未知模型的原调用省略 model，恢复时又被新配置填入 B。

主任务独立跑 `reviewer-settings-recovery.test.ts`，**3 红/1 新轮次正常对照**。后续缺设置句柄对照首次运行时源码已修复，记录为当前绿色覆盖，不冒领红例。

Bridge A/B 使用真实共享 SQLite 队列、10s lease 和实际撤销。B 后台完全结束并 received 后截取完整 row/events/queue，再释放 A 并等待其后台结束，A 的 `ReviewObservation.finish` 将 revision **15→16**、改变 updatedAt 并重复结束事件。主任务独立锁定真实红例；不是把 processing 当 delivered 或尚未完成的 B 当基准。

## 实施

- 为每轮前台审查捕获冻结的 `reviewerSettings`：模型已配置或已解析则保存原参数，未解析则明确保存 model 省略；effort 在初轮选择一次。
- auto continuation、manual resume 和再次 waiting 复用同一参数对象。status/恢复入口对缺原设置的句柄报告 unavailable，不从当前 config 重建。
- 结构化转换沿原模型和原 low 策略；alignment/reconciliation 接收显式设置覆盖，model 为 undefined 时也不退回新 config。保留既有 CLI reconciliation effort 策略。
- 真正 workspace 变化后的显式新业务审查仍允许新的未保存配置；review-only 保存的显式/有效 override 保持其原优先级。
- Bridge 最终观察与 cleanup-note mutation 内执行原 submission identity、token/epoch、实际 lease 检查。leaseLost 旧执行不再调用 finish；已进入 finalization 的旧执行仍须在事务内证明 ownership。
- 原执行的 cancellation/failure 仍允许其合法收尾；取消只在原上下文一致时将 phase 对比规范回原 phase，不授权替代 owner。旧资源由创建者清理，不改赢家业务记录。

## 本地证据

```powershell
pnpm exec tsx --test --test-concurrency=4 test/reviewer-settings-recovery.test.ts test/bridge-review-progress-fencing.test.ts test/review-authority.test.ts test/bridge-review-checkpoint-lifecycle.test.ts
```

组合 **42/42**，类型检查通过。设置组使用真实 Manager、Session/ChildSessionFactory、本地严格网关与实际 SDK normalizer 委派参数，验证 configured/resolved 两种来源、auto effort、原 model omission、显式新 round、legacy 设置缺失；private conversion 参数保持 low，无正式模型调用。

Bridge 组验证完整 durable row/revision、父 events、SQLite queue row/count、backend calls/pins/release 均保持 B 完成快照；不是只检查 verdict 未被改。原组以及权限/和解/checkpoint 控制保留。

追加一个真实事务窗口：A 已进入 finish 并停止 heartbeat，在实际 update 之前接管 SQL lease，但刻意不更改 workflow row 的旧 token/epoch。事务内 finish guard 正确拒绝并不发结束事件，外层 startSubmissionTask.finally 却仍清旧字段、revision **10→11**。主任务依据精确窗口修复 current/recovery 两条清理路径为共享 releaseSubmissionFence：release 必须返回 true；随后实际 update 事务内校验原 epoch 仍已释放、owner 空、until=0，且 record 原 scope/fence 一致。release 与 update 之间发生新的 acquire 也不能清赢家记录。

配置 5、Bridge final progress 2、checkpoint 生命周期 7、启动生命周期 4，组合 **18/18**；类型检查通过。事务 case 的旧外层 cleanup 红例有严格实测日志，不把此前仅 guard 的绿色误写成整条 cleanup 已安全。

此前含新身份回归的 53 用例诊断组合在额外 `--test-timeout=30000` 下有 **51 通过、2 取消**，不计完整通过；单独设置组 5/5 完成，按仓库标准命令的组合结果另列。没有提高生产 timeout/lease 或删掉取消/身份断言。

## 固定来源与限制

[固定研究](../research/github-run-settings-and-progress-fencing-2026-10-06.md)核验 Temporal 的有效 Activity 配置保存/重试读取，以及 heartbeat 在原 token/attempt 校验后才写进度；BullMQ progress 仅 EXISTS 后 HSET、没有 lock token，因此明确作为不满足 loser fencing 的对照。固定 SHA、MIT 许可和较窄上游测试范围见研究；未运行上游测试、复制代码或增加依赖。

捕获的是原请求参数，不是对未知上游实际选用模型的推测。status 不是锁，模型结果、证据和 lease 仍独立检查。此轮实际证明的是 Bridge 最终 observation/notes，不能扩大成所有嵌套进度或历史日志均已修复。corrupt 会话未迁移、真实模型故障 UI 恢复未由本地脚本代替验收。完整门禁和正式重载结果另以实际执行记录为准。

## 最终门禁与正式重载

最后源码/测试冻结，仓库标准命令实际通过：

| 门禁 | 实际结果 |
|---|---|
| `pnpm verify` | **886/886**，340.64 秒 |
| 连续两次 `pnpm release:check` | 各 **886/886**，179.60/234.76 秒；离线 doctor 与包审计通过 |
| `pnpm host:check` | 安装 DSH **0.1.7-rc.2**，九工具、peer/sidebar 契约通过 |
| `pnpm host:recovery:check` | **11/11 场景**，安装服务与 scripted-local 网关，browserUIVerified=false |
| 异步与差异 | 三次全量失败/取消/跳过均 0；全部门禁异步警告 0；`git diff --check` 通过 |

最终日志 `%TEMP%/dsh-twentyfourth-final-gates-706c7888-3fe1-41b7-9d7a-5d9169a8e9f8/summary.json`。新增 **7 个回归**；没有正式模型调用，没有结束测试进程，未把局部 30s 诊断截止导致的取消写成通过。

正式重载前核验旧 PID **65672** 完整命令/可执行文件、3080 listener，409 sessions、无 running/waiting。只重启已确认服务。新 PID **54588**，认证交换 **303**、健康 **HTTP 200**，listener owner 一致；重查仍 409 sessions，无 running/waiting。

复用 Playwright `dsh-recovery-20261005`，标题 **DeepSeek Harness**。唯一 console 错误仍为 wallpaper-engine 背景音频 **404**，无 workflow 错误；未改该插件。receipt `%TEMP%/dsh-twentyfourth-reload-receipt.json` 保存新旧 PID 及 workflow/App Server/Planner/ReviewExecution/SubmissionExecution 构建 SHA256，token/cookie/旧聊天未输出。

本轮关闭了已确认的 Reviewer 参数漂移和 Bridge 最终进度/外层 fence 清理问题。未知上游默认选择、其他嵌套 callback 进度与真实故障 UI 验收的边界保持明确，历史 corrupt 未迁移。变更留在工作区，未 commit/push/publish，持续优化目标保持 active。
