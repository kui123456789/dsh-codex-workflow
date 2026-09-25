import type { CodexTurnPort } from "../../ports.js";

/** Turn-only App Server seam; thread identity and child transport stay out. */
export class TurnGateway {
  constructor(private readonly port: CodexTurnPort) {}

  startTurn(...args: Parameters<CodexTurnPort["startTurn"]>): ReturnType<CodexTurnPort["startTurn"]> { return this.port.startTurn(...args); }
  continueTurn(...args: Parameters<CodexTurnPort["continueTurn"]>): ReturnType<CodexTurnPort["continueTurn"]> { return this.port.continueTurn(...args); }
  startReview(...args: Parameters<CodexTurnPort["startReview"]>): ReturnType<CodexTurnPort["startReview"]> { return this.port.startReview(...args); }
  interrupt(...args: Parameters<CodexTurnPort["interrupt"]>): ReturnType<CodexTurnPort["interrupt"]> { return this.port.interrupt(...args); }
  captureTurnBaseline(...args: Parameters<CodexTurnPort["captureTurnBaseline"]>): ReturnType<CodexTurnPort["captureTurnBaseline"]> { return this.port.captureTurnBaseline(...args); }
  readAppendedTurnText(...args: Parameters<CodexTurnPort["readAppendedTurnText"]>): ReturnType<CodexTurnPort["readAppendedTurnText"]> { return this.port.readAppendedTurnText(...args); }
  forkThread(...args: Parameters<CodexTurnPort["forkThread"]>): ReturnType<CodexTurnPort["forkThread"]> { return this.port.forkThread(...args); }
  normalizeInFork(...args: Parameters<CodexTurnPort["normalizeInFork"]>): ReturnType<CodexTurnPort["normalizeInFork"]> { return this.port.normalizeInFork(...args); }
  resolveDefaultModel(...args: Parameters<CodexTurnPort["resolveDefaultModel"]>): ReturnType<CodexTurnPort["resolveDefaultModel"]> { return this.port.resolveDefaultModel(...args); }
  health(...args: Parameters<CodexTurnPort["health"]>): ReturnType<CodexTurnPort["health"]> { return this.port.health(...args); }
  start(...args: Parameters<CodexTurnPort["start"]>): ReturnType<CodexTurnPort["start"]> { return this.port.start(...args); }
  stop(...args: Parameters<CodexTurnPort["stop"]>): ReturnType<CodexTurnPort["stop"]> { return this.port.stop(...args); }
}
