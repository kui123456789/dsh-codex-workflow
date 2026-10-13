# 第67轮研究：同Reviewer的同步准入预留

状态：第67轮已验收加载。9项真实进程场景、98/98相关控制、typecheck及独立探针通过；完整verify/release各1368/1368、0异步警告，包审计、host加载/恢复与diff通过。正式DSH为PID146760，会话身份与完整workflow记录保持。

## 真实并发缺陷

原waitThreadIdle等待当前children.done，但两个等待者会同时观察空闲，再分别spawn同一Reviewer的模型进程。真实探针保持owner，在它完成后观察到starts3、两个后继活动child；预期是starts2且只有一个后继活动child。多个caller从空闲线程开始也有同样窗口。

初始actor观察未等待spawn微任务，误把尚未启动的取消控制也算失败，原日志保留。补事件循环观察屏障后，在生产代码不变时，7项控制3个并发RED/4个正常控制通过；直接真实probe独立证明两个活动child，不依赖标题或模拟计数。

## 固定源码与采用原则

通过agent-reach的GitHub/gh后端读取固定p-queue及async-mutex；Context7先resolve再核对concurrency1和queued cancellation。11份原字节包含源码、测试及许可，全部与Git blob核对，SHA256和路径保存于本轮 `github-sources/fixed-source-index.json`。

| 项目 / 固定提交 | 许可 | 机制与采用限制 |
| --- | --- | --- |
| sindresorhus/p-queue `180ab9e25cd10b6f548767d7176076b50d25e188` | MIT | run在调用异步任务前增加pending，排队取消只移除对应任务；采用先占用再执行，不移植优先级或速率调度 |
| DirtyHairy/async-mutex `b0bb4c5aa0e42eb5ffc8d9342e56bb6de1b95554` | MIT | acquire同步入队或dispatch占用，runExclusive finally释放；采用调用生命周期与释放归属，不移植其整体cancel接口 |
| nodejs/node24.14.0 `f657bb8ed86365ff3fdbe32e27563e778b41486a` | 项目许可 | 原close与身份保存仍各自结算，取消reason及listener生命周期保持原契约 |

[p-queue占用与取消](https://github.com/sindresorhus/p-queue/blob/180ab9e25cd10b6f548767d7176076b50d25e188/source/index.ts)、[async-mutex Semaphore](https://github.com/DirtyHairy/async-mutex/blob/b0bb4c5aa0e42eb5ffc8d9342e56bb6de1b95554/src/Semaphore.ts)。codebase-design用于把准入行为集中于原Module的Implementation，已有Gateway Interface不变；真实spawn注入仍是既有测试Seam。

## 本项目实现

原run对已知threadId同步预留一个内部reservation，再异步等待前驱和已有child.done；实际模型执行置于原runAdmitted，finally释放一次占用。reservation保持到原close与已接纳binding全部结算，同步spawn异常也finally释放。新创建线程尚未得到ID时仍依靠原child记录，已知ID的后续caller会等待该原child。

取消的ticket只让自己的caller返回，不能提前释放前驱；ticket在前驱结算后才放行后继，防止后面的调用越过原活动运行。不同threadId独立，最后占用结算后删除Map条目，停止拒绝queued caller且不额外spawn。

串行范围是一份dispatcher内一个已知threadId的单次CLI进程调用，不是整个业务review/重试回退区间；既有独立normalization进程保持。没有跨dispatcher/跨进程锁、未知新线程全局锁、优先级、公平性或总内存硬上限，永久前驱仍可能保留取消ticket的Promise链。没有新增依赖或更改模型deadline/原onThread保存责任。

## Evidence → Finding → Path

- Evidence：真实 `cli-thread-admission-red.log` / JSON，原owner退出后两个后继同时存活；正确观察的7项旧控制3失败4通过。Finding：观察空闲与spawn之间缺少预留；Path：已知thread同步占用，原执行finally释放。
- GREEN：8项初步通过、追加stop控制后9项覆盖；最终10个完整文件98/98（40.79秒）、typecheck/diff通过。真实probe新starts2/active1，旧starts3/active2。
- private与public review均按first/second顺序派发。取消first/last不会放行仍活着的owner；身份保存仍暂停时queued模型也不能提前开始。同步spawn抛错后下一caller正常启动，不同线程并行，stop后children及reservations归零，listener清理保持。

从仓库运行 `pnpm exec tsx --test test/cli-thread-admission.test.ts` 可重放。完整门禁和正式加载见[第67轮记录](../iterations/2026-10-08-sixtyseventh-cli-thread-admission.md)。
