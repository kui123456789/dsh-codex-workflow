# Reviewer绑定回写与取消竞态

日期：2026-10-11；第112轮。

## 原因

第111轮在绑定回调失败时先设置 `retainReviewer=true`，再调用 `waitInThread()`。如果取消、租约丢失、stop 或线程丢失同时发生，`ensureRunning()` 会在 `waitInThread()` 中抛错，因而不会写入 `recoverableThreads`；最终清理又因为 `retainReviewer` 为真而跳过 `releaseOwned()`。创建的 Reviewer 订阅和 App Server round pin 会泄漏。

## 修复

初次绑定和 retained binding 两个 catch 都包住 `waitInThread()`：如果 retention 发布失败，先恢复 `retainReviewer=false`，再释放同一 `claimedThread` 和订阅，最后重新抛出原取消/线程错误。绑定仍可恢复时保持原有固定 retry reason；释放逻辑继续一次性执行 `onThreadReleased` 和 `unsubscribe`。

这条边界不把取消或 stop 当作模型错误，也不创建新的 Reviewer。非 ephemeral 绑定失败仍维持终止释放语义。

## 回归证据

旧行为 RED：门控 `onThread` 在 `thread/start` 后挂起，调用 cancel/stop 后才让 hook 抛错；实际 `thread/start=1`、`turn/start=0`、`thread/unsubscribe=0`。日志：`../.codex-workflow-verification/hundredtwelfth-20261011/callback-binding-cancel-race-red-eb34d26a73e5446aa6b817de2b19cfac.log`。

修复 GREEN：

```powershell
pnpm exec tsx --test test/callback-binding-cancel-race.test.ts test/callback-binding-persistence.test.ts
```

三种动作（cancel、cancelSubmission、stop）均为 `thread/start=1`、`turn/start=0`、`thread/unsubscribe=1`、fork=0、未处理事件=0；原 App Server 进程退出。绑定成功后的同线程重试仍保持 `thread/start=1`、`turn/start=2`、unsubscribe=1。

## 限制

本轮只处理“绑定回调失败且 retention 无法发布”的进程内竞态。进程重启后不恢复旧 ephemeral 线程；取消后的新业务轮次仍按现有 admission 规则决定是否创建新 Reviewer。
