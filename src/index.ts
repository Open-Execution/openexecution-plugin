/**
 * @module oe-provenance
 * @description OpenExecution provenance plugin for OpenClaw.
 *
 * Bridges the gap between OpenClaw's internal agent event system and
 * OpenExecution's webhook-based provenance recording.
 *
 * Event flow:
 *   OpenClaw agent event → plugin hook → disk spool (JSONL) → batch queue → HTTP POST → OE webhook
 *
 * Configuration:
 *   In ~/.openclaw/openclaw.json under "oe-provenance":
 *   - privacyLevel: "full" | "metadata" | "minimal"  — quick preset
 *   - displayMode: "silent" | "minimal" | "verbose"   — terminal output level
 *   - Individual privacy flags override the preset
 *
 * License: Apache 2.0
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/oe-provenance";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PluginConfig } from "./types.js";
import { resolveConfig } from "./config.js";
import { DiskSpool } from "./spool.js";
import { EventBatcher } from "./batcher.js";
import { DisplayManager } from "./display.js";
import { stripToolArgs, stripToolResult, extractArgHints, extractCorrelationHints } from "./privacy.js";

const oeProvenancePlugin = {
  id: "oe-provenance",
  name: "OpenExecution Provenance",
  description:
    "Forwards agent lifecycle events to an OpenExecution platform instance for behavioral ledger recording and cross-stream corroboration.",

  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      // Connection
      webhookUrl: { type: "string" as const },
      webhookSecret: { type: "string" as const },
      // Batching
      batchIntervalMs: { type: "number" as const },
      batchMaxSize: { type: "number" as const },
      timeoutMs: { type: "number" as const },
      retryAttempts: { type: "number" as const },
      // Privacy (granular)
      includeToolArgs: { type: "boolean" as const },
      includeToolResults: { type: "boolean" as const },
      includeLlmContent: { type: "boolean" as const },
      includeAssistantText: { type: "boolean" as const },
      // Privacy (preset)
      privacyLevel: { type: "string" as const, enum: ["full", "metadata", "minimal"] },
      // Spool
      spoolEnabled: { type: "boolean" as const },
      spoolDir: { type: "string" as const },
      spoolMaxSizeMb: { type: "number" as const },
      // Display
      displayMode: { type: "string" as const, enum: ["silent", "minimal", "verbose"] },
      showSessionSummary: { type: "boolean" as const },
      showDeliveryStatus: { type: "boolean" as const },
      displayPrefix: { type: "string" as const },
    },
    required: ["webhookUrl", "webhookSecret"] as const,
  },

  register(api: OpenClawPluginApi) {
    const raw = (api.pluginConfig || {}) as PluginConfig;
    if (!raw.webhookUrl || !raw.webhookSecret) {
      api.logger.warn("oe-provenance: missing webhookUrl or webhookSecret — plugin disabled");
      return;
    }

    const cfg = resolveConfig(raw);
    const display = new DisplayManager(cfg, api.logger);

    // Initialize disk spool
    let spool: DiskSpool | null = null;
    if (raw.spoolEnabled !== false) {
      const spoolDir = raw.spoolDir || join(homedir(), ".openclaw", "oe-provenance");
      const maxSizeMb = Math.max(raw.spoolMaxSizeMb ?? 50, 1);
      try {
        spool = new DiskSpool(spoolDir, maxSizeMb, api.logger);
        const stats = spool.stats();
        if (stats.pendingLines > 0) {
          api.logger.info(
            `oe-provenance: spool loaded — ${stats.pendingLines} pending (${(stats.fileSizeBytes / 1024).toFixed(1)}KB)`,
          );
        }
      } catch (err) {
        api.logger.error(`oe-provenance: spool init failed (continuing without durability): ${String(err)}`);
      }
    }

    const batcher = new EventBatcher(cfg, api.logger, display, spool);
    batcher.start();
    display.onInit(batcher.maskedUrl, !!spool);

    const enqueue = (
      stream: string,
      data: Record<string, unknown>,
      opts?: { runId?: string; sessionKey?: string; hook?: string; pluginData?: Record<string, unknown> },
    ) => {
      batcher.enqueue({
        stream,
        data,
        runId: opts?.runId,
        sessionKey: opts?.sessionKey,
        ts: 0,
        seq: 0,
        hook: opts?.hook,
        pluginData: opts?.pluginData,
      });
    };

    // ── Agent Lifecycle ──

    api.on("before_agent_start", (_event, ctx) => {
      enqueue("lifecycle", { phase: "start", startedAt: Date.now() }, {
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        hook: "before_agent_start",
        pluginData: { agentId: ctx.agentId },
      });
    });

    api.on("agent_end", (event, ctx) => {
      enqueue("lifecycle", {
        phase: event.isError ? "error" : "end",
        endedAt: Date.now(),
        ...(event.isError && event.errorMessage ? { error: event.errorMessage } : {}),
      }, {
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        hook: "agent_end",
        pluginData: {
          agentId: ctx.agentId,
          messageCount: event.messageCount,
          stopReason: event.stopReason,
        },
      });
    });

    // ── Session Lifecycle ──

    api.on("session_start", (event, ctx) => {
      enqueue("session", { phase: "start" }, {
        sessionKey: ctx.sessionKey,
        hook: "session_start",
        pluginData: {
          sessionId: event.sessionId,
          agentId: ctx.agentId,
          resumedFrom: event.resumedFrom,
        },
      });
    });

    api.on("session_end", (event, ctx) => {
      enqueue("session", { phase: "end" }, {
        sessionKey: ctx.sessionKey,
        hook: "session_end",
        pluginData: {
          sessionId: event.sessionId,
          agentId: ctx.agentId,
          messageCount: event.messageCount,
          durationMs: event.durationMs,
        },
      });
    });

    // ── Tool Execution ──

    api.on("before_tool_call", (event, ctx) => {
      enqueue("tool", {
        phase: "start",
        name: event.toolName,
        toolCallId: event.toolCallId,
        args: stripToolArgs(event.params, cfg.includeToolArgs),
      }, {
        runId: ctx.runId || event.runId,
        sessionKey: ctx.sessionKey,
        hook: "before_tool_call",
      });
    });

    api.on("after_tool_call", (event, ctx) => {
      const isError = Boolean(event.error);
      enqueue("tool", {
        phase: "result",
        name: event.toolName,
        toolCallId: event.toolCallId,
        isError,
        result: stripToolResult(event.result, cfg.includeToolResults),
        ...(event.error ? { error: event.error } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(!cfg.includeToolResults ? { correlation: extractCorrelationHints(event) } : {}),
        ...(!cfg.includeToolArgs && event.params ? { argHints: extractArgHints(event.params) } : {}),
      }, {
        runId: ctx.runId || event.runId,
        sessionKey: ctx.sessionKey,
        hook: "after_tool_call",
      });
    });

    // ── LLM I/O ──

    api.on("llm_input", (event, ctx) => {
      enqueue("llm", {
        phase: "input",
        model: event.model,
        messageCount: Array.isArray(event.messages) ? event.messages.length : undefined,
        ...(cfg.includeLlmContent ? { messages: event.messages } : {}),
      }, {
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        hook: "llm_input",
        pluginData: { agentId: ctx.agentId },
      });
    });

    api.on("llm_output", (event, ctx) => {
      enqueue("llm", {
        phase: "output",
        model: event.model,
        stopReason: event.stopReason,
        ...(event.usage ? { usage: event.usage } : {}),
        ...(cfg.includeLlmContent && event.message ? { message: event.message } : {}),
      }, {
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        hook: "llm_output",
        pluginData: { agentId: ctx.agentId },
      });
    });

    // ── Subagent Lifecycle ──

    api.on("subagent_spawned", (event, ctx) => {
      enqueue("subagent", { phase: "spawned" }, {
        runId: event.runId || ctx.runId,
        sessionKey: event.childSessionKey,
        hook: "subagent_spawned",
        pluginData: {
          agentId: event.agentId,
          label: event.label,
          mode: event.mode,
          childSessionKey: event.childSessionKey,
        },
      });
    });

    api.on("subagent_ended", (event, ctx) => {
      enqueue("subagent", { phase: "ended" }, {
        runId: event.runId || ctx.runId,
        sessionKey: event.targetSessionKey,
        hook: "subagent_ended",
        pluginData: {
          targetSessionKey: event.targetSessionKey,
          reason: event.reason,
          outcome: event.outcome,
          ...(event.error ? { error: event.error } : {}),
        },
      });
    });

    // ── Messaging ──

    api.on("message_sent", (event, ctx) => {
      enqueue("assistant", {
        text: cfg.includeAssistantText ? (event as Record<string, unknown>).content || "" : "[redacted]",
      }, {
        sessionKey: ctx.sessionKey,
        hook: "message_sent",
        pluginData: {
          channel: ctx.channel,
          accountId: ctx.accountId,
        },
      });
    });

    // ── Gateway Lifecycle ──

    api.on("gateway_start", (event) => {
      enqueue("gateway", { phase: "start", port: event.port }, { hook: "gateway_start" });
    });

    api.on("gateway_stop", (event) => {
      enqueue("gateway", { phase: "stop", reason: event.reason }, { hook: "gateway_stop" });
      batcher.stop();
    });
  },
};

export default oeProvenancePlugin;
export type { PluginConfig, QueuedEvent } from "./types.js";
