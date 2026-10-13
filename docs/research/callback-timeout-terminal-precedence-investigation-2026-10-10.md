# 回调终止错误与嵌入超时片段的优先级

状态：第95轮完整门禁运行期间，仓库外独立探针确认一处后续缺陷；尚未修正或合入。本记录不改变当前327份冻结输入，不将它列作第95轮已完成修复。

## 证据

`src/app-server-callback.ts`可见回合catch在统一`isRecoverableModelFailure(detail)`之外，还允许非锚定的`/Codex turn timed out/i`继续。`src/transient-retry.ts`原统一分类明确先排除Schema、权限、认证、非法线程及display契约等终止条件，并只把完整已知timeout诊断视为可恢复。

在仓库外复制既有ScriptedCallbackClient夹具，驱动实际AppServerCodexCallbackDispatcher。六条诊断分别为Schema、permission denied、401、no rollout、display violation及具体unreadable workspace，并附超时片段。实际每条均发出2次可见请求、1次continuation、1次转换，最终返回verdict而没有保留原拒绝。线程创建仍为1；这个问题是同线程多调用与错误分类，不是新子智能体或线程重建。

两条对照（完整已知timeout、纯Codex run failed）按预期继续一次。原8项结果2通过/6失败；原exit1、请求计数观察及全部受控诊断记录位于`.codex-workflow-verification/ninetyfifth-20261010/follow-up-probe`。实际计数属于注入client协议请求，没有启动模型进程、调用provider、写workflow/queue或证明真实Token账单。

## 下一步

先完成原第95轮50548门禁和精确加载，避免修改冻结源码使本轮结果失效。后续独立修复应采用同一统一分类，删除或约束额外宽松timeout分支；验证终止诊断不发送第二次model request、不调用onContinuation、不转换，也保留真正可恢复错误的原线程继续及现有取消/清理规则。当前探针仅改变下一步选择，不提前宣称生产问题已解决。
