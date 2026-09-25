import type { LiveSessionRepository, WorkflowRepository } from "../../ports.js";

/** Repository seams for the shared coordination database. */
export class LiveSessionRepositoryAdapter implements LiveSessionRepository {
  constructor(private readonly port: LiveSessionRepository) {}
  listLiveSessions(...args: Parameters<LiveSessionRepository["listLiveSessions"]>): ReturnType<LiveSessionRepository["listLiveSessions"]> { return this.port.listLiveSessions(...args); }
  liveSessionsForCwd(...args: Parameters<LiveSessionRepository["liveSessionsForCwd"]>): ReturnType<LiveSessionRepository["liveSessionsForCwd"]> { return this.port.liveSessionsForCwd(...args); }
  refreshOwnerSessions(...args: Parameters<LiveSessionRepository["refreshOwnerSessions"]>): ReturnType<LiveSessionRepository["refreshOwnerSessions"]> { return this.port.refreshOwnerSessions(...args); }
  renewOwnerSessions(...args: Parameters<LiveSessionRepository["renewOwnerSessions"]>): ReturnType<LiveSessionRepository["renewOwnerSessions"]> { return this.port.renewOwnerSessions(...args); }
  releaseOwnerSessions(...args: Parameters<LiveSessionRepository["releaseOwnerSessions"]>): ReturnType<LiveSessionRepository["releaseOwnerSessions"]> { return this.port.releaseOwnerSessions(...args); }
  sessionsForOwner(...args: Parameters<LiveSessionRepository["sessionsForOwner"]>): ReturnType<LiveSessionRepository["sessionsForOwner"]> { return this.port.sessionsForOwner(...args); }
  workflowSessionOf(...args: Parameters<LiveSessionRepository["workflowSessionOf"]>): ReturnType<LiveSessionRepository["workflowSessionOf"]> { return this.port.workflowSessionOf(...args); }
}

export class WorkflowRepositoryAdapter implements WorkflowRepository {
  constructor(private readonly port: WorkflowRepository) {}
  init(...args: Parameters<WorkflowRepository["init"]>): ReturnType<WorkflowRepository["init"]> { return this.port.init(...args); }
  load(...args: Parameters<WorkflowRepository["load"]>): ReturnType<WorkflowRepository["load"]> { return this.port.load(...args); }
  list(...args: Parameters<WorkflowRepository["list"]>): ReturnType<WorkflowRepository["list"]> { return this.port.list(...args); }
  save(...args: Parameters<WorkflowRepository["save"]>): ReturnType<WorkflowRepository["save"]> { return this.port.save(...args); }
  activeForSession(...args: Parameters<WorkflowRepository["activeForSession"]>): ReturnType<WorkflowRepository["activeForSession"]> { return this.port.activeForSession(...args); }
  byBridgeRequest(...args: Parameters<WorkflowRepository["byBridgeRequest"]>): ReturnType<WorkflowRepository["byBridgeRequest"]> { return this.port.byBridgeRequest(...args); }
  abandonOrphaned(...args: Parameters<WorkflowRepository["abandonOrphaned"]>): ReturnType<WorkflowRepository["abandonOrphaned"]> { return this.port.abandonOrphaned(...args); }
  close(...args: Parameters<WorkflowRepository["close"]>): ReturnType<WorkflowRepository["close"]> { return this.port.close(...args); }
  isClosed(...args: Parameters<WorkflowRepository["isClosed"]>): ReturnType<WorkflowRepository["isClosed"]> { return this.port.isClosed(...args); }
}
