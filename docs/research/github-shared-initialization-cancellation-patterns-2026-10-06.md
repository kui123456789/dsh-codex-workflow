# Shared initialization 的消费者取消与资源生命周期

核验日期：2026-10-06。通过 Agent Reach GitHub／gh 路线读取两个成熟实现的固定源码、MIT License和官方测试；未执行上游tests／服务、添加依赖、修改业务源码、调用模型或操作正式DSH79432。本轮Doctor原句柄26533已正常完成；GitHub仍为warn（不写device-id认证探测），实际gh API读取成功。

## 要解决的接口边界

共享initialize／operation不能直接采用第一个caller的signal。每个consumer自己的取消应立即结束自己的wait并清自己的监听器；只要B仍在等待，A不能中断共享握手或清B需要的资源。共享operation使用独立controller／lifecycle signal；全部等待者退出或宿主stop时，才进入该operation自己的中断与原资源清理。

这里研究已有共享初始化的所有权，不把第36轮modelCatalog／selection缓存改造成新的singleflight。成功初始化之后，server如何保留与idle/pin如何释放继续由SDK生命周期决定，不能把某个consumer正常完成误当作全部共享资源撤回。

## 固定来源

| 官方仓库 | 固定SHA／提交时间UTC | License | 可采用的最小机制 |
|---|---|---|---|
| microsoft/vscode | 7b0ccc7c006b52b7a30aa2c9190ac3e99c81807a／2026-10-06 09:49:21 | [MIT][v-license] | 独立operation token，所有consumer取消后才cancel；每个wait wrapper独立race |
| Effect-TS/effect | 6c59de782b9c5b5cdb53fcde0455984bbfd9ff63／2026-10-06 09:43:27 | [MIT][e-license] | detached acquisition fiber、awaiters计数、last撤回先detach、owner scope关闭 |

## VS Code：自己的wait与共享token分开

[CancellationTokenPool][v-pool]创建自己的CancellationTokenSource，记录added／cancelled数量。只有total > 0且total === cancelled时才cancel这个独立source。一次consumer cancel只更新自己的计数和监听器，不直接把最早caller的token作为共享operation token。

官方[三个consumer控制测试][v-pool-test]依次cancel source1、source2时pool仍未取消；source3取消后才变true。官方[已经取消后加入][v-late-test]说明pool一旦done就不再接纳新token：一个已撤回的初始化不能因为后续B进来而复活，后续请求须遵守自己的新operation接纳和原清理完成条件。

[observer wait包装][v-race]只订阅传入token，取消时结束这个wrapper，原promise完成／失败时清该wrapper listener；没有调用原promise.cancel。raceCancellationError仅对自己的等待抛CancellationError。官方[raceCancellation测试][v-race-test]取消waiter token后wrapper先返回，并且另外持有inner timeout token进行独立清理。

边界：CancellationTokenPool不是带resource refcount的初始化器，也没有consumer成功后remove／借用scope接口；pool.dispose只dispose listener/source，不能当作远端writer终止ACK。该race测试随后明确取消inner timeout，没有证明未取消的B最终成功。共享资源生命周期和本项目原RPC仍需另行核验。

## Effect RcRef：获取任务不属于首个等待者

[getState][e-acquire]第一次get创建Acquiring记录，首个caller算awaiters=1，后续get增加awaiters。acquire在detached fiber中运行而不是fork到第一个caller的可取消fiber下。发布成功时还检查self.state === captured acquiring，避免被放弃／关闭的获取重新写成Acquired。

[awaitAcquiring][e-detach]让每个consumer join共享fiber，同时独立处理自己的退出。A退出而awaiters仍大于0时不interrupt共享获取。最后一个退出时先把活动state改Empty，再interrupt旧fiber，所以B不会join正在退出的初始化。若acquisition已发布引用但waiter还没注册finalizer就被中断，源码会释放该waiter的已计入引用。

[release][e-release]只在refCount归零时关闭资源scope或启动既有idleTTL；宿主[owner finalizer][e-owner]先把ref置Closed，随后关闭已获取资源或interrupt尚在获取的fiber。它区分consumer退出与owner关闭，不能用一条caller abort路径代替宿主stop。

已读的官方精确测试：

- [并发首个borrower共享同一generation][e-shared-test]使用Deferred阻塞原acquire，A/B都加入后释放；sameGeneration=true、acquired=1、released=1。
- [A中断不结束B共享获取，全部中断后新获取独立][e-cancel-test]先中断first，finalizer仍未开始；second中断后旧finalizer挂起，新get仍取得generation2。此测试验证last-detach顺序，不只比较数字refcount。
- [发布与waiter中断竞争][e-publish-test]在多个调度budget下中断已获计数但未完成handoff的waiter，acquired/released均为1，随后get可取得2，避免交接窗口泄漏。
- [宿主关闭pending acquisition][e-stop-test]等待acquire真实开始，关闭refScope，finalizer exactly once，getter以interrupt结束。

边界：RcRef允许新逻辑acquire在旧finalizer挂起时开始；本项目App Server是否可启动后继进程必须服从已有原ChildProcess清理与owner fencing，不能照搬并行启动时序。RcRef正常borrower scope结束后的资源释放语义也不等于SDK成功初始化后立即kill server的策略。

## 可采用的最小接口

- 原init对象持有task、独立controller、原process owner和consumer登记；所有caller等待同一个原task。
- observer接口只race自己的signal并退役自己的登记，完成与取消只settle一次；首个caller没有额外清共享RPC的权力。
- abandon／host stop接口驱动原operation controller和原process清理；closing对象先停止接纳，新请求等待既有清理边界后使用自己的有效operation。

这三处接口保持原RPC deadline与原错误，不增加模型重试、框架依赖或modelCatalog singleflight。

## 本项目的实际验证映射

| 原入口时序 | 必须由本项目证明 |
|---|---|
| A触发initialize，握手挂起；B加入同init；A先abort | A立即只收到自己的abort cause；原init RPC仍live，B仍pending；释放原ACK后B成功，进程与initialize只有1个，A不发thread/start |
| A仍等待，B后来加入又abort | B自己的等待立即拒绝，A可正常完成；后加入consumer的signal不能被忽略 |
| 所有consumer在pending init期间撤回 | 原operation不再接受加入；只清原process并确认退出，不残留pending/init缓存；不发送model或新workflow/subagent |
| 最后撤回与B新独立请求／原late response同时发生 | B不能借旧closing promise；A late result／finally不能清B或写B initialized/model namespace；清理边界按原owner执行 |
| 宿主stop时仍有多个consumer | 独立lifecycle取消整个原operation，所有waiters结束，原资源仅清一次；stop后请求不spawn |
| 握手完成与一个consumer abort在handoff窗口竞争 | 不多减refs，不泄漏listener，不把已ready资源标成failed；原设置、process/thread ownership保持 |
| 无取消、initialize真实拒绝／非法响应 | 正常并发仍共享原初始化；所有仍在等待者得到原primary error，旧child清理后再初始化的既有边界保持 |

consumer登记和退役必须对应自己的原operation对象，每个wait只settle／detach一次。共享controller只由operation生命周期或last withdrawal驱动；不是AbortSignal.any([A,B])，后者任意一个abort都会杀共享操作。保持原RPC自己的deadline，独立caller timeout只取消该caller wait。

本地观测应使用实际held initialize协议门闩、原PID／thread owner、wire initialize/thread/start/model计数、caller promise结果与SDKstop清理结果；不能只用取消token为true或本地Map为空宣称原后端结束。共享初始化取消也不改变原workflow失败恢复的同child/thread要求。

本研究不能证明用户此前报告的历史corrupt子会话可以恢复，不能为缺失的原句柄重新附着上下文。这里验证当前进程内已接纳初始化的取消归属；失去原process／handle的workflow继续遵守既有unavailable边界，不能新建Planner并称为继续。

## 文档与采证说明

Context7对VS Code和microsoft vscode的resolve没有返回核心microsoft/vscode库，未采用不相关扩展包。VS Code内部机制以固定源码／官方tests为准，没有从错误文档推导接口。

Effect repo版本查询只返回通用scope材料；随后同次可选官方v3 API站点/websites/effect-ts_github_io_effect的query明确命中RcRef.make/get与last reference release。这里只用它核生命周期概念，永久引文仍固定到本报告SHA。上游tests全部只阅读，未运行；公开采证文件位于C:\Users\Z1803\AppData\Local\Temp\dsh-thirtyseventh-shared-initialization-research。

[v-license]: https://github.com/microsoft/vscode/blob/7b0ccc7c006b52b7a30aa2c9190ac3e99c81807a/LICENSE.txt
[v-pool]: https://github.com/microsoft/vscode/blob/7b0ccc7c006b52b7a30aa2c9190ac3e99c81807a/src/vs/base/common/cancellation.ts#L150-L205
[v-pool-test]: https://github.com/microsoft/vscode/blob/7b0ccc7c006b52b7a30aa2c9190ac3e99c81807a/src/vs/base/test/common/cancellation.test.ts#L140-L166
[v-late-test]: https://github.com/microsoft/vscode/blob/7b0ccc7c006b52b7a30aa2c9190ac3e99c81807a/src/vs/base/test/common/cancellation.test.ts#L189-L209
[v-race]: https://github.com/microsoft/vscode/blob/7b0ccc7c006b52b7a30aa2c9190ac3e99c81807a/src/vs/base/common/async.ts#L83-L116
[v-race-test]: https://github.com/microsoft/vscode/blob/7b0ccc7c006b52b7a30aa2c9190ac3e99c81807a/src/vs/base/test/common/async.test.ts#L1329-L1342
[e-license]: https://github.com/Effect-TS/effect/blob/6c59de782b9c5b5cdb53fcde0455984bbfd9ff63/LICENSE
[e-acquire]: https://github.com/Effect-TS/effect/blob/6c59de782b9c5b5cdb53fcde0455984bbfd9ff63/packages/effect/src/internal/rcRef.ts#L121-L167
[e-detach]: https://github.com/Effect-TS/effect/blob/6c59de782b9c5b5cdb53fcde0455984bbfd9ff63/packages/effect/src/internal/rcRef.ts#L172-L193
[e-release]: https://github.com/Effect-TS/effect/blob/6c59de782b9c5b5cdb53fcde0455984bbfd9ff63/packages/effect/src/internal/rcRef.ts#L210-L228
[e-owner]: https://github.com/Effect-TS/effect/blob/6c59de782b9c5b5cdb53fcde0455984bbfd9ff63/packages/effect/src/internal/rcRef.ts#L95-L101
[e-shared-test]: https://github.com/Effect-TS/effect/blob/6c59de782b9c5b5cdb53fcde0455984bbfd9ff63/packages/effect/test/RcRef.test.ts#L184-L248
[e-cancel-test]: https://github.com/Effect-TS/effect/blob/6c59de782b9c5b5cdb53fcde0455984bbfd9ff63/packages/effect/test/RcRef.test.ts#L386-L418
[e-publish-test]: https://github.com/Effect-TS/effect/blob/6c59de782b9c5b5cdb53fcde0455984bbfd9ff63/packages/effect/test/RcRef.test.ts#L420-L458
[e-stop-test]: https://github.com/Effect-TS/effect/blob/6c59de782b9c5b5cdb53fcde0455984bbfd9ff63/packages/effect/test/RcRef.test.ts#L461-L484