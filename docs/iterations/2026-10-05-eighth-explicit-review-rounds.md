# 2026-10-05 第八轮：显式开启新的业务审查轮次

本轮处理工作区变化之后，显式 review 被等待恢复分支阻断的问题。恢复模型失败仍复用原 Reviewer/thread；用户显式发起 review，且原审查 scope 的证据确已变化时，才允许结束旧回合并创建真正的新 Reviewer。第七轮已完成的 639 基线及门禁记录保留在[第七轮记录](2026-10-05-seventh-recovery-eligibility.md)，不作为本轮改动的验收结果。

## 旧分支的具体缺口

Reviewer 处于可恢复等待状态、原句柄仍存在时，第七轮 status 能只读扫描并返回 `continuation.available:false`、`continuation.reason:workspace_changed`。用户此时显式调用 review，原有等待分支仍可能拒绝进入新业务回合：

| 显式 review 请求 | 旧等待分支 | 结果 |
|---|---|---|
| 与原审查输入相同 | 直接委托原回合 resume | resume 根据已变化的工作区拒绝，不能开启新审查 |
| 与原审查输入不同 | 要求先 resume original | 原证据已经变化，原回合不能合法恢复，新回合也没有入口 |

这个缺口把“模型回合失败后的恢复”和“证据变化后的新审查”都导入了原恢复入口。status 的诊断本身不释放句柄；显式 review 需要独立判断是否满足新业务回合的条件。

## 新回合的许可边界

- **原 scope 证据未变化：** 同输入继续使用原 thread/child；不同输入不能作为强制替换原 Reviewer 的理由，仍遵循原恢复与输入校验规则。
- **原 scope 证据确已变化，并有显式 review 请求：** 允许结束旧等待回合，再经过既有审查 admission 与新请求证据校验，创建新的 Reviewer。
- **status、resume、自动 continuation 或后台恢复：** 工作区变化仅说明当前不能恢复，不授权新建 Reviewer。
- **证据缺失、扫描失败或无法确认变化：** 不把未知当作变化，不销毁旧句柄，也不自动创建替代运行。

“原 scope”指旧回合固定的审查目标和证据范围。改变新请求的路径、参数或描述，不能代替对原 scope 的当前证据进行比较。此次资格判断也不绕过新请求原有的归属、相位和证据要求。

## 异步检查与清理顺序

用于判断新回合资格的 helper 扫描原 scope，扫描 await 之后再决定是否释放旧回合。必须重新核验：

1. 调用者仍有该 workflow 的授权，当前 record 和生命周期状态仍允许显式 review。
2. 原 recoverable run/handle 身份未变化，仍是本次准备结束的旧运行。
3. cancel/stop 未发生；原恢复 owner 或其他审查驱动没有在扫描期间开始执行。
4. 新回合仍经过既有并发 admission；检查结果不能作为迟到请求绕过 resume 的凭据。

只有这些条件仍成立，才能结束旧回合。旧 child、usage subscription 和 review round pin 由同一归属路径收尾一次；取消、停止、迟到结果或其他 cleanup 不能重复释放。之后的新业务轮只计一次 review cycle，并创建一个新 Reviewer/thread。新轮发生模型失败时，继续沿用该新轮自己的原 thread，不因重试再计一次 cycle。

扫描与资格判断不得先释放旧句柄再检查变化。扫描期间若 ownership、原身份或 stop 状态已变化，应按最新状态退出，避免关闭其他请求正在使用的运行或在停止后迟到创建新子会话。

旧订阅的释放同样包含 await。回归确认：若清理期间更换 DSH owner，原 caller 使用清理前的 prepared record 仍会创建新模型回合。现在 caller 在清理完成后重新执行 owned 读取，取消优先返回，并继续 signal、lease 和普通新审查资格检查。

## 源码参考的适用范围

固定来源、许可和核验方法见[第七轮研究](../research/github-recovery-eligibility-patterns-2026-10-05.md)。本轮只参考以下原则：

- [LangGraph `_first` L855-L879](https://github.com/langchain-ai/langgraph/blob/9a0394d88b2211f299dcd69df92db3480c69ee61/libs/langgraph/langgraph/pregel/_loop.py#L855-L879)：已有状态与恢复意图分别判断。
- [Temporal 冲突策略 L90-L110](https://github.com/temporalio/sdk-typescript/blob/7510506c9d81207420b049c7eea936cdf9bf5ecb/packages/common/src/workflow-options.ts#L90-L110)：使用已有运行与创建其他执行属于不同操作语义。
- [OpenHands 生命周期锁 L982-L1017](https://github.com/OpenHands/software-agent-sdk/blob/091d451f5fdd1952994f7da4fcf201a1d21bb615/openhands-agent-server/openhands/agent_server/conversation_service.py#L982-L1017)及[创建前再次检查 L1645-L1668](https://github.com/OpenHands/software-agent-sdk/blob/091d451f5fdd1952994f7da4fcf201a1d21bb615/openhands-agent-server/openhands/agent_server/conversation_service.py#L1645-L1668)：异步准备之后重新校验身份和生命周期。

这些引用不是本项目实现证明。本轮没有移植第三方 checkpoint、跨进程 runtime 重建或执行链；不复制源码，不据此承诺已退出 App Server 的 ephemeral 线程可恢复。本文档子任务没有再次联网或运行正式模型。

## 回归与最终门禁

| 检查 | 预期覆盖 | 当前状态 |
|---|---|---|
| 旧分支红例 | 已确认原 scope 变化后，显式同输入/不同输入 review 都无法合法开启新轮 | 独立真实 Manager 回归最初 **4 项中 2 项失败**，分别误走旧 resume 和误拒绝不同输入 |
| 显式新轮绿例 | 原 scope 确变化且显式 review 合法时，一个新 Reviewer/thread，一个新业务 cycle | 同输入及更新输入两种变化情况通过；原 workflow ID 不变、新 Reviewer/child 各一个，旧失败未消耗 cycle，成功后 cycle 为 1 |
| 原恢复绿例 | 原证据未变化时复用原 child/thread；不重复初始审查或增加 cycle | 既有原线程恢复回归通过；新负例确认仅改变输入不会释放原 handle 或创建新 Reviewer |
| 自动与只读入口 | status/resume/自动恢复不因证据变化新建 Reviewer；未知证据不释放旧运行 | 新显式 resume 负例与 evidence/fingerprint 缺失负例通过；仅 status 诊断不会创建或释放原运行 |
| helper 扫描竞态 | await 期间授权、owner、handle、cancel/stop 或 resume 驱动变化，拒绝过期资格 | 五种真实 Manager/SQLite/admission 场景通过；清理窗口额外 **2 项中 1 项先红**，修后 2/2 通过 |
| 旧回合收尾 | child、subscription、pin 各释放一次；停止后没有迟到新子会话 | 全部 **13/13 新回归通过**；记录原始 dispose、旧 subscription 和 pin 调用，扫描及清理期间取消/停止均没有新 child/thread/model |
| `pnpm typecheck` | 类型检查 | **通过** |
| `pnpm test` / `pnpm verify` | 完整回归及通过/失败/跳过数量 | 最新冻结源码 **652/652 通过**，失败 0、跳过 0，约 47.6 秒；此前 650 基线不用于替代本次验证 |
| `pnpm release:check` | 发布、离线 doctor 与包审计 | **连续两次通过**，均 652/652 和 `RELEASE_CHECK_OK`；离线 doctor 通过（五项跳过）、包审计及临时 tarball 清理通过 |
| `pnpm host:check` / `pnpm host:recovery:check` | 实际安装宿主的隔离兼容与恢复检查 | **均通过**；DSH `0.1.7-rc.2`、九个工具；四个恢复／清理场景各一个 child 和一次可见 thread 创建、原生回放通过、pending tools 为 0 |
| 正式 DSH UI 与实际模型 | 证据变化后的显式新审查，以及同一新轮失败后的原会话继续 | **本轮未重载正式 DSH、未新增真实模型调用**；PID 45264 仍运行第六轮已实测版本，最新 `lib/` 已构建。UI 新路径不能从合成模型门禁推断已完成 |

本轮验收应分别记录“同一业务回合继续”和“明确新业务回合”的身份及计数。测试日志、安装宿主隔离检查和正式 UI 各自保留实际证据；不将前轮门禁或合成测试当作本轮真实运行结论，不推算 Token 或费用。

最新日志在系统临时目录：`dsh-eighth-final-targeted-tests.log`、`dsh-eighth-final-verify.log`、`dsh-eighth-final-gates-278153e4-e6e1-4b5b-b176-439ed3670639/`。

## 后续检查候选

静态检查发现 Planner 的初始模型／effort override 与失败后的手动恢复存在不同读取路径：`startInner` 的初始 record 没有保存完整选择，`resume` 则从 record/config 读取，且 Planner record 尚无 effort 字段。下一轮应先构造回归，验证可恢复失败之后是否保持初次实际模型和推理强度；本轮没有宣称已修复这一候选。
