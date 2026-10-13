# Node测试取消与原夹具清理

日期：2026-10-09。第73轮verify/release各1455/1455、host加载/恢复及diff通过；全部217份生产构建与正式版本一致，保留DSH PID4448，维护者测试通过原Junction生效。原第72轮release失败记录保留，原自然通知时序未单独定位。

## 实际现场与最小反馈环

第72轮release中，一个声明30秒的共享Reviewer用例取消后，工作进程仍带着原本地模型进程等待超过20分钟。其他文件已结束；保留原PID/birth、SQLite状态和进程树后，仅退休该scope，原门禁结算exit1、1447通过/1取消，明确错误test timed out after 30000ms。

受控fixture-cancellation-probe.mts阻挡同一个lease通知，取消调用：旧helper未退出，1个background task、1次native call、1个child、dispose0，与等待现场一致。该probe退出1；清理只针对自己原协议进程。原正常通知为何没有到达尚未单独确认，不能把对清理缺口的证明扩大成生产lease竞态已修复。

## 固定源码与取舍

| 来源及固定提交 | 机制 | 本项目采用 |
| --- | --- | --- |
| [Node v24.14.0](https://github.com/nodejs/node/tree/f657bb8ed86365ff3fdbe32e27563e778b41486a)，核心MIT | doc/api/test.md的context.signal用于取消测试子任务；context.after在当前test结束后运行。test runner控制测试结果，不会替任意awaited Promise释放资源 | 原TestContext signal进入fixture phase observer；after hook与原finally共享幂等close。测试取消仍是取消，不制造pass。 |
| [p-cancelable](https://github.com/sindresorhus/p-cancelable/tree/440e1c81332e5dbb59f55a7261fd2cb2cbc9f7e3)，MIT | 取消拒绝与清理handler显式关联；README建议Node16+优先AbortController | 借鉴明确清理责任，使用原生AbortSignal保留原reason；不引入CancelError包装或新依赖，不把Promise拒绝当作子进程已退出。 |

使用agent-reach GitHub/gh后端查询，6份源码/文档/许可原字节核对Git blob SHA1与SHA256，保存github-sources/fixed-source-index.json。Context7核对Node测试API；固定文档显示context.signal自16.17/18.7支持、context.after自18.13/19.3支持，覆盖现有^22.19/≥24范围。

## 实现与验证

fixture接受可选signal，命名step检查预取消、监听abort并移除listener；取消后继续消费原Promise的晚拒绝，但资源清理归close。close共享一个Promise，释放原测试gate并先stop manager，让它取消/等待原callbacks，再关闭client、context及原临时库。六个调用者注册t.after，保留原30秒限制和原业务断言。

有效初始6项5失败1健康控制通过，background夹具路由修正后的独立RED也保留；最终7项通过。真实node:test超时actor进入lease loss observation，退出1且自然结束；外层回归要求原nativeCalls1、目录清理、backgroundTasks0，无额外模型。原probe变为settledAfterCancellation true、原cause引用保持；11个相关文件38/38通过。

完整门禁及未复现自然通知时序的边界见[第73轮记录](../iterations/2026-10-09-seventythird-shared-reviewer-test-cancellation.md)。本轮只改测试生命周期，未改生产继续机制、provider/profile、Node版本或历史子会话。
