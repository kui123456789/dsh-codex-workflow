# DSH 0.1.5 compatibility — 2026-09-13

Follow-up: the user subsequently started the formal profile. See
[the live validation report](live-validation-2026-09-13.md): loading, planning
and DSH execution passed, but the system Codex CLI rejected the configured
Reviewer model as requiring a newer CLI. A subsequent authorized update to
CLI 0.154.0 resolved that model error and passed the live bridge flow; see
[the CLI update report](cli-update-2026-09-13.md). The separate review-only
empty-task handoff was subsequently fixed in 1.0.14; see
[the repair validation](review-only-fix-2026-09-14.md).

Local plugin build: **1.0.13**. Installed DSH CLI and core APIs checked:
**0.1.5-rc.1**, Cordis **4.0.2**, Node **24.14.0**.

## Findings and changes

The user reported that the plugin could not load after upgrading DSH. The
linked source installation still resolved the older `0.1.0-rc.6` core packages.
An isolated import and tool-registration probe succeeded, so the exact formal
profile error was not captured and is not attributed solely to the version gap.
The following compatibility failures were reproduced and fixed:

1. Typechecking against the installed host failed on removed `Session.events`
   and the removed `dsh-tools` export `JsonValue`. History reads now use
   `Session.snapshotEvents()`; the type comes from `dsh-util-values`.
2. Dispatch tests with the current session API timed out without delivering the
   plan. The fixed suite uses real DSH Session objects and confirms delivery,
   verdict routing, and deduplication after a crash between relay and commit.
3. Awaiting Cordis plugin activation returned before asynchronous initialization
   had registered `codex_workflow_start`. The plugin now awaits its initialization
   effect. Tests confirm all eight tools exist at activation, disappear at unload,
   and initialization failures are returned to the host.

Host peer requirements now start at DSH `0.1.5-rc.1` and Cordis `4.0.2`.
Development peers and the lockfile were updated together; no `0.1.0-rc.*`
DSH packages remain in the lockfile. This release does not support older hosts.
No SQLite or workflow-record migration was introduced.

## Verification

- `pnpm install --frozen-lockfile --strict-peer-dependencies`: passed.
- `pnpm release:check`: passed twice; final run **379 tests passed, 0 failed**,
  with typecheck, build, offline doctor and package allowlist checks passing.
  Offline doctor explicitly skipped its five Codex-dependent checks.
- `pnpm host:check`: loaded the built plugin using the installed host's actual
  Cordis, SystemPrompt and ToolRuntime packages; reported host `0.1.5-rc.1`,
  plugin `1.0.13`, eight registered tools and successful unload. This probe uses
  temporary storage and an empty agent registry, without calling a model.
- `git diff --check`: passed.
- The existing web-profile junction resolves to this project, and its built
  `lib/version.js` reports `1.0.13`.

The formal DSH profile was not restarted. Its real UI and a paid/model-backed
Planner–Reviewer round were not exercised. The separately running browser-workflow
acceptance process was left untouched. The next operator-controlled profile
restart will load the updated linked build; it still needs formal UI confirmation.

## Backup and rollback

The original package manifest, lockfile, source, compiled output, tests and main
documentation were backed up before edits to:

`C:\Users\Z1803\AppData\Local\Temp\dsh-codex-workflow-pre-compat-20260913-191941`

This is a temporary-directory backup. The committed Git baseline is `0be09fd`.
Restoring only the old plugin on the new DSH host is not a compatibility fix;
roll back matching host/plugin versions together if needed. User configuration,
credentials, workflow storage and audit records were not modified by the probes.
