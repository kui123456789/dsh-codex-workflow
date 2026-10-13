# 第三十一轮：中止后收齐原 Planner 创建响应

日期：2026-10-06。仓库 `D:\工作文件\projict\dsh-cc\dsh-codex-workflow`，HEAD `abb6174d283ced56590bee90b3511948e494b3f0`。保留既有未提交修改，没有 commit、push 或发布。

## 现场解释与实际复现

用户提供的解释将未返回 workflowId、`no active` 和 corrupt child 合并为“记录从未存在，只能重开或父会话代写”。当前源码先落盘再建 child/thread；status 原本仅查非终态，resume 已支持无 ID，原生 child 历史状态也不等于 App Server 线程存活。这些推论不足以证明原后端丢失，父会话代写违反工作流契约。

真实本地协议门闩在 server `threads.set` 后、原 `thread/start` 回复前中止 caller。真实 AppServer、SQLite、原生 DSH child 参与，未调用上游模型。首个命令实际 **2/5 通过、3 失败**，2.13s；取消与停止清理为两个通过控制：

```powershell
pnpm exec tsx --test "$env:TEMP/dsh-thirtyfirst-late-start-probe-680eccf4-ec3a-4ee4-af28-08e8b9034510/planner-late-thread-start.test.ts"
```

日志 `%TEMP%/dsh-thirtyfirst-late-start-baseline-red.log`。失败分别为 caller abort 丢弃已创建原线程 ID、真实创建失败无 ID 诊断找不到落盘记录、提前取消仍保存初始 workflow。

## 修复边界

- 初始落盘前、取得创建租约后核对 caller。创建前核查 owner/phase/stop，已开始的创建操作保留原有有时限的响应接收器；不因 caller 或 lifecycle abort 丢弃迟到原 ID。
- 迟到原 ID 返回后，caller abort 停车等待，复用原 child/thread；原 caller 不发送模型回合。cancel/stop 仅清理原返回资源一次，普通模型回合取消规则不变。
- status 的 `running` 来自实际内存中的创建流程，不由旧 durable planning 行推断。没有 active 时，仅当前父 session 最后一条 failed Planner startup 可供诊断；终态不可恢复，也不回退更旧任务。
- 原 RPC 超时、权限错误、进程退出而从未得到 ID，仍明确不可恢复；不编造旧上下文、不启动替代 Planner、不父会话代写。

参考已核验的 [异步资源认领研究](../research/github-async-resource-adoption-patterns-2026-10-06.md)，采用原创建者接收、认领前重核、迟到资源清理归属；未引入框架或复制其代码。

## 验收

首轮目标 8/8（正式 7 场景加原 start-boundary）通过。独立检查随后发现两处空窗：save 已落盘但返回被 hold 时尚未登记 startup；迟到线程的 metering bind 先读取后继 owner，向替换记录写 unknown source。实际扩展回归 **4/4 RED**，日志 `%TEMP%/dsh-thirtyfirst-start-save-scope-red.log`。修复在保存前登记原启动并统一 finally 清理，usage binding 捕获原始 owner/task/cwd/createdAt/id，并在写入 CAS 内重核。

最终目标 **12/12**，2.53s，`pnpm typecheck` 退出 0；日志 `%TEMP%/dsh-thirtyfirst-planner-start-final-green.log`。包含保存等待、创建等待、真实失败诊断、原 ID 恢复、预先取消/租约等待取消、task/cwd/owner 漂移，以及 cancel/stop 一次清理。没有减少失败次数、放宽后继完整 row/revision 等值断言或扩大生产时限。

| 冻结门禁 | 实际结果 |
|---|---|
| `pnpm verify` | 977/977，180.82s，异步警告 0 |
| `pnpm release:check` 第一次 | 977/977，204.57s，doctor/pack 通过，异步警告 0 |
| `pnpm release:check` 第二次 | 977/977，373.43s，doctor/pack 通过，异步警告 0 |
| `pnpm host:check` | 退出 0，4.20s |
| `pnpm host:recovery:check` | 退出 0，9.38s |
| `git diff --check` | 退出 0 |

全套失败/取消/跳过均 0，两次 pack 临时 tarball 清理成功；offline doctor 明确有 5 个跳过项，不冒称实际登录/上游模型验证。最终结果 `%TEMP%/dsh-thirtyfirst-final-gates-a9472a4e-6416-483d-95d4-71020757d07e/summary.json`。第三十轮最初的 14 个失败/超时只是此前失败证据，不作为最终验收。

## 正式 DSH 重载

即时确认原 PID 29828 的可执行文件、DSH 命令和 3080 listener，认证 metadata 411 会话、runningIds=[]、waitingWorkflowCount=0，才停止该精确进程树并以相同参数启动。实际新 PID **75648**，listener `127.0.0.1:3080` 归该进程，认证 HTTP **200**。receipt `%TEMP%/dsh-thirtyfirst-reload-receipt.json` 包含三个主构建 SHA256 和十个相关模块 SHA256；未改 provider、登录配置、profile 或历史 corrupt child。

重载后仍 **411** 会话；指定原 parent `session-1f26c68f-4026-41e2-bca9-0d0b5812fe55` 的 metadata 精确核对为存在，没有读取聊天内容。页面加载后 availableCount=1，runningIds=[]、waitingWorkflowCount=0。服务器 stderr 只有既有 SQLite experimental warning。

原 Playwright handle 已权威报 missing 后，按原名称新开、载入新私有认证，页面标题 **DeepSeek Harness**，控制台 warnings=0；唯一 error 为既有 wallpaper-engine 背景音频 404，未改该插件。没有在正式 provider 注入断流或测量实际费用；本地协议/安装宿主恢复与认证 UI 健康分开记录。

第三十/三十一轮合并构建已重载。本轮已核验事项完成，持续优化目标仍 active，没有 commit、push 或发布。

写入期间 D 盘空间耗尽，doc30 和新的测试文件因失败写入被截断；两者已从本轮读证与 C 盘测试草案恢复。75 份忽略的浏览器诊断文件保全到 C TEMP，逐文件 SHA256 核对，原 D 路径建立 Junction，保留既有访问路径。receipt `%TEMP%/dsh-thirtyfirst-browser-artifacts-preserved-36f72094-4151-4d3b-a1db-606060007b8e/receipt.json`；没有清理用户数据、依赖、快照或修改正式服务。
