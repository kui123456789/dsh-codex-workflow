# 原生子会话的正文快照替换与临时流退役

状态：第94轮完整验收并正式加载。原verify/release各1632/1632、171文件/native回执和host/11恢复/diff通过，真实原exit0；独立浏览器六阶段通过。正式59112认证HTTP200，327输入/217产物审计及全量历史保持。真实provider与完整AgentLoop仍未验收。

## 实际问题与RED

App Server将`turn/plan/updated`标成replace，最终item正文与已流前缀不一致时也发送replace。然而CodexChildSession将所有非工具事件串接，造成旧计划状态与新状态堆叠；第93轮保留失败正文后，这种重复也进入原失败历史。

真实公开factory原7项控制6失败1通过：正文修正、反复计划快照、kind/item区分、工具buffer、空replacement和下一继续turn均失败；普通delta与成功最终结果控制通过。RED原exit1和逐项内容记录在仓库外本轮证据目录，不将单纯代码推测当故障。

## 固定来源与最小采用

agent-reach GitHub/gh读取[DSH固定提交](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c)：`packages/api/session-controller/src/client/sessions/assistant-stream.ts`、对应client测试、agent-loop assistant-stream及LICENSE，4份Git blob/SHA256核对，MIT许可保留。安装client fold及llm bundle另存字节/hash，不冒称它们来自该固定提交。

Context7先resolve Harness，再查询原native帧契约。检索返回生命周期/BlockAssembler说明，具体abandoned分支以固定源码和安装client为准：end使原activeAttempt退役，pending为空时返回abandonment；与原step/turn无关的新start可以继续，重叠start则要求rebaseline。安装Host累积器同样在end清空active，在start/chunk重建重连快照。

只在CodexChildSession中采用：当前段按完整kind/item相关的片段更新，replacement移除旧同item片段、保留其他item的原顺序。原生delta不可删除，因此先发送原display attempt的abandoned end，再在原turn/step重开修正快照；它不是模型回合、没有新thread/start或subagents.start。工具缓冲用同一规则；重复同快照不发新frame，普通delta仍追加。已提交工具前消息及前一turn保持历史，成功最终正文仍权威。

## 验证与未覆盖边界

新增12项控制：原六失败修正，外加原生Client无rebaseline、实时退役顺序、重复快照、工具boundary、交错delta和长item identity。实际完整五个相关文件56/56、fail/cancelled/skipped/TODO0及typecheck通过；原partial-output8项仍通过。none/zstd V4 writer关闭后独立读者确认只有修正快照进入历史，不重复旧draft；工具配对、stream重新组装及原会话继续保持。

这些测试使用实际安装ClientAssistantStream和受控Agent factory，不等于完整AgentLoop、provider断流或费用验收。没有把新显示尝试当成新model turn计数。后续独立真实浏览器/安装宿主组合已取得下面的证据。唯一完整链用327冻结输入和原并发/时限检查1632预期，不替换第93轮或56控制为全量结果。最终门禁和加载状态以[第94轮记录](../iterations/2026-10-10-ninetyfourth-child-replacement-output.md)为准。

## 已取得的独立实际UI证据

独立DSH_HOME、3110端口、stage后端与实际client注册方式，在named Playwright浏览器中控制provisional→replacement→waiting→reload→resume→disposed cold reload六阶段。原thread/child/tab保持，旧标记实时消失、corrected标记及失败历史保留，短continuation与最终plan在原child内可见；线程/child各创建1，turn2到3，释放一次。六份机器回执及两截图hash封存，浏览器关闭、原UI2实例tree退出确认。

此场景使用真实宿主服务与browser，Agent factory轻量、模型网关scripted-local。初始blank parent、旧CLI输出Junction和modal准备错误均记录，未当产品RED；补seed时先确认child/model0，再按原birth退出后更正独立夹具。正式profile/会话与provider保持，不宣称真实模型费用或完整AgentLoop已验收。原完整门禁继续运行，不以独立UI通过提前部署。

最终原24404全链exit0，verify/release各1632/1632、171文件语义回执及host/11冷回放/diff实际通过。原12176树11实例退出后仅交付已测JS/map，217产物全量hash匹配，formal59112认证HTTP200。414身份/429文件及111workflow/119queue保持；runtime交付与独立browser证据分别记录，早期待完成描述为时间顺序，最新状态见第94轮最终节。
