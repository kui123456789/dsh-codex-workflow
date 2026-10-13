# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the DSH plugin, Codex App Server integration, bridge runtime, and browser client (`src/client.js`). Workflow orchestration lives in `src/application/`; persistence and schema code lives in `src/infrastructure/` and `src/state/`. `test/` holds Node test suites and a fake App Server fixture. `scripts/` contains build, compatibility, and release checks. `docs/` holds operational guidance. Generated JavaScript and declarations go to `lib/`; edit `src/`, then rebuild.

## Build, Test, and Development Commands

- `pnpm install` installs pinned development dependencies.
- `pnpm build` compiles TypeScript and copies the browser client to `lib/`.
- `pnpm typecheck` checks types without emitting files.
- `pnpm test` builds and runs `test/*.test.ts` with Node's test runner through `tsx`.
- `pnpm verify` runs type checking and the full test suite.
- `pnpm verify:isolated` runs complete verification in a snapshot outside the checkout, retains evidence, and protects a linked DSH client's build files from verification writes.
- `pnpm host:check` loads the built plugin against the installed DSH host in isolated temporary storage.
- `pnpm host:recovery:check` verifies original-thread continuation through installed DSH services with local fault injection.
- `pnpm release:check` runs verification, an offline doctor check, and a package audit.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, semicolons, and double quotes, matching nearby code. Keep browser code in `src/client.js` compatible with the host's module loader. Name modules by responsibility (`planner-execution.ts`, `workflow-schema.ts`) and tests after the module or behavior they cover (`workflow.test.ts`). Run `pnpm typecheck` before proposing changes. Do not edit generated `lib/` files by hand.

## Testing Guidelines

Use `node:test` and `node:assert/strict`. Add regression tests at the boundary where a failure occurs; the fake App Server in `test/fixtures/` supports protocol and lifecycle cases. The full suite defaults to four independent test processes; set `DSH_WORKFLOW_TEST_CONCURRENCY=2` when memory is limited (allowed: 1–4). Concurrency inside each scenario is unchanged. Run one suite with `pnpm exec tsx --test test/workflow.test.ts`; place test flags before filenames. Run `pnpm verify` before delivery. No numeric coverage threshold is enforced.

## Commit & Pull Request Guidelines

Recent commits use prefixes such as `feat:`, `fix:`, `refactor:`, `docs:`, and `release:` with an imperative summary. Keep commits focused. Pull requests should describe the behavior changed, link the relevant issue or workflow, and include test results. For settings or sidebar changes, include a screenshot or short recording. Document any DSH host compatibility impact.
