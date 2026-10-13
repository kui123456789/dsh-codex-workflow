import { resolve } from "node:path";
import { open } from "node:fs/promises";

/** Companion reporter. Native reporters retain responsibility for human output. */
export default async function* report(source) {
  const runId = process.env.DSH_WORKFLOW_TEST_RECEIPT_ID;
  const root = process.env.DSH_WORKFLOW_TEST_RECEIPT_ROOT;
  const path = process.env.DSH_WORKFLOW_TEST_RECEIPT;
  if (!runId || !root || !path) throw new Error("Test receipt has no original run identity");
  const output = await open(path, "wx");
  const line = value => JSON.stringify(value) + "\n";
  try {
    await output.writeFile(line({ type: "start", schemaVersion: 1, runId, repositoryRoot: resolve(root), nodeVersion: process.version }));
    for await (const event of source) {
      if (event.type === "test:summary") {
        await output.writeFile(line({ type: "summary", scope: event.data.file === undefined ? "cumulative" : "file",
          file: event.data.file ?? null, success: event.data.success, counts: event.data.counts }));
      } else if (["test:diagnostic", "test:stderr", "test:stdout"].includes(event.type)
        && typeof event.data.message === "string"
        && /Warning: A resource generated asynchronous activity|unhandledRejection|uncaughtException/.test(event.data.message)) {
        await output.writeFile(line({ type: "async-warning" })); // Diagnostic contents stay in human logs.
      }
    }
    await output.writeFile(line({ type: "complete", runId }));
  } finally { await output.close(); }
}
