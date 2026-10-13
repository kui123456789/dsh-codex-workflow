# 第十八轮：审查证据与异步提交的接纳边界

## 现场核验

上一轮列出的无原 fingerprint 恢复边界仍未完成。本轮重新检查当前源代码，发现新 `submit` 已有 insufficient/fingerprint 门禁，前台 Reviewer 也在模型创建前拒绝不足证据。新增公开入口测试证明 absent/missing/outside scope 和 foreign owner **4 项既有保护通过**，没有为了凑修复而重复改这些已满足的条件。

真实取证之后、异步 lease 接纳期间，owner/phase 可以改变，原代码却仍准备新 submission、创建 child 并执行 callback。调用者还可原地修改 DTO，把新输入和已采集的旧证据配对。新增入口组初始 **7 项中 4 绿、3 红**，记录了 displaced record revision 被改写及模型调用。

历史 `retrying` 缺 fingerprint 的后台恢复初始仍调用一次 callback。独立恢复组初始 **1 红、2 正常对照**；对照证明模型开始后原文件删除会拒绝最终结果，合法继续仍使用同一 Reviewer/child/usage source。

## GitHub 来源与采用

[固定公开源码研究](../research/github-review-evidence-admission-patterns-2026-10-06.md) 核验 Prefect 在用户 flow 前校验并 short-circuit，Dagster 在计划/run 创建前拒绝缺输入，并对已有 known_state 重新验证当前配置。两项目固定版本均为 Apache-2.0。参数形状和资源定义不能替代本项目的 cwd、真实文件和 evidence freshness；本轮只借鉴接纳顺序，不复制代码、引入依赖或运行上游测试。

## 实施

- 提交入口先保存原输入副本。原 workflow/session、origin task、cwd/task/计划、合法相位等用既有身份函数捕获，进度和正常更新时间不成为身份。
- 取证后和 workflow lease 接纳后重读归属，在 SQLite preparation mutation 内再次核对原身份、阶段与取消/停止。原地修改调用参数不会更改原请求。
- 未接纳的清理只处理自己已绑定的 submission/lease；不匹配时抛出并回滚，防止早 return 仍写 revision/updatedAt。
- 每次后台 callback 前要求原 baseline 有可验证 fingerprint、非 insufficient，按原 cwd/changedFiles 读取当前证据并比较 kind/fingerprint。缺原基准不补造快照，缺证据或变更不发送模型。
- 重读后检查原 context 和实际 lease。合法 interrupted Reviewer 继续机制保持；不能执行的旧记录沿既有 terminal notice 发一次诊断，不消耗 review cycle。

## 可复现证据

```powershell
pnpm exec tsx --test test/bridge-evidence-admission.test.ts test/bridge-evidence-recovery.test.ts
```

入口使用真实 Manager/SQLite、公开 startExternalPlan/submit、真实 collectEvidence 和受控 lease 边界；恢复使用真实 Dispatcher/DSH Session/child factory 与严格脚本化网关。初步入口/恢复/route/submission 组合 **22/22**，恢复/checkpoint/submission 组合 **18/18**，类型检查通过。所有模型是本地注入，不是生产 NPM App Server 或正式模型调用；完整冻结门禁另列。

最终新增入口组 **9/9**、恢复组 **3/3**。最后两个入口用例在真实取得 workflow/submission 两个 lease 后，才改变 task/cwd 或中止 caller，再进入 preparation CAS；整个 workflow row（含 revision/updatedAt）精确保持拒绝前快照，callback/thread/child/queue 为 0。实际 lease owner 清空且 lease_until=0，证明租约确实释放，没有假装未取得资源。原有 foreground 不足证据模型前拒绝的单例另通过 **1/1**。

## 边界与下一步

文件 fingerprint 只证明读取时的状态，不锁工作区。新提交缺输入可以在原 workflow 修正后再提交；已失去原基准的历史 submission 不能伪造同轮恢复，应明确报告并由新的审查输入接纳。历史 corrupt 会话不迁移，Model/DSH 配置与凭据未改，不估算费用或 Token 节省。

## 最终门禁与正式重载

首轮完整 verify 为 **828/829**，唯一失败为旧 `concurrent manager.stop()` 夹具：直接保存 queued，却没有原 fingerprint，真实恢复门禁正确拒绝 callback，旧测试无限等待的条件在 10 秒超时。独立红例 **1/1** 后，仅为夹具补入文件准备完成后的真实 collectEvidence 结果，保留 ignores-abort、两 stop 共同等待、不能提前完成的原断言；finally 也释放 deferred gate，防失败清理挂住。修后 **1/1** 通过、类型及差异检查通过，没有降低恢复门禁。文件由既有 helper 写入后才采集 fingerprint，未用早于真实内容的旧快照。

| 最终冻结门禁 | 结果 |
|---|---|
| `pnpm verify` | **829/829**，92.82 秒 |
| 连续两次 `pnpm release:check` | 各 **829/829**，99.03/98.40 秒；离线 doctor、包审计、临时 tarball 清理通过 |
| `pnpm host:check` | 安装 DSH **0.1.7-rc.2**，九工具、peer/sidebar 契约通过 |
| `pnpm host:recovery:check` | **11/11 场景**；实际宿主服务配 scripted-local 模型网关 |
| 异步及差异检查 | 三次全量失败/取消/跳过为 0，所有门禁异步警告 0，`git diff --check` 通过 |

最终日志 `%TEMP%/dsh-eighteenth-final-gates-5362be65-ca9f-4fdc-8192-c807ed536a2a/summary.json`。前述 828/829 仅用于定位；最后完整門禁没有终止测试进程。

正式重载前再次核验 PID 46120 executable/完整启动命令、3080 listener、D 盘 Junction 与 409 sessions 无 running/waiting。只停止确认的服务树，首次启动 **PID 56520**；认证交换 **303**，带 cookie 健康 **HTTP 200**，监听 owner 与新 PID 一致。重载后仍无 running/waiting，未创建正式验收会话或模型调用。

复用 Playwright `dsh-recovery-20261005`，私有状态加载后标题 **DeepSeek Harness**。唯一控制台错误核验为已有 wallpaper-engine 背景音频资源 **404**，没有修改该插件。页面/API 健康不冒领生产模型故障恢复 UI 验收。

receipt `%TEMP%/dsh-eighteenth-reload-receipt.json` 保存旧/新 PID 与构建 SHA256；token、cookie、既有聊天未输出。source/research/tests/docs 留在工作区，未提交、推送或发布包。持续优化目标保持 active。
