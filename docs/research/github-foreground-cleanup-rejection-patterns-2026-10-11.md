# Foreground cleanup after an original stop rejection

状态：第105轮完整验收完成。聚焦13/13、verify/release各1678/1678、177份原生文件摘要、host/11恢复/diff通过。只修改测试生命周期；第104轮217份生产构建及metadata保持，正式DSH PID47864认证HTTP200。

## 原现场与反馈环

第104轮最初 `isolated-ufp0Ju` 记录 foreground 多manager场景的原进程树清理未确认，随后仍挂着该测试拥有的本地 backend。单独重放原场景1/1通过，后续完整verify/release该文件各12/12通过，因此未确认自然清理异常的触发原因。

明确缺口是该场景的顺序finally：一个manager stop拒绝会跳过其余SDK和fixture close。复制实际场景，在原owner完成自身清理后注入同一异常；原ChildProcess在失败结果后仍活着。探针只退休自己的原进程，原native test仍exit1。正式回归用preload actor执行实际测试文件和真实协议/DSH原生子会话，不复制业务场景；RED0/1对应原进程未清理，候选GREEN1/1要求原native失败、原进程退出、原store关闭。

首次GREEN探针把`WorkflowStore.isClosed()`误当属性读取，已修正并独立保留失败日志，未据此修改生产逻辑。

## 固定GitHub来源

通过agent-reach GitHub/gh读取 [Node v24.14.0](https://github.com/nodejs/node/tree/f657bb8ed86365ff3fdbe32e27563e778b41486a)，固定commit `f657bb8ed86365ff3fdbe32e27563e778b41486a`（核心MIT）。源码、文档和LICENSE的Git blob SHA1、SHA256及字节长度保存在checkout外第105轮`node-sources/source-manifest.json`；没有执行外部源码或新增依赖。

- [`runHook`, test.js:1030–1044](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/lib/internal/test_runner/test.js#L1030-L1044)：hooks顺序运行，首个hook错误抛出并停止后续hook。因此不能靠多个独立after自动完成全部资源清理。
- [`TestContext.after`, test.md:3536–3562](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/test.md#L3536-L3562)：当前test结束后执行after，支持异步hook。Context7先resolve Node.js，再核查Node24 TestContext生命周期；具体失败hook边界以固定源码及本地native执行为准。

## 本项目采用与边界

只给发生缺口的多manager场景加入一个清理Promise。finally与after加入同一flight，顺序尝试各独立资源，最后抛出首个原错误；不并发拆散manager、SDK、store的释放顺序，不重跑模型，不改变原业务断言或时限。

受控失败的子测试仍是失败，外层回归只在错误保留且原资源已清理时通过。5.5秒观察使用保存的原ChildProcess对象，不能把PID复用算作旧进程存活。watchdog后续清理只防止RED探针遗留自己的进程，不参与GREEN判定。

这证明清理早退缺口及修复，未证明第104轮自然CIM/进程身份查询故障的原因，也不放宽生产SDK的“原清理未确认禁止替换”约束。

## 复现与证据路径

在仓库根目录运行：

```powershell
pnpm exec tsx --test test/foreground-cleanup-failure.test.ts test/foreground-new-review-round.test.ts
```

原证据位于checkout外 `../.codex-workflow-verification/hundredfifth-20261011/`：`baseline-injected-cleanup.log`证明失败后原backend存活，`regression-red.log`在同一边界失败，`regression-green-corrected.log`与`focused-original-scenarios.log`记录修复后GREEN1/1及组合13/13。该证据对应的调用路径为owner.stop拒绝→finally逐项清理→f.close关闭原SDK/store→抛出首个错误→after加入同一flight，内层native失败结果始终保留。

完整门禁为`isolated-5QsNDT`，原PID59344/`win32:134361549934795450`实际exit0。verify与release均独立记录清理回归1/1及原foreground文件12/12；完整1678项没有失败、取消、跳过或异步警告。独立审计确认334输入无漂移、生成产物与正式217产物一致；415会话、430会话文件、111 workflow、119 queue和7份配置/凭据保持。
