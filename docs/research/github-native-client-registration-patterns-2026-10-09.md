# 原生浏览器模块注册与自动开栏验收

## 问题与采用机制

第75/76轮临时服务替代了生产服务入口，并禁用了生产Loader行；侧栏测试采用保存布局恢复，因此没有证明生产浏览器逻辑自动开栏。前端存在于仓库或后端投影已发布，不等于该浏览器模块已加载。

采用DSH的双入口包契约：启用的裸包Loader行声明`dsh.client`和`exports["./client"]`，浏览器脚本按同一包名注册lazy-CJS工厂。隔离夹具公开实际生产`lib/client.js`，仅替换模块注册ID，保留投影订阅、开栏和重试逻辑。业务恢复继续由原WorkflowManager和ToolRuntime执行。

## 固定源码依据

通过agent-reach的GitHub CLI查找`dsh.client`官方用法，并使用Context7查询注册契约；实际安装版本0.1.7-rc.2的模块服务再次核对。采用的是宿主公开机制，没有复制其他项目的页面实现。

- [模块服务](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/modules/src/index.ts)：解析`./client`入口，建立包级浏览器资源和模块表。
- [Settings cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/cookbook/adding-a-settings-card.md)：浏览器半部绑定启用的裸包Loader行；子路径行不携带半部，关闭所属行也会卸载页面。
- 同提交MIT许可已保存。相关三份实际字节与Git blob匹配；仓库外`../.codex-workflow-verification/seventyseventh-20261009/source-evidence.json`记录提交、路径、SHA256和原字节文件。该目录还保留前轮pi-mono固定证据副本，未将其作为本次注册结论依据。

## 验证与边界

隔离端口3099，独立DSH_HOME、JSONL日志、真实宿主浏览器组件，临时Agent工厂及脚本网关。启动前0标签、原父会话侧栏布局不存在；没有写入侧栏布局。仅选择原父会话后，实际插件浏览器逻辑自动打开原Planner资源，等待、继续成功和刷新始终保持`tab2`及原child地址。

生产client SHA256为`eb631409c8a373d033d5defb20515129804beb63341b2c1e9e6de8cb8bf9ad54`；夹具回执逐字节证明仅注册ID替换。`audit-auto-sidebar.mjs waiting|completed|reloaded`分别断言原身份、唯一child标签、展开状态和继续输出。见[第77轮记录](../iterations/2026-10-09-seventyseventh-automatic-child-sidebar.md)。

Planner通过只证明其受控展示。后续Reviewer验收发现原生标签被汇总页抢焦点：`review/end`将activeReview置null，但最新reviews仍保存child；浏览器只读取active child而进入fallback。外部注册机制帮助加载真实客户端并暴露该缺陷。

仓库外VM及同浏览器原代码/单行候选修正的可逆核对取得RED/GREEN。第78轮正式合入latest child选择与5项回归，相关14/14、typecheck及完整verify/release各1468/1468通过；候选全过程保持原Reviewer标签。第82轮已受控重载并确认正式boot注册及服务响应包含冻结修正代码；见[最终记录](../iterations/2026-10-09-eightysecond-final-gates-and-formal-load.md)。真实provider错误、费用、完整AgentLoop组合及重启后ephemeral线程恢复保持独立边界。
