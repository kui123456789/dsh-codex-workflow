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

Restart DSH after installation. The bundle registers five model-facing tools:

- `codex_workflow_start`
- `codex_workflow_continue`
- `codex_workflow_review`
- `codex_workflow_status`
- `codex_workflow_cancel`

In a DSH conversation, ask:

```text
让 Codex 先规划这个改动，我来执行，完成后再让 Codex 审查。
```

The DSH agent calls `codex_workflow_start`, implements the returned plan in the same session, and must call `codex_workflow_review` before completing. If Codex requests clarification, answer in DSH and continue with `codex_workflow_continue`.

## Configuration

The bundle defaults are defined in `cordis.patch.yml`:

- `codexCommand`: `codex`
- `plannerModel` / `reviewerModel`: empty means the current Codex default
- `plannerEffort` / `reviewerEffort`: `high`
- `maxReviewCycles`: `3`
- `turnTimeoutMs`: `600000`
- `idleProcessMs`: `900000`

Workflow records are stored under `$DSH_HOME/storages/dsh-codex-workflow/` or `~/.dsh/storages/dsh-codex-workflow/`. They contain task text, plan, thread IDs, review findings, and status; they never contain login tokens.

## Recovery

Planner and reviewer thread IDs are persisted. After a DSH restart, the next continuation or review resumes the Codex thread with `thread/resume`. A planner question that was pending during a process crash is continued as a new turn with the user's answers because the original JSON-RPC request ID is process-local.

## License

MIT
