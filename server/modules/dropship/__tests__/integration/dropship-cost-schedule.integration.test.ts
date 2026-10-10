import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PgDropshipCostScheduleRepository } from "../../infrastructure/dropship-cost-schedule.repository";
import { PgDropshipCostChangeListingActionRepository } from "../../infrastructure/dropship-cost-change-listing-action.repository";
import { PgDropshipCostChangeNoticeRepository } from "../../infrastructure/dropship-cost-change-notice.repository";
import { emptyEventCounts, type CostScheduleVendorTransaction } from "../../application/dropship-cost-detection-service";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;

const NOW = new Date("2026-09-28T16:05:00.000Z");
const LATER = new Date("2026-09-28T17:05:00.000Z");
const IN_TWO_WEEKS = new Date("2026-10-13T00:00:00.000Z");
const planPercent = { source: "plan_percent", planId: "ops", overrideId: null, retailPriceCents: 899, discountBps: 1000 };

/**
 * Migrations 0710 and 0711 and the repository run against real PostgreSQL in
 * a schema of their own, so the bulk inserts, the immutability triggers, the
 * CHECKs and the joins are proven on the engine, not on a fake client.
 */
describeDatabase.sequential("cost schedule PostgreSQL guarantees (migration 0711)", () => {
  const schema = `dropship_cost_schedule_${process.pid}`;
  let pool: pg.Pool;
  let repository: PgDropshipCostScheduleRepository;
  let notices: PgDropshipCostChangeNoticeRepository;
  let actions: PgDropshipCostChangeListingActionRepository;

  function qualify(sql: string): string {
    return sql.replace(/\b(dropship|catalog)\.([a-z_]+)/g, (_table, _namespace, name) => `"${schema}"."${name}"`);
  }

  /** The repository's pool, with every statement re-pointed at the test schema. */
  function qualifiedPool(): Pool {
    return {
      query: (sql: string, values?: unknown[]) => pool.query(qualify(sql), values),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql: string, values?: unknown[]) => client.query(qualify(sql), values),
          release: (discard?: boolean) => client.release(discard),
        } as unknown as PoolClient;
      },
    } as unknown as Pool;
  }

  beforeAll(async () => {
    if (!testUrl || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(testUrl)) {
      throw new Error("ECHELON_TEST_DATABASE_URL must name a disposable database that is not the app database.");
    }
    pool = new pg.Pool({ connectionString: testUrl, max: 3 });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(qualify(`
      CREATE TABLE dropship.dropship_vendors (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, business_name varchar(200), status varchar(30) NOT NULL DEFAULT 'active');
      CREATE TABLE catalog.products (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, name text NOT NULL);
      CREATE TABLE catalog.product_variants (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, product_id integer NOT NULL REFERENCES catalog.products(id),
        sku varchar(100), name text NOT NULL);
      CREATE TABLE dropship.dropship_store_connections (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, vendor_id integer NOT NULL);
      INSERT INTO dropship.dropship_store_connections (vendor_id) VALUES (1), (1), (2), (3);
      CREATE TABLE dropship.dropship_listing_push_jobs (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, vendor_id integer NOT NULL);
      INSERT INTO dropship.dropship_listing_push_jobs (vendor_id) VALUES (1);
      CREATE TABLE dropship.dropship_listing_price_settings (
        vendor_id integer NOT NULL, store_connection_id integer NOT NULL, product_variant_id integer NOT NULL,
        override_price_cents integer, pricing_mode text, PRIMARY KEY (store_connection_id, product_variant_id));
      CREATE TABLE dropship.dropship_pricing_profile_revisions (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, vendor_id integer NOT NULL, store_connection_id integer NOT NULL,
        profile jsonb NOT NULL, created_at timestamptz NOT NULL);
      CREATE TABLE dropship.dropship_pricing_profiles (store_connection_id integer PRIMARY KEY, vendor_id integer NOT NULL, revision_id integer NOT NULL);
      CREATE TABLE dropship.dropship_vendor_listings (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
        store_connection_id integer NOT NULL, product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
        status varchar(40) NOT NULL DEFAULT 'not_listed', vendor_retail_price_cents bigint, platform varchar(30) NOT NULL DEFAULT 'shopify');
      INSERT INTO dropship.dropship_vendors (business_name, status)
        VALUES ('Shellz Vendor', 'active'), ('Paused Vendor', 'paused'), ('Closed Vendor', 'closed');
      INSERT INTO catalog.products (name) VALUES ('Armor Envelope');
      INSERT INTO catalog.product_variants (product_id, sku, name)
        VALUES (1, 'ARM-ENV-SGL-P50', 'Single pack'), (1, NULL, 'Case of 10'), (1, 'ARM-ENV-XL', 'XL pack');
      INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, status, vendor_retail_price_cents) VALUES
        (1, 1, 1, 'active', 899), (1, 1, 2, 'preview_ready', NULL), (1, 2, 1, 'queued', NULL), (1, 1, 3, 'ended', NULL), (1, 1, 3, 'not_listed', NULL),
        (2, 3, 1, 'paused', NULL), (3, 4, 1, 'active', 1_299);
      INSERT INTO dropship.dropship_listing_price_settings (vendor_id, store_connection_id, product_variant_id, override_price_cents, pricing_mode)
        VALUES (1, 2, 1, NULL, 'rules');
      INSERT INTO dropship.dropship_pricing_profile_revisions (vendor_id, store_connection_id, profile, created_at) VALUES
        (1, 2, '{"defaultRecipe":{"basis":"product_cost","markupBps":4000,"flatCents":0,"rounding":"cent"},"groups":[]}', '2026-09-01T00:00:00Z');
      INSERT INTO dropship.dropship_pricing_profiles (store_connection_id, vendor_id, revision_id) VALUES (2, 1, 1);
    `));
    for (const file of ["0710_dropship_cost_change_policy.sql", "0711_dropship_cost_schedule.sql", "0712_dropship_cost_change_notices.sql",
      "0713_dropship_cost_change_listing_actions.sql"]) {
      await pool.query(qualify(readFileSync(resolve(process.cwd(), "migrations", file), "utf8")));
    }
    repository = new PgDropshipCostScheduleRepository(qualifiedPool());
    notices = new PgDropshipCostChangeNoticeRepository(qualifiedPool());
    actions = new PgDropshipCostChangeListingActionRepository(qualifiedPool(), {
      listCatalogCandidates: async (ids) => ids.map((id) => ({ productVariantId: id, productId: 1, category: null, productLineIds: [], defaultRetailPriceCents: 899 })),
      listPricingPolicies: async () => [],
    });
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool?.end();
  });

  it("applies the migrations twice without error, and seeds one state row", async () => {
    for (const file of ["0711_dropship_cost_schedule.sql", "0712_dropship_cost_change_notices.sql", "0713_dropship_cost_change_listing_actions.sql"]) {
      await pool.query(qualify(readFileSync(resolve(process.cwd(), "migrations", file), "utf8")));
    }
    const state = await repository.readDetectionState();
    expect(state).toEqual({
      passNumber: 0, passStartedAt: null, passCompletedAt: null, cursorVendorId: null, policyId: null,
      passVendorsProcessed: 0, passVariantsRead: 0, passUnavailableReadings: 0, passChangesRecorded: 0, lastTickAt: null,
    });
  });

  it("walks watched vendors after the cursor and lists a vendor's tracked variants once each", async () => {
    expect(await repository.listVendorsAfter({ afterVendorId: null, limit: 10 })).toEqual([1, 2]);
    expect(await repository.listVendorsAfter({ afterVendorId: 1, limit: 10 })).toEqual([2]);
    expect(await repository.listVendorsAfter({ afterVendorId: null, limit: 1 })).toEqual([1]);
    const variants = await repository.withVendorSchedule(1, (transaction) => transaction.listTrackedVariantIds());
    // Variant 3 is only ended or never listed; variant 1 is listed in two stores.
    expect(variants).toEqual([1, 2]);
  });

  it("records baselines, an announced increase, its lowering and its withdrawal, with the log and cursor in step", async () => {
    await repository.recordTick({ now: NOW });
    const started = await repository.startPass({ now: NOW, policyId: 1 });
    expect(started).toMatchObject({ passNumber: 1, passStartedAt: NOW, cursorVendorId: null, policyId: 1, lastTickAt: NOW });

    // First reading: two baselines in one statement.
    const first = await repository.withVendorSchedule(1, async (transaction) => {
      expect(await transaction.loadEntries([1, 2])).toEqual(new Map());
      const written = await transaction.writeReconciliation({
        vendorId: 1, observedAt: NOW, policyId: 1, recordedBy: "detection",
        variants: [
          { productVariantId: 1, evidence: planPercent, retailDriven: false, operations: [{ kind: "baseline", unitCostCents: 809, effectiveAt: NOW }] },
          { productVariantId: 2, evidence: { ...planPercent, source: "variant_fixed_price", overrideId: "o-1", retailPriceCents: null, discountBps: null },
            retailDriven: false, operations: [{ kind: "baseline", unitCostCents: 7_999, effectiveAt: NOW }] },
        ],
      });
      await transaction.advanceCursor({ vendorId: 1, counts: { variantsRead: 2, unavailableReadings: 0, changesRecorded: 2 }, now: NOW });
      return written;
    });
    expect(first.counts).toEqual({ ...emptyEventCounts(), baseline: 2 });
    expect([...first.entryIdsByVariant.keys()]).toEqual([1, 2]);
    expect(await repository.readDetectionState()).toMatchObject({ cursorVendorId: 1, passVendorsProcessed: 1, passVariantsRead: 2, passChangesRecorded: 2 });

    const entriesAfterFirst = await repository.withVendorSchedule(1, (transaction) => transaction.loadEntries([1, 2]));
    const baseline = entriesAfterFirst.get(1)![0]!;
    expect(baseline).toMatchObject({ kind: "baseline", fromCents: null, unitCostCents: 809, effectiveAt: NOW, observedAt: NOW, policyId: 1, evidence: planPercent, recordedBy: "detection" });
    expect(entriesAfterFirst.get(2)![0]).toMatchObject({ unitCostCents: 7_999, evidence: { source: "variant_fixed_price", overrideId: "o-1", retailPriceCents: null, discountBps: null } });

    // Second reading: an increase announced for two weeks out.
    const second = await repository.withVendorSchedule(1, (transaction) => transaction.writeReconciliation({
      vendorId: 1, observedAt: LATER, policyId: 1, recordedBy: "acceptance",
      variants: [{ productVariantId: 1, evidence: { ...planPercent, discountBps: 500 }, retailDriven: false, operations: [
        { kind: "add", direction: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS },
      ] }],
    }));
    expect(second.counts).toEqual({ ...emptyEventCounts(), increase_announced: 1 });
    const announced = (await repository.withVendorSchedule(1, (transaction) => transaction.loadEntries([1]))).get(1)!
      .find((entry) => entry.kind === "increase")!;
    expect(announced).toMatchObject({ fromCents: 809, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS, observedAt: LATER, recordedBy: "acceptance" });

    const pending = await repository.listPendingChanges({ now: LATER, limit: 10 });
    expect(pending).toEqual([{
      entryId: announced.entryId, vendorId: 1, vendorBusinessName: "Shellz Vendor", productVariantId: 1, variantSku: "ARM-ENV-SGL-P50",
      variantName: "Single pack", productName: "Armor Envelope", kind: "increase", fromCents: 809, unitCostCents: 999,
      effectiveAt: IN_TWO_WEEKS, observedAt: LATER, policyId: 1, costSource: "plan_percent", recordedBy: "acceptance",
    }]);
    // Once its date has passed it is no longer pending.
    expect(await repository.listPendingChanges({ now: IN_TWO_WEEKS, limit: 10 })).toEqual([]);

    // Third reading: the increase is lowered on its date; fourth: withdrawn.
    const third = await repository.withVendorSchedule(1, (transaction) => transaction.writeReconciliation({
      vendorId: 1, observedAt: LATER, policyId: 1, recordedBy: "detection",
      variants: [{ productVariantId: 1, evidence: planPercent, retailDriven: true, operations: [
        { kind: "reduce", entryId: announced.entryId, fromCents: 999, unitCostCents: 899, effectiveAt: IN_TWO_WEEKS },
      ] }],
    }));
    expect(third.counts).toEqual({ ...emptyEventCounts(), increase_reduced: 1 });
    expect((await repository.listPendingChanges({ now: LATER, limit: 10 }))[0]).toMatchObject({ unitCostCents: 899 });

    const fourth = await repository.withVendorSchedule(1, (transaction) => transaction.writeReconciliation({
      vendorId: 1, observedAt: LATER, policyId: 1, recordedBy: "detection",
      variants: [{ productVariantId: 1, evidence: planPercent, retailDriven: false, operations: [
        { kind: "withdraw", entryId: announced.entryId, unitCostCents: 899, effectiveAt: IN_TWO_WEEKS },
      ] }],
    }));
    expect(fourth.counts).toEqual({ ...emptyEventCounts(), change_withdrawn: 1 });
    expect(await repository.listPendingChanges({ now: LATER, limit: 10 })).toEqual([]);
    expect((await repository.withVendorSchedule(1, (transaction) => transaction.loadEntries([1]))).get(1)!.map((entry) => entry.kind)).toEqual(["baseline"]);

    // The log holds every operation, newest first, and pages by id.
    const page = await repository.listChangeLog({ limit: 3, beforeId: null });
    expect(page.map((row) => [row.eventType, row.fromCents, row.toCents, row.retailDriven, row.recordedBy])).toEqual([
      ["change_withdrawn", 899, null, false, "detection"],
      ["increase_reduced", 999, 899, true, "detection"],
      ["increase_announced", 809, 999, false, "acceptance"],
    ]);
    expect(page[0]).toMatchObject({ vendorBusinessName: "Shellz Vendor", variantSku: "ARM-ENV-SGL-P50", productName: "Armor Envelope", entryId: announced.entryId, policyId: 1 });
    const older = await repository.listChangeLog({ limit: 3, beforeId: page[2]!.logId });
    expect(older.map((row) => [row.eventType, row.productVariantId, row.toCents])).toEqual([["baseline", 2, 7_999], ["baseline", 1, 809]]);
    expect(older[0]).toMatchObject({ variantSku: null, variantName: "Case of 10", costSource: "variant_fixed_price" });

    const completed = await repository.completePass({ now: LATER });
    expect(completed).toMatchObject({ passNumber: 1, passCompletedAt: LATER, cursorVendorId: null, passVendorsProcessed: 1 });
  });

  it("refuses to move the cursor backwards and rolls the vendor's writes back with it", async () => {
    await repository.startPass({ now: LATER, policyId: 1 });
    await repository.withVendorSchedule(2, (transaction) =>
      transaction.advanceCursor({ vendorId: 2, counts: { variantsRead: 1, unavailableReadings: 1, changesRecorded: 0 }, now: LATER }));
    const before = await pool.query(qualify(`SELECT count(*)::int AS n FROM dropship.dropship_cost_schedule_entries WHERE vendor_id = 1`));
    await expect(repository.withVendorSchedule(1, async (transaction) => {
      await transaction.writeReconciliation({
        vendorId: 1, observedAt: LATER, policyId: 1, recordedBy: "detection",
        variants: [{ productVariantId: 2, evidence: planPercent, retailDriven: false, operations: [
          { kind: "add", direction: "decrease", fromCents: 7_999, unitCostCents: 6_999, effectiveAt: LATER },
        ] }],
      });
      await transaction.advanceCursor({ vendorId: 1, counts: { variantsRead: 2, unavailableReadings: 0, changesRecorded: 1 }, now: LATER });
    })).rejects.toMatchObject({ code: "DROPSHIP_COST_DETECTION_CURSOR_CONFLICT" });
    const after = await pool.query(qualify(`SELECT count(*)::int AS n FROM dropship.dropship_cost_schedule_entries WHERE vendor_id = 1`));
    expect(after.rows[0].n).toBe(before.rows[0].n);
    await repository.completePass({ now: LATER });
  });

  it("keeps the vendor's transaction alive when the cost source cannot be read", async () => {
    // The membership tables the cost reader needs do not exist here, so the
    // read fails inside its savepoint; the schedule transaction still commits.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const outcome = await repository.withVendorSchedule(2, async (transaction) => {
        const costs = await transaction.readLiveCosts([1]);
        const state = await transaction.listTrackedVariantIds();
        return { costs, state };
      });
      expect(outcome.costs.get(1)).toMatchObject({ status: "unavailable", issue: "source_read_failed" });
      expect(outcome.state).toEqual([1]);
    } finally {
      warn.mockRestore();
    }
  });

  it("lets the engine refuse every edit the design forbids", async () => {
    const entries = qualify("dropship.dropship_cost_schedule_entries");
    const log = qualify("dropship.dropship_cost_change_log");
    const { rows: [baseline] } = await pool.query(`SELECT id FROM ${entries} WHERE vendor_id = 1 AND product_variant_id = 1 AND kind = 'baseline'`);
    const { rows: [withdrawn] } = await pool.query(`SELECT id FROM ${entries} WHERE vendor_id = 1 AND withdrawn_at IS NOT NULL`);
    const refusals: Array<[string, unknown[], RegExp]> = [
      [`DELETE FROM ${entries} WHERE id = $1`, [baseline.id], /append-only/],
      [`UPDATE ${entries} SET effective_at = now() WHERE id = $1`, [baseline.id], /immutable/],
      [`UPDATE ${entries} SET unit_cost_cents = 700 WHERE id = $1`, [baseline.id], /only be withdrawn/],
      [`UPDATE ${entries} SET unit_cost_cents = 700 WHERE id = $1`, [withdrawn.id], /withdrawn entry cannot change/],
      [`UPDATE ${entries} SET withdrawn_at = NULL WHERE id = $1`, [withdrawn.id], /withdrawn entry cannot change/],
      [`UPDATE ${log} SET to_cents = 1 WHERE vendor_id = 1`, [], /append-only/],
      [`DELETE FROM ${log} WHERE vendor_id = 1`, [], /append-only/],
    ];
    for (const [sql, values, message] of refusals) {
      await expect(pool.query(sql, values), sql).rejects.toThrow(message);
    }
    // The CHECKs mirror the domain: an increase must rise, a decrease must fall, a baseline changes nothing.
    const insert = `INSERT INTO ${entries} (vendor_id, product_variant_id, kind, from_cents, unit_cost_cents, effective_at, observed_at, cost_source, plan_id, recorded_by)
      VALUES (1, 1, $1, $2, $3, now(), now(), 'retail', 'ops', 'detection')`;
    for (const [kind, from, unit] of [["increase", 900, 900], ["increase", 900, 800], ["decrease", 800, 900], ["baseline", 800, 900], ["increase", null, 900], ["decrease", null, 900]]) {
      await expect(pool.query(insert, [kind, from, unit]), `${kind} ${from} -> ${unit}`).rejects.toMatchObject({ code: "23514" });
    }
    const logInsert = `INSERT INTO ${log} (vendor_id, product_variant_id, entry_id, event_type, from_cents, to_cents, effective_at, retail_driven, observed_at, cost_source, plan_id, recorded_by)
      VALUES (1, 1, $1, $2, $3, $4, now(), false, now(), 'retail', 'ops', 'detection')`;
    for (const [event, from, to] of [["increase_announced", null, 900], ["increase_announced", 800, null], ["increase_announced", 900, 900], ["change_withdrawn", null, null], ["change_withdrawn", 900, 900], ["baseline", null, null], ["baseline", 800, 900]]) {
      await expect(pool.query(logInsert, [baseline.id, event, from, to]), `${event} ${from} -> ${to}`).rejects.toMatchObject({ code: "23514" });
    }
    await expect(repository.withVendorSchedule(1, (transaction) => transaction.writeReconciliation({
      vendorId: 1, observedAt: LATER, policyId: 1, recordedBy: "detection",
      variants: [{ productVariantId: 404, evidence: planPercent, retailDriven: false, operations: [{ kind: "baseline", unitCostCents: 809, effectiveAt: LATER }] }],
    }))).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_WRITE_INVALID", context: { sqlState: "23503" } });
  });

  it("walks undecided readings, records one decision per row exactly once, and serves the vendor's view", async () => {
    // Everything recorded above is still undecided: the earliest reading comes first.
    const groups = await notices.listUnnoticedGroups({ limit: 10 });
    expect(groups.map((group) => [group.vendorId, group.recordedBy, group.rowCount])).toEqual([[1, "detection", 2], [1, "acceptance", 1], [1, "detection", 2]]);
    const first = groups[0]!;
    const rows = await notices.loadGroupRows(first);
    expect(rows.map((row) => [row.eventType, row.productVariantId, row.variantSku, row.productName])).toEqual([
      ["baseline", 1, "ARM-ENV-SGL-P50", "Armor Envelope"],
      ["baseline", 2, null, "Armor Envelope"],
    ]);
    expect(await notices.listSentEntryIds(rows.map((row) => row.entryId))).toEqual(new Set());

    const announced = (await notices.loadGroupRows(groups[1]!))[0]!;
    expect(announced.eventType).toBe("increase_announced");
    const decidedAt = new Date("2026-09-28T18:00:00.000Z");
    const written = await notices.recordDecisions([
      ...rows.map((row) => ({
        logId: row.logId, vendorId: row.vendorId, productVariantId: row.productVariantId, entryId: row.entryId, eventType: row.eventType,
        decision: "skipped_baseline" as const, noticeKind: null, noticeEventType: null, idempotencyKey: null, policyId: 1, decidedAt,
      })),
      {
        logId: announced.logId, vendorId: 1, productVariantId: announced.productVariantId, entryId: announced.entryId, eventType: announced.eventType,
        decision: "sent" as const, noticeKind: "announced" as const, noticeEventType: "dropship_cost_change_announced",
        idempotencyKey: "dropship-cost-change:1:announced:acceptance:x", policyId: 1, decidedAt,
      },
    ]);
    expect(written).toBe(3);
    // A replay writes nothing new and does not fail.
    expect(await notices.recordDecisions([{
      logId: announced.logId, vendorId: 1, productVariantId: announced.productVariantId, entryId: announced.entryId, eventType: announced.eventType,
      decision: "skipped_channels_off", noticeKind: null, noticeEventType: null, idempotencyKey: null, policyId: 1, decidedAt,
    }])).toBe(0);
    expect(await notices.listSentEntryIds([announced.entryId, rows[0]!.entryId])).toEqual(new Set([announced.entryId]));
    expect((await notices.listUnnoticedGroups({ limit: 10 })).map((group) => [group.recordedBy, group.rowCount])).toEqual([["detection", 2]]);

    // The engine refuses a sent decision without its key, and any edit or delete.
    const table = qualify("dropship.dropship_cost_change_notices");
    await expect(pool.query(`INSERT INTO ${table} (log_id, vendor_id, product_variant_id, entry_id, event_type, decision, notice_kind, notice_event_type, idempotency_key, decided_at)
      VALUES ($1, 1, 1, $2, 'increase_announced', 'sent', 'announced', 'dropship_cost_change_announced', NULL, now())`, [rows[0]!.logId + 1000, announced.entryId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`UPDATE ${table} SET decision = 'sent' WHERE vendor_id = 1`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM ${table} WHERE vendor_id = 1`)).rejects.toThrow(/append-only/);

    // The vendor's view: nothing announced any more (withdrawn), and the recent log with each row's decision.
    expect(await notices.listVendorAnnouncedChanges({ vendorId: 1, now: LATER, limit: 10 })).toEqual([]);
    const recent = await notices.listVendorRecentChanges({ vendorId: 1, since: new Date("2026-09-01T00:00:00.000Z"), limit: 10 });
    expect(recent.map((row) => [row.eventType, row.noticeDecision])).toEqual([
      ["change_withdrawn", null],
      ["increase_reduced", null],
      ["increase_announced", "sent"],
    ]);
    expect(recent[2]).toMatchObject({ variantSku: "ARM-ENV-SGL-P50", productName: "Armor Envelope", fromCents: 809, toCents: 999 });
  });
  it("acts on an increase in force once: holds, actions and the entry row commit together, replay writes nothing, views and guards hold", async () => {
    // An increase that took effect an hour after it was read, now in force for vendor 1, variant 1.
    const READ_AT = new Date("2026-10-12T22:00:00.000Z");
    const IN_FORCE_AT = new Date("2026-10-12T23:00:00.000Z");
    const AFTER = new Date("2026-10-13T00:05:00.000Z");
    const written = await repository.withVendorSchedule(1, (transaction) => transaction.writeReconciliation({
      vendorId: 1, observedAt: READ_AT, policyId: 1, recordedBy: "detection",
      variants: [{ productVariantId: 1, evidence: planPercent, retailDriven: false, operations: [{ kind: "add", direction: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: IN_FORCE_AT }] }],
    }));
    const entryId = written.entryIdsByVariant.get(1)!;
    expect(entryId).toBeGreaterThan(0);

    const increases = await actions.listEffectiveIncreasesWithoutAction({ now: AFTER, limit: 10 });
    expect(increases).toEqual([{ entryId, vendorId: 1, productVariantId: 1, fromCents: 809, unitCostCents: 999, effectiveAt: IN_FORCE_AT, policyId: 1, inForceEntryId: entryId }]);
    expect(await actions.listEffectiveIncreasesWithoutAction({ now: READ_AT, limit: 10 })).toEqual([]);
    expect(await actions.costInForce({ vendorId: 1, productVariantIds: [1, 2, 3], now: AFTER })).toEqual(new Map([[1, 999], [2, 7_999]]));

    const facts = await actions.loadVendorFacts({ vendorId: 1, productVariantIds: [1] });
    expect(facts.listings.map((listing) => [listing.listingId, listing.storeConnectionId, listing.status, listing.vendorRetailPriceCents, listing.variantSku])).toEqual([
      [1, 1, "active", 899, "ARM-ENV-SGL-P50"], [3, 2, "queued", null, "ARM-ENV-SGL-P50"],
    ]);
    expect(facts.savedPrices).toEqual([{ storeConnectionId: 2, productVariantId: 1, overridePriceCents: null, pricingMode: "rules" }]);
    expect(facts.profiles.get(2)?.profile?.defaultRecipe.basis).toBe("product_cost");
    expect(facts.candidates.get(1)?.defaultRetailPriceCents).toBe(899);

    const decidedAt = AFTER;
    const record = {
      vendorId: 1,
      entries: [{ entryId, productVariantId: 1, listingCount: 2, actionCounts: { below_cost_paused: 1, skipped_inactive_listing: 1 }, supersededByEntryId: null, policyId: 1, decidedAt }],
      listingActions: [
        { entryId, storeConnectionId: 1, productVariantId: 1, listingId: 1, listingStatus: "active", priceSource: "saved_listing" as const, listingPriceCents: 899,
          unitCostCents: 999, action: "below_cost_paused" as const, detail: null, pushJobId: null, holdKey: { storeConnectionId: 1, productVariantId: 1 }, policyId: 1, decidedAt },
        { entryId, storeConnectionId: 2, productVariantId: 1, listingId: 3, listingStatus: "queued", priceSource: "rules_cost" as const, listingPriceCents: 1_399,
          unitCostCents: 999, action: "skipped_inactive_listing" as const, detail: null, pushJobId: null, holdKey: null, policyId: 1, decidedAt },
      ],
      holds: [{ storeConnectionId: 1, productVariantId: 1, listingId: 1, entryId, listingPriceCents: 899, unitCostCents: 999, holdIdempotencyKey: "dropship-cost-change-hold:1:a:b", heldAt: decidedAt }],
    };
    expect(await actions.recordEntryActions(record)).toEqual({ entriesRecorded: 1, listingActionsRecorded: 2, holdsRecorded: 1 });
    // A replayed pass finds the hold it placed and writes nothing new.
    expect(await actions.recordEntryActions(record)).toEqual({ entriesRecorded: 0, listingActionsRecorded: 0, holdsRecorded: 0 });
    expect(await actions.listEffectiveIncreasesWithoutAction({ now: AFTER, limit: 10 })).toEqual([]);

    const holds = await actions.listActiveHolds({ limit: 10 });
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ vendorId: 1, storeConnectionId: 1, productVariantId: 1, listingId: 1, entryId, listingPriceCents: 899, unitCostCents: 999, heldAt: decidedAt });

    const vendorRows = await actions.listVendorListingActions({ vendorId: 1, since: READ_AT, limit: 10 });
    expect(vendorRows.map((row) => [row.listingId, row.action, row.holdReleasedAt])).toEqual([[3, "skipped_inactive_listing", null], [1, "below_cost_paused", null]]);
    const staffRows = await actions.listListingActions({ limit: 1, beforeId: null });
    expect(staffRows).toHaveLength(1);
    expect(staffRows[0]).toMatchObject({ listingId: 3, vendorBusinessName: "Shellz Vendor", priceSource: "rules_cost", listingStatus: "queued", policyId: 1 });

    // Release once; a second release is a no-op, and the engine refuses any other edit or a delete.
    expect(await actions.releaseHolds({ holdIds: [holds[0]!.holdId], reason: "price_covers_cost", detail: "released", releasedAt: AFTER, releaseIdempotencyKey: "dropship-cost-change-release:1:x" })).toBe(1);
    expect(await actions.releaseHolds({ holdIds: [holds[0]!.holdId], reason: "price_covers_cost", detail: "released", releasedAt: AFTER, releaseIdempotencyKey: "dropship-cost-change-release:1:x" })).toBe(0);
    expect(await actions.listActiveHolds({ limit: 10 })).toEqual([]);
    expect((await actions.listVendorListingActions({ vendorId: 1, since: READ_AT, limit: 10 }))[1]).toMatchObject({ holdReleasedAt: AFTER, holdReleaseReason: "price_covers_cost" });
    const holdsTable = qualify("dropship.dropship_cost_change_listing_holds");
    await expect(pool.query(`UPDATE ${holdsTable} SET listing_price_cents = 1 WHERE id = $1`, [holds[0]!.holdId])).rejects.toThrow(/released hold cannot change/);
    await expect(pool.query(`DELETE FROM ${holdsTable} WHERE id = $1`, [holds[0]!.holdId])).rejects.toThrow(/cannot be deleted/);
    const actionsTable = qualify("dropship.dropship_cost_change_listing_actions");
    await expect(pool.query(`UPDATE ${actionsTable} SET action = 'reprice_queued'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`INSERT INTO ${actionsTable} (entry_id, vendor_id, store_connection_id, product_variant_id, listing_id, listing_status, price_source, unit_cost_cents, action, decided_at)
      VALUES ($1, 1, 1, 1, 2, 'active', 'rules_cost', 999, 'reprice_queued', now())`, [entryId])).rejects.toMatchObject({ code: "23514" });
    const entriesTable = qualify("dropship.dropship_cost_change_entry_actions");
    await expect(pool.query(`DELETE FROM ${entriesTable} WHERE entry_id = $1`, [entryId])).rejects.toThrow(/append-only/);
  });
});
