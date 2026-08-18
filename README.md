# dsh-codex-workflow

DeepSeek Harness plugin that gives Codex read-only planning/review roles while DSH remains the sole executor. Two flows share the same workflow engine:

- **Codex-led bridge (preferred)** — the Codex task that produced the plan sends it to the exact live DSH session through a durable filesystem bridge; DSH implements it, submits results back to the *same* Codex task id, and Codex's verdict returns to the original DSH session for repair or sign-off.
- **DSH-led tools (legacy, still supported)** — the DSH agent drives `codex_workflow_start` / `codex_workflow_review` as before.

No browser is opened or controlled anywhere in the product path; no network listener, MCP, hooks, or skills are involved. Browser clicking is a development-only workaround and is not part of the plugin.

## Requirements

- DeepSeek Harness `0.1.0-rc.6`
- Node.js `^22.19.0` or `>=24`
- Codex CLI with a valid ChatGPT login (`codex exec resume <id> -` supported, verified by `pnpm doctor`)

## Build and verify

```powershell
pnpm install
pnpm verify
pnpm doctor
```

## Codex-led flow (preferred)

From the Codex task that owns the plan, dispatch it to the live DSH session:

```powershell
# 1. Find the live DSH session for this workspace
dsh-codex-workflow sessions --cwd $PWD --json

# 2. Dispatch the plan (payload enters through stdin, never arguments)
$payload = '{"task":"实现搜索功能","planMarkdown":"<proposed_plan>…</proposed_plan>","assumptions":[]}'
$payload | dsh-codex-workflow dispatch --cwd $PWD --codex-thread $env:CODEX_THREAD_ID --stdin
```

The bridge resolves the exact session (explicit `--dsh-session` wins; otherwise the cwd must match exactly one live session, and ambiguity fails loudly). DSH receives the plan as a plugin relay message and implements it. When done, DSH calls `codex_workflow_submit`; the plugin resumes the **exact stored Codex task id** with a read-only review prompt:

```text
codex exec --json --output-schema <schema> -C <cwd> --sandbox read-only -c approval_policy=never resume <codexThreadId> -
```

### How the verdict comes back (automatic path)

The reviewer stays read-only and answers **as its final message**: a structured JSON verdict matching the enforced output schema. The DSH plugin process (outside the Codex sandbox) captures that final message from the bounded stdout stream, validates it, durably stages it in the workflow record, and enqueues it as a `submit_verdict` bridge command with a deterministic per-submission request id. The bridge runtime then applies the verdict and relays the outcome to the original DSH session. The reviewer never writes the bridge queue itself and never invokes the CLI.

`dsh-codex-workflow respond` is a **manual/compat fallback only** — for operators who want to type a verdict in by hand instead of letting the automatic path collect it, or to re-drive a verdict after the automatic pipeline was interrupted:

```powershell
$verdict = '{"verdict":"pass","findings":[],"testGaps":[],"summary":"ok"}'
$verdict | dsh-codex-workflow respond --workflow <workflowId> --codex-thread $env:CODEX_THREAD_ID --submission <submissionId> --stdin
dsh-codex-workflow status --request <requestId> --json
```

`--submission <uuid>` (optional in `respond`) pins the verdict to the exact submission the review answered; without it the legacy behavior applies only when the workflow has no active submission. Every `respond` is validated, idempotent per request id, and replayed safely — it never bypasses the evidence-fingerprint check (a verdict whose workspace changed since review is refused).

The verdict is applied in the original DSH session with the same blocking/non-blocking/no-change/max-cycle policy as the DSH-led flow: blocking findings return DSH to `fixing` (then re-`submit`), only non-blocking findings stop at `waiting_review_decision` for the user, and `pass` completes the workflow. If the workspace changed between submission and verdict, the verdict is refused and DSH is asked to re-`submit` for a fresh review — an old verdict can never pass changed code.

### CODEX_THREAD_ID

The bridge never invents a thread id. `dispatch`/`respond` default `--codex-thread` from `CODEX_THREAD_ID` and fail with a paste-ready explanation when it is absent. The callback always resumes the persisted id; a replacement thread is a test failure.

## DSH-led flow (legacy, compatible)

In a DSH conversation:

```text
让 Codex 先规划这个改动，我来执行，完成后再让 Codex 审查。
```

Tools: `codex_workflow_start`, `codex_workflow_continue`, `codex_workflow_review`, `codex_workflow_review_only`, `codex_workflow_submit`, `codex_workflow_decide`, `codex_workflow_status`, `codex_workflow_cancel`.

## State machine

```
planning -> waiting_input -> executing -> reviewing -> fixing -> passed
executing/fixing -> codex_workflow_submit -> queued -> sending -> retrying -> verdict_ready -> received -> applied -> delivered
                                                             `-> failed (attempts exhausted, invalid thread, no verdict)
verdict_ready: verdict staged in the record; enqueue pending (crash-recoverable)
received:      verdict command queued for application
applied:       outcome persisted (pass | fixing | waiting_review_decision | blocked | refused-if-changed)
delivered:     outcome relayed to the original DSH session
cancelled: terminal — no queue retry, no late verdict, no message may resurrect it
```

`cancelled` is terminal under the bridge too: queued callbacks stop retrying, late verdicts receive an idempotent `cancelled` receipt and never wake DSH, and duplicate queue files or restarts cannot duplicate turns.

## Failure recovery

- All multi-step coordination state (leases, the bridge queue, workflow records) lives in one SQLite database per storage directory (`coord.sqlite`), shared by every DSH process and the CLI. Every invariant runs in a single `BEGIN IMMEDIATE` transaction; a killed process at ANY point rolls back cleanly and `PRAGMA integrity_check` stays clean.
- **Journal mode is rollback journal (DELETE), deliberately NOT WAL.** SQLite versions <= 3.51.2 (the runtime bundled with Node 24.14.0) have a WAL-reset bug (fixed 2026-03-13, released as 3.51.3) that can corrupt the WAL under the concurrent writers/checkpoints this plugin creates. `synchronous=FULL` + a busy timeout keep the rollback journal safe for multiple connections. `pnpm doctor` reports the runtime SQLite version, the actual `journal_mode` and runs an integrity check; the coordination database is refused on UNC/network paths.
- Fencing is by a MONOTONIC claim generation plus a random owner token: every ack/retry/dead-letter/renew is a conditional UPDATE on `status='processing' AND claim_epoch=? AND claim_owner=?`. The epoch is NEVER reset (release only clears owner/until), so a stale owner can never re-match a newer claim, and an owner that lost its lease kills its own callback child and stops writing state.
- Powers and deliveries are fenced and re-validated at every step:
  - **session-scoped leases** make workflow creation (and submission creation) atomic across processes — two overlapping DSH processes dispatching/submitting for the same session/request produce exactly one workflow/submission.
  - **verdicts are staged durably** (full command, identical requestId/createdAt/commandHash) and the first apply only moves `received -> applied`; conflicting request ids are always rejected; the staged identity survives until applied.
  - **delivery is prepare -> relay -> commit**: the workspace fingerprint is recomputed before the relay, and `delivered` is written (in a fenced CAS) only after the relay lands. Invalidated passes are reported as void, never as passed; a cancel or new submission that wins before commit never gets marked delivered.
- Dispatch delivery is exactly-once under crash replay: `bridgeRequestId` prevents duplicate workflows and the deterministic relay message id (persisted in the session's `agent/inbox/spliced` events) prevents duplicate followups.
- A missing live session retries forever with capped backoff (never a dead letter) for verdicts, and the fingerprint re-check runs on every retry so a stale pass is invalidated even after a long offline stretch.
- Busy/rate-limited Codex threads retry (`retrying`) up to `callbackMaxAttempts`, then `submissionState: "failed"` without losing the DSH workflow. Invalid thread ids are terminal.
- Interrupted or killed callbacks wait for the child to be CONFIRMED exited before a retry can overlap the same thread; the DSH workflow and its evidence always remain visible via `codex_workflow_status`.

## Storage

Workflow records, leases and the bridge queue live in `$DSH_HOME/storages/dsh-codex-workflow/coord.sqlite` plus `bridge/sessions.json` (the CLI-visible session registry) and `bridge/review-schema.json`. Records never contain login tokens. Legacy file-queue data from earlier versions is imported once on init (receipts, retry semantics and attempts preserved), and old JSON workflow records are imported lazily. Old records load with `origin: "dsh"` and keep their behavior.

## Configuration

Defaults in `cordis.patch.yml`:

- `codexCommand`: `codex`
- `plannerModel` / `reviewerModel`: empty means the current Codex default
- `plannerEffort` / `reviewerEffort`: `high`
- `maxReviewCycles`: `3` (1–10)
- `maxNoChangeReviewRounds`: `1` (1–10)
- `reviewDiffMaxBytes`: `65536` (1 KiB–1 MiB)
- `bridgePollMs`: `1000` (200 ms–60 s)
- `bridgeMaxPayloadBytes`: `1048576` (64 KiB–16 MiB)
- `callbackTimeoutMs`: `600000` (10 s–30 min)
- `callbackMaxAttempts`: `3` (1–10)
- `callbackRetryBaseMs`: `2000` (200 ms–5 min)
- `turnTimeoutMs`: `600000`
- `idleProcessMs`: `900000`

Workflow records and the bridge queue live under `$DSH_HOME/storages/dsh-codex-workflow/` (`bridge/{inbox,processing,retry,receipts,dead-letter}`, `sessions.json`). Records never contain login tokens. Old records load with `origin: "dsh"` and keep their behavior.

## License

MIT