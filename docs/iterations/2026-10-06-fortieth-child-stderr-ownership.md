# 第40轮：子进程stderr诊断归属

日期：2026-10-06，仓库 `D:/工作文件/projict/dsh-cc/dsh-codex-workflow`。第39轮已修复进程实例确认、全验收并重载89732，属于实际progress。本轮保留已有修改、历史失败与会话，不commit/push/publish。

## 真实反馈与限制

SDK原先有共享`this.stderr`字段，startProcess清空；old child data回调直接写共享字段，当前child退出错误读取同一缓存。其他stdout／stdin错误／process事件已有原child绑定，而stderr缺此限制。

初反馈只运行1健康控制＋1候选，即取得真实RED：

| 场景 | 实际证据 |
|---|---|
| 健康旧流先关闭 | A79720真实8192字节排空且close，之后B64892退出42，无旧标记：CONTROL GREEN |
| 原stderr暂停＋真实终止 | A84800写512KiB被pipe阻塞，核验parent18164及创建身份后只终止该A；旧管道真实迟到65536字节进入新B62540缓存，B本身stderr0，公共错误含旧标记：RED |

权威时间线：A exit13:35:36.274Z且readableLength65536／flowing=false；B spawn36.332Z；A actual data36.333Z，当前SDKpid为B，随后A close；B exit42在37.379Z，公共pending错误约16424字节含旧标记。旧exit不等于stdio已关闭。本轮故障注入是受控暂停＋实际终止，不声称自然idle必然触发，也不伪造data事件或修改stdin.write。

初脚本 `%TEMP%/dsh-fortieth-stderr-origin-feedback.mts` 需要外部核验后终止被阻塞的A，不能直接当无人值守复跑命令。原results保留：`dsh-fortieth-stderr-origin-feedback.results.json`，SHA256 `629354E998AD5CAC24EE48F63EA2BE2036AA0ADB6AE07F0D902EEE4EB4C1D74B`；人工干预边界如实记录，不回写美化该原脚本。

## 固定研究与最小修复

[Node24.14.0／execa10.0.1固定研究](../research/github-child-process-stderr-ownership-patterns-2026-10-06.md)记录源码／许可证及官方测试边界；外部测试只读取。Context7的Node24文档核对exit/close契约：原process退出后stdio仍可开放，close是另一事件。Node execFile的每次调用缓存／execa的原stream上下文支持本轮局部诊断所有权；不复制框架或增加依赖。

唯一生产改动`src/app-server.ts`，与40基线只有3处diff：删除共享field/reset；startProcess捕获局部stderr尾部并检查原child仍current；退出错误读取该局部缓存。源码SHA before `DA447AEB5AEFD2106A371781EE5C1EA76972293289E7818A2A022B92B995B0C2`，after `83FE9495F8CAF276C405AF0B43357B4ADF36D10B945061CE6D71EEA745402BB5`。

保留原prefix／trim／退出处理策略与`slice(-16_384)`；这是字符串单位上限，不宣称严格UTF-8 16KiB。退出后的旧data被消费但不进入current诊断，本轮不保证原退出的全部晚字节可追回，不扩大StringDecoder／CLI／分类策略。App Server exited本来就是终止分类，不能说旧401导致recoverable变terminal。

## 持久反馈与冻结

`pnpm exec tsx --test test/app-server-stderr-origin.test.ts`是无人值守真实反馈：actor在flood ACK＋实际paused readable buffer后，通过自己捕获的exact ChildProcess.kill终止A；无需原人工Stop-Process。独立worker自然退出，恢复流、等待完整原进程树退出，主runner隔离。测试用公共health拒绝、真实pipe字节hash与exit／spawn／data／close时间线，不读取已删除的SDK私有stderr字段。

旧源码3场景实际1RED／2CONTROL GREEN。修复后3/3 GREEN，晚管道两个变体current-own／current-silent均有实际65536字节／1晚chunk，公共oldmarker=false且退出42prefix=true；当前自己的stderr保持。既有stdio／RPC／共享初始化15/15 GREEN、typecheck0。同行只读peer确认局部原child绑定、错误前缀及事件时序保持，不重复测试。

新增test SHA `C4D63ED42A51AB19BAA675CB5EDCFBABC320B8A1DFD6E5EF6917F22176EFFBEA`，actor `53F63D543E5BB6FD552CEEA42480D0ED9AB32BF366379E07AC66AEBC50322C34`，protocol `98324EBB57001D98BAB353960059131E18230FCF22BF3A0EB3B37F29D5B6C9B8`。

71个source／142个test/fixture冻结到`dsh-fortieth-source-freeze.json`和`dsh-fortieth-test-freeze.json`。完整122个测试文件以并发2运行，门禁目录 `%TEMP%/dsh-fortieth-final-gates-0927c9af-7903-4644-aebd-ef508e6309c5`；原断言及场景内部并发保持。基线 `%TEMP%/dsh-fortieth-baseline-e3334d1b-9ef6-4f01-b273-34d4d1ccdbc1`无新dependency Junction，更早含Junction基线仍禁止递归删除。

最终门禁和正式重载待追加。正式89732当前411会话，runningIds=[]／waitingWorkflowCount=0，未故障注入、改provider／凭据或建立替代Planner。没有真实模型／费用／完整浏览器验收；持续优化目标保持active。

## 最终门禁与正式重载

上节保留执行中的状态；随后全部122个测试文件以文件并发2完成验收。

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 1135/1135，371.49s |
| `pnpm release:check` 第一次 | 1135/1135，368.09s |
| `pnpm release:check` 第二次 | 1135/1135，375.25s |
| `pnpm host:check` | exit0，5.11s |
| `pnpm host:recovery:check` | exit0，9.35s |
| `git diff --check` | exit0 |

三次完整套件失败、取消、跳过、异步异常均0。两次offline doctor／pack审计及tarball清理通过；5项正式Codex检查仍按offline契约skipped。门禁summary／原日志保存在上节目录，不以本轮通过改写38历史失败原因。

重载前复核71个source和142个test/fixture冻结哈希，差异0；211个构建文件冻结到 `dsh-fortieth-build-freeze.json`。原89732入口、监听及实时活动确认：411会话、runningIds=[]、waitingWorkflowCount=0。然后只停止其已确认进程树，用原profile／参数隐藏启动85376。

新85376监听 `127.0.0.1:3080`，认证HTTP200；旧89732已退出。411会话不变，原父会话 `session-1f26c68f-4026-41e2-bca9-0d0b5812fe55` metadata保留，111条workflow的有序整体SHA256重载前后相同。211个构建文件及receipt的19个模块哈希均匹配，stderr fatal匹配0，当前runningIds=[]／waitingWorkflowCount=0。

证据 `%TEMP%/dsh-fortieth-reload-receipt.json`、`dsh-fortieth-formal-verification.json`、formal-metadata-before/after.jsonl。自动持久回归复跑了原受控管道污染模式，改动绑定原child且仅1个生产文件；没有在正式会话注入真实模型故障或改写旧历史，没有Token费用与完整浏览器UI验收。原exit晚输出全部收集、UTF8严格字节界限和自然idle发生率不在本轮已验证范围。持续优化目标保持active，未commit/push/publish。
