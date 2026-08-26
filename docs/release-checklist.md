# Release checklist — dsh-codex-workflow 1.0.6

This is the operator checklist for shipping 1.0.6. It assumes the automated gates
succeeded; this page is about the things automation cannot cover, plus the
rollback story. It never authorizes touching user credentials or configuration
outside `$DSH_HOME/storages/dsh-codex-workflow/`.

## Automated gates (run in CI and locally)

```powershell
pnpm install --frozen-lockfile
pnpm verify          # typecheck + full test suite + build
pnpm doctor:offline  # CI-safe offline doctor (skips only codex/login checks)
pnpm release:check   # verify + offline doctor + pack audit (tgz always cleaned)
```

Run `pnpm release:check` twice in a row and confirm:

- the second run passes identically;
- no `*.tgz`, no `.codex-pack-review`, no temp tarballs remain after either run.

`git diff --check` must be clean.

## Real-environment smoke (operator, with a live Codex login)

1. `pnpm doctor` (full mode) → `DOCTOR_OK`, SQLite journal `delete`, Codex login,
   compatibility CLI syntax, and App Server health confirmed.
2. In a throwaway workspace with a scratch `CODEX_THREAD_ID`:
   - `dsh-codex-workflow sessions --cwd $PWD --json` lists the live session;
   - `dispatch` a plan and `codex_workflow_submit` it exactly once;
   - the source Codex task stays unchanged while a fresh, durably owned
     Reviewer task is started; `show --workflow <id>` reports both ids and
     version `1.0.6`;
   - while the Reviewer turn runs, Codex Desktop legitimately shows “opened in
     another app” (writer-lock); during the turn the task shows NO provisional
     `pass`/`changes_requested` JSON and no sub-agent activity;
   - after the Review verdict settles (pass, changes_requested, terminal error,
     or cancel), the plugin releases the Reviewer thread via `thread/unsubscribe`
     exactly once; the persisted Reviewer remains visible and can be re-opened
     in Desktop within the idle grace period;
   - a re-review resumes the SAME Reviewer task id (never a second Reviewer);
   - `codex_workflow_status` reports `reviewerActive: true` during the turn and
     `false` afterwards; `latestReview` never contains provisional JSON;
   - delay the Reviewer for more than 30 seconds: `codex_workflow_submit`
     returns within 5 seconds, concludes that DSH turn without another model
     step, the DSH session becomes idle, and status remains
     `sending`/`retrying` until the background verdict arrives;
   - abort the originating tool signal after submit returns: the background
     Reviewer continues and the verdict still wakes the same session;
   - force invalid-task/no-verdict/process failures: one durable terminal notice
     is relayed, including across restart, with no duplicate submit steer;
   - the Reviewer inherits no source history and starts even when the source
     task has an active writer;
   - a second review reuses that Reviewer task instead of starting another;
   - while a Reviewer turn runs longer than `idleProcessMs`, its App Server stays alive; after the final verdict, the process exits after the idle grace period and Codex Desktop can open the Reviewer task;
   - after a passing verdict, DSH reports once without invoking `memory` or any other tool and returns to idle; force a hanging terminal relay and confirm it is cancelled once after `terminalRelayTimeoutMs` with its inbox preserved;
   - let a terminal relay reach idle normally, then start a new user turn and confirm the old guard never cancels it; stop the plugin with a guard pending and confirm no late cancellation occurs;
   - a blocking `changes_requested` returns DSH to `fixing`; re-submit works;
   - only non-blocking findings stop at `waiting_review_decision`;
   - a workspace change between submit and verdict produces a VOID relay
     (`void`/`no longer valid`) and stays `executing`, never forges `passed`;
   - re-`submit` after invalidation succeeds (phase gate is consistent).
3. Failure drills (see also the process-level suite in `test/process-fault.test.ts`):
   - kill a DSH process mid-claim, restart → the stale `processing` row is taken
     over and delivered exactly once;
   - two processes racing claims on one DB → disjoint claims, no duplicate;
    - cancel an App Server review turn → only the persisted Reviewer turn is
      interrupted, never the source task or another submission;
    - the legacy codex-callback child that ignores SIGTERM → dispatcher
      SIGKILL-escalates;
   - cancel a workflow, then deliver a late verdict → `cancelled` receipt, DSH
     never wakes up.
4. Ops check:
   - `workflows`, `show --workflow <id>`, `queue --json`, `retry --request <id>`
     (dead-letter→retry, idempotent), `prune --older-than <ms> --commit`
     removes only terminal data (dry-run default).

## Rollback

- The previous stable version `1.0.5` is a normal `pnpm` package; downgrading is
  just reinstalling it. Its legacy file-queue data is still imported by 1.0.6, and the
  import is one-way (the SQLite queue is authoritative once written).
- If 1.0.6 must be pulled: stop the plugin/dispatch traffic first, restore the
  package, and verify with `pnpm doctor` before resuming. Record database and
  log state are not modified by a version change (only by `prune --commit`).

## Do NOT

- Do not push to user `$DSH_HOME` outside `storages/dsh-codex-workflow`.
- Do not modify or rotate any credentials (this plugin never stores them).
- Do not create a Git tag or GitHub Release in this pass — the originating Codex
  review and the user decide on tagging.
- Do not commit or touch `docs/research/` or `docs/superpowers/` (untracked).

## Residual risk register

- **Offline doctor** cannot prove Codex login/model/app-server availability;
  those checks are reported SKIPPED and must be confirmed by a full `pnpm doctor`
  in a real environment.
- **Windows permissions**: on hosts without the needed symlink/ACL rights the
  platform-specific permission scenarios are covered by tests only when the
  platform allows them; the runnable suite is otherwise platform-neutral.
