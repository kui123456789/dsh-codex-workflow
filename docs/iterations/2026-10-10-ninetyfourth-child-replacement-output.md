# 第94轮：原子会话的replacement正文

状态：第94轮完整验收与正式加载完成。verify/release各1632/1632、171文件/native回执及host/11恢复/diff通过，原24404实际exit0；独立真实浏览器六阶段验收通过。退役原12176树11实例后精确交付已测JS/map，formal59112认证HTTP200，全部历史保持。总体优化目标active。

## 缺陷与来源

[原生显示流研究](../research/github-native-child-replacement-patterns-2026-10-10.md)从实际App Server事件到child公开factory复现replace被追加。原7控制6失败1通过；初始RED日志及原native exit独立保留。固定DSH4份source/test/license Git blob/SHA256核对，安装client/llm字节另存；Context7核对native frame说明，具体abandoned语义仍以固定及安装源码为准。

## 模块实现

`src/codex-child-session.ts`内部维护当前文字段及工具buffer的kind/full item片段，不引入新runtime module或依赖。replacement只替换其原片段，普通delta仍按流顺序追加；已提交工具前内容不被回写。修正live文字先用abandoned end退役未提交attempt，再在同一turn/step发新snapshot，避免原生append-only chunk把旧内容留在画面。相同快照不新增frame，继续回合清空原片段身份。

display attempt变化不调用模型，也不改thread、child、审核次数、一次自动continuation、workflow或清理资格。第93轮partial保留及成功权威正文保持；历史failed/aborted状态不被快照更新当作完成。

## 真实控制与合入

新增12回归，使用原安装ClientAssistantStream读取所有start/chunk/end和durable事件，不允许rebaseline。控制覆盖同kind/item、peer、长ID、工具buffer、empty snapshot、重复snapshot、跨tool/turn边界、交错delta及成功结果。实际none/zstd冷文件回放读到修正快照且不含旧draft；原8partial控制仍通过。

首次候选相关43/43；追加native帧/边界后48/48；加入上一轮partial测试后的真实五文件56/56、fail/cancelled/skipped/TODO与异步诊断0，typecheck通过。5份base/candidate哈希固定、原字节备份后合入。本轮新增12测试，完整计数预期1632（上轮1620+12）仍须实际取得。

## 原完整链与受控加载准备

05:09启动原CLI24404，observer48036保留真实原OS句柄，birth键匹配。327份输入快照和原源码、5采用文件与217正式内容/HMR metadata核对偏差0。原生回执已收到文件摘要但无累计/complete；全量未完成，不提前放行。

首次观察时summary处于snapshot准备且checks为空，只读观察脚本因不存在logPath报错；修正处理准备态后继续查同一实例，原测试没重启。两次尝试直接读取SDK未打包到根lib的文件路径失败，随后rg --files定位实际types路径，再读取实际Host fold；不把路径猜测当API证据。

交付helper从第93轮准备改为本轮真实gate/root及原formal12176/birthKey `win32:134360530770948370`。只有完整原回执与全部文件摘要确认后才准备已测JS/map和原217rollback；完整数量按冻结inventory实际读取，不凭旧数量放行。重载前重复Agent/任务/恢复/guard/queue资格与全量hash核对，保留cancelled历史标记及定向休眠inbox；原树退出后才写stage产物并只启动一个后继。当前helper仅准备，没有运行reload。

正式12176认证/元数据仍为414身份、111workflow、119queue原hash，原parent/corrupt child保留。真实provider、Token费用和完整AgentLoop组合仍需独立证据；下述隔离浏览器验收不冒称正式环境或完整模型组合验证。

## 隔离宿主和真实浏览器全过程

使用已安装Playwright CLI的命名浏览器dsh-replacement94；独立DSH_HOME与3110端口，从当前验证stage读取后端，复制真实client仅改变注册ID。实际宿主ToolRuntime/SessionStore/SubagentRuntime/JSONL和browser模块，轻量Agent factory及scripted-local网关，无真实provider请求、无预置侧栏layout。

原空fixture父Agent没有原生turn，被宿主blank规则隐藏；原UI52608/tree在child0/model0时安全退役，补原生父提示seed后启动一次UI58776/birthKey `win32:134360549628581000`。第一次修订marker因持久化拼接空白不一致被拒绝，原tree已退出且备份保留；随后独立确认原退出和未改插件字节，再完成seed。没有把夹具缺口当产品RED，正式12176与原门禁都未停。

CLI原默认.playwright-cli Junction指向失效Temp，首次浏览器写入失败；指定snapshot路径可读，但自动输出仍受旧启动配置影响。关闭原named browser，在尚未模型start时用显式outputDir配置重新打开同名浏览器、加载仅隔离认证状态。初始设置modal被正常关闭，不写provider配置；点击曾因modal挡住而超时，重新snapshot后处理，不能把这些准备错误当插件失败。

真正的场景从唯一父会话`ui-recovery-parent-3c62dbce-4d39-4209-a07c-d71bb786c31f`开始：真实原child `c1a015f7-cbb4-4628-b361-e01bf745fe55`、thread `planning-f52a6715-abec-404a-b602-187edcbc8d68`、workflow `a67df0db-022a-42d8-b33a-15f12e83338f`及tab2全程保持。

1. 原生侧栏自动打开，provisional标记实际可见。
2. 释放replacement后旧标记消失、corrected标记可见；tab及resource不变。
3. 两次受控失败进入waiting，corrected历史与原错误都保持，threadCreates/childCreates各1、原turns2。
4. 刷新同一页面，真实JSONL读回原corrected历史，无subagent/not-found。
5. 原workflow省略id调用resume成功，短continuation及最终plan可见；同thread/child/tab、原turns3、child释放一次。
6. 释放后的再次cold reload仍读到正确历史和最终plan，不追加旧draft。

六份独立DOM/localStorage/身份回执与native场景结果已封存`ui-acceptance-completion.json`；安全截图和snapshot位于output/playwright/replacement94，completed.png及corrected-history.png已有hash。浏览器正常关闭，原UI58776的2捕获实例tree退出确认。该结果证明本轮真实browser/安装宿主和受控网关组合，不等于正式provider、费用或完整AgentLoop验证。

05:38原完整verify已到1475、失败0，327原/副本输入、5合入文件与217正式content/HMR metadata仍一致；UI独立证据不能替代剩余release/host/恢复/diff或原exit0。期间观察到Planner/Reviewer提示词仍含Desktop位置措辞，记录为后续一致性核查方向；不在本轮冻结输入中追加改动，也不把措辞冲突直接归因为用户原模型失败。

## 原完整verify语义回执已取得

05:39:51.357原verify实际exit0、1632/1632、失败/取消/跳过/TODO及异步诊断0，check1841.077秒。独立读取原TAP和JSONL，171文件与327输入的实际测试inventory一致，一个累计摘要及stream完成、原run/root正确；未把56项控制与旧1620相加当作真实完整结果。

同一原24404进入release，独立run id及回执文件已出现。原5采用文件、327source/stage以及217正式hash/size/mtimeNs/ctimeNs继续一致；没有artifacts成功manifest、delivery准备或reload回执。后续发布/宿主/11恢复/diff及原OS句柄exit仍须实际取得。独立UI清理已完成，不把它当正式重载或原模型进程恢复。

## 最终完整门禁与正式精确交付

06:10:06.952原整链完成，observer48036保留真实原OS句柄并于06:10:06.971确认原24404/birthKey退出码0。verify/release各1632/1632，失败/取消/跳过/TODO及异步诊断0；check1841.077/1800.856秒，host4.041秒、host恢复6.689秒及11场景全部persistedColdReplay/pendingTools0、diff通过。doctor5项offline skipped及包审计/临时tarball清理分别保留，不与测试跳过混淆。

独立final audit确认两份原171文件/native累计/stream及run/root、327原/副本输入、5份合入hash、217产物和正式content/size/mtimeNs/ctimeNs保护。唯一产物差异是child模块JS及source map，与原stage manifest一致，未再次构建。备份原217字节后，重载双查Agent/workflow/恢复/清理/queue资格与429文件稳定baseline；历史cancelled标记和定向休眠inbox原样保留。

原12176树11捕获实例全部确认退出，才复制stage精确JS/map，217canonical hash全部匹配。一次启动formal59112/birth `2026-10-10T06:11:33.7099440+08:00`/birthKey `win32:134360574937099440`；认证HTTP200、入口/监听/出生通过。414会话身份、429文件及111workflow/119queue全量hash保持，文件变化/缺失/新增0，原parent/corrupt child保持，running/waiting/pending/active lease/fatal0。

实际served client字节与原client相同，新child模块replacement/abandoned/buffer代码和hash核对成功。真实浏览器验收来自前述独立宿主和scripted-local网关，host-recovery自身browserUIVerified false；两类证据分别保存，不泛化成真实provider、Token费用或完整AgentLoop验收。源码与Git diff复查通过，原rollback保留，未commit/push/publish。提示词Desktop措辞仍为下一轮独立核查方向，本轮未修改冻结提示词。总体目标继续active。
