import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

const helper = fileURLToPath(new URL("../scripts/dsh-runtime-smoke.mjs", import.meta.url));

async function fixture(t: TestContext, projections?: Array<Record<string, unknown>>,
  controls: { holdObservation?: boolean; rejectObservation?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-smoke-wire-"));
  const state = join(directory, "state.json");
  await writeFile(state, JSON.stringify({ cookies: [{ name: "dsh-auth-fixture", value: "fixture-only",
    domain: "127.0.0.1", path: "/" }], origins: [] }));
  const requests: Array<{ method: string; payload: { args?: { request?: Record<string, unknown> } } }> = [];
  let projectionIndex = 0;
  const server = createServer(async (request, response) => {
    let content = "";
    for await (const chunk of request) content += chunk;
    const message = JSON.parse(content);
    requests.push(message);
    response.setHeader("content-type", "application/json");
    // The installed native gateway rejects this before resolving a service or
    // calling SessionController.create. Keep this exact observed wire boundary.
    const payload = message.payload;
    const pendingObservation = message.method === "session/projections"
      && requests.filter((entry) => entry.method === "session/projections").length === 3;
    if (controls.holdObservation && pendingObservation) {
      // Initial inspection and one descriptor poll already returned. Keep the
      // next read pending until the helper's actual observation signal expires.
      // A finite server delay could miss that boundary under scheduler load.
      return;
    }
    if (controls.rejectObservation && pendingObservation) {
      response.end(JSON.stringify({ type: "server-response", rpcId: message.rpcId,
        result: { ok: false, error: { code: "gateway/internal", message: "Selected projection could not be read" } } }));
      return;
    }
    const valid = payload && Object.keys(payload).length === 1 && payload.args
      && typeof payload.args === "object" && !Array.isArray(payload.args);
    const result = !valid ? { ok: false, error: { code: "gateway/internal",
      message: "Remote payload must contain exactly one plain-object args field" } }
      : message.method === "session/projections" && payload.args.request?.sessionId === "corrupt-child"
        ? { ok: false, error: { code: "gateway/internal", message: "Session projection read failed: tool/call has no advertised tool lifecycle" } }
      : message.method === "session/create" ? { ok: true, value: { sessionId: "server-created-session" } }
        : message.method === "session/prompt" ? { ok: true, value: { accepted: true } }
          : message.method === "session/cancel" ? { ok: true, value: { accepted: true } }
          : message.method === "session/projections" ? { ok: true, value: projections?.[Math.min(projectionIndex++, projections.length - 1)] ?? { asOfSeq: 4, values: {} } }
            : message.method === "session/page" ? { ok: true, value: { records: payload.args.request?.address?.sessionId === "fixture-mixed-parent"
              ? [
                { type: "event", event: { type: "subagent/catalog", data: { childId: "planner-child", mode: "one-shot", label: "Codex Planner · fixture-workflow" } } },
                { type: "event", event: { type: "dsh-codex-workflow/plan-updated", data: { childSessionId: "planner-child", workflowId: "fixture-workflow", status: "ready" } } },
                { type: "event", event: { type: "subagent/catalog", data: { childId: "mnemon-child", mode: "one-shot", label: "Mnemon idle checkpoint review" } } },
                { type: "event", event: { type: "agent/inbox", data: { childSessionId: "unrelated-reference" } } },
              ] : [], hasMore: false } }
              : { ok: false, error: { code: "gateway/unknown", message: "Unexpected fixture endpoint" } };
    response.end(JSON.stringify({ type: "server-response", rpcId: message.rpcId, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const run = async (command: string, args: string[]) => {
    const child = spawn(process.execPath, [helper, command, "--base-url", `http://127.0.0.1:${address.port}`,
      "--state", state, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(stderr, "");
    return { code, output: JSON.parse(stdout) };
  };
  return { directory, requests, run };
}

test("native smoke create uses the sealed args envelope and keeps its returned receipt", async (t) => {
  const f = await fixture(t);
  const receipt = join(f.directory, "create.receipt.json");
  const result = await f.run("create", ["--cwd", f.directory, "--receipt", receipt]);
  assert.equal(result.code, 0, result.output.error);
  assert.equal(result.output.sessionId, "server-created-session");
  assert.deepEqual(Object.keys(f.requests[0]!.payload), ["args"]);
  assert.deepEqual(f.requests[0]!.payload.args, { request: { cwd: f.directory } });
  assert.equal(f.requests.length, 1, "the helper must not retry an unknown create outcome");
  const saved = JSON.parse(await readFile(receipt, "utf8"));
  assert.equal(saved.status, "created");
  assert.equal(saved.sessionId, "server-created-session");
});

test("native smoke prompt and selected-session history use the same args envelope", async (t) => {
  const f = await fixture(t);
  const admitted = await f.run("prompt", ["--session", "fixture-session", "--text", "Fixture prompt only"]);
  assert.equal(admitted.code, 0, admitted.output.error);
  assert.equal(admitted.output.accepted, true);
  assert.equal(f.requests[0]!.payload.args?.request?.sessionId, "fixture-session");
  const history = await f.run("events", ["--session", "fixture-session"]);
  assert.equal(history.code, 0, history.output.error);
  assert.deepEqual(f.requests.map((request) => request.method), ["session/prompt", "session/projections", "session/page"]);
  assert.ok(f.requests.every((request) => Object.keys(request.payload).join() === "args"));
  assert.equal(history.output.eventCount, 0);
});

test("a corrupt selected child keeps the parent summary and reports a separate format diagnostic", async (t) => {
  const f = await fixture(t);
  const history = await f.run("events", ["--session", "fixture-parent", "--child", "corrupt-child"]);
  assert.equal(history.code, 0, history.output.error);
  assert.equal(history.output.ok, true);
  assert.equal(history.output.sessionId, "fixture-parent");
  assert.equal(history.output.eventCount, 0, "the parent journal was still successfully summarized");
  assert.equal(history.output.childSessionId, "corrupt-child");
  assert.equal(history.output.childDiagnosticCategory, "session_format_tool_lifecycle");
  assert.match(history.output.childDiagnosticMessage, /no advertised tool lifecycle/);
  assert.deepEqual(f.requests.map((request) => request.method), ["session/projections", "session/page", "session/projections"]);
});

test("native smoke child metadata distinguishes Codex workflows from unrelated checkpoint agents", async (t) => {
  const f = await fixture(t);
  const history = await f.run("events", ["--session", "fixture-mixed-parent"]);
  assert.equal(history.code, 0, history.output.error);
  assert.deepEqual(history.output.childSessionIds, ["planner-child", "mnemon-child"]);
  assert.deepEqual(history.output.codexChildSessionIds, ["planner-child"]);
  assert.equal(history.output.children.find((child: { childSessionId: string }) => child.childSessionId === "planner-child").role, "planner");
  const checkpoint = history.output.children.find((child: { childSessionId: string }) => child.childSessionId === "mnemon-child");
  assert.equal(checkpoint.role, "mnemon_checkpoint_review");
  assert.equal(checkpoint.provider, undefined, "catalog labels alone cannot invent a runtime provider");
});

test("explicit cancel-session stops only the selected native parent with a sealed request", async (t) => {
  const f = await fixture(t);
  const cancelled = await f.run("cancel-session", ["--session", "fixture-parent"]);
  assert.equal(cancelled.code, 0, cancelled.output.error);
  assert.equal(cancelled.output.scope, "native_parent_turn");
  assert.equal(cancelled.output.workflowCancelled, false);
  assert.deepEqual(f.requests.map((request) => request.method), ["session/cancel"]);
  assert.deepEqual(f.requests[0]!.payload.args, { request: { sessionId: "fixture-parent" } });
});

test("the recovery drill prompts once and waits for backend progress before cancelling the parent turn", async (t) => {
  const plan = { workflowId: "fixture-workflow", childSessionId: "fixture-child", status: "planning" };
  const f = await fixture(t, [
    { asOfSeq: 0, values: {} },
    { asOfSeq: 1, values: { codexWorkflow: { currentWorkflowId: plan.workflowId, plan } } },
    { asOfSeq: 2, values: { codexWorkflow: { currentWorkflowId: plan.workflowId,
      plan: { ...plan, live: [{ kind: "tool", text: "Fixture backend progress" }] } } } },
  ]);
  const receipt = join(f.directory, "drill.receipt.json");
  const result = await f.run("prompt-until-child", ["--session", "new-test-session", "--text", "Fixture planning request",
    "--wait-live", "true", "--timeout-ms", "3000", "--receipt", receipt]);
  assert.equal(result.code, 0, result.output.error);
  assert.equal(result.output.outcome, "parent_turn_interrupted");
  assert.equal(result.output.workflowId, plan.workflowId);
  assert.equal(result.output.childSessionId, plan.childSessionId);
  assert.equal(result.output.workflowCancelled, false);
  assert.deepEqual(f.requests.map((request) => request.method), ["session/projections", "session/prompt",
    "session/projections", "session/projections", "session/cancel"]);
  assert.equal(f.requests.filter((request) => request.method === "session/prompt").length, 1);
  assert.equal(f.requests.filter((request) => request.method === "session/create").length, 0);
  assert.equal(JSON.stringify(result.output).includes("Fixture planning request"), false);
  const saved = JSON.parse(await readFile(receipt, "utf8"));
  assert.equal(saved.status, "parent_turn_interrupted");
});

test("the recovery drill does not fake an interruption after planning already completed", async (t) => {
  const f = await fixture(t, [{ asOfSeq: 0, values: {} }, { asOfSeq: 2, values: { codexWorkflow: {
    currentWorkflowId: "fixture-workflow", plan: { workflowId: "fixture-workflow", childSessionId: "fixture-child", status: "ready" },
  } } }]);
  const result = await f.run("prompt-until-child", ["--session", "new-test-session", "--text", "Fixture request",
    "--receipt", join(f.directory, "complete.receipt.json")]);
  assert.equal(result.code, 0, result.output.error);
  assert.equal(result.output.outcome, "completed_before_interrupt");
  assert.equal(result.output.cancelSent, false);
  assert.equal(f.requests.filter((request) => request.method === "session/cancel").length, 0);
  assert.equal(f.requests.filter((request) => request.method === "session/prompt").length, 1);
});

test("a child descriptor without backend progress times out without cancelling or restarting", async (t) => {
  const f = await fixture(t, [{ asOfSeq: 0, values: {} }, { asOfSeq: 1, values: { codexWorkflow: {
    currentWorkflowId: "fixture-workflow", plan: { workflowId: "fixture-workflow", childSessionId: "fixture-child", status: "planning" },
  } } }]);
  const result = await f.run("prompt-until-child", ["--session", "new-test-session", "--text", "Fixture request",
    "--timeout-ms", "300", "--receipt", join(f.directory, "timeout.receipt.json")]);
  assert.equal(result.code, 0, result.output.error);
  assert.equal(result.output.outcome, "observation_timeout");
  assert.equal(result.output.cancelSent, false);
  assert.equal(result.output.liveEntries, 0);
  assert.equal(f.requests.filter((request) => request.method === "session/prompt").length, 1);
  assert.equal(f.requests.filter((request) => request.method === "session/cancel").length, 0);
  assert.equal(f.requests.filter((request) => request.method === "session/create").length, 0);
});

test("an observation deadline during a pending projection reports timeout without cancelling or repeating the accepted prompt", async (t) => {
  const f = await fixture(t, [{ asOfSeq: 0, values: {} }, { asOfSeq: 1, values: { codexWorkflow: {
    currentWorkflowId: "fixture-workflow", plan: { workflowId: "fixture-workflow", childSessionId: "fixture-child", status: "planning" },
  } } }], { holdObservation: true });
  const receipt = join(f.directory, "pending-projection-timeout.receipt.json");
  const result = await f.run("prompt-until-child", ["--session", "new-test-session", "--text", "Fixture request",
    "--timeout-ms", "1000", "--receipt", receipt]);
  assert.equal(result.code, 0, result.output.error);
  assert.equal(result.output.outcome, "observation_timeout");
  assert.equal(result.output.promptSent, true);
  assert.equal(result.output.cancelSent, false);
  assert.equal(result.output.workflowId, "fixture-workflow", "The last successful observation remains reportable");
  assert.equal(result.output.childSessionId, "fixture-child");
  assert.equal(result.output.liveEntries, 0);
  assert.deepEqual(f.requests.map((request) => request.method), ["session/projections", "session/prompt",
    "session/projections", "session/projections"]);
  const saved = JSON.parse(await readFile(receipt, "utf8"));
  assert.equal(saved.status, "observation_timeout");
  assert.equal(saved.cancelSent, false);
});

test("an observation API rejection remains a failed receipt instead of becoming an observation timeout", async (t) => {
  const f = await fixture(t, [{ asOfSeq: 0, values: {} }, { asOfSeq: 1, values: { codexWorkflow: {
    currentWorkflowId: "fixture-workflow", plan: { workflowId: "fixture-workflow", childSessionId: "fixture-child", status: "planning" },
  } } }], { rejectObservation: true });
  const receipt = join(f.directory, "rejected-projection.receipt.json");
  // This checks an API rejection after admission, so use the helper's normal
  // budget. The separate held-projection case exercises the 1000 ms deadline.
  const result = await f.run("prompt-until-child", ["--session", "new-test-session", "--text", "Fixture request",
    "--receipt", receipt]);
  assert.deepEqual(f.requests.map((request) => request.method), ["session/projections", "session/prompt",
    "session/projections", "session/projections"], "The negative control reached the selected projection rejection after one accepted prompt");
  assert.equal(result.code, 1);
  assert.equal(result.output.ok, false);
  assert.match(result.output.error, /Native API rejected: gateway\/internal; Selected projection could not be read/);
  assert.equal(result.output.outcome, undefined);
  const saved = JSON.parse(await readFile(receipt, "utf8"));
  assert.equal(saved.status, "failed");
  assert.match(saved.error, /Selected projection could not be read/);
});
