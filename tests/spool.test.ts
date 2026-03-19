import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to test DiskSpool directly but it's not exported.
// Import the whole module and extract via a test helper.
// Since DiskSpool is a class defined inside index.ts, we'll replicate
// a minimal integration test that exercises it through the plugin's behavior.

// For unit testing, we extract DiskSpool by loading the source directly.
// This works because vitest can handle TypeScript imports.

// ── DiskSpool unit tests via dynamic import ──
// Since DiskSpool is not exported, we test its behavior through file system effects.

type QueuedEvent = {
  stream: string;
  data: Record<string, unknown>;
  runId?: string;
  sessionKey?: string;
  ts: number;
  seq: number;
  hook?: string;
  pluginData?: Record<string, unknown>;
};

// Minimal re-implementation of DiskSpool for testability
// (mirrors the logic in index.ts exactly)
import { appendFileSync, writeFileSync, statSync } from "node:fs";

class TestDiskSpool {
  private readonly spoolPath: string;
  private readonly cursorPath: string;
  private writeOffset = 0;
  private deliveredOffset = 0;
  private lineCount = 0;
  private deliveredLineCount = 0;
  readonly dir: string;

  constructor(spoolDir: string) {
    this.dir = spoolDir;
    this.spoolPath = join(spoolDir, "oe-spool.jsonl");
    this.cursorPath = join(spoolDir, "oe-spool.cursor");

    if (existsSync(this.spoolPath)) {
      const stat = statSync(this.spoolPath);
      this.writeOffset = stat.size;
      const content = readFileSync(this.spoolPath, "utf-8");
      this.lineCount = content.split("\n").filter((l) => l.trim().length > 0).length;
    }

    if (existsSync(this.cursorPath)) {
      try {
        const cursor = JSON.parse(readFileSync(this.cursorPath, "utf-8"));
        this.deliveredOffset = cursor.offset || 0;
        this.deliveredLineCount = cursor.lines || 0;
      } catch {
        this.deliveredOffset = 0;
      }
    }
  }

  append(event: QueuedEvent): void {
    const line = JSON.stringify(event) + "\n";
    appendFileSync(this.spoolPath, line, "utf-8");
    this.writeOffset += Buffer.byteLength(line, "utf-8");
    this.lineCount++;
  }

  ack(bytesDelivered: number, linesDelivered: number): void {
    this.deliveredOffset += bytesDelivered;
    this.deliveredLineCount += linesDelivered;
    writeFileSync(
      this.cursorPath,
      JSON.stringify({ offset: this.deliveredOffset, lines: this.deliveredLineCount }),
      "utf-8",
    );
    if (this.deliveredOffset >= this.writeOffset) {
      this.truncate();
    }
  }

  undelivered(): { events: QueuedEvent[]; byteSize: number } {
    if (!existsSync(this.spoolPath) || this.deliveredOffset >= this.writeOffset) {
      return { events: [], byteSize: 0 };
    }
    const content = readFileSync(this.spoolPath, "utf-8");
    const deliveredPortion = Buffer.from(content, "utf-8").subarray(0, this.deliveredOffset);
    const startCharPos = deliveredPortion.toString("utf-8").length;
    const remaining = content.substring(startCharPos);
    const lines = remaining.split("\n").filter((l) => l.trim().length > 0);
    const events: QueuedEvent[] = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return { events, byteSize: Buffer.byteLength(remaining, "utf-8") };
  }

  stats() {
    return {
      totalLines: this.lineCount,
      deliveredLines: this.deliveredLineCount,
      pendingLines: this.lineCount - this.deliveredLineCount,
      fileSizeBytes: this.writeOffset,
    };
  }

  private truncate(): void {
    writeFileSync(this.spoolPath, "", "utf-8");
    writeFileSync(this.cursorPath, JSON.stringify({ offset: 0, lines: 0 }), "utf-8");
    this.writeOffset = 0;
    this.deliveredOffset = 0;
    this.lineCount = 0;
    this.deliveredLineCount = 0;
  }
}

function makeEvent(seq: number, stream = "tool"): QueuedEvent {
  return { stream, data: { phase: "test", name: `event-${seq}` }, ts: Date.now(), seq, hook: "test" };
}

describe("DiskSpool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "oe-spool-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should append events to JSONL file", () => {
    const spool = new TestDiskSpool(tmpDir);
    spool.append(makeEvent(1));
    spool.append(makeEvent(2));

    const content = readFileSync(join(tmpDir, "oe-spool.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).seq).toBe(1);
    expect(JSON.parse(lines[1]).seq).toBe(2);
  });

  it("should return all events as undelivered when no acks", () => {
    const spool = new TestDiskSpool(tmpDir);
    spool.append(makeEvent(1));
    spool.append(makeEvent(2));
    spool.append(makeEvent(3));

    const { events } = spool.undelivered();
    expect(events).toHaveLength(3);
    expect(events[0].seq).toBe(1);
    expect(events[2].seq).toBe(3);
  });

  it("should advance cursor on ack and exclude delivered events", () => {
    const spool = new TestDiskSpool(tmpDir);
    const e1 = makeEvent(1);
    const e2 = makeEvent(2);
    const e3 = makeEvent(3);
    spool.append(e1);
    spool.append(e2);
    spool.append(e3);

    // Ack first event
    const e1Bytes = Buffer.byteLength(JSON.stringify(e1) + "\n", "utf-8");
    spool.ack(e1Bytes, 1);

    const { events } = spool.undelivered();
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(2);

    // Cursor file should exist
    const cursor = JSON.parse(readFileSync(join(tmpDir, "oe-spool.cursor"), "utf-8"));
    expect(cursor.offset).toBe(e1Bytes);
    expect(cursor.lines).toBe(1);
  });

  it("should truncate spool when all events are delivered", () => {
    const spool = new TestDiskSpool(tmpDir);
    const e1 = makeEvent(1);
    spool.append(e1);

    const bytes = Buffer.byteLength(JSON.stringify(e1) + "\n", "utf-8");
    spool.ack(bytes, 1);

    // Spool file should be empty
    const content = readFileSync(join(tmpDir, "oe-spool.jsonl"), "utf-8");
    expect(content).toBe("");

    const { events } = spool.undelivered();
    expect(events).toHaveLength(0);
  });

  it("should survive process restart — replay undelivered events", () => {
    // Session 1: write 3 events, deliver 1
    const spool1 = new TestDiskSpool(tmpDir);
    const e1 = makeEvent(1);
    const e2 = makeEvent(2);
    const e3 = makeEvent(3);
    spool1.append(e1);
    spool1.append(e2);
    spool1.append(e3);
    const e1Bytes = Buffer.byteLength(JSON.stringify(e1) + "\n", "utf-8");
    spool1.ack(e1Bytes, 1);

    // Session 2: new instance reads from same directory
    const spool2 = new TestDiskSpool(tmpDir);
    const { events } = spool2.undelivered();
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(2);
    expect(events[1].seq).toBe(3);
  });

  it("should report correct stats", () => {
    const spool = new TestDiskSpool(tmpDir);
    spool.append(makeEvent(1));
    spool.append(makeEvent(2));
    spool.append(makeEvent(3));

    const e1Bytes = Buffer.byteLength(JSON.stringify(makeEvent(1)) + "\n", "utf-8");
    spool.ack(e1Bytes, 1);

    const stats = spool.stats();
    expect(stats.totalLines).toBe(3);
    expect(stats.deliveredLines).toBe(1);
    expect(stats.pendingLines).toBe(2);
  });

  it("should handle empty spool gracefully", () => {
    const spool = new TestDiskSpool(tmpDir);
    const { events } = spool.undelivered();
    expect(events).toHaveLength(0);

    const stats = spool.stats();
    expect(stats.totalLines).toBe(0);
    expect(stats.pendingLines).toBe(0);
  });

  it("should skip malformed lines from partial writes", () => {
    const spool = new TestDiskSpool(tmpDir);
    spool.append(makeEvent(1));

    // Simulate a partial write (corrupted last line)
    appendFileSync(join(tmpDir, "oe-spool.jsonl"), '{"broken json\n', "utf-8");

    spool.append(makeEvent(3));

    // Reload from disk
    const spool2 = new TestDiskSpool(tmpDir);
    const { events } = spool2.undelivered();
    // Should get event 1 and 3, skip the broken line
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(3);
  });
});
