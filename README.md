# dsh-codex-workflow

DeepSeek Harness plugin that gives Codex two read-only roles while DSH remains the sole executor:

1. Codex Planner inspects the current workspace and returns an implementation plan.
2. The original DSH session implements the plan with its normal tools and approvals.
3. A detached Codex Reviewer inspects the implementation.
4. DSH fixes review findings and resubmits, up to three review cycles by default.

The plugin runs `codex app-server --stdio` directly. It opens no network listener, does not read or copy credentials, and does not modify Codex configuration.

Planner and Reviewer tasks inherit the originating DSH session's working directory and runtime workspace root, so Codex Desktop groups them with the same project instead of under an unrelated recent workspace.

## Requirements

- DeepSeek Harness `0.1.0-rc.6`
- Node.js `^22.19.0` or `>=24`
- Codex CLI with a valid ChatGPT login

## Build and verify

```powershell
pnpm install
pnpm verify
pnpm doctor
```

## Install

```powershell
pnpm build
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Profile web
```

Restart DSH after installation. The bundle registers seven model-facing tools:

- `codex_workflow_start`
- `codex_workflow_continue`
- `codex_workflow_review`
- `codex_workflow_review_only`
- `codex_workflow_decide`
- `codex_workflow_status`
- `codex_workflow_cancel`

In a DSH conversation, ask:

```text
让 Codex 先规划这个改动，我来执行，完成后再让 Codex 审查。
```

The DSH agent calls `codex_workflow_start`, implements the returned plan in the same session, and must call `codex_workflow_review` before completing. If Codex requests clarification, answer in DSH and continue with `codex_workflow_continue`.

## Review pipeline

Every review (normal or review-only) captures **auditable evidence** of the workspace before the reviewer runs. The returned workflow JSON exposes `latestReviewEvidence`:

- **Git workspaces**: `git status --porcelain=v1` (with `--untracked-files=all`, so files inside untracked directories are observed individually) plus the full `git diff HEAD`, streamed so large diffs never fill memory. The returned `diff` text is capped at `reviewDiffMaxBytes` (UTF-8-safe truncation sets `diffTruncated`), while `fingerprint` is a SHA-256 over the status and the *complete* diff — staged, unstaged, deleted, renamed and untracked changes all move it.
- **Non-git workspaces**: files listed in `changedFiles` are hashed; the boundary is enforced on the canonical (`realpath`) workspace so symlinks escaping it are rejected in `rejectedPaths`, missing files are recorded, and evidence is marked `insufficient` (which disables no-change detection) unless at least one in-workspace regular file was actually hashed.

### Verdict gate

After normalization, the Reviewer must mark every finding `blocking: true|false`:

- `critical` / `high` findings block by default; `medium` / `low` findings block only when they create an actual correctness, regression, security, or delivery-required test gap; every `testGaps` entry counts as blocking.
- A `pass` verdict carrying findings or test gaps is treated as `changes_requested` (the blocking gate applies) so contradictory model output can never ship with known problems; a `changes_requested` verdict with nothing actionable fails the workflow.
- `pass` (no actionable findings) ends the workflow in `passed`.
- `changes_requested` with **blocking** findings enters the automatic repair loop (`fixing`): DSH fixes everything, reruns tests, and calls `codex_workflow_review` again.
- `changes_requested` with **only non-blocking** findings stops at `waiting_review_decision`: DSH presents the improvements to the user and calls `codex_workflow_decide` with `accept` (ship as-is, findings recorded as deliberately unfixed) or `fix` (repair first, then re-review). The `agent/turn-stopping` guard does not steer while a decision is pending.

### No-change termination

Before each review the plugin compares the evidence fingerprint with the previous round. Consecutive identical fingerprints increment `noChangeReviewRounds`; a change resets it. If the Reviewer keeps returning blocking `changes_requested` while the workspace provably did not change for `maxNoChangeReviewRounds` rounds, the workflow is blocked with a clear error instead of burning another fix cycle. `pass` and non-blocking-only outcomes are never blocked, and `maxReviewCycles` still applies as a second, counter-based limit.

## Review-only usage

`codex_workflow_review_only` reviews the current workspace without running the Planner:

```text
使用 codex_workflow_review_only 审查当前未提交改动，implementationSummary 写“已实现 X”，在 git 仓库中默认审查未提交改动。
```

- Binds to the current DSH session and workspace like `codex_workflow_start`.
- Never runs the Planner: a fresh read-only source thread hosts the first detached Reviewer.
- Git workspaces are reviewed through `uncommittedChanges`; non-git workspaces **must** pass `changedFiles` — the call is rejected otherwise, since there is nothing verifiable for the reviewer to look at.
- One DSH session still owns only one active workflow at a time (the `planned` and `review_only` modes share evidence, the verdict gate, no-change detection, cycle limits and cancellation).
- After the first round, continue with the existing `codex_workflow_review` on the same workflow id; the Reviewer thread is reused.

## Configuration

The bundle defaults are defined in `cordis.patch.yml`:

- `codexCommand`: `codex`
- `plannerModel` / `reviewerModel`: empty means the current Codex default
- `plannerEffort` / `reviewerEffort`: `high`
- `maxReviewCycles`: `3` (1–10)
- `maxNoChangeReviewRounds`: `1` (1–10) — consecutive same-fingerprint blocking reviews before `blocked`
- `reviewDiffMaxBytes`: `65536` (1 KiB–1 MiB) — returned diff text cap
- `turnTimeoutMs`: `600000`
- `idleProcessMs`: `900000`

Workflow records are stored under `$DSH_HOME/storages/dsh-codex-workflow/` or `~/.dsh/storages/dsh-codex-workflow/`. They contain task text, plan, thread IDs, review findings, evidence, decisions, and status; they never contain login tokens. Records written before the verdict gate are upgraded on load: `mode` defaults to `planned`, `noChangeReviewRounds` to `0`, and findings without `blocking` derive it from severity (`critical`/`high` = blocking).

## Recovery

All workflow mutations run through a per-workflow serialized atomic update, and every turn (planner, raw review, normalize) is registered with its thread/turn IDs in an `onStarted` callback the moment it starts — before the plugin waits for it to finish. If that registration (or the reviewer thread settings update) fails, the already-running turn is interrupted before the error propagates, so no turn is ever left unmanaged. `codex_workflow_cancel` therefore interrupts the currently running turn, and `cancelled` is a terminal state: once written, every later write (a late `onStarted`, a completing review, an error path) is suppressed and can never resurrect the record, and a review that settles after cancellation never injects outcome messages. After a DSH restart, the next continuation or review resumes the Codex thread with `thread/resume`. A planner question that was pending during a process crash is continued as a new turn with the user's answers because the original JSON-RPC request ID is process-local.

## License

MIT