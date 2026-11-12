# CLI reference

Run commands from the skill directory with Node.js `^22.19.0 || >=24.0.0`. A configured, logged-in Codex CLI is required for model operations; Git is needed only for Git-based evidence. Workflow commands output JSON with `workflowId`, `phase`, `processState`, `continuation`, `nextAction`, `result`, and `artifactPaths`. `nextAction` is a string; `result` contains `plan`, `review`, and `reviewValid`. `continuation` includes `available` and may include `reason`. The doctor command returns its checks in `result`.

Use `--input FILE` to read a JSON file, or `--stdin` to read JSON from standard input. Paths supplied to `--cwd` must be absolute. State defaults to `~/.codex-workflow`; set `CODEX_WORKFLOW_HOME` or pass `--home` to choose another location outside the project workspace. `--codex-command` selects a Codex executable.

| Command | Purpose and JSON input |
| --- | --- |
| `node scripts/workflow.mjs doctor [--offline]` | Check Node and Codex CLI version and capabilities without a model call. `--offline` checks Node only. |
| `node scripts/workflow.mjs start --cwd ABS --input FILE` | Start planning: `{ "task": "..." }`, optionally with `plannerModel`, `reviewerModel`, `plannerEffort`, `reviewerEffort`, `turnTimeoutMs`, `transientRetryBudgetMs`, `maxReviewCycles`, and `maxNoChangeReviewRounds`. |
| `node scripts/workflow.mjs continue --workflow ID --input FILE` | Answer every planner question using its exact ID: `{ "answers": { "questionId": ["answer"] } }`. |
| `node scripts/workflow.mjs review --workflow ID --input FILE` | Submit host work: `{ "implementationSummary": "...", "changedFiles": ["..."], "testResults": "..." }`; only the summary is required. |
| `node scripts/workflow.mjs review-only --cwd ABS --input FILE` | Review existing work using the same summary, optional changed files and test results, an optional `task`, and the same optional model, effort, and limit settings accepted by `start`. |
| `node scripts/workflow.mjs resume --workflow ID` | Resume an eligible interrupted operation. |
| `node scripts/workflow.mjs status --workflow ID [--wait-ms MS]` | Inspect a workflow; `MS` is 0–30000. Alternatively identify it with `--cwd ABS`. |
| `node scripts/workflow.mjs decide --workflow ID --input FILE` | Decide nonblocking review findings after presenting them to the user: `{ "decision": "accept" }` or `{ "decision": "fix", "note": "..." }`. |
| `node scripts/workflow.mjs cancel --workflow ID` | Cancel the workflow. |

The default limits are three review cycles, one unchanged blocking review round, a ten-minute turn timeout, and a twenty-minute transient retry budget measured by a monotonic clock. Model and effort defaults follow the local Codex configuration; explicitly selected values are persisted for resume.

A subsequent `status` rechecks workspace evidence and may report `blocked` with `reviewValid: false` after a prior pass if the workspace changed.
