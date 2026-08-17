import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { WorkflowStore } from "../src/store.js";
import type { ReviewResult, TurnWaitResult, WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

class FakeGateway implements CodexGateway {
  reviewResults: ReviewResult[] = [];
  reviewThreads: string[] = [];
  private normalizeReview = false;

  async startThread(): Promise<string> {
    return "planner-thread";
  }

  async resumeThread(): Promise<void> {}

  async startTurn(threadId: string): Promise<TurnWaitResult> {
    if (this.normalizeReview) {
      this.normalizeReview = false;
      const review = this.reviewResults.shift() ?? { verdict: "pass", findings: [], testGaps: [], summary: "pass" };
      return completed(threadId, JSON.stringify(review));
    }
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

  async startReview(options: { threadId: string; cwd: string; detached: boolean }): Promise<{ threadId: string; result: TurnWaitResult }> {
    const threadId = options.detached ? "reviewer-thread" : options.threadId;
    this.reviewThreads.push(threadId);
    this.normalizeReview = true;
    return { threadId, result: completed(threadId, "raw review") };
  }

  async interrupt(): Promise<void> {}
}

const config: WorkflowConfig = {
  codexCommand: "codex",
  plannerModel: "",
  reviewerModel: "",
  plannerEffort: "high",
  reviewerEffort: "high",
  maxReviewCycles: 3,
  turnTimeoutMs: 10_000,
  idleProcessMs: 0,
  storageDir: "",
};

test("runs plan, repair, and detached review in the original DSH session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-workflow-manager-"));
  try {
    const gateway = new FakeGateway();
    gateway.reviewResults = [
      {
        verdict: "changes_requested",
        findings: [{ severity: "high", title: "Bug", body: "Fix it", file: "src/a.ts", line: 10 }],
        testGaps: [],
        summary: "Needs repair",
      },
      { verdict: "pass", findings: [], testGaps: [], summary: "Verified" },
    ];
    const manager = new WorkflowManager(new WorkflowStore(directory), gateway, { ...config, storageDir: directory });
    const deferred: unknown[] = [];
    const exec = fakeExec("session-original", directory, deferred);
    const planned = await manager.start({ task: "Build it" }, exec);
    assert.equal(planned.phase, "executing");
    assert.equal(planned.dshSessionId, "session-original");
    const first = await manager.review(planned.id, { implementationSummary: "Implemented", testResults: "pass" }, exec);
    assert.equal(first.phase, "fixing");
    assert.equal(first.reviewerThreadId, "reviewer-thread");
    const second = await manager.review(planned.id, { implementationSummary: "Fixed", testResults: "pass" }, exec);
    assert.equal(second.phase, "passed");
    assert.deepEqual(gateway.reviewThreads, ["reviewer-thread", "reviewer-thread"]);
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
      findings: [{ severity: "medium" as const, title: "Still wrong", body: "Retry" }],
      testGaps: [],
      summary: "No",
    }));
    const manager = new WorkflowManager(new WorkflowStore(directory), gateway, { ...config, storageDir: directory });
    const exec = fakeExec("session-limit", directory, []);
    const planned = await manager.start({ task: "Build it" }, exec);
    await manager.review(planned.id, { implementationSummary: "one" }, exec);
    await manager.review(planned.id, { implementationSummary: "two" }, exec);
    const final = await manager.review(planned.id, { implementationSummary: "three" }, exec);
    assert.equal(final.phase, "blocked");
    assert.equal(final.reviewCycles, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
