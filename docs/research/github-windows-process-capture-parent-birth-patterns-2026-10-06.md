# Windows 进程树采集：父子出生关系与 Node mock 恢复

日期：2026-10-06。范围：第 42 轮门禁发现的独立 Windows census 归属问题及受控 metadata 测试方法。第 42 轮 pending-receipt 研究保持冻结；本研究只写文档，不改 source/tests/lib、provider 或正式 DSH，不终止无关进程。

## 现场事实与失败边界

根执行方提供的失败证据是 TEMP `dsh-fortysecond-tree-capture-failure.json`，研究员已只读核对：2954 bytes，SHA-256 `F78696F408AE3B12F90C01D96C1B7E72E34D2972C90CA4288AD42EDDF69BAD7F`，观察时间 `2026-10-06T15:19:25.2502075Z`。对应 SDK 源 SHA-256 为 `95844BBC0F723D02E1CC44252F920872E46D2C834AC65D63595BD8571EE44D97`。

| 采集记录中的实例 | 记录的 win32 birth | 关系与限制 |
| --- | --- | --- |
| 原 backend PID 88788 | `134357732495098540` | 采集根；复查时 ESRCH |
| 候选父节点 PID 25332 | `134357732495653800` | 归入该 backend 的树；exe 未确认，不称 conhost；复查时 ESRCH |
| Sogou `biz_helper.exe` PID 84272 | `134357729781063110` | PPID=25332；复查仍活，且 birth 与原采集相同 |

84272 比采集记录中的父实例 25332 早出生 `271.459069` 秒，父节点比 backend 晚 `0.055526` 秒。旧数字 PPID 将早已存在的无关进程接到了新 SDK 树；这不是采集之后 PID 84272 换成了新实例。出生身份比较本身正确，错误在采集集合的成员归属。

证据来自保留的 `dsh-app-server-protocol-failure-5320WP` 测试目录。原 backend、25332 与 SDK actor PID 3788 已 ESRCH，84272 仍存活。actor 的全树退出检查因此误拒并超时退出 1；parent finally close 又掩盖较早失败。已记录的 Planner cleaned 状态为 failed，active/recoverable/childHandles/pin 均空或 0；不能把这个证据写成原 backend/writer 持续残留、JSON dispatch 再次崩溃或无关进程应被终止。

## 两组固定一手来源

| 来源 | 固定提交 | 实际许可证 |
| --- | --- | --- |
| [MicrosoftDocs/win32](https://github.com/MicrosoftDocs/win32/tree/e103fa4e8810bd8d42c4777e17081e24dbe62dbd) | `e103fa4e8810bd8d42c4777e17081e24dbe62dbd`；2026-09-15T15:43:29Z；`Fix typo in ETW event tracing documentation (#2221)` | [LICENSE](https://github.com/MicrosoftDocs/win32/blob/e103fa4e8810bd8d42c4777e17081e24dbe62dbd/LICENSE)：CC-BY-4.0 文档；不是 MIT |
| [nodejs/node，v24.14.0](https://github.com/nodejs/node/tree/f657bb8ed86365ff3fdbe32e27563e778b41486a) | `f657bb8ed86365ff3fdbe32e27563e778b41486a`；2026-02-23T23:51:55Z；24.14.0 LTS | [LICENSE](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/LICENSE)：所读 Node 自身代码/文档为 MIT；发行包另列 bundled 第三方许可 |

本轮只研究上述两个固定仓库；原文、实际 LICENSE 与 Node 官方测试已保存到 TEMP。外部官方测试只读取，未执行，不复制框架或新增生产测试 API。

## Windows 官方 PPID 语义

[`Win32_Process.ParentProcessId:639–651`](https://github.com/MicrosoftDocs/win32/blob/e103fa4e8810bd8d42c4777e17081e24dbe62dbd/desktop-src/CIMWin32Prov/win32-process.md#L639-L651) 明确：PPID 所指进程可能已经结束，也可能错误指向复用该编号的新实例；可用 CreationDate 判断指定父实例是否比该子实例更晚创建。

因此 `row.ParentProcessId === ownedPid` 不能独自证明 row 属于当前父实例。仅当同一 census 的两个出生值有效、可比较且 child birth 早于 current parent birth 时，才有依据拒绝这条当前实例之间的父子边；出生相等不能仅因此拒绝。出生缺失/不可比较时不能伪造确定排除或退出证明，应保留已有保守处理。

字段应按既有规范域比较，不降成 JS Number 或先转毫秒。固定 [`CIM_DATETIME:29,48`](https://github.com/MicrosoftDocs/win32/blob/e103fa4e8810bd8d42c4777e17081e24dbe62dbd/desktop-src/WmiSdk/cim-datetime.md#L29-L48) 定义六位微秒字段；FILETIME 格式转换不补回源精度。单次 census 与出生顺序约束也不是整棵进程树原子快照或所有原后代已结束的证明。

这条规则针对有证据的 stale PPID 边，不是按进程名过滤 Sogou/conhost，也不修改已捕获原实例的出生身份或 exit predicate 去假装该无关实例已退出。

## Node 官方 mock 与 ESM live binding 契约

Context7 已执行 `resolve-library-id("Node.js")` → `/websites/nodejs_latest-v24_x_api`，分别查询 mock.method/restore 与 syncBuiltinESMExports；以下还核对了固定 24.14.0 文档。

- [`test.md:2353–2381`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/test.md#L2353-L2381)：`t.mock.method(object, methodName, implementation)` mock 既有对象方法，返回带 `mock` 上下文的 Proxy。适合默认 builtin 导出上的 `childProcess.execFile`，不把只读 ESM namespace 当成可修改普通对象。
- [`test.md:2161–2170`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/test.md#L2161-L2170) 与 [`2517–2545`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/test.md#L2517-L2545)：mock.restore/restoreAll 恢复方法；test context 完成时会 reset，其自动恢复不能代替 named builtin binding 的显式同步。
- [`module.md:342–350`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/module.md#L342-L350)：`syncBuiltinESMExports()` 将 builtin 既有 ESM live bindings 同步到 CommonJS/default 导出属性，不增加或删除导出名。
- `mock.module` 的实验 CLI flag 不属于 `mock.method` 这条方法替换路径，本轮无需新增该 flag、loader 或生产 seam。

### 最小测试与恢复顺序

在独立、Windows 条件启用的 Node test 中，以受控 CIM stdout 回放替换 execFile。生产模块仍直接调用原 `captureProcessTreeEvidence` 的真实解析与树遍历代码：

```ts
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const mockedExecFile = t.mock.method(childProcess, "execFile", cimReplay);
syncBuiltinESMExports();
try {
  await captureProcessTreeEvidence(rootPid);
} finally {
  mockedExecFile.mock.restore();
  syncBuiltinESMExports();
}
```

`cimReplay` 使用生产调用的 command/args/options/callback 结构，在 microtask 调用 `callback(null, JSON.stringify(censusRows), "")`；只回放命令 stdout，不 mock SDK 线程身份或直接返回目标树。明确这是受控 metadata replay，未执行真实 CIM 查询。测试完成前应断言默认 execFile 和 named binding 都已恢复；同一 worker 内不并发修改 builtin。

先恢复默认方法，再同步 named bindings：若只依赖 t.mock 自动 reset，生产模块先前导入的 named execFile 可能仍指向 mock Proxy，即使其实现已经恢复；若先 sync 再 restore，也会把 mock 引用同步回 named binding。

Node 官方 [`test-runner-mocking.js:192–215`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/test/parallel/test-runner-mocking.js#L192-L215) 检查对象方法 Proxy、调用记录与嵌套 restore 后回到原函数。该测试并不执行 Windows census 或本项目的 stale PPID 场景；本项目的 ESM 同步顺序由 API 契约与本地 replay 测试共同核对。

## 本地验证报告与剩余范围

根执行方与探针智能体报告：真实采集 producer 在受控 CIM metadata 下先得到业务 RED（错误包含 84272 与其受控子支 60004）；最小出生 edge 过滤后新 3 cases 通过、typecheck exit 0，相关目标总计 95/95 通过，既有断言和 deadlines 保持。

这些 replay 用例覆盖 stale edge/其后代不进入原树、有效/相等出生的嵌套成员保留，以及 unknown birth 的保守处理。60004 是受控子支，不宣称它是现场实际进程；真实现场证据是前述独立失败记录。本研究员未运行或复演这些测试，没有将回放包装成 live CIM/SDK identity 验收。

完整 125 文件门禁与正式运行态验收由根执行方另行记录；目标通过不等于整体 ancestry 已无竞态或生产已完成部署。本配套文档不改写第 42 轮 pending-receipt 的归属证明，也不把无 ACK/未知 writer 边界称为已恢复。
