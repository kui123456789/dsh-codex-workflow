import { spawn } from "node:child_process";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DesktopThreadOpener {
  open(threadId: string): Promise<void>;
}

export interface SpawnedProcessLike {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
  unref?: () => void;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; windowsHide?: boolean },
) => SpawnedProcessLike;

export function codexThreadUri(threadId: string): string {
  if (!UUID_RE.test(threadId)) throw new Error("Codex thread id must be a UUID");
  return `codex://threads/${threadId}`;
}

function commandFor(platform: NodeJS.Platform, uri: string): { command: string; args: string[] } {
  if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/c", "start", "", uri] };
  if (platform === "darwin") return { command: "open", args: [uri] };
  return { command: "xdg-open", args: [uri] };
}

export class SystemDesktopThreadOpener implements DesktopThreadOpener {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly spawnProcess: SpawnLike = (command, args, options) => spawn(command, args, options),
  ) {}

  open(threadId: string): Promise<void> {
    const uri = codexThreadUri(threadId);
    const { command, args } = commandFor(this.platform, uri);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      let child: ReturnType<SpawnLike>;
      try {
        child = this.spawnProcess(command, args, { stdio: "ignore", windowsHide: true });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      child.once("error", (error: Error) => finish(error));
      child.once("close", (code: number | null) => {
        if (code === 0) finish();
        else finish(new Error(`${command} exited with code ${code ?? "unknown"}`));
      });
      child.unref?.();
    });
  }
}
