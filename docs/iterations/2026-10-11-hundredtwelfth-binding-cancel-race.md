# 第112轮：Reviewer绑定回写取消竞态

状态：完整隔离门禁通过，已按已有用户授权加载；中途发生系统重启，随后用重启证明恢复服务。

## 修改

当 binding catch 中的 `waitInThread()`因取消、租约丢失、stop 或线程丢失无法写入 retained record 时，恢复释放路径并清理 exact Reviewer。仍可 retention 时，保持第111轮的同线程 binding retry。

## 证据

- RED：旧实现取消/stop后实际没有 `thread/unsubscribe`，日志在`../.codex-workflow-verification/hundredtwelfth-20261011/callback-binding-cancel-race-red-eb34d26a73e5446aa6b817de2b19cfac.log`。
- GREEN：`binding-race-green-final4.log`为2个测试通过；cancel、cancelSubmission、stop均一次unsubscribe、无模型回合、无fork、无异步事件；绑定成功重试保持同一Reviewer。
- `typecheck`通过；最终门禁 `isolated-jRqFo7` 由同一保留执行句柄 `unified-exec:76395` 完成，verify/release 各 1702/1702，182 份原生文件摘要，host、11 个恢复场景、diff、doctor 和包审计通过。
- 门禁完成后系统发生重启，旧正式 PID87604 的出生时间早于系统启动时间，PID及3080监听均不存在；没有伪造旧线程树。回滚备份217份，实际只加载 `lib/app-server-callback.js` 及map。
- 新 DSH PID23948、`win32:134362422978667990`，认证 HTTP200；416会话、431文件、111 workflow、119 queue 保持，工作流和队列哈希不变。Codex `config.toml` 在重启前已有差异，时间早于本轮部署，已单独记录，未覆盖。
- 首次受控重载因旧正式进程已被系统重启清理而安全停止；随后依据“系统重启发生在旧进程出生之后”的证明恢复服务。未重建旧 ephemeral thread，也未将系统重启伪装成原进程树退出收据。

本轮目标是清理竞态，不扩大模型重试或跨进程恢复范围。持续优化目标active。
