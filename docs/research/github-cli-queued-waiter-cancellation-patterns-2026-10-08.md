# 第66轮研究：取消CLI线程等待者而不取消原持有者

状态：第66轮已验收加载。9项真实进程场景、89/89相关控制、typecheck和独立探针通过；完整verify/release各1359/1359、0异步警告，包审计、host加载/恢复与diff通过。正式DSH为PID89636，会话身份及完整workflow记录保持。

## 实际缺陷

原CLI run在恢复指定Reviewer前等待同threadId的活动child.done，但waitThreadIdle未观察调用者signal。真实owner被IPC保持运行，queued caller被取消后仍等待owner完成。探针exit1、starts1、queuedSettled false、owner仍活着、killRequests0；不是取消杀错进程，而是等待者不能及时返回。

7项初始隔离控制旧实现4失败3通过，覆盖普通取消、默认reason、原身份绑定待完成及另一等待者仍需继续；预先取消、不同线程与正常准入控制原本通过。追加公开review调用和owner结束/取消竞态两项后，最终控制包含9项。

## 固定源码研究

通过agent-reach的GitHub/gh后端搜索并选择p-queue；Context7先resolve再查询排队与已运行任务的AbortSignal语义。9份固定源码、测试、说明与许可的原字节全部核对Git blob，路径和SHA256保存于本轮 `github-sources/fixed-source-index.json`。

| 项目 / 固定提交 | 许可 | 机制与采用边界 |
| --- | --- | --- |
| sindresorhus/p-queue `180ab9e25cd10b6f548767d7176076b50d25e188` | MIT | 排队abort handler清理自己的listener、移除对应queue item并reject原signal.reason；运行任务另有自己的signal。采用等待者与持有者独立取消责任，未迁移优先级队列、速率限制或运行框架 |
| nodejs/node24.14.0 `f657bb8ed86365ff3fdbe32e27563e778b41486a` | 项目许可 | AbortSignal.reason保存原原因，一次abort监听要清理；ChildProcess退出/close仍由原持有者确认，等待者不应发送其kill |

[p-queue独立取消实现](https://github.com/sindresorhus/p-queue/blob/180ab9e25cd10b6f548767d7176076b50d25e188/source/index.ts)、[queue removal](https://github.com/sindresorhus/p-queue/blob/180ab9e25cd10b6f548767d7176076b50d25e188/source/priority-queue.ts)、[Node取消契约](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/globals.md)。固定index的queueAbortHandler和running task abort分开，不能把取消所有持有者当作取消一个排队调用。

## 本项目采用

原waitThreadIdle新增caller signal参数；等待当前owner.done时另挂一次abort观察，任何结算都移除该等待者listener。取消精确抛原Error/default DOMException；无signal仍使用原done等待，准入后run仍执行既有stop/abort检查。

waiter不持有child，不kill、abort或解绑owner，也不取消peer waiter。原owner.done仍包含模型结束和已提交身份保存，其他线程独立运行。取消后不会创建queued模型进程；owner原操作继续完成。旧done promise上的已附加回调会在owner最终结算时返回空操作，未声称取消能移除所有Promise reaction或全内存硬上限。

没有新增依赖或改写工作流/提交cancel路由；范围是调用者signal的等待取消。未实现新的FIFO、全线程互斥调度或整树退出证明，也没有更改模型deadline、binding callback寿命、上层恢复分类。等待者返回及时的证明使用原owner尚未完成的事件屏障，不宣称墙钟毫秒性能保证。

## Evidence → Finding → Path

- Evidence：真实 `cli-queued-abort-red.log` / JSON，queuedSettled false，原owner活着；7项旧控制4失败3通过。Finding：原线程占用观察忽略caller取消；Path：把取消观察绑定到单个waiter而不是原child。
- GREEN：初始7/7，公开review与释放竞态2/2；最终9个完整文件89/89（35.42秒）、typecheck/diff通过。真实probe queuedSettled true/sameCause true、starts1/killRequests0，原owner仍活着。
- 原身份保存未完成场景中取消queued caller不会跳过owner绑定；另一个peer waiter在owner完成后正常运行。成功准入与不同线程不被新增逻辑延迟，所有结束路径listenerCount0。

从仓库执行 `pnpm exec tsx --test test/cli-queued-waiter.test.ts` 可重放。完整门禁和正式加载见[第66轮记录](../iterations/2026-10-08-sixtysixth-cli-queued-waiter-cancellation.md)。
