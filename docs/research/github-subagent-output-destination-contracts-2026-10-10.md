# 子会话输出位置与模型指令一致性

状态：第95轮已完整验收并正式加载。原verify/release各1632/1632、171文件/native及host/11恢复/diff通过，原进程exit0；精确交付唯一workflow.js，formal22108认证HTTP200，全部历史保持。真实provider对新指令的遵循程度尚未验证。

## 确认的问题

Planner主提示词和共用Reviewer契约仍写“visible reply stays in Codex Desktop”。本项目实际使用隐藏ephemeral App Server thread，结果经插件显示在当前DSH child Session与右侧栏；第94轮真实隔离browser也验证了该载体。因此文字与已实现的展示契约冲突，但它不是已证实的原模型失败根因。

## 固定来源与采用

agent-reach GitHub/gh读取[DSH固定提交](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c)：subagent服务、ui-subagent、Codex provider三份README及MIT LICENSE，共4份Git blob/SHA256核对。Context7先resolve Harness再核对本地Session、provider transport、parent result与`subagentchat`显示的分工。

ui-subagent通过精确parent/child/mode资源读取本地子会话，历史one-shot为只读记录；provider执行方式不决定它显示在哪个外部应用。官方Codex provider的一次性fresh thread策略属于不同后端，本轮没有复制它来替代原workflow恢复。仅采用“指令准确描述自身结果载体”的边界。

## 最小修正与证据

只替换`src/workflow.ts`的两段输出位置说明，指向当前DSH child Session与Codex Review右侧栏。Planner目标、只读范围、task语言、Markdown、review四节与独立结构化转换保持。共用Reviewer契约同时进入开发者指令、原生review/start target和Bridge callback，不新增线程或模型调用。

加强已有review-authority测试的实际Gateway/Callback接收边界，未新增test case。首次将断言放在Bridge mock内部导致后台等待超时，属于夹具副作用；改为记录原请求后在既有流程完成时断言。独立两条过滤流程原2/2失败、无timeout；修正后三个相关文件182/182及typecheck通过。RED/最终GREEN、实际退出与base/candidate备份独立保存，不能把初次夹具超时当产品失败。

当前完整门禁仍待verify/release/host/11恢复/diff及原OS句柄exit回执；不将182局部结果当1632放行。真实provider对新说明的遵循程度、Token费用和完整AgentLoop不由字符串或受控Gateway检查证明。[第95轮](../iterations/2026-10-10-ninetyfifth-output-destination-contract.md)记录当前状态。

最终原50548全链真实exit0，verify/release各1632/1632、171文件语义回执及host/11恢复/diff通过。327输入和217产物/HMR metadata独立核对后，原59112树11实例退出，仅写已测workflow.js；source map同字节保留。正式22108认证HTTP200，414身份/429文件及111workflow/119queue保持，实际模块中两个旧位置声明已不存在。早期待完成段为时间顺序，最新状态见第95轮最终节；它不解决后续独立callback优先级缺陷。
