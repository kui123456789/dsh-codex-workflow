# 第45轮研究：launcher退出与原backend清理证明

## 固定来源

通过Agent Reach的GitHub/`gh`后端读取，原文件保存于`%TEMP%/dsh-fortyfifth-github-aa29173a-7c83-4636-800e-442e253980fc`，外部实现和测试未运行、未复制或安装为依赖。

| 来源 | 固定提交 | manifest/许可 |
| --- | --- | --- |
| microsoft/playwright | `b8147648bf8d4d517705b4683fe03764095a83b5` | 1.65.0-next snapshot，实际LICENSE为Apache-2.0 |
| sindresorhus/execa | `63ddae6aeb6934da06fdb3754647791e58cd87c3` | 10.1.0，MIT |
| microsoft/referencesource | `ec9fa9ae770d522a5b5f0607898044b7478574a3` | .NET Framework历史reference source，MIT，不冒称本机二进制版本 |

Context7 `/nodejs/node`查询确认`exit`先于stdio关闭；`close`在stdio关闭后发生，发送kill成功不证明退出，shell后代不会自动随父进程结束。`.NET`目录的多次resolve未给出正确Process API库，未借无关结果作结论；改用固定reference source及本机只读探针。`/python/cpython`查询确认`pidfd_open`/`pidfd_send_signal`的Linux支持与文件描述符归属。

## 可采用的机制与限制

- [Playwright processLauncher.ts](https://github.com/microsoft/playwright/blob/b8147648bf8d4d517705b4683fe03764095a83b5/packages/utils/processLauncher.ts#L229-L280)区分graceful与forceful路径，Windows使用taskkill树，POSIX使用其专门创建的进程组。[294–304](https://github.com/microsoft/playwright/blob/b8147648bf8d4d517705b4683fe03764095a83b5/packages/utils/processLauncher.ts#L294-L304)明确Node timeout只杀直接child，grandchildren持有stdio时close不发生。本项目不照搬`taskkill /T`或负PID，因为历史PID复用及未创建独立组需要自己的归属证据。
- [Execa wait-subprocess.js](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/resolve/wait-subprocess.js#L82-L123)等待exit与stdio等多个Promise，再处理取消/超时。这是完整结果归属，不证明所有后代进程结束，也不提供本项目的出生身份校验。
- [Process.GetProcessHandle](https://github.com/microsoft/referencesource/blob/ec9fa9ae770d522a5b5f0607898044b7478574a3/System/services/monitoring/system/diagnosticts/Process.cs#L1651-L1700)保留已打开的handle；[Kill](https://github.com/microsoft/referencesource/blob/ec9fa9ae770d522a5b5f0607898044b7478574a3/System/services/monitoring/system/diagnosticts/Process.cs#L2366-L2377)通过该handle调用TerminateProcess。本项目在打开handle后校验StartTime，再终止它指向的原实例。

## 本机实际证据

真实SDK/stdIO原回归首先RED：`pnpm exec tsx --test test/fork-creation-process-exit.test.ts`。保存目录`%TEMP%/dsh-fork-creation-stop-tree-7nBKKb`：launcher92640、捕获树含93748/33724，SDK stop已返回但treeExited=false、backend仍持原fork；model0。launcher的signal退出不能只看exitCode，后续诊断同时记录signalCode。测试finally仅写这个fixture独有的退出marker并核对全部原实例，未留下测试backend。

只读原生时间探针发现CIM出生时间`134357889636243230`、已打开handle的时间`134357889636243239`，相差最后一位FILETIME精度。按整数截到CIM微秒精度后，第二探针两值同为`134357901817140880`，运算类型System.Int64；没有用浮点舍入比较身份。

## 本项目采用

fork提交时保留原进程树证据。永久停止先结束原launcher，再按捕获的出生身份处理仍存活原实例，并独立证明树退出；只有证明成立才删除创建归属。Windows使用原opened handle，Linux使用现有Python 3.9+与内核pidfd API；API/身份不可用时报告未确认，不安装运行时，不退回裸PID强杀。

失败后的再次stop只清理相同捕获树，不能启动新SDK、模型、fork或替代Planner。新原生测试包含launcher提前退出、真实helper拒绝后重试、PID出生时间不匹配的存活进程；受控出生差异不冒称真正OS PID复用。全量门禁与正式重载结果见本轮迭代记录。
