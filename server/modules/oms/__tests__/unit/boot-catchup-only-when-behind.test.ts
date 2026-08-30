import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getLastRunAt,
  isBehindSchedule,
  recordRunCompleted,
} from "../../../../infrastructure/scheduler-run-registry";

const SWEEPER_SRC = readFileSync(
  resolve(__dirname, "../../fulfillment-sweeper.scheduler.ts"),
  "utf8",
);

/**
 * The sweeps replayed a full catch-up pass on every boot. That is right after
 * real downtime and pure waste otherwise - and Echelon deploys many times a day,
 * so it fired constantly against an app that had been up seconds earlier. Two
 * heavy sweeps allocating at once on a 512MB dyno is the shape behind the 1.4GB
 * peak and the R14/R15/H10 crash loop on 2026-08-28.
 *
 * A boot should now ask whether a scheduled run was genuinely missed.
 */

const HOUR = 60 * 60 * 1000;
const dbReturning = (rows: any[]) => ({ execute: vi.fn().mockResolvedValue({ rows }) });

describe("isBehindSchedule", () => {
  it("runs the catch-up when the job has never been recorded", async () => {
    await expect(isBehindSchedule(dbReturning([]), "fulfillment_outbound", HOUR)).resolves.toBe(true);
  });

  it("skips the catch-up right after an ordinary deploy", async () => {
    // The case this exists for: the app was up minutes ago, nothing was missed.
    const db = dbReturning([{ last_completed_at: new Date(Date.now() - 5 * 60 * 1000) }]);
    await expect(isBehindSchedule(db, "fulfillment_outbound", HOUR)).resolves.toBe(false);
  });

  it("runs the catch-up when a scheduled run was actually missed", async () => {
    const db = dbReturning([{ last_completed_at: new Date(Date.now() - 3 * HOUR) }]);
    await expect(isBehindSchedule(db, "fulfillment_outbound", HOUR)).resolves.toBe(true);
  });

  it("treats exactly one interval elapsed as behind", async () => {
    const now = new Date();
    const db = dbReturning([{ last_completed_at: new Date(now.getTime() - HOUR) }]);
    await expect(isBehindSchedule(db, "fulfillment_outbound", HOUR, now)).resolves.toBe(true);
  });

  it("fails OPEN when the lookup errors", async () => {
    // A needless sweep is waste; a skipped one can leave fulfillments unwritten.
    const db = { execute: vi.fn().mockRejectedValue(new Error("relation does not exist")) };
    await expect(isBehindSchedule(db, "fulfillment_outbound", HOUR)).resolves.toBe(true);
  });

  it("ignores an unparseable stored timestamp", async () => {
    const db = dbReturning([{ last_completed_at: "not-a-date" }]);
    await expect(getLastRunAt(db, "fulfillment_outbound")).resolves.toBeNull();
    await expect(isBehindSchedule(db, "fulfillment_outbound", HOUR)).resolves.toBe(true);
  });
});

describe("recordRunCompleted", () => {
  it("upserts so a second completion updates rather than duplicating", async () => {
    const db = dbReturning([]);
    await recordRunCompleted(db, "fulfillment_outbound");
    expect(db.execute).toHaveBeenCalledOnce();

    // Drizzle's sql`` builds a chunk list rather than a string; the literal SQL
    // lives in the StringChunk `value` arrays.
    const chunks = (db.execute.mock.calls[0][0] as any)?.queryChunks ?? [];
    const statement = chunks
      .map((chunk: any) => (Array.isArray(chunk?.value) ? chunk.value.join("") : ""))
      .join(" ");
    expect(statement).toMatch(/public\.scheduler_runs/);
    expect(statement).toMatch(/ON CONFLICT \(job_key\) DO UPDATE/);
  });
});

describe("fulfillment sweeper boot wiring", () => {
  it("gates both hourly boot sweeps on being behind", () => {
    // Both boot passes go through the shared helper, which is what pairs the
    // "am I behind?" check with recording the completion.
    expect(SWEEPER_SRC).toMatch(/jobKey: OUTBOUND_SWEEP_JOB_KEY,/);
    expect(SWEEPER_SRC).toMatch(/intervalMs: OUTBOUND_SWEEP_INTERVAL_MS,/);
    expect(SWEEPER_SRC).toMatch(/jobKey: INBOUND_SWEEP_JOB_KEY,/);
    expect(SWEEPER_SRC).toMatch(/intervalMs: INBOUND_SWEEP_INTERVAL_MS,/);
    expect(SWEEPER_SRC.match(/runBootCatchUpIfBehind\(/g) ?? []).toHaveLength(2);
  });

  it("records completion on the scheduled runs too, not just the boot pass", () => {
    // Recording only on boot would let the timestamp go stale, so every boot
    // would decide it is behind - defeating the whole change. The boot passes
    // record inside runBootCatchUpIfBehind; these are the two interval runs.
    const recordCalls = SWEEPER_SRC.match(/recordRunCompleted\(dbArg, \w+_SWEEP_JOB_KEY\)/g) ?? [];
    expect(recordCalls.length).toBe(2);
  });

  it("keeps the short-interval receipt recovery ungated", () => {
    // Its interval is 60s, so a boot pass costs almost nothing and gating it
    // would add a query for no benefit.
    expect(SWEEPER_SRC).toMatch(/INBOUND_RECEIPT_RECOVERY_INTERVAL_MS = 60_000/);
    const receiptBlock = SWEEPER_SRC.slice(
      SWEEPER_SRC.indexOf("RECEIPT_RECOVERY_LOCK_ID, async"),
      SWEEPER_SRC.indexOf("Inbound provider poll on boot"),
    );
    expect(receiptBlock).not.toMatch(/isBehindSchedule/);
  });
});

describe("migration 0625", () => {
  const MIGRATION = readFileSync(
    resolve(__dirname, "../../../../../migrations/0625_scheduler_runs.sql"),
    "utf8",
  );

  it("gives ON CONFLICT a key to target", () => {
    // Neither app_settings table was usable as a key/value store, so this owns
    // its own table; without the primary key the upsert fails at runtime.
    expect(MIGRATION).toMatch(/job_key VARCHAR\(100\) PRIMARY KEY/);
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS public\.scheduler_runs/);
  });
});
