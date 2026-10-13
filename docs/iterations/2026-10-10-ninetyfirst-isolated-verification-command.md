# 第91轮：完整验证命令的独立构建副本

状态：第91轮完整验收通过。`pnpm verify:isolated`的原PID60196实际exit0，verify/release各1574/1574，host/11恢复/diff通过；321输入及217正式产物内容/metadata保护通过。DSH保持第90轮PID56144，本轮无需重新交付相同运行时产物。总体优化目标active。

## 实际问题与模块设计

[DSH模块服务研究](../research/github-verification-build-isolation-patterns-2026-10-10.md)确认canonical lib是HMR输入，验证构建可在完整门禁前发布client。原“后台PID没有重启所以前端版本没变”的说法已纠正，HTTP读取并不证明浏览器已materialize。

按codebase-design的小Interface原则，`scripts/verification-stage.mjs`集中收集输入、准备独立stage、记录日志、核对源/产物漂移与交付路径；CLI只调用该Interface。真实命令执行和测试execute适配器共用检查流程。`verify:isolated`新增到package.json；开发build命令保持原用途。

## Prototype与合入证据

原315输入的独立副本完整verify于00:52:08真实exit0、1557/1557，fail/cancelled/skipped/TODO0；66 UI控制、host加载、11恢复冷回放亦通过。217产物与canonical逐字节一致，进一步按HMR的metadata契约观察正式217文件内容/size/mtimeNs/ctimeNs变化0，原输入保持。

新工具17项实际文件系统测试覆盖：独立产物/元数据保护、错误与首因传播、原/副本源码及inventory漂移、canonical产物内容/mtime/inventory漂移、内部stage拒绝、旧stage/摘要保留、symlink输入拒绝、缺失产物拒绝，以及缺少最终计数、取消或异步警告的绿色命令拒绝。主和候选均17/17及typecheck通过。

初次TS动态import后跨行类型断言不被esbuild解析，未执行有效测试；修正声明后通过。检查依赖时误重建已存在Junction被PowerShell拒绝，随后实际确认链接目标正确，未移除依赖。日志保持；不将这些准备错误当作产品RED或根因修复。

`prepared-change-manifest`固定8份base/candidate字节；旧90完整交付和prototype全量结果核对后，先保存原字节再合入2脚本/1测试、package.json和4份文档。adoption receipt完整保存，没有重置用户未提交工作，也没有向canonical lib写文件。

## 公开命令与全量门禁

命令依次在stage运行verify、release:check、host:check、host:recovery:check，原repo执行git diff --check。src/test/scripts及声明配置/README/CHANGELOG/LICENSE、可选AGENTS/.gitignore/.github以实际hash复制；.git不复制。仅node_modules通过Junction复用。每步检查原/副本输入与正式lib完整内容及HMR metadata；verify/release还需唯一完整最终计数、0失败/取消/跳过/TODO/异步警告。

证据放在repo父目录`.codex-workflow-verification/isolated-*`，旧目录非空即拒绝，不删除或覆盖；summary、inputs、protected-build、逐步logs及成功后的artifacts.json分别保存。结果返回stage/lib路径，不包含部署操作。依赖目录共享，命令是输出隔离而非依赖/OS sandbox承诺。

01:16唯一Node CLI PID60196/birth `2026-10-10T01:16:33.9034664+08:00`/birthKey `win32:134360397939034660`启动，原代码等同`pnpm verify:isolated`入口；证据`isolated-VDo0DQ`，实际输入321，预期1574（1557+17）。文件并发1、原内部场景/时限保持。已实际核对原PID并进入verify，尚无complete回执；当前不声称新工具完整验收。

正式56144仍运行第90轮已验收版本，414身份和111workflow/119queue完整hash保持。新的后台CLI不启动Planner/Reviewer、不重启服务；最终任何新产物交付仍需独立源码hash/空闲/进程实例/历史数据守卫。

## 原完整verify已完成，后续门禁待取得

2026-10-10 01:46:32原check实际exit0；完整1574/1574、fail/cancelled/skipped/TODO0，测试1788.02秒、check1796.93秒。原summary保存真实最终计数，不将17项控制与上一轮1557拼作结果；同一PID60196/birthKey仍匹配，已进入stage的release:check，没有重开完整链。

仓库外独立审计再次逐项读取原/副本321份输入与inventory，包含AGENTS及.github/workflows/ci.yml；所有hash偏差0。正式217文件的内容/size/mtimeNs/ctimeNs亦偏差0，当前未产生成功artifacts回执，不提前部署。正式只读metadata仍确认414身份、111完整workflow/119queue原hash及原parent/corrupt child保持，running/waiting/pending/lease0。

恢复验收文档纠正第89轮未完成的旧状态。下一机制仅做[Node语义摘要研究](../research/github-node-test-summary-receipt-patterns-2026-10-10.md)，未改冻结脚本或测试。release、host、11恢复场景与diff必须继续读取原链实际结果后才能宣告本轮整体完成。

进一步只读核对历史验收父会话，实际匹配两条终态记录：failed/operation aborted与cancelled，Planner/Reviewer thread字段均缺失。因此旧“no active意味着数据库根本没有记录”的推断不成立；缺失原线程身份仍不能恢复，不能用corrupt child构造替代句柄。脱敏元数据回执保存在本轮仓库外证据；没有修改原workflow或会话。

## 最终完整门禁与保留结果

2026-10-10 02:16:26.279完成同一链，原60196的真实OS句柄由只读observer30348保留，02:16:26.296确认退出码0、出生键`win32:134360397939034660`。observer不启动测试或部署；binding/completion回执以及CLI原stdout保存在本轮证据目录，未以PID消失代替退出码。

verify/release各实际1574/1574，fail/cancelled/skipped/TODO及异步警告0；步骤1796.93/1779.06秒。host加载3.96秒、host-recovery6.78秒、11场景全部persistedColdReplay且pendingTools0，diff通过。离线doctor5项预期skipped、pack审计和临时tarball清理分别核对；这些doctor跳过不等于测试跳过。

仓库外`independent-final-audit.json`独立重读原始计数/host JSON、321份原与副本输入及inventory、8份采用文件、217最终artifact manifest。正式文件hash/size/mtimeNs/ctimeNs变化0，stage产物与canonical逐项hash偏差0，实际AGENTS及.github CI副本存在。`artifacts.json`仅在完整链成功后创建。命令返回stage/lib，不自动部署；依赖Junction仍为共享，不能泛化为OS sandbox。

最终正式metadata仍为414身份、111workflow、119queue原完整哈希；429文件两次连续读取与第90轮不可变baseline完全一致，变化/新增/缺失0。原parent与历史corrupt child均在，running/waiting/durable pending/active lease0。正式56144身份/监听/Junction及认证HTTP200核对通过，本轮没有重载、provider调用或提交发布。

宿主恢复使用scripted-local网关，browserUIVerified false；不是实际provider断流或费用验收，也不恢复历史丢失的ephemeral线程。Node语义摘要仍为后续研究，Windows路径及文件/累计计数的探针修正日志保留，不当作产品缺陷修复。总体目标保持active。
