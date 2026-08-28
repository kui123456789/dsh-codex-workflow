# Release checklist — dsh-codex-workflow 1.0.10

This is the operator checklist for shipping 1.0.10. It assumes the automated gates
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
2. In the formal DSH profile, verify the model-facing trigger policy:
   - with `autoTriggerMode: complex`, send a cross-file implementation task;
     DSH first announces the Codex planning decision and calls
     `codex_workflow_start` before any write/edit/state-changing command;
   - send an obvious low-risk single-file edit and confirm it does not
     auto-trigger;
   - send a complex task with an explicit “直接做，不使用 Codex” override and
     confirm it does not auto-trigger;
   - temporarily test `always` (the simple write-intent task triggers) and `off`
     (nothing auto-triggers, while an explicit Planner request still works),
     then restore `complex`;
   - while one workflow is active, send another qualifying request and confirm
     no second WorkflowRecord or Planner task is created.
3. In a throwaway workspace with a scratch `CODEX_THREAD_ID`:
   - run `pnpm lifecycle:accept`; it uses low reasoning and a 600-second turn
     timeout by default. When the account's default model is temporarily slow,
     pin an available model with `DSH_CODEX_LIFECYCLE_MODEL` rather than
     weakening any history/task-id assertion;
   - `dsh-codex-workflow sessions --cwd $PWD --json` lists the live session;
   - `dispatch` a plan and `codex_workflow_submit` it exactly once;
   - the readable review is appended to the exact source Codex task;
     `show --workflow <id>` reports matching source/review ids and version
     `1.0.10` (an old workflow that already persisted a distinct Reviewer id
     remains on that legacy task);
   - **single-task history**: the source task contains the plan and every
     visible review round, and Codex Desktop shows no additional Reviewer task;
     `review_only` is the sole exception because it has no Planner/source task
     and therefore creates one durable review task;
   - **desktop readability**: while the Planner/review turn runs, Codex
     Desktop shows the task as “opened in another app” (writer-lock) and the
     persisted history contains ONLY readable Markdown in the original task's
     language — no `outputSchema` envelope, no JSON `verdict` blocks even after
     the review settles (the JSON conversion happens in the ephemeral fork);
     during the turn the task shows NO provisional `pass`/`changes_requested`
     JSON and no sub-agent activity;
   - **Git review context**: every DSH-led `review/start` (Git AND
      non-Git) sends the CUSTOM target whose instructions embed the full
     per-round context (original task, approved plan, the PREVIOUS APPLIED
      REVIEW and this round's fix summary, implementation summary,
      test results, evidence diff) plus the item-by-item coverage gate; on a
     Git workspace the Reviewer is told to review the current
     staged/unstaged/untracked changes and to independently run read-only
      `git status`/`git diff`; an explicit plan requirement without an
      implementation must come back `changes_requested`,
       never `pass` - verify by opening the shared workflow task or capturing its
      instructions, and by observing a missing-requirement round return
      `changes_requested`;
   - **visible-review display contract**: after the review round
      settles, the persisted final agentMessage is readable Markdown with
      the four sections (VERDICT/conclusion, FINDINGS, TEST GAPS, SUMMARY)
      in the original task's language — a Chinese task must never end on an
      English one-liner, a JSON envelope or a section-less reply; when the
      native review violates the contract, exactly ONE visible rewrite turn
       appears on the SAME workflow task (low effort, no schema) that only
      re-presents the same verdict/findings/test-gaps in the task's
      language, and the rewrite's final message is what Desktop and the
      ephemeral conversion see (the summary/findings content is unchanged,
       no second visible task, cancel during the rewrite interrupts that
      exact turn);
      the display audit is the PERSISTED history: the plugin read-backs
      `thread/read(includeTurns:true)` (pre-turn baseline id set, real
      App Server review RPC turn ids differ from persisted `turns[].id`),
      so a round whose STREAMED text looked fine but whose PERSISTED text
      lacks the four sections still gets the rewrite (or falls back
      retryable with no verdict when the read-back is missing/ambiguous
      or the rewrite is still non-compliant);
   - **review authority alignment (1.0.10)**: after each review round an
      invisible ephemeral alignment fork checks the verdict against the
      authority hierarchy (reproducible critical/high defect > original task >
      approved plan > previous applied findings > generic suggestions); an
      aligned round applies as one cycle with `reviewContractFailures` reset
      to 0; a conflict triggers exactly ONE visible reconciliation turn on
      the SAME workflow task (readable review, four sections, no JSON),
      a re-normalization and a re-alignment — a reconciliation-corrected
      verdict applies as ONE cycle with `latestReviewConflict.resolved=true`;
      a still-conflicting round restores executing/fixing WITHOUT
      `latestReview`, WITHOUT a consumed cycle and WITHOUT a fix instruction;
      two consecutive unresolved conflicts move the workflow to `blocked`
      with a reportable reviewer-contract failure (no code changes demanded,
      no user choice popup); `codex_workflow_status` and
      `show --workflow <id>` surface `latestReviewConflict` and
      `reviewContractFailures`;
   - after the Review verdict settles (pass, changes_requested, terminal error,
      or cancel), the plugin releases its workflow-task subscription via `thread/unsubscribe`
     exactly once AND the ephemeral conversion fork was unsubscribed exactly
      once on its own ending path; the persisted workflow task remains visible and
     can be re-opened in Desktop within the idle grace period;
   - a re-review resumes the SAME source/workflow task id (never a second task);
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
   - if the source task has an active writer, the review remains durably
     retryable and starts only after that writer releases it; no replacement
     task is created to bypass the lock;
   - a second review reuses that same task instead of starting another;
   - while a review turn runs longer than `idleProcessMs`, its App Server stays alive; after the final verdict, the process exits after the idle grace period and Codex Desktop can open the shared task;
   - after a passing verdict, DSH reports once without invoking `memory` or any other tool and returns to idle; force a hanging terminal relay and confirm it is cancelled once after `terminalRelayTimeoutMs` with its inbox preserved;
   - let a terminal relay reach idle normally, then start a new user turn and confirm the old guard never cancels it; stop the plugin with a guard pending and confirm no late cancellation occurs;
   - a blocking `changes_requested` returns DSH to `fixing`; re-submit works;
   - only non-blocking findings stop at `waiting_review_decision`;
   - a workspace change between submit and verdict produces a VOID relay
     (`void`/`no longer valid`) and stays `executing`, never forges `passed`;
   - re-`submit` after invalidation succeeds (phase gate is consistent).
4. Failure drills (see also the process-level suite in `test/process-fault.test.ts`):
   - kill a DSH process mid-claim, restart → the stale `processing` row is taken
     over and delivered exactly once;
   - two processes racing claims on one DB → disjoint claims, no duplicate;
    - cancel an App Server review turn → only the exact active turn is
      interrupted; the task history and other submissions remain untouched;
    - the legacy codex-callback child that ignores SIGTERM → dispatcher
      SIGKILL-escalates;
   - cancel a workflow, then deliver a late verdict → `cancelled` receipt, DSH
     never wakes up.
5. Ops check:
   - `workflows`, `show --workflow <id>`, `queue --json`, `retry --request <id>`
     (dead-letter→retry, idempotent), `prune --older-than <ms> --commit`
     removes only terminal data (dry-run default).

## Rollback

- The previous stable version `1.0.7` is a normal `pnpm` package; downgrading is
  just reinstalling it. Its legacy file-queue data is still imported by 1.0.10, and the
  import is one-way (the SQLite queue is authoritative once written).
- If 1.0.10 must be pulled: stop the plugin/dispatch traffic first, restore the
  package, and verify with `pnpm doctor` before resuming. Record database and
  log state are not modified by a version change (only by `prune --commit`).
  Old workflow records need no migration (1.0.10 adds only OPTIONAL fields
  `reviewContractFailures`/`latestReviewConflict`; old records default the
  counter to 0); records with a distinct `reviewerThreadId` continue using
  that task.

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
