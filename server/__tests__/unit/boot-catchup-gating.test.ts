import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runBootCatchUpIfBehind } from "../../infrastructure/scheduler-run-registry";

/**
 * Every long-interval scheduler replayed a full pass on boot. That is right
 * after real downtime and waste otherwise - and Echelon deploys many times a
 * day, so ten jobs fired inside two minutes of every boot against an app that
 * had been up seconds earlier. Several heavy passes allocating at once on a
 * 512MB dyno is the shape behind the R14/R15/H10 crash loop on 2026-08-28.
 *
 * PR #1296 gated the two fulfillment sweeps. This covers the rest of the
 * long-interval jobs, and pins which jobs are deliberately NOT gated.
 */

const root = (relative: string) => readFileSync(resolve(__dirname, "../../..", relative), "utf8");

const HOUR = 60 * 60 * 1000;
const dbReturning = (rows: any[]) => ({ execute: vi.fn().mockResolvedValue({ rows }) });

describe("runBootCatchUpIfBehind", () => {
  it("runs the pass and records it when a scheduled run was missed", async () => {
    const db = dbReturning([]); // never recorded
    const run = vi.fn().mockResolvedValue(undefined);

    const ran = await runBootCatchUpIfBehind({
      db, jobKey: "j", intervalMs: HOUR, logPrefix: "[t]", run,
    });

    expect(ran).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(db.execute).toHaveBeenCalledTimes(2); // read, then upsert
  });

  it("skips the pass entirely right after an ordinary deploy", async () => {
    const db = dbReturning([{ last_completed_at: new Date(Date.now() - 60_000) }]);
    const run = vi.fn().mockResolvedValue(undefined);

    const ran = await runBootCatchUpIfBehind({
      db, jobKey: "j", intervalMs: HOUR, logPrefix: "[t]", run,
    });

    expect(ran).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalledOnce(); // the read only - nothing recorded
  });

  it("does not record a completion when the pass throws", async () => {
    // Stamping a completion the job never reached would suppress the next
    // boot's catch-up, which is the one case the catch-up exists for.
    const db = dbReturning([]);
    const run = vi.fn().mockRejectedValue(new Error("sweep exploded"));

    await expect(runBootCatchUpIfBehind({
      db, jobKey: "j", intervalMs: HOUR, logPrefix: "[t]", run,
    })).rejects.toThrow("sweep exploded");

    expect(db.execute).toHaveBeenCalledOnce(); // the read only
  });
});

/**
 * Source-shape assertions. Each gated scheduler must do BOTH halves: gate the
 * boot pass, and record completion on the scheduled runs. Recording only on
 * boot lets the timestamp go stale, so every boot decides it is behind and the
 * gate silently stops gating.
 */
const GATED = [
  { name: "fulfillment sweeper (outbound + inbound)", file: "server/modules/oms/fulfillment-sweeper.scheduler.ts", boots: 2, records: 2 },
  { name: "cycle-count freeze guard", file: "server/modules/inventory/cycle-count-freeze-guard.scheduler.ts", boots: 1, records: 1 },
  { name: "OMS flow reconciliation", file: "server/modules/oms/oms-flow-reconciliation.service.ts", boots: 1, records: 1 },
  { name: "financial command retention", file: "server/platform/commands/financial-command-retention.worker.ts", boots: 1, records: 1 },
  { name: "sync recovery", file: "server/modules/sync/sync-recovery.service.ts", boots: 1, records: 1 },
];

describe("gated boot catch-ups", () => {
  it.each(GATED)("$name gates its boot pass", ({ file, boots }) => {
    const src = root(file);
    expect(src.match(/runBootCatchUpIfBehind\(/g) ?? []).toHaveLength(boots);
  });

  it.each(GATED)("$name records completion on its scheduled runs", ({ file, records }) => {
    const src = root(file);
    expect(src.match(/recordRunCompleted\(/g) ?? []).toHaveLength(records);
  });

  it("uses a distinct job key per scheduler", () => {
    const keys = GATED.flatMap(({ file }) =>
      [...root(file).matchAll(/JOB_KEY = "([a-z_]+)"/g)].map((m) => m[1]),
    );
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(6);
  });
});

/**
 * Deliberately NOT gated. Every one of these runs on an interval short enough
 * that the boot pass costs about one interval, and gating would add a database
 * round-trip on every boot to save almost nothing - while delaying queue drain
 * or alerting. Encoded here so the next person does not "finish the job".
 */
const UNGATED = [
  { name: "variant availability worker (15s queue drain)", file: "server/modules/channels/variant-availability-sync.worker.ts" },
  { name: "PO email outbox worker (15s queue drain)", file: "server/modules/procurement/po-email-outbox.worker.ts" },
  { name: "control tower projector (60s)", file: "server/modules/operations/control-tower-v2.scheduler.ts" },
  { name: "eBay order polling (5m, cadence marked non-negotiable)", file: "server/modules/oms/ebay-order-ingestion.ts" },
  { name: "OMS ops alerting (5m, alert latency)", file: "server/modules/oms/oms-ops-alert.service.ts" },
  { name: "carrier tracking reconciliation (5m)", file: "server/modules/shipping/carrier-tracking-reconciliation.scheduler.ts" },
];

describe("short-interval schedulers stay ungated", () => {
  it.each(UNGATED)("$name does not consult the run registry", ({ file }) => {
    expect(root(file)).not.toMatch(/scheduler-run-registry/);
  });
});
