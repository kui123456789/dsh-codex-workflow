# Reviewer绑定回写失败后的同线程恢复

日期：2026-10-11；第111轮。

## 触发路径

提交审查使用 `ephemeral: true`。回调先创建并占用专用 Reviewer，再调用 `onThread` 将线程身份写回 DSH。旧逻辑把 `transport error: workflow store unavailable` 这类本地错误交给通用 transient/model 分类；第一次调用会保留线程，但第二次调用看到已有线程后跳过 `onThread`，直接发送模型回合。这样绑定尚未落盘就消耗了模型请求。

## 采用的恢复边界

`RetainedReviewer.bindingPending` 只对 ephemeral Reviewer 设置。绑定回调失败时保留原线程、owner、release 函数和订阅，并返回 `retryable_busy`；下一次同一请求先重试同一个 `onThread`，成功后才进入 visible/conversion turn。每次失败都继续保留同一标记和同一线程，不创建替代 Reviewer。非 ephemeral 请求保持原先的终止和释放行为。

本地错误文本不会被拼入诊断 reason；返回固定的“binding persistence failed; waiting for retry”。该标记不改变模型 transient 分类、原线程身份校验、取消和停止清理。

## 回归证据

旧行为 RED：同一 ephemeral 请求第一次绑定失败后，第二次调用的 `bindingCalls` 仍为1，模型回合已经启动。测试使用真实 fake App Server，记录 `thread/start`、`turn/start`、`thread/unsubscribe` 和 `thread/fork`。

修复 GREEN：

```powershell
pnpm exec tsx --test test/callback-binding-persistence.test.ts
```

结果为1/1；清理证明 `thread/start=1`、`turn/start=2`（绑定成功后才发生）、`thread/unsubscribe=1`、`thread/fork=0`、未处理异步事件0，原 App Server 进程已退出。完整 callback 组合75/75通过，类型检查通过。

## 限制

本轮只覆盖本进程内 ephemeral Reviewer 的绑定回写。进程重启后没有旧 native thread 句柄，不伪造恢复；跨轮次的新审查仍可创建新的 Reviewer。真实SQLite锁语句可能不同，但错误分类的边界由绑定回调位置决定：绑定未成功前不能开始模型。
