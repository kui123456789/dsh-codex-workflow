# 第76轮：原子会话成功释放后的持久回放

状态：隔离浏览器刷新及增强宿主恢复检查通过；完整verify/release/host门禁待完成。持续优化目标保持active。

## 问题与实现

第75轮实时侧栏继续已通过，完成后刷新失败。核对安装宿主与[固定外部源码](../research/github-session-journal-retirement-patterns-2026-10-09.md)，确认临时工厂缺少日志写入句柄。正式插件不需要为此延长子会话寿命或重建模型线程。

`scripts/host-recovery-check.mjs`加载真实SessionStore和JSONL后端。临时父/子会话取得写入句柄，保存发布前初始事件；原子会话释放时关闭并排空原写入器，再移除内存引用。另一个Context和持久化后端只读打开原日志，逐项比较完整事件、派生消息及父目录的原child身份。回执新增`persistedColdReplay: true`，仍标记`browserUIVerified: false`。

新增读取断言在原夹具先出现父日志not-found；调整读取顺序后原child同样not-found，退出1，两个RED均保留。补齐持久化生命周期后现有11场景通过，退出0。没有新增生产依赖，也没有修改workflow恢复或成功清理策略。

## 浏览器验收

独立DSH_HOME，端口3098，PID9480/birth `2026-10-09T07:31:51.6932840+08:00`。真实ToolRuntime、SessionStore、SubagentRuntime、JSONL后端和浏览器组件，临时Agent工厂及脚本网关，不配置真实provider。

- Parent：`ui-recovery-parent-ddcf50ae-1fe1-4d67-b071-61cda661ef4a`。
- Workflow：`1d4d5670-457e-4792-9cd2-35f752f19485`。
- Child：`b2bed8f3-54de-44c9-acbb-78721d73076c`。
- Thread：`planning-3d22b339-73a4-4c5f-8898-23c896008497`。

两次模型失败后为planning/waiting；省略workflowId调用resume，第三回合成功，thread/child创建各1、释放child一次。完成后的原生API返回child有效descriptor、34事件、3个turn/start；父目录仍仅原child。刷新原`tab2`资源后DOM保留短continuation及最终计划，无`subagent/not-found`。

浏览器恢复已保存的原生侧栏布局，未验证自动打开标签；此轮也未验证完整AgentLoop、真实provider错误或账单。成功后的日志回放不等于重启后能恢复ephemeral模型线程。

## 证据与正式环境

仓库外证据目录：`../.codex-workflow-verification/seventysixth-20261009/`；临时根：`%TEMP%/dsh-ui-persistence-20261009`。安全截图和回执复制到`output/playwright/persistence-20261009/`，该目录Git忽略。正式3080实例、provider、凭据、原parent和历史corrupt child保持；此轮没有正式重启、提交或发布。

隔离PID9480的原始两实例进程树已按birthKey核对并确认退出，命名浏览器`dsh-persistence76`已关闭。正式只读检查仍为413会话身份、111条workflow完整记录、428份会话文件一致，running/waiting0。

## 完整门禁观察

308份输入已冻结，manifest SHA256为`F1ECAD737B580ACDE9EDD3F00A85C834DE0F128B443DF72BD730C546C9E226A3`。唯一runner PID53340，birthKey `win32:134359764438484850`，门禁目录`final-gates-7d7a3d0c-da16-456b-9a2b-418b50fe9074`。依次运行verify、release:check、host:check、host:recovery:check和diff；完整测试预期仍为1463。

2026-10-09 07:42检查确认原runner和测试子进程仍活，verify已进入测试，typecheck/build已结束；完整结果尚未取得。最初以JSON反序列化后的ISO字符串比对birth误报false，实查是小数秒位数差异，原birthKey完全一致；没有因此重启或重复启动门禁。完成回执及完整测试计数才是最终判定依据。

07:58原summary确认verify exit0、1463/1463，失败/取消/跳过/TODO及异步警告0，1061.88秒；同一runner已进入release:check。第77轮独立浏览器发现Reviewer标签焦点缺陷，但候选修正只在临时包内验证，冻结输入未改。不能把本轮1463项通过扩展为该新增UI缺陷不存在。

## 原完整门禁终态

唯一runner53340于08:15:56结束，完成回执exit1。release测试1463项中1462通过、1失败，取消/跳过/TODO及异步警告0，1049.15秒。失败为`error initialization rejection cannot leave an accepted child or poison subsequent metadata`，报原idle进程树清理未确认；不是超时。原doctor和package步骤继续执行，但release总结果失败，外层后续host/host-recovery未执行，不能声称本轮完整门禁通过。

第78轮在输入仍冻结时定向复查该用例1/1通过，真实原PID退出、第二初始化拒绝及后续目录元数据正常；这不解释原整轮异常。原失败日志和终态回执均保持。原冻结runner退出确认后，第78轮才合入Reviewer UI修正与5项回归，使用新冻结版本重新验收；没有重启原测试或正式DSH。
