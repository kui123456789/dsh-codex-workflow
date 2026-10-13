# Planner 异步结果的原运行归属核验

核验日期：2026-10-05。通过已读 Agent Reach 的 GitHub / `gh` 后端读取两个项目的固定源码和许可。本轮研究原运行身份在异步返回、后续调用及最终写入时的检查，不重复上一轮 LSP/rust-analyzer 诊断证据。只借鉴成立的机制，没有复制代码、引入依赖、执行上游测试或操作正式服务/模型。

## 固定来源与许可

| 项目 | 固定提交 | 许可 | 本次机制 |
|---|---|---|---|
| temporalio/temporal | `aaa291ba3e4a2d2ed71db0fa6fda4554fb81512e` | [MIT](https://github.com/temporalio/temporal/blob/aaa291ba3e4a2d2ed71db0fa6fda4554fb81512e/LICENSE) | 完成结果写入前核对原 run 和 activity attempt/start version |
| microsoft/vscode | `182f2f5bf96b741fd0212115400a32a2c5298c26` | [MIT](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/LICENSE.txt) | AI inline 请求替换取消旧 operation，异步处理后再检查原模型版本 |

完整 SHA 与许可均按固定源码核验。选择依据是具体接纳条件与当前 Planner 路径的关联，没有根据项目知名度认定实现优劣。

## Temporal：在最终状态更新内验证原执行 token

**证据链。** [activity completion L28-L57](https://github.com/temporalio/temporal/blob/aaa291ba3e4a2d2ed71db0fa6fda4554fb81512e/service/history/api/respondactivitytaskcompleted/api.go#L28-L57) 解析 task token，以 namespace/workflow/run 构造 WorkflowKey 进入状态更新。[L74-L86](https://github.com/temporalio/temporal/blob/aaa291ba3e4a2d2ed71db0fa6fda4554fb81512e/service/history/api/respondactivitytaskcompleted/api.go#L74-L86) 读取对应 activity，拒绝不存在、非运行中或与 token 不匹配的任务；通过检查后才在 [L111-L114](https://github.com/temporalio/temporal/blob/aaa291ba3e4a2d2ed71db0fa6fda4554fb81512e/service/history/api/respondactivitytaskcompleted/api.go#L111-L114) 写入完成事件。

匹配函数 [activity_util.go L58-L79](https://github.com/temporalio/temporal/blob/aaa291ba3e4a2d2ed71db0fa6fda4554fb81512e/service/history/api/activity_util.go#L58-L79) 检查任务已开始、带 scheduled event 的 token attempt，以及 start version；旧 version 字段有明确兼容分支。结果属于 workflow ID 仍不足以接受：旧 attempt 的结果不能完成当前 activity。

**适用建议。** Planner 在 admission 时捕获原 session/cwd、当前操作和原 thread/child 身份。最终 record mutation 再核对这些期望值及合法相位；失败后的等待写入、归一化失败写入与成功计划写入使用同一个归属检查。只有本操作可以执行其合法生命周期转换，不能因同一个 workflow ID 就更新被更换的运行。

**边界。** 这里核验标准 token 完成路径，不声称每种 ById 兼容 API 都只绑定最初 run。源码 [L14-L39](https://github.com/temporalio/temporal/blob/aaa291ba3e4a2d2ed71db0fa6fda4554fb81512e/service/history/api/activity_util.go#L14-L39) 在旧 token 缺 run ID 时会查当前 run。本项目不采用该补齐策略，也不复制 Temporal 的 history/lease/token 序列化框架；token 不是本轮已经实现的本地恢复凭据。

## VSCode：取消旧 operation，并在异步边界之后验证原请求

**证据链。** 本例是 VSCode AI inline completion source，不是上一轮的 LSP diagnostic 客户端。[L163-L179](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/src/vs/editor/contrib/inlineCompletions/browser/model/inlineCompletionsSource.ts#L163-L179) 将当前 text model version 保存到 UpdateRequest，能复用相同请求，否则清除旧 operation 并建立新的 cancellation source。[UpdateOperation L619-L629](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/src/vs/editor/contrib/inlineCompletions/browser/model/inlineCompletionsSource.ts#L619-L629) 的 dispose 取消该操作的 token。

debounce await 后，[L208-L215](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/src/vs/editor/contrib/inlineCompletions/browser/model/inlineCompletionsSource.ts#L208-L215) 检查 token、source disposal 和模型版本；provider 处理及展示延迟之后，[L373-L389](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/src/vs/editor/contrib/inlineCompletions/browser/model/inlineCompletionsSource.ts#L373-L389) 再检查同一组条件，过期时标记不展示原因并返回 false。

**适用建议。** 当前 Planner 的 continuation、conversion 和 controlled completion 都有 await；每次返回之后、下一次模型调用之前重新确认原操作仍有驱动权。进入 await 前的一次授权或单纯 signal 检查不应替代当前 record 与 handle 身份检查。过期结果应明确退出；不能通过 catch 将它改写为当前 workflow 的业务失败或继续等待。

**边界。** text model version 是这个编辑模型的身份/版本条件，不是 LLM 模型名称、工作区文件锁或持久 workflow lease。只采用 operation 失效传播和返回后检查原则；不迁移 VSCode observable/provider/UI 框架，也不把 cancel 请求当作服务端原回合已经结束的证明。

## 当前 Planner 路径的定向观察

本地观察基于 `HEAD abb6174d283ced56590bee90b3511948e494b3f0` 加研究时的共享工作区。CodeGraph 已先查询但索引不可用，随后只读相关文件。以下是本轮候选边界，没有运行注入 owner/cwd/phase 变化的故障回归；实施后应核验现状，不继续沿用这些行号作完成证明。

| 观察入口 | 当前源码证据 | 具体剩余检查候选 |
|---|---|---|
| 自动 continuation | [planner-execution.ts](../../src/application/planner-execution.ts) 的 runTurnWithContinuation：可恢复失败后进入第二轮；每轮检查 signal，错误路径检查 stop | 失败回合返回后、child.beginContinuation 和下一次 startTurn 前，重核原 session/cwd、合法 planning 相位及本操作原句柄 |
| 保留等待状态 | 同文件 waitForContinuation：store.update 使用 ignoreCancelled，但直接写 phase/processState 和恢复句柄 | mutation 内验证原运行归属，提交成功后再登记相同 handle；owner/相位变化不应被重写为 planning/waiting |
| 可见结果归一化 | [workflow.ts](../../src/workflow.ts) 的 acceptPlannerOutcome：beforeFork 主要检查 cancelled，随后 await private conversion/controlled completion | conversion 前后及再调用 completion 前，检查原操作；cwd/owner 被更改后拒绝使用旧结果和旧 cwd 继续调用 |
| 最终计划/失败接纳 | ready/needs_input 与 failPlannerNormalization 更新目前主要以 workflow ID 和取消规则约束 | mutation 内核验原 session/cwd/操作、期望合法相位；迟到成功和迟到失败都不能污染新状态 |
| 运行态清理 | conversion/completion finally 及 Planner 清理按 workflow key 删除 active/pending/recoverable/input 项 | 只删除本操作拥有的 map entry，避免旧 finally 清除被更换的运行；原 child/thread 仍按已有一次收尾机制释放 |

Manager 已有 inputFlights/resumeFlights、同指令加入现有请求和取消/停止控制器；它们减少同进程正常重复调用，不应被误报为缺失。单飞表本身也不检查数据库 owner/cwd/phase 在每次异步返回后是否仍相同。其他 manager 的进程内句柄不会共享，本轮不假定跨进程可恢复。

## 最小实现与验收建议

1. 在 start/continue/resume 接纳原运行时捕获期望身份；归属检查兼顾持久 session/cwd/合法相位与进程内操作/原 handle。正常 needs_input 和 planning 转换由同一操作显式拥有，不以固定不变 phase 阻止合法流程。
2. 在 continuation、private conversion、controlled completion 的 await 后重核身份；进入新的模型回合、登记 pending 或恢复句柄前也核验。无法证明原句柄时报告不可恢复，不 reconstruction 或新建替代 Planner。
3. 将相同期望身份传入最终 record mutation，约束 ready/needs_input/等待/失败分支。CAS 应检查语义归属，不能仅保证写入某个最新 record；成功返回后再发 plan-updated 或父会话执行提示。
4. 清理运行态时比较本次 operation/handle/turn，再移除 map 项。取消、停止或归属变化后的旧 callback/finally 不能清掉后续合法运行。

建议定向回归：模型等待中变更 record session/cwd/phase；失败第一轮后身份失效，第二轮模型请求计数为零；conversion 返回迟到 ready/needs_input/failure 不写计划、不重置业务状态；旧 finally 不清除新 handle。保留现有 same-thread/same-child、模型设置和澄清 admission 断言，不用 fake hash 或新依赖代替真实 mutation。

上述是最小候选，不构成本项目完成或正式 DSH 验收。SQLite record 归属检查不锁 live FS，也不能承诺模型全过程读取不可变工作区。Agent Reach 更新检查时 v1.5.0 为最新版本；写本文档时没有再调用模型，不推算 Token/费用。
