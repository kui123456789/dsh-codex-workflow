# codex-workflow

A portable skill that coordinates read-only Codex planning and review while the host agent implements and tests. It also supports review-only requests. The skill runs through a local Node CLI and has no DSH runtime or browser UI dependency.

## Requirements

- Node.js `^22.19.0 || >=24.0.0`.
- A configured, logged-in Codex CLI for model operations. Git is needed for Git-based review evidence.
- pnpm for building and testing from source; a packaged skill runs with Node.

## Build and package

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm verify
pnpm doctor:offline
pnpm pack:skill
```

The portable skill is produced at `dist/codex-workflow` and `dist/codex-workflow.zip`. Install or copy the folder into a skill location supported by the host, then invoke `$codex-workflow` or request a matching planning/review workflow. A compatible host needs to load `SKILL.md` and execute Node. Output language follows the user's task.

The source entry point is `SKILL.md`; [CLI details](references/cli.md) and [recovery and evidence](references/recovery.md) describe direct usage. For example, from the skill folder:

```sh
node scripts/workflow.mjs doctor
node scripts/workflow.mjs start --cwd /absolute/project/path --input task.json
node scripts/workflow.mjs status --cwd /absolute/project/path --wait-ms 30000
```

`task.json` contains `{ "task": "Describe the requested work" }`. Use an actual project path and input file. The host agent follows the returned `nextAction`, implements only authorized work, and supplies a summary and test results for review. A review-only request does not itself authorize changes.

Workflow state defaults to `~/.codex-workflow`; `CODEX_WORKFLOW_HOME` or `--home` overrides it with a location outside the project workspace. Operations use background workers and persistent Codex thread IDs. There is no network listener or daemon. Existing DSH databases and configuration are not migrated or modified by this skill.

## Verification and releases

Run `pnpm verify`, `pnpm doctor:offline`, `pnpm pack:skill`, and `pnpm release:check` as applicable. `pnpm verify:isolated` provides isolated verification. See [release checklist](docs/release-checklist.md). The Windows, Linux, and macOS CI matrix is configured; no cross-platform pass is claimed until actual results are available. Record evidence for each real provider run. Earlier DSH documentation and changelog entries describe the historical plugin and are not documentation of this skill.
