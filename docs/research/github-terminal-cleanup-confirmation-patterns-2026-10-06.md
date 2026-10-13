# 终止错误后的资源清理确认边界

核验日期：2026-10-06。使用 Agent Reach 的 GitHub／`gh` 后端读取官方固定源码和测试，以 docs-generator 的 Evidence → Finding → Path 结构整理。本文新增 RxJS 与 Node 两组证据；CPython 仅复用已有固定来源补充主错误与清理错误的区分。没有复制上游代码、增加依赖、运行上游测试、调用模型或操作正式 DSH。

## 结论与固定来源

解除订阅、关闭本地显示句柄、设置 disposed/destroyed，均不能单独证明原模型 writer 已结束。终止性的显示／Schema／权限错误仍是终止错误；如果当时存在未结束的原 turn，创建者须保留同一 pair 的清理归属，等待原 turn 的终止确认后才释放。清理失败不能覆盖原业务错误，更不能将终止错误转换成模型 continuation。

| 官方案例 | 固定提交／版本 | 固定许可 |
|---|---|---|
| ReactiveX/rxjs | `e5351d02e225e275ac0e497c7b66eaa5f0c88791`，7.8.2，2025-02-22 02:56:46 UTC | [Apache-2.0][r-license] |
| nodejs/node | `fcfb7ecc0ba1199eb336877f2e652bcb21e867be`，main 快照，2026-10-06 05:55:47 UTC | [Node 核心 MIT 文本][n-license]；同 LICENSE 列出内含组件许可 |
| python/cpython，已有来源补证 | `dc0add3a65fc5de8f0ec8a687dccba435d52d97a` | [PSF License Version 2 与历史／组件许可][p-license] |

Context7 已执行 RxJS resolve → query，以及指定 7.8.2 的 query；结果混入当前 master 的 RxJS 9 API，因此没有据其转用 AbortSignal／addTeardown。Node resolve → query 查到 asyncDispose 的 finished Promise 与 destroyOnReturn；以下结论以固定源码为准。版本／main 快照不能代替本机运行态证明。

## RxJS：from(Promise) 退订只阻止投递

**Evidence。** [fromPromise L84-L98][r-promise] 注册 Promise.then；成功回调检查 subscriber.closed 后发送 next/complete，没有返回用于取消该 Promise 的 teardown。[Subscription L47-L51][r-closed] 在 finalizer 执行前设置 closed；[L66-L94][r-finalizers] 同步执行 finalizer 并收集异常，签名为 void，没有等待外部异步清理 Promise 的契约。

**Finding。** 官方 [from-promise test L132-L147][r-test] 创建已 resolved Promise，立即 unsubscribe，随后断言 next/error/complete 都未调用。这只验证消息抑制，不验证外部执行被取消、任何远端 ACK 或副作用回滚。源代码亦没有调用 Promise cancel 的路径。

**Path 与边界。** 关闭 DSH child 的事件投递可以保证迟到消息不再写 UI；这不是停止隐藏 App Server turn 的动作。RxJS 允许自定义 teardown 释放本地资源，但调用者必须另有真实取消 API 和完成确认。不要迁移 RxJS 依赖，也不要把 closed 当作“取消已完成”。

## Node：destroyed、iterator return、异步 dispose 是不同证明

**Evidence。** [destroy L67-L87][n-destroy] 先置 destroyed，再执行 _destroy；[_destroy L93-L125][n-closed] 要等原 callback 才置 closed 并调度 error/close。因此 destroyed 为 true 时底层异步清理可以仍在进行。当前 [async iterator finalize L1611-L1622][n-finalize] 触发 destroy 或解除监听；[processReturn L1720-L1729][n-return] 随即 resolve，未等待 _destroy callback 或 close。

另一个 API 的 [Symbol.asyncDispose L398-L405][n-dispose] 调用 destroy 后 await eos；只吸收本次释放自己生成的同一 AbortError，不用字符串吞掉其它错误。

**Finding。** 官方 [iterator tests L742-L769][n-iterator-test] 验证 destroyOnReturn=true 提前退出会 destroy；false 会保留 stream 继续读。它们断言 destroyed，不等于证明外部远程执行退出。官方 [dispose test L7-L22][n-dispose-test] 检查 close/error 事件与 dispose Promise 完成；该测试没有使用被 deferred 阻塞的 _destroy，因此“等待异步 callback”的链主要由源码支持，未宣称单测完整覆盖这个窗口。上游测试仅阅读，未执行。

**Path 与边界。** 本仓库的 child.finish、subscription dispose 与 thread/unsubscribe 是本地／订阅动作。原 App Server thread/turn 的 interrupt ACK 或已核实终态才解除 writer 屏障。不能简单更换为 for-await return 或 asyncDispose 后宣称已解决远程取消；Node 只管理它自己的 stream 契约。

## 复用 CPython：退出等待与错误信息分别保留

已有 [TaskGroup 研究](github-async-resource-adoption-patterns-2026-10-06.md)解释了取消只是请求。本次补看 [退出循环 L115-L142][p-wait]：重复取消不会绕过 tasks 为空的等待；[L183-L210][p-errors] 将 body 错误加入 task 错误集合，再构造 ExceptionGroup。[test_taskgroup_20a L588-L609][p-errors-test] 用 task 的 ZeroDivisionError 加 body finally 的 MyBaseExc，明确断言两者均保留。

采用其“先等待原任务退出，保留多个来源的异常”纪律；不复制 ExceptionGroup 或 KeyboardInterrupt 的特殊优先规则。对本项目，原 contract/schema/nativeInput 错误应保持原分类和诊断；cleanup error 作为独立诊断及未确认清理状态，不替换原 cause、也不触发模型自动继续。

## 本项目研究时观察与采用方向

研究时读取 [planner-execution.ts](../../src/application/planner-execution.ts) 的 terminal catch/finally：业务写 failed 后，未 retained 分支清 activeTurn、dispose child、releasePlannerThread。[workflow.ts](../../src/workflow.ts) 的 normalization 收到 needs_input 时报告 unexpected user input；这个结果仍带原开放的 native input turn。releaseUnboundReviewer 走 subscription/hold release，不能凭其完成推出原 writer 已结束。此观察是研究时快照，最终源码与验收以迭代记录为准。

已有 [Codex 固定上游测试](github-review-entry-and-resource-ownership-2026-10-06.md#补充核验codex-退订不确认回合终止)直接覆盖退订成功而回合仍运行，本次不再重复抓取。

| 窗口 | 本轮采用／验收方向 |
|---|---|
| terminal error 且原 turn 未完成 | 保留原 threadId/turnId、child、pin 与创建者清理归属；请求精确原 pair interrupt |
| ACK 未确认／cleanup 拒绝 | 保留原主错误和独立 cleanup 诊断；阻止新模型及替代 Planner/child |
| 再次公开操作、cancel、stop | 仅重试该原 pair 的清理；并发调用共享一次实际清理，不凭本地 disposed 推断完成 |
| ACK／可验证终态已确认 | 只释放本次拥有的原句柄一次；终止错误不发送 continuation |
| 本来合法的 native clarification | 按原有 pendingInput 恢复；不要误把正常 waiting_input 当 terminal cleanup |

建议真实协议＋native DSH child 回归：normalization unexpected native input；ACK deferred / false 后原 writer 仍活；重复 resume/start/cancel/stop 不新建；确认后仅清理原 pair；primary error 与 child.dispose / unsubscribe 拒绝同时存在时均可诊断；并发清理 raw interrupt/dispose/unsubscribe 只算一次。比较同 thread/turn/child 身份，计模型和子会话创建数，观察实际 writer。源码建议不是完整门禁或正式 DSH 已验证的声明。

## 只读复核方法

以下 PowerShell 读取固定内容，适用于上表任一路径；需可用 gh GitHub 只读访问，不运行上游测试：

```powershell
$researchSource = gh api 'repos/ReactiveX/rxjs/contents/src/internal/observable/innerFrom.ts?ref=e5351d02e225e275ac0e497c7b66eaa5f0c88791' | ConvertFrom-Json
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($researchSource.content))
```

[r-license]: https://github.com/ReactiveX/rxjs/blob/e5351d02e225e275ac0e497c7b66eaa5f0c88791/LICENSE.txt
[r-promise]: https://github.com/ReactiveX/rxjs/blob/e5351d02e225e275ac0e497c7b66eaa5f0c88791/src/internal/observable/innerFrom.ts#L84-L98
[r-closed]: https://github.com/ReactiveX/rxjs/blob/e5351d02e225e275ac0e497c7b66eaa5f0c88791/src/internal/Subscription.ts#L47-L51
[r-finalizers]: https://github.com/ReactiveX/rxjs/blob/e5351d02e225e275ac0e497c7b66eaa5f0c88791/src/internal/Subscription.ts#L66-L94
[r-test]: https://github.com/ReactiveX/rxjs/blob/e5351d02e225e275ac0e497c7b66eaa5f0c88791/spec/observables/from-promise-spec.ts#L132-L147
[n-license]: https://github.com/nodejs/node/blob/fcfb7ecc0ba1199eb336877f2e652bcb21e867be/LICENSE
[n-destroy]: https://github.com/nodejs/node/blob/fcfb7ecc0ba1199eb336877f2e652bcb21e867be/lib/internal/streams/destroy.js#L67-L87
[n-closed]: https://github.com/nodejs/node/blob/fcfb7ecc0ba1199eb336877f2e652bcb21e867be/lib/internal/streams/destroy.js#L93-L125
[n-finalize]: https://github.com/nodejs/node/blob/fcfb7ecc0ba1199eb336877f2e652bcb21e867be/lib/internal/streams/readable.js#L1611-L1622
[n-return]: https://github.com/nodejs/node/blob/fcfb7ecc0ba1199eb336877f2e652bcb21e867be/lib/internal/streams/readable.js#L1720-L1729
[n-dispose]: https://github.com/nodejs/node/blob/fcfb7ecc0ba1199eb336877f2e652bcb21e867be/lib/internal/streams/readable.js#L398-L405
[n-iterator-test]: https://github.com/nodejs/node/blob/fcfb7ecc0ba1199eb336877f2e652bcb21e867be/test/parallel/test-stream-readable-async-iterators.js#L742-L769
[n-dispose-test]: https://github.com/nodejs/node/blob/fcfb7ecc0ba1199eb336877f2e652bcb21e867be/test/parallel/test-stream-readable-dispose.js#L7-L22
[p-license]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/LICENSE
[p-wait]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/Lib/asyncio/taskgroups.py#L115-L142
[p-errors]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/Lib/asyncio/taskgroups.py#L183-L210
[p-errors-test]: https://github.com/python/cpython/blob/dc0add3a65fc5de8f0ec8a687dccba435d52d97a/Lib/test/test_asyncio/test_taskgroups.py#L588-L609
