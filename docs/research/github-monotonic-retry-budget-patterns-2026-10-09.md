# 重试预算与系统时钟校正

状态：三个默认计时入口已合入主源码，37项新增回归及定向46/46、typecheck通过。第89轮完整1541预期门禁正在运行；正式DSH尚未加载本轮修正，实际状态以迭代记录为准。

## 确定性复现

当前 `retryTransient()` 默认用 `Date.now` 算 deadline。预算50毫秒，等待后实际已过210毫秒，而墙钟从1000回拨到500，原实现仍执行第二次操作。默认时钟候选使用 `() => performance.now()` 后，只执行一次并抛原预算耗尽错误，`lastError`仍为原对象。

相反，实际只过10毫秒、墙钟向前校正到2000时，原实现提前放弃；候选仍允许预算内的原操作继续。正常等待、截止边界、零预算成功/失败、原取消原因及显式now注入分别验证。

可重复命令：

```powershell
node "D:\工作文件\projict\dsh-cc\.codex-workflow-verification\eightyeighth-20261009\monotonic-investigation\probe.mjs"
```

9个场景、原代码与候选两种来源，共18个结果符合预期。探针编译原模块的实际字节，在独立VM里提供可控默认Date/performance时钟；没有改系统时间、请求模型或修改正在验收的源码。初次取消控制因VM与外部Error不同realm而失败；夹具共享Error构造器后验证原错误身份，未改产品的取消语义。

## GitHub 对照与取舍

使用 agent-reach 的 GitHub CLI 后端实际获取固定源码：

| 来源 | 固定提交/文件 | 机制与边界 |
| --- | --- | --- |
| [p-retry index.js](https://github.com/sindresorhus/p-retry/blob/1472907affe8d6107aba5884abc36d6361b3042e/index.js#L81) | `1472907affe8d6107aba5884abc36d6361b3042e`，MIT | `performance.now() - start`计算剩余时长，异步失败回调后重查预算；不照搬其调度器或重试次数。 |
| [Node 24.14.0 perf_hooks](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/perf_hooks.md#L330) | `f657bb8ed86365ff3fdbe32e27563e778b41486a`，原LICENSE保存 | now返回相对进程启动的高精度毫秒值；从v19起调用时须保留performance receiver，候选使用闭包调用。 |

四份实际源码/许可保存在 `%TEMP%/dsh-monotonic-github-a8550a09-6542-458a-ad3d-75584f597b53`，manifest含固定提交、路径、Git blob和SHA256，Git blob均匹配。p-retry当前main的实际提交仍是该固定版本；不将Node固定文档描述为全网最新版。

后续核对发现该Temp证据已不可读，未推定删除原因。以同一固定SHA重新实际读取四份资料，全部Git blob核验后归档到`.codex-workflow-verification/eightyninth-20261009/source-evidence`；新manifest记录当前可读的原始字节和SHA256。上面的Temp路径仅为首次获取记录，当前证据以本轮归档为准。

系统重启后原shell代理127.0.0.1:10808不可用，首次gh失败。仅在访问公开GitHub的子进程环境去掉代理变量后实际成功；未修改用户代理、provider或profile。Context7 resolve Node连续两次传输失败，没有产生有效library ID或文档结果；本记录明确使用上述实际获取的固定官方源码，不把失败的工具调用当阅读证据。

## 后续实施范围

三个默认计时入口均需覆盖：共享 `retryTransient`、WorkflowManager的可读回合重试、CLI dispatcher重试。现已隔离编译实际WorkflowManager和CLI模块，在现有重试入口执行4个场景、原代码/候选两版、Planner/Reviewer/CLI三入口共24项；回拨超预算、前跳预算内、正常继续及取消优先均符合预期，所有模拟操作目标仍为同一个thread。

`actual-entry-probe.mjs`保存在前述仓库外调查目录，结果含每入口实际调用次数；只替换模型/子进程执行边界及默认Date/performance时钟，保留实际预算循环和取消接纳。首次调用写成不存在的CLI方法`runWithRetry`，候选未执行；核对源码改为原`runWithTransientRetry`后24/24通过，原错误日志保留。VM共享控制18项与实际模块24项是不同层次的证据，不能宣称完整CLI子进程、工具/父子会话或生产代码已采用单调预算。

采用时保留显式now/sleep/random注入；一次初始操作、零预算、等待后的截止检查、原取消原因和独立一次自动continuation额度保持。持久化的submissionRetryAt、lease及展示时间仍需要墙钟，不能将它们改成仅本进程可比较的时间值。先完成第88轮门禁/正式恢复，再为这些实际入口新增回归并合入；预算与线程身份分别验证，不把逻辑修正扩展为真实Token费用或跨重启恢复证明。

## 第89轮候选准备结果

仓库外候选已将三个默认计时入口统一到现有模块的`retryClockNow()`；同一36项回归在原副本20通过/16失败，候选36/36、typecheck通过。独立真实本地CLI进程控制再次确认原代码2进程、候选1进程且原Reviewer目标保持，候选保留最后503诊断；未调用正式provider。3源码/1测试的候选与base哈希已固定。主源码仍未合入，详见[第89轮候选状态](../iterations/2026-10-09-eightyninth-monotonic-retry-clock.md)。

调用点核对：`AppServerCodexCallbackDispatcher`将control操作直接交给共享`retryTransient`，未声明第四个Date.now默认；Workflow的control入口明确传递其retryNow，因此同时依赖Workflow默认切换和共享循环。当前src中按backoffDelayMs与retryTransient调用路径检索，默认预算时钟来自上述三个入口。持久callback调度、lease、展示elapsed与系统进程退出等待拥有不同职责，本候选的通过不覆盖它们的时钟行为。

第89轮进一步加入公开Planner start/status/resume/cancel回归，候选37/37及typecheck通过。原副本重复回拨的首个负向探针持续重试，按准确测试进程身份终止后，改用最多3次调用的有界夹具取得正常exit1 RED；候选只执行initial、一次自动continuation和一次manual resume，原thread/child保持且manual不恢复自动额度。未来完整计数预期更新为1541，生产代码仍未合入。

第88轮完整gate/delivery及正式恢复通过后，已重新验证candidate/base hash并合入3源码、1测试和3份文档，原字节备份及adoption receipt保持。主源码定向46/46、typecheck通过；314输入冻结，新1541预期门禁和一次性受控加载observer实际启动。正式PID51892仍第88轮验收版本，没有把旧1504计数作为新代码放行证据。
