# 第98轮：CLI无数字退出码仍保留终止诊断

状态：候选四文件已在仓库外验证和封存，尚未合入、完整门禁或正式加载。第97轮原47664在`isolated-9olNA1`继续release，首轮verify1651/1651已通过；正式65896保持第96轮。

## 实际RED与因果验证

公开normalize调用经本地ChildProcess适配器收到完整stderr及close(null,SIGTERM)；403、Schema、display及非法线程诊断被busy分支接纳。初步七项3通过4失败，原诊断可见、calls1。该证据不表示真实进程被信号终止、重复模型请求已发生或Token费用增加。

null分支优先级、保留截断和阶段包装三个方向以原文本和error type区分。`code === null`直接返回busy，绕过现有终止分类。候选只在该busy分支前查询共享terminal；未知null退出与null503保持，非零403保持typed失败。

初次candidate测试使用错误字段recoverable，typecheck拒绝；修正为实际recoverableModelFailure后重新恢复旧源码取得有效3通过/4失败，再加同一源码条件取得7/7。早期probe/typecheck/错误字段日志保留，不将它们作为最终GREEN证据。

## GitHub机制和范围

[固定来源研究](../research/github-cli-signal-terminal-patterns-2026-10-10.md)通过agent-reach GitHub/gh读取Node v24.14.0 child_process文档/LICENSE及p-retry固定index/license四份原字节，Git blob/SHA256校验通过；Context7核对null/signal/close顺序。null是退出形态，已知终止必须优先；使用现有classifier，没有依赖或调度器替换。

仓库外`../.codex-workflow-verification/ninetyeighth-20261010/`保留candidate、纠正前后RED/GREEN、相关控制与source-evidence。四候选base/candidate hash固定于prepared-candidate.json：CLI源码、新七项回归、README、CHANGELOG。主第97轮329输入及217正式产物保持。

## 已取得验证

有效七项GREEN7/7；相关5文件一次完整91/91，失败/取消/跳过/TODO与异步警告0，typecheck通过。原取消、backoff与首因、stdin/stdout故障结算均在控制范围；没有放宽时限或新增真实provider调用。

未来完整预期1658项/174文件/330输入，仅是候选清单；第97轮须先完整验收并实际加载后才可按base hash采用，再取新的完整verify/release、宿主/11恢复/diff和产物清单。不沿用1651结果放行1658，不在采用阶段写canonical lib。

原schema等终止消息保持、原unknown signal retry规则保持；信号名称持久化未实现，本轮不声称已改善该观察字段。provider/profile、历史corrupt child与原失败证据保持，未commit/push/publish，持续优化目标active。

采用助手已准备，要求第97轮真实completion/deployed、原47664完整exit0、1651/173/11恢复及329输入/217产物一致后，核对四份base/candidate、备份旧字节再采用；新七项测试独占创建。助手未执行，本轮没有改canonical源码或构建；当前正式65896仍是第96轮。
