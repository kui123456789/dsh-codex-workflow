# Repository Guidelines

## Scope and structure

This repository builds the portable `codex-workflow` skill. `SKILL.md` is its entry point; `references/` contains the CLI and recovery guidance. TypeScript source lives in `src/`, tests and fake Codex fixtures in `test/`, and build and verification tools in `scripts/`. The generated skill is packaged at `dist/codex-workflow` and `dist/codex-workflow.zip`; do not hand-edit generated output.

Codex planner and reviewer roles are read-only. The host agent implements and tests within the user's authorization. Review-only intent does not authorize fixes. Preserve exact persistent thread IDs, operation ownership, cancellation fencing, and review evidence; never duplicate an operation when its receipt or cleanup is uncertain. Existing DSH databases and configuration are outside this skill's scope. Historical DSH documents remain historical.

## Development and verification

Use Node `^22.19.0 || >=24.0.0` and the pinned pnpm version. Follow existing TypeScript conventions: two-space indentation, semicolons, and double quotes. Run `pnpm build`, `pnpm typecheck`, affected tests, and `pnpm verify`; use `pnpm verify:isolated` when isolated verification is needed. `pnpm doctor:offline` checks local readiness, `pnpm pack:skill` creates the distribution, and `pnpm release:check` runs release checks. Consult `docs/release-checklist.md` before release work. Do not claim platform or live Codex validation without evidence.

Preserve existing changelog history and record user-facing behavior changes in Unreleased. Do not commit, push, tag, or publish unless requested.
