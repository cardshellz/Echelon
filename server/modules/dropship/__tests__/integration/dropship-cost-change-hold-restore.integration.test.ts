import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DROPSHIP_COST_CHANGE_POLICY } from "../../../../../shared/dropship/cost-change-policy";
import {
  COST_CHANGE_HOLD_ACTOR_ID,
  DropshipCostChangeListingActionService,
  type DropshipCostChangeHoldGate,
} from "../../application/dropship-cost-change-listing-action-service";
import type { DropshipNotificationSenderInput } from "../../application/dropship-ports";
import type { DropshipCostChangePolicySettings } from "../../../../../shared/dropship/cost-change-policy";
import { PgDropshipCostChangeListingActionRepository } from "../../infrastructure/dropship-cost-change-listing-action.repository";

/**
 * F4: before the live status fix a queued or failed push wrote a non-live
 * status over a listing that stayed live on eBay, and the hold review released
 * its below-cost pause as "listing no longer live". The pause is put back
 * (migration 0713's real holds table, triggers and CHECKs) and the same pass
 * re-judges it.
 */
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;

const OBSERVED = new Date("2026-09-30T00:00:00.000Z");
const PUSHED = new Date("2026-10-01T00:00:00.000Z");
const HELD = new Date("2026-10-02T00:00:00.000Z");
const QUEUED = new Date("2026-10-03T00:00:00.000Z");
const RELEASED = new Date("2026-10-04T00:00:00.000Z");
const FAILED = new Date("2026-10-05T00:00:00.000Z");
const NOW = new Date("2026-10-20T12:00:00.000Z");
const LATER = new Date("2026-10-20T12:30:00.000Z");
const WORKER = "worker-hold-restore";

describeDatabase.sequential("cost change pause restore after a demoted live listing (PostgreSQL, migration 0713)", () => {
  const schema = `dropship_cost_hold_restore_${process.pid}`;
  let pool: pg.Pool;
  let actions: PgDropshipCostChangeListingActionRepository;

  function qualify(sql: string): string {
    return sql.replace(/\b(dropship|catalog)\.([a-z_]+)/g, (_table, _namespace, name) => `"${schema}"."${name}"`);
  }

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
    // The owner tables migrations 0710-0713, 0738 and 0739 reference, with the columns this flow reads.
    await pool.query(qualify(`
      CREATE TABLE dropship.dropship_vendors (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, business_name varchar(200), status varchar(30) NOT NULL DEFAULT 'active');
      CREATE TABLE catalog.products (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, name text NOT NULL, category_id integer);
      CREATE TABLE catalog.product_categories (id integer PRIMARY KEY, name varchar(100) NOT NULL);
      CREATE TABLE catalog.product_variants (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, product_id integer NOT NULL REFERENCES catalog.products(id),
        sku varchar(100), name text NOT NULL);
      CREATE TABLE dropship.dropship_store_connections (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, vendor_id integer NOT NULL,
        UNIQUE (id, vendor_id));
      CREATE TABLE dropship.dropship_listing_push_jobs (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, vendor_id integer NOT NULL);
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
        status varchar(40) NOT NULL DEFAULT 'not_listed', vendor_retail_price_cents bigint, platform varchar(30) NOT NULL DEFAULT 'ebay',
        external_listing_id varchar(255));
      CREATE TABLE dropship.dropship_listing_push_job_items (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_id integer NOT NULL REFERENCES dropship.dropship_listing_push_jobs(id), listing_id integer REFERENCES dropship.dropship_vendor_listings(id),
        product_variant_id integer NOT NULL, status varchar(30) NOT NULL, result jsonb,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
      -- The completed push's sync event carries the price it published (dropship-listing-push-worker.repository completeItem).
      CREATE TABLE dropship.dropship_listing_sync_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        listing_id integer NOT NULL REFERENCES dropship.dropship_vendor_listings(id), event_type varchar(80) NOT NULL,
        source varchar(40) NOT NULL, payload jsonb, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE dropship.dropship_audit_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer, store_connection_id integer, entity_type varchar(80) NOT NULL, entity_id varchar(255),
        event_type varchar(120) NOT NULL, actor_type varchar(40) NOT NULL DEFAULT 'system', actor_id varchar(255),
        severity varchar(20) NOT NULL DEFAULT 'info', payload jsonb, created_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO dropship.dropship_vendors (business_name) VALUES ('Shellz Vendor');
      INSERT INTO dropship.dropship_store_connections (vendor_id) VALUES (1);
      INSERT INTO catalog.products (name) VALUES ('Armor Envelope');
      INSERT INTO catalog.product_variants (product_id, sku, name)
        SELECT 1, 'ARM-' || n, 'Size ' || n FROM generate_series(1, 7) AS n;
      INSERT INTO dropship.dropship_listing_push_jobs (vendor_id) VALUES (1);
    `));
    for (const file of ["0710_dropship_cost_change_policy.sql", "0711_dropship_cost_schedule.sql", "0712_dropship_cost_change_notices.sql",
      "0713_dropship_cost_change_listing_actions.sql", "0738_dropship_product_listing_settings.sql", "0739_dropship_category_listing_settings.sql"]) {
      await pool.query(qualify(readFileSync(resolve(process.cwd(), "migrations", file), "utf8")));
    }
    actions = new PgDropshipCostChangeListingActionRepository(qualifiedPool(), {
      listCatalogCandidates: async (ids) => ids.map((id) => ({ productVariantId: id, productId: 1, category: null, categoryId: null, productLineIds: [], defaultRetailPriceCents: 899 })),
      listPricingPolicies: async () => [],
    });
  });

  beforeEach(async () => {
    // Holds and entries are append-only by trigger; each test gets fresh rows by
    // truncating (TRUNCATE does not fire row triggers).
    await pool.query(qualify(`TRUNCATE dropship.dropship_audit_events, dropship.dropship_listing_sync_events, dropship.dropship_listing_push_job_items,
      dropship.dropship_listing_price_settings,
      dropship.dropship_cost_change_listing_actions, dropship.dropship_cost_change_listing_holds,
      dropship.dropship_cost_change_entry_actions, dropship.dropship_cost_schedule_entries,
      dropship.dropship_vendor_listings RESTART IDENTITY CASCADE`));
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool?.end();
  });

  interface Scenario {
    variantId: number;
    listingStatus?: string;
    completedMode?: "live" | "draft_first";
    /** A push item created after the completed push and before the release (the demotion). */
    demotedBeforeRelease?: boolean;
    releaseReason?: "listing_inactive" | "price_covers_cost";
    laterHold?: boolean;
  }

  /** One paused listing as production made it: completed push, pause, (queued update), release, (failed update). */
  async function seed(scenario: Scenario): Promise<{ listingId: number; holdId: number; entryId: number; demotingItemId: number | null; basisItemId: number }> {
    const listing = await pool.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_vendor_listings
      (vendor_id, store_connection_id, product_variant_id, status, vendor_retail_price_cents, platform, external_listing_id)
      VALUES (1, 1, $1, $2, 899, 'ebay', $3) RETURNING id`), [scenario.variantId, scenario.listingStatus ?? "active", `E-${scenario.variantId}`]);
    const listingId = listing.rows[0]!.id;
    const basis = await pool.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_listing_push_job_items
      (job_id, listing_id, product_variant_id, status, result, created_at, updated_at)
      VALUES (1, $1, $2, 'completed', $3::jsonb, $4, $4) RETURNING id`), [listingId, scenario.variantId,
      JSON.stringify({ listingIntent: { listingMode: scenario.completedMode ?? "live" }, push: { rawResult: { listingMode: scenario.completedMode ?? "live" } } }),
      PUSHED]);
    const entry = await pool.query<{ id: string }>(qualify(`INSERT INTO dropship.dropship_cost_schedule_entries
      (vendor_id, product_variant_id, kind, from_cents, unit_cost_cents, effective_at, observed_at, policy_id, cost_source, plan_id,
       retail_price_cents, discount_bps, recorded_by)
      VALUES (1, $1, 'increase', 809, 999, $2, $3, 1, 'plan_percent', 'ops', 899, 1000, 'detection') RETURNING id`),
      [scenario.variantId, HELD, OBSERVED]);
    const entryId = Number(entry.rows[0]!.id);
    await actions.recordEntryActions({
      vendorId: 1,
      entries: [{ entryId, productVariantId: scenario.variantId, listingCount: 1, actionCounts: { below_cost_paused: 1 }, supersededByEntryId: null, policyId: 1, decidedAt: HELD }],
      listingActions: [{ entryId, storeConnectionId: 1, productVariantId: scenario.variantId, listingId, listingStatus: "active", priceSource: "saved_listing",
        listingPriceCents: 899, unitCostCents: 999, action: "below_cost_paused", detail: null, pushJobId: null,
        holdKey: { storeConnectionId: 1, productVariantId: scenario.variantId }, policyId: 1, decidedAt: HELD }],
      holds: [{ storeConnectionId: 1, productVariantId: scenario.variantId, listingId, entryId, listingPriceCents: 899, unitCostCents: 999,
        holdIdempotencyKey: `dropship-cost-change-hold:1:${scenario.variantId}`, heldAt: HELD }],
    });
    const holdId = Number((await pool.query(qualify(`SELECT id FROM dropship.dropship_cost_change_listing_holds WHERE listing_id = $1`), [listingId])).rows[0]!.id);
    let demotingItemId: number | null = null;
    if (scenario.demotedBeforeRelease ?? true) {
      const demoting = await pool.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_listing_push_job_items
        (job_id, listing_id, product_variant_id, status, result, created_at, updated_at)
        VALUES (1, $1, $2, 'failed', '{"listingIntent":{"listingMode":"live"}}'::jsonb, $3, $4) RETURNING id`), [listingId, scenario.variantId, QUEUED, FAILED]);
      demotingItemId = demoting.rows[0]!.id;
    }
    await actions.releaseHolds({ holdIds: [holdId], reason: scenario.releaseReason ?? "listing_inactive", detail: "released", releasedAt: RELEASED,
      releaseIdempotencyKey: `dropship-cost-change-release:1:${holdId}` });
    if (scenario.laterHold) {
      await pool.query(qualify(`INSERT INTO dropship.dropship_cost_change_listing_holds
        (vendor_id, store_connection_id, product_variant_id, listing_id, entry_id, listing_price_cents, unit_cost_cents, hold_idempotency_key, held_at)
        VALUES (1, 1, $1, $2, $3, 899, 999, $4, $5)`), [scenario.variantId, listingId, entryId, `later-${scenario.variantId}`, FAILED]);
    }
    return { listingId, holdId, entryId, demotingItemId, basisItemId: basis.rows[0]!.id };
  }

  it("puts back only pauses released while a still-live listing read as not live, once, with an audit row each", async () => {
    const wrongful = await seed({ variantId: 1 });
    const draft = await seed({ variantId: 2, completedMode: "draft_first" });
    const releasedWhileActive = await seed({ variantId: 3, demotedBeforeRelease: false });
    const coveredCost = await seed({ variantId: 4, releaseReason: "price_covers_cost" });
    const stillDemoted = await seed({ variantId: 5, listingStatus: "failed" });
    const redecided = await seed({ variantId: 6, laterHold: true });

    const restored = await actions.restoreHoldsReleasedWhileListingDemoted({ now: NOW, workerId: WORKER, limit: 50 });

    expect(restored).toEqual([{
      holdId: expect.any(Number), releasedHoldId: wrongful.holdId, vendorId: 1, storeConnectionId: 1, productVariantId: 1,
      listingId: wrongful.listingId, entryId: wrongful.entryId, releasedAt: RELEASED,
      basisJobItemId: wrongful.basisItemId, demotingJobItemId: wrongful.demotingItemId,
    }]);
    const live = await actions.listActiveHolds({ limit: 10 });
    expect(live.map((hold) => [hold.holdId, hold.productVariantId, hold.listingId, hold.entryId, hold.listingPriceCents, hold.unitCostCents, hold.heldAt]))
      .toEqual([
        // The re-decided listing's later hold (placed before this pass), untouched.
        [expect.any(Number), 6, redecided.listingId, redecided.entryId, 899, 999, FAILED],
        [restored[0]!.holdId, 1, wrongful.listingId, wrongful.entryId, 899, 999, NOW],
      ]);
    const key = (await pool.query(qualify(`SELECT hold_idempotency_key FROM dropship.dropship_cost_change_listing_holds WHERE id = $1`), [restored[0]!.holdId])).rows[0];
    expect(key.hold_idempotency_key).toBe(`dropship-cost-change-hold:restore:${wrongful.holdId}`);
    const audit = (await pool.query(qualify(`SELECT entity_type, entity_id, event_type, actor_type, actor_id, severity, payload
      FROM dropship.dropship_audit_events ORDER BY id`))).rows;
    expect(audit).toEqual([{
      entity_type: "dropship_cost_change_listing_hold", entity_id: String(restored[0]!.holdId), event_type: "cost_change_hold_restored",
      actor_type: "job", actor_id: WORKER, severity: "warning",
      payload: expect.objectContaining({
        before: { liveHoldId: null, releasedHoldId: wrongful.holdId, releaseReason: "listing_inactive", releasedAt: RELEASED.toISOString() },
        after: { liveHoldId: restored[0]!.holdId }, basisJobItemId: wrongful.basisItemId, demotingJobItemId: wrongful.demotingItemId,
      }),
    }]);
    void draft; void releasedWhileActive; void coveredCost; void stillDemoted;

    // Re-run: the restored hold is newer than the released one, so nothing is restored again.
    expect(await actions.restoreHoldsReleasedWhileListingDemoted({ now: LATER, workerId: WORKER, limit: 50 })).toEqual([]);
    // Even after the review releases the restored hold again, the original release is never restored twice.
    await actions.releaseHolds({ holdIds: [restored[0]!.holdId], reason: "price_covers_cost", detail: "released", releasedAt: LATER,
      releaseIdempotencyKey: "dropship-cost-change-release:1:again" });
    expect(await actions.restoreHoldsReleasedWhileListingDemoted({ now: LATER, workerId: WORKER, limit: 50 })).toEqual([]);
  });

  it("restores a demoted listing's pause once the listing is live again", async () => {
    const stillDemoted = await seed({ variantId: 5, listingStatus: "failed" });
    expect(await actions.restoreHoldsReleasedWhileListingDemoted({ now: NOW, workerId: WORKER, limit: 50 })).toEqual([]);
    // The listing push sweep's live status repair restores it (dropship-listing-live-status-repair.repository).
    await pool.query(qualify(`UPDATE dropship.dropship_vendor_listings SET status = 'active' WHERE id = $1`), [stillDemoted.listingId]);
    const restored = await actions.restoreHoldsReleasedWhileListingDemoted({ now: LATER, workerId: WORKER, limit: 50 });
    expect(restored.map((hold) => hold.releasedHoldId)).toEqual([stillDemoted.holdId]);
  });

  it("re-judges a put-back pause in the same pass: still under water, it is held again at inventory planning", async () => {
    await seed({ variantId: 7 });
    const gateCalls: string[] = [];
    const gate: DropshipCostChangeHoldGate = {
      maxVariantsPerCommand: 50,
      holdVariants: async (input) => {
        gateCalls.push(`hold:${input.productVariantIds.join(",")}`);
        return { applied: true, targetCount: 1, publicationRows: input.productVariantIds.length, changedProductVariantIds: [...input.productVariantIds], blockedProductIds: [] };
      },
      releaseVariants: async (input) => {
        gateCalls.push(`release:${input.productVariantIds.join(",")}`);
        return { applied: true, targetCount: 1, publicationRows: input.productVariantIds.length, changedProductVariantIds: [...input.productVariantIds], blockedProductIds: [] };
      },
      // The wrongful release removed our hold at inventory planning.
      listHeldVariants: async () => new Map(),
    };
    const logs: string[] = [];
    const service = new DropshipCostChangeListingActionService({
      repository: actions,
      policy: { resolvePolicy: async () => ({ policyId: 1, settings: { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY } }) },
      reprice: { queueReprice: async () => { throw new Error("no reprice expected"); } },
      holdGate: gate,
      notificationSender: { send: async () => undefined },
      clock: { now: () => NOW },
      logger: { info: (event) => logs.push(event.code), warn: (event) => logs.push(event.code), error: (event) => logs.push(event.code) },
    });

    const result = await service.runListingActionPass({ workerId: WORKER });

    expect(result.holds).toMatchObject({ restored: 1, reviewed: 1, released: 0, reasserted: 1, deferred: 0, vendorsFailed: 0 });
    expect(gateCalls).toEqual(["hold:7"]);
    expect(logs).toContain("DROPSHIP_COST_CHANGE_HOLD_RESTORED");
    expect((await actions.listActiveHolds({ limit: 10 })).map((hold) => hold.productVariantId)).toEqual([7]);
  });

  /** A gate that remembers what it holds, as inventory planning does. */
  function trackingGate(initiallyHeld: readonly number[] = []) {
    const held = new Map<number, string>(initiallyHeld.map((id) => [id, COST_CHANGE_HOLD_ACTOR_ID]));
    const calls: string[] = [];
    const applied = (ids: readonly number[]) => ({ applied: true as const, targetCount: 1, publicationRows: ids.length,
      changedProductVariantIds: [...ids], blockedProductIds: [] });
    const gate: DropshipCostChangeHoldGate = {
      maxVariantsPerCommand: 50,
      holdVariants: async (input) => {
        calls.push(`hold:${input.productVariantIds.join(",")}`);
        for (const id of input.productVariantIds) held.set(id, COST_CHANGE_HOLD_ACTOR_ID);
        return applied(input.productVariantIds);
      },
      releaseVariants: async (input) => {
        calls.push(`release:${input.productVariantIds.join(",")}`);
        for (const id of input.productVariantIds) held.delete(id);
        return applied(input.productVariantIds);
      },
      listHeldVariants: async (input) => new Map([...held].filter(([id]) => input.productVariantIds.includes(id)).map(([id, heldBy]) => [id, { heldBy }])),
    };
    return { gate, calls };
  }

  function buildService(input: { gate: DropshipCostChangeHoldGate; settings?: Partial<DropshipCostChangePolicySettings> }) {
    const sent: DropshipNotificationSenderInput[] = [];
    const reprices: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    const service = new DropshipCostChangeListingActionService({
      repository: actions,
      policy: { resolvePolicy: async () => ({ policyId: 1, settings: { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY, ...input.settings } }) },
      reprice: { queueReprice: async (request) => { reprices.push({ ...request }); return { queued: true, jobId: 1, jobStatus: "queued", idempotentReplay: false, items: [] }; } },
      holdGate: input.gate,
      notificationSender: { send: async (notice) => { sent.push(notice); } },
      clock: { now: () => NOW },
      logger: { info: (event) => logs.push(event.code), warn: (event) => logs.push(event.code), error: (event) => logs.push(event.code) },
    });
    return { service, sent, reprices, logs };
  }

  /** A listing live on eBay: its last completed push published `publishedPriceCents` (null: the push recorded no price). */
  async function seedLiveListing(input: { variantId: number; status?: string; priceCents?: number; publishedPriceCents?: number | null }): Promise<number> {
    const listing = await pool.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_vendor_listings
      (vendor_id, store_connection_id, product_variant_id, status, vendor_retail_price_cents, platform, external_listing_id)
      VALUES (1, 1, $1, $2, $3, 'ebay', $4) RETURNING id`), [input.variantId, input.status ?? "active", input.priceCents ?? 899, `E-${input.variantId}`]);
    const listingId = listing.rows[0]!.id;
    await pool.query(qualify(`INSERT INTO dropship.dropship_listing_push_job_items
      (job_id, listing_id, product_variant_id, status, result, created_at, updated_at)
      VALUES (1, $1, $2, 'completed', '{"listingIntent":{"listingMode":"live"},"push":{"rawResult":{"listingMode":"live"}}}'::jsonb, $3, $3)`),
      [listingId, input.variantId, PUSHED]);
    if (input.publishedPriceCents !== null) {
      await pool.query(qualify(`INSERT INTO dropship.dropship_listing_sync_events (listing_id, event_type, source, payload, created_at)
        VALUES ($1, 'listing_push_completed', 'dropship_worker', $2::jsonb, $3)`),
        [listingId, JSON.stringify({ jobId: 1, priceCents: input.publishedPriceCents ?? input.priceCents ?? 899 }), PUSHED]);
    }
    return listingId;
  }

  async function seedIncrease(variantId: number): Promise<number> {
    const entry = await pool.query<{ id: string }>(qualify(`INSERT INTO dropship.dropship_cost_schedule_entries
      (vendor_id, product_variant_id, kind, from_cents, unit_cost_cents, effective_at, observed_at, policy_id, cost_source, plan_id,
       retail_price_cents, discount_bps, recorded_by)
      VALUES (1, $1, 'increase', 809, 999, $2, $3, 1, 'plan_percent', 'ops', 899, 1000, 'detection') RETURNING id`), [variantId, HELD, OBSERVED]);
    return Number(entry.rows[0]!.id);
  }

  it("shows a put-back pause as paused on the vendor's and ops' pages while the review keeps it, and tells the vendor once", async () => {
    const seeded = await seed({ variantId: 7 });
    const { gate } = trackingGate();
    const { service, sent } = buildService({ gate });

    await service.runListingActionPass({ workerId: WORKER });

    const live = await actions.listActiveHolds({ limit: 10 });
    expect(live.map((hold) => hold.listingId)).toEqual([seeded.listingId]);
    const vendorView = await actions.listVendorListingActions({ vendorId: 1, since: OBSERVED, limit: 10 });
    expect(vendorView.map((row) => [row.listingId, row.action, row.holdReleasedAt, row.holdReleaseReason]))
      .toEqual([[seeded.listingId, "below_cost_paused", null, null]]);
    const opsView = await actions.listListingActions({ limit: 10, beforeId: null });
    expect(opsView.map((row) => [row.listingId, row.action, row.holdReleasedAt, row.holdReleaseReason]))
      .toEqual([[seeded.listingId, "below_cost_paused", null, null]]);
    const paused = sent.filter((notice) => notice.eventType === "dropship_cost_change_listings_paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]!.payload).toMatchObject({ holdIds: [live[0]!.holdId] });

    // The next pass keeps the hold and tells the vendor nothing more.
    await service.runListingActionPass({ workerId: WORKER });
    expect(sent.filter((notice) => notice.eventType === "dropship_cost_change_listings_paused")).toHaveLength(1);
  });

  it("keeps a pause while the price that covers the cost is saved but not yet on eBay, and releases it once a push publishes it", async () => {
    const listingId = await seedLiveListing({ variantId: 3, publishedPriceCents: 899 });
    const entryId = await seedIncrease(3);
    await actions.recordEntryActions({
      vendorId: 1,
      entries: [{ entryId, productVariantId: 3, listingCount: 1, actionCounts: { below_cost_paused: 1 }, supersededByEntryId: null, policyId: 1, decidedAt: HELD }],
      listingActions: [{ entryId, storeConnectionId: 1, productVariantId: 3, listingId, listingStatus: "active", priceSource: "saved_listing",
        listingPriceCents: 899, unitCostCents: 999, action: "below_cost_paused", detail: null, pushJobId: null,
        holdKey: { storeConnectionId: 1, productVariantId: 3 }, policyId: 1, decidedAt: HELD }],
      holds: [{ storeConnectionId: 1, productVariantId: 3, listingId, entryId, listingPriceCents: 899, unitCostCents: 999,
        holdIdempotencyKey: "dropship-cost-change-hold:1:3", heldAt: HELD }],
    });
    // The vendor saves $15 and queues it: the queue writes the new price on the row and keeps it active (part A); the push fails.
    await pool.query(qualify(`INSERT INTO dropship.dropship_listing_price_settings (vendor_id, store_connection_id, product_variant_id, override_price_cents, pricing_mode)
      VALUES (1, 1, 3, 1500, 'fixed')`));
    await pool.query(qualify(`UPDATE dropship.dropship_vendor_listings SET vendor_retail_price_cents = 1500 WHERE id = $1`), [listingId]);
    await pool.query(qualify(`INSERT INTO dropship.dropship_listing_push_job_items (job_id, listing_id, product_variant_id, status, result, created_at, updated_at)
      VALUES (1, $1, 3, 'failed', '{"listingIntent":{"listingMode":"live","priceCents":1500}}'::jsonb, $2, $3)`), [listingId, QUEUED, FAILED]);
    const { gate, calls } = trackingGate([3]);
    const { service } = buildService({ gate });

    const first = await service.runListingActionPass({ workerId: WORKER });

    // eBay still shows $8.99 against a $9.99 cost: the pause stays.
    expect(first.holds).toMatchObject({ reviewed: 1, released: 0 });
    expect(calls).toEqual([]);
    expect((await actions.listActiveHolds({ limit: 10 })).map((hold) => hold.listingId)).toEqual([listingId]);

    // A later push completes at $15.
    await pool.query(qualify(`INSERT INTO dropship.dropship_listing_sync_events (listing_id, event_type, source, payload, created_at)
      VALUES ($1, 'listing_push_completed', 'dropship_worker', '{"jobId":2,"priceCents":1500}'::jsonb, $2)`), [listingId, NOW]);
    const second = await service.runListingActionPass({ workerId: WORKER });
    expect(second.holds).toMatchObject({ reviewed: 1, released: 1 });
    expect(calls).toEqual(["release:3"]);
    expect(await actions.listActiveHolds({ limit: 10 })).toEqual([]);
  });

  it("re-judges an increase skipped while a still-live listing read as not live once it is active again: paused through the pause path, once", async () => {
    const rechecked = await seedLiveListing({ variantId: 4, publishedPriceCents: 899 });
    const draft = await seedLiveListing({ variantId: 5, status: "active", publishedPriceCents: 899 });
    const stillDemoted = await seedLiveListing({ variantId: 6, status: "failed", publishedPriceCents: 899 });
    const skipped = async (variantId: number, listingId: number, listingStatus: string) => {
      const entryId = await seedIncrease(variantId);
      await actions.recordEntryActions({
        vendorId: 1,
        entries: [{ entryId, productVariantId: variantId, listingCount: 1, actionCounts: { skipped_inactive_listing: 1 }, supersededByEntryId: null, policyId: 1, decidedAt: HELD }],
        listingActions: [{ entryId, storeConnectionId: 1, productVariantId: variantId, listingId, listingStatus, priceSource: "saved_listing",
          listingPriceCents: 899, unitCostCents: 999, action: "skipped_inactive_listing", detail: null, pushJobId: null, holdKey: null, policyId: 1, decidedAt: HELD }],
        holds: [],
      });
      return entryId;
    };
    // Skipped while an earlier queue or failed push had demoted it (the listing stayed live on eBay).
    const entryId = await skipped(4, rechecked, "failed");
    // Skipped while it was a draft: not the demotion, not re-judged.
    await skipped(5, draft, "paused");
    // Skipped while demoted and still demoted: re-judged only once it is live again.
    await skipped(6, stillDemoted, "queued");
    const { gate, calls } = trackingGate();
    const { service, sent } = buildService({ gate, settings: { belowCostFixedListings: "pause_listing" } });

    const result = await service.runListingActionPass({ workerId: WORKER });

    expect(result).toMatchObject({ rechecks: { rechecked: 1, holdsPlaced: 1, vendorsFailed: 0 } });
    expect(calls).toEqual(["hold:4"]);
    const live = await actions.listActiveHolds({ limit: 10 });
    expect(live.map((hold) => [hold.productVariantId, hold.listingId, hold.entryId, hold.listingPriceCents, hold.unitCostCents]))
      .toEqual([[4, rechecked, entryId, 899, 999]]);
    const audit = (await pool.query(qualify(`SELECT entity_type, event_type, severity, actor_id, payload FROM dropship.dropship_audit_events
      WHERE event_type = 'cost_change_listing_rechecked'`))).rows;
    expect(audit).toEqual([{
      entity_type: "dropship_cost_change_listing_action", event_type: "cost_change_listing_rechecked", severity: "warning", actor_id: WORKER,
      payload: expect.objectContaining({
        before: { action: "skipped_inactive_listing", listingStatus: "failed" },
        after: expect.objectContaining({ action: "below_cost_paused", listingStatus: "active", listingPriceCents: 899, unitCostCents: 999, holdId: live[0]!.holdId }),
        entryId, listingId: rechecked,
      }),
    }]);
    const view = await actions.listVendorListingActions({ vendorId: 1, since: OBSERVED, limit: 10 });
    expect(view.filter((row) => row.listingId === rechecked).map((row) => [row.action, row.listingPriceCents, row.holdReleasedAt]))
      .toEqual([["below_cost_paused", 899, null]]);
    expect(view.filter((row) => row.listingId !== rechecked).map((row) => row.action)).toEqual(["skipped_inactive_listing", "skipped_inactive_listing"]);
    expect(sent.filter((notice) => notice.eventType === "dropship_cost_change_listings_paused")).toHaveLength(1);

    // Once only: the next pass re-judges nothing again.
    const rerun = await service.runListingActionPass({ workerId: WORKER });
    expect(rerun).toMatchObject({ rechecks: { rechecked: 0, holdsPlaced: 0 } });
    expect((await pool.query(qualify(`SELECT count(*)::int AS n FROM dropship.dropship_audit_events WHERE event_type = 'cost_change_listing_rechecked'`))).rows[0].n).toBe(1);
  });

  it("restores a pause released after an older push failed later than the newest completed push (write order, not id order)", async () => {
    const listingId = (await pool.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_vendor_listings
      (vendor_id, store_connection_id, product_variant_id, status, vendor_retail_price_cents, platform, external_listing_id)
      VALUES (1, 1, 2, 'active', 899, 'ebay', 'E-2') RETURNING id`))).rows[0]!.id;
    // An older job's item, retried and failed after the newer push completed (an ops or catch-up retry of an old job).
    const older = (await pool.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_listing_push_job_items
      (job_id, listing_id, product_variant_id, status, result, created_at, updated_at)
      VALUES (1, $1, 2, 'blocked', '{"listingIntent":{"listingMode":"live"}}'::jsonb, $2, $3) RETURNING id`),
      [listingId, new Date("2026-09-29T00:00:00.000Z"), QUEUED])).rows[0]!.id;
    const basis = (await pool.query<{ id: number }>(qualify(`INSERT INTO dropship.dropship_listing_push_job_items
      (job_id, listing_id, product_variant_id, status, result, created_at, updated_at)
      VALUES (1, $1, 2, 'completed', '{"listingIntent":{"listingMode":"live"},"push":{"rawResult":{"listingMode":"live"}}}'::jsonb, $2, $2) RETURNING id`),
      [listingId, PUSHED])).rows[0]!.id;
    const entryId = await seedIncrease(2);
    await actions.recordEntryActions({
      vendorId: 1,
      entries: [{ entryId, productVariantId: 2, listingCount: 1, actionCounts: { below_cost_paused: 1 }, supersededByEntryId: null, policyId: 1, decidedAt: HELD }],
      listingActions: [{ entryId, storeConnectionId: 1, productVariantId: 2, listingId, listingStatus: "active", priceSource: "saved_listing",
        listingPriceCents: 899, unitCostCents: 999, action: "below_cost_paused", detail: null, pushJobId: null,
        holdKey: { storeConnectionId: 1, productVariantId: 2 }, policyId: 1, decidedAt: HELD }],
      holds: [{ storeConnectionId: 1, productVariantId: 2, listingId, entryId, listingPriceCents: 899, unitCostCents: 999,
        holdIdempotencyKey: "dropship-cost-change-hold:1:2", heldAt: HELD }],
    });
    const holdId = (await actions.listActiveHolds({ limit: 10 }))[0]!.holdId;
    await actions.releaseHolds({ holdIds: [holdId], reason: "listing_inactive", detail: "released", releasedAt: RELEASED,
      releaseIdempotencyKey: "dropship-cost-change-release:1:2" });
    expect(older).toBeLessThan(basis);

    const restored = await actions.restoreHoldsReleasedWhileListingDemoted({ now: NOW, workerId: WORKER, limit: 50 });

    expect(restored.map((hold) => [hold.releasedHoldId, hold.basisJobItemId, hold.demotingJobItemId])).toEqual([[holdId, basis, older]]);
  });
});
