# CLI重试全过程的取消责任

日期：2026-10-08。第69轮已通过完整verify/release各1399/1399、host加载/恢复和diff，并受控加载到正式DSH，PID148336。没有增加第三方依赖。

## 本地缺陷与实际证据

原`run`只在待准入阶段登记取消，创建child后交接，child退出后本次登记结束。`runWithTransientRetry`随后等待退避，只有调用者signal；此时按workflow/submission取消找不到这次原操作。

真实Node子进程探针连续复现：原child以`server_overloaded`退出，取消时`settledBeforeWakeup:false`、`backoffSignalAborted:false`；释放等待后进程数从1变为2。15项初始回归13失败、2个控制通过，覆盖公开normalize/review/createReview/align/reconcile、submission隔离、原错误原因、停止和不合作等待。另补无caller信号及生产默认timer两个控制，累计17项。原RED、源码副本和失败actor目录保留。

## 固定源码比较

| 项目及固定提交 | 实际机制 | 本项目采用与边界 |
| --- | --- | --- |
| [p-retry](https://github.com/sindresorhus/p-retry/tree/1472907affe8d6107aba5884abc36d6361b3042e)，MIT | `index.js:84–106`退避监听signal、清timer并拒绝原reason；`191–195`等待前后检查；`233–249`整次重试使用同一signal | 采用跨attempt的取消范围，保留本地abortableDelay、终态分类和时间预算。底层操作仍需观察signal。 |
| [Cockatiel](https://github.com/connor4312/cockatiel/tree/80b5ed67966dfcc5410a912285fcb3eeb2dc5e5e)，MIT | `src/RetryPolicy.ts:101–123`把同一signal传给每次执行并检查重试资格；其delay未接收signal | 借鉴整次执行的责任范围；及时取消等待以p-retry和本地实现为依据。 |

通过agent-reach的GitHub/gh后端搜索并读取；8份源码、测试、README、许可原字节已验证Git blob SHA1及SHA256，保存于本轮证据目录`github-sources/fixed-source-index.json`。Context7的`/sindresorhus/p-retry`确认signal取消重试的公开契约，具体细节以固定源码为准。只采用机制，自行实现本地代码。

## 实现与验收边界

在现有pendingRuns中登记整个CLI重试操作，独立Controller与caller signal合并，覆盖每次准入、执行和退避；finally撤销登记并结算原done。stop取消并等待所拥有的重试。信号和直接取消重叠时，原child首次终止保留原因，后续取消不重发kill。

新显式调用仍可复用相同workflow/submission；已有thread预留、身份绑定、一次自动continuation和ephemeral进程边界保持。17项新增回归、相关测试、完整门禁及正式加载结果以[第69轮记录](../iterations/2026-10-08-sixtyninth-cli-retry-operation-cancellation.md)为准。受控本地故障不证明正式provider自然故障、Token费用或浏览器交互。
