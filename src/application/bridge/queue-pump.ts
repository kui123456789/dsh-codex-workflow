import type { BridgeWorkflowPort } from "../../ports.js";

/** Application seam for durable bridge queue polling and teardown. */
export class QueuePump {
  constructor(private readonly port: BridgeWorkflowPort) {}

  start(): void { this.port.start(); }
  stop(): Promise<void> { return this.port.stop(); }
  pump(): Promise<void> { return this.port.pump(); }
}
