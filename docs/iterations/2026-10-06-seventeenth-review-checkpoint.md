# 第十七轮：已完成审查结果的检查点

## 实际问题

真实公开 `startExternalPlan → submit → recoverCallbacks`，配真实 CallbackDispatcher、SQLite 和原生 DSH child factory，最初 **1 个红例、1 个正常对照**。原可读审查与结构化转换已成功，权威校验失败后，却创建第二个 Reviewer 重跑完整审查。原 child 已提前 dispose；自动恢复没有再创建显示 child，因此仅检查 child 数量为 1 会漏掉实际关闭。

## 采用的机制

[固定 GitHub 研究](../research/github-review-checkpoint-patterns-2026-10-06.md) 对照 Inngest 的已完成步骤存储/读取、Temporal 的历史 Activity 结果恢复。任务 ID 不能代替输入与证据身份；完成结果和仍在运行的模型线程分别管理。本轮只借鉴机制，未复制框架源码、增加依赖或运行上游测试。固定版本的许可及证据强弱见研究文件。

## 实施

- 本进程 `submissionReviewResults` 保留已完成的规范化结果、可读文本和原 child。回调成功释放的原线程与 pin 不再重新持有或重新创建；恢复仅调用私有校验。
- SHA256 身份绑定 workflow/submission、原 session/origin task、cwd/task/批准计划、前次已应用审查、提交输入、模型选项和原 evidence。进度、尝试次数和合法 lease generation 不属于结果身份。
- 缓存写入与读取各 `structuredClone`，下游处理不会改写原结果。复用前按原 scope 读取真实工作区证据；接受结果前再读一次，并在 SQLite mutation 内检查当前 lease 和原身份。
- 保留原 child 到校验完成；继续显示追加短校验指令。取消、停止、失效结果结束时只清理一次；真实 apply 才计业务 cycle。
- 持久 `submissionReviewPending` 仅保存布尔标记，不保存结果、child 或临时线程句柄。新 manager 缺失该进程内结果时明确失败，不重新运行已完成的 Reviewer。
- 第一次 marker 写失败后，成功的 busy/abort/retry 提交会补回待校验标记；未校验的缓存不向 `review-end` 发布 verdict/result。
- 进度与 heartbeat 在事务内核对原 scope/lease。失配 heartbeat 停止；旧 lease cleanup 对不属于自己的行抛出并回滚，避免早 return 仍改写 revision/updatedAt。

## 红到绿证据

| 场景 | 原始失败 | 修后证据 |
|---|---|---|
| 已完成回调后 authority 失败 | 可读调用/Reviewer 为 2，旧 child 已关闭 | 可读调用/Reviewer 为 1，原 child 保留，最终精确 staged command apply 一次 |
| 生命周期组 | 首组 6/6 红：重复审查、提前关闭或过期结果发布 | 增强后的 7 个顶层测试全绿；覆盖输入/task/owner、workspace、cancel/stop、不同 submission 和异步最终检查 |
| 结果投影 | authority 失败后仍向父 Session 发 pass/result | 等待事件保留可读诊断，verdict/result 未发布 |
| lease 清理 | 新 owner 行 revision 23 被旧清理改成 24 | revision、updatedAt 精确保持替换快照 |
| 单次 marker 存储故障 | runtime 缓存存在，但 durable retrying 没有 pending 标记 | 后续成功事务补回布尔标记，SQLite reopen 保留 |
| heartbeat | held 350ms 后旧任务改写新 owner 的时间戳/进度 | 原 owner/task/revision/updatedAt/progress/elapsed 快照完全不变 |
| manager 重启边界 | 必须禁止以新 Reviewer 代替丢失结果 | SQLite 标记存在，新 manager 无缓存时明确失败，无新增 callback/Reviewer/child |

最终两套新测试 **10/10**；authority/submission/tools 组合 **60/60** 为阶段证据，最终完整门禁另列。测试使用严格脚本化模型网关，真实 Dispatcher/SQLite/DSH Session/child factory；未触发正式模型，不冒领生产 App Server 协议或 UI 故障验收。

## 边界

本轮 checkpoint 为具有可验证原 evidence fingerprint 的提交建立，结果只在原 manager 进程内；它不是 Temporal 历史重放或跨进程线程恢复。任何存储均未成功提交前的崩溃，无法提供持久完成证明。marker 不能恢复结果内容，原进程丢失必须报告，不伪造上下文。文件系统 fingerprint 是读取时的快照，不锁工作区。无原证据的 legacy 提交不取得缓存恢复证明，后续需继续核验该输入边界。未估算 Token 节省或费用，历史 corrupt 会话未迁移。

2026-10-06 补充：[第十八轮](2026-10-06-eighteenth-evidence-admission.md) 已核验该 legacy 输入边界，并在每次后台 callback 前拒绝缺失或不可验证的原证据，避免通过重新运行 Reviewer 替代原基准。

## 最终门禁与正式重载

首次完整 verify 为 **815/817**：旧结果策略与幂等夹具在 `submit` 返回后立即 apply，后台仍处于 `sending`。独立窄组 **2/2 红**，确认不是业务允许的应用相位。只修三处夹具屏障，等待同 submission 的真实 `waiting_verdict` 且 lease 清空，再执行原完整策略/幂等断言。修后 **2/2 通过**，没有固定 sleep、放宽生产 apply 条件或修改结果策略。

| 最终冻结门禁 | 结果 |
|---|---|
| `pnpm verify` | **817/817**，90.40 秒 |
| 连续两次 `pnpm release:check` | 各 **817/817**，96.98/94.52 秒；离线 doctor、包审计、临时 tarball 清理通过 |
| `pnpm host:check` | 安装 DSH **0.1.7-rc.2**，九工具及 peer/sidebar 契约通过 |
| `pnpm host:recovery:check` | **11/11**，scripted-local 网关配实际宿主服务，未声称浏览器故障验收 |
| 异步与差异检查 | 三次全量失败/取消/跳过为 0，所有门禁异步警告 0，`git diff --check` 通过 |

最终日志 `%TEMP%/dsh-seventeenth-final-gates-deaa493c-ea3c-4160-8869-43ea41457328/summary.json`。前述 815/817 只用于定位，最后一次完整门禁没有终止测试进程。

正式重载前再次核验 PID 42020 的 executable/完整命令、3080 listener 和 D 盘 Junction，409 sessions 无 running/waiting。taskkill 对退出中的部分子进程返回非零，控制脚本在启动前停下；逐项重查原 PID 与列出的子 PID 均已消失，3080 已释放，才接续同次重载的启动步骤。没有因观察超时重复启动或停止其它 node。

新服务首次启动 **PID 46120**，认证交换 **303**、带 cookie 健康 **HTTP 200**；监听 owner 与新 PID 一致，重载后仍无 running/waiting。复用 Playwright `dsh-recovery-20261005`，新私有状态加载后标题 **DeepSeek Harness**。唯一控制台错误核验为已有 wallpaper-engine 背景音频资源 **404**，本轮未改该插件。

receipt `%TEMP%/dsh-seventeenth-reload-receipt.json` 保存新旧 PID 与 Workflow/App Server/Planner 构建 SHA256，启动 token/cookie/旧聊天内容未输出。没有追加正式验收会话或模型调用。变更保留在工作区，未提交、推送或发布包；持续优化目标保持 active。
