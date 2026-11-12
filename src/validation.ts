import { PLANNER_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA } from "./schemas.js";
import type { PlannerResult, ReviewResult, ReviewInput, Settings } from "./types.js";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Input must be a JSON object");
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown input field: ${key}`);
}
export function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}
export function settings(input: Record<string, unknown>): Settings {
  const result: Settings = { turnTimeoutMs: 600_000, transientRetryBudgetMs: 1_200_000, maxReviewCycles: 3, maxNoChangeReviewRounds: 1 };
  for (const [key, min, max] of [["turnTimeoutMs", 100, 7_200_000], ["transientRetryBudgetMs", 0, 7_200_000], ["maxReviewCycles", 1, 10], ["maxNoChangeReviewRounds", 1, 10]] as const) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
    result[key] = value;
  }
  for (const key of ["plannerModel", "reviewerModel", "plannerEffort", "reviewerEffort"] as const) {
    if (input[key] !== undefined) result[key] = text(input[key], key);
  }
  for (const key of ["plannerEffort", "reviewerEffort"] as const) if (result[key] && !["low", "medium", "high", "xhigh", "max", "ultra"].includes(result[key]!)) throw new Error(`Invalid ${key}`);
  return result;
}
export function reviewInput(input: Record<string, unknown>): ReviewInput {
  text(input.implementationSummary, "implementationSummary");
  if (input.testResults !== undefined && typeof input.testResults !== "string") throw new Error("testResults must be a string");
  if (input.changedFiles !== undefined && (!Array.isArray(input.changedFiles) || input.changedFiles.some((value) => typeof value !== "string" || !value.trim()))) throw new Error("changedFiles must be an array of non-empty strings");
  return { implementationSummary: input.implementationSummary as string,
    ...(input.changedFiles ? { changedFiles: input.changedFiles as string[] } : {}),
    ...(input.testResults !== undefined ? { testResults: input.testResults as string } : {}) };
}

function validate(value: unknown, schema: Record<string, unknown>, path = "result"): void {
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((candidate) => { try { validate(value, candidate as Record<string, unknown>, path); return true; } catch { return false; } })) throw new Error(`Invalid schema at ${path}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`Invalid enum at ${path}`);
  if (schema.type === "object") {
    const record = object(value);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    for (const key of schema.required as string[] ?? []) if (!(key in record)) throw new Error(`Missing schema field ${path}.${key}`);
    for (const [key, item] of Object.entries(record)) {
      if (!properties[key]) { if (schema.additionalProperties === false) throw new Error(`Unknown schema field ${path}.${key}`); }
      else validate(item, properties[key]!, `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`Invalid array at ${path}`);
    value.forEach((item, index) => validate(item, schema.items as Record<string, unknown>, `${path}[${index}]`));
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)) throw new Error(`Invalid integer at ${path}`);
  } else if (schema.type === "null") {
    if (value !== null) throw new Error(`Invalid null at ${path}`);
  } else if (typeof value !== schema.type) throw new Error(`Invalid ${String(schema.type)} at ${path}`);
}
export function plannerResult(value: unknown): PlannerResult {
  validate(value, PLANNER_OUTPUT_SCHEMA);
  const result = value as PlannerResult;
  if (result.status === "ready" && (!result.planMarkdown.trim() || result.questions.length)) throw new Error("Ready Planner result requires a plan and no unanswered questions");
  if (result.status === "needs_input" && !result.questions.length) throw new Error("Planner needs_input requires questions");
  if (new Set(result.questions.map((q) => q.id)).size !== result.questions.length || result.questions.some((q) => !q.id.trim() || !q.question.trim())) throw new Error("Planner questions require unique non-empty ids and questions");
  return result;
}
export function reviewResult(value: unknown): ReviewResult {
  validate(value, REVIEW_OUTPUT_SCHEMA);
  const result = value as ReviewResult;
  for (const finding of result.findings) if (!finding.title.trim() || !finding.body.trim() || (finding.line !== null && finding.line < 1)) throw new Error("Review findings require title, body and a positive line or null");
  const content = result.findings.length > 0 || result.testGaps.length > 0;
  if (result.verdict === "changes_requested" && !content) throw new Error("Invalid review result: changes_requested without findings or test gaps");
  return result.verdict === "pass" && content ? { ...result, verdict: "changes_requested" } : result;
}
