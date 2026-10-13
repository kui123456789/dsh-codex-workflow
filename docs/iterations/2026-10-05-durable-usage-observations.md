# 2026-10-05：原线程用量持久化

接续[审查准入与超时预算](2026-10-05-review-admission-and-timeout-budgets.md)。实施依据为[固定提交的 OpenCode、Goose 与 Codex 机制核验](../research/github-usage-budget-patterns-2026-10-05.md)：覆盖同一来源的绝对值、原子保存汇总、将长期观测与可丢弃缓存分离。没有复制第三方实现或新增依赖。

## 原问题与改动

此前 `tokenUsage` 只存在于当前进程缓存，原线程解除订阅或进程退出后无法回查。新增 `workflow-usage.ts` 和 `WorkflowUsageObserver`，将已观测的原 Planner/Reviewer 快照原子写入已有工作流记录的可选 `observedUsage` 字段，不新增数据库表或改变旧记录的业务相位。

| 边界 | 当前行为 |
|---|---|
| 同线程累计 `100 → 150 → 150` | 同一来源覆盖旧值，最终为 150，重复值不重写 revision/updatedAt |
| 独立原线程再报告 30 | 新增来源，已观测合计为 180 |
| 从未收到通知或缓存写入字段缺失 | 保持未知，不填零；摘要列出缺失/部分来源 |
| 计数倒退或非法快照 | 保留最后有效值，标记异常 |
| 多来源相加超过安全整数 | 省略溢出的合计字段并标记，不产生负数或伪零 |
| 同来源使用不同已知模型 | 删除单模型标签，标记 `modelMixed` |
| 完成、取消、停止和重新打开存储 | 已提交观测保留；业务相位和取消状态保持原有权限 |

## 统计契约

```json
{
  "version": 1,
  "source": "app_server",
  "scope": "observed_original_threads",
  "sources": [],
  "summary": {
    "observedSources": 0,
    "missingSources": 0,
    "partialSources": 0,
    "anomalousSources": 0
  }
}
```

每个绑定来源有随机 `sourceId`、阶段、可选模型和服务端 `total`/`last`。原始 App Server thread/turn ID 仅用于进程内关联，不写入观测记录。同线程继续沿用来源，新审查轮次新增来源。

`summary.total` 只汇总已经收到的原线程字段；缓存输入、推理输出是输入/输出的子集，不能再次加到总量。原线程上的归一和重写自然包含在其累计值中；独立 fork、CLI 操作和父 DSH 模型在范围外。`last` 是最后模型响应，未必覆盖整个回合。该字段不是完整 workflow 账单、价格估算或消费上限。

旧记录没有 `observedUsage` 时保持未知。旧 gateway 未实现用量订阅或快照查询仍可执行，绑定来源会记录缺失数据。

## 写入与清理

观察器接收合法服务器通知，使用原始 WorkflowStore 做 revision-CAS，只更新用量字段。这些写入不继承审查的判定写权限，也不能修改相位、审查次数、取消状态或提交身份。租约丢失之后收到的真实计量可以保存，旧执行者依旧不能回写判定。

前台规划/审查在运行之前绑定来源，后台 callback 在成功取得原 Reviewer 归属后绑定；外部任务、未取得归属的线程及内部 fork 不绑定。正常 Planner 完成也释放其原订阅，原生澄清等待继续保持已有线程。

清理先捕获最后快照，再等待串行写入排空后解除订阅；等待期间新到达的通知也要保存。真实回归覆盖 100、150、200 三次阻塞写，release 只有在 200 已提交后返回。stop 先解除监听，再排空已接纳观测。

存储故障保留原来源和待写快照，状态给出固定短诊断，不包含原始错误或上游数据，也不重跑模型。停止时仍失败会保留安全的进程内诊断和待重试数据；存储恢复后的显式 flush 可补写。进程崩溃或不可用存储仍可能丢失未提交观察，不能据已有合计声称整个消耗已完整记录。

## 晚通知与工具返回

真实客户端回归在业务提交后注入合法的晚通知：持久值已经从 240 增至 360，旧工具返回却仍为 240。成功入口现等待清理结束后的统计刷新，只补当前归属工作流的观测，不重跑任务、不改业务判定。刷新本身也纳入 foreground 等待，避免 stop 先关闭存储。

## 验证入口与范围

```powershell
pnpm exec tsx --test test/workflow-usage-store.test.ts
pnpm exec tsx --test test/durable-workflow-usage.test.ts test/callback-usage-hooks.test.ts
pnpm verify
pnpm release:check
pnpm release:check
pnpm host:check
pnpm host:recovery:check
git diff --check
```

测试使用真正的 App Server client、WorkflowManager、SQLite Store 与 callback dispatcher，传输来自隔离本地协议子进程。样本验证完成 Planner/Reviewer 各 240 tokens、同线程恢复最终 480、新审查两个来源合计 480，而独立对齐线程的 12000 不并入原线程。所有数字均为测试数据，不是用户实际调用或节省量。

未启动正式 DSH 或调用真实外部模型；正式界面和真实模型验收仍是独立待办。消费上限也尚未启用，本轮提供后续控制所需的可核查观测。

## 门禁中发现的测试问题

既有故障回归曾按“第几次 Store.update”注入业务失败；增加独立统计写入后，这个计数不再指向目标。测试改为在真实 CAS mutation 内比较业务字段变化，mutation 只执行一次，并新增统计写入故障与回合注册故障互不吞掉的验证。清理断言以 Planner 完成后的基线隔离审查资源。

完整并行运行暴露原心跳测试的 300 毫秒租约与真实等待敏感性，隔离运行通过。该测试改用受控 Date/setInterval，保留真实异步处理器和 SQLite；在处理器挂起时，跨越原 TTL 并确认实际心跳刷新，移除心跳后相同推进令会话过期。未提高 TTL 或延长等待。

模拟计时器的清理又在整套桥接测试中暴露全局函数污染：逐个 restore 没有移除 MockTracker 的注册记录，自动清理会重新恢复已失效的模拟函数。现先 reset/disassociate mock 记录，再重置计时器；验证 Date 和计时器函数的原始身份在后续测试仍保持。桥接完整 48/48 与三个相关测试 3/3 均通过。生产桥接源码没有改动。

## 最终门禁结果

| 检查 | 本轮实测 |
|---|---|
| `pnpm verify` | 类型检查与构建通过；599/599 tests，失败 0，用时 45.30 秒 |
| `pnpm release:check` | 连续两次 `RELEASE_CHECK_OK`，各自 599/599；离线 Doctor 正常、5 项明确 SKIPPED；打包审计通过且临时包已清理 |
| `pnpm host:check` | DSH 0.1.7-rc.2；9 个工具注册/卸载，peer 与原生 sidebar 契约通过 |
| `pnpm host:recovery:check` | 原线程、原 child 的四个场景通过；等待和继续保持身份、消息可重放、未完成工具为 0 |
| `git diff --check` | 通过 |

新增 37 个回归：观测存储 16、真实客户端持久集成 12、callback 生命周期钩子 7，以及统计/业务故障隔离与异步刷新后的归属重查各 1。已有心跳与清理故障断言的调整保持原风险覆盖。

最终日志位于系统 Temp：`dsh-fifth-final-verify-20261005.log`、`dsh-fifth-release-20261005-1.log`、`dsh-fifth-release-20261005-2.log`、`dsh-fifth-host-20261005.log`、`dsh-fifth-host-recovery-20261005.log`。没有提交、推送、发布或修改正式 profile；既有未提交改动保留。

持续优化目标保持进行中，后续消费控制须基于这个明确范围与未知数据策略，不能直接把有限观测当作完整计费上限。
