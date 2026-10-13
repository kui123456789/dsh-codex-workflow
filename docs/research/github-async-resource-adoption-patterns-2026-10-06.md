# 异步资源创建后的接纳与清理归属核验

核验日期：2026-10-06。使用 Agent Reach 的 GitHub／`gh` 后端读取 CPython asyncio TaskGroup 与 Effect 的固定公开源码和测试。两例选取依据是创建动作可在归属登记前执行、以及成功获取到释放登记之间的取消窗口。本轮只借鉴机制，没有复制代码、引入框架依赖、修改源码/测试、调用模型或运行正式服务。

## 结论与固定来源

provider 的创建请求发出后，cancel/stop/owner 丢失不能证明副作用没有发生。原创建者应追踪未完成请求；句柄返回后先建立清理归属，再核查当前接纳条件，合法时转移给 workflow，否则释放同一返回资源。清理完成必须有独立的 awaited barrier，不能仅凭 cancelled/Closed 标记推断。

| 案例 | 固定提交 | 固定许可 |
|---|---|---|
| python/cpython | `dc0add3a65fc5de8f0ec8a687dccba435d52d97a` | [Python Software Foundation License Version 2][p-license]；固定 LICENSE 另列历史/内含软件许可，GitHub 元数据 NOASSERTION 未被当作许可结论 |
| Effect-TS/effect | `bd00773b252970e576ffe0cce17b84c10ce3c81f` | [MIT][e-license] |

两者为核验时 main 源码快照，提交时间分别为 2026-10-05 19:09:36 UTC 与 18:56:13 UTC；不据此推断稳定发行版或本机宿主行为。

## asyncio TaskGroup：创建后再检查退出状态

**Evidence。** [create_task][p-create] 在尚未进入、已结束或正在 abort 的 group 上关闭 coroutine 并拒绝创建。合法时调用 loop.create_task；随后登记原 task 到 `_tasks`、建立 done callback，再重新检查 `_aborting`，取消创建期间才进入 abort 的未完成 task。注释明确处理 eager task 在加入 `_tasks` 前取消 group 的情况。[eager start][p-eager] 确实可以在创建过程直接执行 coroutine。

[退出循环][p-exit] 在取消后持续等待 `_tasks` 为空，重复外部取消也不直接跳过等待；[_abort 与 done callback][p-done] 将 cancel 请求发给原 task，只有真实 done callback 才移除它。这是“已请求退出”与“已完成退出”的独立条件。

**Finding。** 上游 [创建期间取消测试][p-create-test] 覆盖 child 在首次挂起前取消 group，返回的原 task 最终 cancelled；[取消时等待 child finally][p-finally-test] 用 Event 阻塞 child 的 finally，再释放它，并验证外部取消仍正确传播。测试通过[普通与 eager 两种 loop factory][p-factories]运行同一 BaseTestTaskGroup。另有[拒绝已结束 group 并关闭 coroutine][p-closed-test]的检查。以上测试仅阅读，未在本地执行。

**Path 与边界。**

- 对异步 child provider，创建前检查只能挡住尚未发出的请求；返回后仍要核查 cancel/stop 和 owner，不能把开始时的合法状态当作永久许可。
- 先追踪原返回句柄并安排清理，再决定采用，才能覆盖创建期间 owner 已失效的窗口。
- [Task.cancel 实现说明][p-cancel]明确只是请求，coroutine 可延迟/拒绝取消，甚至返回值。已执行的副作用不会因此回滚；未结束 task 仍需原 owner 等待。
- TaskGroup 管理的是本地 Task，不自动管理 coroutine 返回的 DSH child、App Server thread 或其远端 writer；这些资源需要自己的 release 与中断确认。
- CPython 的拒绝路径关闭未启动 coroutine，不证明一个已经提交给外部 provider 的创建请求也能被撤销。

## Effect：成功获取必须连接到释放动作

**Evidence。** [acquireRelease][e-acquire] 默认在 uninterruptibleMask 内获取资源，再以返回的原 `a` 注册 release，捕获原 context。获取成功与释放登记不会被普通 interruption 切开；`interruptible:true` 则显式恢复获取过程的可中断性。

[safe scopeAddFinalizerExit][e-add] 若 scope 已 Closed，立即执行新 finalizer；否则登记到当前 scope。[scopeClose][e-close] 启动清理时保护其执行，[scopeCloseUnsafe][e-close-state]先把状态设 Closed、解除父归属，再处理 finalizers；重复关闭不重新启动同一集合。[finalizer 执行][e-finalize]顺序模式逐项等待，并行模式等待所有 finalizer fibers。

**Finding。** [acquireUseRelease interrupt 测试][e-bracket-test] 在延迟获取期间请求 interrupt，仍断言 acquired=true、use=false、release=true，且 release 收到原资源 123；[acquireRelease scoped 测试][e-acquire-test]也断言 interruption 后已运行 release。[Scope close 测试][e-close-test]在释放动作等待 Deferred 时取消关闭 fiber，先验证中断操作未完成，再释放 Deferred，最后检查两个 finalizer 各执行一次。另有[父 scope 关闭 child 仅一次][e-once-test]。以上测试只读，未执行；未找到并核实一个单测同时覆盖“外部 provider 迟到返回、owner 变化、closed scope 即刻释放”的完整场景，该边界由源码链支持。

**Path 与边界。**

- 成功获取句柄后必须立即拥有一个针对该句柄的 release；scope 已不接受资源时，迟到资源仍进入原创建者的清理路径。
- safe add 的 Closed 分支会执行 finalizer；不能把同结论套给 raw unsafe add，或任意 JavaScript Promise/finally。
- 默认 mask 可能推迟 cancellation；不应照搬为无限等待策略。`interruptible:true` 获取如果在产生句柄前中断，后续 release 尚未登记，部分外部副作用仍需 provider 自身保证回滚或可追踪。
- Closed 在清理运行前已写入；再次 close 的立即返回不能代替第一次清理 Promise 的完成。状态标记不证明远端 unsubscribe/interrupt ACK 或 writer 终止。
- Effect 保证的是其运行态内的归属与 finalizer 执行机制，不证明 DSH child 的 dispose 成功、不丢远端资源或跨进程恢复。

## 本项目的最小采用与验收方向

| 窗口 | 采用/归属动作 |
|---|---|
| 创建前 | 当前 owner、工作流相位、cancel/stop 与输入门禁通过后才发出创建请求 |
| 创建 pending | 原创建者保留 start Promise 的追踪；stop/cancel 标记失效，仍等待该请求 settle |
| provider 返回 | 立即为原句柄建立本地 cleanup owner；重新核查 owner/相位/取消状态后才转交并启动模型回合 |
| 已失去 owner 或 stopped | 不提交迟到句柄、不调用模型；创建者释放该原资源，await 清理完成 |
| 已采用或正在恢复 | 归属转移明确且比较同一运行对象；旧 finally 不能删除替代 owner，原未确认终止 pair 继续保留 |
| 创建 reject 或清理未确认 | 按 provider 契约区分“未创建”与“副作用未知”；报告原创建/清理状态，不假设 abort 等于回滚 |

本轮采用方向为 guard + await pending start tasks：stop 先禁止新接纳，再等待创建与原 owned 资源清理完成；不复制 Effect 的 mask 策略，也不把本地取消当模型 ACK。远端未知中断的资源归属规则继续遵守 [Codex unsubscribe 核验](github-review-entry-and-resource-ownership-2026-10-06.md)。

建议真实 provider 接纳路径配合可控 deferred 回归：创建暂停时 cancel、stop、owner 变更；随后返回唯一 child 句柄，断言模型回合为零、仅该原 child 被释放一次、stop 在 start settle/cleanup 前未完成。正常 adoption 后归属不重复；旧清理不删除替代运行；创建拒绝和清理拒绝仍可区分。计 raw dispose/pin/subscription 与模型调用，不用幂等包装隐藏重复清理。

这些是固定来源事实与本轮采用方向，不是当前生产实现、全部门禁或 DSH UI 已通过的声明。

[p-license]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/LICENSE
[e-license]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/LICENSE
[p-create]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/Lib/asyncio/taskgroups.py#L218-L250
[p-eager]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/Lib/asyncio/tasks.py#L256-L273
[p-exit]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/Lib/asyncio/taskgroups.py#L94-L142
[p-done]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/Lib/asyncio/taskgroups.py#L260-L274
[p-create-test]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/Lib/test/test_asyncio/test_taskgroups.py#L1190-L1199
[p-finally-test]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/Lib/test/test_asyncio/test_taskgroups.py#L1201-L1227
[p-factories]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/Lib/test/test_asyncio/test_taskgroups.py#L1369-L1377
[p-closed-test]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/Lib/test/test_asyncio/test_taskgroups.py#L858-L871
[p-cancel]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/Lib/asyncio/tasks.py#L192-L232
[e-acquire]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/src/internal/effect.ts#L4134-L4150
[e-add]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/src/internal/effect.ts#L4012-L4022
[e-close]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/src/internal/effect.ts#L3929-L3935
[e-close-state]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/src/internal/effect.ts#L3938-L3953
[e-finalize]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/src/internal/effect.ts#L3973-L3993
[e-bracket-test]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/test/Effect.test.ts#L317-L341
[e-acquire-test]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/test/Effect.test.ts#L1266-L1283
[e-close-test]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/test/Scope.test.ts#L20-L61
[e-once-test]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/test/Scope.test.ts#L184-L196

