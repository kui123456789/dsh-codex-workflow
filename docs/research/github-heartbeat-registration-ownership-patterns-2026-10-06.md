# Heartbeat 注册对象的清理归属核验

核验日期：2026-10-06。本研究围绕主任务报告的真实 SQL A/B generation 探针：旧 heartbeat mark 的 OwnershipError catch 与旧 submission finalizer 按 workflowId 停止当前 timer，可能移除仍运行的 B。该本地探针由主任务执行；本研究只核验公开机制，不声称已修复本项目。

来源已通过 Agent Reach 的 GitHub／`gh` 后端读取，Node timer API 已按 Context7 resolve→query 核对。本文由冻结期间的 TEMP 笔记整理而来，没有重新抓取或运行测试，也没有修改其它文档、源码、测试或正式 DSH。

## 固定来源与许可

| 来源 | 固定提交 | 许可 |
|---|---|---|
| nodejs/node | `9746ebce077fceddcf0e8b11e85839a4cc11f6bb` | [Node 主体 MIT 条款][n-license]；固定 LICENSE 另列组成部分许可，GitHub NOASSERTION 未作为许可结论 |
| statelyai/xstate | `38dcaffb20ec7f3cbb10e6161d8f0ebacca33701` | [MIT][x-license] |

选取依据是实际 registration identity 与 owner 取消分支，未借项目知名度推断本项目行为；没有迁移依赖或复制框架代码。

## Node.js：同 key 已替换时只清理原对象

**Evidence。** [listOnTimeout L724-L730][n-compare]明确说明当前 list 可能已移除并按同 key 创建新实例，销毁前必须比较对象。只有 `list === timerListMap[msecs]` 才删除 map 项并移除 priority queue 中的当前 list。

**Finding。** [官方回归测试 L3-L34][n-test]的形状直接对应 A/B 替换：A 回调清掉 A，随即创建同 TIMEOUT key 的 B，再按 B 原 handle 取消 B。A 回调尾部不能删除 B 所在的新 list。测试注释说明原缺陷会让 B 无法取消或到期不执行。测试已阅读，未本地运行。

[setInterval 返回 Timeout][n-set]与[clearInterval 接受原 Timeout][n-clear]说明取消依据是注册句柄；应用 workflowId 只是查找 key。原 timer 与同 key 下的最新 timer 是不同对象。

**Path 与边界。**

- 保存旧注册 A；只有当前 slot 仍指向 A 时才删除该 slot。A 的原 interval handle 可以单独清掉，不能迟到后按 workflowId 重新取 B 清理。
- 上游回归是同步 timer callback 尾部的同 key 替换，不是 SQL、跨 await 或 lease epoch 测试。本项目的异步覆盖仍需自己的真实 A/B 探针。
- clearInterval 取消后续调度，不回滚已经进入 await 的旧 callback；旧回调的进度写入继续需要当前 ownership guard。
- 固定 main 源码不代表本机 Node 版本已通过该上游测试；这里借鉴对象比较机制，不要求更换运行时。

## XState：按 actor 实例隔离同名 timer

**Evidence。** [scheduler key L41-L45][x-key]使用 `actorRef.sessionId + "." + event id`；[cancel/cancelAll L134-L154][x-cancel]按原 source 查句柄，cancelAll 只处理 `scheduledEvent.source === actorRef`。[actor stop L707-L714][x-stop]把自身对象传给 cancelAll；[cancel action L36-L39][x-action]同样传 actorScope.self。

**Finding。** 两项[同名事件取消测试][x-test-first]、[相反注册顺序测试][x-test-second]均建立两个 actor 的 sameId timer：只取消指定 actor，另一 actor 的事件执行一次。测试已阅读，未本地运行。

**Path 与边界。**

- 清理应携带原 registration owner/实例，不能只有共有业务 key。
- 此例通过不同 actor.sessionId 分域；同 actor 重用同 event id 时，[schedule callback L122-L132][x-schedule]仍按 key 删除，没有 Node 同 slot 的 compare-and-remove。
- 因此 XState 的 actor scope 不能替代本项目“同 workflow、不同 heartbeat registration”的原对象比较，也不能证明同 actor 下所有重注册都安全。
- 不引入 XState；只借鉴清理动作携带原 owner 的接口原则。

## 本项目的最小采用与验收方向

| 清理来源 | 应携带与检查的对象 |
|---|---|
| heartbeat callback 的旧 OwnershipError catch | 创建时捕获的原 registration/Timeout A；registry 删除前检查 current === A |
| submission 的旧 finalizer | 原 run 的 registration owner；不重新读取同 workflowId 的最新 B |
| 业务 cancel / manager stop | 明确的 current/all 清理权限；与旧 run 只清自身资源的路径区分 |
| A 失去 owner 后的迟到进度 | 拒绝 SQLite 写入；该拒绝不授权 A 停止 B 的 timer |

建议继续使用真实 SQL coordination 与 exact timer handle：A mark pending 时替换 owner/generation 并注册 B，释放 A 的回调或 finalizer。断言 B 仍在 registry、仍 running，下一次 heartbeat 更新其自身进度；最后显式停止 B。A/B 各清自己的原 handle，计实际 clear/remove，不用幂等包装掩盖误删。

本研究仅提供两种贴合机制，不声称生产修复、全部门禁或 DSH UI 已通过。timer registration ownership、数据库 lease fencing 和远端 writer 终止 ACK 是分别核验的条件。关联背景见 [嵌套进度 fencing](github-nested-workflow-progress-fencing-2026-10-06.md)。

[n-license]: https://github.com/nodejs/node/blob/9746ebce077fceddcf0e8b11e85839a4cc11f6bb/LICENSE#L1-L23
[x-license]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/LICENSE
[n-compare]: https://github.com/nodejs/node/blob/9746ebce077fceddcf0e8b11e85839a4cc11f6bb/lib/internal/timers.js#L724-L730
[n-test]: https://github.com/nodejs/node/blob/9746ebce077fceddcf0e8b11e85839a4cc11f6bb/test/parallel/test-timers-same-timeout-wrong-list-deleted.js#L3-L34
[n-set]: https://github.com/nodejs/node/blob/9746ebce077fceddcf0e8b11e85839a4cc11f6bb/doc/api/timers.md#L234-L242
[n-clear]: https://github.com/nodejs/node/blob/9746ebce077fceddcf0e8b11e85839a4cc11f6bb/doc/api/timers.md#L378-L387
[x-key]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/system.ts#L41-L45
[x-cancel]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/system.ts#L134-L154
[x-stop]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/createActor.ts#L707-L714
[x-action]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/actions/cancel.ts#L36-L39
[x-test-first]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/test/actions.test.ts#L3625-L3671
[x-test-second]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/test/actions.test.ts#L3673-L3718
[x-schedule]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/system.ts#L122-L132

