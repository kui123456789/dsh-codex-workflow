#!/usr/bin/env node
/** Native DSH Web smoke helper. Credentials stay in a temporary Playwright state
 * file; stdout contains only operator-readable summaries. No process is killed,
 * no profile is edited, and create/prompt run only when explicitly requested. */
import { readFile, writeFile, stat } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";

const [command = "help", ...args] = process.argv.slice(2);
const options = {};
let argumentError;
for (let index = 0; index < args.length; index += 2) {
  if (!args[index]?.startsWith("--") || args[index + 1] === undefined) { argumentError = new Error("Expected --option value pairs"); break; }
  options[args[index].slice(2)] = args[index + 1];
}
const output = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const requireOption = (name) => {
  if (!options[name]) throw new Error(`Missing --${name}`);
  return options[name];
};
function localUrl(value) {
  const url = new URL(value ?? "http://127.0.0.1:3080");
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) throw new Error("Only a clean HTTP loopback URL is allowed");
  return new URL(url.origin);
}
let base;
let operationReceipt;
let receiptFile;
function safeDiagnostic(value) {
  return String(value ?? "")
    .replace(/\(raw log: [^)]+\)/gi, "(raw log path withheld)")
    .replace(/(Bearer\s+)[^\s"'<>]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|api[_-]?key|key|secret)=)[^\s&"'<>]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|cookie|credentials)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"<>]*(?:userdata|credentials|[\\/]keys|[\\/]\.dsh[\\/]sessions)[^\s"<>]*/gi, "[private storage]")
    .slice(0, 600);
}
function temporaryStatePath(value) {
  const path = resolve(value ?? join(tmpdir(), `dsh-runtime-smoke-${randomUUID()}.state.json`));
  const inside = relative(resolve(tmpdir()), path);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Authentication state must stay inside the system temporary directory");
  return path;
}
async function cookieHeader() {
  const state = JSON.parse(await readFile(temporaryStatePath(requireOption("state")), "utf8"));
  const cookies = (state.cookies ?? []).filter((cookie) => cookie.domain === base.hostname
    && cookie.path === "/" && cookie.name.startsWith("dsh-auth-"));
  if (!cookies.length) throw new Error("No DSH cookie for this loopback authority in the state file");
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
async function rpc(method, payload, timeoutMs = 30_000) {
  const response = await fetch(new URL(`/api/${method}`, base), { method: "POST",
    headers: { "content-type": "application/json", cookie: await cookieHeader(), origin: base.origin },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload: { args: payload } }),
    signal: AbortSignal.timeout(Math.max(1, Math.trunc(timeoutMs))) });
  if (!response.ok) throw new Error(`Native API HTTP ${response.status}`);
  const envelope = await response.json();
  if (envelope.result?.ok !== true) {
    const code = envelope.result?.error?.code;
    const diagnostic = safeDiagnostic(envelope.result?.error?.message);
    const error = new Error(`Native API rejected: ${typeof code === "string" && /^[a-z0-9/_-]+$/i.test(code) ? code : "unknown_error"}${diagnostic ? `; ${diagnostic}` : ""}`);
    const createdId = diagnostic.match(/session ["']([a-z0-9-]{1,128})["']/i)?.[1];
    if (createdId) error.sessionId = createdId;
    throw error;
  }
  return envelope.result.value;
}
function browserCookie(header) {
  const parts = header.split(";").map((part) => part.trim());
  const equal = parts[0].indexOf("=");
  const attributes = Object.fromEntries(parts.slice(1).map((part) => {
    const cut = part.indexOf("=");
    return [part.slice(0, cut === -1 ? undefined : cut).toLowerCase(), cut === -1 ? true : part.slice(cut + 1)];
  }));
  const sameSite = String(attributes.samesite ?? "Lax").toLowerCase();
  return { name: parts[0].slice(0, equal), value: parts[0].slice(equal + 1), domain: base.hostname,
    path: String(attributes.path ?? "/"), expires: attributes.expires ? Math.floor(Date.parse(attributes.expires) / 1000) : -1,
    httpOnly: attributes.httponly === true, secure: attributes.secure === true,
    sameSite: sameSite === "strict" ? "Strict" : sameSite === "none" ? "None" : "Lax" };
}
const counters = (value) => Object.fromEntries(Object.entries(value ?? {}).filter(([key, entry]) =>
  /^(totalTokens|inputTokens|cachedInputTokens|cacheWriteInputTokens|outputTokens|reasoningOutputTokens)$/.test(key)
  && typeof entry === "number" && Number.isFinite(entry)));
function workflowSummary(record) {
  if (!record || typeof record !== "object") return undefined;
  return { workflowId: record.id, phase: record.phase, processState: record.processState,
    continuation: record.continuation, reviewCycles: record.reviewCycles,
    awaitingContinuation: record.retryState?.awaitingContinuation,
    tokenUsage: record.tokenUsage ? { scope: record.tokenUsage.scope, stage: record.tokenUsage.stage,
      total: counters(record.tokenUsage.total), last: counters(record.tokenUsage.last) } : undefined,
    observedUsage: record.observedUsage ? { scope: record.observedUsage.scope,
      sourceCount: record.observedUsage.sources?.length, observedSources: record.observedUsage.summary?.observedSources,
      missingSources: record.observedUsage.summary?.missingSources, total: counters(record.observedUsage.summary?.total) } : undefined };
}
function historySummary(records, projection) {
  const events = (records ?? []).map((record) => record.event).filter(Boolean);
  const toolCounts = {};
  const children = new Map();
  const rememberChild = (id, metadata = {}) => {
    if (typeof id !== "string") return;
    const previous = children.get(id) ?? { childSessionId: id, role: "unknown" };
    const label = metadata.label === undefined ? previous.label : safeDiagnostic(metadata.label).slice(0, 120);
    const inferredRole = /^Codex Planner\b/.test(label ?? "") ? "planner"
      : /^Codex Reviewer\b/.test(label ?? "") ? "reviewer"
        : label === "Mnemon idle checkpoint review" ? "mnemon_checkpoint_review" : "unknown";
    children.set(id, { ...previous, ...metadata, ...(label === undefined ? {} : { label }),
      role: metadata.role ?? (previous.role !== "unknown" ? previous.role : inferredRole) });
  };
  const workflows = new Map();
  let turns = 0;
  const errorCategories = new Set();
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === "turn/start") turns += 1;
    if (event.type === "tool/call" && /^codex_workflow_/.test(data.name ?? "")) toolCounts[data.name] = (toolCounts[data.name] ?? 0) + 1;
    if (event.type === "subagent/catalog") rememberChild(data.childId, { mode: data.mode, label: data.label,
      ...(typeof data.provider === "string" ? { provider: data.provider } : {}), sourceEventType: event.type });
    if (event.type === "dsh-codex-workflow/plan-updated") rememberChild(data.childSessionId, { role: "planner", codexWorkflow: true });
    if (event.type === "dsh-codex-workflow/review-start") rememberChild(data.childSessionId, { role: "reviewer", codexWorkflow: true });
    if (event.type === "tool/result") {
      for (const block of data.message?.content ?? []) {
        if (block.type !== "text" || typeof block.text !== "string") continue;
        try {
          const record = JSON.parse(block.text);
          if (record.id && record.dshSessionId && record.phase) workflows.set(record.id, workflowSummary(record));
        } catch { /* Do not print tool contents, model text or credentials. */ }
      }
    }
    const diagnostic = String(data.error?.message ?? data.reason?.error?.message ?? "");
    if (/quota|insufficient.*credit|balance|额度/i.test(diagnostic)) errorCategories.add("provider_quota_or_credit");
    if (/timeout|timed out/i.test(diagnostic)) errorCategories.add("timeout");
    if (/connection|network|stream.*disconnect/i.test(diagnostic)) errorCategories.add("connection_or_stream");
    if (diagnostic && errorCategories.size === 0) errorCategories.add("runtime_error");
  }
  const value = projection?.values?.codexWorkflow;
  rememberChild(value?.plan?.childSessionId, { role: "planner", codexWorkflow: true });
  rememberChild(value?.activeReview?.childSessionId, { role: "reviewer", codexWorkflow: true });
  return { eventCount: events.length, turnStarts: turns, codexToolCalls: toolCounts,
    childSessionIds: [...children.keys()], children: [...children.values()],
    codexChildSessionIds: [...children.values()].filter((child) => child.codexWorkflow === true).map((child) => child.childSessionId),
    workflows: [...workflows.values()], errorCategories: [...errorCategories],
    projection: value ? { workflowId: value.currentWorkflowId, planStatus: value.plan?.status,
      reviewProcessState: value.activeReview?.processState, reviewCount: value.reviews?.length } : undefined };
}

async function main() {
  if (argumentError) throw argumentError;
  if (["help", "--help", "-h"].includes(command)) {
    output({ commands: {
      "launch-plan": "[--cli-bin path] [--cwd directory] [--port 3080]: print spawn metadata; does not start a service",
      "auth-state": "--log stdout.log [--state TEMP/file.json]: privately exchange startup token for a Playwright cookie state",
      health: "[--state TEMP/file.json] [--pid spawnedPID]: report loopback HTTP status and exact process liveness",
      create: "--state TEMP/file.json (--cwd directory or --workspace id) [--session id] [--agent-preset id] [--receipt TEMP/file.json]: create one explicit smoke-test session",
      prompt: "--state TEMP/file.json --session id --text-file file (or --text text): admit one explicit prompt",
      "cancel-session": "--state TEMP/file.json --session id: stop this native parent turn; does not cancel its Codex workflow",
      "prompt-until-child": "--state TEMP/file.json --session new-test-id --text-file file --wait-live true [--timeout-ms 30000]: prompt once, wait for real Planner progress, then stop only that native parent turn",
      events: "--state TEMP/file.json --session parent-id [--child child-id] [--max-messages 64]: summarize only the selected session",
    }, shared: "--base-url http://127.0.0.1:3080; no profile mutations, no automatic shutdown, no secrets on stdout" });
    return;
  }
  base = localUrl(options["base-url"]);
  if (command === "launch-plan") {
    const bin = resolve(options["cli-bin"] ?? join(process.env.APPDATA ?? "", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
    await stat(bin);
    const pkg = JSON.parse(await readFile(join(bin, "..", "..", "package.json"), "utf8"));
    const port = Number(options.port ?? 3080);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid listen port");
    const stamp = `${Date.now()}-${process.pid}`;
    output({ executable: process.execPath, arguments: [bin, "web", "--host", "127.0.0.1", "--port", String(port), "--no-open"],
      cwd: resolve(options.cwd ?? process.cwd()), version: pkg.version,
      stdoutLog: join(tmpdir(), `dsh-runtime-smoke-${stamp}.stdout.log`), stderrLog: join(tmpdir(), `dsh-runtime-smoke-${stamp}.stderr.log`) });
    return;
  }
  if (command === "auth-state") {
    const log = await readFile(requireOption("log"), "utf8");
    const candidates = [...log.matchAll(/dsh web:\s+(http:\/\/[^\s)]+)/g)].map((match) => new URL(match[1]));
    const url = candidates.find((candidate) => candidate.origin === base.origin && candidate.searchParams.has("token"));
    if (!url) throw new Error("No matching loopback launch URL found in the supplied log");
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (response.status !== 303) throw new Error(`Launch-token exchange HTTP ${response.status}`);
    const cookies = response.headers.getSetCookie().map(browserCookie).filter((cookie) => cookie.name.startsWith("dsh-auth-") && cookie.path === "/");
    if (!cookies.length) throw new Error("Launch-token exchange returned no local DSH cookie");
    const path = temporaryStatePath(options.state);
    await writeFile(path, JSON.stringify({ cookies, origins: [] }), { encoding: "utf8", mode: 0o600 });
    output({ ok: true, baseUrl: base.origin, exchangeStatus: 303, cookieCount: cookies.length, stateFile: path });
    return;
  }
  if (command === "health") {
    const headers = options.state ? { cookie: await cookieHeader() } : {};
    const response = await fetch(base, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    let processAlive;
    if (options.pid) {
      const pid = Number(options.pid);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid process id");
      try { process.kill(pid, 0); processAlive = true; } catch { processAlive = false; }
    }
    output({ ok: response.status === 200, reachable: true, httpStatus: response.status, baseUrl: base.origin,
      ...(options.pid ? { requestedPid: Number(options.pid), processAlive } : {}), authenticated: response.status === 200 });
    return;
  }
  if (command === "create") {
    if (Boolean(options.cwd) === Boolean(options.workspace)) throw new Error("Supply exactly one of --cwd or --workspace");
    const cwd = options.cwd ? resolve(options.cwd) : undefined;
    if (cwd && !(await stat(cwd)).isDirectory()) throw new Error("The requested workspace is not a directory");
    // Match the installed UI: a fresh create omits sessionId. Supplying one
    // selects the host's persisted-identity/adoption path, not a UUID codec.
    const request = { ...(cwd ? { cwd } : { workspaceId: options.workspace }),
      ...(options.session ? { sessionId: options.session } : {}),
      ...(options["agent-preset"] ? { agentPreset: options["agent-preset"] } : {}) };
    operationReceipt = { operation: "create", baseUrl: base.origin, requestId: randomUUID(),
      request, startedAt: new Date().toISOString(), status: "pending" };
    receiptFile = temporaryStatePath(options.receipt ?? join(tmpdir(), `dsh-runtime-smoke-create-${operationReceipt.requestId}.receipt.json`));
    await writeFile(receiptFile, JSON.stringify(operationReceipt), { encoding: "utf8", mode: 0o600 });
    const result = await rpc("session/create", { request });
    operationReceipt = { ...operationReceipt, status: "created", sessionId: result.sessionId };
    await writeFile(receiptFile, JSON.stringify(operationReceipt), { encoding: "utf8", mode: 0o600 });
    output({ ok: true, sessionId: result.sessionId, cwd, workspaceId: options.workspace, agentPreset: result.agentPreset,
      receiptFile, requestFields: Object.keys(request) });
    return;
  }
  if (command === "prompt") {
    const text = options["text-file"] ? await readFile(options["text-file"], "utf8") : requireOption("text");
    if (!text.trim()) throw new Error("Prompt must not be empty");
    const requestId = randomUUID();
    const result = await rpc("session/prompt", { request: { requestId, sessionId: requireOption("session"), mode: "queue",
      content: [{ type: "text", text }], clientTimeZone: "Asia/Shanghai" } });
    output({ ok: true, accepted: result.accepted, requestId, sessionId: options.session,
      promptCharacters: text.length, promptSha256: createHash("sha256").update(text).digest("hex") });
    return;
  }
  if (command === "cancel-session") {
    const sessionId = requireOption("session");
    const result = await rpc("session/cancel", { request: { sessionId } });
    output({ ok: true, sessionId, accepted: result.accepted, scope: "native_parent_turn", workflowCancelled: false });
    return;
  }
  if (command === "prompt-until-child") {
    const sessionId = requireOption("session");
    if ((options["wait-live"] ?? "true") !== "true") throw new Error("The recovery drill requires --wait-live true; child creation alone cannot prove the Codex turn started");
    const timeoutMs = Number(options["timeout-ms"] ?? 30_000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error("timeout-ms must be between 100 and 60000");
    const text = options["text-file"] ? await readFile(options["text-file"], "utf8") : requireOption("text");
    if (!text.trim()) throw new Error("Prompt must not be empty");
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    const initial = await rpc("session/projections", { request: { sessionId } }, remaining());
    if (initial?.values?.codexWorkflow?.currentWorkflowId) throw new Error("Selected test session already has a Codex workflow; inspect or resume it instead of starting another");
    const requestId = randomUUID();
    operationReceipt = { operation: "prompt-until-child", baseUrl: base.origin, sessionId, requestId,
      promptCharacters: text.length, promptSha256: createHash("sha256").update(text).digest("hex"),
      startedAt: new Date().toISOString(), status: "pending", waitLive: true };
    receiptFile = temporaryStatePath(options.receipt ?? join(tmpdir(), `dsh-runtime-smoke-drill-${requestId}.receipt.json`));
    const save = async () => writeFile(receiptFile, JSON.stringify(operationReceipt), { encoding: "utf8", mode: 0o600 });
    await save();
    const admitted = await rpc("session/prompt", { request: { requestId, sessionId, mode: "queue",
      content: [{ type: "text", text }], clientTimeZone: "Asia/Shanghai" } }, remaining());
    if (!admitted.accepted) throw new Error("Selected session did not admit the prompt");
    let latest;
    while (Date.now() < deadline) {
      let projection;
      try { projection = await rpc("session/projections", { request: { sessionId } }, remaining()); }
      catch (error) {
        // A read that consumes the remaining observation budget is the same
        // deadline outcome as expiring between polls. Prompt/cancel outcomes
        // remain errors because their side effects may not be acknowledged.
        if (error?.name === "TimeoutError") break;
        throw error;
      }
      const plan = projection?.values?.codexWorkflow?.plan;
      latest = { workflowId: plan?.workflowId ?? projection?.values?.codexWorkflow?.currentWorkflowId,
        childSessionId: plan?.childSessionId, planStatus: plan?.status, asOfSeq: projection?.asOfSeq,
        liveEntries: Array.isArray(plan?.live) ? plan.live.length : 0 };
      if (plan?.status === "ready") {
        operationReceipt = { ...operationReceipt, ...latest, status: "completed_before_interrupt", cancelSent: false };
        await save();
        output({ ok: true, sessionId, outcome: "completed_before_interrupt", ...latest, cancelSent: false, receiptFile });
        return;
      }
      const live = (plan?.live ?? []).filter((entry) => ["tool", "message", "plan", "reasoning"].includes(entry.kind)
        && typeof entry.text === "string" && entry.text.length > 0);
      if (plan?.childSessionId && plan.status === "planning" && live.length > 0) {
        operationReceipt = { ...operationReceipt, ...latest, status: "interrupt_requested", cancelSent: true };
        await save();
        const stopped = await rpc("session/cancel", { request: { sessionId } }, remaining());
        operationReceipt = { ...operationReceipt, status: "parent_turn_interrupted", cancelAccepted: stopped.accepted };
        await save();
        output({ ok: true, sessionId, requestId, outcome: "parent_turn_interrupted", ...latest,
          liveKinds: [...new Set(live.map((entry) => entry.kind))], cancelAccepted: stopped.accepted,
          scope: "native_parent_turn", workflowCancelled: false, receiptFile });
        return;
      }
      if (plan?.status === "failed") {
        operationReceipt = { ...operationReceipt, ...latest, status: "planner_failed_before_interrupt", cancelSent: false };
        await save();
        output({ ok: true, sessionId, outcome: "planner_failed_before_interrupt", ...latest, cancelSent: false, receiptFile });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining())));
    }
    operationReceipt = { ...operationReceipt, ...latest, status: "observation_timeout", cancelSent: false };
    await save();
    output({ ok: true, sessionId, outcome: "observation_timeout", ...latest, cancelSent: false,
      promptSent: true, waitLive: true, receiptFile });
    return;
  }
  if (command === "events") {
    const sessionId = requireOption("session");
    const projection = await rpc("session/projections", { request: { sessionId } });
    if (!projection) throw new Error("Selected session has no projection baseline");
    const maxMessages = Number(options["max-messages"] ?? 64);
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 128) throw new Error("max-messages must be between 1 and 128");
    if (!Number.isSafeInteger(projection.asOfSeq)) throw new Error("Selected parent journal has no valid observation cut");
    const page = await rpc("session/page", { request: { address: { kind: "session", sessionId }, throughSeq: projection.asOfSeq, maxMessages } });
    const parent = { ok: true, sessionId, asOfSeq: projection.asOfSeq,
      hasMore: page.hasMore, ...historySummary(page.records, projection) };
    if (!options.child) { output(parent); return; }
    try {
      const childProjection = await rpc("session/projections", { request: { sessionId: options.child } });
      if (!childProjection || !Number.isSafeInteger(childProjection.asOfSeq)) throw new Error("Selected child journal has no valid observation cut");
      const childPage = await rpc("session/page", { request: { address: { kind: "subagent", parentSessionId: sessionId,
        childSessionId: options.child, mode: "one-shot" }, throughSeq: childProjection.asOfSeq, maxMessages } });
      const descriptor = childPage.records?.find((record) => record.event?.type === "subagent/descriptor")?.event.data;
      const metadata = descriptor ? { mode: descriptor.mode, provider: descriptor.provider,
        label: safeDiagnostic(descriptor.label).slice(0, 120) } : undefined;
      if (metadata) parent.children = parent.children.map((child) => child.childSessionId === options.child ? { ...child, ...metadata } : child);
      output({ ...parent, child: { childSessionId: options.child, asOfSeq: childProjection.asOfSeq,
        ...(metadata ? { descriptor: metadata } : {}), hasMore: childPage.hasMore, ...historySummary(childPage.records) } });
    } catch (error) {
      const diagnostic = safeDiagnostic(error instanceof Error ? error.message : "Child journal read failed");
      const lifecycle = /tool.*lifecycle|SessionFormatError|stored.*corrupt|session projection read failed/i.test(diagnostic);
      output({ ...parent, childSessionId: options.child,
        childDiagnosticCategory: lifecycle ? "session_format_tool_lifecycle" : "session_query_unavailable",
        childDiagnosticMessage: diagnostic });
    }
    return;
  }
  throw new Error("Unknown smoke-helper command");
}
main().catch(async (error) => {
  const message = safeDiagnostic(error instanceof Error ? error.message : "Smoke helper failed");
  if (operationReceipt && receiptFile) {
    operationReceipt = { ...operationReceipt, status: "failed", error: message,
      ...(error.sessionId ? { sessionId: error.sessionId } : {}) };
    await writeFile(receiptFile, JSON.stringify(operationReceipt), { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
  }
  output({ ok: false, error: message, ...(receiptFile ? { receiptFile,
    ...(operationReceipt?.request ? { requestFields: Object.keys(operationReceipt.request) } : {}),
    ...(operationReceipt?.sessionId ? { sessionId: operationReceipt.sessionId } : {}) } : {}),
    ...(error.sessionId ? { sessionId: error.sessionId } : {}),
    ...(operationReceipt?.request?.sessionId ? { requestedSessionId: operationReceipt.request.sessionId } : {}) });
  process.exitCode = 1;
});
