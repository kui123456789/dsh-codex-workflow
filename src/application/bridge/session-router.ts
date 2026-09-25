export interface SessionRegistryPort {
  refreshSessions(force?: boolean): Promise<void>;
}

/** Application seam for the live-session registry used by bridge routing. */
export class SessionRouter {
  constructor(private readonly port: SessionRegistryPort) {}

  refreshSessions(force = false): Promise<void> {
    return this.port.refreshSessions(force);
  }
}
