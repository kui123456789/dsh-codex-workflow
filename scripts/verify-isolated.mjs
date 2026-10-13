import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolatedVerification } from "./verification-stage.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: pnpm verify:isolated");
  process.exitCode = 2;
} else {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const evidenceRoot = join(dirname(repositoryRoot), ".codex-workflow-verification");
  await mkdir(evidenceRoot, { recursive: true });
  const evidenceDirectory = await mkdtemp(join(evidenceRoot, "isolated-"));
  console.log("Isolated verification evidence: " + evidenceDirectory);
  try {
    const result = await runIsolatedVerification({ repositoryRoot, evidenceDirectory });
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown verification failure";
    console.error("Isolated verification failed: " + reason + "; retained evidence: " + evidenceDirectory);
    process.exitCode = 1;
  }
}
