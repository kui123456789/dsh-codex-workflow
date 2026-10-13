import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { originalProcessTreeExited, type ProcessTreeEvidence } from "../src/infrastructure/process-transport.js";
import { sharedWaitFor } from "./fixtures/bridge-shared-reviewer-fixture.js";

for (const mode of ["chinese", "emoji", "incomplete", "bounded", "bounded-surrogate"] as const) {
test(`actual UTF-8 stderr preserves original diagnostics and bounds: ${mode}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-stderr-utf8-")), backend = join(directory, "backend.mjs");
  await writeFile(backend, `
import { createInterface } from "node:readline";
const input=createInterface({input:process.stdin});
const reply=(id,result)=>process.stdout.write(JSON.stringify({id,result})+"\\n");
input.on("line",line=>{const {id,method,params={}}=JSON.parse(line);
 if(method==="initialize")return reply(id,{userAgent:"utf8-local"});
 if(method==="initialized")return;
 if(method==="fixture/part")return process.stderr.write(Buffer.from(params.bytes,"base64"),()=>reply(id,{}));
 if(method==="fixture/exit")return process.stderr.write(Buffer.from(params.bytes,"base64"),()=>process.exit(42));
 reply(id,{});
});input.on("close",()=>process.exit(0));
`);
  const client = new CodexAppServerClient({ command: process.execPath, args: [backend], requestTimeoutMs: 5000,
    rpcTimeoutMs: 4000, idleProcessMs: 0 });
  const port = client as unknown as { child: ChildProcess; request<T>(method: string, params: object): Promise<T>;
    initializedProcessTrees: WeakMap<ChildProcess, Promise<ProcessTreeEvidence>> };
  const readable = "模型连接中断，保留原会话继续处理。";
  const diagnostic = mode === "emoji" ? "😀模型失败，保留原审查🔥" : mode === "bounded" ? "旧".repeat(20000) + readable
    : mode === "bounded-surrogate" ? "😀" + "x".repeat(16383) : mode === "incomplete" ? "结束时残余：" : readable;
  const bytes = mode === "incomplete" ? Buffer.concat([Buffer.from(diagnostic, "utf8"), Buffer.from([0xe6, 0xa8])]) : Buffer.from(diagnostic, "utf8");
  const expected = mode === "incomplete" ? diagnostic + "�" : mode === "bounded-surrogate" ? "x".repeat(16383) : diagnostic.slice(-16384);
  let failed = false, evidence: ProcessTreeEvidence | undefined;
  try {
    await client.start(); const original = port.child;
    evidence = await port.initializedProcessTrees.get(original)!;
    assert.ok(evidence?.processIdentities?.length, "Real original birth evidence is required before injecting a pipe fault");
    const chunks: Buffer[] = []; original.stderr!.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const first = new Promise<void>(resolve => original.stderr!.once("data", () => resolve()));
    await port.request("fixture/part", { bytes: bytes.subarray(0, 2).toString("base64") });
    await first;
    assert.deepEqual(Buffer.concat(chunks), bytes.subarray(0, 2), "The actual original pipe delivered an incomplete first Chinese character");
    const outcome = await port.request("fixture/exit", { bytes: bytes.subarray(2).toString("base64") })
      .then(() => { throw new Error("The exiting original cannot reply"); }, (error: Error) => error);
    await writeFile(join(directory, "utf8-result.json"), JSON.stringify({ evidence, chunks: chunks.map(chunk => chunk.toString("hex")),
      error: outcome.message, diagnostic }, null, 2));
    assert.ok(chunks.length >= 2);
    const prefix = "codex app-server exited 42 (no signal): ";
    assert.ok(outcome.message.startsWith(prefix));
    const body = outcome.message.slice(prefix.length);
    assert.equal(body.length, expected.length, "Decoded bounded tail has the expected complete-character length");
    assert.equal(body === expected, true, "Actual bytes and bounded tail must preserve complete decoded characters");
    assert.ok(body.length <= 16384, "Original diagnostic tail budget remains unchanged");
    if (mode !== "incomplete") assert.equal(outcome.message.includes("�"), false);
    assert.equal(body.length > 0 && body.charCodeAt(0) >= 0xdc00 && body.charCodeAt(0) <= 0xdfff, false,
      "Tail clipping cannot publish a standalone low surrogate");
    assert.equal(await originalProcessTreeExited(evidence), true);
  } catch (error) { failed = true; throw error; }
  finally {
    await client.stop().catch(() => undefined);
    if (evidence?.processIdentities?.length) await sharedWaitFor(() => originalProcessTreeExited(evidence!), "UTF-8 original fixture instances exited");
    if (failed) console.error(`UTF-8 stderr evidence retained: ${directory}`);
    else { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
  }
});
}
