# 第二十六轮：审查心跳定时器归属

## 已复现的缺陷

第二十五轮冻结验收期间，隔离探针使用同一个真实 WorkflowManager：撤销 A 的实际 SQL submission lease，再通过公开 `recoverCallbacks()` 取得 B 的新 generation。B callback 仍被持有、sending/running，实际 SQL lease 仍归 B。两条旧 A 路径都会删掉 B 的 exact timer：

- A 的 heartbeat mark 被持有，B 注册新 timer 后再释放 A；原 mark 被权限 guard 拒绝，但 interval catch 按 workflowId 停止当前 B timer。
- A 的 callback 返回后，旧 background finalizer 按 workflowId 停止当前 B timer。

两条探针都得到 `successorTimerPresent=false`、`exactSuccessorTimerPreserved=false`。证据是 `%TEMP%/dsh-review-heartbeat-owner-probe-20261006.log`；临时探针源码已删除，隔离 SQLite 资源已清理。确认范围仅为旧任务停止新任务的进度心跳，没有证明 B 模型被取消。

## 修复与验证范围

本轮以 exact timer 归属为边界：清理自身定时器与按 workflow 取消当前定时器需有不同入口。并行审计还要求核验 guarded finish、stale 快照返回和 startup 返回屏障，避免只修 callback finally 后仍从另一条异步路径停止新 timer。取消、插件 stop 和正常结束的资源清理必须保留。

`test/review-heartbeat-registration.test.ts` 已在未修复源码运行 **4 红/1 正向绿**：旧 scope 注册不能替换 B；携带 A timer 的 guarded finish 不能停止 B；实际 SQLite 更新被持有后，新时间戳与同时间戳两种 B 接管都不能被旧 stale probe 写状态、改 revision 或停止心跳。正常 current stale 提交一次并释放自己的 timer 是正向控制。日志 `%TEMP%/dsh-twentysixth-heartbeat-registration-red.log`，不是先修源码后补的绿色测试。

固定来源见 [注册归属研究](../research/github-heartbeat-registration-ownership-patterns-2026-10-06.md)：Node 原 list 对象与当前注册对象相等才删除的机制直接对应同 key 替换；XState 的 actor scope 仅作为原 owner 参与取消的参考，不外推同 actor 重注册保护。没有增加依赖、复制上游代码或声称运行了上游测试。

## 实施

- 保留原 `Map<string, Timeout>`，`startHeartbeat` 返回原 timer，替换前同步核验当前 record 与 admission guard；旧 interval catch 只清其闭包里的 timer。
- `stopHeartbeat(id, timer)` 清传入 timer，仅在 registry 仍指向它时删除；undefined 是无资源，不是按 workflow 清理的通配权限。显式取消使用 `stopCurrentHeartbeat`，插件 stop 阻止新启动后清全部 timer，任务清理后再兜底。
- `begin` 的 timer 创建移至前台与 Bridge 两个调用者：前台先更新合法 reviewing phase/attempt 再接纳心跳，避免拒绝自己的正常启动。前台与后台最终收尾都保存并清原 timer。
- Bridge queued timer 随后台任务转移，run 尚未进入 try 的加载失败也由任务最终清理负责；未转移的 startup failure 清原 queued timer。
- `refreshStale` 核真实 row revision、运行状态、时间戳和调用前捕获的 timer；旧观察通过专用错误回滚并返回事务实际 record。普通错误仍传播；真正 stale 提交一次才停自己的 timer。

没有新增 runtime 表、generation 字段或第三方依赖。第二十五轮的生产源码保存在 `%TEMP%/dsh-twentysixth-production-baseline`，本轮五文件差异已独立复核。

## 回归验证

同 manager 实际 SQL A/B 两条回归先运行 **2/2 红**，原 row/revision/events 不变、B 仍持有真实 lease/模型未返回、没有额外模型/取消、B 随后 received/queue=1/timer=0/cycle=1 等断言已通过，最后才报告捕获到 B timer 被删除。日志 `%TEMP%/dsh-bridge-heartbeat-ownership-red-20261006.log`。

修复后独立边界组合 **5/5**，日志 `%TEMP%/dsh-twentysixth-registration-independent-green.log`。源码作者的新增/启动/恢复/取消/停止目标组合 **57/57**、类型检查通过；生产随后冻结。

真实 A/B 补充修后正向：先断言旧 action 没改 row/events，再释放并 drain 已持有 B ticks，等待之后真正新注册周期触发的 B tick。B callback 继续被持有，实际 SQLite revision 与原 parent running progress 都增加，原 SQL lease 仍有效。避免仅 Map 同对象却 interval 已被清掉的假绿；30s 是测试死锁上限，生产 timeout 没变。此新增正向首次执行在修后源码，不冒领旧源码红例。

主任务独立执行最新 A/B 2、registration 5、辅助 pin 2、owned final phase 1 合计 **10/10**，类型检查通过，日志 `%TEMP%/dsh-twentysixth-new-independent.log`。

```powershell
pnpm exec tsx --test --test-concurrency=4 test/bridge-heartbeat-ownership.test.ts test/review-heartbeat-registration.test.ts test/bridge-auxiliary-pin.test.ts test/bridge-owned-final-phase.test.ts
```

## 最终门禁与正式重载

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 901/901，157.18s，异步警告 0 |
| `pnpm release:check` 第一次 | 901/901，185.75s，离线 doctor 与打包检查通过，异步警告 0 |
| `pnpm release:check` 第二次 | 901/901，228.90s，离线 doctor 与打包检查通过，异步警告 0 |
| `pnpm host:check` | 安装版宿主检查 ok，退出 0 |
| `pnpm host:recovery:check` | 11 个本地故障/恢复场景通过，退出 0 |
| `git diff --check` | 退出 0 |

完整结果 `%TEMP%/dsh-twentysixth-final-gates-01af5d9b-99c9-4513-b57a-a944ab20da5a/summary.json`。第二十五轮最初失败及修后的成功门禁都保留，未覆盖或冒领。

重载前再次核验 PID 54588 的可执行文件、global DSH entry、命令与 3080 listener，runningIds=[]、waitingWorkflowCount=0。第二十五轮未单独重载，本次统一载入第二十五/二十六轮构建。重载后：

- 新 PID **64788**，旧 PID 已退出；127.0.0.1:3080 listener 归新进程，认证 HTTP **200**。
- installed DSH **0.1.7-rc.2**，web profile 的 plugin Junction 仍指向本仓库，没有改 profile 或历史会话。
- 会话总数仍 **409**，runningIds=[]、waitingWorkflowCount=0。
- 复用 `dsh-recovery-20261005` 浏览器，加载新私有认证 state 后页面标题为 **DeepSeek Harness**；唯一 console error 是既有 wallpaper-engine 背景音频 404，warnings=0。
- `%TEMP%/dsh-twentysixth-reload-receipt.json` 记录新旧 PID 及 workflow、App Server、Planner、ReviewObservation、SubmissionExecution、ReviewExecution 构建 SHA256；认证/日志保留在私有 TEMP 文件，未输出 token、cookie 或聊天内容。

没有正式上游模型调用，宿主故障注入不是实际模型失败 UI 的验收替代；旧 corrupt 日志未迁移。本轮没有 commit、push 或发布，持续迭代目标保持 active。
