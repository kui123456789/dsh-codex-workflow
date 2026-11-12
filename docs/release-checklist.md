# Release checklist

This checklist applies to the portable `codex-workflow` skill. Earlier DSH plugin documents and release records are historical.

1. Confirm the intended source state and inspect `git status`; preserve unrelated changes.
2. Run `pnpm build`, `pnpm typecheck`, `pnpm verify`, `pnpm doctor:offline`, `pnpm pack:skill`, and `pnpm release:check`. Use `pnpm verify:isolated` when isolated verification is required. Investigate every failure and retain the actual command output and exit status.
3. Validate the root `SKILL.md` with skill-creator's `quick_validate.py`. Inspect `dist/codex-workflow` and its ZIP for the skill instructions, references, and executable runtime; check that the packaged CLI runs offline without source-only dependencies.
4. Exercise start, clarification, review, status, recovery, and cancellation using the available fixtures. Verify live Codex behavior separately when credentials and the environment are available. Do not treat a fake Codex test as live validation.
5. Record Windows, Linux, and macOS CI results individually. A planned job or missing result is not a pass.
6. Update the changelog and review the final diff. Create commits, tags, publish, or push only with the user's authorization.
