/**
 * @module display
 * @description Terminal display manager — controls what the plugin shows in OpenClaw's terminal
 *
 * License: Apache 2.0
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/openclaw-provenance";
import type { ResolvedConfig } from "./types.js";

/**
 * Manages plugin display output within OpenClaw's terminal.
 * Respects the configured displayMode to control verbosity.
 */
export class DisplayManager {
  private readonly log: OpenClawPluginApi["logger"];
  private readonly config: ResolvedConfig;
  private readonly prefix: string;

  // Session stats
  private eventsSent = 0;
  private eventsDropped = 0;
  private batchesSent = 0;
  private batchesFailed = 0;
  private sessionStartTime = Date.now();

  constructor(config: ResolvedConfig, log: OpenClawPluginApi["logger"]) {
    this.config = config;
    this.log = log;
    this.prefix = config.displayPrefix;
  }

  /** Show plugin initialization message */
  onInit(maskedUrl: string, spoolEnabled: boolean): void {
    if (this.config.displayMode === "silent") return;

    const privacyDesc = this.getPrivacyDescription();
    this.log.info(
      `${this.prefix}: connected → ${maskedUrl} ` +
        `(batch=${this.config.batchIntervalMs}ms, spool=${spoolEnabled ? "on" : "off"}, privacy=${privacyDesc})`,
    );
  }

  /** Show event enqueue (verbose only) */
  onEventEnqueued(stream: string, hook: string): void {
    if (this.config.displayMode !== "verbose") return;
    this.eventsSent++;
    this.log.info(`${this.prefix}: ← ${stream}/${hook}`);
  }

  /** Track event without display (for non-verbose modes) */
  trackEvent(): void {
    this.eventsSent++;
  }

  /** Show batch delivery result */
  onBatchDelivered(count: number, durationMs: number): void {
    this.batchesSent++;
    if (!this.config.showDeliveryStatus && this.config.displayMode !== "verbose") return;
    this.log.info(`${this.prefix}: ✓ ${count} events delivered (${durationMs}ms)`);
  }

  /** Show batch delivery failure */
  onBatchFailed(count: number, error: string): void {
    this.batchesFailed++;
    this.eventsDropped += count;
    if (this.config.displayMode === "silent") return;
    this.log.warn(`${this.prefix}: ✗ batch failed (${count} events): ${error}`);
  }

  /** Show spool replay info */
  onSpoolReplay(count: number): void {
    if (this.config.displayMode === "silent") return;
    this.log.info(`${this.prefix}: replaying ${count} events from previous session`);
  }

  /** Show session summary on shutdown */
  onSessionEnd(): void {
    if (!this.config.showSessionSummary || this.config.displayMode === "silent") return;

    const duration = Math.round((Date.now() - this.sessionStartTime) / 1000);
    const parts = [
      `${this.eventsSent} events`,
      `${this.batchesSent} batches`,
    ];
    if (this.batchesFailed > 0) parts.push(`${this.batchesFailed} failed`);
    if (this.eventsDropped > 0) parts.push(`${this.eventsDropped} dropped`);
    parts.push(`${duration}s`);

    this.log.info(`${this.prefix}: session summary — ${parts.join(", ")}`);
  }

  /** Show memory queue overflow warning */
  onQueueOverflow(dropped: number, spoolEnabled: boolean): void {
    if (this.config.displayMode === "silent") return;
    this.log.warn(
      `${this.prefix}: queue overflow — dropped ${dropped} from memory` +
        (spoolEnabled ? " (events safe on disk)" : " (events LOST — enable spool)"),
    );
  }

  /** Get a human-readable privacy description */
  private getPrivacyDescription(): string {
    const { includeToolArgs, includeToolResults, includeLlmContent, includeAssistantText } = this.config;
    if (includeToolArgs && includeToolResults && includeLlmContent && includeAssistantText) return "full";
    if (!includeToolArgs && !includeToolResults && !includeLlmContent && !includeAssistantText) return "minimal";
    if (!includeToolArgs && !includeToolResults && !includeLlmContent && includeAssistantText) return "metadata";

    const parts: string[] = [];
    if (includeToolArgs) parts.push("args");
    if (includeToolResults) parts.push("results");
    if (includeLlmContent) parts.push("llm");
    if (includeAssistantText) parts.push("text");
    return parts.length > 0 ? parts.join("+") : "events-only";
  }
}
