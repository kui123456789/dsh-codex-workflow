# 第十二轮：前台审查结果接纳前复核证据

## 问题与红例

前台 Reviewer 只在回合开始读取工作区证据。原生审查、结构转换或权威对齐等待期间文件发生变化，旧 `pass` 或旧修复意见仍会写入 `latestReview`，消耗周期并注入完成/修复提示。真实 WorkflowManager、SQLite 与 Session 的初始回归为 **9 项中 7 项失败、2 项正常对照通过**。

另一个真实临时 Git 仓库红例发现，内容不同的两个干净提交具有相同旧 fingerprint：指纹只有 status/diff/untracked，遗漏 HEAD。只增加末尾扫描无法识别这种变化。

## 采用的机制

参考 [固定源码研究](../research/github-review-freshness-patterns-2026-10-05.md) 的异步资格复核、generation 和预期提交门禁；没有复制上游源码或引入依赖。

- `ReviewExecutionContext.readFinalEvidence` 只提供末尾只读取证入口，按原 cwd、changedFiles 与 diff 上限扫描。
- 扫描位于转换、对齐和协调完成后、判定或合同失败副作用前；证据变化/不足/无法读取均拒绝旧结果，不计业务周期、不发送完成或修复指令、不自动创建替代 Reviewer。
- 最终 SQLite 写入仍经现有租约栅栏，并检查 owner、reviewAttempt、cwd 与原 baseline fingerprint。扫描后的取消、停止及身份变化不能接纳晚到结果。
- 失败 child 显示拒绝诊断；末尾 observation 不向不同 owner/attempt 发布结论。
- 只读复审另复现两条归属漏洞：晚到 unsubscribe 失败诊断污染新 owner 的进度；连续通用模型失败把新 owner/attempt 停放为旧 Reviewer 的 waiting。清理诊断与 waiting 写入均补事务内原身份检查，自动继续前重新核对归属，原资源仍清理一次。
- `trackNoChange` 移到成功接纳判定的同一事务。基础设施失败不再提前累积未变化次数，第一次有效判定不会因此前失败错误地阻塞。
- Git fingerprint 纳入实际 HEAD SHA；diff 使用捕获 SHA，扫描末尾再次读取 HEAD。不一致时沿既有文件证据降级，不能把混合快照当有效 Git 证据。
- 只有确认缺失的 branch ref 才记为 `unborn`；损坏 ref 或 Git 错误不能伪装成空仓库。`baseRevision` 是可选诊断字段，无数据库迁移。

## 证据不足的明确契约

前台与 Bridge 均要求可验证证据。非 Git 必须提交真实、可读、工作区内的 changedFiles；不足时在模型启动前拒绝判定。既有正常流程测试补真实范围文件，保留模型、线程、取消、租约和合同断言。原 insufficient/no-change 测试改为验证拒绝；失败的未观察输入不清除此前有效指纹链。

等待 Reviewer 的 status 对不足或读取类型降级返回 `evidence_unavailable` 并保留原句柄。显式新 review 在无法验证变化时同样保留原 waiting Reviewer。模型运行失败与代码实际变化是两种入口：恢复继续原线程；真正的新业务审查由显式调用开始。

## 定向验证

- 前台证据组 **23/23 通过**：三阶段两种判定、正常对照、显式新轮、最终扫描中的 cancel/stop/owner/attempt/baseline 变化、读取失败与真实不足证据，以及清理诊断和失败恢复归属六例。
- Git 证据组 **18/18 通过**：不同干净提交、扫描途中实际提交、unborn 首次提交、损坏引用以及已有差异/截断/UTF-8/路径保护。
- 恢复状态与显式审查轮次 **40/40 通过**；同线程恢复与审查准入组合 **61/61 通过**。
- 权威合同组 **29/29 通过**，含协调成功与未解决冲突时真实修改工作区两例；工作流组 **120/120 通过**，保留三次基础设施失败后首个有效结果仍 cycle=1/fixing 的断言。

## 验证范围

末尾扫描验证检查时的文件系统快照。SQLite CAS 保护 workflow 记录，不能锁住 live FS，不能证明接纳后工作区始终不变。没有修复旧损坏子会话，也不将独立验收当作旧 workflow 恢复；没有重复真实模型来证明本地即可验证的门禁。

## 最终门禁与正式 DSH 重载

| 门禁 | 本轮结果 |
|---|---|
| `pnpm verify` | 725/725，失败/跳过/取消为 0，61.12 秒 |
| 连续两次 `pnpm release:check` | 各 725/725；65.36/64.88 秒；离线 doctor 通过（5 项明确跳过）、包审计通过、临时 tarball 已清理 |
| `pnpm host:check` | 实际安装 DSH 0.1.7-rc.2，九工具注册/卸载及兼容性通过 |
| `pnpm host:recovery:check` | 八个隔离宿主场景通过，原 child/thread、设置、回放及一次清理 |
| 异步残留与 `git diff --check` | 异步/unhandled/关闭存储诊断 0；差异检查通过 |

日志目录：`%TEMP%/dsh-twelfth-final-gates-d7db3f99-0257-457f-9597-d8a63d9e1adc/`。README/CHANGELOG 与固定研究及本轮记录已更新，没有提交或推送。

正式重载前 metadata 核验 runningIds 为空、已加载的待规划/待答/待恢复工作流为 0，PID 8828 的 executable/commandline 与本任务启动一致，插件 Junction 实查指向 D 盘仓库。只终止该已核验进程树；最新 `lib/` 重载为 PID **48952**，认证交换 303、健康检查 **HTTP 200**。复用 Playwright `dsh-recovery-20261005` 并加载新的临时 cookie state，页面标题 **DeepSeek Harness**。未创建正式模型测试或额外子智能体。

重载 receipt 为 `%TEMP%/dsh-twelfth-reload-receipt.json`，记录已构建 `review-execution.js` SHA256。stdout 和认证状态包含敏感启动信息，不在文档或结果输出原文。
