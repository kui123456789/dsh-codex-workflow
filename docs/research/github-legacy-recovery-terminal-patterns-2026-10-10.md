# 旧提交恢复迁移的终止错误优先级

状态：第96轮完整验收/正式65896加载封存后，第97轮候选四文件已按hash采用；新47664在`isolated-9olNA1`验证329输入/1651预期链。局部6/6、legacy1/1、policy2/2及typecheck通过，不代替新完整门禁；尚未正式加载候选。

## 正确反馈环

使用真实 `WorkflowManager.recoverCallbacks()`、App Server协议client、dispatcher、SQLite状态及原生DSH子会话夹具。先在Thread或Turn入口注入权限/Schema拒绝，等待原提交真实失败，再设置原失败通知已送达，驱动后台恢复。通知未送达会挡在迁移前，不能检验该分支。

四项混合诊断包含 `already has an active writer`，两个对照只含原终止诊断。旧实现6项中2通过、4失败：恢复数由0变1，原SQL行改变，错误从403/Schema改成原Reviewer不可用。既有资源保护阻止了额外模型请求；不把状态变化误报成已复现Token重复花费。首个三项独立探针也失败，原日志保留。

## 固定来源和因果定位

通过agent-reach GitHub/gh重新核对 [p-retry固定提交](https://github.com/sindresorhus/p-retry/blob/1472907affe8d6107aba5884abc36d6361b3042e/index.js)。本轮保存同提交index与MIT license原字节，独立核对Git blob SHA1、SHA256和远端SHA；源码在任何失败尝试/重试钩子前识别AbortError并返回原错误。借鉴“恢复机会不能覆盖已确认终止”的分工，复用本项目现有 `transientReason`，没有引入库或执行下载代码。

三个排查方向为迁移的writer宽松匹配、通知状态干扰、原资源退休误判。混合与不混合对照保持原入口、通知状态和退休路径相同，结果只在writer片段出现时变化。实际迁移只匹配该片段，跳过统一终止分类；原资源退休是错误恢复之后的保护结果。

## 候选与验证

只为 `isRecoverableContentionFailure()` 的writer分支增加共享暂时性分类检查，保留完整已知legacy busy诊断分支。原权限、Schema等终止诊断不再进入持久恢复，原失败记录及诊断保持。

- 新六项回归6/6，原SQL行、线程/请求/child相关计数保持，失败/取消/跳过/TODO0。
- 原完整legacy busy/active-writer迁移测试1/1，继续验证lifetime attempts与既有恢复资格。
- 原终止审查策略文件2/2，真实线程退休仍拒绝替代，创建前失败后的用户明确首次审查重试仍有效。
- 全候选 `pnpm typecheck` 通过。以上为三次独立测试结果，未拼成一次完整门禁。

候选四文件为workflow源码、六项新回归、README和CHANGELOG；hash保存在第97轮 `prepared-candidate.json`。预期新完整1651项/173文件/329输入；尚未运行该全量链。先完成第96轮verify/release、宿主/11恢复及正式精确加载，再按base hash采用第97轮并获取独立门禁。provider/profile、原数据及历史corrupt child保持；原自然停止超时的原因仍未由本轮定位。
