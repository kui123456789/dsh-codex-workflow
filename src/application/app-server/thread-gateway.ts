import type { CodexThreadPort } from "../../ports.js";

/** Thread-only App Server seam; turn and process state stay out of it. */
export class ThreadGateway {
  constructor(private readonly port: CodexThreadPort) {}

  startThread(...args: Parameters<CodexThreadPort["startThread"]>): ReturnType<CodexThreadPort["startThread"]> { return this.port.startThread(...args); }
  resumeThread(...args: Parameters<CodexThreadPort["resumeThread"]>): ReturnType<CodexThreadPort["resumeThread"]> { return this.port.resumeThread(...args); }
  unsubscribeThread(...args: Parameters<CodexThreadPort["unsubscribeThread"]>): ReturnType<CodexThreadPort["unsubscribeThread"]> { return this.port.unsubscribeThread(...args); }
  releaseThreadForExternal(...args: Parameters<CodexThreadPort["releaseThreadForExternal"]>): ReturnType<CodexThreadPort["releaseThreadForExternal"]> { return this.port.releaseThreadForExternal(...args); }
  nameThread(...args: Parameters<CodexThreadPort["nameThread"]>): ReturnType<CodexThreadPort["nameThread"]> { return this.port.nameThread(...args); }
  readThread(...args: Parameters<CodexThreadPort["readThread"]>): ReturnType<CodexThreadPort["readThread"]> { return this.port.readThread(...args); }
  listThreadIds(...args: Parameters<CodexThreadPort["listThreadIds"]>): ReturnType<CodexThreadPort["listThreadIds"]> { return this.port.listThreadIds(...args); }
}
