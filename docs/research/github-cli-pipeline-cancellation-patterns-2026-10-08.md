# CLI公开调用与异步回调的取消范围

研究日期：2026-10-08，最终验收2026-10-09。第70轮verify/release各1415/1415、host加载/恢复及diff通过，已受控加载到正式DSH，PID148600。未增加依赖或修改外部Gateway接口。后续“caller取消后再stop的原因覆盖”另有独立RED，见迭代记录。

## 本地RED与真实调用入口

第69轮覆盖单次retry及其backoff；公开reconcile在retry结束后仍会等待captureVisibleText，然后调用normalize。workflow.ts的CLI协调分支确实传入异步capture回调，review的最终onThread回调也会跨越子进程之外的等待。

真实Node子进程探针连续两次证明：第一次审查成功，保存回调被受控门阻挡；按workflow取消后释放该回调，仍会启动第二个转换进程，且调用成功返回。16项初始回归12失败、4控制通过；caller信号、错误目标及原capture错误原来已有正确行为。原源码、RED日志与12份失败actor目录已保留。

## 固定源码与采用决定

| 来源及固定提交 | 源码机制 | 本项目采用 |
| --- | --- | --- |
| [p-queue](https://github.com/sindresorhus/p-queue/tree/180ab9e25cd10b6f548767d7176076b50d25e188)，MIT | source/index.ts:479–519将signal传给整个async task，取消竞争返回Promise并清listener；readme说明运行中的任务须自己处理signal | 采用整个公开调用的责任范围与信号传播。本项目仍等待已接纳的capture/onThread回调结算；Promise竞争拒绝本身不能证明保存已结束。 |
| [p-retry](https://github.com/sindresorhus/p-retry/tree/1472907affe8d6107aba5884abc36d6361b3042e)，MIT | index.js:233–249在调用前及其异步结果返回后检查同一signal | 采用公开调用返回前的取消检查，避免回调结束后交付已取消的成功结果；保留原退避分类、预算及原错误。 |

使用agent-reach的GitHub/gh后端搜索、固定提交读取。8份源码/测试/README/许可原字节均核对Git blob SHA1与SHA256，收据位于本轮github-sources/fixed-source-index.json。Context7的/sindresorhus/p-queue确认运行任务需自行处理signal，细节以固定源码为准；只采用机制，自行实现代码。

## 实现与验证

统一withCancellation供review/createReview/reconcile/normalize/align及retry复用：登记workflow/submission、独立Controller和done，caller信号合并传入各阶段，finally撤销责任并结算done。stop等待原公开调用和已接纳回调。缓存路径先接受取消检查；callback失败仍保留原cause，捕获不重放，取消不是永久identity封禁。

16项新增及147项相关测试通过；真实probe变为captureCalls1、childStarts1并拒绝原取消原因。scope覆盖保存、最终回调、缓存、预中止、stop、caller/API首因、peer和显式复用。自定义回调需要实际结束才能完成清理；没有新增回调硬超时。完整门禁及加载结果见[第70轮记录](../iterations/2026-10-08-seventieth-cli-pipeline-cancellation.md)。受控fixture不代表正式provider故障、Token计费或浏览器交互验收。
