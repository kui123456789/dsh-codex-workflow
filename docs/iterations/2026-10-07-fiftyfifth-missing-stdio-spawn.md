# 第55轮：stdio缺失的spawn失败保存原receipt

状态：本轮生产修复、最终完整门禁及正式重载完成。DSH PID112348已加载第55轮，412sessions/111workflows与完整canonical保持。下文保留阶段性反馈，最终结果见末节。总体持续优化目标active，未commit/push/publish。

## 当前现场与RED

前一轮已实际落地，是已验证进展。再读第54轮PID106280/birth `2026-10-07T20:53:52.2110370+08:00`，412sessions/111workflows、available0/running0/waiting0、完整canonical/session hash及原parent/历史corrupt保持。HEAD仍abb6174，既有dirty工作保留。

隔离SDK worker用native spawn-adapter受控回放Node EMFILE形状：真实ChildProcess对象、无stdio/PID、next-tick原error后close，不发exit。旧SDK首先TypeError `input.on is not a function`遮盖原fault；原error监听数0，uncaught-monitor记录EMFILE，worker自然exit1。日志 `D:/工作文件/projict/dsh-cc/.codex-workflow-verification/fiftyfifth-20261007/missing-stdio-red.log`，现场 `%TEMP%/dsh-missing-stdio-spawn-YmROpx/states.jsonl`。没有耗尽系统句柄、没有全局异常workaround。

原因候选是假设stdout必存在、创建readline早于监听error、原child未同步纳入ownership。官方Node本机版本和回放支持这些条件。[固定研究](../research/github-missing-stdio-spawn-patterns-2026-10-07.md)核对Node/cross-spawn/MCP SDK的SHA、版本、许可与契约，不复制实现或增加依赖。

## 修复与控制

SpawnedProcessTransport的lines为optional，输出存在才创建Interface。SDK仍同步持有原child，先注册原process/可用stream监听，缺失必要stdio时等待原error/close或incomplete spawn receipt再拒绝，不先发送initialize。等待使用已有control-RPC预算及signal；成功或撤回均清理自己的等待监听和计时器，保留原child error消费。

NoPID失败不创建retirement/unknown tombstone；actual-pid case真实启动忽略stdio的keeper，既有捕获birth树清理后才返回。共享调用得到同一原error；单个caller取消只撤回自己的receipt；最后withdraw结束原flight，明确metadata后继仍不受旧late error影响。并发stop共享promise且保持永久latch。

10/10隔离case通过，9.80秒。测试受控重放native onexit的只读类型字段最初被typecheck指出，改用Reflect测试回放，生产代码不写exitCode，typecheck/diff通过。相关104/104、exit0，207.95秒，失败/取消/跳过0；stdio/原输出/stderr/共享初始化/回执/退休控制保持，原断言和场景期限不改。

385份baseline和所有固定源码、日志位于本轮持久目录，依赖目录0。认证state/formal stdout仅TEMP，不输出内容。完整verify、连续release两次、host、host-recovery及diff通过，源/build freeze一致且正式idle后才重载。profile/provider/凭据、canonical/历史corrupt保持，未commit/push/publish。

这是隔离native契约回放和两个实际OS child路径，不声称制造真实系统EMFILE/ENFILE、真实provider故障/Token费用/浏览器/Linux pidfd实机验收。

## 完整门禁进行中

目录 `final-gates-283a155b-abc8-4cae-8b75-b39326ba898c/`，原exec18068持续结算。263份源码/测试/脚本freeze，完整门禁每项前后校验，文件并发2，原场景期限及断言不变，预期完整1270项。SDK源码SHA256 `039E1DBEDB329A9C1E5FF8860FF944C2A8F8B3A0090B895E7AF30095A0234A2F`；process transport源码SHA256 `8507D1F9E86A5C14E164221B199799E0FE700F00A473CB685889A6E901719B7A`。受控reload准备核对原PID106280及birth、六项最终门禁、源/build freeze和正式idle；没有因观测超时重复运行或启动新实例。

verify1270/1270、exit0，1094.90秒，失败/取消/跳过/异步警告0；连续release及host继续原exec18068，尚未正式重载。

release第一次1270/1270、exit0，1164.93秒，失败/取消/跳过/异步警告0；offline doctor明确跳过5项真实连接检查，pack audit通过、临时tarball清理。第二次仍在原exec18068执行。

## 最终完整门禁及正式加载

| 检查 | 结果 | 用时 |
| --- | --- | --- |
| `pnpm verify` | 1270/1270，exit0 | 1094.90秒 |
| `pnpm release:check` 第一次 | 1270/1270，exit0 | 1164.93秒 |
| `pnpm release:check` 第二次 | 1270/1270，exit0 | 1076.84秒 |
| `pnpm host:check` | exit0 | 6.02秒 |
| `pnpm host:recovery:check` | exit0 | 10.31秒 |
| `git diff --check` | exit0 | 已记录 |

三个全量运行失败/取消/跳过/异步警告0；两次release离线doctor明确跳过5项真实连接检查，pack audit通过且临时tarball清理。原exec18068明确terminal exit0后才放行，没有因观测超时重复检查。263份源freeze前后保持，217份build冻结；原场景时限与业务断言未放宽。

受控reload核对原PID106280/birth、六项最终门禁、源/build freeze及正式idle。现场412sessions、available0/running0/waiting0、111workflows。已打开原handle/birth安全清理捕获树11实例，独立证明退出后只启动一次PID112348。启动等待原reload exec23264完成，未重复启动。

新birth `2026-10-07T22:22:59.1108720+08:00`，入口、工作目录和参数保持 `web --host 127.0.0.1 --port 3080 --no-open`；认证exchange303/authenticated=true、health200，唯一127.0.0.1:3080 listener匹配。217份build与receipt的27个关键模块hash0偏差，stderr fatal0。

412sessions排序身份hash `579e3efe69e5323d7b143b014f9995b87059d0cfc923474c8efdb8848d962145`保持；111workflow完整SQL配方 `SELECT id, revision, record_json, updated_at FROM workflows ORDER BY id; JSON.stringify(rows)` hash仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。原parent与历史corrupt child存在，running0/waiting0。

`lib/app-server.js` SHA256 `13271763701CDE845F8F271E11ACB56F56899A090315D6AED790E1DE95778196`；`lib/infrastructure/process-transport.js` SHA256 `068D0755114E9300E7807F793AD44C4A59ACE02F94C3728DBD2DD6502B0FFA85`。formal-before/after、原树证据、reload-receipt和formal-verification位于本轮持久目录，认证state/formal stdout仅TEMP，未输出内容。

profile/provider/凭据、canonical与历史corrupt保持；未复建丢失ephemeral，未commit/push/publish。host为已安装DSH服务、实际SDK/stdIO和本地合成上游；EMFILE/ENFILE是隔离native契约回放，actual-pid与metadata successor是真实OS child。没有声称耗尽系统句柄、真实provider故障、Token费用、浏览器或Linux pidfd实机验收。本轮落地，总体持续优化目标active。
