import assert from "node:assert/strict";
import test from "node:test";
import { ForegroundReviewStageError } from "../src/application/foreground-review-checkpoint.js";
import { isRecoverableModelFailure, isTerminalModelFailure, retryTransient, transientReason } from "../src/transient-retry.js";

test("permission and authentication rejection override a mixed stream failure in both retry layers", async () => {
  for (const message of ["permission denied: stream disconnected", "401 Unauthorized: stream disconnected", "HTTP 403 Forbidden: server overloaded"]) {
    assert.equal(isTerminalModelFailure(message), true);
    assert.equal(isRecoverableModelFailure(message), false);
    assert.equal(transientReason(message), undefined);
    assert.equal(new ForegroundReviewStageError("alignment", new Error(message)).recoverable, false);
    let requests = 0;
    await assert.rejects(retryTransient(async () => { requests += 1; throw new Error(message); },
      (error) => transientReason(error instanceof Error ? error.message : String(error)),
      { baseMs: 1, maxMs: 1, budgetMs: 100, jitterRatio: 0 }), { message });
    assert.equal(requests, 1, "Neither automatic continuation nor transient backoff may repeat the rejected request");
  }
});

test("only explicitly model-call failures can make a foreground stage recoverable", () => {
  const storageFailure = new ForegroundReviewStageError("alignment", new Error("connection reset by peer"));
  assert.equal(storageFailure.recoverable, false, "progress/storage failures must not trigger a model continuation");

  const modelFailure = new ForegroundReviewStageError("alignment", new Error("connection reset by peer"), { modelCall: true });
  assert.equal(modelFailure.recoverable, true, "the same diagnostic is recoverable when it came from the model call");

  assert.equal(isRecoverableModelFailure({ message: "opaque upstream failure", recoverableModelFailure: true }), true,
    "an explicit upstream model-failure marker remains usable even when its text is generic");
  assert.equal(isRecoverableModelFailure({ recoverableModelFailure: true }), true,
    "an explicit model-failure marker can carry no diagnostic text");
});
