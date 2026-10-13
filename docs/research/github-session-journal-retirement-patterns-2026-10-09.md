# 会话日志写入归属与释放后回放

## 本地问题与采用范围

第75轮临时 Agent 工厂只发布内存 Session，没有取得日志写入句柄。原子会话实时继续成功，但完成并释放后刷新返回 `subagent/not-found`。这属于验收夹具缺口；不能据此修改正式插件的成功释放策略。

本轮采用“写入归属随会话生命周期保持”和“释放后从独立存储读取”的机制，改进 `scripts/host-recovery-check.mjs`。生产 workflow 和 ephemeral 模型线程生命周期保持不变。

## 固定源码与许可

通过 agent-reach 的 GitHub CLI 路由搜索 `coding agent jsonl session`，发现 pi-session-viewer；进一步核查其日志生产者 pi-mono，并对照 DSH 官方持久化边界。没有按星数宣称某个实现最优。

| 项目 | 固定提交与源码 | 可复用机制 | 本地边界 |
| --- | --- | --- | --- |
| pi-mono | [SessionManager](https://github.com/badlogic/pi-mono/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/core/session-manager.ts)，MIT | `_persist` 首次写入会话头及已有事件，之后追加；已有有效日志按原路径读取 | 不复制同步文件写入、树型消息格式或懒写入阈值；DSH已有自己的JSONL后端 |
| DeepSeek Harness | [AgentLoop](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/src/index.ts)，MIT | 发布前取得持久化写入句柄并保存初始事件，关闭句柄后释放；后台路由实时Session事件 | 临时工厂只模拟这条持久化边界，不宣称加载了真实AgentLoop或调用了provider |
| DeepSeek Harness | [持久化契约](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/subsystems/persistence.zh.md) | `flush`/`close`形成持久化屏障，`read`只读打开不取得写入归属 | 日志可读不等于ephemeral模型线程可恢复；不重建历史线程 |

五份源码/许可保存在仓库外 `../.codex-workflow-verification/seventysixth-20261009/sources/`，每份实际字节与Git blob SHA匹配，偏差0；`source-evidence.json`记录SHA256、提交和路径。Context7的官方DSH文档补充确认了写入句柄及发布边界；实际安装版本0.1.7-rc.2的源码再次核对。

## 实现与证据

新增的独立后端读取断言先在原夹具失败：`SessionPersistenceNotFoundError`，包括原child读取失败，退出1。补齐SessionStore发布及日志句柄后，现有11场景全部通过，退出0；逐项比较完整事件，不仅检查文件存在。

浏览器隔离实验在端口3098使用真实宿主组件和临时Agent工厂，原child三回合成功后释放一次；刷新同一资源仍显示短continuation及最终计划。它验证日志回放，不验证插件自动打开标签、真实provider故障或费用。原子会话和线程身份不变的证据见[第76轮记录](../iterations/2026-10-09-seventysixth-persisted-child-replay.md)。
