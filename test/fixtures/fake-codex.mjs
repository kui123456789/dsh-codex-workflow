import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const value = option => args[args.indexOf(option) + 1];
const schema = JSON.parse(await readFile(value("--output-schema"), "utf8"));
const role = schema.properties.verdict ? "reviewer" : "planner";
const control = process.env.FAKE_CODEX_CONTROL_DIR;
if (!control) throw new Error("FAKE_CODEX_CONTROL_DIR is required");
await mkdir(control, { recursive: true });
let count = 0;
try { count = Number(await readFile(join(control, role + ".count"), "utf8")); } catch {}
count++;
await writeFile(join(control, role + ".count"), String(count));
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const resume = args.includes("resume");
const threadId = resume ? args.find(arg => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(arg)) : randomUUID();
if (!threadId) throw new Error("Resume requires the exact original thread UUID");
await appendFile(join(control, "calls.jsonl"), JSON.stringify({ role, count, threadId, resume, prompt, args }) + "\n");
const scenario = process.env.FAKE_CODEX_SCENARIO ?? "happy";
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
if (scenario !== "missing_thread") emit({ type: "thread.started", thread_id: threadId });
if (scenario === "fail_once" && count === 1) {
  process.stderr.write("temporary local transport interruption\n");
  process.exit(1);
}
const delay = Number(process.env.FAKE_CODEX_DELAY_MS ?? (scenario === "slow" ? 1500 : 0));
if (delay > 0) await new Promise(accept => setTimeout(accept, delay));
let result;
if (role === "planner") {
  const ask = scenario === "needs_input" && count === 1;
  result = { status: ask ? "needs_input" : "ready", planMarkdown: "1. Implement the requested change.\n2. Run the relevant tests.",
    questions: ask ? [{ id: "scope", header: "Scope", question: "Which scope should be implemented?",
      options: [{ label: "Small", description: "Change the requested behavior." }, { label: "Large", description: "Include adjacent behavior." }],
      allowOther: true, secret: false }] : [], assumptions: [], message: ask ? "Choose a scope." : "Plan ready." };
} else {
  const findings = (scenario === "findings" || scenario === "nonblocking") && count === 1;
  result = { verdict: findings ? "changes_requested" : "pass",
    findings: findings ? [{ severity: scenario === "nonblocking" ? "low" : "high", blocking: scenario !== "nonblocking",
      title: "Review the changed behavior", body: "The implementation needs a focused correction.", file: "target.txt", line: 1 }] : [],
    testGaps: [], summary: findings ? "Please address the finding." : "The implementation passes review." };
}
if (scenario === "invalid_schema") result = { unexpected: true };
emit({ type: "item.completed", item: { id: "answer", type: "agent_message", text: scenario === "invalid_json" ? "{not JSON" : JSON.stringify(result) } });
emit({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 20 } });
