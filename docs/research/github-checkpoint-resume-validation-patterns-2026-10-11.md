# Checkpoint 与同线程恢复的状态校验模式

状态：第100轮完整验收与正式加载完成。61项相关回归、typecheck及diff通过；首次1663通过/1失败的原gate证据保留。修正gate `isolated-oxdyLi` 的verify/release各1666/1666、175份原生文件摘要、host/11恢复/diff通过，原47604真实exit0。正式DSH PID51296健康HTTP200；111条正式记录均兼容，415会话/430文件、111workflow/119queue及7份受保护配置保持。

## GitHub 来源

| 项目 | 固定源码 | 观察到的机制 | 许可证 |
| --- | --- | --- | --- |
| [LangGraph](https://github.com/langchain-ai/langgraph) | [`types.py`](https://github.com/langchain-ai/langgraph/blob/b4991f1ba36a2449ab59c38ab71828ee865bff84/libs/langgraph/langgraph/types.py)、[`_retry.py`](https://github.com/langchain-ai/langgraph/blob/b4991f1ba36a2449ab59c38ab71828ee865bff84/libs/langgraph/langgraph/pregel/_retry.py) | `RetryPolicy` 明确 attempt、上限、退避和 `retry_on`；每次尝试携带不可变的 task/thread 上下文 | MIT；license blob `fc0602feecdd6748623c852ab534e1ca612673c7` |
| [OpenAI Agents Python](https://github.com/openai/openai-agents-python) | [`run_state.py`](https://github.com/openai/openai-agents-python/blob/125efa029b4bfd84238bd2c4fd69c3406f802663/src/agents/run_state.py) | `RunState` 以 schema 版本、当前步骤、pending input 和不可恢复终态作为恢复边界；未知或不完整状态不应伪造下一次模型调用 | MIT；license blob `e5ad2c5aa30343f143a5c418004ca1a8d2cfaff4` |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | [`_checkpoint.py`](https://github.com/microsoft/agent-framework/blob/fd52de71579162a888fb2dd7510c57c6014dcdfc/python/packages/core/agent_framework/_workflows/_checkpoint.py) | checkpoint 明确 workflow/graph 兼容信息、版本、前序链和 pending events；恢复先校验形状，再交给执行器 | MIT；license blob `9e841e7a26e4eb057b24511e7b92d42b257a80e5` |

通过agent-reach的GitHub/gh后端读取固定commit；四个项目的源码及许可证共9份原字节均核对长度、Git blob SHA1和SHA256，证据见第100轮 `source-evidence/fixed-source-index.json`。Context7补充核对Microsoft checkpoint与Node v24进程语义。没有执行外部代码或引入框架依赖。

## 本项目采用

DSH 已经把 ephemeral thread 与 child handle 留在进程内；durable `retryState` 只应描述可验证的恢复意图。此前 schema 只检查 terminal cleanup 和 process identity，恶意或损坏的 `stage`、`attempts`、布尔标记或 checkpoint step 仍可能被读入。

本轮在 `workflow-schema.ts` 增加严格校验：已存在的字段必须是合法 Planner/Reviewer stage、正的安全整数attempt、布尔生命周期标记和受支持的checkpoint step。枚举字段要求真正的字符串，不能用 `String()` 把数组转换成合法值。已是v2的迁移入口也执行校验。旧版只有 `interruption` 的清理记录继续可读。

真实存取路径探针显示：旧实现读取 `stage: ["planning"]` 的坏记录后仍报告 `continuation.available=true`；修正候选明确报告workflow记录无效。两次探针都保持原记录和恢复handle、模型请求0。SQLite回归另证实非法save/update不改变payload或实际revision，损坏记录的status不会探测模型线程。

## 本地证据

旧实现6项回归3通过/3失败，首次候选4通过/2失败，严格候选6/6。与store、status、新审查轮次的相关控制合计61/61；typecheck通过。首次原gate PID46564正常结束并返回exit1，其175份文件摘要证明唯一失败是旧启动器数字PID消失断言。它在已确认退出后再次检查同一个数字PID；缺少失败瞬间的出生时间，不能把它直接认定为生产恢复缺陷。

夹具改用已捕获的PID/出生时间及原实例清理接口，保持两种新审查请求拒绝和原后台存活的业务断言。独立该场景1/1，后续全文件控制通过。Node固定源码明确PID重分配可能使后续signal命中另一个进程；此处复用已有实例验证实现，未放宽正式恢复条件。完整gate与正式加载均已完成，产物差异只有schema JS及map；浏览器交互和真实provider故障仍不在已证明范围。
