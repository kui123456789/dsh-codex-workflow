import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  SystemDesktopThreadOpener,
  codexThreadUri,
  type SpawnLike,
  type SpawnedProcessLike,
} from "../src/desktop-thread-opener.js";

const threadId = "123e4567-e89b-12d3-a456-426614174000";

function fakeSpawnCapture(exitCode: number | null = 0, error?: Error): {
  spawn: SpawnLike;
  calls: Array<{ command: string; args: string[]; options: { stdio: "ignore"; windowsHide?: boolean } }>;
} {
  const calls: Array<{ command: string; args: string[]; options: { stdio: "ignore"; windowsHide?: boolean } }> = [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, options });
    const emitter = new EventEmitter();
    const child = emitter as unknown as SpawnedProcessLike;
    queueMicrotask(() => {
      if (error) emitter.emit("error", error);
      else emitter.emit("close", exitCode);
    });
    return child;
  };
  return { spawn, calls };
}

test("codexThreadUri validates UUID and builds the deep link", () => {
  assert.equal(codexThreadUri(threadId), `codex://threads/${threadId}`);
  assert.throws(() => codexThreadUri("not-a-uuid"), /must be a UUID/);
});

for (const [platform, command, args] of [
  ["win32", "cmd.exe", ["/d", "/c", "start", "", `codex://threads/${threadId}`]],
  ["darwin", "open", [`codex://threads/${threadId}`]],
  ["linux", "xdg-open", [`codex://threads/${threadId}`]],
] as const) {
  test(`${platform} uses the expected system opener`, async () => {
    const fake = fakeSpawnCapture();
    const opener = new SystemDesktopThreadOpener(platform, fake.spawn);
    await opener.open(threadId);
    assert.deepEqual(fake.calls, [{ command, args, options: { stdio: "ignore", windowsHide: true } }]);
  });
}

test("spawn failures are returned as rejected promises", async () => {
  const fake = fakeSpawnCapture(0, new Error("no URI handler"));
  await assert.rejects(() => new SystemDesktopThreadOpener("linux", fake.spawn).open(threadId), /no URI handler/);
});

test("nonzero opener exit codes are diagnosable", async () => {
  const fake = fakeSpawnCapture(2);
  await assert.rejects(() => new SystemDesktopThreadOpener("darwin", fake.spawn).open(threadId), /open exited with code 2/);
});

test("an opener that closes without an exit code is treated as a failure", async () => {
  const fake = fakeSpawnCapture(null);
  await assert.rejects(() => new SystemDesktopThreadOpener("linux", fake.spawn).open(threadId), /xdg-open exited with code unknown/);
});
