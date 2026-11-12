import { build } from "esbuild";
import { chmod } from "node:fs/promises";

await build({ entryPoints: ["src/cli.ts"], outfile: "scripts/workflow.mjs", bundle: true, platform: "node", format: "esm", target: "node22.19", legalComments: "inline",
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __workflowCreateRequire } from "node:module"; const require = __workflowCreateRequire(import.meta.url);' } });
await chmod("scripts/workflow.mjs", 0o755);
console.log("Built self-contained scripts/workflow.mjs");
