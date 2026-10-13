# 审查结果的证据版本与异步新鲜性核验

核验日期：2026-10-05。通过已读 Agent Reach 的 GitHub / `gh` 后端，按固定提交读取三个项目的原始源码及许可。本轮关注结果关联哪个输入版本，以及异步结果返回后的接纳条件；只借鉴机制，没有复制源码、引入依赖、运行上游测试或执行实际 review/merge/模型调用。

核心建议是把审查结果绑定实际输入证据，在模型返回后重新核验证据及结果资格，再决定是否接纳。SQLite 的 storeHash/CAS 约束记录更新，不能锁住 live FS；重新取证只能证明检查时观察到的文件状态。

## 固定来源与许可

| 项目 | 固定提交 | 许可 | 本次选取的机制 |
|---|---|---|---|
| microsoft/vscode-languageserver-node | `2d1773893617b1b9d585d5ba527578b196433839` | [MIT](https://github.com/microsoft/vscode-languageserver-node/blob/2d1773893617b1b9d585d5ba527578b196433839/License.txt) | 异步诊断返回后重读请求状态，明确过期时丢弃 |
| rust-lang/rust-analyzer | `667b817189625f373f0e29e4cc12dee18eed07e6` | [MIT](https://github.com/rust-lang/rust-analyzer/blob/667b817189625f373f0e29e4cc12dee18eed07e6/LICENSE-MIT) 或 [Apache-2.0](https://github.com/rust-lang/rust-analyzer/blob/667b817189625f373f0e29e4cc12dee18eed07e6/LICENSE-APACHE) | Cargo/check 诊断拒绝晚到的旧 generation |
| cli/cli | `6fc1c29d5477bfe71da7af290eb481c0df7811f1` | [MIT](https://github.com/cli/cli/blob/6fc1c29d5477bfe71da7af290eb481c0df7811f1/LICENSE) | 直接 merge 请求显式携带 expected head SHA |

许可由固定提交文件核验；rust-analyzer 的 [Cargo.toml L9](https://github.com/rust-lang/rust-analyzer/blob/667b817189625f373f0e29e4cc12dee18eed07e6/Cargo.toml#L9) 明确写为 MIT OR Apache-2.0。以下 permalink 不依赖移动分支。

## LSP：保存版本，返回后重新检查结果资格

**证据。** [diagnostic.ts L391-L402](https://github.com/microsoft/vscode-languageserver-node/blob/2d1773893617b1b9d585d5ba527578b196433839/client/src/common/diagnostic.ts#L391-L402) 在请求开始时登记 document version、请求状态和 token，再等待 provider 的诊断结果。[L413-L426](https://github.com/microsoft/vscode-languageserver-node/blob/2d1773893617b1b9d585d5ba527578b196433839/client/src/common/diagnostic.ts#L413-L426) 在 await 返回后重新读取请求状态，检查文档可见性，明确 outDated 时直接 return，随后才可能写入 diagnostics。[L481-L488](https://github.com/microsoft/vscode-languageserver-node/blob/2d1773893617b1b9d585d5ba527578b196433839/client/src/common/diagnostic.ts#L481-L488) 展示将在途请求标为 outDated 并清除其资格的路径。

**发现与本项目建议。** 请求开始时证据合法，不能证明结果返回时仍合法。Reviewer 应携带当次输入证据版本，返回后重新核验当前证据及接纳状态，再更新判定。空 findings 或成功响应也走相同检查，不以“没有发现问题”跳过证据新鲜性验证。

**边界。** 这个客户端不是对每次文档 version 变化都立即硬丢弃：其 [reschedule 分支 L429-L443](https://github.com/microsoft/vscode-languageserver-node/blob/2d1773893617b1b9d585d5ba527578b196433839/client/src/common/diagnostic.ts#L429-L443) 可能先展示返回结果，再请求新结果。本轮借鉴的是显式过期状态和 await 后检查；不将其整体策略宣传为本项目已有的严格文件 hash gate，也不把 resultId 当作当前文件版本证明。

## rust-analyzer：旧检查消息不能覆盖已接受的新 generation

**证据。** [main_loop.rs L1212-L1234](https://github.com/rust-lang/rust-analyzer/blob/667b817189625f373f0e29e4cc12dee18eed07e6/crates/rust-analyzer/src/main_loop.rs#L1212-L1234) 从 FlycheckMessage::AddDiagnostic 取出 generation，并随诊断送入对应 package 的结果集合。[diagnostics.rs L168-L176](https://github.com/rust-lang/rust-analyzer/blob/667b817189625f373f0e29e4cc12dee18eed07e6/crates/rust-analyzer/src/diagnostics.rs#L168-L176) 检查已接受的 package generation，incoming 旧于它时直接 return。

**发现与本项目建议。** 异步结果完成顺序不代表业务先后顺序。审查执行和返回值需要关联本次输入版本及执行代次；新的结果已经被接纳时，迟到的旧结果不能覆盖当前判定或推进当前业务状态。

**边界。** 本例只引用 Cargo/check 的严格丢弃路径。native syntax/semantic 诊断在 [L201-L230](https://github.com/rust-lang/rust-analyzer/blob/667b817189625f373f0e29e4cc12dee18eed07e6/crates/rust-analyzer/src/diagnostics.rs#L201-L230) 另有合并逻辑，不能一并宣称为相同 gate。generation 是检查执行顺序，不是文件内容 hash；拒绝旧 generation 也不能证明输入在整个执行期间没有变化。

## GitHub CLI：最终操作传递明确的预期 head

**证据。** [merge.go L184](https://github.com/cli/cli/blob/6fc1c29d5477bfe71da7af290eb481c0df7811f1/pkg/cmd/pr/merge/merge.go#L184) 将 match-head-commit 定义为允许 merge 的预期 head SHA。[L286-L294](https://github.com/cli/cli/blob/6fc1c29d5477bfe71da7af290eb481c0df7811f1/pkg/cmd/pr/merge/merge.go#L286-L294) 把指定值写入 payload。[http.go L77-L79](https://github.com/cli/cli/blob/6fc1c29d5477bfe71da7af290eb481c0df7811f1/pkg/cmd/pr/merge/http.go#L77-L79) 将非空预期值编码为 ExpectedHeadOid，用于 [L98-L103](https://github.com/cli/cli/blob/6fc1c29d5477bfe71da7af290eb481c0df7811f1/pkg/cmd/pr/merge/http.go#L98-L103) 的直接 mergePullRequest mutation。

**发现与本项目建议。** 最终接纳点应明确知道“此结果针对哪个输入版本”。本项目可以将原审查证据 fingerprint 与结果绑定，并在写入当前结果之前检查期望记录版本及重新读取的证据；只依赖 workflow ID 或回合身份不足以判断内容新鲜。

**边界。** 本次核验客户端编码，没有执行服务端 mutation；案例范围是显式 expected head 的直接 merge 请求。普通 gh pr review 的 [入口 L148-L153](https://github.com/cli/cli/blob/6fc1c29d5477bfe71da7af290eb481c0df7811f1/pkg/cmd/pr/review/review.go#L148-L153) 只查询 id/number，不能使用上述 merge 源码证明普通 review 发布已有相同 freshness 检查。Git HEAD SHA 也不包含未提交工作区变化，不能替代本项目实际使用的 diff/file hashes。

## 本项目的最小采用路径与保证范围

| 需要区分的事实 | 可借鉴的处理 | 保证范围 |
|---|---|---|
| 模型实际输入的证据版本 | 将 scope、diff、file hashes/fingerprint 与该结果关联 | 可说明结果针对哪份已采集证据 |
| 异步返回时的证据资格 | 重新取证，变化时拒绝把旧判定标为当前有效 | 检查时观察到的证据一致性 |
| 迟到执行覆盖新结果 | 最终记录更新检查对应执行和期望记录版本 | workflow 记录内的并发接纳顺序 |
| 检查之后仍可修改的文件 | 保留结果输入版本和检查范围说明 | 不宣称实时文件锁或整个执行期间的不可变快照 |

SQLite CAS/storeHash 只约束数据库记录；数据库事务并不拥有工作区文件的修改权。即使记录 CAS 成功，live FS 仍可随后改变。一次重新取证与 hash 比较也不能证明模型运行全过程读取了同一不可变文件集合。本轮不增加文件锁、框架或外部服务，不声称已经获得跨数据库与文件系统的原子接纳保证。

建议本仓库回归覆盖：模型等待中修改输入文件；新结果先返回、旧结果晚到；旧结果为空 findings；记录版本变化和文件证据变化分别处理。具体实现、红绿与最终门禁由主任务另行记录，第三方源码不是本仓库完成证明。研究结束时 Agent Reach 更新检查为 v1.5.0 最新；写本文档时未再次联网，不推算 Token 或费用。
