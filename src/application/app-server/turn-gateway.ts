import type { CodexGateway } from "../../workflow.js";

export type TurnGatewayPort = Pick<CodexGateway, "startTurn" | "continueTurn" | "startReview" | "interrupt" | "normalizeInFork" | "captureTurnBaseline" | "readAppendedTurnText" | "resolveDefaultModel">;

/** Turn-only App Server seam; thread identity and child transport stay out. */
export class TurnGateway {
  constructor(private readonly port: TurnGatewayPort) {}

  startTurn(...args: Parameters<TurnGatewayPort["startTurn"]>): ReturnType<TurnGatewayPort["startTurn"]> { return this.port.startTurn(...args); }
  continueTurn(...args: Parameters<TurnGatewayPort["continueTurn"]>): ReturnType<TurnGatewayPort["continueTurn"]> { return this.port.continueTurn(...args); }
  startReview(...args: Parameters<TurnGatewayPort["startReview"]>): ReturnType<TurnGatewayPort["startReview"]> { return this.port.startReview(...args); }
  interrupt(...args: Parameters<TurnGatewayPort["interrupt"]>): ReturnType<TurnGatewayPort["interrupt"]> { return this.port.interrupt(...args); }
  captureTurnBaseline(...args: Parameters<NonNullable<TurnGatewayPort["captureTurnBaseline"]>>): ReturnType<NonNullable<TurnGatewayPort["captureTurnBaseline"]>> { return this.port.captureTurnBaseline ? this.port.captureTurnBaseline(...args) : Promise.reject(new Error("codex gateway has no captureTurnBaseline")); }
  readAppendedTurnText(...args: Parameters<NonNullable<TurnGatewayPort["readAppendedTurnText"]>>): ReturnType<NonNullable<TurnGatewayPort["readAppendedTurnText"]>> { return this.port.readAppendedTurnText ? this.port.readAppendedTurnText(...args) : Promise.reject(new Error("codex gateway has no readAppendedTurnText")); }
  normalizeInFork(...args: Parameters<TurnGatewayPort["normalizeInFork"]>): ReturnType<TurnGatewayPort["normalizeInFork"]> { return this.port.normalizeInFork(...args); }
  resolveDefaultModel(...args: Parameters<NonNullable<TurnGatewayPort["resolveDefaultModel"]>>): ReturnType<NonNullable<TurnGatewayPort["resolveDefaultModel"]>> { return this.port.resolveDefaultModel ? this.port.resolveDefaultModel(...args) : Promise.resolve(undefined); }
}
