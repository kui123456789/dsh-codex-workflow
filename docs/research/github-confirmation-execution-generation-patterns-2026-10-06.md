# 成功确认与缓存结果必须限定原执行代次

核验日期：2026-10-06。通过 Agent Reach GitHub／gh 后端读取公开固定源码和官方测试；Context7 执行 resolve-library-id → query-docs 校验 TanStack Query fetch/cancelRefetch 与 etcd CREATE 事务比较语义。研究阶段未修改仓库源码或测试，未调用模型、执行上游测试／服务、添加依赖或操作正式 DSH；本报告随后整理进 docs/research/。CodeGraph 已先尝试，明确返回本仓库没有可用索引，未初始化。

## 问题与采用原则

相同 workflowId/threadId/turnId 文本只能说明请求的地址，不足以证明产生成功确认或缓存结果的是当前执行。旧成功 ACK 若跨 App Server 代次沿用，可能放行新回合、误释放仍在运行的 writer；成功 Promise 若按业务 key 无条件回收，也可能清掉同 key 的新执行。

本轮保持现有远端 ACK 与原资源恢复语义，将可信确认限定到创建该执行的运行句柄／代次；读取确认和做最终清理时都核对当前代次。同一真实运行允许复用成功确认；真实执行换代后不复用。SQL Manager 的协调 owner 接管不等于远端 App Server 执行换代，不能仅因前者变化就丢弃仍属于原远端句柄的确认。

## 固定来源

| 官方仓库 | 固定 SHA／提交时间 UTC | License | 采用点 |
|---|---|---|---|
| TanStack/query | d169ee87786c250ccc791f5b22c40141a489ec88／2026-10-05 17:38:27 | [MIT][q-license] | 同业务 key 内每次 fetch 保留独立 retryer 身份；旧 finally 只清原 retryer |
| etcd-io/etcd | 76d58e32b30d57a540821c9c5bbcb651fd89994c／2026-10-05 23:11:04 | [Apache-2.0][e-license] | key 必须结合创建 revision，写入和删除都在事务内复核原身份 |

本文新增的精确失败／重入测试证据与既有 observer-count／cache-remove 研究不同；没有引入框架依赖或建议迁移框架。

## TanStack Query：cache key 不等于每个 fetch 的身份

[创建 fetch][q-create]捕获当前 retryer 对象，await 该 retryer 的 start；[finally][q-finally]只有 this.#retryer === retryer 时才能设为 undefined。旧 fetch 成功后的同步 onSuccess 回调可以立即启动新 fetch，此时 business key 不变，但原 retryer 与新 retryer 不同。按 key 清理会破坏新 fetch。

**新增官方测试一。** [should release the retryer once its fetch has settled][q-settled-test]在 QueryCache.onSuccess 中重入 query.fetch()。它先捕获 firstPromise，第一次完成后明确断言 query.promise 仍存在且不等于 firstPromise；第二次完成后才为 undefined。这是成功完成 A → 同 key 新执行 B → A finally 的准确证据，不能用“回调成功了”授权清理 B。

**新增官方测试二。** [should not override fetching state when revert happens after new observer subscribes][q-revert-test]同 Query 先消费 signal、移除 observer1 并添加 observer2，再发起第二次 fetch。旧 promise1 必须以 CancelledError 拒绝；queryFn 调用两次，最后 data 必须是 data1。旧取消的 revert 不能覆盖新 fetch 状态。

[Retryer][q-retryer]的 pending/resolved/rejected 状态属于单个闭包；取消将该闭包置为 rejected，迟到 resolve/reject 检查自己的闭包状态。[silent cancel][q-silent]让旧 caller 接收当前新 fetch 的 Promise，代表客户端的显式共享语义；它不是“旧 ACK 对新远端执行仍有效”的依据，不能照搬本项目原线程恢复规则。

## etcd：相同 key 加原创建 revision 才能改写／删除

[ResumeElection][e-resume]显式接收原 leaderKey 与 leaderRev。[Proclaim][e-proclaim]在事务里比较 CreateRevision(leaderKey) == leaderRev，然后才写；比较失败返回 ErrElectionNotLeader。[Resign][e-resign]也用同一比较条件才删除，不因 key 文本相同就删除新领导者。etcd 的 API 文档明确 rev 是 key 创建 revision，可用于事务内验证 election ownership。

[官方 ResumeElection 控制测试][e-resume-test]通过当前 leader.Kvs[0].Key 与 CreateRevision 重建 election，再辞任与另选 candidate2。它证明恢复传递原身份的正例，不包含“伪造旧 revision 删除新 key”的负例；后一保护由上述固定事务源码支持，本文不宣称运行过该测试。

[官方 session restart 控制测试][e-session-test]显式复用原 lease，再创建新 Session 并 Campaign 成功。这说明本地 Session wrapper 变化不自动等于资源 generation 变化。但 etcd lease 是持久协调资源，本项目 ephemeral thread 只在当前 App Server 进程内有效，不能据此宣称插件重启后可恢复。

本地采用与 RED → GREEN 结果见 [第三十四轮迭代](../iterations/2026-10-06-thirtyfourth-cleanup-confirmation-generation.md)。本研究的上游来源不替代本地验收。

## 本项目的验证映射

| 条件 | 需要本项目自己的权威证据 |
|---|---|
| 相同真实 backend execution，多次检查相同原中断 | 一次可信 ACK 后后续调用仍复用确认；不重复模型调用／清理 |
| A 成功确认后，B 使用相同公开 workflow/thread/turn key，但真实 backend generation 已变化 | B 不可读 A 的 receipt；必须获得 B 的确认／保留等待 |
| A 的迟到 ACK／finally 抵达，B 已合法注册 | A 的结果不能写入 B 的确认表；清理只针对 A 的真实句柄 |
| SQL Manager owner 更换，原 App Server 进程代次与执行句柄仍相同 | 保留原 ACK 的有效性；不能将协调 owner 变化误判为执行换代 |
| PID 值相同或 TTL 未到，但执行身份不相同 | 同 key 确认不可放行；PID 与时间不是执行授权身份 |

官方客户端内 Promise/Revision 机制不证明本项目原 RPC 已确认、process tree 已退出或真实 DSH UI 已验收。原模型权限／Schema 错误、ACK pending、process lost 与不可恢复标记仍须遵守现有终态／等待契约，不能因缓存 miss 静默创建替代 Planner／Reviewer。

## 采证说明

公开内容通过 gh api repos/.../contents/...?...ref=固定SHA 获取，base64 解码到 C:\Users\Z1803\AppData\Local\Temp\dsh-thirtyfourth-generation-research。License 文件及提交时间均已实际读取。Agent Reach Doctor 的 GitHub 状态为 warn（不自动写 device-id 验证），随后实际 gh API 返回固定源码，证明本次只读路径可用。agent-reach check-update 返回 v1.5.0 已最新。

Context7 的 /etcd-io/etcd 精确 Election 查询未命中；改选同次 resolve 返回的官方站点 /websites/etcd_io_v3_8，命中 CREATE Compare、Txn 原子分支及 LeaderKey.rev ownership 文档。TanStack /tanstack/query 命中 fetch、cancelRefetch 和 silent-cancel Promise 的接口边界。文档动态更新只辅助理解，永久引用均固定到上表 SHA。

[q-license]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/LICENSE
[q-create]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/query.ts#L839-L868
[q-finally]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/query.ts#L923-L928
[q-settled-test]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/__tests__/query.test.tsx#L544-L571
[q-revert-test]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/__tests__/query.test.tsx#L1354-L1401
[q-retryer]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/retryer.ts#L149-L204
[q-silent]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/query.ts#L890-L904
[e-license]: https://github.com/etcd-io/etcd/blob/76d58e32b30d57a540821c9c5bbcb651fd89994c/LICENSE
[e-resume]: https://github.com/etcd-io/etcd/blob/76d58e32b30d57a540821c9c5bbcb651fd89994c/client/v3/concurrency/election.go#L48-L56
[e-proclaim]: https://github.com/etcd-io/etcd/blob/76d58e32b30d57a540821c9c5bbcb651fd89994c/client/v3/concurrency/election.go#L109-L129
[e-resign]: https://github.com/etcd-io/etcd/blob/76d58e32b30d57a540821c9c5bbcb651fd89994c/client/v3/concurrency/election.go#L131-L145
[e-resume-test]: https://github.com/etcd-io/etcd/blob/76d58e32b30d57a540821c9c5bbcb651fd89994c/tests/integration/clientv3/concurrency/election_test.go#L53-L104
[e-session-test]: https://github.com/etcd-io/etcd/blob/76d58e32b30d57a540821c9c5bbcb651fd89994c/tests/integration/v3_election_test.go#L222-L255