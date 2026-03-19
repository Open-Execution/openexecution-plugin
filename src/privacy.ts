/**
 * @module privacy
 * @description Privacy helpers — strip/redact sensitive fields from events
 *
 * License: Apache 2.0
 */

export function stripToolArgs(args: unknown, include: boolean): unknown {
  if (include || !args) return args;
  if (typeof args !== "object") return "[redacted]";
  return Object.fromEntries(
    Object.keys(args as Record<string, unknown>).map((k) => [k, "[redacted]"]),
  );
}

export function stripToolResult(result: unknown, include: boolean): unknown {
  if (include || result === undefined) return result;
  if (typeof result === "string") return `[${result.length} chars]`;
  if (typeof result === "object" && result !== null) {
    return `[object with ${Object.keys(result as Record<string, unknown>).length} keys]`;
  }
  return "[redacted]";
}

/**
 * Extract only resource-identifying fields from tool args.
 * These are repo/project/file identifiers needed for resource_ref inference —
 * NOT the full args payload.
 */
export function extractArgHints(
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const hints: Record<string, unknown> = {};
  let hasHints = false;

  const identifierKeys = [
    "repo", "repository", "owner",
    "project", "projectId", "project_id",
    "branch", "ref",
    "file_key", "fileKey",
    "page_id", "pageId",
    "database_id", "databaseId",
    "documentId", "document_id", "docId",
    "channel", "channel_id", "channelId",
    "name",
  ];

  for (const key of identifierKeys) {
    const val = params[key];
    if (val !== undefined && (typeof val === "string" || typeof val === "number")) {
      hints[key] = val;
      hasHints = true;
    }
  }

  return hasHints ? hints : undefined;
}

/**
 * Extract minimal correlation hints from a tool call result.
 * Only extracts identifiers (SHAs, IDs, numbers) — no content.
 */
export function extractCorrelationHints(
  event: { toolName: string; result?: unknown; params?: Record<string, unknown> },
): Record<string, unknown> | undefined {
  const result = event.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;

  const r = result as Record<string, unknown>;
  const hints: Record<string, unknown> = {};
  let hasHints = false;

  // GitHub: commit SHA, PR/issue number, branch ref
  if (r.sha && typeof r.sha === "string") { hints.sha = r.sha; hasHints = true; }
  if (r.number && typeof r.number === "number") { hints.number = r.number; hasHints = true; }
  if (r.merged !== undefined) { hints.merged = r.merged; hasHints = true; }
  if (r.ref && typeof r.ref === "string") { hints.ref = r.ref; hasHints = true; }

  // Vercel: deployment ID
  if (r.id && typeof r.id === "string") { hints.id = r.id; hasHints = true; }
  if (r.deployment_id || r.deploymentId) { hints.deployment_id = r.deployment_id || r.deploymentId; hasHints = true; }

  // Figma: node ID, file key
  if (r.node_id || r.nodeId) { hints.node_id = r.node_id || r.nodeId; hasHints = true; }
  if (r.file_key || r.fileKey) { hints.file_key = r.file_key || r.fileKey; hasHints = true; }

  // Notion: page ID, database ID
  if (r.page_id || r.pageId) { hints.page_id = r.page_id || r.pageId; hasHints = true; }
  if (r.database_id || r.databaseId) { hints.database_id = r.database_id || r.databaseId; hasHints = true; }

  // Google Docs: document ID
  if (r.documentId || r.document_id) { hints.document_id = r.documentId || r.document_id; hasHints = true; }

  // Messaging: message ID
  if (r.message_id || r.messageId) { hints.message_id = r.message_id || r.messageId; hasHints = true; }

  return hasHints ? hints : undefined;
}
