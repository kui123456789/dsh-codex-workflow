# 2026-10-05 第九轮：Planner 恢复保留原模型设置

本轮修复 Planner 失败之前未完整保存模型与请求 effort，导致 manual resume 读取当前 config 后改变原选择的问题。源码参考见[Planner 设置研究](../research/github-planner-settings-patterns-2026-10-05.md)。本记录分别列出源码回归、安装宿主隔离门禁和正式 DSH 的验证范围。

## 失败路径与本轮处理

原 Planner 可在产出成功结果之前进入可恢复等待或 abort。若设置只在成功路径保存，等待期间配置由 A/high 改为 B/low 后，manual resume 可能把 B/low 发送给原 thread。相同 thread 身份不能防止 turn 参数覆盖其模型设置。

本轮使用客户端 `onModel` 回调给出的已解析 wire 模型保存运行选择。requested effort 在首次规划执行之前保存，并在失败或 abort 时保留；自动 continuation 和 manual resume 都沿用该运行保存的 model/effort，避免恢复入口重新选取当前 config。

模型快照描述客户端解析的 wire 选择；effort 快照描述原请求。现有 SDK port 不报告服务器实际 effort，本轮没有更改该接口，不能将保存值宣传为 server actual effort。公开协议具备相关字段只作为研究证据。

## 兼容与阶段边界

- 新的带快照运行使用本次保存的选择；等待期间修改全局 config 不改变其 continuation 设置。
- legacy 记录缺少快照字段时，继续保留既有 config fallback。这保证当前兼容路径，不证明原历史选择已被恢复。
- 当前 PlanMode 省略参数会重新选择 preset，因此没有采用研究建议中的省略 override 方案。
- 私有转换回合继续使用固定 `low`。转换 effort 与 Planner 业务 effort 分开，不能将转换的 `low` 写回 Planner 快照。
- 真正的新业务运行仍按该新运行的配置选择设置；本轮不增加模型切换 API、新依赖或跨进程 ephemeral 恢复能力。

## 已知定向红绿基线

以下计数由主任务提供，文档子任务没有重复运行测试：

| 阶段 | 已知结果 | 证据范围 |
|---|---|---|
| 补丁前定向红例 | **6 个测试，4 个失败** | 原模型/effort 在失败恢复路径中未完整保留 |
| 补丁后同组绿例 | **6 个测试通过** | 该组设置保留回归已转绿 |
| 具体红例 | 显式 A/low 的前两轮为 A/low，manual resume 变 B/high；未配置模型但首次解析 A 时，后续仍省略模型且 manual effort 变 high；两种早期 abort 同样丢失选择 | 原 thread/child 始终相同，因此仅身份检查不能发现这个缺陷 |

`startInner` 在首次 await 前复制所选字符串值，并把 `plannerModel`（已知时）和 `plannerEffort` 写入初始记录。客户端解析模型后同步更新该运行与同一个 retry options 对象；即使尚未获得 turn/start 成功响应，失败等待也可保存最新已知选择。新增的可选 effort 归入 v2 `planning` envelope，SQLite 重新打开及反序列化回归已核验。

## 后续回归与最终验收

| 检查 | 预期覆盖 | 当前状态 |
|---|---|---|
| 自动 continuation 设置 | 失败后使用原 wire model/requested effort，config 变化不重选 | **通过**；显式选择和默认解析选择两种情况；同一次 transient wrapper 重试也保持首次解析的 model |
| manual resume 设置 | 请求确实包含原运行保存值；默认设置变更不影响该快照 | **通过**；运行 B/low 等待后 config 改 C/high，原 resume 仍发送 B/low |
| 早期失败与 abort | 成功产物出现前即保存请求 effort；onModel 解析值在失败/abort 中保留 | **通过**；generic fail twice、thread 已创建但 turn 未开始、onStarted 后中止均保留选择 |
| legacy 与私有转换 | 缺字段继续原 config fallback；私有转换固定 low，不覆盖业务 effort | **通过**；旧记录有／无 model 两种 fallback；legacy resume 新解析 model 传入转换并存入记录；真实 conversion 方法发送 low |
| 新业务运行 | 合法的新 Planner 使用新运行设置，与原回合 continuation 区分 | **通过**；独立 owner 新任务读取 C/high，原 B/low 的恢复不变；短回复 controlled completion 保留原 visible effort |
| `pnpm typecheck` | 类型检查 | **通过** |
| `pnpm test` / `pnpm verify` | 完整通过/失败/跳过数量与日志 | 定向 **10/10**；最新完整验证 **662/662**，失败 0、跳过 0，约 46.7 秒 |
| `pnpm release:check` | 发布、离线 doctor 与包审计 | **连续两次通过**，均 662/662、失败 0、跳过 0，`RELEASE_CHECK_OK`；离线 doctor 通过（五项跳过）、打包审计及临时 tarball 清理通过 |
| `pnpm host:check` / `pnpm host:recovery:check` | 实际安装宿主的隔离兼容与恢复检查 | **均通过**；DSH `0.1.7-rc.2`、九个工具、注册／卸载及 peer/sidebar 契约；四个恢复／清理场景各一个 child、一次可见 thread 创建、pending tools 为 0，恢复均保留原身份 |
| 正式 DSH UI / 实际模型 | 原会话继续的实际设置与身份证据 | **本轮未重载正式 DSH、未新增真实模型调用**；现有服务仍为第六轮实测版本，本轮只验证源码与隔离宿主 |

本轮验收应分别记录 wire 解析模型、requested effort 和缺失字段的兼容行为；没有 server actual effort 的观测时保持未知。已有线程恢复门禁、合成回归和真实 UI 验收分别记录，不将上一轮结果当作本轮验证，不推算 Token 或费用。

定向与完整日志在系统临时目录：`dsh-ninth-final-targeted-tests.log`、`dsh-ninth-typecheck.log`、`dsh-ninth-final-verify.log`。最终发布／宿主门禁在 `dsh-ninth-final-gates-77a11c0e-955a-4352-9479-977a60583fc0/`，其中 `summary.json` 明确标注 scripted-local model gateway 和未验证正式浏览器 UI。
