# 第74轮：租约续租定时器异常隔离

状态：第74轮完整验收及正式加载完成，新PID41660。verify/release各1463/1463、host加载/恢复及diff通过，217份build与正式会话/记录核对通过；原自然通知时序仍未单独定位，持续优化目标active。

## 基线与受控交接控制

HEAD保持abb6174及全部dirty；只读正式查询确认413个会话身份、111条workflow完整记录保持，running/waiting0，原parent和历史corrupt child保留。原正式PID4448/birth2026-10-09T03:29:22.6331920+08:00。

本轮证据目录../.codex-workflow-verification/seventyfourth-20261009/。调查前轮自然通知缺失，控制原SubmissionExecution首次load，真实SQL释放startup lease并调用原loss callback，结果heartbeatRegistrations2/modelTurns0/child1/dispose1/backgroundTasks0。初次probe未提前消费start晚拒绝，自己的client.stop触发诊断错误；纠正后exit0，控制表明该交接没有发模型，不能当作缺陷。

## 实际SQLite RED

原workflow.ts副本保留。heartbeat-busy-probe.mts创建实际第二个DatabaseSync连接并BEGIN IMMEDIATE，只在隔离库将busy_timeout缩为10ms，原timer续租抛database is locked。观察uncaughtTimerErrors2、leaseLossCallbacks0、modelCalls0，退出1；诊断错误拦截仅为记录并释放自己事务，生产不安装全局uncaughtException handler。

新增7项原实现测试：busy/busy-unobserved/error三项实际续租异常RED，revoked/stop/peer3有效控制通过，healthy原来要求精确3次timer但实际2次，属断言采样错误。修正healthy为已执行续租且之后继续增长，保留原RED日志，不把该采样失败当作生产缺陷。增加活跃Reviewer实际SQLite竞争控制，总计8项。

## 实现与局部验收

生产只改makeManagerLease的heartbeat renewal：try原renew，异常时ok保持false，沿原失败路径clearInterval并调用原onLost一次。显式renew/release错误不变，数据库正式busy_timeout不变；无额外重试、Thread替代或模型回放。

8/8通过，22.07秒；类型检查通过。实际busy probe GREEN为uncaught0/loss1/models0，退出0。live-busy真实上游fixture已有一个active原Reviewer，SQL renewal失败后原cancel路径结束turn并释放child，仍只有原thread/turn，无新增模型；peer/健康/显式stop控制保持。

原exec9278明确terminal exit0，13个相关完整文件53/53、失败/取消/跳过0，52.69秒，文件并发2；覆盖原startup/late receipt、共享owner/retirement、test cancellation、new business round与unavailable routing、heartbeat注册及consumer。测试actor增补时的语法错误已修正，未作为有效结果；原有效RED/正式失败记录保持。

## 外部研究和完整门禁边界

[proper-lockfile/Node固定机制](../research/github-lease-heartbeat-error-patterns-2026-10-09.md)核对5份原字节、Git blob和许可，Context7确认更新错误/compromised处理。采用失败通知责任，保留本地保守取消和SQL fence，不复制外部默认throw或文件锁阈值。

完整测试预期1463（原1455+8）。本轮生产有变化，因此完整verify/release、host加载/恢复和diff通过后，须再实时核对正式原实例及实际空闲状态，受控加载并比较新的前后持久数据。不能以53项局部结果放行。provider/profile/凭据、workflow历史和corrupt child保持，未commit/push/publish。

本轮证明SQLite续租错误不会逃逸timer、原owner只收到一次撤销；不声称已定位前轮自然通知未到达的具体时序。受控SQL竞争和本地模型fixture不等于正式provider故障、Token计费或浏览器交互证明。

## 冻结与唯一完整后台门禁

308份代码/测试/脚本及发布输入冻结并保存同数快照；manifest SHA256为`74023D7D469D3B21C728150695E2DAD1DD486C1FFFF90B8547E4893D77F9A5AC`。相对第73轮仅workflow.ts、README、CHANGELOG3份变化，新增heartbeat测试/actor2份；研究/迭代文档在冻结集合外。逐项hash偏差0，Junction仍指向本D盘仓库。

唯一门禁目录final-gates-1b544973-25fe-4b0c-80b2-43608fafec85/，依次verify、release、host、host-recovery和diff，阶段前后核对308份集合/hash。verify/release各要求1463/1463、失败/取消/跳过及异步警告0；TAP和文件并发2保持原场景时限及内部并发。隐藏后台单次启动，durable-gates-start.json保存PID/birth，finally保存实际完成收据；观察超时继续按原实例等待。

准备脚本由第73轮原helper改写参数并解析核对，没有覆盖原helper、原门禁或失败日志。操作helper仍绑定正式PID4448/birth2026-10-09T03:29:22.6331920+08:00/win32:134359613626331920，guard与retirement语法通过。当前尚无完整完成收据或最终build freeze，不放行正式重载。

## 测试启动前的操作守卫修正

第一次后台PID32764在05:44:45立即完成exit1，failureType RuntimeException；门禁目录为空，没有任何verify/release日志或模型请求。检查发现prepare脚本仍替换第72轮304/1448，而复制的是第73轮306/1455 helper，导致本轮源清单守卫仍306。真实freeze为308且hash保持；错误没有放行测试或正式重载。

原start/completion及操作helper保存为*.pre-count-repair。修正prepare替换的旧值为306/1455，实际gate/freeze/reload脚本一致改为308/1463，逐项校验不存在旧数、解析无错误、308份源码hash偏差0。确认原runner已退出且唯一门禁目录没有任何日志后，在原目录启动真正完整链；空目录重用仍拒绝有内容的原日志。没有重复已运行测试、改写失败证据或变更冻结源码。

当前真实完整链后台PID16192/birth2026-10-09T05:47:15.5530830+08:00/win32:134359696355530830，durable-gates-start.json保留新实例身份，prelaunchCountFailurePreserved true。后续等待该同一原实例和实际完成收据，不等待已结束的32764。

## 完整verify结算

原后台PID16192的verify明确exit0：1463/1463，失败/取消/跳过/TODO及异步警告0，942.75秒。原summary.json和verify.log保留，TAP数字直接解析，verify-completion-audit.json复核308份源码hash偏差0及本轮8个heartbeat场景在完整运行全部通过，包括真实active Reviewer SQL竞争后的原turn取消。

同一后台进入release，未因观察到期重开。post-verify-operation-audit.json确认三操作helper解析0错误、当前目录绑定、没有旧306/1455守卫、原正式PID4448出生键及manifest匹配、retirement语法通过。发布包审计、host加载/恢复及最终diff仍待结算，build-freeze/reload收据未生成，不放行正式重载。

## 最终完整验收

原真实后台PID16192保持其出生标识，durable-gates-completion.json明确06:19:03完成、exit0、failureType null；没有因观察等待到期重开验证。

| 门禁 | 结果 | 耗时 |
| --- | --- | --- |
| verify | 1463/1463；失败/取消/跳过/TODO及异步警告0 | 942.75秒 |
| release:check | 1463/1463；失败/取消/跳过/TODO及异步警告0，包审计通过 | 952.55秒 |
| host:check | exit0，安装宿主加载通过 | 4.10秒 |
| host:recovery:check | exit0，受控原线程恢复通过 | 6.27秒 |
| diff --check | exit0 | — |

本轮8项真实/受控heartbeat回归以及原callback/新审查/取消测试均在完整运行通过。离线doctor通过（5项skipped），release明确RELEASE_CHECK_OK、临时tarball清理完成，TAP计数直接解析。首次无测试的计数守卫失败及所有原RED记录保留，不把它们计为通过。

308份源码及集合冻结保持。最终217份build manifest SHA256为`E61812B809723A0C0F0F16CA1AAE325EE4C06B0C605801606E303B28903E589A`，build-freeze-receipt.json绑定原完整门禁。宿主恢复使用scripted-local网关及隔离存储，browserUIVerified false；不泛化为正式provider自然故障、Token费用或浏览器交互。

## 正式受控加载及数据保护

实时核对原PID4448/ISO及Windows出生键、原Node/DSH入口、3080监听、D盘Junction、actual running/waiting0，保存新的前置元数据后，仅执行一次controlled-reload.ps1。原exec62416明确exit0，原11个完整捕获实例确认退出，仅启动一个新正式实例：PID41660/birth`2026-10-09T06:20:24.8843430+08:00`。认证健康HTTP200，原入口和127.0.0.1:3080监听匹配。

formal-verification.json确认217份build及27个关键模块hash偏差0，413个会话身份和111条workflow完整记录保持，原parent/历史corrupt child保留，stderr致命匹配0，running/waiting0。workflow完整记录SHA256仍为`289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。

provider/profile/凭据保持，原模型上下文不伪造，历史损坏子会话不替换，未commit/push/publish。生产只包含本轮已证实的heartbeat renewal异常隔离；前轮自然通知未到达的特定时序依然未知，没有把它和这个真实SQLite异常混成同一根因。持续优化目标active。
