# 模型目录缓存快照不可变

状态：第102轮的 detached/frozen snapshot 已完整验收并正式加载（当轮verify/release各1674/1674）。第104轮补充同 generation 的 single-flight；15项目录回归、verify/release各1677/1677及host/11恢复/diff通过，已随5份验证产物正式加载到DSH PID47864，认证HTTP200。

## GitHub 参考

[OpenAI Agents JS 的 `ScriptedModel`](https://github.com/openai/openai-agents-js/blob/89a9ddf1e241e75f2e0ad4c15d89de9e215ebac6/packages/agents-core/src/testing/scriptedModel.ts) 将记录的模型请求定义为 `Readonly`，对返回集合和嵌套输入建立 detached snapshot，并对公开 `calls` 返回冻结的副本。固定仓库 commit 的许可证为 MIT（license blob `0b9aa14f1d62dc4f93fd48437369ceff7ff27cd8`）。源码只作设计参考，没有执行外部代码或增加依赖。

## 本项目采用

`ModelSelectionGateway` 的 generation fencing 已阻止旧 App Server 的迟到响应回填新缓存，但缓存条目此前仍可通过 `listVisibleModels()` 直接暴露给调用方。候选把缓存数组和条目冻结，并返回新的浅副本；调用方可以排序、标注或修改结果而不会改变当前 App Server generation 的 default/model/effort 选择。

回归证明：首次读取后修改 model id、reasoning effort 并追加条目，下一次读取仍返回原 catalog，且只发出一次 `model/list` 请求。既有 generation reset、旧响应、失败重试、空 catalog 和取消隔离测试保持通过；总模型目录回归14/14。

## 边界

快照只覆盖模型目录的扁平元数据；它不把 Planner/Reviewer 的 saved model 或 thread owner 改成动态默认值，也不持久化 provider 凭据。真正的新 App Server generation 仍由现有 reset/owner 检查决定。

## 并发 single-flight

本轮候选在同一 generation 共享一个 `model/list` Promise；每个观察者用自己的 AbortSignal 等待该 Promise，单个调用者取消不会取消其他观察者，也不会让旧 generation 回填新缓存。reset 会让新的 generation 开启新的 flight。该边界参考同仓库既有的 GitHub 研究：Redis client-side cache 的并发 waiter 共享 entry，Apollo QueryManager 只有持有原 entry 的清理者才能移除它；本项目不复制其存储实现。
