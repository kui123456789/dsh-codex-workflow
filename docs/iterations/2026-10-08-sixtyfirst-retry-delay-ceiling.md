# 第61轮：抖动后的等待上限

状态：第61轮已完成完整验收并加载正式DSH，PID139496。verify/release各1310/1310，host加载/恢复与diff通过；持续优化目标active。

## 基线与范围

只读核对PID129228/birth `2026-10-08T11:00:34.2682370+08:00`，413个会话身份、111条workflow完整记录保持，原parent/历史corrupt child存在，running/waiting0。HEAD仍abb6174，既有dirty保留；provider、profile、凭据及历史workflow未改变。第60轮共享模块SHA256 `32C04E1A6A9C47B01BFA0250F96E1B62171E27AF19132277049D2338BC572C52`，原副本保留为本轮 `transient-retry-before.ts`。

证据位于 `../.codex-workflow-verification/sixtyfirst-20261008/`。先执行直接探针，再补回归测试，保留真实RED，不把现有绿灯当作故障已被覆盖。

## RED与修复

命令 `node --import tsx ../.codex-workflow-verification/sixtyfirst-20261008/retry-delay-ceiling-probe.mjs` 0.71秒exit1：base/max60000、budget65000、jitter0.25、random0.999999，delay75000，attempts1、sleeps[]，返回TransientRetryExhaustedError。只检查预期时间无法排除抖动超上限；根因是末尾缺少最终裁切，归一化后的配置正确。

新增 `test/retry-delay-ceiling.test.ts` 4项（指数饱和/上限、小数round、原负向抖动、实际预算接纳），既有Workflow新增Planner/Reviewer各1项，CLI新增1项。旧实现7项6失败1通过，日志 `retry-delay-ceiling-tests-red.log` 留存。

只修改 `src/transient-retry.ts` 的共享等待计算：毫秒上限向下取整且保留原最低1毫秒，最终抖动/round值不能超限。没有增加重试预算、改写线程身份或增加continuation次数；达到上限时的正向抖动被裁切，负向抖动保持。README/CHANGELOG说明真实计划等待上限；[三项目研究](../research/github-retry-delay-ceiling-patterns-2026-10-08.md)明确不同上限契约，未新增依赖或照搬调度器。

## 已完成验证

7项定向GREEN通过，直接探针变为delay60000、attempts2、sleeps[60000]、原操作成功。原RED JSON另存，未覆盖为成功记录。typecheck exit0。

原exec91485已明确terminal exit0：5个完整文件169/169、fail/cancelled/skipped0，95.15秒；运行期间不改输入。与此前等待唤醒deadline及取消控制同时运行，既有保护仍通过。

真实CLI探针采用原dispatcher及真实本地Node子进程：starts3、实际exitCode[1,0,0]，前两次参数均为 `resume original-local-reviewer`，一次60000等待，clock60000，最终verdict。同线程恢复与原normalization分别记录，没有调用正式模型。临时backend目录经真实路径边界校验后清理。生产修复后共享模块SHA256 `76627D83319096B2978B71F6326869F646088964127000559A2391B0D72A4553`。

本轮局部结果不替代完整verify/release/host恢复或正式加载；不是墙钟等待硬上限、真实provider自然故障或Token计费证明。完整测试预期1310（原1303+新增7），未commit/push/publish。

## 冻结后的完整验证链

278份代码、测试、脚本及发布输入已冻结，并保存同数快照；manifest SHA256 `764FA5515239EE06A70F389EADC27E790896E2058122B86DF88966F11F017031`。输入包括src/test/scripts、package/lock、tsconfig、patch及README/CHANGELOG/LICENSE；研究与迭代记录在此冻结集合之外。

唯一完整链原exec96157，目录 `final-gates-b6895ff7-b8e4-4e27-a230-9784badefc2e/`，依次verify、一次release、host、host-recovery、diff；每阶段前后核对集合与各文件哈希，完整测试要求1310/1310、fail/cancelled/skipped0及0异步警告。独立文件并发1，场景原时限与内部并发保持。当前已启动verify，未取得完整终态，不重复启动。

后续受控加载helper均已绑定本轮唯一门禁、manifest、278/1310输入及正式原PID129228/birth11:00:34.2682370，PowerShell解析0错误。前置认证使用第60轮私有state；本轮最终build冻结及正式重载尚未执行，只有完整门禁结束通过且实际正式服务空闲才可执行。观察超时须继续同一exec或已启动实例，不能再开验证链或再次重载。

## 完整verify结算

原exec96157的verify已明确exit0：1310/1310、失败/取消/跳过均0、异步警告0，1811.36秒。完整 `verify.log` / `summary.json` 留存，同一exec继续release；没有重开验证链，未用169项局部结果替代完整验收。门禁前后278份冻结输入保持。

另存 `source-change-receipt.json`：相对第60轮277份输入，增加1个测试文件、变更5份既有输入（共享生产模块1份、测试2份、README/CHANGELOG2份），其余保持；研究、迭代记录在冻结集合之外。发布包审计、host加载/恢复、diff终态和正式加载仍须分别确认，本轮build freeze及reload receipt尚未生成。

## 最终完整验收

原exec96157已明确terminal exit0，沿用同一完整链，没有因观察到期重复启动：

| 门禁 | 结果 | 总耗时 |
| --- | --- | --- |
| verify | 1310/1310；失败、取消、跳过与异步警告均0 | 1811.36秒 |
| release:check | 1310/1310；失败、取消、跳过与异步警告均0；包审计通过 | 1846.76秒 |
| host:check | exit0，安装宿主加载通过 | 4.28秒 |
| host:recovery:check | exit0，本地受控网关和隔离存储的原线程恢复通过 | 7.60秒 |
| diff --check | exit0 | — |

离线doctor通过（5项skipped），临时tarball已清理。host恢复使用DSH0.1.7-rc.2、原生ToolRuntime/AgentRegistry/SessionProjectionRegistry/SubagentRuntime；结果明确 `browserUIVerified: false`，不是正式provider自然故障、真实Token计费或浏览器交互证明。

278份输入与原快照保持；最终217份build冻结SHA256 `B3676C1D93FE486E918CB85F3226F124E87983D16DB3FC084635440201E58873`，`build-freeze-receipt.json`关联本轮完整门禁。

## 重载身份校验的实际失败与修正

第一次执行重载在任何进程捕获/信号之前被guard拒绝，exit1；正式PID129228和3080监听均保持，无old-tree文件、无reload receipt、未启动新实例。原因是操作helper复制时PID和ISO birth已更新，硬编码的Windows出生标识仍为第59轮 `win32:134358947882582700`。

重新只读取得原实例真实birth `win32:134359020342682370`，保留原helper及首次pre-metadata快照。只读身份探针先RED exit1，再修正操作helper和prepare脚本的标识转换/残留检查，GREEN exit0、Node语法检查通过。应用源码、278份门禁输入和217份build未变；没有取消身份校验或重跑完整门禁。证据：`reload-first-guard-failure.json`、`formal-identity-guard-red.log` / `green.log`、`formal-birth-correction-receipt.json`。

## 正式加载与数据核对

正式空闲再次确认running/waiting0后，修正后的重载原exec7131明确exit0，只实际启动一个新实例。原PID129228对应捕获的11个原实例已退出；新PID139496/birth `2026-10-08T12:19:03.6647040+08:00`，原Node/DSH入口与127.0.0.1:3080监听匹配，认证健康HTTP200。

`formal-verification.json`确认217份build及27个关键模块哈希0偏差、413个会话身份保持、111条workflow完整记录保持、stderr致命匹配0。workflow完整记录SHA256仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`；原parent与历史corrupt child存在，未替换或伪造其旧ephemeral线程。插件Junction指向D盘当前仓库，provider/profile/凭据保持；未commit/push/publish，持续优化目标仍active。
