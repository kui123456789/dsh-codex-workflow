# 跨 await 的嵌套进度 scope 与写入 fencing 核验

核验日期：2026-10-06。使用 Agent Reach 的 GitHub／`gh` 后端读取 Temporal 的嵌套更新入口与 Node.js AsyncLocalStorage；ALS 接口同时按 Context7 文档核对，最终引用以固定源码/官方测试为准。本文只记录机制与边界，没有修改其它文件、运行上游测试/服务、调用模型或操作正式 DSH。

## 结论与固定来源

异步 context 负责把原 run scope 带到嵌套 helper；写入 guard 负责比较当前 owner/attempt/lease。两者必须同时存在。旧回调即使仍读到原 scope，也不得覆盖已更换 owner/epoch 的 progress/metadata；只在外层长操作开始时校验不足以保护后续写入。

独立调研不承担本项目复现或提前决定新增 ALS；主任务随后依据真实入口红例选择显式 guard，验证记录见[第二十五轮迭代](../iterations/2026-10-06-twentyfifth-nested-progress-fencing.md)。上游机制与本地修复的证明范围分别记录。

| 案例 | 固定提交 | 固定许可 |
|---|---|---|
| temporalio/temporal | `4db93cd73eb12f4aa12e244f6419b506cbd35dc0` | [MIT][t-license] |
| nodejs/node | `9746ebce077fceddcf0e8b11e85839a4cc11f6bb` | [Node 主体 MIT 条款][n-license]；固定 LICENSE 另列组成部分许可，GitHub NOASSERTION 不作为许可结论 |

## Temporal：把原 workflow lease 显式传给嵌套写入

**Evidence。** [GetAndUpdateWorkflowWithNew][t-entry]接收原 workflow key/clock，获取对应 workflow lease，defer 释放，再将同一 lease 传给 UpdateWorkflowWithNew。[嵌套更新 helper][t-update]先执行 action；action 报错或返回 Noop 就退出，只有接纳后才调用原 context 的 UpdateWorkflowExecutionAsActive/WithNewAsActive。

[heartbeat action][t-heartbeat]在该 lease callback 中核 workflow running、原 scheduled Activity 和当前 token/attempt，再调用嵌套 UpdateActivityProgress。[token 判断][t-token]不匹配 attempt/startVersion 等时拒绝；[实际 mutation][t-progress]随后写 heartbeat details/time/worker identity。UpdateActivityProgress 自身不重新验证 token，安全性来自调用入口持有的 lease 与提前验证，不能脱离此入口任意调用。

[consistency checker][t-load]按精确 namespace/workflow/run 加载 mutable state，返回同 scope 的 lease；缓存 predicate 失败后重新加载。重新加载不会再次执行该 predicate，因此 caller 的业务 token 检查仍必要，不能仅凭“加载到状态”授权进度写入。

**Finding。** 上游 [attempt mismatch 测试][t-token-test]断言 token attempt=2 对当前 attempt=3 拒绝、相同 attempt 接受。[lease lookup 测试][t-lease-test]断言精确 run key 和同 mutable-state/未提前释放；[clock 测试][t-clock-test]对可比较且当前 shard clock 落后者返回错误并卸载。不同 shard/cluster 或缺 clock 可走兼容路径，不能把 clock 当所有请求的业务 epoch fence。

这些测试已阅读，未执行；不是完整“多层 nested progress、跨 await 更换赢家、整行不变”的集成测试。拒绝 token 到嵌套 mutation 的顺序由 handler 源码支持。

**Path 与边界。**

- 手动 guard/scope 参数应从原 admitted run 传到底层进度 sink；nested helper 不临时读取最新记录并冒充原 scope。
- 在实际事务的可写分支内验证 current owner/token/phase，guard 拒绝不进入持久化。只有父函数已经验证、或只传 workflowId 的 helper 仍可能失去保护。
- 上游 lease 是 Temporal 的 workflow execution 锁/一致性 scope，不等于本项目 TTL coordination lease；本项目要核实际 owner/epoch。
- heartbeat ByID 的兼容路径可以跳过 scheduled token 的 attempt 比较。该机制不自动保护任意未走原 token 接纳入口的更新。

## Node.js ALS：跨 await 传递原 scope，不自动授权写入

**Evidence。** 固定 [AsyncLocalStorage 实现][n-impl]的 run 切换当前 frame，finally 恢复调用者 frame；getStore 返回当前 frame 的原值。bind 使用 AsyncResource，snapshot 用 bind 保存当前 context。[固定 API 文档][n-doc]说明这些接口的 context 绑定，另说明[自定义 thenable/callback 的 context loss 处理][n-loss]。

**Finding。** 官方 [async-await 测试][n-await-test]在 await 后仍读取原 Map，run 外读到 undefined；[nested 测试][n-nested-test]在 inner scope 返回后恢复 outer，exit 后也恢复 outer。[snapshot 测试][n-snapshot-test]在 scope 123 中捕获函数，稍后于 scope 321 调用仍返回 123，明确显示“携带原 scope”而非“自动取得最新合法 owner”。测试仅阅读，未执行。

**Path 与边界。**

- ALS 可以减少 nested helper 手动逐层传参的遗漏：原 run 建立 scope，progress sink 获取同一原 identity/token 后执行与手动参数相同的当前写入 guard。
- ALS 不读取数据库 lease、验证 owner/epoch、比较 evidence，也不撤销已绑定的旧 callback。不能把上下文正确传递当作防迟到写入的证明。
- store 对象没有由 ALS 深拷贝/冻结；原 identity/effective settings 必须由应用捕获，不能让可变共享对象或新 fallback 改写基准。
- 自定义 callback/事件或 thenable 可能失去 context；有需要时显式 bind/AsyncResource。缺 scope 的敏感进度写入应拒绝，不能退回“按 workflowId 更新最新记录”。
- fixed main 的 frame 实现与本机 Node 版本不是同一验收证据。Context7 文档仅核接口语义，本轮未运行宿主 ALS 或安装新版运行时。

## 两种载体的采用条件

| 载体 | 能证明的事实 | 本项目仍必须做的事 |
|---|---|---|
| 显式 original scope/guard 参数 | 调用签名可见原 identity/attempt，易逐层审查 | 所有 nested helper 传递同 guard；每次 transaction 内验证当前 owner/lease |
| ALS run scope + 统一 progress sink | 官方测试证明 await、nested 与 snapshot 携带原 context | 处理 context loss，必须有 scope，sink 执行同样的 CAS/owner guard |
| 仅 workflowId 或当前记录 lookup | 只能定位记录 | 不足以授权旧回调；不得从赢家记录生成旧回调的新 guard |
| 回调在 lease 失效后仍存在 | 可能仍有原 context 与原句柄 | 拒绝 progress/usage/finally 写入，不启动替代模型，也不释放别人的资源 |

建议用实际 Bridge/foreground nested validation 路径，将 owner/epoch 的变化放在外层 guard 之后、nested progress mutation 之前，调用真实 mark/heartbeat/elapsed/usage 写入。断言赢家整行、revision、updatedAt、lease owner/epoch 不变；正常 scope 写入成功；缺 scope、错 scope 和 captured old callback 均拒绝。若 mutator 早 return 仍会推进 revision，要使用真正拒绝/回滚或等价 CAS suppression，不能把空写当作无变化。

此研究没有证明本地 nested defect 或修复已完成。配置与原身份条件沿 [run settings/progress](github-run-settings-and-progress-fencing-2026-10-06.md)及[恢复身份 fencing](github-resume-identity-fencing-patterns-2026-10-06.md)保持；输入/evidence freshness 和远端中断 ACK 仍是独立门禁。

[t-license]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/LICENSE
[n-license]: https://github.com/nodejs/node/blob/9746ebce077fceddcf0e8b11e85839a4cc11f6bb/LICENSE#L1-L23
[t-entry]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/update_workflow_util.go#L14-L35
[t-update]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/update_workflow_util.go#L62-L117
[t-heartbeat]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/recordactivitytaskheartbeat/api.go#L41-L87
[t-token]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/activity_util.go#L58-L79
[t-progress]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/mutable_state_impl.go#L2110-L2127
[t-load]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/consistency_checker.go#L275-L315
[t-token-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/activity_util_test.go#L39-L50
[t-lease-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/consistency_checker_test.go#L80-L108
[t-clock-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/consistency_checker_test.go#L170-L224
[n-impl]: https://github.com/nodejs/node/blob/9746ebce077fceddcf0e8b11e85839a4cc11f6bb/lib/internal/async_local_storage/async_context_frame.js#L42-L81
[n-doc]: https://github.com/nodejs/node/blob/9746ebce077fceddcf0e8b11e85839a4cc11f6bb/doc/api/async_context.md#L148-L211
[n-loss]: https://github.com/nodejs/node/blob/9746ebce077fceddcf0e8b11e85839a4cc11f6bb/doc/api/async_context.md#L513-L527
[n-await-test]: https://github.com/nodejs/node/blob/9746ebce077fceddcf0e8b11e85839a4cc11f6bb/test/async-hooks/test-async-local-storage-async-await.js#L8-L16
[n-nested-test]: https://github.com/nodejs/node/blob/9746ebce077fceddcf0e8b11e85839a4cc11f6bb/test/async-hooks/test-async-local-storage-nested.js#L10-L25
[n-snapshot-test]: https://github.com/nodejs/node/blob/9746ebce077fceddcf0e8b11e85839a4cc11f6bb/test/parallel/test-async-local-storage-snapshot.js#L7-L16
