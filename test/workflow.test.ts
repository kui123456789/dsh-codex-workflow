import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { WorkflowStore } from "../src/store.js";
import type { ReviewResult, TurnWaitResult, WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

interface ReviewStartCall {
  threadId: string;
  detached: boolean;
}

interface DeferredGate {
  promise: Promise<void>;
  release: () => void;
}

function deferredGate(): DeferredGate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

class FakeGateway implements CodexGateway {
  reviewResults: ReviewResult[] = [];
  reviewThreads: string[] = [];
  reviewStarts: ReviewStartCall[] = [];
  threadCalls: Array<{ name: string; model?: string }> = [];
  turnCalls: Array<{ model?: string; effort?: string }> = [];
  interrupts: Array<{ threadId: string; turnId: string }> = [];
  /** Held before onStarted fires for review/start (ids known, not persisted). */
  beforeReviewOnStarted?: DeferredGate;
  /** Held after onStarted for review/start (review pending). */
  reviewGate?: DeferredGate;
  /** Held after onStarted for startTurn (planner and normalize turns pending). */
  turnGate?: DeferredGate;
  private normalizeReview = false;

  async startThread(options: { cwd: string; name: string; model?: string }): Promise<string> {
    this.threadCalls.push({ name: options.name, ...(options.model ? { model: options.model } : {}) });
    return options.name.startsWith("DSH Review") ? "source-thread" : "planner-thread";
  }

  async resumeThread(): Promise<void> {}

  async startTurn(threadId: string, options?: { model?: string; effort?: string; onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void }): Promise<TurnWaitResult> {
    this.turnCalls.push({ ...(options?.model ? { model: options.model } : {}), ...(options?.effort ? { effort: options.effort } : {}) });
    if (this.normalizeReview) {
      this.normalizeReview = false;
      if (options?.onStarted) {
        try {
          await options.onStarted({ threadId, turnId: "normalize-turn-1" });
        } catch (error) {
          await this.interrupt(threadId, "normalize-turn-1").catch(() => undefined);
          throw error;
        }
      }
      if (this.turnGate) await this.turnGate.promise;
      const review = this.reviewResults.shift() ?? { verdict: "pass", findings: [], testGaps: [], summary: "pass" };
      return completed(threadId, JSON.stringify(review));
    }
    if (options?.onStarted) {
      try {
        await options.onStarted({ threadId, turnId: "planner-turn-1" });
      } catch (error) {
        await this.interrupt(threadId, "planner-turn-1").catch(() => undefined);
        throw error;
      }
    }
    if (this.turnGate) await this.turnGate.promise;
    return completed(threadId, JSON.stringify({
      status: "ready",
      planMarkdown: "<proposed_plan>\nImplement the feature\n</proposed_plan>",
      questions: [],
      assumptions: ["Tests are available"],
    }));
  }

  async continueTurn(): Promise<TurnWaitResult> {
    throw new Error("not used");
  }

  async startReview(options: { threadId: string; cwd: string; detached: boolean; onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void }): Promise<{ threadId: string; result: TurnWaitResult }> {
    const threadId = options.detached ? "reviewer-thread" : options.threadId;
    this.reviewThreads.push(threadId);
    this.reviewStarts.push({ threadId: options.threadId, detached: options.detached });
    this.normalizeReview = true;
    if (this.beforeReviewOnStarted) await this.beforeReviewOnStarted.promise;
    if (options.onStarted) {
      try {
        await options.onStarted({ threadId, turnId: "review-turn-1" });
      } catch (error) {
        // Mirror the app-server: a failed registration interrupts the new turn.
        await this.interrupt(threadId, "review-turn-1").catch(() => undefined);
        throw error;
      }
    }
    if (this.reviewGate) await this.reviewGate.promise;
    return { threadId, result: completed(threadId, "raw review") };
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId });
  }
}

const blockingFinding = {
  severity: "high" as const,
  blocking: true,
  title: "Bug",
  body: "Fix it",
  file: "src/a.ts",
  line: 10,
};

const nonBlockingFinding = {
  severity: "medium" as const,
  blocking: false,
  title: "Nit",
  body: "Could be cleaner",
};

const config: WorkflowConfig = {
  codexCommand: "codex",
  plannerModel: "",
  reviewerModel: "",
  plannerEffort: "high",
  reviewerEffort: "high",
  maxReviewCycles: 3,
  maxNoChangeReviewRounds: 1,
  reviewDiffMaxBytes: 65536,
  turnTimeoutMs: 10_000,
  idleProcessMs: 0,
  storageDir: "",
};

function manager(directory: string, gateway = new FakeGateway(), overrides: Partial<WorkflowConfig> = {}) {
  return new WorkflowManager(new WorkflowStore(directory), gateway, { ...config, ...overrides, storageDir: directory });
}

test("runs plan, repair, and detached review in the original DSH session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-manager-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "Needs repair" },
      { verdict: "pass", findings: [], testGaps: [], summary: "Verified" },
    ];
    const managerInstance = manager(directory, gateway);
    const deferred: unknown[] = [];
    const exec = fakeExec("session-original", directory, deferred);
    const planned = await managerInstance.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "executing");
    assert.equal(planned.dshSessionId, "session-original");
    assert.equal(planned.mode, "planned");
    const first = await managerInstance.review(planned.id, { implementationSummary: "Implemented", testResults: "pass" }, exec);
    assert.equal(first.phase, "fixing");
    assert.equal(first.reviewerThreadId, "reviewer-thread");
    const second = await managerInstance.review(planned.id, { implementationSummary: "Fixed", testResults: "pass" }, exec);
    assert.equal(second.phase, "passed");
    assert.deepEqual(gateway.reviewThreads, ["reviewer-thread", "reviewer-thread"]);
    assert.deepEqual(gateway.reviewStarts[0], { threadId: "planner-thread", detached: true });
    assert.deepEqual(gateway.reviewStarts[1], { threadId: "reviewer-thread", detached: false });
    assert.ok(deferred.length >= 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocks after the configured third failed review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-limit-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = Array.from({ length: 3 }, () => ({
      verdict: "changes_requested" as const,
      findings: [{ ...blockingFinding, title: "Still wrong", body: "Retry" }],
      testGaps: [],
      summary: "No",
    }));
    const managerInstance = manager(directory, gateway);
    const exec = fakeExec("session-limit", directory, []);
    const planned = await managerInstance.start({ task: "Build it" }, exec);
    await managerInstance.review(planned.id, { implementationSummary: "one" }, exec);
    await managerInstance.review(planned.id, { implementationSummary: "two" }, exec);
    const final = await managerInstance.review(planned.id, { implementationSummary: "three" }, exec);
    assert.equal(final.phase, "blocked");
    assert.equal(final.reviewCycles, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocking findings enter the automatic repair loop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-blocking-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: ["missing tests"], summary: "Fix" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-blocking", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const reviewed = await instance.review(planned.id, { implementationSummary: "Impl" }, exec);
    assert.equal(reviewed.phase, "fixing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("test gaps alone count as blocking", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-testgaps-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [], testGaps: ["add unit tests for the fix"], summary: "Tests" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-testgaps", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const reviewed = await instance.review(planned.id, { implementationSummary: "Impl" }, exec);
    assert.equal(reviewed.phase, "fixing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-blocking findings stop at the review decision gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-gate-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [nonBlockingFinding], testGaps: [], summary: "Nits only" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-gate", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const reviewed = await instance.review(planned.id, { implementationSummary: "Impl" }, exec);
    assert.equal(reviewed.phase, "waiting_review_decision");
    assert.equal(reviewed.reviewCycles, 1);
    await assert.rejects(
      instance.review(planned.id, { implementationSummary: "again" }, exec),
      /cannot be reviewed from phase waiting_review_decision/,
    );
    await assert.rejects(
      instance.decide(planned.id, { decision: "accept" }, fakeExec("other-session", directory, [])),
      /belongs to another DSH session/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accept at the decision gate ships the workflow with findings recorded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-accept-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [nonBlockingFinding], testGaps: [], summary: "Nits" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-accept", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    await instance.review(planned.id, { implementationSummary: "Impl" }, exec);
    const decided = await instance.decide(planned.id, { decision: "accept", note: "nitpick only" }, exec);
    assert.equal(decided.phase, "passed");
    assert.equal(decided.reviewDecision?.decision, "accept");
    assert.equal(decided.reviewDecision?.note, "nitpick only");
    assert.ok(decided.latestReview?.findings[0]?.blocking === false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fix at the decision gate enters the repair loop and can pass later", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-fix-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [nonBlockingFinding], testGaps: [], summary: "Nits" },
      { verdict: "pass", findings: [], testGaps: [], summary: "Good" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-fix", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    await instance.review(planned.id, { implementationSummary: "Impl" }, exec);
    const decided = await instance.decide(planned.id, { decision: "fix" }, exec);
    assert.equal(decided.phase, "fixing");
    assert.equal(decided.reviewDecision?.decision, "fix");
    const repaired = await instance.review(planned.id, { implementationSummary: "Fixed nits" }, exec);
    assert.equal(repaired.phase, "passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocks a blocking re-review when the workspace did not change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-nochange-"));
  try {
    const file = join(directory, "a.txt");
    await writeFile(file, "v1", "utf8");
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-nochange", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const first = await instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.txt"] }, exec);
    assert.equal(first.phase, "fixing");
    assert.equal(first.noChangeReviewRounds, 0);
    assert.ok(first.latestReviewEvidence?.fingerprint);
    const second = await instance.review(planned.id, { implementationSummary: "two (no changes)", changedFiles: ["a.txt"] }, exec);
    assert.equal(second.phase, "blocked");
    assert.equal(second.noChangeReviewRounds, 1);
    assert.match(second.error ?? "", /no verifiable change/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an actual workspace change resets the no-change counter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-reset-"));
  try {
    const file = join(directory, "a.txt");
    await writeFile(file, "v1", "utf8");
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-reset", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    await instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.txt"] }, exec);
    await writeFile(file, "v2", "utf8");
    const second = await instance.review(planned.id, { implementationSummary: "two (fixed)", changedFiles: ["a.txt"] }, exec);
    assert.equal(second.phase, "fixing");
    assert.equal(second.noChangeReviewRounds, 0);
    const third = await instance.review(planned.id, { implementationSummary: "three", changedFiles: ["a.txt"] }, exec);
    assert.equal(third.phase, "blocked");
    assert.equal(third.noChangeReviewRounds, 1);
    assert.match(third.error ?? "", /no verifiable change/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pass and non-blocking reviews are never blocked by identical fingerprints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-passnoc-"));
  try {
    const file = join(directory, "a.txt");
    await writeFile(file, "v1", "utf8");

    const passGateway = new FakeGateway();
    passGateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "pass", findings: [], testGaps: [], summary: "OK" },
    ];
    const passInstance = manager(directory, passGateway);
    const passExec = fakeExec("session-passnoc-a", directory, []);
    const passPlanned = await passInstance.start({ task: "Build it" }, passExec);
    await passInstance.review(passPlanned.id, { implementationSummary: "one", changedFiles: ["a.txt"] }, passExec);
    const passed = await passInstance.review(passPlanned.id, { implementationSummary: "two", changedFiles: ["a.txt"] }, passExec);
    assert.equal(passed.phase, "passed");

    const gateGateway = new FakeGateway();
    gateGateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "changes_requested", findings: [nonBlockingFinding], testGaps: [], summary: "Nits" },
    ];
    const gateInstance = manager(directory, gateGateway);
    const gateExec = fakeExec("session-passnoc-b", directory, []);
    const gatePlanned = await gateInstance.start({ task: "Build it" }, gateExec);
    await gateInstance.review(gatePlanned.id, { implementationSummary: "one", changedFiles: ["a.txt"] }, gateExec);
    const gated = await gateInstance.review(gatePlanned.id, { implementationSummary: "two", changedFiles: ["a.txt"] }, gateExec);
    assert.equal(gated.phase, "waiting_review_decision");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("insufficient evidence disables no-change detection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-insufficient-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-insufficient", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    // No changedFiles in a non-git workspace: nothing verifiable, no false block.
    const first = await instance.review(planned.id, { implementationSummary: "one" }, exec);
    assert.equal(first.phase, "fixing");
    assert.ok(first.latestReviewEvidence?.insufficient);
    const second = await instance.review(planned.id, { implementationSummary: "two" }, exec);
    assert.equal(second.phase, "fixing");
    assert.equal(second.noChangeReviewRounds, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("review-only skips the planner, uses a detached reviewer, and reuses it on re-review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-reviewonly-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "pass", findings: [], testGaps: [], summary: "OK" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-reviewonly", directory, []);
    const started = await instance.reviewOnly({
      task: "Polish existing changes",
      implementationSummary: "Changed src",
      changedFiles: ["src/a.ts"],
      testResults: "pass",
    }, exec);
    assert.equal(started.mode, "review_only");
    assert.equal(started.phase, "fixing");
    assert.equal(started.reviewerThreadId, "reviewer-thread");
    assert.ok(!gateway.threadCalls.some((call) => call.name.startsWith("DSH Plan")));
    assert.deepEqual(gateway.reviewStarts[0], { threadId: "source-thread", detached: true });

    const reReviewed = await instance.review(started.id, { implementationSummary: "Fixed" }, exec);
    assert.equal(reReviewed.phase, "passed");
    assert.deepEqual(gateway.reviewThreads, ["reviewer-thread", "reviewer-thread"]);
    assert.deepEqual(gateway.reviewStarts[1], { threadId: "reviewer-thread", detached: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("review-only enforces single active workflow per session and supports cancel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-own-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-own", directory, []);
    const started = await instance.reviewOnly({ implementationSummary: "Changed", changedFiles: ["a.txt"] }, exec);
    await assert.rejects(instance.start({ task: "Second" }, exec), /already has active Codex workflow/);
    await assert.rejects(
      instance.reviewOnly({ implementationSummary: "Other" }, fakeExec("session-own", directory, [])),
      /already has active Codex workflow/,
    );
    await assert.rejects(
      instance.status(started.id, fakeExec("session-other", directory, [])),
      /belongs to another DSH session/,
    );
    const cancelled = await instance.cancel(started.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    // After cancellation a new workflow may start.
    const fresh = await instance.start({ task: "Second" }, exec);
    assert.equal(fresh.phase, "executing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("review-only fails cleanly when the source thread cannot start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-rofail-"));
  try {
    const gateway = new FakeGateway();
    const failing = new Proxy(gateway, {
      get(target, property, receiver) {
        if (property === "startThread") return async () => { throw new Error("boom"); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FakeGateway;
    const instance = manager(directory, failing);
    const exec = fakeExec("session-rofail", directory, []);
    await assert.rejects(instance.reviewOnly({ implementationSummary: "Changed", changedFiles: ["a.txt"] }, exec), /boom/);
    const records = await new WorkflowStore(directory).list();
    assert.equal(records[0]?.phase, "failed");
    assert.equal(records[0]?.mode, "review_only");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unobservable rounds break the fingerprint chain and are never blocked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-chain-"));
  try {
    const file = join(directory, "a.txt");
    await writeFile(file, "v1", "utf8");
    const gateway = new FakeGateway();
    gateway.reviewResults = Array.from({ length: 3 }, () => ({
      verdict: "changes_requested" as const,
      findings: [blockingFinding],
      testGaps: [],
      summary: "No",
    }));
    const instance = manager(directory, gateway, { maxNoChangeReviewRounds: 1, maxReviewCycles: 5 });
    const exec = fakeExec("session-chain", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const first = await instance.review(planned.id, { implementationSummary: "one", changedFiles: ["a.txt"] }, exec);
    assert.equal(first.phase, "fixing");
    assert.ok(first.previousReviewFingerprint);
    // All-missing round: unverifiable, clears the fingerprint chain.
    const unobservable = await instance.review(planned.id, { implementationSummary: "two", changedFiles: ["missing.txt"] }, exec);
    assert.equal(unobservable.phase, "fixing");
    assert.equal(unobservable.noChangeReviewRounds, 0);
    assert.equal(unobservable.previousReviewFingerprint, undefined);
    // Returning to the old fingerprint after an unobservable round is fresh progress.
    const third = await instance.review(planned.id, { implementationSummary: "three", changedFiles: ["a.txt"] }, exec);
    assert.equal(third.phase, "fixing");
    assert.equal(third.noChangeReviewRounds, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pass verdict carrying actionable content is demoted to changes_requested", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-passcontent-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "pass", findings: [blockingFinding], testGaps: [], summary: "pass but has a finding" },
      { verdict: "pass", findings: [], testGaps: ["missing unit tests"], summary: "pass but test gaps" },
      { verdict: "pass", findings: [nonBlockingFinding], testGaps: [], summary: "pass but nits" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-passcontent", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const blocking = await instance.review(planned.id, { implementationSummary: "one" }, exec);
    assert.equal(blocking.phase, "fixing");
    const testGaps = await instance.review(planned.id, { implementationSummary: "two" }, exec);
    assert.equal(testGaps.phase, "fixing");
    const nits = await instance.review(planned.id, { implementationSummary: "three" }, exec);
    assert.equal(nits.phase, "waiting_review_decision");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an empty changes_requested verdict fails the review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-emptyverdict-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [], testGaps: [], summary: "nothing to say" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-emptyverdict", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    await assert.rejects(
      instance.review(planned.id, { implementationSummary: "one" }, exec),
      /changes_requested without findings or test gaps/,
    );
    const records = await new WorkflowStore(directory).list();
    assert.equal(records[0]?.phase, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("review-only honours reviewer model and effort overrides across repair rounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-rooverride-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
      { verdict: "pass", findings: [], testGaps: [], summary: "OK" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-rooverride", directory, []);
    const started = await instance.reviewOnly({
      implementationSummary: "Changed",
      changedFiles: ["src/a.ts"],
      reviewerModel: "override-model",
      reviewerEffort: "low",
    }, exec);
    assert.equal(started.reviewerModel, "override-model");
    assert.equal(started.reviewerEffort, "low");
    // The source thread and both normalize turns carry the override.
    assert.equal(gateway.threadCalls[0]?.model, "override-model");
    assert.deepEqual(gateway.turnCalls.map((call) => call.model), ["override-model"]);
    assert.deepEqual(gateway.turnCalls.map((call) => call.effort), ["low"]);
    await instance.review(started.id, { implementationSummary: "Fixed" }, exec);
    assert.deepEqual(gateway.turnCalls.map((call) => call.model), ["override-model", "override-model"]);
    assert.deepEqual(gateway.turnCalls.map((call) => call.effort), ["low", "low"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("review-only without changedFiles is rejected in a non-git workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-rogitchanged-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-rogitchanged", directory, []);
    await assert.rejects(
      instance.reviewOnly({ implementationSummary: "Changed" }, exec),
      /requires changedFiles/,
    );
    // Rejected before record creation: nothing persisted, no active workflow.
    assert.equal((await new WorkflowStore(directory).list()).length, 0);
    const next = await instance.reviewOnly({ implementationSummary: "Changed with files", changedFiles: ["a.txt"] }, exec);
    assert.equal(next.phase, "fixing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel interrupts a still-running review and is not overwritten when it settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-activereview-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    let release!: () => void;
    gateway.reviewGate = {
      promise: new Promise<void>((resolve) => { release = resolve; }),
      release: () => release(),
    };
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-activereview", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const pendingReview = instance.review(planned.id, { implementationSummary: "one" }, exec);
    // The reviewer ids must be persisted while the review is still running.
    const store = new WorkflowStore(directory);
    await waitFor(async () => (await store.load(planned.id))?.reviewerThreadId === "reviewer-thread");
    const during = await store.load(planned.id);
    assert.equal(during?.reviewerThreadId, "reviewer-thread");
    assert.equal(during?.reviewerTurnId, "review-turn-1");
    assert.equal(during?.phase, "reviewing");
    const cancelled = await instance.cancel(planned.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    assert.deepEqual(gateway.interrupts, [{ threadId: "reviewer-thread", turnId: "review-turn-1" }]);
    release();
    const settled = await pendingReview;
    // The settling review must not overwrite the cancelled phase.
    assert.equal(settled.phase, "cancelled");
    assert.equal((await store.load(planned.id))?.phase, "cancelled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("review-only persists its source thread id for recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-sourcethread-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-sourcethread", directory, []);
    const started = await instance.reviewOnly({ implementationSummary: "Changed", changedFiles: ["a.txt"] }, exec);
    assert.equal(started.sourceThreadId, "source-thread");
    assert.equal(started.reviewerThreadId, "reviewer-thread");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("review-only source thread failure still records a usable failed record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-sourcethreadfail-"));
  try {
    const gateway = new FakeGateway();
    const failing = new Proxy(gateway, {
      get(target, property, receiver) {
        if (property === "startThread") return async () => { throw new Error("no thread"); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FakeGateway;
    const instance = manager(directory, failing);
    const exec = fakeExec("session-sourcethreadfail", directory, []);
    await assert.rejects(instance.reviewOnly({ implementationSummary: "Changed", changedFiles: ["a.txt"] }, exec), /no thread/);
    const store = new WorkflowStore(directory);
    await waitFor(async () => (await store.list()).length === 1);
    const records = await store.list();
    assert.equal(records[0]?.phase, "failed");
    assert.equal(records[0]?.sourceThreadId, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Test seam: holds the next store load so a cancel can win the race between a
 * final cancelled check and the outcome commit. */
class GatedStore extends WorkflowStore {
  holdNextLoad = false;
  loadGate?: DeferredGate;

  override async load(id: string): Promise<WorkflowRecord | undefined> {
    if (this.holdNextLoad) {
      this.holdNextLoad = false;
      if (this.loadGate) await this.loadGate.promise;
    }
    return super.load(id);
  }
}

/** Test seam: fails the Nth update call so turn registration can be made to throw. */
class FlakyStore extends WorkflowStore {
  updateCount = 0;
  failAtUpdate?: number;

  override async update<T>(
    id: string,
    fn: (record: WorkflowRecord) => T | Promise<T>,
    opts: { ignoreCancelled?: boolean } = {},
  ) {
    this.updateCount += 1;
    if (this.failAtUpdate === this.updateCount) {
      throw new Error("store write failed");
    }
    return super.update(id, fn, opts);
  }
}

test("a failing turn registration fails the workflow and interrupts the new turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-regfail-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const store = new FlakyStore(directory);
    const instance = new WorkflowManager(store, gateway, { ...config, storageDir: directory });
    const exec = fakeExec("session-regfail", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "executing");
    // start() used one update; the third review update is the raw-review turn
    // registration (entering, evidence, registerActiveTurn).
    store.failAtUpdate = store.updateCount + 3;
    await assert.rejects(instance.review(planned.id, { implementationSummary: "one" }, exec), /store write failed/);
    const records = await store.list();
    assert.equal(records[0]?.phase, "failed");
    // The just-started reviewer turn was interrupted, mirroring the app-server.
    assert.ok(gateway.interrupts.some(
      (entry) => entry.threadId === "reviewer-thread" && entry.turnId === "review-turn-1",
    ));
    assert.equal(await store.activeForSession("session-regfail"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel before the reviewer ids are persisted: onStarted never resurrects and interrupts the new turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-beforeonstarted-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const beforeOnStarted = deferredGate();
    gateway.beforeReviewOnStarted = beforeOnStarted;
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-beforeonstarted", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const store = new WorkflowStore(directory);
    const pendingReview = instance.review(planned.id, { implementationSummary: "one" }, exec);
    await waitFor(async () => (await store.load(planned.id))?.phase === "reviewing" && gateway.reviewStarts.length === 1);
    // The reviewer ids are not persisted yet: cancel wins first.
    const before = await store.load(planned.id);
    assert.equal(before?.reviewerThreadId, undefined);
    assert.equal(before?.plannerTurnId, "planner-turn-1");
    const cancelled = await instance.cancel(planned.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    beforeOnStarted.release();
    const settled = await pendingReview;
    assert.equal(settled.phase, "cancelled");
    assert.equal((await store.load(planned.id))?.phase, "cancelled");
    // The turn obtained after cancellation was interrupted, not resurrected.
    assert.ok(gateway.interrupts.some(
      (entry) => entry.threadId === "reviewer-thread" && entry.turnId === "review-turn-1",
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel during the normalize turn interrupts the normalize turn, not the finished raw review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-normalizecancel-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const instance = manager(directory, gateway);
    const exec = fakeExec("session-normalizecancel", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const turnGate = deferredGate();
    gateway.turnGate = turnGate;
    const store = new WorkflowStore(directory);
    const pendingReview = instance.review(planned.id, { implementationSummary: "one" }, exec);
    await waitFor(async () => (await store.load(planned.id))?.reviewerTurnId === "normalize-turn-1");
    const during = await store.load(planned.id);
    assert.equal(during?.reviewerTurnId, "normalize-turn-1");
    assert.notEqual(during?.reviewerTurnId, "review-turn-1");
    const cancelled = await instance.cancel(planned.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    assert.deepEqual(gateway.interrupts, [{ threadId: "reviewer-thread", turnId: "normalize-turn-1" }]);
    turnGate.release();
    const settled = await pendingReview;
    assert.equal(settled.phase, "cancelled");
    assert.equal((await store.load(planned.id))?.phase, "cancelled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel between the final check and the outcome commit: no overwrite, no outcome message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-latecancel-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "pass", findings: [], testGaps: [], summary: "OK" },
    ];
    const store = new GatedStore(directory);
    const instance = new WorkflowManager(store, gateway, { ...config, storageDir: directory });
    const exec = fakeExec("session-latecancel", directory, []);
    const deferred: unknown[] = [];
    const execWithDeferred = fakeExec("session-latecancel", directory, deferred);
    const planned = await instance.start({ task: "Build it" }, exec);
    const turnGate = deferredGate();
    gateway.turnGate = turnGate;
    const pendingReview = instance.review(planned.id, { implementationSummary: "one" }, execWithDeferred);
    await waitFor(async () => (await store.load(planned.id))?.reviewerTurnId === "normalize-turn-1");
    const loadGate = deferredGate();
    store.holdNextLoad = true;
    store.loadGate = loadGate;
    turnGate.release();
    // Wait until the after-normalize load is actually held at the gate.
    await waitFor(() => store.holdNextLoad === false);
    const cancelled = await instance.cancel(planned.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    loadGate.release();
    const settled = await pendingReview;
    assert.equal(settled.phase, "cancelled");
    assert.equal((await store.load(planned.id))?.phase, "cancelled");
    // No outcome message may be injected after the cancellation.
    assert.ok(!deferred.some((message) => JSON.stringify(message).includes("Codex Reviewer passed")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel while the planner turn is running interrupts the planner turn and ends start cancelled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-plancancel-"));
  try {
    const gateway = new FakeGateway();
    const turnGate = deferredGate();
    gateway.turnGate = turnGate;
    const instance = manager(directory, gateway);
    const store = new WorkflowStore(directory);
    const exec = fakeExec("session-plancancel", directory, []);
    const pendingStart = instance.start({ task: "Build it" }, exec);
    await waitFor(async () => (await store.list()).length > 0);
    const record = (await store.list())[0]!;
    await waitFor(async () => (await store.load(record.id))?.plannerTurnId === "planner-turn-1");
    const cancelled = await instance.cancel(record.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    assert.deepEqual(gateway.interrupts, [{ threadId: "planner-thread", turnId: "planner-turn-1" }]);
    turnGate.release();
    const settled = await pendingStart;
    assert.equal(settled.phase, "cancelled");
    assert.equal((await store.load(record.id))?.phase, "cancelled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupt failures never un-cancel a workflow or leave it active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-intfail-"));
  try {
    const gateway = new FakeGateway();
    gateway.interrupt = async () => { throw new Error("interrupt failed"); };
    const instance = manager(directory, gateway);
    const store = new WorkflowStore(directory);
    const exec = fakeExec("session-intfail", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const cancelled = await instance.cancel(planned.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal((await store.load(planned.id))?.phase, "cancelled");
    assert.equal(await store.activeForSession("session-intfail"), undefined);
    const fresh = await instance.start({ task: "Second" }, exec);
    assert.equal(fresh.phase, "executing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("onStarted interrupt failure after cancellation still leaves the record cancelled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-onstartedfail-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      { verdict: "changes_requested", findings: [blockingFinding], testGaps: [], summary: "No" },
    ];
    const beforeOnStarted = deferredGate();
    gateway.beforeReviewOnStarted = beforeOnStarted;
    let interruptThrows = false;
    gateway.interrupt = async (threadId: string, turnId: string) => {
      gateway.interrupts.push({ threadId, turnId });
      if (interruptThrows) throw new Error("interrupt failed");
    };
    const instance = manager(directory, gateway);
    const store = new WorkflowStore(directory);
    const exec = fakeExec("session-onstartedfail", directory, []);
    const planned = await instance.start({ task: "Build it" }, exec);
    const pendingReview = instance.review(planned.id, { implementationSummary: "one" }, exec);
    await waitFor(async () => gateway.reviewStarts.length === 1);
    const cancelled = await instance.cancel(planned.id, exec);
    assert.equal(cancelled.phase, "cancelled");
    interruptThrows = true;
    beforeOnStarted.release();
    const settled = await pendingReview;
    assert.equal(settled.phase, "cancelled");
    assert.equal((await store.load(planned.id))?.phase, "cancelled");
    assert.ok(gateway.interrupts.some(
      (entry) => entry.threadId === "reviewer-thread" && entry.turnId === "review-turn-1",
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

function completed(threadId: string, text: string): TurnWaitResult {
  return { kind: "completed", threadId, turnId: `turn-${Math.random()}`, status: "completed", text };
}

function fakeExec(sessionId: string, cwd: string, deferred: unknown[]): ToolRunContext {
  return {
    agent: { id: sessionId, session: { header: { cwd } } },
    signal: new AbortController().signal,
    deferContext: (message: unknown) => deferred.push(message),
  } as unknown as ToolRunContext;
}