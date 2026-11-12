import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const cli = resolve("scripts/workflow.mjs");
const fixture = resolve("test/fixtures/fake-codex.mjs");

async function invoke(args: string[], home: string, input?: unknown, env: NodeJS.ProcessEnv = {}) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args, "--home", home], {
      env: { ...process.env, CODEX_WORKFLOW_CODEX_ARGS: JSON.stringify([fixture]), FAKE_CODEX_CONTROL_DIR: join(home, "fixture"), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("CLI exceeded 15 seconds: " + args.join(" "))); }, 15_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => { clearTimeout(timeout); accept({ code, stdout, stderr }); });
    child.stdin.end(input === undefined ? undefined : typeof input === "string" ? input : JSON.stringify(input));
  });
}

async function sandbox(run: (home: string, cwd: string) => Promise<void>) {
  const home = await mkdtemp(resolve(tmpdir(), "codex-workflow-cli-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "target.txt"), "Initial implementation.\n");
  try { await run(home, cwd); }
  finally {
    const response = await invoke(["status", "--cwd", cwd], home).catch(() => undefined);
    if (response?.code === 0) {
      const state = JSON.parse(response.stdout);
      if (state.workflowId && !["passed", "failed", "blocked", "cancelled"].includes(state.phase)) {
        await invoke(["cancel", "--workflow", state.workflowId], home);
      }
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function json(args: string[], home: string, input?: unknown, env: NodeJS.ProcessEnv = {}) {
  const response = await invoke(args, home, input, env);
  assert.equal(response.code, 0, response.stderr);
  const value = JSON.parse(response.stdout);
  for (const key of ["workflowId", "phase", "processState", "continuation", "nextAction", "result", "artifactPaths"]) {
    assert.ok(Object.hasOwn(value, key), "Missing public envelope field " + key);
  }
  assert.equal(typeof value.continuation.available, "boolean");
  return value;
}

async function settled(home: string, workflowId: string) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const state = await json(["status", "--workflow", workflowId, "--wait-ms", "1000"], home);
    if (state.processState !== "running") return state;
  }
  assert.fail("Worker did not settle within bounded status waits");
}

async function calls(home: string): Promise<Array<{ role: string; threadId: string; resume: boolean; prompt: string }>> {
  return (await readFile(join(home, "fixture/calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

test("offline doctor returns the stable JSON envelope without a model call", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "codex-workflow-cli-"));
  try {
    const result = await invoke(["doctor", "--offline"], home);
    assert.equal(result.code, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    for (const key of ["workflowId", "phase", "processState", "continuation", "nextAction", "result", "artifactPaths"]) {
      assert.ok(Object.hasOwn(value, key), key);
    }
    assert.equal(typeof value.continuation.available, "boolean");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("planner questions resume the original thread and hand the plan to the host", { timeout: 60_000 }, async () => {
  await sandbox(async (home, cwd) => {
    const started = await json(["start", "--cwd", cwd, "--stdin", "--codex-command", process.execPath], home,
      { task: "Implement the requested behavior", plannerModel: "fake-planner", plannerEffort: "high" }, { FAKE_CODEX_SCENARIO: "needs_input" });
    assert.equal(started.phase, "planning");
    const waiting = await settled(home, started.workflowId);
    assert.equal(waiting.phase, "waiting_input");
    await json(["continue", "--workflow", started.workflowId, "--stdin"], home, { answers: { scope: ["Small"] } }, { FAKE_CODEX_SCENARIO: "needs_input" });
    const ready = await settled(home, started.workflowId);
    assert.equal(ready.phase, "executing");
    assert.equal(ready.processState, "waiting");
    const planner = (await calls(home)).filter(call => call.role === "planner");
    assert.equal(planner.length, 2);
    assert.equal(planner[0]!.resume, false);
    assert.equal(planner[1]!.resume, true);
    assert.equal(planner[1]!.threadId, planner[0]!.threadId);
    assert.match(planner[1]!.prompt, /Small/);
    assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "Initial implementation.\n");
  });
});

test("a blocking review returns corrections and a changed resubmission starts a fresh reviewer thread", { timeout: 60_000 }, async () => {
  await sandbox(async (home, cwd) => {
    const started = await json(["start", "--cwd", cwd, "--stdin", "--codex-command", process.execPath], home,
      { task: "Correct target behavior" });
    const planned = await settled(home, started.workflowId);
    assert.equal(planned.phase, "executing", JSON.stringify(planned));
    const inputFile = join(home, "review.json");
    await writeFile(inputFile, JSON.stringify({ implementationSummary: "Implemented the requested behavior", changedFiles: ["target.txt"], testResults: "Focused check passed" }));
    await json(["review", "--workflow", started.workflowId, "--input", inputFile], home, undefined, { FAKE_CODEX_SCENARIO: "findings" });
    const fixing = await settled(home, started.workflowId);
    assert.equal(fixing.phase, "fixing");
    assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "Initial implementation.\n");
    await writeFile(join(cwd, "target.txt"), "Corrected implementation.\n");
    await json(["review", "--workflow", started.workflowId, "--stdin"], home,
      { implementationSummary: "Corrected the reviewer finding", changedFiles: ["target.txt"] }, { FAKE_CODEX_SCENARIO: "findings" });
    assert.equal((await settled(home, started.workflowId)).phase, "passed");
    const reviews = (await calls(home)).filter(call => call.role === "reviewer");
    assert.equal(reviews.length, 2);
    assert.equal(reviews[0]!.resume, false);
    assert.equal(reviews[1]!.resume, false);
    assert.notEqual(reviews[1]!.threadId, reviews[0]!.threadId);
    assert.match(reviews[0]!.prompt, /Focused check passed/);
  });
});

test("review-only returns findings without a planner or automatic workspace changes", { timeout: 30_000 }, async () => {
  await sandbox(async (home, cwd) => {
    const started = await json(["review-only", "--cwd", cwd, "--stdin", "--codex-command", process.execPath], home,
      { task: "Review target behavior", implementationSummary: "Existing implementation", changedFiles: ["target.txt"] }, { FAKE_CODEX_SCENARIO: "findings" });
    const result = await settled(home, started.workflowId);
    assert.equal(result.phase, "fixing");
    assert.equal(result.processState, "waiting");
    assert.deepEqual((await calls(home)).map(call => call.role), ["reviewer"]);
    assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "Initial implementation.\n");
    assert.equal((await json(["status", "--cwd", cwd], home)).workflowId, started.workflowId);
  });
});

test("nonblocking review waits for explicit accept or fix decisions", { timeout: 60_000 }, async () => {
  for (const decision of ["accept", "fix"]) await sandbox(async (home, cwd) => {
    const started = await json(["review-only", "--cwd", cwd, "--stdin", "--codex-command", process.execPath], home,
      { implementationSummary: "Existing implementation", changedFiles: ["target.txt"] }, { FAKE_CODEX_SCENARIO: "nonblocking" });
    assert.equal((await settled(home, started.workflowId)).phase, "waiting_review_decision");
    const result = await json(["decide", "--workflow", started.workflowId, "--stdin"], home, { decision, note: "User made an explicit decision" });
    assert.equal(result.phase, decision === "accept" ? "passed" : "fixing");
    assert.equal((await calls(home)).length, 1);
    assert.equal(await readFile(join(cwd, "target.txt"), "utf8"), "Initial implementation.\n");
  });
});

test("duplicate starts reuse the original workflow while a different task conflicts", { timeout: 30_000 }, async () => {
  await sandbox(async (home, cwd) => {
    const args = ["start", "--cwd", cwd, "--stdin", "--codex-command", process.execPath];
    const input = { task: "Implement one task" };
    const started = await json(args, home, input, { FAKE_CODEX_SCENARIO: "slow" });
    const duplicate = await json(args, home, input, { FAKE_CODEX_SCENARIO: "slow" });
    assert.equal(duplicate.workflowId, started.workflowId);
    const conflict = await invoke(args, home, { task: "A conflicting task" });
    assert.notEqual(conflict.code, 0);
    assert.match(conflict.stdout + conflict.stderr, /active|conflict|different|already/i);
    assert.equal((await settled(home, started.workflowId)).phase, "executing");
    assert.equal((await calls(home)).length, 1);
  });
});

test("new CLI invocations resume an interrupted planner on its original thread", { timeout: 30_000 }, async () => {
  await sandbox(async (home, cwd) => {
    const started = await json(["start", "--cwd", cwd, "--stdin", "--codex-command", process.execPath], home,
      { task: "Recover an interrupted plan", transientRetryBudgetMs: 0 }, { FAKE_CODEX_SCENARIO: "fail_once" });
    const interrupted = await settled(home, started.workflowId);
    assert.equal(interrupted.phase, "planning");
    assert.equal(interrupted.processState, "waiting");
    assert.equal(interrupted.continuation.available, true);
    await json(["resume", "--workflow", started.workflowId], home, undefined, { FAKE_CODEX_SCENARIO: "fail_once" });
    assert.equal((await settled(home, started.workflowId)).phase, "executing");
    const history = await calls(home);
    assert.equal(history.length, 2);
    assert.equal(history[1]!.resume, true);
    assert.equal(history[0]!.threadId, history[1]!.threadId);
  });
});

test("missing thread receipts and malformed model results fail closed without a new resume request", { timeout: 60_000 }, async () => {
  for (const scenario of ["missing_thread", "invalid_json", "invalid_schema"]) await sandbox(async (home, cwd) => {
    const started = await json(["start", "--cwd", cwd, "--stdin", "--codex-command", process.execPath], home,
      { task: "Reject unowned or malformed model results" }, { FAKE_CODEX_SCENARIO: scenario });
    const result = await settled(home, started.workflowId);
    assert.equal(result.phase, "failed", scenario);
    assert.equal(result.continuation.available, false, scenario);
    if (scenario === "missing_thread") assert.match(result.continuation.reason, /receipt|thread|start/i);
    const resumed = await invoke(["resume", "--workflow", started.workflowId], home);
    assert.notEqual(resumed.code, 0, scenario);
    assert.equal((await calls(home)).length, 1, scenario);
  });
});

test("invalid request JSON and invalid input schema return nonzero before any model call", async () => {
  await sandbox(async (home, cwd) => {
    const missing = await invoke(["status", "--cwd", cwd], home);
    assert.notEqual(missing.code, 0);
    await assert.rejects(readFile(join(home, "coord.sqlite")), { code: "ENOENT" });
    const args = ["start", "--cwd", cwd, "--stdin", "--codex-command", process.execPath];
    for (const input of ["{not JSON", { task: 42 }, { task: "Valid task", unknownField: true }]) {
      const result = await invoke(args, home, input);
      assert.notEqual(result.code, 0);
      assert.equal(JSON.parse(result.stdout).continuation.available, false);
    }
    await assert.rejects(readFile(join(home, "fixture/calls.jsonl")), { code: "ENOENT" });
  });
});

test("cancelled workers cannot publish late model results", { timeout: 30_000 }, async () => {
  await sandbox(async (home, cwd) => {
    const started = await json(["start", "--cwd", cwd, "--stdin", "--codex-command", process.execPath], home,
      { task: "Cancel this slow plan" }, { FAKE_CODEX_DELAY_MS: "1500" });
    for (let attempt = 0; attempt < 200; attempt++) {
      try { if ((await calls(home)).length) break; } catch {}
      await new Promise(accept => setTimeout(accept, 50));
    }
    assert.equal((await calls(home)).length, 1);
    const cancelled = await json(["cancel", "--workflow", started.workflowId], home);
    assert.equal(cancelled.phase, "cancelled");
    const result = await json(["status", "--workflow", started.workflowId, "--wait-ms", "1800"], home);
    assert.equal(result.phase, "cancelled");
    assert.equal(result.continuation.available, false);
    assert.equal(result.result.plan, null);
    assert.equal((await calls(home)).length, 1);
  });
});

test("workspace changes during review invalidate the result instead of publishing a pass", { timeout: 30_000 }, async () => {
  await sandbox(async (home, cwd) => {
    const started = await json(["review-only", "--cwd", cwd, "--stdin", "--codex-command", process.execPath], home,
      { implementationSummary: "Review this implementation", changedFiles: ["target.txt"] }, { FAKE_CODEX_DELAY_MS: "1500" });
    for (let attempt = 0; attempt < 200; attempt++) {
      try { if ((await calls(home)).length) break; } catch {}
      await new Promise(accept => setTimeout(accept, 50));
    }
    assert.equal((await calls(home)).length, 1);
    await writeFile(join(cwd, "target.txt"), "Changed while the reviewer was running.\n");
    const result = await settled(home, started.workflowId);
    assert.equal(result.phase, "failed");
    assert.equal(result.continuation.available, false);
    assert.match(JSON.stringify(result), /workspace|evidence|changed/i);
    assert.equal(result.result.review, null);
  });
});

test("simultaneous starts admit exactly one workflow and one planner request", { timeout: 30_000 }, async () => {
  await sandbox(async (home, cwd) => {
    const args = ["start", "--cwd", cwd, "--stdin", "--codex-command", process.execPath];
    const input = { task: "One concurrent task" };
    const results = await Promise.all([json(args, home, input, { FAKE_CODEX_SCENARIO: "slow" }), json(args, home, input, { FAKE_CODEX_SCENARIO: "slow" })]);
    assert.equal(results[0].workflowId, results[1].workflowId);
    const result = await settled(home, results[0].workflowId);
    assert.equal(result.phase, "executing", JSON.stringify(result));
    assert.equal((await calls(home)).length, 1);
  });
});

test("a turn timeout confirms cleanup and refuses a fabricated replacement request", { timeout: 30_000 }, async () => {
  await sandbox(async (home, cwd) => {
    const started = await json(["start", "--cwd", cwd, "--stdin", "--codex-command", process.execPath], home,
      { task: "Timeout a slow model request", turnTimeoutMs: 100, transientRetryBudgetMs: 0 }, { FAKE_CODEX_DELAY_MS: "10000" });
    const result = await settled(home, started.workflowId);
    assert.equal(result.phase, "failed", JSON.stringify(result));
    assert.equal(result.continuation.available, false);
    assert.match(JSON.stringify(result), /timeout/i);
    assert.notEqual((await invoke(["resume", "--workflow", started.workflowId], home)).code, 0);
    let history = [];
    try { history = await calls(home); } catch {}
    assert.ok(history.length <= 1, "A timeout cannot create a replacement request");
  });
});
