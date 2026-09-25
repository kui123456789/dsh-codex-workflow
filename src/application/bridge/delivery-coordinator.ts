import type { SubmissionPort } from "../../ports.js";

/** Application seam for recovering durable callback deliveries. */
export class DeliveryCoordinator {
  constructor(private readonly port: SubmissionPort) {}

  recoverCallbacks(): Promise<number> {
    return this.port.recoverCallbacks();
  }
}
