/**
 * @module spool
 * @description Append-only JSONL spool with cursor-based delivery tracking (Write-Ahead Log)
 *
 * Design:
 *   - Events are appended to a .jsonl file (one JSON line per event)
 *   - A .cursor file stores the byte offset of the last successfully delivered event
 *   - On startup, undelivered() returns all events after the cursor
 *   - When all events are delivered, the spool file is truncated
 *   - When the spool exceeds maxSizeBytes, old delivered events are compacted
 *
 * All writes use *Sync to guarantee crash safety — if the process dies mid-write,
 * the worst case is a partial last line which is safely skipped on replay.
 *
 * License: Apache 2.0
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { QueuedEvent } from "./types.js";

type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

export class DiskSpool {
  private readonly spoolPath: string;
  private readonly cursorPath: string;
  private readonly maxSizeBytes: number;
  private readonly log: Logger;
  private writeOffset = 0;
  private deliveredOffset = 0;
  private lineCount = 0;
  /** Set to false during in-flight delivery to prevent compaction from invalidating cursor state */
  compactionEnabled = true;
  private deliveredLineCount = 0;

  constructor(spoolDir: string, maxSizeMb: number, log: Logger) {
    this.log = log;
    this.maxSizeBytes = maxSizeMb * 1024 * 1024;
    this.spoolPath = join(spoolDir, "oe-spool.jsonl");
    this.cursorPath = join(spoolDir, "oe-spool.cursor");

    if (!existsSync(spoolDir)) {
      mkdirSync(spoolDir, { recursive: true });
    }

    if (existsSync(this.spoolPath)) {
      try {
        const stat = statSync(this.spoolPath);
        this.writeOffset = stat.size;
        const content = readFileSync(this.spoolPath, "utf-8");
        this.lineCount = content.split("\n").filter((l) => l.trim().length > 0).length;
      } catch {
        this.writeOffset = 0;
        this.lineCount = 0;
      }
    }

    if (existsSync(this.cursorPath)) {
      try {
        const cursor = JSON.parse(readFileSync(this.cursorPath, "utf-8"));
        this.deliveredOffset = cursor.offset || 0;
        this.deliveredLineCount = cursor.lines || 0;
      } catch {
        this.deliveredOffset = 0;
        this.deliveredLineCount = 0;
      }
    }
  }

  /** Append an event to the spool file. Records exact byte size on the event for cursor tracking. */
  append(event: QueuedEvent): void {
    const line = JSON.stringify(event) + "\n";
    const byteLen = Buffer.byteLength(line, "utf-8");
    try {
      appendFileSync(this.spoolPath, line, "utf-8");
      this.writeOffset += byteLen;
      this.lineCount++;
      event._spoolBytes = byteLen;
    } catch (err) {
      this.log.error(`openclaw-provenance: spool write error (event will be delivered from memory only): ${String(err)}`);
    }

    if (this.compactionEnabled && this.writeOffset > this.maxSizeBytes && this.deliveredOffset > this.writeOffset * 0.5) {
      this.compact();
    }
  }

  /** Advance the delivery cursor after successful delivery. */
  ack(bytesDelivered: number, linesDelivered: number): void {
    this.deliveredOffset += bytesDelivered;
    this.deliveredLineCount += linesDelivered;
    try {
      writeFileSync(
        this.cursorPath,
        JSON.stringify({ offset: this.deliveredOffset, lines: this.deliveredLineCount }),
        "utf-8",
      );
    } catch (err) {
      this.log.error(`openclaw-provenance: cursor write error: ${String(err)}`);
    }

    if (this.deliveredOffset >= this.writeOffset) {
      this.truncate();
    }
  }

  /** Read all undelivered events from the spool. */
  undelivered(): { events: QueuedEvent[]; byteSize: number } {
    if (!existsSync(this.spoolPath) || this.deliveredOffset >= this.writeOffset) {
      return { events: [], byteSize: 0 };
    }

    try {
      const content = readFileSync(this.spoolPath, "utf-8");
      const deliveredPortion = Buffer.from(content, "utf-8").subarray(0, this.deliveredOffset);
      const startCharPos = deliveredPortion.toString("utf-8").length;
      const remaining = content.substring(startCharPos);
      const lines = remaining.split("\n").filter((l) => l.trim().length > 0);

      const events: QueuedEvent[] = [];
      for (const line of lines) {
        try {
          const event: QueuedEvent = JSON.parse(line);
          event._spoolBytes = Buffer.byteLength(line + "\n", "utf-8");
          events.push(event);
        } catch {
          this.log.warn("openclaw-provenance: skipping malformed spool line");
        }
      }

      const byteSize = Buffer.byteLength(remaining, "utf-8");
      return { events, byteSize };
    } catch (err) {
      this.log.error(`openclaw-provenance: spool read error: ${String(err)}`);
      return { events: [], byteSize: 0 };
    }
  }

  /** Get spool stats for logging. */
  stats(): { totalLines: number; deliveredLines: number; pendingLines: number; fileSizeBytes: number } {
    return {
      totalLines: this.lineCount,
      deliveredLines: this.deliveredLineCount,
      pendingLines: this.lineCount - this.deliveredLineCount,
      fileSizeBytes: this.writeOffset,
    };
  }

  /** Remove all delivered events, keeping only undelivered ones. */
  private compact(): void {
    try {
      const { events } = this.undelivered();
      if (events.length === 0) {
        this.truncate();
        return;
      }
      const tmpPath = this.spoolPath + ".tmp";
      const lines = events.map((e) => {
        const { _spoolBytes: _, ...clean } = e;
        return JSON.stringify(clean) + "\n";
      }).join("");
      writeFileSync(tmpPath, lines, "utf-8");
      writeFileSync(this.cursorPath, JSON.stringify({ offset: 0, lines: 0 }), "utf-8");
      renameSync(tmpPath, this.spoolPath);

      const newSize = Buffer.byteLength(lines, "utf-8");
      this.log.info(
        `openclaw-provenance: spool compacted — ${this.lineCount - events.length} delivered events removed, ` +
          `${events.length} pending retained (${(newSize / 1024).toFixed(1)}KB)`,
      );
      this.writeOffset = newSize;
      this.deliveredOffset = 0;
      this.lineCount = events.length;
      this.deliveredLineCount = 0;
    } catch (err) {
      this.log.error(`openclaw-provenance: spool compact error: ${String(err)}`);
    }
  }

  /** Truncate spool and cursor — called when fully caught up. */
  private truncate(): void {
    try {
      writeFileSync(this.spoolPath, "", "utf-8");
      writeFileSync(this.cursorPath, JSON.stringify({ offset: 0, lines: 0 }), "utf-8");
      this.writeOffset = 0;
      this.deliveredOffset = 0;
      this.lineCount = 0;
      this.deliveredLineCount = 0;
    } catch (err) {
      this.log.error(`openclaw-provenance: spool truncate error: ${String(err)}`);
    }
  }
}
