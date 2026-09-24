# review_only 空任务恢复修复 — 2026-09-14

修复版：**1.0.14**。保留之前的 DSH 0.1.5 适配与 CLI 更新。

## 问题与修复

原首次 `review_only` 路径先调用 App Server 创建空任务，再交给 CLI
`exec resume`。没有持久化对话历史时，交接报 `codex thread ... does not exist`。
此前的正式会话失败记录保留在 [CLI 更新报告](cli-update-2026-09-13.md)。

现在只有首次 `review_only` 使用持久化 `codex exec --json` 创建审查任务。
收到完整且有效的 `thread.started` 事件后立即保存真实任务 ID；结构化转换或
CLI 进程随后失败，重试仍恢复同一任务。后续复审和格式修正继续使用 `exec resume`。
规划、桥接和已有独立 Reviewer 的任务绑定不变，不以新任务绕过无效的已有 ID。

缺失、非法或相互冲突的创建 ID 会拒绝继续；任务记录写入失败或取消先赢时，
停止 CLI 子进程，不进入转换和结论应用。停止操作等待进程退出和待完成的 ID 写入。
没有数据库迁移，也不会自动替换旧失败记录里的任务 ID；旧空任务工作流可取消后重新创建。

## 回归验证

修复前的定向测试复现了 `empty App Server tasks cannot be resumed by CLI`。
修复后验证了：

- 首次创建与失败后复审只使用一个任务。
- 分块、重复及无末尾换行的 JSONL 身份事件。
- 缺失、非法、冲突 ID 的拒绝路径。
- 持久化失败、取消竞态、等待 ID 写入期间的停止与清理。
- 原 Planner、桥接与历史 Reviewer 的恢复行为。

完整发布检查通过：**388 项测试通过、0 失败**，含类型检查、构建、离线
doctor 和打包白名单检查。`host:check` 使用本机 DSH 0.1.5-rc.1 的真实核心包
成功加载/卸载构建 1.0.14，注册并移除全部 8 个工具。

## 真实 CLI 两轮验证

命令：设置 `DSH_CODEX_LIFECYCLE_MODEL=gpt-6-astra` 后运行
`pnpm review-only:accept`。使用 Codex CLI 0.154.0、真实登录、真实模型请求和真实
任务持久化。DSH 工具上下文是隔离夹具，不是正式 profile 中的模型驱动会话。

- 第一轮故意把加法实现为减法，Node 测试失败；审查返回 `changes_requested`，工作流进入 `fixing`。
- 将实现修正为加法，3 项 Node 测试通过；复审返回 `pass`，工作流进入 `passed`。
- 工作流：`41b0dac7-fa34-4ad7-bab1-f9cd11d57d63`。
- 两轮共用任务：`01a09ce7-0b37-7ee1-8751-6cefca81d35f`。
- 审查轮数为 2。实际命令记录是 1 次首次创建、1 次恢复、4 次临时转换/校验；
  可见审查均为 high effort，内部转换/校验为 low，全部保持只读。
- 原始报告：`C:\Users\Z1803\AppData\Local\Temp\dsh-review-only-accept-VjnFz8\result.json`。

实机验证已运行修复代码，启动时版本字段仍为 1.0.13；随后发布元数据递增为
1.0.14，修复逻辑没有再改动。最终版本另通过完整发布检查与真实宿主加载检查。

源码和 `lib/` 构建已更新，正式 DSH 未在本轮重启；已运行进程须重新加载新构建后生效。

## 用户授权后的正式重载

2026-09-14 08:45（Asia/Shanghai），用户明确要求重载。确认无运行中的会话后，
受控重启桌面壳及其 Web 子进程，未关闭已有浏览器窗口。
新桌面主进程 PID 为 16644，Web PID 为 26220，仍使用 127.0.0.1:3080。
新进程从原项目链接加载构建 1.0.14，正式插件 inventory 显示 enabled=true、active。
认证请求返回 200 HTML，未认证请求仍为 401；会话数量前后均为 56。
profile 的 package.json、cordis.patch.yml 与 DSH 凭证文件哈希未变，SQLite integrity_check=ok。
确认只有一个桌面主进程和一个正式 Web 进程。此次重载检查没有再次调用审查模型。

## 重载后的正式 DSH 模型驱动验收

2026-09-14 08:55（Asia/Shanghai），用户要求运行测试后，再次运行 `pnpm verify`：
**388/388 通过，0 失败**。同时在已重载的正式 Web profile 中，由真实 DSH 模型
执行 Node 测试并调用 `codex_workflow_review_only`，不是前述隔离工具上下文夹具。

- 工作流：`10ceb7af-5a2c-4a74-af70-5eb1c418aae2`，mode=`review_only`。
- 实际新建并绑定的 CLI 任务：`01a09d67-d117-7862-ae22-348966092e7a`。
- Reviewer 模型：`gpt-6-astra`，high effort；系统 CLI 为 0.154.0。
- 最终 phase=`passed`，verdict=`pass`，reviewCycles=1，findings=0，testGaps=0。
- 结果返回原 DSH 会话 `session-12bd3089-daf0-4fe0-a8b9-df411a618894`，
  持久化记录出现 `turn/end`，API 确认 running=false。
- 正式插件保持 active，认证 HTTP 请求返回 200。未出现空任务恢复错误。

这次验证补齐了正式 DSH 中首次只审查、真实 CLI 创建、结果转换及返回会话的完整链路。
