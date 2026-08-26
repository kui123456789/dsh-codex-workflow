// REAL lifecycle acceptance for dsh-codex-workflow 1.0.6+ (requires a Codex
// login and a working app-server; this is the online acceptance the fake-server
// unit tests cannot replace).
//
// Flow against the REAL Codex app-server:
//   client-1: create a durable Reviewer, run one silent structured-verdict turn
//             -> verdict parsed; unsubscribe; close client-1.
//   client-2 (FRESH): thread/read(includeTurns:true) -> the tested sequence must
//             have persisted the first turn as `completed` with the final
//             assistant JSON present (regression against THIS sequence, not a
//             proof of root cause; the backing compare experiment read the
//             completed turn back under the kill sequence too). Then
//             resumeThread(same id) -> run a SECOND structured turn -> verdict;
//             unsubscribe; close client-2.
//   client-3 (FRESH): thread/read -> BOTH turns `completed` with their final
//             JSON; same Reviewer thread id reused across rounds.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../lib/app-server.js";
import { REVIEW_OUTPUT_SCHEMA } from "../lib/schemas.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-lifecycle-accept-"));

function verdictText(verdict) {
  return verdict === "pass"
    ? JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" })
    : JSON.stringify({
        verdict: "changes_requested",
        findings: [{ severity: "high", blocking: true, title: "t", body: "b", file: null, line: null }],
        testGaps: [],
        summary: "changes needed",
      });
}

function promptFor(verdict) {
  return `You are a read-only code reviewer. Return EXACTLY this JSON object as your only output, no markdown fences, no commentary, no other text:\n${verdictText(verdict)}`;
}

function freshClient() {
  return new CodexAppServerClient({ command: "codex", requestTimeoutMs: 240_000, idleProcessMs: 0, quitGraceMs: 15_000, killGraceMs: 3_000 });
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

const logical = [];

try {
  // ---- Round 1 ----
  const c1 = freshClient();
  let reviewerId;
  try {
    reviewerId = await c1.startReviewerThread({ cwd, name: "DSH lifecycle acceptance reviewer" });
    const r1 = await c1.startTurn(reviewerId, { prompt: promptFor("pass"), outputSchema: REVIEW_OUTPUT_SCHEMA, silentReview: true });
    if (r1.kind !== "completed" || r1.status !== "completed") throw new Error(`round 1 unexpected: ${JSON.stringify(r1)}`);
    const verdict1 = JSON.parse(r1.text);
    if (verdict1.verdict !== "pass") throw new Error(`round 1 verdict was ${verdict1.verdict}`);
    const unsub1 = await c1.unsubscribeThread(reviewerId);
    logical.push({ round: 1, reviewerId, verdict: verdict1.verdict, unsubscribe: unsub1 });
  } finally {
    await c1.stop(); // graceful close: EOF -> app-server flushes -> exits
  }

  // ---- FRESH read after client-1 closed ----
  const c2 = freshClient();
  let p1;
  try {
    p1 = lastTurnSummary(await c2.readThread(reviewerId, true));
    if (!p1 || p1.status !== "completed") throw new Error(`round 1 was NOT persisted as completed: ${JSON.stringify(p1)}`);
    if (!p1.finalAgentText || !p1.finalAgentText.includes('"verdict":"pass"')) {
      throw new Error(`round 1 final assistant JSON was lost: ${JSON.stringify(p1)}`);
    }

    // ---- Round 2 on the SAME Reviewer id ----
    await c2.resumeThread(reviewerId, cwd);
    const r2 = await c2.startTurn(reviewerId, { prompt: promptFor("changes_requested"), outputSchema: REVIEW_OUTPUT_SCHEMA, silentReview: true });
    if (r2.kind !== "completed" || r2.status !== "completed") throw new Error(`round 2 unexpected: ${JSON.stringify(r2)}`);
    const verdict2 = JSON.parse(r2.text);
    if (verdict2.verdict !== "changes_requested") throw new Error(`round 2 verdict was ${verdict2.verdict}`);
    const p2mid = lastTurnSummary(await c2.readThread(reviewerId, true));
    if (!p2mid || p2mid.status !== "completed" || !p2mid.finalAgentText?.includes('"verdict":"changes_requested"')) {
      throw new Error(`round 2 was NOT persisted as completed while client-2 still open: ${JSON.stringify(p2mid)}`);
    }
    const unsub2 = await c2.unsubscribeThread(reviewerId);
    logical.push({ round: 2, reviewerId, verdict: verdict2.verdict, unsubscribe: unsub2 });
  } finally {
    await c2.stop();
  }

  // ---- FRESH read after client-2 closed: both turns completed ----
  const c3 = freshClient();
  try {
    const thread = await c3.readThread(reviewerId, true);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    if (turns.length < 2) throw new Error(`expected >=2 persisted turns, got ${turns.length}`);
    const s1 = lastTurnSummary({ turns: turns.slice(0, 1) });
    const s2 = lastTurnSummary({ turns: turns.slice(1) });
    if (s1?.status !== "completed" || !s1.finalAgentText?.includes('"verdict":"pass"')) throw new Error(`turn 1 not durable: ${JSON.stringify(s1)}`);
    if (s2?.status !== "completed" || !s2.finalAgentText?.includes('"verdict":"changes_requested"')) throw new Error(`turn 2 not durable: ${JSON.stringify(s2)}`);
    logical.push({ finalCheck: { persistedTurns: turns.length, turn1: s1?.status, turn2: s2?.status, reviewerReused: true } });
  } finally {
    await c3.stop();
  }

  console.log("LIFECYCLE_ACCEPTANCE_OK", JSON.stringify(logical, null, 2));
  process.exit(0);
} catch (error) {
  console.error("LIFECYCLE_ACCEPTANCE_FAIL", error);
  console.error("LOGICAL", JSON.stringify(logical, null, 2));
  process.exit(1);
}
