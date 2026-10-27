import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { instrumentQueries, type OwnerMeasurement } from "./query-measurement";

/** Explicit operator-invoked local experiment, not an ordinary CI unit test.
 * Caller creates a new empty database and removes it after this process ends.
 * Example: VITEST=true ECHELON_TEST_DATABASE_DISPOSABLE=true
 * ECHELON_TEST_DATABASE_URL=<new loopback database> node --import tsx
 * test/performance/procurement/run-health-cost.ts <absolute report.json> [10,100,500] [unresolved|posted]
 */
async function main(): Promise<void> {
  if (!process.env.VITEST || process.env.DISABLE_SCHEDULERS !== "true" || process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL
    || process.env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true") {
    throw new Error("Clear live database variables and explicitly enable disposable performance verification");
  }
  const url = process.env.ECHELON_TEST_DATABASE_URL;
  if (!url) throw new Error("ECHELON_TEST_DATABASE_URL is required");
  const outputArgument = process.argv[2];
  if (!outputArgument || !isAbsolute(outputArgument) || !outputArgument.endsWith(".json")) throw new Error("An absolute JSON evidence path is required");
  const output = resolve(outputArgument);
  const tiers = (process.argv[3] ?? "10,100,500").split(",").map(Number);
  if (!tiers.length || tiers.some((value, index) => ![10,100,500].includes(value) || (index > 0 && value <= tiers[index - 1]))) throw new Error("Use ascending bounded tiers 10,100,500");
  const mode = process.argv[4] ?? "unresolved";
  if (!["unresolved", "posted"].includes(mode) || (mode === "posted" && tiers.some(tier => tier > 100))) throw new Error("Posted verification is bounded to 10/100 shipments");
  const files = ["server/modules/procurement/shipment-tracking.service.ts", "server/modules/procurement/po-shipment-cost-summary.repository.ts",
    "server/modules/procurement/procurement-health-summary.service.ts", "server/modules/procurement/purchase-cost-status.repository.ts",
    "server/modules/procurement/purchase-cost-status-snapshot.repository.ts", "server/modules/procurement/shipment-cost-review.repository.ts",
    "server/modules/procurement/shipment-cost-posting-read.repository.ts", "server/modules/procurement/procurement.storage.ts",
    "server/modules/procurement/domain/current-shipment-cost-source.ts", "server/modules/procurement/shipment-health-evidence.repository.ts",
    "shared/money-read.ts", "shared/utils/money.ts",
    "test/performance/procurement/query-measurement.ts", "test/performance/procurement/health-cost.fixture.ts",
    "test/performance/procurement/run-health-cost.ts"];
  const source = () => Object.fromEntries(files.map(file => [file,
    existsSync(resolve(file)) ? createHash("sha256").update(readFileSync(resolve(file))).digest("hex") : null]));
  const report: Record<string, unknown> = {
    version: 1, mode, startedAt: new Date().toISOString(), head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceBefore: source(), tiers, limits: { shipments: 500, linesPerShipment: 5, maximumFanoutShipmentsForOnePo: 100,
      repeats: 3, ownerBudgetMs: 60_000, statementTimeoutMs: 15_000, singleProcess: true },
    limitations: ["Synthetic local distribution; no production records or statistics were read.",
      "The fixture installs actual schema columns and selected owner migrations/indexes, not the full release migration chain; inspect the saved table/index catalog.",
      mode === "unresolved" ? "Closed shipments deliberately have estimated freight without allocation/application evidence. This measures unresolved health and source reads, not a heavily transformed lot graph."
        : "Closed shipments have real receipts, lot lineage, finalized estimated freight and applied cost revisions. Product/packaging estimates remain provisional. No transformed or sold lot graph is simulated.",
      "Catalog/demand/forecast tables are small. Full purchasing-health owner is executed, but this experiment does not certify large sales-history planning queries.",
      "Three serial samples per owner are diagnostic, not a production latency SLO. The first is cold relative to this experiment; later samples share PostgreSQL/OS caches.",
      "RSS sampling at 20 ms reports the process observed peak, not an allocation profile. SQL duration totals may exceed wall time for parallel health reads."],
    measurements: [],
  };
  const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  save();
  const { createProcurementPerformanceFixture, PERFORMANCE_AS_OF, PERFORMANCE_ID_BASE, PERFORMANCE_FANOUT_LIMIT } = await import("./health-cost.fixture");
  const fixture = await createProcurementPerformanceFixture(url, mode as "unresolved" | "posted").catch(error => {
    report.status = "fixture_failed";
    report.failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
    save();
    throw error;
  });
  const instrumentation = instrumentQueries(fixture.harness.pool);
  try {
    report.identity = fixture.identity;
    report.schema = await fixture.metadata();
    const [{ loadProcurementHealthSummary }, { readPoShipmentCosts }, { inventoryStorage }] = await Promise.all([
      import("../../../server/modules/procurement/procurement-health-summary.service"),
      import("../../../server/modules/procurement/po-shipment-cost-summary.repository"),
      import("../../../server/modules/inventory"),
    ]);
    const healthStorage = { ...fixture.harness.storage, getVelocityLookbackDays: () => inventoryStorage.getVelocityLookbackDays() };
    const previous = new Map<string, { tier: number; elapsedMs: number }>();
    for (const tier of tiers) {
      // Stop before a larger dataset if the previous observed full-scan time
      // projects past the per-owner budget. Never reduce evidence coverage to
      // make a slow result appear successful.
      const projected = [...previous].find(([label, sample]) => ["landed-health", "filtered-shipments", "purchasing-health"].includes(label)
        && sample.elapsedMs * tier / sample.tier > 60_000);
      if (projected) { report.stopped = { beforeTier: tier, reason: "prior full-scan measurement projects beyond 60 seconds", owner: projected[0], prior: projected[1] }; break; }
      await fixture.seedTo(tier);
      await fixture.readOnly(true);
      const before = await fixture.fingerprint();
      const fanout = Math.min(tier, PERFORMANCE_FANOUT_LIMIT);
      const measurements: Array<{ tier: number; owner: string; samples: OwnerMeasurement<unknown>[] }> = [];
      const run = async <T>(label: string, operation: () => Promise<T>, verify: (value: T) => void): Promise<void> => {
        const samples: OwnerMeasurement<T>[] = [];
        for (let repeat = 0; repeat < 3; repeat++) {
          const sample = await instrumentation.measure(label, operation);
          verify(sample.value);
          samples.push(sample);
          console.log(JSON.stringify({ tier, owner: label, repeat, elapsedMs: Math.round(sample.elapsedMs), queries: sample.queries }));
        }
        assert.ok(samples.every(sample => sample.queries === samples[0].queries), `${label} query count must remain stable for unchanged evidence`);
        previous.set(label, { tier, elapsedMs: Math.max(...samples.map(sample => sample.elapsedMs)) });
        measurements.push({ tier, owner: label, samples });
        (report.measurements as unknown[]).push(measurements[measurements.length - 1]);
        save();
      };
      await run("landed-health", () => fixture.harness.shipment.getLandedCostHealth({ limit: 250 }), value => {
        assert.equal(value.scannedShipments, tier);
        assert.equal(value.counts.allocationBlockers, mode === "posted" ? 0 : tier);
        assert.equal(value.counts.pendingFinalization, mode === "posted" ? 0 : tier);
        assert.equal(value.counts.postingReviewRequired, mode === "posted" ? 0 : tier);
        assert.equal(value.critical, mode === "posted" ? 0 : tier * 3);
        assert.equal(value.counts.provisionalOtherCosts, tier);
        assert.equal(value.warning, tier);
        assert.equal(value.items.length, Math.min(250, value.critical + value.warning));
      });
      await run("unfiltered-shipments", () => fixture.harness.shipment.getShipmentPage({ limit: 50 }), value => {
        assert.equal(value.total, tier);
        assert.equal(value.shipments.length, Math.min(50, tier));
        assert.equal(value.shipments[0].id, PERFORMANCE_ID_BASE + tier);
        assert.ok(value.shipments.every(shipment => shipment.purchaseOrders.length === 1));
      });
      await run("filtered-shipments", () => fixture.harness.shipment.getShipmentPage({ limit: 50, costFilter: mode === "posted" ? "any" : "critical" }), value => {
        assert.equal(value.total, tier);
        assert.equal(value.shipments.length, Math.min(50, tier));
        assert.equal(value.shipments[0].id, PERFORMANCE_ID_BASE + tier);
      });
      await run("purchasing-health", () => loadProcurementHealthSummary({ shipmentTracking: fixture.harness.shipment,
        limit: 50, db: fixture.harness.database, storage: healthStorage, asOf: PERFORMANCE_AS_OF }), value => {
        const landed = value.sources.find(source => source.key === "landed_cost_health");
        assert.ok(landed);
        assert.equal(landed.critical, mode === "posted" ? 0 : tier * 3);
        assert.equal(landed.warning, tier);
        if (mode === "unresolved") assert.equal(value.status, "critical");
      });
      await run("po-cost-fanout", () => readPoShipmentCosts(fixture.harness.database, PERFORMANCE_ID_BASE + 1), value => {
        assert.ok(value);
        assert.equal(value.summary.shipmentCount, fanout);
        assert.equal(value.summary.chargeCount, fanout);
        assert.equal(value.summary.unallocatedChargeCount, mode === "posted" ? 0 : fanout);
        assert.equal(value.summary.totalCents, mode === "posted" ? fanout * 1_000 : 0);
        assert.equal(value.summary.poAmountCents, 5_000_000);
        if (mode === "unresolved") assert.equal(value.summary.combinedCostCents, null);
        assert.equal(value.lines.length, fanout * 5);
      });
      if (tier > PERFORMANCE_FANOUT_LIMIT) await run("po-cost-single", () => readPoShipmentCosts(fixture.harness.database, PERFORMANCE_ID_BASE + tier), value => {
        assert.ok(value);
        assert.equal(value.summary.shipmentCount, 1);
        assert.equal(value.summary.chargeCount, 1);
        assert.equal(value.summary.poAmountCents, 50_000);
        assert.equal(value.lines.length, 5);
      });
      // Small-data correctness checks isolate display limits from scan coverage.
      if (tier === 10) {
        const narrow = await fixture.harness.shipment.getLandedCostHealth({ limit: 1 });
        const wide = await fixture.harness.shipment.getLandedCostHealth({ limit: 250 });
        assert.deepEqual(narrow.counts, wide.counts);
        assert.equal(narrow.critical, wide.critical);
        assert.equal(narrow.warning, wide.warning);
        assert.equal(narrow.items.length, 1);
        const first = await fixture.harness.shipment.getShipmentPage({ limit: 1, costFilter: mode === "posted" ? "any" : "critical" });
        const second = await fixture.harness.shipment.getShipmentPage({ limit: 1, costFilter: mode === "posted" ? "any" : "critical", offset: 1 });
        assert.equal(first.total, second.total);
        assert.notEqual(first.shipments[0].id, second.shipments[0].id);
        assert.deepEqual(first.costHealthItems, wide.items.filter(item => item.shipmentId === first.shipments[0].id));
        assert.equal((await fixture.harness.shipment.getShipmentPage({ costFilter: "ready_to_push" })).total, 0);
      }
      assert.deepEqual(await fixture.fingerprint(), before, "No measured owner may alter any synthetic business row");
      (report.fingerprints ??= [] as unknown[]);
      (report.fingerprints as unknown[]).push({ tier, unchanged: true, tables: before });
      await fixture.readOnly(false);
      save();
    }
    assert.deepEqual(source(), report.sourceBefore, "Measured source must remain unchanged during the experiment");
    report.status = report.stopped ? "bounded_stop" : "passed";
  } catch (error) {
    report.status = "failed";
    report.failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
    throw error;
  } finally {
    instrumentation.restore();
    try { await fixture.dispose(); report.disposed = true; }
    finally {
      report.sourceAfter = source();
      report.finishedAt = new Date().toISOString();
      save();
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
