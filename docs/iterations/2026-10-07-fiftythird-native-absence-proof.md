# 第53轮：独立系统查询消解Windows未知进程状态

状态：本轮修复、最终完整门禁和正式重载完成。DSH PID112192已加载第53轮，412sessions/111workflows与完整canonical记录保持。下文保留真实反馈和阶段结果，最终见末节。总体持续优化目标active，未commit/push/publish。

## 现场与复现

前一轮是已修复、完整验收并正式加载的进展。当前再读第52轮PID110780，412sessions/111workflows、available0/running0/waiting0和完整canonical/session hash保持，原parent和历史corrupt child存在。HEAD仍abb6174，既有dirty工作保留。

保存的真实旧PID68600在CIM/.NET已不存在，Node signal-zero仍EPERM。旧proof不认缺席，保留未确认。新native回归启动并真实退休SDK，确认原捕获实例退出后，只对原PID的signal-zero观察注入EPERM；旧source首先RED `false !== true`，日志 `D:/工作文件/projict/dsh-cc/.codex-workflow-verification/fiftythird-20261007/process-absence-red.log`。没有伪造birth或发送信号。

候选为signal探针权限更强、遗漏身份结果保持未知、缺少独立存在性端口。libuv/psutil固定源码与本地原反馈支持这些条件。[固定研究](../research/github-windows-process-absence-patterns-2026-10-07.md)记录SHA/版本/许可与官方API边界，不增加依赖或复制实现。

## 修复与验证

完整原birth且身份查询成功后，遗漏PID可经独立.NET缺席查询确认；信号EPERM或查询漏项不能单独放行。native helper有4秒上限，严格要求每个请求PID恰好一条boolean结果；访问拒绝/失败/部分/陌生/重复结果保持未知。matching live birth和缺失原birth沿用原规则。refresh共享独立缺席证明，不借用复用PID后代，不制造线程或workflow。

首轮新12项通过，16.02秒；补充真实SQLite守卫后12项通过，20.13秒：live与denied保留原marker，独立确认retired后才标记原token/epoch成功。相关68/68通过，132.99秒，失败/取消/跳过0；旧树capture/refresh/cleanup、fork/initializer/idle/输出和generation控制保持。

真实历史query以原68600/104692保存证据再次读源码：signalProbe仍EPERM，whole-tree confirmed=true、refreshPreservedIdentity=true、captured2，记录 `historical-native-absence.json`。首次临时TS脚本因目录无module声明而top-level-await编译失败；保存为.mts后完成，未修改生产/依赖。验证只读，模型/新线程/终止信号0。

379份baseline及所有日志、固定源码位于本轮持久目录，依赖目录0；typecheck/diff通过。认证state/formal stdout仍仅TEMP，不输出内容。完整verify、连续release两次、host、host-recovery和diff通过、源/build freeze一致且正式idle后才重载。profile/provider/凭据和canonical/历史corrupt保持；未commit/push/publish。

## 完整门禁进行中

目录 `final-gates-7306ee7f-73aa-4e3c-8c6f-b30829c1a80c/`，原exec57268持续结算。260份源码/测试/脚本冻结，每项前后校验；文件并发2，原场景期限及断言保持。process transport源码SHA256 `B04C3519935603216FAE680EFEC596F1E4501425FD36A2592F0D6F90D5E47D9F`。已准备受控reload核对原PID110780/birth、六项完整门禁、源/build freeze及正式idle；当前尚未重载。

## 首轮完整反馈与收窄依赖

原exec57268明确terminal exit1：verify1252/1253，1失败，976.88秒，取消/跳过/异步警告0。原目录完整保留；release没有启动，正式未重载。失败为新native retired场景的refresh未取得确定结果，whole-tree确认已通过。增加只记录原PID对应查询的诊断后，单项一次及有界8次重复均通过，首次失败的具体查询原因未证实，不能把它冒称为已稳定复现的PID复用或权限故障。

代码检查确认refresh先采完整后代census，才使用缺席证明；已经可被独立证明不存在的原root仍依赖一次无必要的census。新增直接边界回归，完整独立absence receipt存在时census不可用，旧实现先调用census并RED，日志 `absence-before-census-red.log`。修复先批量独立确认缺席，仅采剩余原实例；某个root在随后采集中消失仍可再次独立确认。未知、拒绝或部分缺席结果不跳过原实例；完整原birth前置校验不变。

13项新native/SQLite/边界与7项refresh组合20/20通过，18.03秒，日志 `absence-before-census-green.log`。原实际68600仍EPERM，proof及refresh确定成功、身份保持。typecheck/diff通过；新process transport源码SHA256 `97D206830CC88D92FFAF055B53A724B04121163002942F6A0C932C7B7CEF6984`。最终关联控制重新执行，随后更新freeze和新完整链，原失败链绝不放行重载。

最终相关69/69、exit0，137.26秒，日志 `process-absence-final-controls.log`，失败/取消/跳过0。更新260份freeze后重跑verify/连续release/host链，最终预期1254项；重跑基于已确认失败及新的依赖边界修复，不是观测超时。

## 修复后完整门禁

目录 `final-gates-2eee7cc2-d561-4620-91c9-4279d3d294b5/`，原exec49001持续结算。verify1254/1254、exit0，1046.07秒，失败/取消/跳过/异步警告0，release及host尚在执行。新260份freeze一致，正式仍第52轮PID110780、412sessions/111workflows保持；reload只引用新完整链，不使用原失败结果。

release第一次1254/1254、exit0，1111.89秒，失败/取消/跳过/异步警告0；第二次仍在原exec49001运行。离线doctor/pack audit与临时包清理通过，正式尚未重载。

## 最终完整门禁及正式加载

| 检查 | 结果 | 用时 |
| --- | --- | --- |
| `pnpm verify` | 1254/1254，exit0 | 1046.07秒 |
| `pnpm release:check` 第一次 | 1254/1254，exit0 | 1111.89秒 |
| `pnpm release:check` 第二次 | 1254/1254，exit0 | 1071.88秒 |
| `pnpm host:check` | exit0 | 5.52秒 |
| `pnpm host:recovery:check` | exit0 | 12.07秒 |
| `git diff --check` | exit0 | 已记录 |

三个最终全量运行失败/取消/跳过/异步警告0；连续release offline doctor明确跳过5项真实连接检查，pack audit通过且临时tarball清理。首轮失败目录完整保留，最后exec49001确认terminal exit0后才放行。260份source freeze前后匹配、217份最终build冻结；已有场景期限及业务断言未放宽。

受控reload重新核对原PID110780/birth `2026-10-07T17:47:49.5038630+08:00`、六项完整门禁、源/build freeze、唯一listener及正式idle。现场412sessions、available0/running0/waiting0、111workflows；用已打开原handle/birth安全清理捕获树11实例并独立证明退出后，只启动一次PID112192。

新birth `2026-10-07T19:27:33.2946030+08:00`；入口、工作目录与参数保持 `web --host 127.0.0.1 --port 3080 --no-open`，认证exchange303/authenticated=true、health200，唯一127.0.0.1:3080 listener匹配。首次formal-verify早于auth state生成而ENOENT；等待原reload exec71068完成exit0后复查成功，没有重新启动或重复认证流程。

正式217份build和receipt中27个关键模块hash0偏差，stderr fatal0；412sessions排序身份hash `579e3efe69e5323d7b143b014f9995b87059d0cfc923474c8efdb8848d962145`保持。111workflows完整SQL配方 `SELECT id, revision, record_json, updated_at FROM workflows ORDER BY id; JSON.stringify(rows)` hash仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。原parent与历史corrupt child存在，running0/waiting0。

`lib/infrastructure/process-transport.js` SHA256 `A0AAC024B675AFE7651A786DC23D14C10782C7FE33AD31DF8B1EE163FA33E246`。formal-before/after、原树证据、reload-receipt和formal-verification在本轮持久目录；认证state/formal stdout仅TEMP，未输出内容。profile/provider/凭据保持，未复建丢失ephemeral或替换历史corrupt。

host采用已安装DSH服务、实际SDK/stdIO与本地合成上游；Windows独立.NET缺席查询和SQLite守卫真实执行，真实历史EPERM PID只读证明恢复。首轮一次native refresh未知的具体原因仍未证实，不把后续通过写成原因已复现。没有声称真实OS PID复用、provider故障、Token费用、浏览器或Linux pidfd实机验收；没有commit/push/publish。本轮落地，总体持续优化目标保持active。
