# 第39轮：原进程实例的退出确认

日期：2026-10-06，仓库 `D:/工作文件/projict/dsh-cc/dsh-codex-workflow`。第38轮已修改源码、完成验收并重载86052，属于progress。本轮保留已有修改与失败记录，不commit/push/publish，不改变正式provider或旧会话。

## 原失败的边界与有界复现

第38轮两次完整门禁失败均发生在“captured original process tree exited”15秒等待、创建B／调用旧resume之前；当时日志没有具体存活PID。增加诊断后的完整verify和连续两次release通过，仍不能确认旧失败根因。

本轮以原15秒等待／原断言运行10轮、文件并发2，合30个原流程场景全部CONTROL GREEN。没有通过延长等待、过滤conhost或降低断言制造通过。一手before metadata却实际观察到数字PID重复，例如run6 Node60100创建于12:25:58.892Z，run7 conhost60100创建于12:26:09.545Z。复用现象是事实，但不能倒推原失败归因。

压力反馈 `node "$env:TEMP/dsh-thirtyninth-original-tree-pressure.mjs"`；results.json与run1..10日志保全。当前一次只读快照中的伪进程时间关系不是普通用户进程假PPID反例，不据此更改捕树规则。

## 新的实际RED

另一个有界反馈使用真实SDK后端历史集合：每个旧后端先捕获Node／conhost身份，再stop并逐PID证明ESRCH，身份查询为空；随后观察仍活的新后端。最多30次、并发2，实际22次即命中后停止，所有22棵诊断树最终退出，无伪造PID或stdin.write。

| 事实 | 实际证据 |
|---|---|
| 原Node／tree | index17，PID34064／[34064,75236]，原Node出生12:35:57.044Z |
| 原实例退出已证 | 12:35:59.623Z，全部旧PID为ESRCH，过滤身份查询为空 |
| 新实例仍活时 | index21，Node PID再次34064，出生12:36:02.079Z |
| 真实旧退出判定 | `terminalProcessTreeExited`对旧descriptor返回false |
| 真实持久守卫 | TEMP SQLite的`TerminalCleanupGuard.assertAvailable`拒绝同session的新工作 |

反馈脚本 `pnpm exec tsx "$env:TEMP/dsh-thirtyninth-original-pid-reuse-feedback.mts"`，完整结果 `dsh-thirtyninth-original-pid-reuse-feedback.results.json`，摘录 `dsh-thirtyninth-pid-reuse-authoritative-proof.json`。这是新的裸PID误阻塞缺陷证据，不是第38轮两次等待失败的根因证明。

## 固定研究与设计边界

[psutil与Microsoft官方资料](../research/github-original-process-birth-identity-patterns-2026-10-06.md)固定源码／文档版本、许可证和官方测试边界。psutil使用PID＋出生身份区分实例，缺失出生时间不能推断死亡；原Windows HANDLE属于原对象，按数字PID重新打开的句柄需要核对原身份。未复制框架、增加依赖或把模拟上游测试当本地复用证明。

拟采用一次捕获、不可变的原process-instance tree，保持原PID列表作为兼容诊断。Windows出生域为规范FILETIME字符串，Linux为boot-id＋/proc startticks，其他平台缺身份保持保守规则。全部原PID均ESRCH仍可确认；出现活PID时，仅原完整出生身份与当前实例确定不同才能确认旧实例结束，缺失／查询拒绝／不完整快照保持unknown，不拿当前出生时间补造原数据。

确认入口统一用于实际cleanup／新审查准入／创建准入，不给普通status加入CIM。异步查询后核对原lease owner／epoch及相关守卫，防止旧查询结果清除新守卫。不修改原thread owner、远端ACK、模型继续预算、conhost集合或原15秒测试期限。

## 当前状态

新确认逻辑与12处必要证据传播尚待持久回归RED→GREEN及完整验收。基线 `%TEMP%/dsh-thirtyninth-baseline-a1cfc077-b7fc-465d-a68f-432847549867` 已保存源码、构建、测试、脚本、文档，无新dependency Junction；更早含Junction的基线仍禁止递归删除。

正式86052只读核查为411会话，runningIds=[]、waitingWorkflowCount=0，未重载／故障注入。没有真实模型、Token费用或完整浏览器验收。持续优化目标保持active；后续结果按真实证据追加。

## 实施与冻结

实际改变11个生产文件，核心为`process-transport`、type/error、schema及terminal guard；其余是SDK、runtime、Planner／Reviewer／callback／workflow中的必要证据传递。旧PID-only采集API保留；`originalProcessTreeExited`统一异步确认。原出生不足时producer省略身份字段，避免把未知采样变成Schema错误；外来显式损坏／partial／unsupported身份拒绝确认。

持久`test/process-instance-exit.test.ts`先在旧实现得到1业务RED／3GREEN，拒绝发生在真实SQLite守卫入口而非缺新API。原／新birth查询是明确标注的确定性模拟；实际OS复用证明另保全在34064反馈，不在CI随机等待30次复用。随后补三个必要风险组，最终7/7 GREEN、typecheck通过：损坏完整性／出生域、查询期间新owner／epoch／新增守卫／SQLite CAS返回0，以及真实Reviewer error→runtime→retry出生证据和实际退出后无模型回放、一次清理。测试SHA256 `CC7E0DE80E8E3CAB0417CBF94CB0917F13687F89339A7F2255E40764E154D648`。

核心分工的新4场景和既有23场景通过，传播分工五个相关套件34/34通过；重复套件不相加计总数。两组互查确认SDK采样前后原child不变、完整不可变身份、异步返回后的scope／guard／lease复核、四条退出路径统一。普通status没有增加出生查询，模型继续和远端ACK边界保持。

Windows捕获和复查都用CIM CreationDate.ToFileTimeUtc的同一转换；真实只读本机样本Kind=Local。规范单位为100ns并不增加CIM来源精度，不冒称原生GetProcessTimes完整精度。Linux实现按固定psutil的`/proc/stat`第19个tail starttime和boot ID，当前Windows环境没有真实Linux内核验收。生产采集“部分出生信息缺失”分支经源码审查，尚无专用注入seam测试；新helper对缺失数据的政策已有确定性覆盖，不混为整个producer已验证。

71个source与139个test/fixture已冻结到 `%TEMP%/dsh-thirtyninth-source-freeze.json` 和`dsh-thirtyninth-test-freeze.json`；完整门禁以文件并发2运行，目录 `dsh-thirtyninth-final-gates-8e5bdfae-176e-4ae7-9573-79adfe0b5482`。原场景内部并发／断言未更改。最终结果与正式重载待追加，不以38门禁冒称39通过。

## 最终门禁

上节保留执行中的状态；之后实际完成如下检查。完整121个测试文件均运行，文件并发2。

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 1132/1132，342.37s |
| `pnpm release:check` 第一次 | 1132/1132，354.79s |
| `pnpm release:check` 第二次 | 1132/1132，464.70s |
| `pnpm host:check` | exit0，7.24s |
| `pnpm host:recovery:check` | exit0，16.41s |
| `git diff --check` | exit0 |

三次完整套件失败、取消、跳过、异步异常均0；两次offline doctor／pack审计及临时tarball清理通过，5项正式Codex检查仍按offline契约skipped。39结果存于上节门禁目录summary.json；38两次退出等待失败仍按其原结果保留，不因39通过而改写原因。

## 原反馈的真实默认查询GREEN

原RED脚本只带裸PID并使用旧同步API，不能直接重跑当新版GREEN。另存绿色版本，原守卫在原实例活着时保存SDK实际捕获的规范出生信息；原树先逐PID证明ESRCH后加入历史集合，后续真实复用时调用新默认OS查询与SQLite守卫，未从旧毫秒ISO记录补造FILETIME。

新反馈最多30次／并发2，实际26次命中止，errors0、26棵树最终均退出。原index2树 `[86732,89676]` 的89676出生为 `win32:134357667211635900`，13:25:23.593Z旧树已物理退出；新index24树 `[87360,89676]` 的89676出生为 `win32:134357667435753510`。**复用的是捕获的子进程PID89676**，不是新根PID复用。

新peer仍活时，`await originalProcessTreeExited`用原完整身份＋默认OS查询返回true，`await guard.assertAvailable`确认同token／epoch1的原marker。新SDK前后health为modelCount1，原child对象不变、stats全等；threadStarts／turnStartRequests／interrupts／unsubscribes均空，journal只有1次start。这确认原子树实例退出不会误伤新peer，不允许恢复已丢失原thread。

绿色脚本／results／log前缀为 `%TEMP%/dsh-thirtyninth-original-pid-reuse-feedback-green`；脚本SHA256 `E65175E804420526B42FA85D6DB637E7D0D9595A04276DF340EA718D3772452C`，results `6BF6C40B60A43BA93A9EDB535FC9B4B1C62504509D777D4F6241AC4150D00FEF`。原RED34064档案未改，两次真实复用属于同一误阻模式，不据此追认38两次失败根因。

## 正式重载与保全

71个source与139个test/fixture在全门禁后复核冻结哈希，差异0；211个构建文件保存到 `dsh-thirtyninth-build-freeze.json`。原86052的准确命令、监听及活动实时核对：411会话、runningIds=[]、waitingWorkflowCount=0。然后只停止该已确认的进程树，用原profile／参数隐藏启动89732。

新89732监听 `127.0.0.1:3080`、认证HTTP200，旧86052已退出。411会话、原父会话 `session-1f26c68f-4026-41e2-bca9-0d0b5812fe55` metadata保留；111条workflow的有序整体SHA256重载前后相同。211个构建文件与receipt的19个模块哈希全部匹配，stderr fatal匹配0，当前runningIds=[]／waitingWorkflowCount=0。

证据 `%TEMP%/dsh-thirtyninth-reload-receipt.json`、`dsh-thirtyninth-formal-verification.json` 与formal-metadata-before/after.jsonl。未改变provider／凭据、历史corrupt会话或建立替代Planner／Reviewer；未执行正式模型故障注入、Token费用测量或完整浏览器交互。Linux真实内核与producer部分出生缺失的专用测试边界仍如上节，不用Windows完整验收冒称全部平台覆盖。持续优化目标保持active，未commit/push/publish。
