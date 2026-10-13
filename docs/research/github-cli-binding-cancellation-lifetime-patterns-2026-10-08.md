# 第65轮研究：进程关闭后的原身份绑定与取消观察

状态：第65轮已验收加载。9项隔离场景、80/80相关控制、typecheck及独立探针通过；完整verify/release各1350/1350、0异步警告，包审计、host加载/恢复与diff通过。正式DSH为PID123048，会话身份和完整workflow记录保持。

## 原可复现缺陷

CLI run正确等原child.close及已经提交的onThread保存回调，但在close时就移除调用者abort监听器。真实进程exit1后，原身份保存仍被暂停；此时取消，原实现最后返回permission denied进程错误，而非原取消对象。保存回调之后拒绝也会盖过被漏掉的取消。

独立真实CLI探针exit1，starts1、原backend实际exit1、bindingEntered true、sameCancellation false。9项actor控制旧实现2失败7通过；成功进程的取消会在后续阶段入口被再次检查，workflow/submission cancel和stop也已有自己的等待，所以本轮没有把这些正常路径误判为同一个故障。

## 固定源码研究

通过agent-reach的GitHub/gh后端读取固定Execa源码；Context7先resolve Node.js，再核对v24 AbortSignal.reason、一次abort事件和取消监听清理契约。9份原始文件含测试/许可全部通过Git blob字节核对，SHA256与路径位于本轮 `github-sources/fixed-source-index.json`。

| 来源 / 固定提交 | 许可 | 核对机制与采用限制 |
| --- | --- | --- |
| sindresorhus/execa `63ddae6aeb6934da06fdb3754647791e58cd87c3` | MIT | cancel观察原signal并抛原reason，onAbortedSignal另用stopSignal结束观察；失败结算仍汇合原进程与流。采用业务观察寿命独立于物理事件的原则，不宣称它实现了本项目onThread保存窗口 |
| nodejs/node24.14.0 `f657bb8ed86365ff3fdbe32e27563e778b41486a` | 项目许可 | AbortSignal.reason保存调用者原因，abort事件只触发一次；ChildProcess.close仅证明进程和stdio结束，不证明应用层身份保存已经结束 |

[Execa原reason](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/terminate/cancel.js)、[观察停止信号](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/utils/abort-signal.js)、[Node取消契约](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/globals.md)、[Node物理close事件](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/child_process.md)。

## 本项目采用

只移动原CLI run的abort监听器清理时机：从child.close移动到原binding promise结算之后、删除原children条目与resolveDone之前。原信号在这个窗口继续记录首次pendingError；已退出child不会再次收到kill，原绑定仍等待一次保存完成。

取消不撤销保存、不提前返回并遗弃绑定，也不创建新线程或子进程。绑定拒绝时原catch仍结算清理，先前取消对象优先；未取消时进程终止诊断和绑定拒绝对象保持原行为。最终listenerCount0，完成后取消不会再kill旧进程。未改变模型timeout在close时停止的边界，也未增加新的保存超时；不处理永不结算的callback、第三方阻止abort传播或整个workflow的所有取消路径。

## Evidence → Finding → Path

- Evidence：真实 `cli-binding-abort-red.log` 与JSON，原exit1后保存暂停、取消丢失；9项控制2失败7通过。Finding：物理close被错误当作取消观察结束；Path：原listener寿命延长到应用层原绑定结算。
- GREEN：9/9、typecheck、8个完整相关文件80/80（30.12秒）。真实probe sameCancellation true、starts1/actual exit1、原身份回调完成一次。
- actor在close时记录children1和caller未结算；取消后继续保持这个状态，释放原gate后精确返回原取消对象，未新增normalization进程。workflow/submission cancel、stop、成功控制、终止控制和绑定拒绝控制均保持；所有最终abort listener移除，killRequests0。

从仓库执行 `pnpm exec tsx --test test/cli-binding-lifetime.test.ts` 可复现。完整门禁和正式加载见[第65轮记录](../iterations/2026-10-08-sixtyfifth-cli-binding-cancellation-lifetime.md)。
