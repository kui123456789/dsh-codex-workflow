import crossSpawn from "cross-spawn";
import { CodexAppServerClient } from "../lib/app-server.js";

const command = process.env.DSH_CODEX_COMMAND || "codex";

function capture(args) {
  const result = crossSpawn.sync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return String(result.stdout || result.stderr || "").trim();
}

const version = capture(["--version"]);
const login = capture(["login", "status"]);
const client = new CodexAppServerClient({ command, requestTimeoutMs: 30_000, idleProcessMs: 0 });
try {
  const health = await client.health();
  process.stdout.write(`DOCTOR_OK\nCodex: ${version}\nLogin: ${login}\nModels: ${health.modelCount}\n`);
} finally {
  await client.stop();
}
