# 工具结果展示、元数据与按需读取核验

核验日期：2026-10-05。使用 Agent Reach 的 GitHub / `gh` 路由检索并按固定提交读取原始源码；许可证由仓库元数据与 LICENSE 核验。本轮只研究与测量，不修改工具实现，不复制第三方代码，也不把字节数换算为 Token 或费用。

## 源码机制

| 项目 | 固定提交 | 许可 | 实际机制 |
|---|---|---|---|
| Codex | `823ea830c0fd418b09ff02d36cad9a1fff66465b` | [Apache-2.0](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/LICENSE) | 模型历史与原始 Code Mode 结果使用不同表示 |
| OpenCode | `907b3bc518fa48e90e8ec24dd327d13eee71c36c` | [MIT](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/LICENSE) | 完整结构化值保留，展示预览受限，大文本落盘供按需读 |
| Goose | `d7ce0cdf8c4e1fb55aabed5b6717f141c4c8220f` | [Apache-2.0](https://github.com/aaif-goose/goose/blob/d7ce0cdf8c4e1fb55aabed5b6717f141c4c8220f/LICENSE) | Shell 结构化结果与展示文本分开，大输出保存读取入口 |

### Codex

[McpToolOutput L126-L145](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/tools/context.rs#L126-L145) 保留原始 `CallToolResult`，日志使用独立预算；[L164-L180](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/tools/context.rs#L164-L180) 分别提供 Code Mode 原结果、metadata 与 post-tool hook 原响应。实际模型历史通过 [response_payload L184-L213](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/tools/context.rs#L184-L213) 转换内容并施加截断预算。

采用：本项目保留完整业务/持久值，只精简模型读到的重复计量历史。边界：不迁移其 Token 估计器；也不对计划、判定或 JSON 对象做任意字符串裁切，这会破坏业务语义。

### OpenCode

[Tool 包装 L130-L143](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/tool/tool.ts#L130-L143) 替换展示 `output`，在 metadata 中保留 `truncated` 和 `outputPath`。[truncate L85-L94](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/tool/truncate.ts#L85-L94) 使用 UTF-8 bytes 与行数检查；[L124-L139](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/tool/truncate.ts#L124-L139) 保存原文并给出 Grep/Read 的 offset/limit 读取提示。

更接近本项目的是 [ToolOutputStore L138-L172](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/tool-output-store.ts#L138-L172)：限制展示 `content` 时仍保留原 `structured`，完整文本写入独立输出文件。

采用：以结构化投影精简重复来源列表，明确详情读取入口。边界：不照搬 2000 行 / 50 KiB 全局限制，也不额外生成结果文件；本项目已经有持久 workflow 账本，详情可经原状态工具读取。

### Goose

[Shell L452-L461](https://github.com/aaif-goose/goose/blob/d7ce0cdf8c4e1fb55aabed5b6717f141c4c8220f/crates/goose/src/agents/platform_extensions/developer/shell.rs#L452-L461) 构造 stdout/stderr/exit code 等结构化字段，同时单独构造展示文本；[L503-L522](https://github.com/aaif-goose/goose/blob/d7ce0cdf8c4e1fb55aabed5b6717f141c4c8220f/crates/goose/src/agents/platform_extensions/developer/shell.rs#L503-L522) 在成功/错误内容块旁保留 `structured_content`。[L851-L865](https://github.com/aaif-goose/goose/blob/d7ce0cdf8c4e1fb55aabed5b6717f141c4c8220f/crates/goose/src/agents/platform_extensions/developer/shell.rs#L851-L865) 给出完整输出文件及分段读取方式；[L882-L898](https://github.com/aaif-goose/goose/blob/d7ce0cdf8c4e1fb55aabed5b6717f141c4c8220f/crates/goose/src/agents/platform_extensions/developer/shell.rs#L882-L898) 同时检查行数和 bytes。

采用：错误、成功、统计摘要均保留可理解的结构，不把完整历史默认展开。边界：Goose 的结构化 stdout/stderr 已经过各自截断，不能把“有 structured_content”当作原文永不丢失的证明；本项目仍以 SQLite 完整账本为权威。

## 本项目现场与宿主接口

`src/tools.ts` 的 `asJson()` 只做 JSON 克隆，普通控制工具和 status 的 canonical value 都包含整个 WorkflowRecord；共用 `jsonOutput.render()` 再把整个值美化为模型内容。因此新增 `observedUsage.sources` 历史会在每次控制工具结果中重复展开。`submit` 也通过对象展开保留整份 record。

通过 Context7 的 `/deepseek-ai/deepseek-harness` 核验当前工具契约，并对照实际安装的 DSH `0.1.7-rc.2` `ToolOutputDefinition` / `ToolExecutionSuccess`：`output.render(args,value)` 是 Native/model 内容投影，`value` 是执行期间的 canonical JSON；`presentationMeta` 是独立 UI 投影。canonical value 不写入聊天 `tool/result`，该事件只保存 content/error/meta。文档来源：[tools 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md)。这是当前接口文档，非本报告固定提交的第三方源码证据。

## 本次 UTF-8 字节测量

运行环境：Node `v24.14.0`。直接调用现有编译产物 `createWorkflowTools(...).find(status).output.render({}, fixture)`，以 `Buffer.byteLength(text, "utf8")` 测量。Context7 核验了该函数返回编码后的 bytes，区别于字符串长度；它不是模型 tokenizer。

两份合成 fixture 的业务字段完全相同：task、计划全文、最新审查、完整 files evidence、phase、continuation、会话/工作流身份与时间。每来源使用固定 36 字符 opaque source ID、`test-model`、total/last 六项服务器计数和 context window；仅来源条数与现有合并函数生成的统计汇总不同。没有读取用户聊天或数据库。

| 原线程来源数 | canonical JSON bytes | 当前美化模型文本 bytes | 建议摘要展示 bytes |
|---:|---:|---:|---:|
| 1 | 1753 | 2374 | 1770 |
| 11 | 5740 | 8721 | 1778 |

建议摘要只把展示对象的 `observedUsage.sources` 换成 `sourceCount` 与 `sourcesIncluded:false`，保留 version/source/scope/summary；其它业务字段逐项保持相同，`businessWithoutUsageIdentical` 两组均为 `true`。本次 11 条来源的展示差值为 **6943 bytes**，不是实际模型 Token 或费用差值。

测量脚本如下，可在仓库根目录作为 ESM 通过 Node 执行；它只在内存中构造 fixture。实现 renderer 后再次运行会得到新结果，本表描述研究时的原实现。

```js
import { createWorkflowTools } from "./lib/tools.js";
import { mergeWorkflowObservedUsage } from "./lib/workflow-usage.js";
const business = {
  schemaVersion: 1, id: "fixture-workflow", dshSessionId: "fixture-session", cwd: "C:/synthetic-workspace",
  task: "增加只读健康检查命令，保留失败恢复机制", mode: "planned", phase: "executing",
  createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z",
  planMarkdown: "# 目标\n增加健康检查。\n# 改动\n读取配置并报告 SQLite 状态。\n# 验证\n验证缺失和正常配置。",
  assumptions: [], questions: [], reviewCycles: 0,
  latestReview: { verdict: "pass", findings: [], testGaps: [], summary: "符合当前要求" },
  latestReviewEvidence: {
    kind: "files", changedFiles: ["implementation.txt"], status: "fixture", diff: "fixture diff",
    diffTruncated: false, diffBytes: 12, fingerprint: "synthetic-fingerprint",
    fileHashes: [{ path: "implementation.txt", sha256: "0".repeat(64) }],
    missingFiles: [], rejectedPaths: [], insufficient: false,
  },
  continuation: { available: false, reason: "not_waiting" }, reviewerActive: false,
};
const status = createWorkflowTools({ status: async () => ({}) }, { turnTimeoutMs: 1000, transientRetryBudgetMs: 0 })
  .find((tool) => tool.name === "codex_workflow_status");
const counts = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 70, cacheWriteInputTokens: 5,
  outputTokens: 20, reasoningOutputTokens: 6 };
for (const count of [1, 11]) {
  const sources = Array.from({ length: count }, (_, index) => ({
    sourceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    stage: index === 0 ? "planning" : "reviewing", model: "test-model",
    total: { ...counts }, last: { ...counts }, modelContextWindow: 128000,
  }));
  const full = { ...business, observedUsage: mergeWorkflowObservedUsage(undefined, sources) };
  const projected = { ...full, observedUsage: {
    version: full.observedUsage.version, source: full.observedUsage.source, scope: full.observedUsage.scope,
    summary: full.observedUsage.summary, sourceCount: sources.length, sourcesIncluded: false,
  } };
  console.log({ sourceCount: count,
    canonicalUtf8Bytes: Buffer.byteLength(JSON.stringify(full), "utf8"),
    currentRenderedUtf8Bytes: Buffer.byteLength(status.output.render({}, full)[0].text, "utf8"),
    proposedSummaryRenderedUtf8Bytes: Buffer.byteLength(JSON.stringify(projected, null, 2), "utf8"),
    businessWithoutUsageIdentical: JSON.stringify({ ...full, observedUsage: undefined })
      === JSON.stringify({ ...projected, observedUsage: undefined }),
  });
}
```

## 最小接口方案

1. **仅改模型展示投影。** 控制工具仍返回完整 canonical WorkflowRecord；共用 renderer 对已验证的 `observedUsage` 生成 summary 投影，保留 `version`、`source`、`scope`、`summary`、`sourceCount`，明确 `sourcesIncluded:false`。计划、审查、证据、问题/假设、错误、恢复状态、submission 和业务决策字段完整保留。
2. **status 按需展开。** `codex_workflow_status` 增加可选 `includeUsageSources:boolean`，默认 `false`；为 `true` 时 renderer 返回完整 `observedUsage.sources`，并标明 `sourcesIncluded:true`。工具描述提示来源诊断使用该参数，正常轮询无需反复携带历史。参数只属于工具展示，不改变 Manager.status 的参数或 SDK 返回类型。
3. **权威记录与读取路径保留。** SQLite、Manager SDK 和 CLI `show` 保持完整 ledger；工具 canonical value 也保持完整，避免影响程序化调用。第一版不新增 RPC、不迁移 schema、不依赖新文件或上游截断框架。

这解决的是 Native 工具结果默认模型文本中的重复来源历史。PTC / `run_code` 若主动打印 canonical value，仍可能把完整 sources 带回模型；应在后续 PTC 验收中检视真实输出，不能把 renderer 改动声称为所有调用模式的 Token 优化。摘要中的聚合数字会随观察更新，缺失/部分/异常来源计数仍须保留，不将缺失统计改成 0。

## 验收建议与当前状态

- 用真实 ToolRuntime 执行 start/resume/review/submit/decide/cancel/status：canonical 值仍有完整 ledger，默认模型 content 只含统计摘要。
- status 默认/false 不展开 sources；true 展开完整 sources。归属校验仍由 Manager 执行，跨 DSH 会话不能通过详情参数绕过。
- 对计划、审查、证据、恢复、后台结束标记和工具错误做逐字段对比；渲染不修改原对象，未知/旧记录没有 observedUsage 时保持既有结果。
- 使用同业务数据、多来源 fixture 验证只改变计量展示；单独覆盖 Native 与 PTC 场景，并只报告实际测到的 bytes 或服务端 usage。

当前仅完成研究、固定源码核验和上述字节测量，未实施输出精简，未执行真实模型费用对照。Agent Reach 更新检查：`v1.5.0` 为检查时最新版本。
