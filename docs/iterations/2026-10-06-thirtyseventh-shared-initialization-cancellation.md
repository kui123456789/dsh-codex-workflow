# 第37轮：共享初始化的调用者取消隔离

日期：2026-10-06。当前仓库为 `D:/工作文件/projict/dsh-cc/dsh-codex-workflow`；保留已有修改。目标仍为持续优化；本轮不提交、推送或发布。

## 用户现场与恢复边界

用户贴出的说明将“start未返回workflowId”推断为“workflow记录不存在”，并认为start失败后永久禁止再次尝试。当前工具契约已经允许省ID的status/resume，重复启动提示也明确不是失败后的永久配额。

本轮仅查询正式DSH的会话metadata与只读SQLite，没有读取历史聊天或修改旧会话。子会话 `cbccaec0-9ecf-4253-8558-e3deaf875a40` 的父会话为 `session-b94b6958-59c0-48c9-84ad-b050b40d7f8e`。父会话保存两条记录：`a046a666-0bce-4be1-afe7-be1be9f6007e` 为failed，`9fb83c1b-e678-4ce4-ad9e-e23fd10e834a` 为cancelled；两者均未保存Planner线程ID。

因此no-active不是no-record。status不会从最新cancelled任务回退到更早failed任务；没有原运行态能力时，也不能把这些旧记录或本地child投影当成可恢复线程。首次save之前取消对应0record/0child/0thread；当前已进入child创建的路径先持久化记录。已有入口控制本轮实际23/23通过，包含未知thread启动诊断与所有权隔离。

这段现场不能证明下述并发初始化缺陷就是历史失败原因，也不证明历史corrupt会话可恢复。

## 真实RED反馈环

固定探针：`%TEMP%/dsh-thirtyseventh-shared-startup-authoritative-red.mts`，通过仓库的tsx运行。使用真实SDK、独立本地协议进程、原生DSH child和隔离SQLite，不调用正式模型。初始化ACK被fixture持有，明确观察B加入同一个starting Promise及同一个PID后才取消A。

| 场景 | 实际修复前证据 |
|---|---|
| A目录调用取消，B原生Planner仍等待 | B.signal未取消却继承A错误；原PID退出，唯一child被释放，记录failed，没有线程创建：RED |
| 后加入的B取消 | ACK前B未结束；ACK后B错误地fulfilled，A正常：RED |
| 正常原生Planner、全部取消、永久stop | 三个控制GREEN；所有七个诊断PID实际退出，清理EOF各一次 |

探针结果、协议与清理证据分别保存在同名前缀的results和authoritative-red.wire文件。临时材料不位于正式profile。基线 `%TEMP%/dsh-thirtyseventh-baseline-268bc45a-53a9-41cd-aae1-d26c0a9e133a` 含依赖Junction，禁止递归删除。

## 设计与采用

原因是共享starting使用首caller.signal，而joined observer直接返回共享Promise，没有自己的取消等待。采用初始化自己的controller与观察者登记；观察者取消只撤回自己的wait，最后观察者离开才标记abandoned并中断原初始化。新caller先等原cleanup，不能加入撤销中的初始化。ready后的迟到取消不关闭已接纳backend；stop维持永久禁止重启及原child一次清理。

来源：[固定VS Code与Effect源码研究](../research/github-shared-initialization-cancellation-patterns-2026-10-06.md)。只采用独立生命周期、最后消费者撤回和先detach再清理的接口原则；上游测试仅阅读，没有添加框架依赖或放宽原线程/process owner边界。

## 验收状态

待追加本轮回归RED→GREEN、原探针GREEN、冻结源码后的完整门禁与正式重载。此前第36轮1110/1110结果不作为本轮通过证据。恢复等待与初始化清理分开：本轮不伪造原线程、不新建替代Planner、不由父会话代写计划。未测真实provider故障、费用或完整浏览器交互。

## 源码冻结与目标验收

唯一生产改动为 `src/app-server.ts`；全部71个source和134个test/fixture文件已冻结到 `%TEMP%/dsh-thirtyseventh-source-freeze.json` 与 `dsh-thirtyseventh-test-freeze.json`。新增测试SHA256为 `69C8E3BB447AC8C1F4320DF727B3187DB80221BDC2A4C51A10194AAEC3F87CBC`。

- 初始两个新回归2/2 RED；补必要控制后实际7场景为5RED/2PASS，日志 `dsh-thirtyseventh-shared-init-cancellation-necessary-controls.log`。
- 修复后新回归7/7 GREEN，类型检查通过；跨await使用已settle的snapshot结果，保留全部身份和业务断言。
- 源码修复后的初始化／模型目录／线程owner目标组合34/34 GREEN。随后测试只修类型观察并延长fixture EOF退出窗口，不降低断言。
- 原权威探针另存 `dsh-thirtyseventh-shared-startup-authoritative-green.mts/results.json`，5/5 GREEN，全部六个诊断PID实际退出；首caller取消保住B的唯一原线程／child。
- 原SDK初始化、idle、stop/error相关控制7/7 GREEN；只读peer检查publication、ready、最后observer撤回、原cleanup等待及stop接管，没有发现可到达的新风险。

新回归的清理等待场景在实际原EOF且旧PID仍活时取消metadata观察者C；C及时返回自己的取消cause，其他fresh观察者D等待同一次原cleanup后合法初始化。EOF延迟1500ms，处于5000ms quitGrace内；没有用sleep推断清理完成，没有产生Planner替代线程。完整门禁已开始，目录 `dsh-thirtyseventh-final-gates-d40099a4-d943-4393-8b0a-a6bcb09bbe80`；正式79432尚未重载。

## 最终门禁与正式重载

上节保留执行中的状态；以下结果是之后实际完成的验收。完整118个测试文件均以文件并发2运行，场景内部并发与断言保持不变。

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 1117/1117，462.98s |
| `pnpm release:check` 第一次 | 1117/1117，417.37s |
| `pnpm release:check` 第二次 | 1117/1117，414.75s |
| `pnpm host:check` | exit0，6.12s |
| `pnpm host:recovery:check` | exit0，12.47s |
| `git diff --check` | exit0 |

三次完整套件的失败、取消、跳过、异步警告均0。两次release的offline doctor与pack审计通过，临时tarball均已清理；正式Codex检查5项按契约skipped，不能记作真实模型通过。结果保存在 `%TEMP%/dsh-thirtyseventh-final-gates-d40099a4-d943-4393-8b0a-a6bcb09bbe80/summary.json`。

重载前重验全部71个source与134个test/fixture的冻结哈希，差异0；211个构建文件另存 `dsh-thirtyseventh-build-freeze.json`。原79432的准确入口、监听、411会话、runningIds=[]与waitingWorkflowCount=0均实时核对后，才停止其进程树并用原profile/参数隐藏启动。没有修改provider、凭据或旧corrupt会话。

重载完成：旧79432已退出，新44296监听 `127.0.0.1:3080`，认证HTTP200；仍为411会话，原父会话 `session-1f26c68f-4026-41e2-bca9-0d0b5812fe55` metadata存在。111条workflow记录的有序整体SHA256在重载前后相同，两个历史父会话记录仍分别failed/cancelled且没有原线程ID。当前runningIds=[]、waitingWorkflowCount=0；211个构建文件与receipt的19个模块哈希均匹配，stderr fatal匹配0。

证据为 `%TEMP%/dsh-thirtyseventh-reload-receipt.json`、`dsh-thirtyseventh-formal-verification.json` 和metadata-before/after.jsonl。SDK协议／原生宿主恢复检查及重载健康检查已完成；没有在正式会话注入真实provider故障、测量Token费用或进行完整浏览器交互验收。原线程丢失仍明确拒绝恢复，本轮没有补造句柄或为旧任务建立替代Planner。持续优化目标保持active；未commit/push/publish。
