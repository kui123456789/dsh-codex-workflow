// REAL lifecycle acceptance for dsh-codex-workflow 1.0.11 (requires a Codex
// login and a working app-server; this is the online acceptance the fake-server
// unit tests cannot replace).
//
// What is proven here, against the REAL Codex App Server:
//   Probes (protocol-level):
//   - Planner: a durable visible Plan-mode turn persists as a readable `plan`
//     item (real native clarification -> continue round included) with NO JSON
//     envelope; the ephemeral conversion fork never lands in the history.
//   - Ephemeral invisibility (HARD gate): thread/list is REQUIRED; the fork
//     must never be listed while its conversion turn is ACTIVE (polled) nor
//     after unsubscribe. A missing thread/list fails the gate (no silent
//     pass), and a listed fork at any point fails it.
//   - Teardown during normalization (deterministic): the fork turn must have
//     STARTED (onStarted gate) before stop(); the conversion then settles
//     with the stopped error — no timing assumptions.
//   REAL PLUGIN segments (through WorkflowManager / the background callback,
//   the persisted state machine and the bridge relay — not client probes):
//   - DSH-led planned workflow: a NARROW workspace (one buggy greet function
//     with a passing positive test) is staged BEFORE planning; manager.start
//     plans ONLY that single defect -> real review/start on the ORIGINAL
//     planner task with the ONLY change being a failing admin regression test
//     (real pre-review run MUST fail; its output is the honest round-1 test
//     results) -> the FIRST verdict must be changes_requested -> DSH fixes
//     ONLY the order bug (real post-fix run MUST pass) -> re-review on the
//     SAME task id -> pass within the fixed 3-round limit.
//     Asserts reviewerThreadId === plannerThreadId at every round, persisted
//     history holds plan + both reviews with no JSON envelopes, and
//     `dsh-codex-workflow show --json` reports pluginVersion 1.0.11 with the
//     same reviewer task id (runtime version probe).
//   - Codex-bridge workflow: a REAL source task is created; startExternalPlan
//     binds it as the originating task; submit drives the REAL background
//     callback which validates the source, RESUMES THE SAME task and appends
//     the review; the verdict is staged, enqueued, applied by the bridge
//     runtime and relayed to the (fake) DSH session. Asserts
//     reviewerThreadId === codexThreadId, delivery + followup, and the source
//     history holds the readable review with no JSON envelope.
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CodexAppServerClient } from "../lib/app-server.js";
import { CodexCliAuditDispatcher } from "../lib/codex-cli-audit.js";
import { BridgeStore } from "../lib/bridge-store.js";
import { BridgeRuntime } from "../lib/bridge-runtime.js";
import { PLANNER_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA } from "../lib/schemas.js";
import { ALIGN_OUTPUT_SCHEMA } from "../lib/review-authority.js";
import { WorkflowStore } from "../lib/store.js";
import { newRequestId } from "../lib/bridge-protocol.js";
import { WorkflowManager } from "../lib/workflow.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-lifecycle-accept-"));
const acceptanceModel = process.env.DSH_CODEX_LIFECYCLE_MODEL?.trim() || undefined;
const acceptanceEffort = process.env.DSH_CODEX_LIFECYCLE_EFFORT?.trim() || "low";
const acceptanceTimeoutMs = Number(process.env.DSH_CODEX_LIFECYCLE_TIMEOUT_MS || 600_000);

if (!Number.isInteger(acceptanceTimeoutMs) || acceptanceTimeoutMs < 30_000) {
  throw new Error(`DSH_CODEX_LIFECYCLE_TIMEOUT_MS must be an integer >= 30000 (got ${process.env.DSH_CODEX_LIFECYCLE_TIMEOUT_MS})`);
}

const CLI_PATH = join(fileURLToPath(new URL("..", import.meta.url)), "lib", "bridge-cli.js");

function modelOptions() {
  return {
    ...(acceptanceModel ? { model: acceptanceModel } : {}),
    effort: acceptanceEffort,
  };
}

const NARROW_TASK = "修复 greet(name) 的行为缺陷：当 name 为 'admin' 时当前返回 'Denied'，应返回 'Hello, admin'。允许累计修改两个文件：test/greet.test.ts 新增精确回归断言 greet('admin') === 'Hello, admin'；src/greet.ts 把现有 admin 分支的 return 'Denied' 精确替换为 return `Hello, ${name}`（保留普通 fallback 分支）。不修改其他文件。没有其他 API 面、配置或发布要求。任务已包含全部决策，不要提问，直接输出计划。";
const PLANNER_TASK = "实现一个安全的读写模块：输入校验、错误处理与单元测试。技术栈固定为 TypeScript/Node（fs/promises、严格类型），交付形态为独立库包（公共 API、错误类型、配置、单元测试，无 CLI），平台范围覆盖 Windows + POSIX（含符号链接拒绝与原子替换）。任务已包含全部产品决策，直接输出计划，不要提问。";

const MIN_PLAN_TEXT = 40;

function assertReadyPlanText(text) {
  if (typeof text !== "string" || text.trim().length < MIN_PLAN_TEXT) {
    throw new Error(`planner visible reply is not a complete readable plan (${typeof text === "string" ? text.length : "?"} chars): ${typeof text === "string" ? text.slice(0, 200) : text}`);
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && "status" in parsed && "planMarkdown" in parsed) {
        throw new Error(`planner visible reply leaked the structured envelope: ${trimmed.slice(0, 400)}`);
      }
    } catch (error) {
      if (error instanceof Error && /leaked the structured envelope/.test(error.message)) throw error;
    }
  }
}

function assertPersistedReadablePlan(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const last = turns.at(-1);
  if (!last) throw new Error(`no persisted planner turn found`);
  const items = Array.isArray(last.items) ? last.items : [];
  const finalTexts = items
    .filter((it) => it && (it.type === "plan" || it.type === "agentMessage") && typeof it.text === "string" && String(it.text).trim().length > 0)
    .map((it) => ({ type: it.type, text: String(it.text) }));
  if (finalTexts.length === 0) {
    throw new Error(`persisted Planner turn has no readable "plan"/"agentMessage" item: ${JSON.stringify(items.map((it) => it?.type).slice(0, 6))}`);
  }
  const finalText = finalTexts.at(-1).text;
  if (finalText.trim().length < MIN_PLAN_TEXT) {
    throw new Error(`persisted plan reply is not a complete plan (${finalText.length} chars): ${finalText.slice(0, 200)}`);
  }
  assertNoJsonEnvelope(thread);
}

function plannerPrompt() {
  return `You are the planning gate of a DSH coding workflow. Inspect the current workspace read-only and produce a DECISION-COMPLETE implementation plan for the task below. Do not edit files.

Your visible reply stays in Codex Desktop as a single complete, readable Markdown plan (goal, changes, files, verification) in Chinese — Codex renders Plan-mode output as a plan item. Do NOT output JSON; do not use code fences around the whole plan.
TASK: ${PLANNER_TASK}`;
}

function clarificationPrompt() {
  return `You are the planning gate of a DSH coding workflow. Before you can plan the task "${PLANNER_TASK}", you MUST ask the user exactly one clarifying question (via the native input request) about the deployment target. Ask it now and wait.`;
}

function continuationPrompt(answers) {
  return `Continue the existing plan using these user answers. Treat the answers as input for the plan, NOT as something to acknowledge: your ONLY final visible message must be the COMPLETE plan itself (goal, changes, files, verification) as readable Chinese Markdown; Codex renders Plan-mode output as a plan item. Do NOT output JSON; do NOT reply with a summary or acknowledgement.\n\nANSWERS:\n${JSON.stringify(answers)}`;
}

function plannerConversionPrompt(visibleReply) {
  return `Convert this planner visible reply into the enforced planner JSON schema. Output ONLY the JSON object matching the schema: status "ready" with planMarkdown containing the visible plan's full text verbatim (wrap it in a <proposed_plan> block internally if you like — that wrapper is an internal planMarkdown format, NOT part of the visible reply).\n${visibleReply}`;
}

function visibleReviewPrompt(verdict) {
  const text = verdict === "pass"
    ? "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: ok"
    : "VERDICT: changes_requested\nFINDINGS:\n- [high, blocking] t (file unknown): b\nTEST GAPS: none\nSUMMARY: changes needed";
  return `You are a read-only code reviewer. Reply with EXACTLY this readable review as your only output, no other text:\n${text}`;
}

function conversionPrompt(visibleReview) {
  return `Convert this review into the enforced JSON schema. Output ONLY the JSON object matching the schema:\n${visibleReview}`;
}

function freshClient() {
  return new CodexAppServerClient({
    command: "codex",
    requestTimeoutMs: acceptanceTimeoutMs,
    rpcTimeoutMs: Math.min(acceptanceTimeoutMs, 60_000),
    idleProcessMs: 0,
    quitGraceMs: 15_000,
    killGraceMs: 3_000,
  });
}

function lastTurnSummary(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const last = turns.at(-1);
  if (!last) return null;
  const agentTexts = (Array.isArray(last.items) ? last.items : [])
    .filter((it) => it && typeof it.text === "string" && it.text.length > 0)
    .map((it) => String(it.text));
  return {
    status: last.status ?? null,
    completedAt: last.completedAt ?? null,
    finalAgentText: agentTexts.at(-1) ?? null,
    turnId: last.id ?? null,
  };
}

/** The persisted task history must NEVER contain a structured-output envelope. */
function assertNoJsonEnvelope(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (const turn of turns) {
    const texts = (Array.isArray(turn.items) ? turn.items : [])
      .map((it) => (it && typeof it.text === "string" ? String(it.text) : ""))
      .join("\n");
    for (const line of texts.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          if ("status" in parsed && "planMarkdown" in parsed) {
            throw new Error(`persisted Planner history contains the raw JSON envelope: ${trimmed.slice(0, 400)}`);
          }
          if ("verdict" in parsed && "findings" in parsed) {
            throw new Error(`persisted Reviewer history contains a JSON verdict: ${trimmed.slice(0, 400)}`);
          }
        }
      } catch (error) {
        if (error instanceof Error && /persisted .* history contains/.test(error.message)) throw error;
      }
    }
  }
}

async function runVisiblePlannerTurn(client, threadId, prompt, maxRounds = 12) {
  let result = await client.startTurn(threadId, { prompt, planMode: true, ...modelOptions() });
  for (let round = 0; result.kind === "needs_input"; round += 1) {
    if (round >= maxRounds) {
      throw new Error(`planner kept requesting native clarification after ${maxRounds} rounds: ${JSON.stringify(result)}`);
    }
    const answers = Object.fromEntries(result.request.questions.map((q) => [q.id, [q.options?.[0]?.label ?? "继续"]]));
    result = await client.continueTurn(result, answers);
  }
  if (result.kind !== "completed" || result.status !== "completed") {
    throw new Error(`visible planner unexpected: ${JSON.stringify(result)}`);
  }
  return result;
}

async function waitFor(predicate, timeoutMs = acceptanceTimeoutMs * 6, stepMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Diagnostics for real-turn failures: dump the persisted task history texts
 * (bounded) so acceptance iterations can see exactly what the server rolled
 * out instead of guessing. */
async function dumpThreadTexts(label, client, threadId) {
  try {
    const thread = await client.readThread(threadId, true);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const summaries = turns.map((turn) => {
      const items = Array.isArray(turn?.items) ? turn.items : [];
      const texts = items
        .map((it) => (typeof it?.text === "string" ? String(it.text) : typeof it?.review === "string" ? String(it.review) : ""))
        .filter((t) => t.trim().length > 0)
        .map((t) => t.slice(0, 200));
      return { id: turn?.id, status: turn?.status, finalTexts: texts.slice(-2) };
    });
    console.error(`[${label}] persisted turns:`, JSON.stringify(summaries, null, 2).slice(0, 3000));
  } catch (error) {
    console.error(`[${label}] dump failed:`, String(error));
  }
}

/** Minimal fake DSH agent for the REAL plugin segments: records followups and
 * exposes the session header the plugin's store keys on. */
function makeLiveAgent(id, cwd) {
  const followups = [];
  const events = [];
  const agent = {
    id,
    session: { header: { cwd }, events },
    followup: (message) => {
      followups.push(message);
      events.push({
        type: "agent/inbox/spliced",
        seq: events.length,
        time: Date.now(),
        data: { target: "next-turn", start: 0, deleteCount: 0, inserted: [message] },
      });
    },
  };
  return { agent, followups };
}

function makeExec(sessionId, dir, messages) {
  return {
    agent: { id: sessionId, session: { header: { cwd: dir } } },
    signal: new AbortController().signal,
    deferContext: (message) => messages.push(message),
  };
}

function runNpmTest(cwd) {
  const options = { cwd, encoding: "utf8", windowsHide: true, timeout: 120_000 };
  return process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm test"], options)
    : spawnSync("npm", ["test"], options);
}

/** Collect every file path under a workspace (relative, forward-slash, sorted)
 * — used to assert the demo-smoke workspace contains EXACTLY the planned
 * files and nothing else. */
function collectWorkspaceFiles(dir) {
  const out = [];
  const walk = (sub) => {
    for (const entry of readdirSync(sub)) {
      const full = join(sub, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full.slice(dir.length + 1).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Plugin-shaped config for the REAL WorkflowManager segments. */
function managerConfig(storageDir) {
  return {
    codexCommand: "codex",
    autoTriggerMode: "complex",
    plannerModel: acceptanceModel ?? "",
    reviewerModel: acceptanceModel ?? "",
    plannerEffort: acceptanceEffort,
    reviewerEffort: acceptanceEffort,
    maxReviewCycles: 3,
    maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65536,
    bridgePollMs: 200,
    bridgeMaxPayloadBytes: 1048576,
    callbackTimeoutMs: acceptanceTimeoutMs,
    callbackMaxAttempts: 2,
    callbackRetryBaseMs: 300,
    leaseTtlMs: 60_000,
    turnTimeoutMs: acceptanceTimeoutMs,
    rpcTimeoutMs: Math.min(acceptanceTimeoutMs, 60_000),
    idleProcessMs: 0,
    terminalRelayTimeoutMs: 60_000,
    storageDir,
  };
}

function makeAudit(storageDir, invocations = []) {
  const bridgeDir = join(storageDir, "bridge");
  mkdirSync(bridgeDir, { recursive: true });
  const reviewSchemaFile = join(bridgeDir, "review-schema.json");
  const alignmentSchemaFile = join(bridgeDir, "alignment-schema.json");
  writeFileSync(reviewSchemaFile, `${JSON.stringify(REVIEW_OUTPUT_SCHEMA)}\n`, "utf8");
  writeFileSync(alignmentSchemaFile, `${JSON.stringify(ALIGN_OUTPUT_SCHEMA)}\n`, "utf8");
  return new CodexCliAuditDispatcher({
    command: "codex",
    reviewSchemaFile,
    alignmentSchemaFile,
    timeoutMs: acceptanceTimeoutMs,
    // Real `codex exec --json` emits warnings, progress items and tool events
    // before the final agent message. Keep a finite bound, but large enough
    // for a genuine review context rather than the unit-test default.
    maxOutputBytes: 4 * 1024 * 1024,
    onSpawn: (args) => invocations.push([...args]),
  });
}

function assertCliAuditArguments(invocations, label) {
  const visible = invocations.filter((args) => args.includes("resume"));
  const ephemeral = invocations.filter((args) => args.includes("--ephemeral"));
  if (visible.length === 0) throw new Error(`${label}: no visible codex exec resume invocation was observed`);
  if (ephemeral.length === 0) throw new Error(`${label}: no ephemeral normalization/alignment invocation was observed`);
  for (const args of visible) {
    if (args.includes("--output-schema")) throw new Error(`${label}: visible review unexpectedly used --output-schema`);
    if (!args.includes(`model_reasoning_effort="${acceptanceEffort}"`)) {
      throw new Error(`${label}: visible review omitted reviewer effort ${acceptanceEffort}: ${JSON.stringify(args)}`);
    }
    const modelIndex = args.indexOf("-m");
    if (acceptanceModel) {
      if (modelIndex < 0 || args[modelIndex + 1] !== acceptanceModel) {
        throw new Error(`${label}: visible review omitted reviewer model ${acceptanceModel}: ${JSON.stringify(args)}`);
      }
    } else if (modelIndex >= 0) {
      throw new Error(`${label}: visible review should use the CLI default model when reviewerModel is blank`);
    }
  }
  for (const args of ephemeral) {
    if (args.includes("resume")) throw new Error(`${label}: ephemeral audit unexpectedly resumed a visible task`);
    if (!args.includes("--output-schema")) throw new Error(`${label}: ephemeral audit omitted its output schema`);
    if (!args.includes('model_reasoning_effort="low"')) {
      throw new Error(`${label}: ephemeral audit did not force low effort: ${JSON.stringify(args)}`);
    }
    const modelIndex = args.indexOf("-m");
    if (acceptanceModel) {
      if (modelIndex < 0 || args[modelIndex + 1] !== acceptanceModel) {
        throw new Error(`${label}: ephemeral audit omitted reviewer model ${acceptanceModel}: ${JSON.stringify(args)}`);
      }
    } else if (modelIndex >= 0) {
      throw new Error(`${label}: ephemeral audit should use the CLI default model when reviewerModel is blank`);
    }
  }
  return {
    visibleInvocations: visible.length,
    ephemeralInvocations: ephemeral.length,
    model: acceptanceModel ?? "CLI default (-m omitted)",
    visibleEffort: acceptanceEffort,
    ephemeralEffort: "low",
  };
}

const logical = [];

// Durable task ids this acceptance creates; the FINAL thread/list SET
// assertion allows exactly these as NEW visible tasks (plus P1 below). The
// baseline is captured before anything is created and thread/list is
// REQUIRED: unavailable -> acceptance fails, never a silent pass.
let taskListBaseline = null;
let livePlannerTaskId = null;
let bridgeSourceThreadId = null;

try {
  // ---- Planner round 1: visible ready reply + ephemeral conversion ----
  const cP = freshClient();
  let plannerThreadId;
  try {
    const baselineIds = await cP.listThreadIds();
    if (baselineIds === undefined) {
      throw new Error("thread/list unavailable — the single-task acceptance cannot be certified (no silent pass)");
    }
    taskListBaseline = baselineIds;
    plannerThreadId = await cP.startThread({ cwd, name: "DSH lifecycle acceptance planner", ...(acceptanceModel ? { model: acceptanceModel } : {}) });
    const visible = await runVisiblePlannerTurn(cP, plannerThreadId, plannerPrompt());
    if (visible.itemType !== "plan") throw new Error(`planner visible final item is not a "plan" item (itemType=${visible.itemType}): ${JSON.stringify(visible)}`);
    assertReadyPlanText(visible.text);
    const converted = await cP.normalizeInFork({
      threadId: plannerThreadId,
      cwd,
      prompt: plannerConversionPrompt(visible.text),
      ...(acceptanceModel ? { model: acceptanceModel } : {}),
      outputSchema: PLANNER_OUTPUT_SCHEMA,
    });
    if (converted.kind !== "completed" || converted.status !== "completed") throw new Error(`planner conversion unexpected: ${JSON.stringify(converted)}`);
    const plan = JSON.parse(converted.text);
    if (plan.status !== "ready" || typeof plan.planMarkdown !== "string") throw new Error(`planner conversion produced no ready plan: ${converted.text}`);
    const thread = await cP.readThread(plannerThreadId, true);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    if (turns.length !== 1) throw new Error(`expected exactly 1 persisted planner turn, got ${turns.length}`);
    assertPersistedReadablePlan(thread);
    logical.push({ planner: { round: 1, threadId: plannerThreadId, finalItemType: visible.itemType, persistedReadablePlan: true, persistedTurns: turns.length, noJsonEnvelope: true, planStatus: plan.status } });
  } finally {
    await cP.stop();
  }

  // ---- Ephemeral invisibility (HARD gate, thread/list REQUIRED): the fork
  //      must never appear in the visible task directory — while its
  //      conversion turn is ACTIVE (polled several times during the real model
  //      turn) and after unsubscribe. thread/list unavailability is a FAILURE
  //      (no silent pass), and a listed fork at ANY point fails the gate.
  const cE = freshClient();
  try {
    const forkId = await cE.forkThread(plannerThreadId, cwd);
    // Poll the directory DURING the fork's activity (the real conversion turn
    // runs for seconds, giving a genuine window) and a little past it.
    let listedDuringActivity = [];
    let directoryUnavailable = false;
    let pollActive = true;
    const pollDeadline = Date.now() + 120_000;
    const poller = (async () => {
      while (pollActive && Date.now() < pollDeadline) {
        try {
          const ids = await cE.listThreadIds();
          if (ids === undefined) {
            directoryUnavailable = true;
            return;
          }
          if (ids.includes(forkId)) listedDuringActivity.push(Date.now());
        } catch {
          return; // client stopped or RPC failure: polling is over
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    })();
    const forkTurn = await cE.startTurn(forkId, { prompt: plannerConversionPrompt(`TASK: ${PLANNER_TASK}`), outputSchema: PLANNER_OUTPUT_SCHEMA, conversion: true, ...modelOptions() });
    if (forkTurn.kind !== "completed" || forkTurn.status !== "completed") throw new Error(`fork turn unexpected: ${JSON.stringify(forkTurn)}`);
    await new Promise((resolve) => setTimeout(resolve, 800)); // final poll beats after unsubscribe
    if (directoryUnavailable) throw new Error("thread/list unavailable — the ephemeral-visibility gate cannot be certified (no silent pass)");
    if (listedDuringActivity.length > 0) {
      throw new Error(`ephemeral fork ${forkId} was listed ${listedDuringActivity.length} time(s) WHILE ITS CONVERSION TURN WAS ACTIVE — the fork leaked into the visible task list`);
    }
    await cE.unsubscribeThread(forkId);
    for (let i = 0; i < 2; i += 1) {
      const ids = await cE.listThreadIds();
      if (ids === undefined) throw new Error("thread/list became unavailable after unsubscribe — cannot certify invisibility");
      if (ids.includes(forkId)) throw new Error(`ephemeral fork ${forkId} is listed by thread/list after unsubscribe`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    pollActive = false;
    await poller;
    let readAfterUnsubscribe = "unreadable";
    try {
      await cE.readThread(forkId, false);
      readAfterUnsubscribe = "readable(not-listed-direct-id)";
    } catch {
      readAfterUnsubscribe = "unreadable";
    }
    logical.push({ ephemeralFork: { threadId: forkId, neverListedDuringActivity: true, listedInDirectoryAfterUnsubscribe: false, threadListProbe: "required-and-provided", readAfterUnsubscribe } });
  } finally {
    await cE.stop();
  }

  // ---- Planner round 2: REAL native clarification -> continue -> convert,
  //      on the SAME workflow task (resume P1 — never a second visible task) ----
  const cC = freshClient();
  try {
    await cC.resumeThread(plannerThreadId, cwd);
    const paused = await cC.startTurn(plannerThreadId, { prompt: clarificationPrompt(), planMode: true, ...modelOptions() });
    if (paused.kind !== "needs_input") throw new Error(`expected a native clarification, got ${JSON.stringify(paused)}`);
    let pending = paused;
    let resumed;
    for (let round = 0; round < 12; round += 1) {
      const answers = Object.fromEntries(pending.request.questions.map((q) => [q.id, ["局域网部署；信息已完整，请直接生成最终计划"]]));
      resumed = await cC.continueTurn(pending, answers);
      if (resumed.kind !== "needs_input") break;
      pending = resumed;
    }
    if (!resumed) throw new Error("clarification resume produced no result");
    if (resumed.kind !== "completed" || resumed.status !== "completed") throw new Error(`clarification resume unexpected: ${JSON.stringify(resumed)}`);
    if (resumed.itemType !== undefined && resumed.itemType !== "plan" && resumed.itemType !== "agentMessage") {
      throw new Error(`clarification planner final item has an unexpected type (itemType=${resumed.itemType})`);
    }
    assertReadyPlanText(resumed.text);
    const converted2 = await cC.normalizeInFork({
      threadId: plannerThreadId,
      cwd,
      prompt: plannerConversionPrompt(resumed.text),
      ...(acceptanceModel ? { model: acceptanceModel } : {}),
      outputSchema: PLANNER_OUTPUT_SCHEMA,
    });
    if (converted2.kind !== "completed" || converted2.status !== "completed") throw new Error(`planner conversion 2 unexpected: ${JSON.stringify(converted2)}`);
    const plan2 = JSON.parse(converted2.text);
    if (plan2.status !== "ready") throw new Error(`planner conversion 2 produced no ready plan`);
    const thread2Read = await cC.readThread(plannerThreadId, true);
    const thread2Turns = Array.isArray(thread2Read?.turns) ? thread2Read.turns : [];
    if (thread2Turns.length !== 2) {
      throw new Error(`expected 2 persisted turns (plan + clarified plan) on the ONE workflow task, got ${thread2Turns.length}`);
    }
    assertPersistedReadablePlan(thread2Read);
    logical.push({ planner: { round: 2, clarification: true, continued: true, sameTask: true, finalItemType: resumed.itemType, persistedReadablePlan: true, persistedTurns: thread2Turns.length, noJsonEnvelope: true } });
  } finally {
    await cC.stop();
  }

  // ================= REAL PLUGIN SEGMENT 1: DSH-led planned workflow
  // (changes_requested -> DSH fixes -> pass on the SAME original planner task)
  const wsLive = mkdtempSync(join(tmpdir(), "dsh-lifecycle-ws-live-"));
  const homeLive = mkdtempSync(join(tmpdir(), "dsh-lifecycle-home-live-"));
  const storageDirLive = join(homeLive, "storages", "dsh-codex-workflow");
  mkdirSync(join(storageDirLive, "bridge"), { recursive: true });
  const workflowStoreLive = new WorkflowStore(storageDirLive);
  const codexLive = freshClient();
  const liveAuditInvocations = [];
  const auditLive = makeAudit(storageDirLive, liveAuditInvocations);
  const managerLive = new WorkflowManager(workflowStoreLive, codexLive, managerConfig(storageDirLive), auditLive, undefined, auditLive);
  let liveRecord;
  async function liveReview(workflowId, input, exec, label) {
    try {
      return await managerLive.review(workflowId, input, exec);
    } catch (error) {
      const rec = await workflowStoreLive.load(workflowId);
      await dumpThreadTexts(label, codexLive, rec?.plannerThreadId);
      throw error;
    }
  }
  try {
    const messages = [];
    const exec = makeExec("session-live1", wsLive, messages);
    // 1) Narrow workspace FIRST: the Planner must inspect a real, small
    //    project — one buggy function plus one passing positive test. The
    //    failing admin regression is added in the implementation round as the
    //    reviewable evidence.
    mkdirSync(join(wsLive, "src"), { recursive: true });
    mkdirSync(join(wsLive, "test"), { recursive: true });
    writeFileSync(join(wsLive, "package.json"), JSON.stringify({
      name: "dsh-lifecycle-greet",
      private: true,
      type: "module",
      scripts: { test: "node --test test/greet.test.ts" },
    }, null, 2), "utf8");
    writeFileSync(join(wsLive, "src", "greet.ts"), [
      "export function greet(name: string): string {",
      "  if (name === 'admin') return 'Denied';",
      "  return `Hello, ${name}`;",
      "}",
    ].join("\n"), "utf8");
    writeFileSync(join(wsLive, "test", "greet.test.ts"), [
      "import { test } from 'node:test';",
      "import { strict as assert } from 'node:assert';",
      "import { greet } from '../src/greet.ts';",
      "",
      "test('other users are greeted', () => {",
      "  assert.equal(greet('alice'), 'Hello, alice');",
      "});",
    ].join("\n"), "utf8");
    // 2) The narrow Planner task: ONE decision-complete defect fix. This
    //    Planner must plan for the greet project, never the wide library task.
    liveRecord = await managerLive.start({ task: NARROW_TASK, ...(acceptanceModel ? { plannerModel: acceptanceModel } : {}) }, exec);
    for (let round = 0; liveRecord.phase === "waiting_input" && round < 12; round += 1) {
      const answers = Object.fromEntries(liveRecord.questions.map((q) => [q.id, [q.options?.[0]?.label ?? "按推荐选项继续并直接输出计划"]]));
      liveRecord = await managerLive.continue(liveRecord.id, answers, exec);
    }
    if (liveRecord.phase !== "executing") throw new Error(`real planner did not reach executing (phase=${liveRecord.phase})`);
    const taskId = liveRecord.plannerThreadId;
    livePlannerTaskId = taskId;
    if (!taskId) throw new Error("real planner produced no plannerThreadId");
    // 3) Implementation round: the ONLY change is the admin regression test
    //    that EXPOSES the defect; the buggy code stays untouched. The suite is
    //    run for REAL before the review: it must FAIL, and its actual output
    //    becomes the honest (failing) testResults — never hardcoded.
    writeFileSync(join(wsLive, "test", "greet.test.ts"), [
      "import { test } from 'node:test';",
      "import { strict as assert } from 'node:assert';",
      "import { greet } from '../src/greet.ts';",
      "",
      "test('admin gets a greeting, not a denial', () => {",
      "  assert.equal(greet('admin'), 'Hello, admin');",
      "});",
      "",
      "test('other users are greeted', () => {",
      "  assert.equal(greet('alice'), 'Hello, alice');",
      "});",
    ].join("\n"), "utf8");
    const failingRun = runNpmTest(wsLive);
    const failingOutput = String(failingRun.stdout || failingRun.stderr);
    const failingSummary = failingOutput.split("\n").filter((l) => /pass|fail/.test(l)).slice(-6).join(" | ") || failingOutput.slice(0, 300);
    if (failingRun.status === 0) {
      throw new Error(`round 1 fixture error: the admin regression test unexpectedly PASSES against the defect — the scenario is broken`);
    }
    liveRecord = await liveReview(liveRecord.id, {
      implementationSummary: "实现轮唯一变更：新增 greet('admin') 回归测试，明确暴露检查顺序缺陷（当前返回 Denied）；源代码未变更",
      changedFiles: ["test/greet.test.ts"],
      testResults: failingSummary,
    }, exec);
    if (liveRecord.reviewerThreadId !== taskId) {
      throw new Error(`real planned review did NOT reuse the original planner task (reviewerThreadId=${liveRecord.reviewerThreadId}, plannerThreadId=${taskId})`);
    }
    if (liveRecord.reviewCycles !== 1) throw new Error(`real review consumed ${liveRecord.reviewCycles} cycles (expected 1)`);
    if (liveRecord.phase !== "fixing") {
      throw new Error(`round 1 (defect intact + failing regression test, real output: ${failingSummary}) did not produce changes_requested (phase=${liveRecord.phase}); no verdict is ever manufactured`);
    }
    // 4) Round 2, EXACTLY per the accepted task: replace the existing admin
    //    branch's `return 'Denied'` with `return `Hello, ${name}``, keep the
    //    ordinary fallback, and do not touch any other file (the admin
    //    regression test already landed in round 1). Real-run must exit 0.
    writeFileSync(join(wsLive, "src", "greet.ts"), [
      "export function greet(name: string): string {",
      "  if (name === 'admin') return `Hello, ${name}`;",
      "  return `Hello, ${name}`;",
      "}",
    ].join("\n"), "utf8");
    const fixRun = runNpmTest(wsLive);
    const fixPassed = fixRun.status === 0;
    const fixLines = String(fixRun.stdout).split("\n").filter((l) => /pass|fail/.test(l)).slice(-4).join(" | ");
    const lastTestOutput = fixPassed ? `npm test all green (${fixLines || "0 fail"})` : `npm test FAILED: ${String(fixRun.stderr || fixRun.stdout).slice(0, 300)}`;
    if (!fixPassed) {
      throw new Error(`round 2 fixture error: the FIXED code does not pass its own regression test: ${lastTestOutput}`);
    }
    liveRecord = await liveReview(liveRecord.id, {
      implementationSummary: "按计划完成修复：admin 分支的 return 'Denied' 已精确替换为 return `Hello, ${name}`（模板串），普通 fallback 保留；累计变更 = 回归测试（首轮）+ src/greet.ts 单行（本轮）；未修改其他文件；测试实际运行通过（" + lastTestOutput + "）",
      changedFiles: ["src/greet.ts", "test/greet.test.ts"],
      testResults: lastTestOutput,
    }, exec);
    if (liveRecord.reviewerThreadId !== taskId) {
      throw new Error(`repair round did NOT reuse the original planner task (reviewerThreadId=${liveRecord.reviewerThreadId})`);
    }
    if (liveRecord.phase !== "passed") {
      // Round 2 must close the loop. A third submission would repeat the SAME
      // workspace/evidence (no-change gate) — instead surface the Reviewer's
      // real findings and fail the acceptance; no verdict is manufactured.
      await dumpThreadTexts("R2-findings", codexLive, taskId);
      throw new Error(`round 2 did not pass (phase=${liveRecord.phase}, cycles=${liveRecord.reviewCycles}, last test: ${lastTestOutput}); the Reviewer's real findings are dumped above — no third identical submission`);
    }
    if (liveRecord.reviewCycles !== 2) {
      throw new Error(`expected exactly 2 review cycles (changes_requested then pass), got ${liveRecord.reviewCycles}`);
    }
// The DSH session received the state-machine messages (fixing guidance and
    // the passing report) through the plugin's deferContext.
    const messageTexts = JSON.stringify(messages);
    if (!/requested changes|fix/.test(messageTexts)) throw new Error("the fixing outcome message was not relayed to the DSH session");

    // Persisted-history audit on the ORIGINAL task: plan + both reviews, no
    // JSON envelopes anywhere.
    const liveThread = await codexLive.readThread(taskId, true);
    const liveTurns = Array.isArray(liveThread?.turns) ? liveThread.turns : [];
    if (liveTurns.length < 3) throw new Error(`expected plan + 2 review turns on the shared task, got ${liveTurns.length}`);
    assertNoJsonEnvelope(liveThread);

    // RUNTIME version probe: the plugin's own CLI reports 1.0.11 and the SAME
    // reviewer task id against the scratch DSH_HOME the segments wrote.
    const show = spawnSync(process.execPath, [CLI_PATH, "show", "--workflow", liveRecord.id, "--json"], {
      env: { ...process.env, DSH_HOME: homeLive },
      encoding: "utf8",
      windowsHide: true,
    });
    if (show.status !== 0) throw new Error(`dsh-codex-workflow show failed: ${String(show.stderr || show.stdout)}`);
    let showJson;
    try {
      showJson = JSON.parse(show.stdout);
    } catch {
      throw new Error(`dsh-codex-workflow show produced no JSON: ${show.stdout.slice(0, 400)}`);
    }
    if (showJson.pluginVersion !== "1.0.11") throw new Error(`pluginVersion is ${showJson.pluginVersion}, expected 1.0.11`);
    if (showJson.reviewerCodexTaskId !== taskId) throw new Error(`show reports reviewer task ${showJson.reviewerCodexTaskId}, expected the original planner task ${taskId}`);
    const cliArguments = assertCliAuditArguments(liveAuditInvocations, "planned workflow");

    logical.push({
      realPluginPlanned: {
        taskId,
        reviewerReusedOriginalTask: true,
        round1: "changes_requested",
        round2: "passed",
        reviewCycles: liveRecord.reviewCycles,
        persistedTurns: liveTurns.length,
        noJsonEnvelope: true,
        pluginVersion: showJson.pluginVersion,
        reviewerCodexTaskId: showJson.reviewerCodexTaskId,
        cliArguments,
      },
    });
  } finally {
    await managerLive.stop();
    await auditLive.stop();
    await codexLive.stop();
  }

  // ================= REAL PLUGIN SEGMENT 2: Codex-bridge background callback
  // (review appended to the ORIGINAL source task; verdict back to DSH)
  const wsBridge = mkdtempSync(join(tmpdir(), "dsh-lifecycle-ws-bridge-"));
  mkdirSync(join(wsBridge, "src"), { recursive: true });
  writeFileSync(join(wsBridge, "src", "search.ts"), "export function search() { return []; }\n");
  const homeBridge = mkdtempSync(join(tmpdir(), "dsh-lifecycle-home-bridge-"));
  const storageDirBridge = join(homeBridge, "storages", "dsh-codex-workflow");
  mkdirSync(join(storageDirBridge, "bridge"), { recursive: true });
  const bridgeStore = new BridgeStore(storageDirBridge);
  const workflowStoreBridge = new WorkflowStore(join(homeBridge, "workflows"));
  const codexBridge = freshClient();
  const bridgeAuditInvocations = [];
  const callbackBridge = makeAudit(storageDirBridge, bridgeAuditInvocations);
  const managerBridge = new WorkflowManager(workflowStoreBridge, codexBridge, managerConfig(storageDirBridge), callbackBridge, bridgeStore, callbackBridge);
  const { agent: agentBridge, followups: followupsBridge } = makeLiveAgent("session-live2", wsBridge);
  let desktopOpenCalls = 0;
  const runtimeBridge = new BridgeRuntime(bridgeStore, { get: () => agentBridge, list: () => [agentBridge] }, {
    pollMs: 200,
    storageDir: storageDirBridge,
    manager: managerBridge,
    workflowStore: workflowStoreBridge,
    desktopOpener: { open: async () => { desktopOpenCalls += 1; } },
  });
  runtimeBridge.start();
  let bridgeRecord;
  try {
    // A REAL visible source task: this is the originating Codex task the
    // 1.0.8 review must be appended to.
    const sourceThreadId = await codexBridge.startThread({ cwd: wsBridge, name: "DSH lifecycle bridge source task", ...(acceptanceModel ? { model: acceptanceModel } : {}) });
    bridgeSourceThreadId = sourceThreadId;
    bridgeRecord = await managerBridge.startExternalPlan({
      version: 1,
      kind: "dispatch_plan",
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      codexThreadId: sourceThreadId,
      target: { cwd: wsBridge, dshSessionId: "session-live2" },
      task: "实现搜索功能（含单元测试）",
      planMarkdown: "<proposed_plan>\n实现搜索功能并补充单元测试\n</proposed_plan>",
      assumptions: [],
    }, agentBridge);
    const execBridge = makeExec("session-live2", wsBridge, []);
    await managerBridge.submit(bridgeRecord.id, {
      implementationSummary: "实现了搜索功能及单元测试",
      changedFiles: ["src/search.ts"],
      testResults: "测试全部通过",
    }, execBridge);
    // The REAL background callback validates the source, resumes the SAME task,
    // appends the review, converts it in an ephemeral fork, stages the verdict
    // and the bridge runtime delivers it back to the DSH session.
    await waitFor(async () => {
      const r = await workflowStoreBridge.load(bridgeRecord.id);
      return r?.submissionState === "delivered" || r?.submissionState === "failed";
    }, acceptanceTimeoutMs * 4);
    const done = await workflowStoreBridge.load(bridgeRecord.id);
    if (!done) throw new Error("bridge workflow record disappeared during the background review");
    if (done.submissionState === "failed") throw new Error(`bridge background review failed: ${done.submissionError}`);
    if (done.submissionState !== "delivered") throw new Error(`bridge submission did not deliver (state=${done.submissionState})`);
    if (!done.reviewerThreadId || done.reviewerThreadId !== done.codexThreadId) {
      throw new Error(`bridge reviewerThreadId=${done.reviewerThreadId} must equal codexThreadId=${done.codexThreadId} (the ORIGINAL task)`);
    }
    if (!done.latestReview) throw new Error("no verdict was applied to the bridge workflow");
    if (followupsBridge.length === 0) throw new Error("no verdict followup was delivered to the DSH session");
    if (!/Codex review/.test(followupsBridge.map((f) => JSON.stringify(f)).join("\n"))) {
      throw new Error("the relayed followup is not the review outcome message");
    }
    // The ORIGINAL source task persisted the readable review with no envelope.
    const sourceThread = await codexBridge.readThread(done.codexThreadId, true);
    const sourceTurns = Array.isArray(sourceThread?.turns) ? sourceThread.turns : [];
    if (sourceTurns.length < 1) throw new Error("the source task persisted no review turn");
    assertNoJsonEnvelope(sourceThread);
    if (desktopOpenCalls !== 0) throw new Error(`bridge audit opened Codex Desktop ${desktopOpenCalls} time(s)`);
    const cliArguments = assertCliAuditArguments(bridgeAuditInvocations, "bridge callback");
    logical.push({
      realPluginBridge: {
        codexThreadId: done.codexThreadId,
        reviewerReusedSourceTask: true,
        submissionState: done.submissionState,
        verdict: done.latestReview.verdict,
        followupDelivered: true,
        sourcePersistedReadableReview: true,
        noJsonEnvelope: true,
        desktopOpenCalls,
        cliArguments,
      },
    });
  } finally {
    await runtimeBridge.stop();
    await managerBridge.stop();
    await callbackBridge.stop();
    await codexBridge.stop();
    bridgeStore.close();
  }

  // ================= REAL PLUGIN SEGMENT 3: demo-smoke acceptance
  // (REAL Codex plans the exact demo-smoke: three files, EXACTLY two
  // node:test cases, CLI verified by REAL commands; the REAL Reviewer runs
  // through the REAL review-authority alignment/reconciliation chain; DSH
  // adds no fourth file; the workflow must pass without demanding automated
  // tests the plan deliberately excluded).
  const DEMO_SMOKE_TASK = "新建 demo-smoke 最小 ESM 项目：恰好三个文件 package.json（\"type\":\"module\"、scripts.test=\"node --test\"、private）、src/hello.mjs（导出 greet(name)：无参或空字符串返回 'hello, world'，否则返回 'hello, <name>'；支持直接以 node src/hello.mjs [name] 运行）、test/hello.test.mjs（恰好两条 node:test 用例：默认问候语与带名字问候语，不增加参数化或额外抽象）。零第三方依赖，不安装任何包。CLI 行为以真实命令验证：node src/hello.mjs 输出 'hello, world'、node src/hello.mjs Codex 输出 'hello, Codex'。不得修改其他任何文件，不做任何超出上述范围的扩展（不增加边界/空白/CLI 自动化测试，不创建 README）。任务已包含全部决策，不要提问，直接输出计划。";
  const wsDemo = mkdtempSync(join(tmpdir(), "dsh-lifecycle-ws-demo-"));
  const homeDemo = mkdtempSync(join(tmpdir(), "dsh-lifecycle-home-demo-"));
  const storageDirDemo = join(homeDemo, "storages", "dsh-codex-workflow");
  mkdirSync(join(storageDirDemo, "bridge"), { recursive: true });
  const workflowStoreDemo = new WorkflowStore(storageDirDemo);
  const codexDemo = freshClient();
  const demoAuditInvocations = [];
  const auditDemo = makeAudit(storageDirDemo, demoAuditInvocations);
  const managerDemo = new WorkflowManager(workflowStoreDemo, codexDemo, managerConfig(storageDirDemo), auditDemo, undefined, auditDemo);
  let demoRecord;
  /** Durable demo-smoke task id, registered in the final thread/list gate. */
  let demoSmokeTaskId;
  async function demoReview(workflowId, input, exec, label) {
    try {
      return await managerDemo.review(workflowId, input, exec);
    } catch (error) {
      const rec = await workflowStoreDemo.load(workflowId);
      await dumpThreadTexts(label, codexDemo, rec?.plannerThreadId);
      throw error;
    }
  }
  try {
    const messages = [];
    const exec = makeExec("session-live3", wsDemo, messages);
    demoRecord = await managerDemo.start({ task: DEMO_SMOKE_TASK, ...(acceptanceModel ? { plannerModel: acceptanceModel } : {}) }, exec);
    for (let round = 0; demoRecord.phase === "waiting_input" && round < 12; round += 1) {
      const answers = Object.fromEntries(demoRecord.questions.map((q) => [q.id, [q.options?.[0]?.label ?? "按推荐选项继续并直接输出计划"]]));
      demoRecord = await managerDemo.continue(demoRecord.id, answers, exec);
    }
    if (demoRecord.phase !== "executing") throw new Error(`real demo-smoke planner did not reach executing (phase=${demoRecord.phase})`);
    const demoTaskId = demoRecord.plannerThreadId;
    demoSmokeTaskId = demoTaskId;
    if (!demoTaskId) throw new Error("real demo-smoke planner produced no plannerThreadId");
    // DSH implementation — EXACTLY the three planned files, nothing else.
    mkdirSync(join(wsDemo, "src"), { recursive: true });
    mkdirSync(join(wsDemo, "test"), { recursive: true });
    writeFileSync(join(wsDemo, "package.json"), JSON.stringify({
      name: "demo-smoke",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    }, null, 2), "utf8");
    writeFileSync(join(wsDemo, "src", "hello.mjs"), [
      "export function greet(name) {",
      "  if (name === undefined || name === '') return 'hello, world';",
      "  return `hello, ${name}`;",
      "}",
      "",
      "if (process.argv[1] && process.argv[1].endsWith(import.meta.url.split('/').pop())) {",
      "  console.log(greet(process.argv[2]));",
      "}",
    ].join("\n"), "utf8");
    writeFileSync(join(wsDemo, "test", "hello.test.mjs"), [
      "import { test } from 'node:test';",
      "import { strict as assert } from 'node:assert';",
      "import { greet } from '../src/hello.mjs';",
      "",
      "test('default greeting', () => {",
      "  assert.equal(greet(), 'hello, world');",
      "});",
      "",
      "test('named greeting', () => {",
      "  assert.equal(greet('Codex'), 'hello, Codex');",
      "});",
    ].join("\n"), "utf8");
    // REAL command verification: npm test plus the two CLI invocations.
    const demoTestRun = runNpmTest(wsDemo);
    const demoCliDefault = spawnSync(process.execPath, [join(wsDemo, "src", "hello.mjs")], { encoding: "utf8", windowsHide: true });
    const demoCliNamed = spawnSync(process.execPath, [join(wsDemo, "src", "hello.mjs"), "Codex"], { encoding: "utf8", windowsHide: true });
    if (demoTestRun.status !== 0) throw new Error(`demo-smoke npm test failed: ${String(demoTestRun.stderr || demoTestRun.stdout).slice(0, 300)}`);
    if (demoCliDefault.stdout.trim() !== "hello, world") throw new Error(`demo-smoke CLI default: ${JSON.stringify(demoCliDefault.stdout)}`);
    if (demoCliNamed.stdout.trim() !== "hello, Codex") throw new Error(`demo-smoke CLI named: ${JSON.stringify(demoCliNamed.stdout)}`);
    const demoTestLines = String(demoTestRun.stdout).split("\n").filter((l) => /pass|fail|tests /.test(l)).slice(-6).join(" | ") || "exit 0";
    // REAL review round(s): the authority chain (alignment fork -> possible
    // reconciliation -> re-alignment) runs on the REAL Reviewer output. The
    // demo contract (exactly two tests, CLI verified by real commands) may
    // tempt the Reviewer into demanding automated coverage of ''/whitespace/
    // CLI — that is exactly the overreach the authority must refuse. DSH
    // performs NO further file changes between rounds.
    let demoReviews = 0;
    for (let demo = 1; demo <= 3; demo += 1) {
      demoReviews += 1;
      demoRecord = await demoReview(demoRecord.id, {
        implementationSummary: `demo-smoke 实现：恰好三文件；npm test 全绿（${demoTestLines}）；node src/hello.mjs → hello, world；node src/hello.mjs Codex → hello, Codex（真实命令输出即 CLI 行为证据）；未增加任何其他文件`,
        changedFiles: ["package.json", "src/hello.mjs", "test/hello.test.mjs"],
        testResults: `${demoTestLines}; CLI default="${demoCliDefault.stdout.trim()}"; CLI named="${demoCliNamed.stdout.trim()}"`,
      }, exec, `demo-smoke-round-${demo}`);
      if (demoRecord.reviewerThreadId !== demoTaskId) {
        throw new Error(`real demo-smoke review did NOT reuse the original planner task`);
      }
      if (demoRecord.phase === "passed") break;
      if (demoRecord.phase === "blocked") throw new Error(`real demo-smoke became blocked: ${demoRecord.error}`);
      if (demoRecord.phase === "waiting_review_decision") {
        // Non-blocking-only outcome: accept as-is; this ships the review as-is.
        demoRecord = await managerDemo.decide(demoRecord.id, { decision: "accept" }, exec);
        break;
      }
      // fixing: DSH must NOT add tests/files (contract forbids it); only the
      // authority chain may correct the Reviewer between rounds. A genuine
      // defect finding would demand a real fix — surface the real findings.
      if (demo === 3 && demoRecord.phase !== "passed") {
        await dumpThreadTexts("demo-smoke-final", codexDemo, demoTaskId);
        throw new Error(`real demo-smoke did not reach passed after 3 rounds (phase=${demoRecord.phase}); real findings dumped above`);
      }
    }
    if (demoRecord.phase !== "passed") {
      throw new Error(`real demo-smoke finished at phase ${demoRecord.phase} (cycles=${demoRecord.reviewCycles}, reviews=${demoReviews})`);
    }
    // The workspace still contains EXACTLY the three planned files.
    const demoFiles = collectWorkspaceFiles(wsDemo);
    const expectedDemoFiles = ["package.json", "src/hello.mjs", "test/hello.test.mjs"];
    if (JSON.stringify(demoFiles) !== JSON.stringify(expectedDemoFiles)) {
      throw new Error(`demo-smoke workspace drifted from the exact three-file plan: ${JSON.stringify(demoFiles)}`);
    }
    const demoThread = await codexDemo.readThread(demoTaskId, true);
    assertNoJsonEnvelope(demoThread);
    const cliArguments = assertCliAuditArguments(demoAuditInvocations, "demo-smoke workflow");
    logical.push({
      realPluginDemoSmoke: {
        plannerTaskId: demoTaskId,
        reviewerReusedOriginalTask: demoRecord.reviewerThreadId === demoTaskId,
        finalPhase: demoRecord.phase,
        reviewCycles: demoRecord.reviewCycles,
        reviewRounds: demoReviews,
        npmTestPassed: true,
        cliDefaultOutput: demoCliDefault.stdout.trim(),
        cliNamedOutput: demoCliNamed.stdout.trim(),
        exactThreeFiles: true,
        authorityCorrected: demoRecord.latestReviewConflict && demoRecord.latestReviewConflict.reconciled === true,
        noJsonEnvelope: true,
        cliArguments,
      },
    });
  } finally {
    await managerDemo.stop();
    await auditDemo.stop();
    await codexDemo.stop();
  }

  // ---- Teardown during normalization (deterministic), on the SAME workflow
//      task — NO extra visible reviewer task is ever created. ----
  const c4 = freshClient();
  try {
    await c4.resumeThread(plannerThreadId, cwd);
    const r4 = await c4.startTurn(plannerThreadId, { prompt: visibleReviewPrompt("pass"), ...modelOptions() });
    if (r4.kind !== "completed" || r4.status !== "completed") throw new Error(`teardown visible unexpected: ${JSON.stringify(r4)}`);
    let forkStarted = null;
    const longReview = `VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: ${"长".repeat(8000)}`;
    const converting = c4.normalizeInFork({
      threadId: plannerThreadId,
      cwd,
      prompt: conversionPrompt(longReview),
      ...(acceptanceModel ? { model: acceptanceModel } : {}),
      outputSchema: REVIEW_OUTPUT_SCHEMA,
      onStarted: (started) => { forkStarted = started; },
    });
    const settledPromise = converting.then(
      () => "resolved",
      (error) => `rejected: ${String(error)}`,
    );
    const startDeadline = Date.now() + 30_000;
    while (forkStarted === null) {
      if (Date.now() > startDeadline) {
        throw new Error(`the conversion fork never started within 30s (settled=${await settledPromise}); the in-flight probe cannot fake a pass`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const startedAt = Date.now();
    await c4.stop();
    const settled = await settledPromise;
    const elapsed = Date.now() - startedAt;
    if (!/rejected:.*stopped/.test(settled)) throw new Error(`teardown did not settle the in-flight conversion with the stopped error: ${settled}`);
    if (elapsed > 30_000) throw new Error(`teardown settle took too long: ${elapsed}ms`);
    logical.push({
      teardownDuringNormalization: {
        inFlightAtStop: true,
        forkThreadStarted: forkStarted.threadId,
        forkTurnStarted: forkStarted.turnId,
        settled: "rejected(stopped)",
        elapsedMs: elapsed,
      },
    });
  } finally {
    await c4.stop();
  }

  // ---- FINAL thread/list SET assertion (required): compared to the
  //      directory baseline captured BEFORE this run, the ONLY new visible
  //      tasks may be the exact workflow tasks this acceptance created — the
  //      probe workflow task (P1), the live planned workflow task, the
  //      bridge source task and the demo-smoke workflow task. No extra
  //      Reviewer, clarification or normalization task; no ephemeral fork may
  //      be listed. ----
  const cF = freshClient();
  try {
    const after = await cF.listThreadIds();
    if (after === undefined) {
      throw new Error("thread/list unavailable — the single-task acceptance cannot be certified (no silent pass)");
    }
    const before = new Set(taskListBaseline);
    const afterSet = new Set(after);
    const newIds = after.filter((id) => !before.has(id));
    const expected = new Set([plannerThreadId, livePlannerTaskId, bridgeSourceThreadId, demoSmokeTaskId].filter(Boolean));
    const unexpected = newIds.filter((id) => !expected.has(id));
    if (unexpected.length > 0) {
      throw new Error(`unexpected visible tasks created during the acceptance: ${unexpected.join(", ")}`);
    }
    for (const id of expected) {
      if (!afterSet.has(id)) throw new Error(`workflow task ${id} is missing from thread/list`);
    }
    logical.push({
      finalTaskList: {
        threadListRequired: true,
        baselineCount: before.size,
        afterCount: after.size,
        newVisibleTasks: newIds.sort(),
        expectedWorkflowTasks: [...expected].sort(),
        noExtraVisibleTask: true,
      },
    });
  } finally {
    await cF.stop();
  }

  console.log("LIFECYCLE_ACCEPTANCE_OK", JSON.stringify(logical, null, 2));
  process.exit(0);
} catch (error) {
  console.error("LIFECYCLE_ACCEPTANCE_FAIL", error);
  console.error("LOGICAL", JSON.stringify(logical, null, 2));
  process.exit(1);
}
