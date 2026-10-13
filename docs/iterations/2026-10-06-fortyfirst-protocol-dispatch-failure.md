# 第41轮：解析后协议异常与原回合终止清理

日期：2026-10-06。仓库 `D:/工作文件/projict/dsh-cc/dsh-codex-workflow`；上一轮已完成源码修复、1135/1135完整门禁与正式85376重载，属于progress。本轮保留已有修改、会话及历史失败，不commit/push/publish。

## 真实RED及准确边界

`onLine`原先只捕获JSON.parse异常，成功解析后`onServerRequest`／`onNotification`中的字段校验可以从Readline同步回调逃出。独立本地Node上游向已注册活动回合发送合法JSON输入请求，但缺itemId或threadId，SDK宿主默认fatal退出。

最小反馈1健康control及最多3候选：itemId缺失两次，threadId缺失一次，均实际未捕获；栈为string→onServerRequest→onLine→Readline。异常当刻原backend活、turn／RPC均pending、活动waiter1／控制RPC1，没有interrupt、业务结算或清理。宿主退出后backend在本机也退休，没有证明其继续运行；初版要求“host后仍活”的harness ERROR原件保留，不将它美化为全流程RED。

无人值守命令：`pnpm exec tsx "$env:TEMP/dsh-fortyfirst-malformed-frame-feedback.mts" missing-threadId`。最终artifact `dsh-fortyfirst-malformed-frame-feedback.results.json` SHA256 `5D8C97A284775DFAD5A5CD4F044506C7F840262675EE2711CDAFDD6D4BD6F187`。第二候选host76828/backend85128、第三host56040/backend61040；仅本地合成帧、没有emit假line／模型调用／配置修改，诊断PID均退出。

## 固定研究与最小采用

[vscode-jsonrpc／MCP固定研究](../research/github-jsonrpc-dispatch-error-isolation-patterns-2026-10-06.md)说明回调异常边界与业务终止是两层。Node Context7核对EventEmitter emit同步执行，captureRejections并不替代同步try/catch。vscode的类型参数检查不是完整deep Schema；MCP的unknown handler兼容与onerror包装也不提供本项目原cause、cleanup-only或模型预算保证，不能照搬。

MCP实际来源为modelcontextprotocol/typescript-sdk，非Microsoft仓库；许可迁移范围如研究文件固定原文，不笼统称MIT。外部tests只读取，没有复制框架、添加依赖或扩大CLI／UTF8／JSON噪声行为。

## 两处必要生产改动

- SDK隔离已JSON.parse后的handler异常；typed input／turn字段校验包装为带原cause的CodexProtocolError，RPC结果／transport错误保原类型。使用原ChildProcess、ThreadOwner及真实receipt注册thread/turn，在await onStarted／settings之前登记。
- 仅当前child、当前state registration和threadOwner唯一匹配时latch首错。protocolFailure先于completed结果或重发answers；可寻址原回合以cleanupOnly中断，ACK失败保原句柄和出生证据，不调用failProcess清注册，不拒绝无关metadata RPC。
- Planner runSingle先抛出cleanupOnly错误，交既有outer terminal guard；不把它保存成普通可继续模型失败。

本轮只有`src/app-server.ts`与`src/application/planner-execution.ts`改变，SHA分别 `A957FA866EEAB8AE39FFC26BED51D0C783C48C0982AB4D9441890F56C8B6E65B`／`6776086859542A22F4E4F79F2FE225ACC64D431E3E76ED59C600E8C7ACB8A507`。

无唯一归属的foreign／ambiguous／unscoped帧仅被消费，不冒认其他回合；没有新增-32602策略或对外诊断API。未知writer且原turn/start receipt尚未返回的完整处置没有本轮反馈，不声称全协议异常均有业务终止保证，也不清理或伪造其原receipt。普通unknown通知仍兼容。

## 持久回归与冻结

新`test/app-server-protocol-failure.test.ts`在旧源得到4业务RED／1healthy GREEN，失败为actual stdout schema frame导致uncaught-monitor，而非缺API；onStarted受控handoff时waiter0但真实receipt已返回也捕获该窗口。独立actor自然退出，完整原tree按既有15秒期限确认，仅处理自己的诊断资源。

修复后5/5 GREEN：有效输入＋unknown通知、known／handoff首cause及ACK、foreign／ambiguous不借tuple、真实Planner失败ACK保原child／turn／pin／awaitingCleanup／自动0，手动resume只cleanup，确认后回收一次且没有新model turn／thread。测试分别按既有公开合同捕获failedACK resume throw和confirmedACK返回failed canonical record，生产合同未为测试改写。

相关旧core42／cleanup-only16／owner6／Plannerterminal11共75/75 GREEN，typecheck0，同行只读peer无遗留问题。新增test SHA `E0FE7E6DBE372A66B035D99A5A8C3FA76DDDB35F5CED49DEE593F8FCA4819A27`；actor `DF3379F2F74B0723B9BDD8F73855E9348E8D7512116F7F5DC9576BDA46036B54`；protocol `1F84543507460EFF76BB1EB54DA9F04E7ABF3C2DB541B121E4861400C1FEB3AF`。

基线 `%TEMP%/dsh-fortyfirst-baseline-c4feff0e-2a2c-45e8-b188-24a3f2367d9b`无新dependency Junction；旧含Junction基线仍禁止递归删除。71个source／145个test/fixture已冻结，完整123个测试文件以并发2运行，目录 `dsh-fortyfirst-final-gates-c8d2a7cb-167f-49b9-8463-2aa52c666517`；原断言与内部并发保持。最终门禁和正式重载待追加。

正式85376仍411会话、runningIds=[]／waitingWorkflowCount=0，未故障注入或修改历史corrupt会话／provider／凭据。没有真实模型、费用或完整浏览器UI验收；持续优化目标保持active。

## 最终门禁与正式重载

上节保留执行中的状态；随后全部123个测试文件以文件并发2完成门禁。

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 1140/1140，410.11s |
| `pnpm release:check` 第一次 | 1140/1140，391.01s |
| `pnpm release:check` 第二次 | 1140/1140，380.20s |
| `pnpm host:check` | exit0，4.72s |
| `pnpm host:recovery:check` | exit0，7.87s |
| `git diff --check` | exit0 |

三次完整套件失败、取消、跳过、异步异常均0，两次offline doctor／pack审计和tarball清理通过；5项正式Codex检查仍按offline契约skipped。summary和日志保存在上节门禁目录。新增无人值守真实pipe回归反复覆盖known、handoff、foreign／ambiguous与Planner清理模式，不用这些结果冒称未知writer策略已验证。

重载前复核71个source／145个test/fixture冻结哈希，差异0，211个构建文件保存到 `dsh-fortyfirst-build-freeze.json`。原85376的准确命令、监听、411会话、runningIds=[]／waitingWorkflowCount=0均实时确认后，只停止该原进程树，用原profile／参数隐藏启动67176。

新67176监听 `127.0.0.1:3080`，认证HTTP200；旧85376已退出。411会话不变，原父会话 `session-1f26c68f-4026-41e2-bca9-0d0b5812fe55` metadata保留，111条workflow的有序整体SHA256重载前后相同。211个构建文件与receipt的19个模块哈希全部匹配，stderr fatal匹配0，当前runningIds=[]／waitingWorkflowCount=0。

证据 `%TEMP%/dsh-fortyfirst-reload-receipt.json`、`dsh-fortyfirst-formal-verification.json`、formal-metadata-before/after.jsonl。原已注册回合的协议contract错误能controlled结算、保原ACK失败清理句柄并禁止模型继续；无唯一归属的消息不伪造tuple。未知writer且receipt未回的完整业务处理仍未覆盖，未新增对外unscoped诊断API。没有正式provider故障注入、Token费用或完整浏览器验收；旧会话／配置保全，目标保持active，未commit/push/publish。
