# 第60轮：重试等待后的预算接纳

状态：第60轮已完成完整验收并加载正式DSH，PID129228。verify/release各1303/1303，host加载/恢复与diff通过；首轮1301/1303失败证据保留。持续优化目标active。

## 基线与实际RED

本轮开始只读核对正式服务：412个会话身份、111条workflow完整记录及哈希保持，原parent/历史child存在，running/waiting0。HEAD仍abb6174，既有dirty保持；第59轮shared retry源SHA256 `317ED14CF6BB9627FB80C5F0884C3E989ECC8011BCC3ED8DA3637100800CF1F6`。

在仓库执行 `node --import tsx ../.codex-workflow-verification/sixtieth-20261008/retry-deadline-probe.mjs`，0.63秒exit1：budget50，wake clock210，calls2，额外操作成功返回。日志/JSON保留。三条实际重试入口的14项新增控制旧实现9失败5通过，`retry-wakeup-all-red.log`确认超预算、恰好截止以及可读回合取消接纳错误。

## 改动和局部结果

仅在 `src/transient-retry.ts`、`src/workflow.ts`、`src/codex-cli-audit.ts` 的原sleep后追加取消和同一deadline检查。control保留原错误对象/原因及真实attempt数；visible/CLI保留最后原结果，仍由原调用者分类为retryable。原线程身份、首次budget0、原操作timeout和独立一次continuation权限保持。

`test/retry-wakeup-budget.test.ts`新增5项，共享exact/late、inside、cancel、zero；既有CLI文件新增3项，既有Workflow文件新增6项，使用实际private retry入口及注入原gateway，不创建另一套测试循环。typecheck首轮因新增review选项少传detached失败，`typecheck.log`保留；不修改运行中的局部控制输入，原exec5725先明确terminal exit0，5个完整文件163/163，86.60秒。随后补齐detached，typecheck/diff及14项定向全通过，`retry-wakeup-typed-green.log`留存。

真实本地CLI探针 `cli-retry-deadline-probe.mjs` 使用原dispatcher和实际spawned Node backend：actualExitCode1、503原错误、clock210/budget50、starts1且retryable。对应JSON/log保留，未调用真实模型，不把此证明泛化为通用进程树或provider费用验收。

[固定p-retry/Node研究](../research/github-retry-wakeup-deadline-patterns-2026-10-08.md)确认5份源码字节与固定blob一致、许可保留。所选p-retry源码也缺等待后的时间检查，参考限于异步策略回调后的接纳原则；未增加依赖或切换默认时钟。

当前完整测试预期1303，verify/release/host恢复及正式加载尚须独立证明。provider/profile/凭据及旧corrupt未修改，未commit/push/publish；不把本次改动描述为全任务硬时限或取消已开始的操作。

## 完整门禁与当前失败观察

冻结277份源码/测试/脚本及发布输入与同数副本，不复制依赖。manifest SHA256 `862515901164CFD6E6F832BB0F4999C14D759B57FBCE7F64281CAF965C6475F1`。每门禁前后核对完整输入集合和各文件哈希。原exec5069，目录 `final-gates-4d7d87f4-2f2a-48c2-87a8-e529266412a8/`，执行verify、一次release、host、host-recovery及diff；预期1303，独立文件并发1，原场景预算保持。

首组既有 `1.1.3: a writer conflict on the Reviewer is retried, and a spent budget stays retryable` 标记失败，原完整verify尚在运行；具体错误栈须等终态。当前不修改冻结输入或重复启动门禁。源码核查发现该测试每读now就前进60000毫秒，预算120000，新增post-sleep检查读到180000的原deadline，旧断言仍要求至少2次resume。

独立纯控制探针 `clock-observation-probe.mjs`/JSON确认：read-advances采样 `[60000,120000,180000]`、calls1、reason active writer；同样120000预算采用stable now、每次sleep推进60000时calls2、采样 `[0,0,60000,60000,120000]`，耗尽后仍reason active writer。此结果支持测试时钟与边界不一致的判断，但不冒称已得到原完整失败栈；未来修正不得增加预算或授权截止后的操作。

正式操作helper仅准备，绑定原PID132660/birth `2026-10-08T08:59:48.2582700+08:00` / `win32:134358947882582700` 与本轮唯一目录、277/1303输入，解析0错误，未执行重载或最终build冻结。首轮失败日志保留，未用14项或163项局部通过放行。

## 原完整失败结算与时钟修正

原exec5069已明确terminal exit1：1303项中1301通过、2失败、cancelled/skipped0、异步警告0，1868.34秒。原门禁后续release/host未运行。完整 `verify.log`、`summary.json`留存，没有因中途观察超时重开任务或改冻结输入。

终态栈确认：`app-server-callback.test.ts:251`的“the conflict was retried”断言失败；`operation-budget.test.ts:81`返回planning而旧断言期待executing。第一项的read-advances时钟把等待后的预算读到原deadline，旧断言仍要求至少第二次resume。第二项的3x300000/600000模拟要求恰好deadline后的操作成功，和真实预算边界不一致。

只改两个既有测试：writer的now只读、sleep推进60000，原120000预算不变，严格断言2次resume和clock120000，耗尽结果仍active writer、旧Reviewer不释放。operation保留300000回退和600000预算，first phase实际唤醒耗尽，后两phase在budget前1毫秒成功；总elapsed1799998仍超过原两预算工具期限，turns[1,2,2]共5次同一线程、2次conversion。旧9次要求不再授权截止后操作。未修改生产源码或放宽tool/turn预算。

定向日志 `corrected-clock-target.log` exit0，2/2、5.73秒，typecheck-clock-corrected及diff通过。原exec11168执行5个完整相关文件，`clock-corrected-full-controls.log`留存，运行中不改输入。它终态后才能更新原freeze已解释的这两个测试路径，首轮manifest须另存保留，新完整门禁仍需包含所有1303项。

## 时钟修正后的完整链

原exec11168已明确terminal exit0：5个完整相关文件64/64、fail/cancelled/skipped0，60.44秒。没有用定向2项代替完整相关控制；生产3个改动模块保持，仍未放宽预算。

原manifest另存 `source-freeze-before-clock-correction.json`，原两个测试快照另存 `clock-correction-before/`。仅 `test/app-server-callback.test.ts`、`test/operation-budget.test.ts`两项hash有已解释更新，277份输入集合保持、0偏差；新manifest SHA256 `C9177FD6CBB3C6A1CD70DBB6B1E3AEAFC8387D36DCA7EFEFF02C3A09CAEEDC39`，`clock-correction-freeze-receipt.json`记录原/新关联。原门禁和操作脚本另存original副本。

新完整原exec83772，目录 `final-gates-6fb30ebc-e412-4f91-969b-6ae0e2aecb49/`；verify、一次release、host、host-recovery、diff均须成功，预期1303，独立文件并发1。只有原exec5069明确terminal失败且解释的修改完成后才启动这条新链，未因观察等待到期重开旧任务。正式重载helper仅引用新门禁和新manifest；最终build freeze及重载仍未执行。

接续只读核查：三个操作helper已绑定修正后的同一门禁目录与manifest，解析0错误，原首轮失败日志存在；writer预算场景在新完整运行中通过。原exec83772仍running，未据此放行重载。

正式现场有合法的新会话活动：session/list共413、available1、running1（`session-89eb60dc-992a-47de-bae0-1a6d6ad1f2cc`）、waitingWorkflow0。会话身份集合SHA256为 `f54dc700003c0eb8c13858e1668292a4e60863129acb525b992b95c8baa75293`，111条workflow完整记录SHA256仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`，原parent及历史child存在。该新增会话不是故障或数据丢失；未来pre/post应以重载当时实际身份为基线，不固定期待历史412。原会话运行时不执行服务重载，亦未读取其聊天内容或向它发指令。

## 修正后完整verify终态

新目录verify已明确exit0：1303/1303、fail/cancelled/skipped均0、异步警告0，1837.45秒。完整 `verify.log` / `summary.json`保留；原exec83772仍执行release，未因观察等待到期再次启动。原两项失败案例在本次完整运行通过，277份冻结输入0偏差。release包审计、host加载/恢复及diff尚待终态，build freeze与正式重载未执行，正式空闲仍须加载前实时检查。

## 最终完整验收与正式加载

原exec83772明确terminal exit0，沿用同一完整链，没有因观察到期重复启动：

| 门禁 | 结果 | 耗时 |
| --- | --- | --- |
| verify | 1303/1303；失败、取消、跳过与异步警告均0 | 1837.45秒 |
| release:check | 1303/1303；失败、取消、跳过与异步警告均0；包审计通过 | 1885.22秒 |
| host:check | exit0，安装宿主加载通过 | 4.43秒 |
| host:recovery:check | exit0，本地受控网关与隔离存储的原线程恢复通过 | 7.13秒 |
| diff --check | exit0 | — |

release离线doctor通过（5项skipped），临时tarball已清理。host恢复记录明确 `browserUIVerified: false`；原thread、原child和中断确认来自安装宿主的受控协议测试，不泛化为正式provider自然故障或真实Token计费。

277份输入保持修正后的manifest；最终217份build冻结SHA256 `65B025B880C9EE0FC79ED49BFFACA691B17D8AABD3E9CAC67DAD7115DCD66E55`，`build-freeze-receipt.json`关联本轮完整门禁。正式活动已自行结束，未强制中止用户工作；重载时实时确认running/waiting0，实际413个会话身份作为pre/post基线。

受控重载原exec78554明确exit0，只启动一次。旧PID132660对应捕获的11个原实例已确认退出，新PID129228/birth `2026-10-08T11:00:34.2682370+08:00`，原入口和127.0.0.1:3080监听匹配，认证健康HTTP200。`formal-verification.json`确认217份build及27个关键模块哈希0偏差、413个会话身份保持、111条workflow完整记录保持；原parent与历史corrupt child存在，未修复或替换历史不可恢复线程。workflow完整记录SHA256仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。

正式插件Junction指向D盘当前仓库。额外补充中文恢复指南的句柄找回说明：未返回ID先在原父会话查status，区分原记录缺失、回执待定和真正可继续；不得新建替代Planner或由父会话代写。该文档在冻结代码/构建之外，未修改门禁输入。未commit/push/publish，持续优化目标保持active。
