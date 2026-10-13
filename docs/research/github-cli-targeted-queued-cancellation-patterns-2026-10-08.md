# 第68轮研究：待准入CLI调用的定向取消

状态：第68轮已验收加载。14项隔离场景、112/112相关控制、typecheck及真实probe通过；完整verify/release各1382/1382、0异步警告，包审计、host加载/恢复与diff通过。正式DSH为PID139348，会话身份与完整workflow记录保持。

## 原真实缺陷

caller signal可以取消等待者，但原cancel(workflowId)/cancelSubmission只扫描已创建的children。真实owner仍占用Reviewer，目标queued call尚无child，按workflow取消被漏掉：queuedSettled false、starts1、killRequests0；owner完成后该调用仍可能spawn。stop在原child已经close、身份绑定仍暂停时也无法让排队调用及时退出。

初始10项真实actor控制旧实现9失败1通过，唯一通过是wrong-target正常控制。目标覆盖公有review、同workflow单个submission、peer隔离、绑定owner、stop、重复取消与后续显式复用。原RED和9份失败actor状态已保存。

## 固定源码核对

通过agent-reach的GitHub/gh后端核对p-queue和async-mutex；Context7先resolve Node.js，再核对AbortSignal.any原reason和版本边界。9份源码/测试/许可原字节与Git blob核对，路径/SHA256保存于本轮 `github-sources/fixed-source-index.json`。

| 来源 / 固定提交 | 许可 | 采用机制与限制 |
| --- | --- | --- |
| sindresorhus/p-queue `180ab9e25cd10b6f548767d7176076b50d25e188` | MIT | queued任务有独立abort handler并能被移除，不能只取消running任务；采用待准入调用的独立身份和取消责任，不引入其队列调度 |
| DirtyHairy/async-mutex `b0bb4c5aa0e42eb5ffc8d9342e56bb6de1b95554` | MIT | cancel拒绝排队任务而不让现有holder提前释放；采用持有者与等待者分离，本项目按workflow/submission精确匹配而非取消全部队列 |
| nodejs/node24.14.0 `f657bb8ed86365ff3fdbe32e27563e778b41486a` | 项目许可 | AbortSignal.any组合原caller和内部目标取消，首次reason保持；固定globals注明v18.17/v20.3引入，覆盖项目支持的Node^22.19/≥24 |

[p-queue queued handler](https://github.com/sindresorhus/p-queue/blob/180ab9e25cd10b6f548767d7176076b50d25e188/source/index.ts)、[Semaphore cancel](https://github.com/DirtyHairy/async-mutex/blob/b0bb4c5aa0e42eb5ffc8d9342e56bb6de1b95554/src/Semaphore.ts)、[Node组合取消](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/lib/internal/abort_controller.js)。没有新增依赖或提高项目Node最低版本。

## 本项目采用

原run在准入前登记workflowId/submissionId和独立AbortController；与caller signal组合后交给原reserveThread/wait及执行流程。cancel匹配workflow，cancelSubmission匹配完整pair，stop取消所有待准入调用；matching queued caller返回原取消，未认领的child不会被创建。

原runAdmitted同步注册child后从pending registry交接，finally仍删除注册并释放原reservation。已准入child继续沿用原cancel/close/binding责任。onSpawn观察与spawn adapter同步调用取消时重新检查signal，尚未创建child就拒绝；child已经创建则只终止该原child，跳过prompt并等待close。FIFO前驱占用、peer waiter和不同workflow/submission保持。

注册和停止后pendingRuns/children/reservations归零；重复取消不重复创建模型，取消不永久封禁相同workflow的后续显式新调用。范围是当前待准入调用与当前活动child，未改写所有public操作在backoff gap的取消或永久workflow状态，也没有为绑定callback永不结算添加deadline。

## Evidence → Finding → Path

- Evidence：真实 `cli-queued-workflow-cancel-red.log` / JSON，取消目标尚无child而被漏掉；初始10项9失败1通过。Finding：定向取消只看已执行资源；Path：将待准入调用按原身份登记并提供独立取消来源。
- GREEN：初始10/10，首个caller/API reason与onSpawn控制3/3，spawn adapter控制1/1；最终11文件112/112（47.92秒）、typecheck/diff通过。真实probe queuedSettled true、starts1/kill0，owner仍活着。
- stop-binding让queued caller退出而原owner保存仍被持有，释放该binding后原stop才结束。错误目标保持等待、peer后来正常运行；复用和原共享重试策略保持。提前取消无queued child，spawn中取消则观察到该实际child退出，未声称此场景“从未创建进程”。

从仓库执行 `pnpm exec tsx --test test/cli-targeted-queued-cancel.test.ts` 可重放。完整验收与正式加载见[第68轮记录](../iterations/2026-10-08-sixtyeighth-cli-targeted-queued-cancellation.md)。
