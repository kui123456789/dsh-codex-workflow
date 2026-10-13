# 共享工作流 operation 的 consumer 与资源清理归属核验

核验日期：2026-10-06。通过已读 Agent Reach GitHub／`gh` 路线核验 TanStack Query 与 Effect RcMap 的固定源码、许可和测试。接口文档按 Context7 查询；机制结论以固定代码/测试为准。本文由既有 TEMP 笔记整理，没有新抓取、运行上游测试、修改其它文件、调用模型或操作正式 DSH。

## 本地背景与研究范围

本研究开始时，已只读 AppServer callback send/cancel 路径并与两审计 agent 协调：flight 按 workflowId:submissionId + requestSignature 共享 task；第二 send 直接返回原 task，没有独立 lease consumer 登记；旧 lease 的取消/收尾可能作用于共同 controller 与同 raw child。

主任务随后报告两项真实 RED 已确认，路径包含 native 服务、真实 CodexAppServerClient/本地协议进程、同 flight/retained thread 和同 child。本研究没有重新执行这些本地 probe；具体断言与修复验证由主任务迭代记录归档，不把上游来源写成项目修复已经通过的证明。

## 固定来源与许可

| 来源 | 固定提交 | 许可 | 借鉴范围 |
|---|---|---|---|
| TanStack/query | `d169ee87786c250ccc791f5b22c40141a489ec88` | [MIT][q-license] | observer 的独立接纳/退出、公共请求生命周期、旧注册清理 |
| Effect-TS/effect | `bd00773b252970e576ffe0cce17b84c10ce3c81f` | [MIT][e-license] | pending acquisition 共享、caller scope 引用与原 entry 清理 |

不引入框架依赖或复制代码。Effect 的 Context7 查询未命中 RcMap 专题，普通 Scope/fork 说明没有被用来替代 RcMap 固定源码。

## TanStack Query：移除原 observer，不直接取消公共 operation

**Evidence。** [Query.fetch][q-flight]对合法 in-flight retryer 返回公共 promise；显式 cancelRefetch 另行处理。[add/remove observer][q-observer]按 observer 实例登记/移除，不存在的实例为 no-op；只有 observers 为空才考虑 cancel/cancelRetry 与 GC。是否真正 abort 还取决于 transport 是否消费 signal 等条件。

[QueryCache.remove][q-remove]只有当前 Query 对象 === 请求清理的 Query 才 destroy/delete/通知。旧同 hash 对象不能删除新注册；因此“相同业务 key”与“同一有清理权的注册”分开判断。

**Finding。** 官方测试覆盖 [observer 计数 3→2→1→0][q-count-test]、[A 在 update 期间 unsubscribe，B 仍收结果][q-remaining-test]、[旧同 key Query remove 对新 Query 无效且不通知][q-replace-test]，以及[两个订阅者、queryFn 一次][q-shared-test]。均已阅读，未运行。

**边界。**

- 这些测试不是 SQL lease generation 接管、模型仍运行时旧 consumer abort 的完整案例；pending fetch 保留其它 observer 的取消条件由源码支持。
- 显式 Query.cancel/整个 cache 管理操作可以取消公共请求，不等于 observer unsubscribe。旧 SQL lease 退出不能据此获得全 operation 取消权。
- query key 还需应用核输入等价/权限；observer 数量不验证 SQL owner。公共 promise 相同没有自动转移 callback/signal 权限。

## Effect RcMap：共享 pending Deferred，每个 caller 保留原 entry

**Evidence。** [RcMap.get][e-get]让同 key 共享原 entry/Deferred，但每次 get 都 refCount++，在 caller Scope 登记捕获原 entry 的 release finalizer，再 await 公共 Deferred。底层 lookup 在独立 entry.scope 运行。

[release][e-release]只减原 entry 的引用，仍有引用则不 close；原 entry 不再是当前 map 项时，只 close 原 entry、不删新 entry。TTL 清理同样比较原 entry 与当前项。[removeInterrupted][e-interrupted]也只在 map 当前项仍为原 entry 时移除，仍有 borrowers 时由各 scope 负责释放。

**Finding。** 官方 [ready borrower 交接测试][e-ready-test]关闭原 owner scope 后 released=0，borrower 关闭后才为 1。[共享 in-flight 测试][e-pending-test]在 Deferred 阻塞时 refs=2、共享结果；释放 gate 后旧 owner 关闭不释放资源，borrower 关闭才释放一次。[原 generation 不移除新 generation 测试][e-generation-test]同 key invalidation 后新值为 2；旧 scope 关闭只释放值 1，map 仍有新 entry。均已阅读，未运行。

**边界。**

- in-flight 测试关闭原 scope 发生于 Deferred 完成后，不直接证明 pending acquisition 中取消 A、B 继续的全部时序。
- RcMap owner scope 关闭是全资源 teardown，不能作为旧 SQL consumer 的 detach；底层共享 operation 的 scope 应独立于其中一个临时 consumer。
- invalidate 允许未来 get 创建新 acquisition，不能迁移成失败时替代原模型线程。
- RcMap 不提供 SQL lease/业务 scope 授权，也不等于 App Server interrupt ACK。

## 本项目必须分别维护的三层身份

| 层 | 归属与取消原则 |
|---|---|
| shared model operation | 原 thread/turn/subscription/pin、input signature；一次实际模型回合只创建/释放一次 |
| lease consumer registration | 每个参与者的原 owner/token/epoch 与独立 registration；旧 lease 只能退出自身，不能按共同 key 取消新 consumer |
| native child UI/resource | 同 raw child 可从 A 转给 B；raw handle 相等或 WeakSet 幂等不能证明 A 仍有 finish/dispose 权限，须核当前 owner registration 或合法保留引用 |

合法 B 必须先被接纳为 consumer 再等待公共 operation；只返回原 task 不足以证明 adoption。原 A signal/callback 与 cleanup 仍需 fencing；progress/result 提交权由当前 lease 决定，不以资源引用数替代。用户明确 workflow cancel/manager stop 的全操作权限与旧 lease onLost 分开。

最小核验应使用同 dispatcher、同 native SubagentRuntime/child、实际 SQL A/B lease 接管，再触发 A onLost/catch/finally。断言 B仍持有同 thread/child、公共模型不新 start、A不能 interrupt/dispose/finish B，B取得原结果且完成；最后当前授权清理一次。不用两个独立 fake callback 或只看最终 threadRefs 数量代替跨 consumer 安全验证。

关联边界见 [timer 注册归属](github-heartbeat-registration-ownership-patterns-2026-10-06.md)、[嵌套进度 fencing](github-nested-workflow-progress-fencing-2026-10-06.md)与[恢复身份 fencing](github-resume-identity-fencing-patterns-2026-10-06.md)。本地 RED 背景不代表生产修复完成、完整门禁或真实模型 UI 已验收。

[q-license]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/LICENSE
[e-license]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/LICENSE
[q-flight]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/query.ts#L708-L723
[q-observer]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/query.ts#L612-L653
[q-remove]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/queryCache.ts#L235-L242
[q-count-test]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/__tests__/query.test.tsx#L688-L711
[q-remaining-test]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/__tests__/query.test.tsx#L849-L866
[q-replace-test]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/__tests__/queryCache.test.tsx#L422-L440
[q-shared-test]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/__tests__/queryObserver.test.tsx#L823-L846
[e-get]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/src/RcMap.ts#L334-L388
[e-release]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/src/RcMap.ts#L481-L519
[e-interrupted]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/src/RcMap.ts#L458-L473
[e-ready-test]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/test/RcMap.test.ts#L163-L185
[e-pending-test]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/test/RcMap.test.ts#L188-L223
[e-generation-test]: https://github.com/Effect-TS/effect/blob/bd00773b252970e576ffe0cce17b84c10ce3c81f/packages/effect/test/RcMap.test.ts#L55-L99

