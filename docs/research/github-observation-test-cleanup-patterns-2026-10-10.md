# 共享 Reviewer 观察测试的取消清理

状态：第96轮完整验收/正式65896加载完成。原21308真实exit1（1644通过/1取消）及清理证据保留；补齐调用方signal/step/after后，新62488真实exit0，verify/release各1645/1645，原观察文件在两个gate均4/4、host加载/11恢复/diff通过。原自然等待原因仍未确认，不能用受控验证覆盖原失败。

## 固定来源与适用机制

通过 agent-reach GitHub/gh 后端重新读取 [Node v24.14.0 的测试运行器](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/lib/internal/test_runner/test.js)、同提交的 `doc/api/test.md` 和 `LICENSE`。安装中的 Node 确为 v24.14.0；三份文件均校验 Git blob SHA1、SHA256 和原字节长度，未执行下载的代码。清单保存在仓库外第96轮 `observation-source-evidence/source-manifest.json`。

固定 `test.js` 的1055–1165行显示：测试函数与停止Promise竞争；超时进入取消路径，但不会替任意用户Promise解除等待。运行器在成功及失败路径都调用原after钩子。固定文档明确 `context.signal` 可用于中止测试子任务，`context.after` 在当前测试结束后执行。Context7先解析Node.js，再分别查询取消信号及after生命周期；检索片段对after主要返回suite文档，因此具体TestContext结论以固定文档和原生执行证据为准。

只采用信号传播和明确清理责任，使用本项目已有 `fixture.step` 与幂等 `close`，无需新增依赖、重写生产调度器或改变Node版本范围。原30/90秒场景时限与业务断言保持；after与finally加入同一清理Promise。

## 正确反馈环与边界

仓库外复制实际 `bridge-shared-reviewer-observation.test.ts`，只在探针把停止用例时限设为4秒、阻挡takeover的lease通知；实际回归主体、真实App Server协议client、dispatcher和DSH原生子会话保持。旧调用方在Node已报告超时后仍存活，按完整PID/birth/tree证据清理该探针自己的进程。接入signal、命名step和after后，同一用例仍报告取消、自然exit1，并显示 `takeover lease loss observation`；不把清理成功变成测试通过。

原停止用例的普通单次重放和连续20次重放均成功。候选20项相关控制覆盖原生显示、接管、停止、取消、不可用原Reviewer及已有取消actor；类型检查通过。它们证明取消清理缺口和原身份断言保持，没有复现或解释原自然90秒超时的原因。

原失败门禁必须自然结算后再合入三份候选（一个测试文件、README、CHANGELOG），然后获取新的完整1645测试/172文件门禁、宿主加载与11恢复场景。源码、输入清单和正式217产物在原门禁运行时保持冻结。生产恢复边界、provider/profile及历史corrupt子会话保持；不使用测试清理证据宣称真实模型故障或Token账单已验收。

上述采用条件已满足，原失败完整native收据与输入保护审计保留；新gate只启动一次，日志共享冲突通过读取同一进程的原输出恢复绑定，没有因观察异常重开。五份唯一候选变更及新328输入、正式217产物核对通过。完整结果和正式加载状态见[第96轮记录](../iterations/2026-10-10-ninetysixth-callback-terminal-precedence.md)。
