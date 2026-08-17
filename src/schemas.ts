export const PLANNER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["ready", "needs_input", "failed"] },
    planMarkdown: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          header: { type: "string" },
          question: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { label: { type: "string" }, description: { type: "string" } },
              required: ["label", "description"],
            },
          },
          allowOther: { type: "boolean" },
          secret: { type: "boolean" },
        },
        required: ["id", "header", "question", "options", "allowOther", "secret"],
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
    message: { type: "string" },
  },
  required: ["status", "planMarkdown", "questions", "assumptions", "message"],
} as const;

export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "changes_requested"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          title: { type: "string" },
          body: { type: "string" },
          file: { anyOf: [{ type: "string" }, { type: "null" }] },
          line: { anyOf: [{ type: "integer" }, { type: "null" }] },
        },
        required: ["severity", "title", "body", "file", "line"],
      },
    },
    testGaps: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["verdict", "findings", "testGaps", "summary"],
} as const;
