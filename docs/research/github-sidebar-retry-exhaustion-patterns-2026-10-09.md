# 侧栏开栏重试的耗尽状态

状态：第89轮完整交付后，第90轮已按base hash合入主源码；相关66/66及typecheck通过，新1557预期完整门禁运行中。正式DSH暂未加载本轮修正。

## 本地失败与采用机制

`src/client.js`声明最多8次自动重试及15秒窗口，但耗尽分支删除原重试记录。后续同一投影通知再次开栏失败时，重新生成次数0/新窗口；同一child或summary目标可不断尝试。另外，迟到回调先调用openResource/openTab，失败后才检查窗口，造成deadline之后的额外资源接纳。

候选为同一目标保留耗尽集合，在实际open之前检查原窗口。一个初始调用和最多8次重试之后，普通模型进度通知不能重新授予额度；新的child或workflow目标拥有自己的key和额度。普通成功重试及插件卸载清理继续使用原路径。修改仅在浏览器扫描，不发模型继续、不创建Planner/Reviewer，也不改变宿主手动开栏API。

## GitHub 依据

通过agent-reach的GitHub CLI实际读取固定[p-retry实现](https://github.com/sindresorhus/p-retry/blob/1472907affe8d6107aba5884abc36d6361b3042e/index.js#L166)、同提交测试及MIT许可。实现对`remainingTime <= 0 || retriesLeft <= 0`抛原错误，原操作的终态不因新一次内部通知重置。这里仅采用“耗尽属于原操作”的原则，不引入p-retry调度器或依赖。

三份实际源码/测试/许可保存到仓库外`.codex-workflow-verification/ninetieth-20261009/source-evidence`，固定提交`1472907affe8d6107aba5884abc36d6361b3042e`；manifest含Git blob及SHA256，全部字节匹配。公开GitHub读取仅在子进程环境绕过不可用代理，用户/provider/profile配置保持。

## 回归与范围

原8项回归4通过/4失败；补充卸载和中途通知后，原12项6通过/6失败，候选12/12。相关展示套件62/62及typecheck通过，失败/取消/跳过/TODO0。首次候选生成因CRLF匹配失败，没有生成有效候选；归一候选文本后成功。首次相关套件副本缺少backend展示模块，补齐原字节依赖后得到有效62项结果；前两份失败日志保留。

测试使用实际插件源码、独立VM及受控通知/定时器，明确记录次数、目标与耗尽警告，分别覆盖原生child和summary fallback。15秒迟到为可控时钟边界，没有改变真实系统时间，不能当作真实浏览器定时器负载验收。当前browser窗口仍用Date.now，不把本候选扩大为单调浏览器时钟或所有 UI 内存策略。

候选为1源码/1测试，12项新增，未来完整计数1553仅为预期（第89轮1541+12）。须等第89轮真实完整门禁/正式交付后，核对base hash再合入；具体状态见[第90轮记录](../iterations/2026-10-09-ninetieth-sidebar-retry-budget.md)。

补充目标与父会话切换后的耗尽保留控制后，最终16项原6通过/10失败，候选相关66/66与typecheck通过。新的target和不同parent有各自key；返回已耗尽原key仍拒绝自动开栏。最终manifest更新为16项新增、未来1557预期，主源码保持冻结；早期12/62结果不改写。

第89轮gate/delivery与正式PID25056核对通过后，本轮1源码/1测试/3文档已逐项hash检查、备份并合入主源码，主相关66/66及typecheck通过。真实1557预期完整门禁和正式重载仍需新的结果；实施状态见迭代记录，不将早期候选表述当作当前交付状态。
