# Model catalog 缓存限定 backend namespace 与代次

核验日期：2026-10-06。通过 Agent Reach GitHub／gh 路线读取公开固定源码、License和官方测试；Context7完成Apollo Client与node-redis的resolve-library-id → query-docs。研究阶段先在C TEMP采证，本报告随后整理进docs/research/；未执行上游tests／服务、添加依赖、调用模型或操作正式DSH75844。新Doctor原句柄65577已正常结束；GitHub为warn（不写认证device-id验证），实际gh API成功取得本报告固定内容。

## 范围与本轮采用

modelCatalog、modelSelections属于提供这些元数据的backend namespace。进程／namespace切换后，旧A的异步结果不能回填B的活动缓存，旧A的finally也不能删除B的新请求。PID、模型名、TTL或Map.clear本身都不是代次身份。

主任务已在本地确认3个跨进程catalog／默认选择红例，实施与实际门禁由迭代记录另行提供。本报告采用上游的namespace与旧entry回填保护；并发去重作为参考机制记录，当前实现保持已有caller取消和threadOwner契约。aux tuple/prefix为边界研究：主任务现场CLI0.157.1生成UUIDv7，当前未证明冒号／前缀碰撞可达，所以本轮没有据此修改缓存键或增加新行为。

## 固定来源

| 官方仓库 | 固定SHA／提交时间UTC | License | 相关机制 |
|---|---|---|---|
| apollographql/apollo-client | c81455fa3a1bff12de6b4f9694169a301b57ee28／2026-10-05 21:55:03 | [MIT][a-license] | QueryManager自己的in-flight Trie；捕获原entry，精确匹配后才能删除 |
| redis/node-redis | 9db9237a436139b443f5b16f43eeb0c18e08e993／2026-10-01 15:57:06 | [MIT][r-license] | pending Promise entry共享；回填前validate；特定cache变体核creator＋socketEpoch |

## Apollo：捕获自己的缓存表与entry

[QueryManager的Trie][a-trie]属于该实例。[lookup][a-lookup]以printed document与canonical variables两个独立参数查找entry，不把它们简单拼接成一个带分隔符的业务字符串。已有entry.observable则复用；新entry的网络observable用shareReplay/refCount交付并发观察者。

[创建路径][a-table]先捕获inFlightLinkObservables与link。[finalize][a-lookup]只有原表的peek(document, variables) === captured entry时才能remove同tuple；迟到A清理不会无条件删除已经替换的B entry。这是可直接缩小采用的入口身份比较，不能把“Map当前存在同key”当原flight仍有清理权。

[clearStore][a-clear]在reset cache前取消未完成fetches，不能继续信赖旧store依赖的结果。官方[reset时拒绝in-flight fetch][a-reset-test]使用延迟MockLink，等待原请求已注册，再resetStore，原promise必须抛出Store reset while query was in flight。官方[queryDeduplication控制][a-tuple-test]核对document／variables tuple确有原observable entry，并验证context可关闭去重。

边界：默认去重键只有query与variables，认证header或provider context不自动成为独立namespace；源码允许context.queryDeduplication覆盖。resetStore还会重取活动query，clearStore不重取。本项目不能照搬重取行为去创建替代Planner／Reviewer。上述测试不是“两个SDK进程的A迟到响应覆盖B”的完整负例；该本地边界须由本项目的原fetch/RPC入口验证。

## node-redis：entry的有效性与creator代次

[handleCache][r-flight]在等待网络返回前先发布Promise entry，相同命令的并发caller等待该entry的同一个Promise。[回填][r-backfill]再次调用原entry.validate；若已失效则不写value。写入同cacheKey的新entry时，[set][r-replace]会invalidate原entry，让持有旧引用的loader／waiter不能重新覆盖它。

特别精确的namespace参考是[PooledNoRedirectClientSideCache][r-creator]：创建value与Promise entry时都捕获原creator client和socketEpoch；[validate][r-epoch]要求creator仍isReady且当前socketEpoch与捕获epoch相同。它是这个具体变体的保护，不能说成默认BasicPooledClientSideCache所有entry都拥有该行为。该条件也不是普通TTL：即便TTL=0，连接代次仍会判旧entry失效。

已读取的官方测试：

- [loader与并发waiter共享一次请求][r-single-test]将原Promise挂起，启动两次handleCache，释放后均得到v，但fn仅调用一次；isStorable=false时cache.size必须为0。它验证共享与禁止存储语义，不包含SDK process替换。
- [从未连接的client不能清别人共享cache][r-unused-test]socketEpoch=0的client重复destroy不抛错，已存在的共享entry仍在。清理动作必须具有自己的连接生命周期，不能因为任意对象被dispose就全局clear。
- [精确key invalidation][r-invalidate-test]对同x依次set1/2/3后每次get均读当前值，missCount=3、hitCount=0；源码[invalidate][r-invalidate]通过该key关联的显式cacheKey集合删除，未用字符串前缀选择其它key。

这些测试分别是并发／无存储／连接生命周期／失效的控制，没有直接覆盖NoRedirect变体socketEpoch的跨连接迟到回填；后者由固定源码支持，不能冒称测试已证明本项目恢复。

## 不能直接复制的clear与tuple细节

BasicClientSideCache.[clear][r-clear]只清两个map，没有逐个invalidate已被外部loader捕获的entry。因此单独clear后旧Promise仍可能持有效entry；本项目的reset必须让旧namespace或flight失去活动回填权，不能仅清一个全局map再继续无条件赋值。

Redis的[command key编码][r-key]先保存每个arg长度再拼接arg，是针对其Redis命令表示的编码；不是本项目任意字符串／二进制ID的通用证明。aux tuple若未来确有可达需求，可采用独立Map层或明确tuple结构，删除指定thread的指定turn／schema字段，最后只回收自己的空分支。当前CLI UUIDv7契约下没有实施这个拓展。

## 最小seam与本地验证映射

| 已接纳的真实时序 | 必须核对的本项目证据 |
|---|---|
| A catalog／selection已缓存，原进程退出后B提供不同catalog/default | B通过原SDK入口取得自己的metadata；旧A结果不授权B的model／effort选择 |
| A原catalog fetch挂起，reset后B fetch先完成，随后A完成／拒绝／finally | B缓存仍是B结果；A不能覆盖B catalog／selection，不能删除B flight或把失败记给B |
| 原同namespace重复查询 | 缓存命中保持当前请求／取消语义；错误不作为成功缓存，明确reset后首次查询仍能刷新 |
| 模型字段相同但provider／backendnamespace不同 | 选择隔离依赖真实namespace代次，不以model字符串或PID独立证明身份 |
| 当前原thread等待继续且全局默认设置变化 | 既有saved model／effort契约与threadOwner仍有效；不能用缓存刷新静默替换原执行 |

并发去重如需另行采用，必须先独立定义并验证consumer取消、原threadOwner、失败重查与不同selection输入的边界；本文不以它作为此次3红例的修复条件。本轮围绕已确认的namespace缓存问题，不增加框架依赖，也不执行上游测试。

## 采证边界

公开文件保存在C:\Users\Z1803\AppData\Local\Temp\dsh-thirtysixth-backend-cache-research，commit时间与MIT License均实际读取。Context7的/apollographql/apollo-client命中clearStore／resetStore／query去重与entry精确清理；/redis/node-redis命中clientSideCache与连接生命周期文档。动态文档只辅助API边界，永久引用全部固定到上述SHA。

[a-license]: https://github.com/apollographql/apollo-client/blob/c81455fa3a1bff12de6b4f9694169a301b57ee28/LICENSE
[a-trie]: https://github.com/apollographql/apollo-client/blob/c81455fa3a1bff12de6b4f9694169a301b57ee28/src/core/QueryManager.ts#L883-L896
[a-table]: https://github.com/apollographql/apollo-client/blob/c81455fa3a1bff12de6b4f9694169a301b57ee28/src/core/QueryManager.ts#L918-L927
[a-lookup]: https://github.com/apollographql/apollo-client/blob/c81455fa3a1bff12de6b4f9694169a301b57ee28/src/core/QueryManager.ts#L959-L983
[a-clear]: https://github.com/apollographql/apollo-client/blob/c81455fa3a1bff12de6b4f9694169a301b57ee28/src/core/QueryManager.ts#L631-L658
[a-reset-test]: https://github.com/apollographql/apollo-client/blob/c81455fa3a1bff12de6b4f9694169a301b57ee28/src/core/__tests__/ApolloClient/general.test.ts#L5315-L5355
[a-tuple-test]: https://github.com/apollographql/apollo-client/blob/c81455fa3a1bff12de6b4f9694169a301b57ee28/src/core/__tests__/ApolloClient/general.test.ts#L8603-L8679
[r-license]: https://github.com/redis/node-redis/blob/9db9237a436139b443f5b16f43eeb0c18e08e993/LICENSE
[r-flight]: https://github.com/redis/node-redis/blob/9db9237a436139b443f5b16f43eeb0c18e08e993/packages/client/lib/client/cache.ts#L624-L667
[r-backfill]: https://github.com/redis/node-redis/blob/9db9237a436139b443f5b16f43eeb0c18e08e993/packages/client/lib/client/cache.ts#L678-L692
[r-replace]: https://github.com/redis/node-redis/blob/9db9237a436139b443f5b16f43eeb0c18e08e993/packages/client/lib/client/cache.ts#L803-L819
[r-creator]: https://github.com/redis/node-redis/blob/9db9237a436139b443f5b16f43eeb0c18e08e993/packages/client/lib/client/cache.ts#L965-L981
[r-epoch]: https://github.com/redis/node-redis/blob/9db9237a436139b443f5b16f43eeb0c18e08e993/packages/client/lib/client/cache.ts#L930-L962
[r-single-test]: https://github.com/redis/node-redis/blob/9db9237a436139b443f5b16f43eeb0c18e08e993/packages/client/lib/client/cache.spec.ts#L765-L792
[r-unused-test]: https://github.com/redis/node-redis/blob/9db9237a436139b443f5b16f43eeb0c18e08e993/packages/client/lib/client/cache.spec.ts#L11-L28
[r-invalidate-test]: https://github.com/redis/node-redis/blob/9db9237a436139b443f5b16f43eeb0c18e08e993/packages/client/lib/client/cache.spec.ts#L175-L193
[r-invalidate]: https://github.com/redis/node-redis/blob/9db9237a436139b443f5b16f43eeb0c18e08e993/packages/client/lib/client/cache.ts#L718-L750
[r-clear]: https://github.com/redis/node-redis/blob/9db9237a436139b443f5b16f43eeb0c18e08e993/packages/client/lib/client/cache.ts#L753-L756
[r-key]: https://github.com/redis/node-redis/blob/9db9237a436139b443f5b16f43eeb0c18e08e993/packages/client/lib/client/cache.ts#L457-L471