# 第46轮研究：订阅释放回执与本地归属提交

## 结论与使用边界

只有原连接返回有效`thread/unsubscribe`状态，SDK才删除本地订阅归属。缺失状态、未知状态及null结果均保持清理未确认。有效释放不代表模型回合已中止，也不代表服务端线程立即卸载；原回合中断和进程退出仍由既有独立机制证明。

## 固定来源

使用Agent Reach的GitHub/`gh`后端搜索App Server客户端并读取固定源码。文件保存在`%TEMP%/dsh-fortysixth-github-1f2a62b4-31c3-4b67-892d-4f86b7ed19bf`；未复制外部实现、运行外部测试或添加依赖。

| 来源 | 固定提交 | manifest及许可 | 可采用机制 |
| --- | --- | --- | --- |
| openai/codex | `24edd7b89026865149d58d0a090694a2146b6d3c` | Cargo workspace版本0.0.0开发快照，Apache-2.0 | required状态及三值枚举；官方幂等释放测试 |
| JaminZhou/codex-app-server-client | `f833da886e01e817d0c2b959ff964b2b1a9a93c7` | 0.5.3，MIT | 对收到的响应先执行协议验证，再返回给调用者 |

[官方JSON Schema](https://github.com/openai/codex/blob/24edd7b89026865149d58d0a090694a2146b6d3c/codex-rs/app-server-protocol/schema/json/v2/ThreadUnsubscribeResponse.json)要求status存在且属于`unsubscribed`、`notSubscribed`、`notLoaded`。[官方测试](https://github.com/openai/codex/blob/24edd7b89026865149d58d0a090694a2146b6d3c/codex-rs/app-server/tests/suite/v2/thread_unsubscribe.rs#L461-L506)验证首次释放及重复释放的状态；文件另有活动turn继续运行的测试，不把unsubscribe误作interrupt。

[TypeScript客户端requestWithId](https://github.com/JaminZhou/codex-app-server-client/blob/f833da886e01e817d0c2b959ff964b2b1a9a93c7/src/app-server-client.ts#L247-L263)在验证启用时先assertResponse，再交付result。它的错误路径dispose整个peer；本项目未照搬这种范围更大的策略，只在现有SDK释放边界验证必要枚举并保留原owner。

OpenAI Docs通过官方域名搜索后实际获取[App Server文档](https://developers.openai.com/codex/app-server#unsubscribe-from-a-loaded-thread)，正文保存在`%TEMP%/dsh-fortysixth-official-app-server.md`。初次curl未跟随redirect仅得到Redirecting，随后带location获取正文，前者不算阅读证据。正文确认三个状态及延迟卸载语义。

Context7先resolve Codex App Server，再查询`/openai/codex/rust-v0.154.0`；检索未命中unsubscribe枚举，因此不将其当作枚举证据。另resolve Zod并查询`/colinhacks/zod/v4.6.5`确认验证成功/失败的显式分支模式；本项目使用现有简单枚举检查，不为三个状态新增schema库。

## 本地证据到修复

运行`pnpm exec tsx --test --test-name-pattern='unsubscribe reply retains' test/fork-creation-receipt.test.ts`，原生产代码3/3失败。RED日志`%TEMP%/dsh-fortysixth-unsubscribe-red.log`保留：缺失及未知状态的backend仍loaded原fork，但SDK丢掉owner，允许fork2/model1；null丢掉owner后留下无法再次释放的保护状态。实际失败目录分别为`dsh-fork-creation-receipt-5xbZUC`、`gGpoiW`、`qCEPvM`，均位于TEMP。

修复把required状态验证移动到任何本地释放之前，非法结果抛现有协议错误且不回显外部payload。相同backend注入后整文件12/12通过，原fork/owner保留，保护状态阻止源模型及新fork；held真实ACK随后释放原fork一次，再允许独立显式调用。两个既有健康fixture从空对象改为官方有效状态，原业务断言和期限不变。

这是本地真实SDK/stdIO故障注入，不是生产provider故障或Token费用证明。完整门禁及正式加载状态以[本轮记录](../iterations/2026-10-07-fortysixth-subscription-release-validation.md)为准。
