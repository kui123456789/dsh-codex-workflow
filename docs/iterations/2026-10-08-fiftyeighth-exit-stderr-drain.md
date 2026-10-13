# 第58轮：实际退出后原stderr诊断丢失

状态：第58轮完整验收与正式加载完成。verify及连续release两次均1284/1284，host加载/恢复和diff通过；正式PID130352，412个会话身份与111条workflow完整记录保持。总体持续优化目标active。

## 基线与现场

HEAD `abb6174d283ced56590bee90b3511948e494b3f0`，既有dirty保留；SDK源码SHA256仍为第57轮 `F553FCAE28A061D9203CEB8B5B23A66660885152A13102C561D461FBD5F4B0BB`。只读正式核查412sessions/111workflows、完整身份/记录hash及原parent/历史child保持，available/running/waiting均0。没有中止正式服务或更换provider/profile。

## 实际最小反馈循环

在D盘仓库执行 `node --import tsx ../.codex-workflow-verification/fiftyeighth-20261008/late-stderr-probe.mjs`。它使用真实SDK和本地backend，完整原birth采集后暂停原stderr消费；backend写完整中文再实际exit42。第二次有序监听的执行耗时1.82秒，exit1：原exit先发生、60字节后到达，但SDK错误诊断为空，完整pipe文本断言及原树退出证明均通过，错误尾部断言RED。

原进程120204/birth `win32:134358828954523220`及原conhost124576/birth `win32:134358828954992930`保留在实际证据；这里只描述该次现场，不用这些历史PID发起新操作。初次记录把exit写在Promise回调里，有微任务顺序偏差；初版JSON/log保留，第二次以同步exit事件更正记录并再次失败，不能把初版次序冒称OS事件顺序。

证据在仓库旁 `fiftyeighth-20261008/`：`late-stderr-red.log`、`late-stderr-initial-result.json`、`late-stderr-ordered-red.log`、`late-stderr-result.json`。SDK原文件另存 `app-server-before.ts`，没有伪造事件、替换SDK方法或模型调用。

## 诊断与实施要求

假设依次核查：退出时owner提前清空会丢掉真实晚到数据；decoder过早end会损坏未完成字节；首个transport错误可能覆盖退出诊断。当前源码和有序事件明确支持第一项：on exit清空child后，stderr listener在解码前被owner guard拒绝；实际错误仍带原exit42，完整源字节已证实。[固定Node/Execa研究](../research/github-exit-stderr-drain-patterns-2026-10-08.md)确认exit并非stdio结束。

实现须保持原进程立即不可用，同时在有界诊断收尾后结算原失败，并把后继启动与旧失效通知分开。模型继续不得借此新建Planner/Reviewer，原UTF-8、字符尾部预算和OS出生身份清理规则保持。需要真实晚到尾部、有存活继承管道的有界失败、停止与后继owner隔离控制，再执行完整类型/测试/发布/宿主门禁。

初始RED阶段未修改生产代码、创建正式验收会话或调用真实模型。不能把RED、源码研究或第57轮旧门禁写成第58轮已修复、已验收或已加载。

## 实施与有界收尾

上述段落记录初始RED阶段。当前SDK只改原exit诊断生命周期：实际exit同步清空child并登记原失效/出生证据，原stderr闭包继续接收其缓冲字节；end/close/error或100毫秒期限结算一次，flush UTF-8 decoder并生成原退出错误。超时明确附带 `stderr diagnostic stream did not finish before exit deadline`，原16384字符尾部和低surrogate裁切保持。

原LostAppServerProcess保留仅进程内的diagnostic promise；后继启动及stop先加入这个有界失败结算，再沿用原OS实例清理。初始化正在读取出生证据时也等待原exit诊断。普通stop没有额外空Promise等待；已有RPC/turn计时器保持。没有以stdio关闭或诊断超时替代树退出证明。

## 回归与实际未确认结果

`test/app-server-exit-stderr.test.ts`新增4个真实本地场景：实际exit后晚到stderr、存活继承writer的有界失败、同地址后继、exit收尾中stop。原late回归先确定RED：`exit-stderr-test-red.log`，原完整尾部断言失败；最初外部探针现已GREEN：`late-stderr-probe-green.log`，60字节完整诊断进入原exit42错误，原树退出证明通过。

第一版继承fixture使用IPC/单fd继承，实际reader在根退出时已经end，不能证明保持打开；两份未通过日志 `exit-stderr-first-green.log`、`exit-stderr-inherited-control.log`留存。改用仓库已有的detached+inherit构造，writer在写入真实stderr后发布文件ready，原birth采集后才退出根。`exit-stderr-detached-control.log`通过，实际reader保持打开，writer heartbeat继续且原树未退出；SDK只有诊断期限结算，后来独立清理才确认退出。

一次四项运行3通过、late在最终原树退出证明上未确认，`exit-stderr-four-green.log`为实际exit1；原目录保留，不能冒称4/4。该次原断言证据未完整落盘，尚不能确认具体查询原因。随后改进测试失败证据记录并要求captured birth包含真实writer；完整17项诊断组合 `exit-stderr-controls.log` exit0，17/17，55.44秒，原UTF-8、当前/退休stderr错误及实际迟到管道隔离都通过。

类型检查及diff通过。SDK当前SHA256 `20491F33115A021C657746B18769FDDB7816E0555902E74E3E1CA5C047549AF8`。原exec29390执行6个生命周期文件控制，日志 `exit-stderr-lifecycle-controls.log`；测试期间未修改这些输入。当前总测试预期1284，完整verify、连续release、host/恢复、freeze及正式重载仍待执行。README、CHANGELOG和release清单已说明诊断期限、原失败屏障和独立退出证明。

## 完整门禁启动

原exec29390明确terminal exit0：6个文件71/71，fail/cancelled/skipped0，251.83秒。断言失败现在保存原错误和已有证据，初始化缺少完整birth仍失败；不对不完整历史采集伪造退出证明。继承场景另要求采集包含实际writer的出生身份。

冻结275份输入与同数副本，包含src/test/scripts、package/lock/tsconfig/patch及发布README/CHANGELOG/LICENSE；没有复制依赖。manifest SHA256 `78AB2C1C647F0F3577847B666A14446CF9DABBB0815F9407E0817392A4F101F2`。每门禁前后核对文件内容和完整输入目录清单，发布文档亦不再中途编辑。

新原exec42896、目录 `final-gates-c6603f51-8c61-45a5-a69f-da132af155b5/`，执行verify、连续release两次、host、host-recovery及diff。完整预期1284，独立文件并发1；原内部并发及预算保持。当前运行中不能生成最终build freeze或重载。

受控操作helper已从上轮已验证版本准备，固定当前正式PID130184、birth `2026-10-08T05:31:20.9656950+08:00` / `win32:134358822809656950`，引用本轮唯一目录及275/1284新输入；脚本解析0错误，没有执行重载。正式pre-auth使用第57轮TEMP状态，新状态和stdout仅在第58轮独立TEMP文件。真正重载仍须原门禁terminal exit0、冻结一致及正式空闲。

本轮原完整verify已明确exit0：1284/1284、fail/cancelled/skipped均0、异步警告0，1806.41秒，完整 `verify.log` 和 `summary.json`保留。原exec42896仍执行release-1，未重新启动门禁。当前尚无连续release、host/恢复和最终diff结果，也没有生成build freeze或正式重载；第57轮运行不因此被写成第58轮已加载。

本轮原release-1已明确exit0：1284/1284、fail/cancelled/skipped均0、异步警告0，1739.43秒。`RELEASE_CHECK_OK`确认类型/测试/构建、offline doctor（5项明确skipped）、包审计及临时tarball清理。原exec42896继续release-2，第二次release及host/恢复/diff尚待结果；没有重开原链、生成build freeze或正式重载。

release-2等待期间核对受控操作helper：生成最终build清单与重载均校验本轮固定manifest哈希及完整输入目录集合，重载另校验build清单集合与原门禁目录关联receipt；已有reload receipt时拒绝再次启动，避免观察超时被当作新启动授权。这些改动只在仓库旁操作脚本，275份冻结产品/发布输入未变。两脚本解析0错误，当前未完成release-2时实际调用freezer被正确拒绝，`freeze-incomplete-guard.log`保留，build-freeze.json未写入。原exec42896保持running，不把脚本准备或局部通过当作正式加载。

## 最终验收与正式重载

以上门禁段落为按发生顺序保留的观察。本轮原exec42896现已明确terminal exit0，六项门禁完整结果保留于 `final-gates-c6603f51-8c61-45a5-a69f-da132af155b5/summary.json` 及原日志。独立文件并发1，原场景内部并发、模型/控制预算及进程清理证明保持。

| 门禁 | 最终结果 | 秒数 |
| --- | --- | --- |
| verify | 1284/1284，fail/cancelled/skipped/异步警告均0 | 1806.41 |
| release-1 | 1284/1284，RELEASE_CHECK_OK | 1739.43 |
| release-2 | 1284/1284，RELEASE_CHECK_OK | 1892.09 |
| host | ok=true，安装宿主0.1.7-rc.2，exit0 | 4.38 |
| host-recovery | ok=true，安装宿主0.1.7-rc.2，exit0 | 9.94 |
| diff-check | exit0 | — |

两次release均通过typecheck/test/build、offline doctor（5项明确skipped）、pack audit及临时tarball清理。最终217份build清单在原链终态后生成，关联本轮唯一门禁目录；275份冻结输入及完整目录集合保持一致，manifest SHA256保持。build manifest SHA256为 `868322DBD37A1300E86E7B32B297877175AEC2990490EB9D5E8C68DBCCE0F4FF`。

正式服务空闲且原PID130184/birth及启动命令/listener核对后，受控reload原exec81719明确exit0：捕获11个原实例并确认全部退出，只启动一次新PID **130352**，birth **2026-10-08T07:49:43.9657780+08:00**。认证交换303，健康HTTP200，监听 `127.0.0.1:3080`。认证state与formal stdout仅TEMP未输出内容。

`formal-verification.json` / `formal-plugin-provenance.json`核对：217份build及27个关键模块哈希0偏差，275份冻结输入0偏差；412个会话身份与111条workflow完整canonical记录保持，原parent及历史child存在，running/waiting0，stderr fatal扫描0。正式profile声明和插件Junction指向当前D盘仓库，linked SDK为本轮构建。这里只证明会话身份集合，未冒称全部历史消息逐字比对或旧corrupt模型上下文修复。

- Session身份SHA256：`579e3efe69e5323d7b143b014f9995b87059d0cfc923474c8efdb8848d962145`。
- Workflow完整记录SHA256：`289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`；recipe为 `SELECT id, revision, record_json, updated_at FROM workflows ORDER BY id` 后 `JSON.stringify(rows)`。
- 正式linked `lib/app-server.js` SHA256：`76E4CE67C0D9B7AA8AF796D34D2F341381CC000B94D5A2988D9C3956F664B727`。

本轮证明实际退出后的缓冲诊断恢复、有存活继承writer时的有界失败、后继及stop隔离、完整本地门禁和正式加载/记录保护。诊断期限到达不能证明整树退出；本地fixture及宿主恢复检查也不证明provider自然故障、真实Token费用或Linux实机行为。早期未确认控制日志保留，具体系统查询原因未冒称已知。未改provider/profile/凭据，未commit/push/publish；持续优化总体目标保持active。
