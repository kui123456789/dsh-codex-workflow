# 第二十一轮：review-only 创建与审查接纳之间的边界

## 真实故障

公开 reviewOnly 已经持久化，但尚未进入 ReviewExecution 时，caller abort、竞争审查租约和 manager stop 会留下无模型句柄的 `reviewing` 记录。status 会把旧 reviewing 记录补成 running，显式 review 又拒绝该相位。同一 owner 下 task 被替换时，旧调用还会采用新范围启动审查。显式 cancel 后返回 rejection，而非最新 cancelled DTO。

真实两个 manager/两个 WorkflowStore 共享 SQLite，并在模型选择期间同步两个调用，观察到 **2 个 workflow、2 个原生 child、2 个 Reviewer、2 次 native 调用**。不同 UUID 的 review lease 不能保护同一 session 的创建。

主任务独立重跑了上述 **6 个红例**，没有将静态推断当复现。

## 实施

- reviewOnly 初始保存 `phase: "executing"`；只有实际 ReviewObservation.begin 才进入 reviewing。移除初次 reviewOnly 绕过普通相位接纳的特例。
- 在模型选择后获取已有 session 创建 lease，在锁内再次检查 active workflow、abort/stop，再保存。完成的独立审查仍允许后续新 reviewOnly。
- 保留创建时的原 scope，传入 admission、租约内复查和 ReviewExecution 启动检查。owner、cwd、task、createdAt、mode、model/effort 或初始 attempt 改变时不创建 child/model，不修改替代记录。未填写 attempt 与 schema 规范化后的 0 等价，真实非零变化仍拒绝。
- 创建失败收尾只处理原 scope、尚无 attempt/processState 的 executing 记录。获取实际 review lease，再在 SQLite update 事务内核验 lease 和原 scope；有竞争 holder 时不修改整行/revision，不释放其 lease。
- cancel 返回当前原 scope 的 cancelled DTO；stop 等待已有前置流程结束。无模型时不虚构 continuation、不消耗 cycle；有原模型句柄的 waiting 恢复保持第 20 轮语义。

## 红到绿的证据

```powershell
pnpm exec tsx --test --test-timeout=10000 test/review-only-creation-admission.test.ts test/review-only-creation-lifecycle.test.ts test/foreground-review-startup.test.ts test/foreground-review-startup-lifecycle.test.ts
```

初步结果 **12/12**。随后追加模型选择/attempt 的必要红例，再与完整 workflow-resume 组合 **43/43**，其中本轮新增 **7/7**。使用真实 Manager、SQLite、DSH Session 和 native ChildSessionFactory；网关为本地脚本，没有正式模型调用。

| 新测试 | 核心断言 |
|---|---|
| creation-admission：save 后 caller abort | 返回原 Error 对象；原 id 可 status 定位，记录不伪装 running；同 id 显式 review 得到第一个 verdict/cycle |
| creation-admission：实际竞争 review lease | loser 整行/revision 不变，holder lease 保留；释放后同 workflow review 成功 |
| creation-admission：两个 manager 同 session 创建 | resolver 屏障确认两次都通过最初检查；持有 native 模型后只一个 record/child/thread/native，另一次拒绝 |
| creation-lifecycle：save 后 cancel | latest cancelled DTO 与持久记录一致，零 model/child/cycle |
| creation-lifecycle：save 后 stop | stop 等待前置流程；记录非 reviewing/running，store 关闭后重读完全一致 |
| creation-lifecycle：owner/task 替换 | 不继承新 scope，整行/revision 不变，零 child/model；owner 和 task 两分支分别验证 |
| creation-lifecycle：model、effort、attempt 替换 | 三次独立变更，每次只改一个字段；拒绝新 scope/attempt，整行/revision 不变，零 child/model |

第 20 轮 raw child 创建屏障中的单个旧相位断言改为 executing，明确它还未进入实际 observation；模型、清理、等待与取消断言没有放宽。

初步类型检查退出 **0**。恢复、权限、证据、接纳和审查重启相关组合 **123/123**，失败、取消、跳过均为 0。追加 attempt 检查曾因 schema 将 undefined 规范为 0 而拒绝正常创建；按真实 schema 语义修正比较后，上述 43 组合全部通过，没有放宽非零 attempt 的拒绝。完整门禁与正式加载结果另以实际运行记录为准。

## 固定来源与限制

[GitHub 机制核验](../research/github-durable-creation-admission-patterns-2026-10-06.md)核验 Inngest `6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a` 的创建/入队补偿归属，以及 BullMQ `71c9ca72f32108e21f8d339b95ff750606806f60` 的单 job 前置验证和保存/入队脚本。许可与上游测试范围见研究；只借鉴机制，不复制源码或新增框架依赖。

保存成功不证明模型开始，lease 存在也不证明模型可 continuation。竞争方可能还在启动，不以本次失败推断其终止。新记录使用可重试初始相位；历史 corrupt 或旧无句柄 reviewing 记录没有自动迁移。已有原线程丢失时仍不创建替代，也不由父会话代写计划。

## 门禁暴露的观察截止问题

首次完整 verify 为 **850/851**、异步警告 0；唯一失败是旧 runtime-smoke 的 300ms 观察用例，HTTP projection 查询耗尽 remaining budget 后误走外层 failed receipt。独立原文件可 8/8 通过，不能以独立成功否认全量暴露的截止窗口。

确定性回归先确认 initial inspection、prompt accepted 与首个 child descriptor 查询，随后仅保持下一次只读 projection 不响应，直到真实 AbortSignal 超时；结果复现同样的 `The operation was aborted due to timeout`。修复只在观察 loop 内捕获 TimeoutError，沿原 observation_timeout 输出和 receipt 收尾，保留最近 workflow/child、零 cancel、prompt 只发一次。initial、prompt 和 cancel 的未知提交/确认仍保持原错误行为，其他 API 错误继续抛出。旧 300ms 时长未提高，没有自动重试或替代会话。

runtime-smoke 完整 **10/10**、类型检查通过；新增确定性 deadline 与 API 拒绝负控各一个。主任务独立运行确认，未靠重跑成功掩盖初次门禁失败。

## 最终门禁与正式重载

修复后生产/测试冻结，从头完成实际门禁：

| 门禁 | 实际结果 |
|---|---|
| `pnpm verify` | **853/853**，98.72 秒 |
| 连续两次 `pnpm release:check` | 各 **853/853**，104.38/104.99 秒；离线 doctor、包审计通过 |
| `pnpm host:check` | 安装 DSH **0.1.7-rc.2**，九工具、peer/sidebar 契约通过 |
| `pnpm host:recovery:check` | **11/11 场景**，实际安装服务与 scripted-local 网关；browserUIVerified=false |
| 异步与差异 | 三次全量失败/取消/跳过均 0；全部门禁异步警告 0；`git diff --check` 通过 |

最终日志 `%TEMP%/dsh-twentyfirst-final-gates-c84dfdd3-44eb-4864-82e4-f799cd6a7f93/summary.json`。初次 850/851 的失败日志保留在 `%TEMP%/dsh-twentyfirst-final-gates-f6c1a850-f6e0-4b6c-9ba2-bbd2f7c93031/summary.json`；没有结束测试进程。相较上轮新增 **9 个回归**，没有正式模型调用。

正式重载前核验原 PID **57136** 的 executable/完整命令与 3080 listener、web profile 的 D 盘 Junction；409 sessions、无 running/waiting。只重启已确认服务。新 PID **55256**，认证交换 **303**，带 cookie 健康 **HTTP 200**，监听 owner 匹配；再次核验仍 409 sessions、无 running/waiting。

复用 Playwright `dsh-recovery-20261005`，标题 **DeepSeek Harness**。唯一 console 错误仍为 wallpaper-engine 背景音频资源 **404**，无 workflow 错误；未改该插件。receipt `%TEMP%/dsh-twentyfirst-reload-receipt.json` 保存旧/新 PID 和 workflow/App Server/Planner/ReviewExecution 构建 SHA256，token/cookie/旧聊天未输出。

变更留在工作区，未 commit/push/publish；历史 corrupt 和旧无句柄 reviewing 未自动迁移；真实上游模型故障的 UI 恢复仍不能由 scripted-local 与页面健康代替验收。持续优化目标保持 active。
