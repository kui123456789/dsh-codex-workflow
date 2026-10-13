# 完整验证构建与正式客户端隔离

状态：可复用隔离命令已完整验收。原CLI60196实际exit0，verify/release各1574/1574、host/11恢复/diff通过；321输入及217正式文件内容/HMR metadata保护通过。命令不部署，正式56144保持，未交付相同运行时产物。

## 现场与版本表述纠正

第90轮release运行时，正式PID25056仍由第89轮启动，但认证boot/resource读取已返回第90轮client：包含耗尽guard，SHA256 `b9680f6a9763caef345deecbb4f60928e7474437092fddb255911e8d04d4b403`；旧client不在响应里。读取没有执行浏览器或模型。此前“正式仍第89轮”的说法只准确描述后台进程，不足以描述全部前端资源。

主profile的Junction指向开发checkout，常规pnpm build覆盖该checkout的lib。DSH模块服务监听构建变更，因此verify/release的pretest构建也可能使未完成门禁的client可被读取。是否已在某个浏览器materialize未观察，不能由HTTP字节推定。

## 固定依据与机制

Context7先resolve DeepSeek Harness，再查询`/deepseek-ai/deepseek-harness`：rebuilt是HMR进入图的入口，依赖mtime/ctime/size，artifactBaseline保护启动与watch安装间的变更；browser factory延迟materialize。

agent-reach GitHub CLI实际读取固定提交`d743267388641bc76f17c45ce8b4c231aed1d32c`的[模块服务源码](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/modules/src/index.ts)、README、subsystem文档及MIT LICENSE，4份Git blob和SHA256核对。安装的`@deepseek-ai/dsh-client-modules`0.1.7-rc.2实际JS亦保存并hash；其rebuilt在metadata revision变化后readFileSync并更新bundle/graph，不把上游commit冒称安装bundle的提交。

采用方向是把门禁运行在冻结代码副本，产生独立lib，再于完整结果/原数据/空闲守卫通过后交付其精确产物。开发命令的HMR用途与正式验证产物分别记录，暂不改用户profile、provider或Junction。

## 独立副本的实际结果

315份当前输入按原manifest逐字节复制到仓库外`.codex-workflow-verification/build-isolation-20261010/stage`，仅node_modules Junction复用开发依赖。独立pnpm build产生217份产物，逐项SHA256与当前canonical lib一致；原315代码输入保持。66项UI控制、host加载及11场景持久冷回放通过，没有真实浏览器/模型动作。

内容一致本身不证明没有重写同字节文件。按照实际HMR契约，重新捕获canonical217文件的SHA256/size/mtimeNs/ctimeNs，再运行副本host与host-recovery的两个构建，最终内容变化0、metadata变化0。隔离命令没有触碰正式lib，因此没有该路径上的重建通知触发。

## 尚待证明的范围

副本完整pnpm verify的唯一runner47688/birthKey `win32:134360365218610540`于00:22启动，独立文件并发1，原1557项预期及所有场景断言/时限保持。真正全量结果、源输入/产物比对及Git相关测试是否依赖canonical checkout仍待实际结果，不把66/host结果当1557放行。

副本没有复制.git，后续原仓库diff检查仍需在canonical执行；包审计/正式交付的取件路径与原工作区source drift守卫也尚未接入。测试产物归属和运行中DSH身份必须分别证明。当前只写仓库外prototype与本研究，没有更改主build/test脚本或提前交付新后端。

## 后续取得的结果与实现

原副本47688于00:52:08真实exit0，独立1557/1557，fail/cancelled/skipped/TODO0。进一步实现`verification-stage.mjs`及`verify-isolated.mjs`，新增`pnpm verify:isolated`，在副本跑完整verify/release/host/恢复，原工作区跑git diff，并验证原/副本源码、正式产物内容和HMR metadata。

17项候选与主回归、typecheck通过，覆盖来源/产物漂移及伪绿色计数拒绝；非空证据目录和旧stage拒绝，artifacts manifest仅在全部成功后保存。命令返回已测试build路径，交付仍需原独立守卫。证据默认存repo父目录以避免只依赖Temp；node_modules共享，不将其说成全依赖/OS隔离。

新CLI完整链PID60196/birthKey `win32:134360397939034660`实际运行，输入321、预期1574，当前结果尚未取得。实施与真实状态见[第91轮](../iterations/2026-10-10-ninetyfirst-isolated-verification-command.md)，早期prototype/未合入描述保留为当时证据，最新状态以此节为准。

最终该原链于2026-10-10 02:16:26完成并确认真实exit0；verify/release各1574/1574、失败/取消/跳过/TODO及异步警告0，host/11持久冷回放/diff通过。独立审计原/副本321输入、8份采用文件与217产物，原lib内容/metadata变化0、最终stage与canonical逐项hash偏差0。414会话身份、429文件及111workflow/119queue保持；本轮没有重载DSH。最终状态以[第91轮最终节](../iterations/2026-10-10-ninetyfirst-isolated-verification-command.md)为准，先前待完成段为时间顺序证据。
