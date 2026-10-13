# 第47轮研究：保留完成结果，重试失败清理

## 结论与范围

把模型转换与资源清理分成两个步骤。清理失败时保留已完成输出、原进程、原订阅owner及转换输入身份；同材料恢复只执行清理，再返回原输出。错误、取消及进程丢失有独立边界。默认ephemeral Planner/Reviewer直接原线程转换；本轮主要覆盖persistent-source内部转换fork，不创建替代Planner/Reviewer。

## 固定来源

使用Agent Reach的GitHub/`gh`后端读取；文件保存在`%TEMP%/dsh-fortyseventh-github-d17a696d-ec2e-43d0-abfa-06a4b2173732`。只借鉴机制，没有复制外部实现、运行外部测试或安装依赖。

| 来源 | 固定提交 | manifest / 许可 | 采用机制 |
| --- | --- | --- | --- |
| langchain-ai/langgraph | `3a1796ecf072b9f3bb429d5835179c15e92d719a` | 1.2.14，MIT | 恢复已完成任务的结果，单独处理未完成步骤 |
| sindresorhus/p-retry | `1472907affe8d6107aba5884abc36d6361b3042e` | 8.0.1，MIT | 重试范围由传入函数决定，避免把成功模型和失败清理包成整体重跑 |

[LangGraph完成任务写入恢复](https://github.com/langchain-ai/langgraph/blob/3a1796ecf072b9f3bb429d5835179c15e92d719a/libs/langgraph/langgraph/pregel/_loop.py#L797-L810)把已完成输出重新附到任务上；[checkpoint说明](https://github.com/langchain-ai/langgraph/blob/3a1796ecf072b9f3bb429d5835179c15e92d719a/libs/checkpoint/README.md#L55-L66)解释保留成功节点的pending writes，恢复时避免重复执行。它使用持久化checkpointer；本项目只保留当前进程中的原fork及结果，不能据此重建失去的ephemeral线程。

[p-retry调用范围](https://github.com/sindresorhus/p-retry/blob/1472907affe8d6107aba5884abc36d6361b3042e/index.js#L236-L250)每次尝试调用同一input函数。若input包含模型和清理，后续清理失败会把模型也重跑。本项目把可重试动作限定为原清理，不引入p-retry，也不改变原模型自动继续预算。

Context7先分别resolve LangGraph和p-retry，再查询`/langchain-ai/langgraph`与`/sindresorhus/p-retry`。检索支持任务输出恢复及input重试范围；LangGraph检索片段与固定源码的具体内部写法不同，最终以固定源码为准。

## 本地反馈

`pnpm exec tsx --test --test-name-pattern='completed conversion with' test/fork-creation-receipt.test.ts`先RED。保持既有首次成功返回语义后，最终反馈命令仍2/2失败，日志`%TEMP%/dsh-fortyseventh-completed-release-api-red.log`：首次转换完成，释放失败被吞掉；重复调用、源模型及变化材料继续运行，wire统计fork3/model4，原fork仍loaded。初探预期第一次返回错误不属于既有契约，未采用该行为变更。

修复缓存转换结果的独立副本并保留清理保护。并发恢复共用一次清理RPC，单个observer取消不取消另一个；成功输出和原始模型错误保持。原模型中断未确认时先确认其真实pair，再释放订阅。源订阅明确释放可推进它自己的fork清理；外部CLI交接在清理失败或仍有活动工作时拒绝关闭原进程。

另以真实launcher/backend拓扑验证：转换完成但unsubscribe拒绝、launcher先退出时，SDK stop继续清理捕获原backend并证明退出，model1、fork1、无伪造ACK。该新增原生case1/1通过，不冒称已经在修复前跑过这项原生RED。

相关SDK/callback/原生控制117/117通过，86.59秒。两条外部交接入口先2/2 RED后GREEN；普通转换中断边界先RED后GREEN。完整门禁及正式加载状态见[本轮记录](../iterations/2026-10-07-fortyseventh-completed-conversion-cleanup.md)。证据为本地真实SDK/stdIO和合成上游，不是实际provider故障或Token计费证明。
