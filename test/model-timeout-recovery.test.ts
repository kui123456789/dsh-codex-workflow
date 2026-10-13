import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/app-server.js";
import { isRecoverableModelFailure, isTransientFailure } from "../src/transient-retry.js";
import { CodexTurnInterruptionError } from "../src/turn-interruption.js";

test("the real App Server turn-timeout diagnostic permits continuation without entering transient backoff", async () => {
  const codex = new CodexAppServerClient({
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url))],
    requestTimeoutMs: 1_000,
    idleProcessMs: 0,
  });
  try {
    const threadId = await codex.startThread({ cwd: process.cwd(), ephemeral: true });
    let failure: unknown;
    try { await codex.startTurn(threadId, { prompt: "HANG", model: "test-model" }); }
    catch (error) { failure = error; }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /^Codex turn timed out:/);
    assert.equal(isRecoverableModelFailure(failure.message), true);
    assert.equal(isTransientFailure(failure.message), false, "a model timeout gets at most one short continuation, not a full backoff loop");
    assert.equal(codex.isThreadAvailable(threadId), true);
  } finally { await codex.stop(); }
});

test("control RPC timeouts and terminal diagnostics never become recoverable model turn timeouts", () => {
  for (const diagnostic of [
    "Codex request timed out: thread/start", "Codex request timed out: turn/start",
    "Codex turn timed out: turn-1; approval denied", "Codex turn timed out: turn-1; cancelled by user",
    "Codex turn timed out: turn-1; schema invalid", "Codex turn timed out: turn-1; no rollout found for thread id x",
    "Codex turn timed out: turn-1; permission denied", "Codex turn timed out: turn-1; unauthorized",
    "A message containing Codex turn timed out: turn-1 is quoted documentation",
  ]) assert.equal(isRecoverableModelFailure(diagnostic), false, diagnostic);
});

test("unconfirmed interruption blocks model backoff and does not serialize its original handles", () => {
  for (const diagnostic of ["Codex turn timed out: turn-private", "server_overloaded", "stream disconnected"]) {
    const original = new Error(diagnostic);
    const error = new CodexTurnInterruptionError(original, "thread-private", "turn-private");
    assert.equal(error.cause, original);
    assert.equal(error.interruptionConfirmed, false);
    assert.equal(error.threadId, "thread-private");
    assert.equal(error.turnId, "turn-private");
    assert.equal(isTransientFailure(error.message), false);
    assert.equal(isRecoverableModelFailure(error.message), false);
    assert.equal(Object.keys(error).includes("threadId"), false);
    assert.equal(Object.keys(error).includes("turnId"), false);
  }
  for (const diagnostic of ["codex app-server exited 1: stream disconnected", "Codex app-server stopped"]) {
    assert.equal(isTransientFailure(diagnostic), false);
    assert.equal(isRecoverableModelFailure(diagnostic), false);
  }
});
