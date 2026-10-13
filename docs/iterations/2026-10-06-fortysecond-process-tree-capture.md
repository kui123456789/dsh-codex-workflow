# 第42轮补充：Windows 旧父 PID 的进程树误归属

日期：2026-10-06。独立于启动回执竞态；在该修复的相关回归门禁中实际发现。保留原失败目录，不降低退出期限或断言，不终止不相关软件。

## 原失败现场

`test/app-server-protocol-failure.test.ts` 的 Planner actor 已完成原回合清理、唯一 unsubscribe/dispose、pin归零，随后自己的退出检查失败。父测试的 finally 再等待同一错误树，覆盖了内层退出诊断；总耗时约33秒。6组相关回归85测试中84通过、1失败，不能将整个 Planner 测试算为通过。

真实目录 `%TEMP%/dsh-app-server-protocol-failure-5320WP` 保存 actor3788 的 wire/states。捕获的实例为：

| PID | 捕获出生值 | 关系 |
| --- | --- | --- |
| 88788 | `win32:134357732495098540` | 原 backend |
| 25332 | `win32:134357732495653800` | 原 backend 的新子进程 |
| 84272 | `win32:134357729781063110` | 活着的旧 `biz_helper.exe`，数字父 PID 仍为25332 |

复核时原 backend、25332及 actor 均已退出；84272仍活着，出生值与捕获值相同，且比新父25332早271.5秒。旧数字父 ID 的关联误入新树，不是84272在捕获后被另一实例替代。这次真实证据不能证明早期第38轮等待失败也是此原因。

## 修复范围与验证要求

仅修正 `src/infrastructure/process-transport.ts` 的 Windows capture 边：当子、父的 CIM 出生值均有效、可比较，子实例早于当前父实例时，不把这条旧关联计入原树。它的后代也不能经这条关联取得归属。合法嵌套子进程、同出生值及未知出生元数据保持原规则；未知元数据不能被当作已确认退出。

原主问题 SDK、恢复预算、线程身份和所有既有测试期限保持。Controlled census 回归需要在旧源实际得到 RED，再通过新源码；它验证捕获算法，不伪称重新制造了真实 OS PID 复用。真实 Windows 失败现场是独立证据。主问题7项 pipe 回归与原健康对照亦需保持通过。

补充基线 `%TEMP%/dsh-fortysecond-tree-baseline-08ae8606-c651-4dae-972f-8b24c96835b2` 保存 SDK 和 process transport；旧 transport SHA256 `9BDD2C0171F2853F2CCC7A78D7D1B55EDE5C28846C06B53ECEE1AA68D7EF5B24`。补充实现、回归与最终门禁结果完成后追加。

只读现场证据 `%TEMP%/dsh-fortysecond-tree-capture-failure.json` SHA256 `F78696F408AE3B12F90C01D96C1B7E72E34D2972C90CA4288AD42EDDF69BAD7F`。Controlled census 回归在旧源以 `pnpm exec tsx --test test/process-tree-capture.test.ts` 实际得到 RED：期望只包含原 root、有效子进程及合法嵌套/同级后代，实际多出84272及它的下支。日志 `%TEMP%/dsh-fortysecond-process-tree-capture-red.log` 保留；源码修复在该 RED 后实施，没有测试专用生产 API。

## 补充验证与冻结

修复 SHA256 `38E024CAB390E46192BF858F95ED2344F65F0DA595C9B52A1C6751A29AE3D7C4`。新增3项 census 回归通过，typecheck通过；未知/损坏出生信息省略 identity 字段，活着的 PID-only 证据不能确认退出。用 `mock.method` 与 `syncBuiltinESMExports` 替换仅当前测试进程的 native census 输出，finally恢复，不生成任何 OS 进程或发送信号。

测试冻结 SHA256 `FCB2EC9C49FA267815E4FD353FDDB3A7C780D1D90ABF49549277F47539D9986F`。同一组既有套件加主问题7项及census3项，95/95通过，原 Planner 失败用例完成业务断言与退出期限；未将先前失败删掉或改写。完整125文件门禁及正式重载见 [主迭代记录](2026-10-06-fortysecond-pending-turn-receipt.md)。

[固定来源研究](../research/github-windows-process-capture-parent-birth-patterns-2026-10-06.md)核对 Microsoft 的 `Win32_Process.ParentProcessId` 文档：旧父 ID 可指向复用后的新实例，CreationDate 可验证时间顺序。Node24的 `mock.method` 与 `syncBuiltinESMExports` 文档支持受控 census 测试及恢复顺序。该研究明确CIM源精度、未知父 exe、非原子快照及受控回放边界，不复制框架或扩大进程终止策略。

最终125文件的verify和连续两次release各1150/1150通过，host与recovery检查exit0。正式重载前另核对实际DSH树的出生顺序，捕获旧67176下11个原实例；停止原树、启动75196后，按出生身份确认原11实例均已退出。411会话、111workflow和全部211构建文件核验保持；没有终止不相关Sogou进程或清除失败证据。完整日志和最终边界见主迭代记录。
