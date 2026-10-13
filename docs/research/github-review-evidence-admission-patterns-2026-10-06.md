# 昂贵审查步骤启动前的输入与资源门禁核验

核验日期：2026-10-06。使用 Agent Reach 的 GitHub／`gh` 后端读取 Prefect、Dagster 的固定公开源码和测试。本文只借鉴执行顺序与拒绝条件，没有复制 SDK/框架源码、加入依赖、修改生产代码、调用模型或运行正式服务。上游测试仅阅读，未执行。

## 结论与来源

参数可以解析成 JSON、类型正确、历史记录曾经 ready，仍不足以证明本次审查具备有效输入。应在创建模型 thread/DSH child 与发送模型回合之前，完成当前 owner、仓库、审查范围和证据可用性校验；缺少可补充输入时保留原 workflow，让用户修正后通过同一接纳入口继续。

| 案例 | 固定提交 | 固定许可 | 借鉴机制 |
|---|---|---|---|
| PrefectHQ/prefect | `86cbe02fe1932964852dba7ef9eb2ab497ee85c9` | [Apache-2.0][p-license] | 用户 flow 函数前校验当前参数，失败 short-circuit |
| dagster-io/dagster | `13168d9ba1ac882661701fb6fb6039a20852cf50` | [Apache-2.0][d-license] | 缺输入/缺资源定义时拒绝计划接纳，用户 op 不 dispatch |

## Prefect：当前参数通过后才调用用户 flow

**Evidence。** 同步 [begin_run][p-begin] 先解析参数、等待依赖，再调用 `flow.validate_parameters`；捕获校验异常后处理错误并设置 `short_circuit=True`。[set_state][p-short] 在该标记存在时保留当前状态，不能继续切换 Running；[run_flow_sync/async][p-dispatch] 只在 `engine.is_running()` 时调用用户 flow。异步 [begin_run][p-async] 实现同样顺序。

[validate_parameters][p-validate] 由函数签名/注解生成 Pydantic 验证路径，返回转换后的参数或 ParameterTypeError；没有调用 `flow.fn`。[实际用户函数调用点][p-userfn] 在 engine 的 call_flow_fn 中，位于上述接纳门禁之后。

**Finding。** 上游同步及异步 [无效参数测试][p-test-sync]、[异步测试][p-test-async] 以 `x="FAIL!"` 传入 `x:int` 的 flow，断言 Failed/ParameterTypeError；邻近用例同时断言类型可转换的 `"42"` 得到整数 42。测试没有单独记录模型/thread/child 调用计数，用户 flow 未调用的结论来自 dispatch 控制流。

**Path 与边界。**

- 将可修正的审查输入校验放在昂贵模型 dispatcher 前；修正原 workflow 的输入后，再以当前数据重新接纳。
- 默认验证会发生类型 coercion，且 [validate_parameters=False 用例][p-disable-test] 明确可以绕过它。本项目应显式定义必需条件，不能借类型转换推断仓库或证据真实存在。
- Prefect 可以在校验前建立 flow-run 记录、解析 Block 引用或运行自定义 validator；本例只证明用户 flow 函数门禁，不证明整个接纳过程零副作用。
- Prefect 的参数错误写 Failed；本项目“缺输入、等待同 workflow 修正”的状态策略应独立决定，不能照搬其终态分类。
- 这里没有检查本项目的 repository identity、文件存在、diff 对应版本、证据内容或工作区是否变化。

## Dagster：缺必需输入或资源定义时拒绝执行

**Evidence。** [core_execute_in_process][d-entry] 依次检查顶层输入、创建 execution plan，之后才 create_run_for_job、构造并消费执行 iterator。[顶层输入检查][d-top-input] 在没有 loader/default/direct input 的情况下抛 DagsterInvalidInvocationError。

[create_execution_plan][d-plan] 无条件以当前 `run_config` 调用 ResolvedRunConfig.build，然后才把 `known_state` 等信息传入 ExecutionPlan.build。[ResolvedRunConfig.build][d-config] 处理当前配置，失败抛 DagsterInvalidConfigError。此路径说明已有 known_state 本身不能跳过当前配置接纳。

资源侧，[ResourceKeyRequirement.ensure_satisfied][d-resource] 检查所需 key 是否存在且定义类型正确；[统一 requirements 检查][d-requirements] 对每项要求执行该验证。[job 的验证入口][d-resource-entry] 调用它，缺 InputManager/IOManager 属于定义接纳错误。

**Finding。** [test_string_missing_inputs][d-input-test] 调用 execute_in_process 缺必需配置，断言 DagsterInvalidConfigError 且 `"yup" not in called`，明确证明用户 op 未调用。同文件还覆盖提供了与依赖相冲突的输入配置时 op 未调用。[缺 input manager 测试][d-resource-test] 在 job 定义阶段拒绝缺失管理器；它证明缺资源定义的接纳门禁，不是外部服务健康检查。

**Path 与边界。**

- 业务 dispatch 之前检查真实所需输入与资源，拒绝时返回具体缺项，不能先启动 Reviewer 再依赖模型报错。
- 用当前输入重建/验证接纳条件；历史 ready、已有计划或恢复标记不直接等于当前可执行。
- Dagster 的存在/类型检查只覆盖 resource definition；它不证明文件可读、远端服务可达或凭据仍有效，资源初始化和 config mapping 也可能运行代码。
- 配置通过后到步骤执行之间仍可能发生外部状态变化。本例没有锁住 live FS，本项目必须使用自己的 snapshot/freshness fence。
- 两个案例均未证明 DSH 的同 workflow 修正、原 child/thread 保留或模型零调用计数；这些需要本项目自身回归测试。

## 本项目的最小采用与验收方向

| 当前校验层 | 应核实的条件 | 失败后的动作 |
|---|---|---|
| 形状与语义 | 必需 scope/模式/路径字段、允许值与规范化输入；空值不能仅因 JSON 合法而接纳 | 返回具体缺项，保留原 workflow 等待补充 |
| owner 与相位 | 当前调用者、workflow origin、合法相位、已有审查 owner 与恢复 pair | 拒绝越权/冲突，不建立新模型资源 |
| repository liveness | 当前绝对工作区可访问，仓库身份与所选 revision 对应；所需文件/改动仍存在 | 重新采集证据或等待修正 |
| evidence freshness | 当前范围有可用证据且与 snapshot/signature 对应；实际没有可审查内容应明确报告 | 阻止昂贵 dispatch，保留可修正记录 |
| 历史 ready/恢复输入 | 每次接纳读取并验证当前记录；legacy ready 不能覆盖缺 scope/失效证据 | 修正原记录后重走门禁；已启动的恢复遵守原句柄屏障 |

应使用真实入口回归：缺 scope、仓库已移动/不可访问、文件或 diff 已变化、历史 ready 但当前证据失效时，断言 model turn、thread/start、subagents.start 均为零；原 workflow 补齐有效输入后才首次 dispatch。owner 不符或原 writer 终止未确认时继续拒绝；已有成功 checkpoint 的下游恢复仍应满足当前身份与 freshness 条件，参考 [checkpoint 研究](github-review-checkpoint-patterns-2026-10-06.md)。

本节给出采用与验收方向，不对共享工作区当前实现、全部测试门禁或真实 DSH UI 作通过声明。

[p-license]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/LICENSE
[d-license]: https://github.com/dagster-io/dagster/blob/13168d9ba1ac882661701fb6fb6039a20852cf50/LICENSE
[p-begin]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/src/prefect/flow_engine.py#L688-L718
[p-short]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/src/prefect/flow_engine.py#L754-L758
[p-dispatch]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/src/prefect/flow_engine.py#L2096-L2137
[p-async]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/src/prefect/flow_engine.py#L1412-L1442
[p-validate]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/src/prefect/flows.py#L591-L679
[p-userfn]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/src/prefect/flow_engine.py#L1337-L1351
[p-test-sync]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/tests/test_flow_engine.py#L1219-L1257
[p-test-async]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/tests/test_flow_engine.py#L1019-L1057
[p-disable-test]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/tests/test_flows.py#L720-L725
[d-entry]: https://github.com/dagster-io/dagster/blob/13168d9ba1ac882661701fb6fb6039a20852cf50/python_modules/dagster/dagster/_core/execution/execute_in_process.py#L119-L157
[d-top-input]: https://github.com/dagster-io/dagster/blob/13168d9ba1ac882661701fb6fb6039a20852cf50/python_modules/dagster/dagster/_core/execution/execute_in_process.py#L183-L219
[d-plan]: https://github.com/dagster-io/dagster/blob/13168d9ba1ac882661701fb6fb6039a20852cf50/python_modules/dagster/dagster/_core/execution/api.py#L677-L718
[d-config]: https://github.com/dagster-io/dagster/blob/13168d9ba1ac882661701fb6fb6039a20852cf50/python_modules/dagster/dagster/_core/system_config/objects.py#L127-L164
[d-resource]: https://github.com/dagster-io/dagster/blob/13168d9ba1ac882661701fb6fb6039a20852cf50/python_modules/dagster/dagster/_core/definitions/resource_requirement.py#L61-L78
[d-requirements]: https://github.com/dagster-io/dagster/blob/13168d9ba1ac882661701fb6fb6039a20852cf50/python_modules/dagster/dagster/_core/definitions/resource_requirement.py#L219-L224
[d-resource-entry]: https://github.com/dagster-io/dagster/blob/13168d9ba1ac882661701fb6fb6039a20852cf50/python_modules/dagster/dagster/_core/definitions/job_definition.py#L659-L661
[d-input-test]: https://github.com/dagster-io/dagster/blob/13168d9ba1ac882661701fb6fb6039a20852cf50/python_modules/dagster/dagster_tests/core_tests/test_input_injection.py#L49-L103
[d-resource-test]: https://github.com/dagster-io/dagster/blob/13168d9ba1ac882661701fb6fb6039a20852cf50/python_modules/dagster/dagster_tests/core_tests/resource_tests/test_required_resources.py#L540-L559

