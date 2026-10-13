# 租约心跳的存储异常与原owner撤销

日期：2026-10-09。第74轮verify/release各1463/1463、host加载/恢复及diff通过，已受控加载到正式DSH，新PID41660，原会话及workflow数据保持。维护者第72/73轮已验收；原自然通知时序仍未单独定位。

## 实际反馈与范围

调查前轮未到达的lease通知，首先控制后台SubmissionExecution第一次load，真实SQL释放startup lease后触发原loss callback。结果modelTurns0、child1/dispose1、backgroundTasks0，排除了该探针的交接丢失假设。初次probe未提前消费start的晚拒绝，停止自己的client时退出1；修正观察责任后exit0，原日志保留，不把探针错误当成生产缺陷。

另一个实际SQLite竞争probe以第二个DatabaseSync连接BEGIN IMMEDIATE阻挡原续租，仅在隔离库缩短busy_timeout到10ms：旧timer两次抛出database is locked，loss callbacks0、models0；修复后uncaught0/loss1。正式busy_timeout及模型时限未更改。这是独立已证实缺陷，未证明它就是前轮自然通知缺失的原因。

## 固定源码比较

| 来源及固定提交 | 实际机制 | 本项目采用与取舍 |
| --- | --- | --- |
| [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile/tree/9f8c303c91998e8404a911dc11c54029812bca69)，MIT | lib/lockfile.js:99–200显式处理更新错误；部分错误先重试，判定compromised后停止timer、移除原登记并调用onCompromised | 借鉴不可信更新必须进入明确owner通知，使用本地已有onLost取消，不复制默认throw或文件锁重试阈值。 |
| [Node v24.14.0](https://github.com/nodejs/node/tree/f657bb8ed86365ff3fdbe32e27563e778b41486a)，核心MIT | doc/api/sqlite.md说明DatabaseSync同步执行及busy timeout；锁竞争超出等待可以由调用抛错 | 在实际timer续租边界消费异常，保留显式renew/release错误和现有数据库设置。 |

使用agent-reach GitHub/gh后端搜索和固定读取；5份源码/文档/许可原字节、Git blob SHA1及SHA256已核对，保存本轮github-sources/fixed-source-index.json。Context7确认proper-lockfile update/compromised契约；具体默认throw和重试边界以固定源码为准。没有增加依赖或升级Node。

## 实现及证据边界

makeManagerLease仅捕获heartbeat的renewLease异常，将ok保留false，沿原boolean失败路径停止本timer并调用原onLost一次。没有吞掉显式renew/release调用的错误、回放模型、制造新的lease owner或尝试隐藏backoff。

初始7项3个存储故障RED及3个有效控制通过，健康exact3次断言另因正常timer调度失败；修正为观察持续续租，未修改生产时序。最终8项通过，包含活跃Reviewer实际SQL lock：原turn被取消，child释放，无新thread/turn。相关53/53及typecheck通过。原SQLite probe GREEN证明0未捕获错误/1原丢失回调。

完整门禁及部署见[第74轮记录](../iterations/2026-10-09-seventyfourth-lease-heartbeat-errors.md)。SQLite故障发生在本地隔离连接，不代表正式provider自然故障、Token费用或浏览器验收；前轮自然通知时序结论保持未知。
