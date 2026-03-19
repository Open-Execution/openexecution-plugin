/**
 * @module types
 * @description Type definitions for the OpenExecution provenance plugin
 *
 * License: Apache 2.0
 */

// Re-export the OpenClaw plugin API type for extension authors
export type { OpenClawPluginApi } from "openclaw/plugin-sdk/oe-provenance";

// ── Plugin Configuration ──

export type PrivacyLevel = "full" | "metadata" | "minimal";

export type DisplayMode = "silent" | "minimal" | "verbose";

export type PluginConfig = {
  // ── Connection ──
  webhookUrl: string;
  webhookSecret: string;

  // ── Batching ──
  batchIntervalMs?: number;
  batchMaxSize?: number;
  timeoutMs?: number;
  retryAttempts?: number;

  // ── Privacy (granular) ──
  includeToolArgs?: boolean;
  includeToolResults?: boolean;
  includeLlmContent?: boolean;
  includeAssistantText?: boolean;

  // ── Privacy (preset) ──
  /** Convenience preset: "full" (everything), "metadata" (structure only), "minimal" (events only) */
  privacyLevel?: PrivacyLevel;

  // ── Spool / Durability ──
  spoolEnabled?: boolean;
  spoolDir?: string;
  spoolMaxSizeMb?: number;

  // ── Display ──
  /** Controls terminal output: "silent" (no output), "minimal" (status only), "verbose" (all events) */
  displayMode?: DisplayMode;
  /** Show a summary line when the session ends (event counts, delivery stats) */
  showSessionSummary?: boolean;
  /** Show real-time delivery status (✓/✗) for each batch */
  showDeliveryStatus?: boolean;
  /** Custom prefix for all plugin log messages. Default: "oe" */
  displayPrefix?: string;
};

// ── Resolved config with defaults applied ──

export type ResolvedConfig = Required<
  Pick<
    PluginConfig,
    | "webhookUrl"
    | "webhookSecret"
    | "batchIntervalMs"
    | "batchMaxSize"
    | "timeoutMs"
    | "retryAttempts"
    | "includeToolArgs"
    | "includeToolResults"
    | "includeLlmContent"
    | "includeAssistantText"
    | "displayMode"
    | "showSessionSummary"
    | "showDeliveryStatus"
    | "displayPrefix"
  >
>;

// ── Internal event types ──

export type QueuedEvent = {
  stream: string;
  data: Record<string, unknown>;
  runId?: string;
  sessionKey?: string;
  ts: number;
  seq: number;
  hook?: string;
  pluginData?: Record<string, unknown>;
  /** Byte size of the JSONL line on disk (set by DiskSpool.append). Used for cursor tracking. */
  _spoolBytes?: number;
};
