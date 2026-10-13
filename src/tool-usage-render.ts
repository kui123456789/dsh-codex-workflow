/** Project repeated usage history for Native/model display only. Canonical
 * tool values and the persistent ledger keep their complete source list. */
export function formatWorkflowToolResult(value: unknown, includeUsageSources = false): unknown {
  if (includeUsageSources === true) return value;
  const workflow = object(value);
  const usage = object(workflow?.observedUsage);
  if (!workflow || !usage || usage.version !== 1 || usage.source !== "app_server"
    || usage.scope !== "observed_original_threads" || !Array.isArray(usage.sources)
    || !object(usage.summary)) return value;
  return {
    ...workflow,
    observedUsage: {
      version: usage.version,
      source: usage.source,
      scope: usage.scope,
      summary: usage.summary,
      sourceCount: usage.sources.length,
      sourcesIncluded: false,
    },
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
