# 失败子回合的部分输出与原生消息收尾

状态：第93轮完整验收并正式加载。实际原verify/release各1620/1620、host/11恢复/diff及原进程exit0核对，326输入/217产物保护通过。原树11实例退出后交付已测JS/map，正式12176认证HTTP200，全部历史数据保持。真实RED及候选控制不能替代这些完整结果。

## 具体缺陷

Codex子会话收到message delta或工具后的缓冲文字后，`failAttempt`、`beginContinuation`和带错误正文的`finish`将该段`this.text`替换为诊断。原线程与child确实保持，但durable assistant message只剩错误，冷回放也看不到已显示的部分输出。它是消息收尾造成的丢失，不是线程重建或重新发任务。

最小公开factory控制实际复现等待、自动继续、terminal失败、取消、工具缓冲与冷回放六失败；空失败与成功权威正文两控制通过。RED/GREEN日志和真实退出分别保存在仓库外`.codex-workflow-verification/ninetythird-20261010`。

## 固定来源与采用机制

使用agent-reach GitHub/gh后端读取[DSH固定提交](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c)：`packages/llm/llm/src/assembler.ts`、其测试、`docs/subsystems/llm-streaming.md`和LICENSE。4份原字节Git blob/SHA256核对，MIT许可保留；另记录已安装llm bundle，未冒称其来自该提交。

Context7先resolve `/deepseek-ai/deepseek-harness`再核对BlockAssembler：block-end的ContentBlock成为最终正文，delta只用于尚未关闭的部分；中断可以保留安全的text/reasoning前缀。安装实现同样使用`partial.block = chunk.block`，所以error时覆盖block-end会真正改写持久消息。固定来源用于解释协议，不复制整个agent loop或改变模型恢复资格。

采用最小修正：失败/取消时把当前段及工具缓冲的文字保留，随后追加诊断；成功时仍取权威最终正文。failed turn/end、工具错误配对、stream start/end和后续同child回合保持原语义。部分正文只是未完成历史，不能当作accepted plan/verdict，也不改变一次自动继续预算。

## 已取得的验证与范围

新增8项控制连同原child、真实持久化和公开Manager恢复控制44/44通过，typecheck通过。none/zstd持久化文件在writer关闭后独立打开，原失败段与继续段均保留；native客户端帧和BlockAssembler仍与durable消息一致。没有调用正式provider，尚未在正式浏览器或完整AgentLoop组合执行本修正。

第93轮326输入在独立stage跑完整verify/release/host/恢复/diff，原正式lib保护保持；新gate实际PID49844/birthKey固定。交付脚本必须在完整原回执、无活动/待恢复/未确认清理、原实例出生和会话文件baseline通过后才退役原DSH。原树退出后才复制精确已测变化文件，保存rollback字节并只启动一个后继。当前完整与正式状态见[第93轮记录](../iterations/2026-10-10-ninetythird-partial-child-output.md)。

最终上述原链各1620/1620、170文件/native回执及host/11恢复/diff实际成功，原进程exit0；来源/产物审计后正式加载。JS/source map两份精确变化来自同一stage，不重新构建；原217rollback保存，429会话文件及111workflow/119queue完整hash保持。队列一条休眠定向dispatch与cancelled历史marker仍原样存在，不以“没有workflow”推断队列清空。原client服务字节保持；正式浏览器/provider行为仍需独立证据。
