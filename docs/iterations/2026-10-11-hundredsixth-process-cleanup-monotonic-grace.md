# 第106轮：原进程清理确认宽限期采用单调计时

状态：完整验收与正式加载完成。修正verify/release各1683/1683、178份原生文件摘要，host、11恢复及diff通过；新正式DSH PID46240认证HTTP200。第一次完整门禁1679/1680、实际exit1及全部探针失败保留。

## 改动与来源

`stopCapturedProcessTree()` 原墙钟deadline会因时钟回拨延长等待、前跳过早结束。两处截止读取改用`performance.now()`；原identity证据、一发termination、独立exit证明和50ms轮询保持。固定p-retry/Node源码、许可证、复现命令及实际边界见[研究记录](../research/github-process-cleanup-monotonic-grace-2026-10-11.md)。

第一次完整verify中callback原场景清理未确认，观测表明仅一次退役清单失败即可缓存无法恢复的PID-only evidence。补充候选在同一native child仍live且属于原SDK时补读一次，随后再核验owner；持续不可用或退役仍拒绝，清理期间不启动模型或替代进程。[清单观察证据](../research/github-process-retirement-census-observation-2026-10-11.md)保留原失败和探针修正。

## 验证与计划交付

- 同一原边界RED5/7、GREEN7/7，无系统时钟修改；typecheck通过。
- 真实process instance、fork创建、permanent stop与cleanup相关场景28/28通过。
- 第一次唯一门禁`isolated-dxNYPO`原PID53156/`win32:134361570882827850`，1679通过/1失败，无取消/跳过，actual exit1。334输入和217正式产物及metadata保持，release/host未运行；没有覆盖首次失败或仅凭聚焦结果交付。
- 补充退役清单原边界RED1/3、GREEN3/3；首次路径/拦截作用域错误独立保留。
- 扩展相关场景最初30/31：仅旧`missing-census`次数断言失败，原拒绝和不得回填断言均通过。改为同一live owner的最多两次清单读取后，相关31/31、callback/清单28/28通过，初次失败证据保留。
- 修正唯一门禁`isolated-IIomJm`原PID42160/`win32:134361590175203420`实际exit0，verify/release各1683/1683、178份native摘要；失败/取消/跳过/TODO及异步警告均0，host/11恢复/diff通过。
- 336输入无漂移，217正式产物及mtime/ctime保持至受控交付。只交付`lib/app-server.js`/map与`lib/infrastructure/process-tree-cleanup.js`/map四份产物，最终217份哈希与已测构建一致。

完整门禁通过后按既有明确授权受控加载，保留原会话、workflow、queue、provider/profile/凭据、原parent和历史corrupt child。首次RED、原104/105轮证据及回滚目录保持，未commit、push、publish，持续优化目标active。

重载期间发现用户新增了已加载空白会话`session-2f1f7764-0bf5-4baa-84ae-ae997cd324ac`；总数从415增至416。只读核实其日志只有未播种session header，无消息、工具或模型回合，API双查空闲且无待恢复workflow/lease。复用已有明确重启授权，在这一指定空运行态的有界保护条件下受控重载，没有归档/删除操作，也未把偏好问题的沉默当作新授权。

旧PID47864的11个原进程实例确认退出，新PID46240/`win32:134361611415782030`认证HTTP200。最新416会话、431文件、111 workflow、119 queue及7份profile/provider/凭据字节保持；新空白会话、指定原会话、原parent、历史corrupt child、取消诊断marker和休眠inbox保留。新运行态available0，当前无running/waiting workflow或lease。

完成收据、原native退出、原会话清单、空运行态证明、授权来源与完整217构建回滚位于`../.codex-workflow-verification/hundredsixth-repaired-20261011/`；首次门禁和探针仍独立保存在`hundredsixth-20261011/`。正式boot检查未宣称浏览器交互，持续优化目标active。

本轮只验证时钟校正下的退出确认grace；自然清理异常根因、真实provider故障和Token账单不在已证明范围。
