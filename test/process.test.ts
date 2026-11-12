import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";

const processModule = await import("../src/process.js").catch(() => undefined);

function api() {
  assert.ok(processModule, "owned process module must exist");
  return processModule;
}

async function line(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => finish(new Error("child output timed out")), 8_000);
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("\n")) finish(undefined, text.slice(0, text.indexOf("\n")).trim());
    };
    const onExit = () => finish(new Error("child exited before output"));
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", finish);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(value!);
    };
    child.stdout!.on("data", onData);
    child.once("error", finish);
    child.once("exit", onExit);
  });
}

test("identifies the running process and rejects a different birth", async () => {
  const { identifyProcess, processState, stopTree } = api();
  const identity = await identifyProcess(process.pid);
  assert.ok(identity);
  assert.equal(identity.pid, process.pid);
  assert.ok(identity.birth.length > 0);
  assert.equal(await processState(identity), "alive");
  const wrong = { ...identity, birth: `${identity.birth}-wrong` };
  assert.equal(await processState(wrong), "dead");
  assert.equal(await stopTree({ root: wrong, members: [] }, 8_000), true);
  assert.equal(await processState(identity), "alive");
});

test("invalid and absent PIDs are never signalled", async () => {
  const { identifyProcess, processState } = api();
  assert.equal(await identifyProcess(-1), undefined);
  assert.equal(await identifyProcess(0), undefined);
  assert.equal(await identifyProcess(2_147_483_647), undefined);
  assert.equal(await processState({ pid: 2_147_483_647, birth: "missing" }), "dead");
  assert.equal(await processState({ pid: process.pid, birth: "" }), "unknown");
});

test("captures and stops an owned child tree, including survivors after its launcher exits", { timeout: 30_000 }, async () => {
  const { spawnCommand, captureTree, stopTree, identifyProcess, processState } = api();
  const child = spawnCommand(process.execPath, ["-e", [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "console.log(child.pid);",
    "process.stdin.once('data', () => process.exit(0));",
    "setInterval(() => {}, 1000);",
  ].join("\n")], { cwd: process.cwd() });
  let descendantPid: number | undefined;
  let descendant: Awaited<ReturnType<typeof identifyProcess>>;
  try {
    descendantPid = Number(await line(child));
    descendant = await identifyProcess(descendantPid);
    assert.ok(descendant);
    const tree = await captureTree(child.pid!);
    assert.ok(tree);
    assert.ok(tree.members.some((member) => member.pid === descendantPid));
    const exited = once(child, "exit");
    child.stdin!.end("exit\n");
    await exited;
    const survivors = await captureTree(tree.root.pid, tree);
    assert.ok(survivors);
    assert.ok(survivors.members.some((member) => member.pid === descendantPid));
    assert.equal(await stopTree(survivors, 8_000), true);
    assert.equal(await processState(descendant), "dead");
    assert.equal(await stopTree(survivors, 8_000), true);
  } finally {
    child.kill("SIGKILL");
    if (descendant && await processState(descendant) === "alive") {
      await stopTree({ root: descendant, members: [] }, 8_000);
    }
  }
});

test("stops a three-generation tree without assuming timeout means cleanup", { timeout: 30_000 }, async () => {
  const { spawnCommand, captureTree, stopTree, identifyProcess, processState } = api();
  const middleScript = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "console.log(child.pid); setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawnCommand(process.execPath, ["-e", [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(middleScript)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
    "child.stdout.once('data', data => console.log(JSON.stringify([child.pid, Number(data.toString().trim())])));",
    "setInterval(() => {}, 1000);",
  ].join("\n")], { cwd: process.cwd() });
  const descendants: NonNullable<Awaited<ReturnType<typeof identifyProcess>>>[] = [];
  try {
    const pids = JSON.parse(await line(child)) as number[];
    for (const pid of pids) {
      const identity = await identifyProcess(pid);
      assert.ok(identity);
      descendants.push(identity);
    }
    const tree = await captureTree(child.pid!);
    assert.ok(tree);
    for (const pid of pids) assert.ok(tree.members.some((member) => member.pid === pid));
    assert.equal(await stopTree(tree, 0), false);
    assert.equal(await processState(tree.root), "alive");
    assert.equal(await stopTree({ ...tree, members: [{ ...descendants[0]!, birth: "" }] }, 8_000), false);
    assert.equal(await processState(descendants[0]!), "alive");
    assert.equal(await stopTree(tree, 8_000), true);
    assert.equal(await processState(tree.root), "dead");
    for (const descendant of descendants) assert.equal(await processState(descendant), "dead");
  } finally {
    child.kill("SIGKILL");
    for (const descendant of descendants) {
      if (await processState(descendant) === "alive") await stopTree({ root: descendant, members: [] }, 8_000);
    }
  }
});

test("spawns executable argument arrays without shell expansion", { timeout: 15_000 }, async () => {
  const { spawnCommand } = api();
  const args = ["two words", "literal & echo injected", "caret^pipe|angle<>"];
  const child = spawnCommand(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...args], { cwd: process.cwd() });
  const exited = once(child, "close");
  assert.deepEqual(JSON.parse(await line(child)), args);
  assert.equal((await exited)[0], 0);
});

test("platform command shims preserve literal arguments", { timeout: 15_000 }, async () => {
  const { spawnCommand } = api();
  const directory = await mkdtemp(path.join(tmpdir(), "workflow cmd "));
  try {
    await writeFile(path.join(directory, "echo.cjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const command = path.join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
    if (process.platform === "win32") {
      await writeFile(command, `@"${process.execPath}" "%~dp0echo.cjs" %*\r\n`);
    } else {
      await writeFile(command, "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n");
      await chmod(command, 0o700);
    }
    const args = ["two words", "literal & echo injected", "caret^pipe|angle<>"];
    const child = spawnCommand(command, args, { cwd: directory });
    const exited = once(child, "close");
    assert.deepEqual(JSON.parse(await line(child)), args);
    assert.equal((await exited)[0], 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
