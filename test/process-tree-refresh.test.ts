import assert from "node:assert/strict";
import test from "node:test";
import childProcess, { type ExecFileOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { refreshOriginalProcessTreeEvidence, type ProcessTreeEvidence, type ProcessTreeObservation } from "../src/infrastructure/process-transport.js";

const launcher = { processId: 100, birth: "win32:134357732495098540" };
const backend = { processId: 101, birth: "win32:134357732495653800" };
const late = { processId: 102, birth: "win32:134357732496100000" };
const original: ProcessTreeEvidence = { processId: 100, processIds: [100, 101], processIdentities: [launcher, backend] };

test("lost launcher refresh retains original identities and adopts later descendants only from a matching backend", async (t) => {
  const requested: number[] = [];
  const observed: ProcessTreeObservation[] = [];
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  const refreshed = await refreshOriginalProcessTreeEvidence(original, {
    isAbsent: pid => pid === 100,
    async capture(pid) { requested.push(pid); elapsed = 4100; return { processIds: [101, 102], processIdentities: [backend, late] }; },
    onObservation: value => observed.push(value),
  });
  assert.deepEqual(requested, [101]);
  assert.deepEqual(refreshed, { processId: 100, processIds: [100, 101, 102], processIdentities: [launcher, backend, late] });
  assert.deepEqual(original.processIds, [100, 101], "Retained evidence cannot be edited by the refresh");
  assert.ok(Object.isFrozen(refreshed)); assert.ok(Object.isFrozen(refreshed!.processIdentities![2]));
  assert.deepEqual(observed, [{ processId: 100, code: "refreshed", elapsedMs: 4100 }]);
  assert.ok(Object.isFrozen(observed[0]), "Diagnostics are immutable and separate from process identity evidence");
});

test("a reused original backend PID cannot lend its current descendants to the old cleanup", async () => {
  const reused = { ...backend, birth: "win32:134357732496000000" };
  const refreshed = await refreshOriginalProcessTreeEvidence(original, {
    isAbsent: pid => pid === 100,
    async capture() { return { processIds: [101, 102], processIdentities: [reused, late] }; },
  });
  assert.deepEqual(refreshed, original);
});

test("unknown original births cannot be filled from current metadata even when numeric PIDs are absent", async () => {
  const observed: ProcessTreeObservation[] = [];
  const result = await refreshOriginalProcessTreeEvidence({ processId: 100 }, {
    isAbsent: () => true,
    async capture() { throw new Error("No snapshot may invent original ownership"); },
    onObservation: value => observed.push(value),
  });
  assert.equal(result, undefined);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]!.code, "original_identity_incomplete");
});

for (const failure of ["missing", "partial", "foreign-domain", "conflicting-identity"] as const) {
test(`an unproven descendant census cannot clear original ownership: ${failure}`, async () => {
  const observed: ProcessTreeObservation[] = [];
  const result = await refreshOriginalProcessTreeEvidence(original, {
    isAbsent: pid => pid === 100,
    async capture() {
      if (failure === "missing") return undefined;
      if (failure === "partial") return { processIds: [101, 102], processIdentities: [backend] };
      if (failure === "foreign-domain") return { processIds: [101], processIdentities: [
        { ...backend, birth: "linux:12345678-1234-1234-1234-123456789abc:55" },
      ] };
      return { processIds: [101, 100], processIdentities: [backend, { ...launcher, birth: late.birth }] };
    },
    onObservation: value => observed.push(value),
  });
  assert.equal(result, undefined);
  assert.deepEqual(original.processIdentities, [launcher, backend]);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]!.code, { missing: "capture_unavailable", partial: "current_identity_incomplete",
    "foreign-domain": "birth_domain_mismatch", "conflicting-identity": "identity_conflict" }[failure]);
  assert.equal(observed[0]!.processId, failure === "conflicting-identity" ? 100 : 101);
  assert.ok(Object.isFrozen(observed[0]));
  assert.ok(!JSON.stringify(observed).includes(launcher.birth) && !JSON.stringify(observed).includes(backend.birth));
});
}

test("refresh observer failures cannot change evidence or admit descendants from a reused original PID", async () => {
  for (const onObservation of [() => { throw new Error("PRIVATE_REFRESH_OBSERVER"); },
    async () => { throw new Error("PRIVATE_REFRESH_OBSERVER"); }]) {
    const refreshed = await refreshOriginalProcessTreeEvidence(original, {
      isAbsent: pid => pid === 100,
      async capture() { return { processIds: [101, 102], processIdentities: [{ ...backend, birth: late.birth }, late] }; },
      onObservation,
    });
    assert.deepEqual(refreshed, original);
  }
  await new Promise<void>(resolve => setImmediate(resolve));
});

test("a failed descendant capture preserves the native sanitized cause and refuses original cleanup", {
  skip: process.platform !== "win32",
}, async (t) => {
  const privateMarker = "PRIVATE_REFRESH_CENSUS_TOKEN";
  const observed: ProcessTreeObservation[] = [];
  const mock = t.mock.method(childProcess, "execFile", ((_file: string, args: string[], options: ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    assert.ok(args.some(value => value.includes("Get-CimInstance Win32_Process")));
    assert.equal(options.timeout, 4000);
    queueMicrotask(() => callback(Object.assign(new Error(privateMarker), { code: "EACCES" }), privateMarker, privateMarker));
    return new childProcess.ChildProcess();
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    const refreshed = await refreshOriginalProcessTreeEvidence(original, {
      isAbsent: pid => pid === 100, onObservation: value => observed.push(value),
    });
    assert.equal(refreshed, undefined);
    assert.deepEqual(observed.map(value => value.code), ["permission_denied", "capture_unavailable"]);
    assert.ok(observed.every(value => value.processId === 101 && Object.isFrozen(value)));
    assert.equal(JSON.stringify(observed).includes(privateMarker), false);
    assert.deepEqual(original.processIdentities, [launcher, backend]);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("independently proven exit after unavailable capture needs no invented descendant identities", async () => {
  const observed: ProcessTreeObservation[] = [];
  let gone = false;
  const refreshed = await refreshOriginalProcessTreeEvidence(original, {
    isAbsent: pid => pid === 100 || gone,
    async capture() { gone = true; return undefined; },
    onObservation: value => observed.push(value),
  });
  assert.deepEqual(refreshed, original);
  assert.deepEqual(observed.map(value => value.code), ["refreshed"]);
});
