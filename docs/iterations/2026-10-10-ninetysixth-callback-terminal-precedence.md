# 第96轮：回调终止错误禁止继续

状态：第96轮完整验收及正式加载完成。修复后原62488真实exit0，verify/release各1645/1645、172原文件摘要、host加载/11恢复/diff通过；正式65896加载217份已测产物，414会话/429文件及111workflow/119queue完整保持。原21308的1644通过/1取消及清理证据保留，总体目标active；第97轮另开独立门禁。

## 问题与候选范围

[原RED调查](../research/callback-timeout-terminal-precedence-investigation-2026-10-10.md)的8项2通过6失败及request统计保留。进一步确认inner OR与outer timeout/rate-limit/writer fallback两层绕过统一终止分类。只修inner不足以禁止将终止结果park，故候选集中改src/app-server-callback.ts两层，不修改原pipeline或新建replacement路径。

[p-retry终止机制研究](../research/github-callback-terminal-precedence-patterns-2026-10-10.md)保存固定SHA的index/license两份Git blob/SHA256，Context7核对AbortError在retry回调前短路。仅借鉴优先级分工，本项目复用现有分类，没有依赖或scheduler替换。首次单独base64源码读取记录保留，后续完整API响应/原字节核验保存为正式来源。

## 已取得结果

候选13项新增：六类附timeout的原终止/具体错误、两个合法recoverable对照、Schema/permission/403附rate-limit/writer及具体control timeout四控制、两次generic失败后retained Reviewer手动继续。初步35/35及typecheck通过；之后完整9相关文件95/95、负计数与async warning0、native exit0及signal null保存candidate-controls.json。

原Schema/权限等错误现在只发一次visible请求，不触发onContinuation或conversion；原订阅/pin释放。两次generic失败仍为waiting/retryable，original Reviewer只创建1，手动resume为短continuation，成功释放一次。真实RPC/interruption barrier/start receipt、caller cancel/stop、owner与usage控制通过；不意味着真实provider费用已验收。

README/CHANGELOG候选说明与src/test4份base/candidate hash固定，prepared-candidate.json标记adopted false。没有写canonical lib，没有替换当前327输入，不提前合入或沿用第95轮的完整计数。下一步必须在原第95轮完整链和精确加载之后再比较base、备份旧字节、采用并运行新的1645全量链。

## 后续实际合入与原新门禁

第95轮原50548完整verify/release各1632/1632、171native摘要、host/11恢复/diff及真实exit0通过，精确加载formal22108、217产物/全部历史保持后，才采用本候选。adopt脚本先读取第95轮完成/deployed回执，逐一确认原327输入与4份prepared base/candidate hash，再备份旧字节、wx创建新回归并合入；adoption-receipt标记newTests13、expectedFullTests1645、canonicalBuildWritten false，没有重置dirty工作。

07:27原CLI21308启动，observer29564保留真实原OS句柄/birth；证据isolated-rkLIyY，328输入/172测试文件。原文件并发1、场景内部并发/断言/时限保持。独立source/stage/4合入文件与217正式content/metadata核对通过，成功artifacts和delivery/reload回执尚未出现。本轮不能沿用第95轮或95局部控制为1645放行。

交付helper已改绑原formal22108/birthKey `win32:134360618604983240`和原gate，只允许精确已测callback.js及对应map变化；原217rollback、双查Agent/恢复/guard/queue资格和429稳定baseline、原tree退出与一次启动后继条件保持。当前helper仅准备，通过语法检查，未实际停正式服务。真实provider/费用仍未验收；第95轮原措辞修正已加载，本轮分类修正仍在完整验证中。

## 原完整门禁失败及清理调查

原verify第283项`explicit stop cleans the adopted shared Reviewer and original child once`报告`testTimeoutFailure`，90秒原时限未改，原worker23748及其fake App Server49056在测试取消后仍存活。不得将这一门禁列为通过或用单独成功覆盖原失败。

只在确认原native超时已终止该测试、backend49056的parent23748/命令指向原stage及birthKey `win32:134360625245192250`后，按完整原tree证据清理这个假backend。07:44:07确认退出，未停止正式服务或重启完整门禁；原worker随后产生file摘要并继续下一文件。`failed-fixture-original-tree.json`及`failed-fixture-cleanup.json`保留身份和结果。

仓库外同一停止用例带阶段探针单独通过1/1；随后连续20个原停止场景全部通过。没有复现自然超时原因，也没有证据将它归因于本轮callback分类修改。

另一个可独立复现的缺口已确认：此观察测试文件的四个调用方未传`TestContext.signal`、未使用已有fixture.step，也未注册after清理。受控阻挡原takeover通知，真实Node测试4秒超时后，旧调用方仍持有假模型进程；只在仓库外接入已有signal/step/after后，同一超时仍以exit1报告，但原fixture自动清理，worker自然退出并报告准确等待阶段。原测试30/90秒限制及业务断言没有更改。`observation-cancellation/red.log`、`green.log`和两份completion保留失败与清理区别。

候选仅修改该测试的调用方，生产stop/pipeline与fixture不改；正在候选副本运行相关测试，canonical328输入与217产物继续保持。原完整门禁仍在同一21308实例执行；未结束前不得合入候选、重开完整门禁或放行正式加载。受控超时的清理修正不等于自然等待竞态根因已定位。

## 原失败结算与修复后新门禁

08:07:17原21308真实exit1，OS句柄观察器29564保存原birth及终止收据。verify1645总项、1644通过、失败0、取消1、跳过/TODO0；172份file摘要、1份cumulative和complete标记齐全，唯一负项对应上述观察测试，异步警告0。原328输入及217正式产物内容/metadata偏差0；捕获的20个原实例全部退出，原stage命令的Node进程数0。`failed-full-audit.json`明确gatePassed false，release/host未运行，不能沿用原stage交付。

固定[Node取消清理研究](../research/github-observation-test-cleanup-patterns-2026-10-10.md)补充安装版本v24.14.0的源码、文档、许可证三份原字节及Git blob/SHA256；Context7重新核对取消和after机制。候选完整相关6文件20/20、负计数0及typecheck通过；受控native timeout仍是exit1，清理后自然退出。格式整理只调整诊断标签和缩进，所有原时限与业务断言逐项比较保持。

08:08:01在确认原失败实际结算、完整收据与进程退出后，备份测试/README/CHANGELOG三份旧字节，逐项比较base/candidate hash再采用；原`src`及fixture未额外修改，canonical lib未写。初始分类四文件与本次三文件合并为五个唯一变更文件，新完整预期仍1645项/172文件/328输入。

08:08:08仅启动一次新CLI62488与原OS句柄观察器61924，证据`isolated-ZW8fDG`。启动脚本读取重定向日志遇到Windows共享冲突；原gate已经运行，随后通过共享读获取实际证据、核对同一PID/birth/命令并补齐helper绑定，gateRestarted false。旧失败目录与原收据保持；后续交付helper只绑定新证据和62488，原失败helper不能放行。

08:08:57独立核对新328源/stage输入、五份已采用文件及217正式内容/metadata偏差0；新verify开始，尚无完整结果。文件并发1、原30/90秒场景限制与内部并发不变。正式PID22108未停，尚未创建rollback、交付产物或重载；必须获取新完整verify/release、host/11恢复/diff及真实exit0后才能继续交付。

## 后续现场与独立候选

新verify原观察测试4/4及文件native摘要已通过，原第283项停止用例包含其中。原自然90秒超时原因未确认；本次成功与受控超时清理机制分别记录。08:31同一62488仍live，verify1156项通过、127文件摘要、负项0；完整链未放行，未因等待重开。

08:24正式原临时认证state消失，但原PID22108/birthKey、启动命令与3080 listener保持。未推断消失原因、未打印启动token或cookie；用同一实例原启动日志重新交换临时cookie state，303成功、health200。独立metadata仍414会话、111workflow/119queue，完整记录哈希保持、Agent可用0、running/waiting/pending/active lease0。`original-auth-state-refresh.json`保存脱敏现场；serviceRestarted/profileChanged均false。

第97轮独立探针确认旧submission迁移的writer匹配绕过终止分类：六项2通过4失败，原权限/Schema错误被改写为原资源不可用；既有资源保护阻止额外模型请求。仓库外候选新增统一分类检查，六项6/6、legacy迁移1/1、原终止审查策略2/2及typecheck通过。候选四文件hash已封存、尚未合入；新1651/173/329预期不能用于本轮。详细来源和边界见[旧迁移分类研究](../research/github-legacy-recovery-terminal-patterns-2026-10-10.md)。第96轮冻结src/README/CHANGELOG/test与217正式产物保持。

## 修复后完整verify结算

08:37:15新门禁62488的verify真实exit0，1645/1645，失败/取消/跳过/TODO和异步警告0，172份原file摘要及1份cumulative、complete标记齐全，原生runId `a1aa2883-9ae0-45ab-9e99-a2aa2d860e39`。耗时1736.33秒；原21308的1644通过/1取消未改写。

`independent-verify-audit.json`逐项核对原日志、file集合、累计计数及328份源/stagehash，没有拼接局部结果或沿用旧门禁。同期独立audit核对五份合入及217正式产物内容/metadata偏差0。08:37:15.943同一62488进入release:check，runId `2446049f-eeda-4fcf-81c8-df71e1f8e0cb`，没有重新启动完整门禁。

原OS句柄观察器仍等待62488全链退出；release、host加载、11恢复与diff待完成。正式DSH22108仍加载第95轮，没有创建rollback或执行重载。完成封存helper已绑定62488/1645/172和旧失败保留证据，仅准备、尚未执行。第97轮候选保持仓库外，不能以本次首轮verify提前采用。

## Release原失败场景二次核对

08:45原62488继续release，322项通过/负项0、40文件摘要；`bridge-shared-reviewer-observation.test.ts`原native文件摘要再次success true，四项全部通过、取消/失败/跳过/TODO0。该文件包含原超时的停止测试，与首轮verify4/4及受控native-timeout清理证据共同保存，`release-original-case-observation.json`不将整个release标为完成。

原21308失败门禁和取消记录保留；两次自然通过仍不能确认最初90秒等待的确切原因。冻结328输入/217正式产物偏差0，原DSH未重启。第97轮已准备采用和一次隔离gate启动助手，绑定实际第96轮后继PID/birth才能执行；当前仍未采用/启动，不影响本轮完整输入或计数。

## 完整门禁和受控交付结算

09:06:11原62488及其OS句柄观察器61924确认实际exit0。verify/release各1645/1645，172份file摘要、1份cumulative及complete收据分别齐全，所有失败/取消/跳过/TODO和异步警告0；release标记RELEASE_CHECK_OK、offline doctor通过（5项skipped）、包审计通过、临时tarball清理。host加载、11个原线程恢复/冷回放场景及diff均exit0。独立最终audit逐项核对328原输入/217旧正式产物，允许差异只为callback.js及map两份。

正式重载前双查实际Agent可用0、running/waiting/pending/active lease0，原取消历史marker和定向休眠inbox保持。备份217份原产物，捕获正式22108/birthKey `win32:134360618604983240`原树11个实例，确认全部退出后才写两份已测字节；只启动一次后继65896/birthKey `win32:134360680588615050`（09:07:38）。重载observer尚未完成时过早运行metadata因auth state尚未生成而ENOENT，原启动仍继续；等待同一操作auth/health完成后核对，不重启后继或伪称该早期探测成功。

正式health200、启动命令/监听与实际birth匹配，217产物和receipt哈希偏差0、stderr fatal0。414会话身份、429份session完整文件（manifest `3f64bebf8cf8bd8e896a102ca2cd4039abd0f736b3955549a67f2750741ad9b9`）、111条workflow和119条queue完整哈希与前一致，原parent及历史corrupt child保持。原workspace/provider/profile未改；served client与正式boot注册检查通过，不将这些检查宣称为真实浏览器交互或provider Token费用验收。

`iteration-completion.json`绑定原62488成功证据、两次1645完整收据、原失败保留及正式65896，complete/deployed true。宿主恢复为scripted-local，browserUIVerified false；原自然90秒超时根因仍未定位。未commit/push/publish，持续优化目标保持active。

完成第96轮封存后，第97轮按原328输入/217已加载产物及四份base/candidate hash核对，备份旧字节并采用六项新回归与迁移分类修正；没有在采用阶段写canonical lib。原47664/birthKey `win32:134360681580520070`于09:09:18只启动一次，observer50120保留原OS句柄，在`isolated-9olNA1`验证329输入/1651预期链；本轮完成记录不覆盖下一轮验证。正式65896保持第96轮，后续进度见第97轮。
