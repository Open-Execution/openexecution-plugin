/**
 * @module batcher
 * @description Event batching and delivery with retry logic
 *
 * License: Apache 2.0
 */
import { createHmac } from "node:crypto";
import type { QueuedEvent, ResolvedConfig } from "./types.js";
import type { DiskSpool } from "./spool.js";
import type { DisplayManager } from "./display.js";

type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/");
    const masked = segments.map((seg, i) =>
      i >= segments.length - 2 && seg.length > 0 ? seg.slice(0, 4) + "***" : seg,
    );
    u.pathname = masked.join("/");
    return u.toString();
  } catch {
    return url.replace(/(https?:\/\/[^/]+\/).*/, "$1***");
  }
}

export class EventBatcher {
  private queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private static readonly MAX_QUEUE_SIZE = 1000;
  private readonly config: ResolvedConfig;
  private readonly log: Logger;
  private readonly display: DisplayManager;
  private readonly spool: DiskSpool | null;
  readonly maskedUrl: string;
  private inflight = false;
  private lastOverflowWarn = 0;
  private droppedSinceLastWarn = 0;

  constructor(config: ResolvedConfig, log: Logger, display: DisplayManager, spool: DiskSpool | null) {
    this.config = config;
    this.log = log;
    this.display = display;
    this.spool = spool;
    this.maskedUrl = maskUrl(config.webhookUrl);
  }

  start() {
    if (this.timer) return;

    // Replay undelivered events from previous sessions
    if (this.spool) {
      const { events } = this.spool.undelivered();
      if (events.length > 0) {
        const replayBatch = events.slice(0, EventBatcher.MAX_QUEUE_SIZE);
        this.display.onSpoolReplay(replayBatch.length);
        if (events.length > EventBatcher.MAX_QUEUE_SIZE) {
          this.log.warn(
            `oe-provenance: ${events.length} undelivered events in spool, replaying first ${replayBatch.length}`,
          );
        }
        const maxReplayedSeq = events.reduce((max, e) => Math.max(max, e.seq || 0), 0);
        if (maxReplayedSeq >= this.seq) this.seq = maxReplayedSeq;
        this.queue.push(...replayBatch);
      }
    }

    this.timer = setInterval(() => {
      this.flush().catch((err) => this.log.error(`oe-provenance: flush error: ${String(err)}`));
    }, this.config.batchIntervalMs);

    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush().catch((err) => this.log.error(`oe-provenance: shutdown flush error: ${String(err)}`));
    this.display.onSessionEnd();
  }

  enqueue(event: QueuedEvent) {
    event.seq = ++this.seq;
    event.ts = Date.now();

    if (this.spool) {
      this.spool.append(event);
    }

    this.queue.push(event);

    // Display tracking
    if (this.config.displayMode === "verbose") {
      this.display.onEventEnqueued(event.stream, event.hook || "unknown");
    } else {
      this.display.trackEvent();
    }

    if (this.queue.length > EventBatcher.MAX_QUEUE_SIZE) {
      const dropped = this.queue.length - EventBatcher.MAX_QUEUE_SIZE;
      this.queue.splice(0, dropped);
      this.droppedSinceLastWarn += dropped;
      const now = Date.now();
      if (now - this.lastOverflowWarn > 10_000) {
        this.display.onQueueOverflow(this.droppedSinceLastWarn, !!this.spool);
        this.droppedSinceLastWarn = 0;
        this.lastOverflowWarn = now;
      }
    }

    if (this.queue.length >= this.config.batchMaxSize) {
      this.flush().catch((err) => this.log.error(`oe-provenance: flush error: ${String(err)}`));
    }
  }

  private async flush() {
    if (this.queue.length === 0 || this.inflight) return;

    const batch = this.queue.splice(0, this.config.batchMaxSize);
    this.inflight = true;
    if (this.spool) this.spool.compactionEnabled = false;

    const startTime = Date.now();
    try {
      await this.deliver(batch);
      this.display.onBatchDelivered(batch.length, Date.now() - startTime);
    } catch (err) {
      this.display.onBatchFailed(batch.length, String(err));
    } finally {
      this.inflight = false;
      if (this.spool) this.spool.compactionEnabled = true;
    }

    // Reload more events from spool if queue is empty
    if (this.queue.length === 0 && this.spool) {
      const { events } = this.spool.undelivered();
      if (events.length > 0) {
        const reloadBatch = events.slice(0, EventBatcher.MAX_QUEUE_SIZE);
        this.log.info(`oe-provenance: reloading ${reloadBatch.length} more events from spool`);
        this.queue.push(...reloadBatch);
      }
    }
  }

  private async deliver(events: QueuedEvent[]) {
    for (let i = 0; i < events.length; i++) {
      try {
        await this.deliverSingle(events[i]);
        if (this.spool && events[i]._spoolBytes) {
          this.spool.ack(events[i]._spoolBytes, 1);
        }
      } catch (err) {
        const undelivered = events.slice(i);
        this.queue.unshift(...undelivered);
        throw err;
      }
    }
  }

  private async deliverSingle(event: QueuedEvent) {
    const { _spoolBytes: _, ...payload } = event;
    const body = JSON.stringify(payload);
    const signature = "sha256=" + createHmac("sha256", this.config.webhookSecret).update(body).digest("hex");
    const deliveryId = `${event.runId || "no-run"}:${event.seq}`;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.config.retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

        try {
          const res = await fetch(this.config.webhookUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-openclaw-signature": signature,
              "x-openclaw-delivery": deliveryId,
            },
            body,
            signal: controller.signal,
          });

          if (res.ok) return;

          const resBody = await res.text().catch(() => "");
          lastError = new Error(`HTTP ${res.status}: ${resBody.slice(0, 200)}`);

          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            this.log.error(
              `oe-provenance: non-retryable ${res.status} — delivery ${deliveryId}: ${lastError.message}`,
            );
            return;
          }
        } finally {
          clearTimeout(timer);
        }

        if (attempt < this.config.retryAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          await new Promise((r) => setTimeout(r, delay));
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.config.retryAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError || new Error("delivery failed");
  }
}
