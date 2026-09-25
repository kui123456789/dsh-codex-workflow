import type { CodexGateway } from "../../workflow.js";

export type ThreadGatewayPort = Pick<CodexGateway, "startThread" | "resumeThread">;

/** Thread-only App Server seam; turn and process state stay out of it. */
export class ThreadGateway {
  constructor(private readonly port: ThreadGatewayPort) {}

  startThread(...args: Parameters<ThreadGatewayPort["startThread"]>): ReturnType<ThreadGatewayPort["startThread"]> { return this.port.startThread(...args); }
  resumeThread(...args: Parameters<ThreadGatewayPort["resumeThread"]>): ReturnType<ThreadGatewayPort["resumeThread"]> { return this.port.resumeThread(...args); }
}
