import { createInterface, type Interface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";

/** The small seam between App Server JSON-RPC and a local child process. */
export interface ProcessTransportOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface SpawnedProcessTransport {
  child: ChildProcess;
  lines: Interface;
}

/** Spawn one stdio Codex App Server and expose only its line stream. */
export function spawnProcess(options: ProcessTransportOptions): SpawnedProcessTransport {
  const child = crossSpawn(options.command, options.args ?? ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: options.env ?? process.env,
  });
  return { child, lines: createInterface({ input: child.stdout! }) };
}

/** Gracefully close a child, escalating only after bounded deadlines. */
export async function stopProcess(child: ChildProcess, quitGraceMs: number, killGraceMs: number): Promise<void> {
  try { child.stdin?.end(); } catch {
    // stdin may already be closed by the child side.
  }
  if (child.exitCode !== null) return;
  await waitForExit(child, quitGraceMs);
  if (child.exitCode !== null) return;
  child.kill();
  await waitForExit(child, killGraceMs);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", finish);
      child.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once("exit", finish);
    child.once("close", finish);
  });
}
