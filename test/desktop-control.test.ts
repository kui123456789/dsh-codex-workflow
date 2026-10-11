import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { dedicatedSessionId, workerOutput } from "../src/desktop-control.js";
import { newRequestId, parseDesktopControlCommand } from "../src/bridge-protocol.js";

// Deliberately synthetic log fragments test scoping, not the Session validator.
function events(parts: object[]): SessionEvent[] {
  return parts.map((part, seq) => ({ seq, time: 0, ...part })) as SessionEvent[];
}
const user = (id: string) => ({ type: "user/message", data: { id } });
const answer = (text: string, turn = 1, interrupted = false) => ({ type: "assistant/message", data: { turn, interrupted, message: { content: [{ type: "text", text }, { type: "reasoning", text: "never disclose" }] } } });
const end = (kind = "completed", turn = 1) => ({ type: "turn/end", data: { turn, reason: { kind } } });

test("worker output stops before later workflow/user output and never emits reasoning", () => {
  const log = events([user("unrelated-before"), answer("private-before"), user("relay-a"), answer("task A"), end(), user("relay-b"), answer("private-after", 2), end("completed", 2)]);
  const output = workerOutput(log, "relay-a", "workflow-a");
  assert.deepEqual(output.messages, [{ seq: 3, turn: 1, interrupted: false, text: "task A", truncated: false }]);
  assert.equal(output.completed, true);
  assert.ok(!JSON.stringify(output).includes("private"));
  assert.ok(!JSON.stringify(output).includes("never disclose"));
});

test("worker output includes only its own bounded followup turns", () => {
  const log = events([user("relay-a"), answer("first"), end(), user("dsh-codex-workflow:followup:workflow-a:request"), answer("correction", 2), end("completed", 2), user("manual input"), answer("private", 3)]);
  const output = workerOutput(log, "relay-a", "workflow-a");
  assert.equal((output.messages as unknown[]).length, 2);
  assert.equal(output.completed, true);
  assert.ok(!JSON.stringify(output).includes("private"));
});

test("idle/error/interrupted/missing relay never invent a completed worker result", () => {
  assert.equal(workerOutput(events([answer("unrelated")]), "missing", "w").completed, false);
  assert.equal(workerOutput(events([user("relay"), answer("partial", 1, true), end("aborted")]), "relay", "w").completed, false);
  assert.equal(workerOutput(events([user("relay"), answer("error body"), end("error")]), "relay", "w").completed, false);
  assert.equal(workerOutput(events([user("relay")]), "relay", "w").completed, false);
});

test("dedicated identity is stable and separated by source, cwd, and preset", () => {
  const id = dedicatedSessionId("source-a", "/project", "preset-a");
  assert.equal(id, dedicatedSessionId("source-a", "/project/", "preset-a"));
  for (const changed of [["source-b", "/project", "preset-a"], ["source-a", "/other", "preset-a"], ["source-a", "/project", "preset-b"]]) assert.notEqual(id, dedicatedSessionId(...changed as [string, string, string]));
});

test("desktop control validates sources, absolute cwd and action-specific payloads", () => {
  const base = { version: 1, kind: "desktop_control", requestId: newRequestId(), createdAt: new Date().toISOString(), codexThreadId: newRequestId(), target: { cwd: "/project" }, action: "ensure_session", preset: "standard" };
  assert.equal(parseDesktopControlCommand(base).action, "ensure_session");
  for (const patch of [{ target: { cwd: "relative" } }, { codexThreadId: "invented" }, { target: { cwd: "/project", dshSessionId: "user-session" } }, { message: "unexpected" }, { action: "unknown" }, { extra: true }]) assert.throws(() => parseDesktopControlCommand({ ...base, ...patch }));
  assert.throws(() => parseDesktopControlCommand({ ...base, action: "followup", preset: undefined, workflowId: newRequestId() }));
});


test("generated user-role context does not hide worker results or count as input", () => {
  const context = (form: string) => ({ type: "user/message", data: { id: `context-${form}`, source: { kind: "context-plugin", form } } });
  const human = { type: "user/message", data: { id: "human", source: { kind: "user" } } };
  const log = events([user("relay"), ...["instructions", "catalog", "snapshot", "notice", "recall"].map(context), answer("verified result"), end(), context("snapshot"), human, answer("unrelated", 2)]);
  const output = workerOutput(log, "relay", "w");
  assert.equal(output.completed, true);
  assert.equal((output.messages as unknown[]).length, 1);
  assert.ok(JSON.stringify(output).includes("verified result"));
  assert.ok(!JSON.stringify(output).includes("unrelated"));
  assert.equal(workerOutput(events([user("relay"), answer("first"), end(), user("dsh-codex-workflow:followup:w:request")]), "relay", "w").completed, false);
});

test("only proven workflow verdict relays extend the output window", () => {
  const own = "dsh-codex-workflow:verdict:own";
  const log = events([user("relay"), answer("submitted"), end(), user(own), answer("review passed", 2), end("completed", 2), user("dsh-codex-workflow:verdict:other"), answer("private", 3)]);
  const output = workerOutput(log, "relay", "w", new Set([own]));
  assert.equal((output.messages as unknown[]).length, 2);
  assert.equal(output.completed, true);
  assert.ok(!JSON.stringify(output).includes("private"));
});
