# CLI reference

Run commands from the skill directory with Node.js `^22.19.0 || >=24.0.0`. Model operations require a configured, logged-in Codex CLI. Git is needed for Git-based evidence; non-Git review requires an explicit file scope.

Use `node scripts/workflow.mjs help` for the command listing. Standard output is JSON; diagnostics go to stderr. Model operations run asynchronously: preserve the returned workflow ID and poll status for results.

## Input and paths

Use `--input FILE` for a UTF-8 JSON file without BOM, or `--stdin` for JSON from standard input. The root value must be an object. File input avoids shell-specific quoting for long tasks and implementation summaries.

`--cwd` must be an absolute target project directory. An input file path is relative to the command's working directory unless absolute; `changedFiles` paths are resolved inside the target project. State defaults to `~/.codex-workflow`; `CODEX_WORKFLOW_HOME` or `--home` selects another location outside the target project.

`--codex-command` selects the executable for `doctor`, `start`, or `review-only`. A workflow records its executable, argument prefix, and explicit role options for later continuation. `CODEX_WORKFLOW_CODEX_ARGS` accepts an optional JSON array of executable-prefix arguments, for example when the configured executable launches a wrapper.

## Commands

`ABS`, `FILE`, and `ID` below are placeholders for the actual absolute project path, input file, and returned workflow ID.

| Command | Purpose and JSON input |
| --- | --- |
| `node scripts/workflow.mjs doctor [--offline]` | Check Node and Codex CLI version and capabilities without a model call. `--offline` checks Node only. |
| `node scripts/workflow.mjs start --cwd ABS --input FILE` | Start planning with a required `task` and optional settings described below. |
| `node scripts/workflow.mjs continue --workflow ID --input FILE` | Submit `answers`, keyed by the exact Planner question IDs, with an array of answer strings for each question. |
| `node scripts/workflow.mjs review --workflow ID --input FILE` | Submit `implementationSummary`, optional `changedFiles`, and optional `testResults`. |
| `node scripts/workflow.mjs review-only --cwd ABS --input FILE` | Review existing work using the same summary, optional changed files and test results, an optional `task`, and the same optional model, effort, and limit settings accepted by `start`. |
| `node scripts/workflow.mjs resume --workflow ID` | Resume an eligible interrupted operation. |
| `node scripts/workflow.mjs status --workflow ID [--wait-ms MS]` | Inspect a workflow; `MS` is 0–30000. Alternatively identify it with `--cwd ABS`. |
| `node scripts/workflow.mjs decide --workflow ID --input FILE` | Submit the user's choice on nonblocking findings: `{ "decision": "accept" }` or `{ "decision": "fix" }`, with an optional `note`. |
| `node scripts/workflow.mjs cancel --workflow ID` | Cancel the workflow. |

Use `--workflow` for an existing workflow. `status` also accepts `--cwd`; supply one selector, not both.

## JSON examples and settings

A planning input file:

```json
{
  "task": "Add a health check command and verify its behavior."
}
```

If the Planner returns a question whose ID is `scope`, a continuation input can be:

```json
{
  "answers": {
    "scope": ["Limit the change to the requested command."]
  }
}
```

Submit every returned question ID with the user's actual answer. A review input file can be:

```json
{
  "implementationSummary": "Describe the implementation actually completed.",
  "changedFiles": ["src/health.ts"],
  "testResults": "Describe the checks actually run and their results."
}
```

Only `implementationSummary` is required for review input, but a non-Git workspace needs explicit existing files to establish sufficient evidence. Replace example file paths and text with the actual scope and results. `review-only` accepts this shape plus an optional `task` and the settings accepted by `start`.

Optional settings are `plannerModel`, `reviewerModel`, `plannerEffort`, `reviewerEffort`, `turnTimeoutMs`, `transientRetryBudgetMs`, `maxReviewCycles`, and `maxNoChangeReviewRounds`. Defaults are three review cycles, one unchanged blocking review round, a ten-minute turn timeout, and a twenty-minute transient retry budget measured by a monotonic clock. Model and effort defaults follow the local Codex configuration. Explicit values are persisted for resume; omitted options do not identify the actual model used by Codex.

## Results

Doctor and workflow operations use the following envelope. `help` returns a separate command listing.

| Field | Meaning |
| --- | --- |
| `workflowId` | Workflow identity; null for doctor or command errors |
| `phase` | Business stage, such as `waiting_input`, `fixing`, `passed`, or `blocked` |
| `processState` | Operation state: `running`, `waiting`, `completed`, `failed`, or `cancelled` |
| `continuation` | `available` is a boolean; `reason` explains eligibility or why continuation is refused |
| `nextAction` | Host action as a string; follow it with the user's authorization |
| `result` | Workflow `plan`, `review`, and `reviewValid`; doctor returns checks instead |
| `artifactPaths` | Workflow directory and, when present, operation directory |

A submitted operation is not a completed model result. A populated review or `reviewValid: true` alone does not establish passage: inspect `phase` and `nextAction`. Command errors return JSON with `phase: "error"` and a nonzero exit code.

A subsequent `status` rechecks workspace evidence and may report `blocked` with `reviewValid: false` after a prior pass if the workspace changed.

Status refreshes are bounded. If concurrent updates exhaust that budget, the response uses the latest stored phase and temporarily disables continuation with `reason: "state_changed"` (or `"running"` for a running operation). Query `status` again before resuming; a stale snapshot never authorizes another model call.
