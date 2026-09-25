import type { LeaseRepository, LiveSessionRepository, QueueRepository, WorkflowRepository } from "../../ports.js";

/** Repository seams for the shared coordination database. */
export class QueueRepositoryAdapter implements QueueRepository {
  constructor(private readonly port: QueueRepository) {}
  enqueueCommand(...args: Parameters<QueueRepository["enqueueCommand"]>): ReturnType<QueueRepository["enqueueCommand"]> { return this.port.enqueueCommand(...args); }
  claimNext(...args: Parameters<QueueRepository["claimNext"]>): ReturnType<QueueRepository["claimNext"]> { return this.port.claimNext(...args); }
  ackClaim(...args: Parameters<QueueRepository["ackClaim"]>): ReturnType<QueueRepository["ackClaim"]> { return this.port.ackClaim(...args); }
  renewClaim(...args: Parameters<QueueRepository["renewClaim"]>): ReturnType<QueueRepository["renewClaim"]> { return this.port.renewClaim(...args); }
  retryClaim(...args: Parameters<QueueRepository["retryClaim"]>): ReturnType<QueueRepository["retryClaim"]> { return this.port.retryClaim(...args); }
  deadLetterClaim(...args: Parameters<QueueRepository["deadLetterClaim"]>): ReturnType<QueueRepository["deadLetterClaim"]> { return this.port.deadLetterClaim(...args); }
  quarantineRow(...args: Parameters<QueueRepository["quarantineRow"]>): ReturnType<QueueRepository["quarantineRow"]> { return this.port.quarantineRow(...args); }
  requeueRequest(...args: Parameters<QueueRepository["requeueRequest"]>): ReturnType<QueueRepository["requeueRequest"]> { return this.port.requeueRequest(...args); }
  recoverQueueOrphans(...args: Parameters<QueueRepository["recoverQueueOrphans"]>): ReturnType<QueueRepository["recoverQueueOrphans"]> { return this.port.recoverQueueOrphans(...args); }
  queueRow(...args: Parameters<QueueRepository["queueRow"]>): ReturnType<QueueRepository["queueRow"]> { return this.port.queueRow(...args); }
  queueRowsByStatus(...args: Parameters<QueueRepository["queueRowsByStatus"]>): ReturnType<QueueRepository["queueRowsByStatus"]> { return this.port.queueRowsByStatus(...args); }
}

export class LeaseRepositoryAdapter implements LeaseRepository {
  constructor(private readonly port: LeaseRepository) {}
  acquireLease(...args: Parameters<LeaseRepository["acquireLease"]>): ReturnType<LeaseRepository["acquireLease"]> { return this.port.acquireLease(...args); }
  renewLease(...args: Parameters<LeaseRepository["renewLease"]>): ReturnType<LeaseRepository["renewLease"]> { return this.port.renewLease(...args); }
  releaseLease(...args: Parameters<LeaseRepository["releaseLease"]>): ReturnType<LeaseRepository["releaseLease"]> { return this.port.releaseLease(...args); }
  isLeaseOwner(...args: Parameters<LeaseRepository["isLeaseOwner"]>): ReturnType<LeaseRepository["isLeaseOwner"]> { return this.port.isLeaseOwner(...args); }
  leaseInfo(...args: Parameters<LeaseRepository["leaseInfo"]>): ReturnType<LeaseRepository["leaseInfo"]> { return this.port.leaseInfo(...args); }
}

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
