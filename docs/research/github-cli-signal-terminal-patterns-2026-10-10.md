# CLI信号退出的终止诊断优先级

状态：第99轮已完整验收并正式加载。CLI候选第98轮正式加载后，SDK callback候选以第99轮 verify/release各1663/1663、175份原生文件摘要和正式PID29964健康HTTP200完成交付；第97/98轮原失败与恢复证据保持。

## 用户相关故障与反馈环

公开 `CodexCliAuditDispatcher.normalize()` 的本地ChildProcess适配器回放完整stderr后触发 `close(null, "SIGTERM")`。四种终止诊断分别为403、Schema、显示契约和非法线程，并附暂时性提示；另设非零403、null503及null无诊断三个对照。适配器只发一次调用、不创建真实模型进程，不证明正式provider信号故障或Token账单。

旧实现七项3通过/4失败：四种诊断完整出现在错误中，但错误类型成为busy。三个方向为null分支优先级、诊断保留截断和阶段包装；诊断全文与公开出口类型表明不是截断或包装，`throwProcess()`的`code === null`跳过了共享终止判定。

初次候选仍报告四项失败，类型检查发现探针断言字段误写为 `recoverable`，实际字段是 `recoverableModelFailure`。保留首次日志，修正字段后回放旧源码仍3通过/4失败，应用同一候选后7/7，建立有效RED/GREEN；没有把错误字段造成的失败当作产品缺陷。

## 固定外部机制

| 来源 | 核对内容 | 采用 |
| --- | --- | --- |
| [Node v24.14.0](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/child_process.md) | close/exit的code与signal；信号退出code为null；close发生在stdio关闭后 | null只描述进程退出形态，不能覆盖已有权限/Schema等业务诊断 |
| [p-retry固定版本](https://github.com/sindresorhus/p-retry/blob/1472907affe8d6107aba5884abc36d6361b3042e/index.js) | AbortError在重试机会及钩子之前返回原错误 | 复用本项目已有共享终止分类，不引入库或改调度器 |

agent-reach GitHub/gh读取以上原文及各自license，共四份原字节核对Git blob SHA1、SHA256和长度，保存在第98轮source-evidence。Context7先resolve Node.js，再查询v24的close/exit文档；安装Node v24.14.0与固定文档一致。未执行下载源码。

## 候选与实际验证

只为CLI busy分支加 `!isTerminalModelFailure(diagnostic)` 条件。非法rollout原有专门错误分支保持；已知终止诊断生成原typed process error并设置recoverableModelFailure false。没有终止诊断的null退出和既有暂时故障保留原行为，原caller取消仍走既有首因结算。

修正后七项7/7，相关五文件一次完整命令91/91，失败/取消/跳过/TODO及异步警告0；typecheck通过，包含CLI原取消、退避、首因与输入/输出流结算。该测试范围不能代替未来1658完整门禁，也不说明信号名称现已持久化。

候选四文件为CLI源码、七项新回归、README、CHANGELOG，base/candidate hash封存。第98轮采用四文件后完整门禁1658项/174文件/330输入通过，canonical差异只有`lib/codex-cli-audit.js`及map；正式交付保持415会话/430文件/111 workflow/119 queue。provider/profile与历史会话保持；未commit/push/publish。

## SDK callback 后续边界

`src/codex-callback.ts` 复用了相同的 signal 语义。新增五项回归分别覆盖403、Schema、显示契约、非法线程和无诊断 signal；旧实现1/5通过，候选5/5。修复只改变已知终止诊断的优先级，不扩大可恢复错误集合，也不创建第二个 SDK 子进程。第99轮完整 gate 与正式重载验证了该边界；真实 provider 信号故障仍需单独的运行时证据。
