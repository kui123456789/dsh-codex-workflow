# 第75轮：原生侧栏继续回合验收

## 结论

隔离 DSH Web 的原生子会话侧栏实时显示了自动继续和手动继续，最终计划来自同一个 Planner 线程。此轮没有修改生产代码，也没有重新启动正式 DSH。完成后的刷新回放未通过；临时 Agent 夹具没有持久化写入器，不构成正式历史回放验收。

## 场景与证据

使用已安装 DSH 的 SessionStore、SubagentRuntime、ToolRuntime 和浏览器组件；端口3097、独立 DSH_HOME，模型网关为本地脚本，不配置正式 provider。临时 Agent 工厂替代 AgentLoop，隔离配置关闭自动标题和 file-reference-local。

- 父会话：`ui-recovery-parent-16f16d86-943e-4348-8fc1-74341b5c5362`。
- Workflow：`7e1e3dd3-0474-4c8e-9edd-f9c5f6ed670e`。
- 原子会话：`ed672977-2894-4a67-95cc-493e3636b299`。
- 原线程：`planning-86029ec1-1632-4b6f-b629-c938a87e09f0`。

前两回合受控失败，自动继续一次后为 `planning/waiting`，原子会话未释放。通过真实 ToolRuntime 调用 `codex_workflow_resume`，省略 workflowId，仅传短 continuation；第三回合成功后为 `executing`，原子会话释放一次。线程创建次数1；原子会话 turn/start、turn/end 各3次。原生父会话目录只列出这个 Planner。

夹具原始 Agent 工厂计数为2，额外一次是浏览器初始化的空白主会话 `session-fa5a9f62-d1fe-467b-ba46-d28252bf08fc`，不属于该 workflow 子会话。不能把原始计数直接写成“只创建一次 Agent”。

侧栏恢复采用浏览器本地保存布局，指向原 `subagentchat` 资源；未验证插件自动打开标签。成功前后仍是同一个 `tab2`、同一个资源地址。真实 DOM 和截图显示第三回合及其最终计划，父会话没有代写。

本地截图和脱敏回执位于 `output/playwright/recovery-20261009/`（Git忽略）；维护脚本和原始隔离诊断位于仓库外 `../.codex-workflow-verification/seventyfive-20261009/`。可在隔离实例仍运行时执行 `node ../.codex-workflow-verification/seventyfive-20261009/ui-acceptance-audit.mjs` 核对原身份及回合数量。

## 回放限制与下一步

成功释放后刷新，原生侧栏返回 `subagent/not-found`。宿主 SessionStore 明确不负责持久化；真实 Agent 生命周期安装日志写入器，此轮临时工厂未安装。此次证明实时追加，未证明完成后日志回放、完整 AgentLoop 组合、真实 provider 故障或 Token 账单。下次持久化验收应使用真实日志写入生命周期，不重建此轮已结束的 ephemeral 线程。

## 正式环境保护

正式端口3080保持原PID41660。只读核对413个会话身份、111条workflow完整记录、428份会话存储文件与原基线一致；running/waiting均0。历史corrupt子会话保持。隔离服务仅按原PID和出生身份清理；不取消正式任务，不修改provider、凭据或历史记录。
