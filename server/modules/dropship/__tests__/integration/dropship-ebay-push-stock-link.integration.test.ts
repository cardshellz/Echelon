import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://unused:unused@127.0.0.1:1/unused";
});

import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-composition-database.fixture";
import { installWalmartPublicationInventoryFixture } from "../../../inventory-planning/__tests__/fixtures/walmart-publication-inventory.fixture";
import { installCutoverAdmissionFixturePrerequisites } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-admission.fixture";
import {
  DROPSHIP_EBAY_STOCK as F, addSecondFulfillmentNode, countDropshipStockRows, createDropshipEbayTarget, installDropshipEbayStockFixture,
} from "../../../inventory-planning/__tests__/fixtures/dropship-ebay-stock.fixture";
import { quantityPublicationScopeLockKey, PostgresQuantityPublicationAdmission } from "../../../inventory-planning/infrastructure/quantity-publication-admission.repository";
import { PUBLICATION_TARGET_SCOPE_LOCK_SEED } from "../../../inventory-planning/infrastructure/inventory-publication-target-stop.repository";
import { PostgresInventoryPublicationOutboxRepository } from "../../../inventory-planning/infrastructure/inventory-publication-outbox.repository";
import { InventoryPublicationOutboxService } from "../../../inventory-planning/application/inventory-publication-outbox.service";
import { createDropshipEbayQuantityRequestAdmission, readDropshipEbayStockDestination } from "../../../inventory-planning/quantity-publication";
import { dropshipEbayStockCommandKey } from "../../../inventory-planning/quantity-publication";
import { EbayDropshipListingPushProvider } from "../../infrastructure/dropship-ebay-listing-push.provider";
import { createDropshipEbayStockReadinessGate, type DropshipStockLinkLogger } from "../../infrastructure/dropship-ebay-stock-readiness.gate";
import { PgDropshipListingPushWorkerRepository } from "../../infrastructure/dropship-listing-push-worker.repository";
import { PgDropshipListingPushOpsRepository, readAutomaticRequeuePendingItemIds } from "../../infrastructure/dropship-listing-push-ops.repository";
import { PgDropshipListingPushStatusRepository } from "../../infrastructure/dropship-listing-push-status.repository";
import { PgDropshipListingPushJobQueueRepository, runDropshipListingPushSweep } from "../../infrastructure/dropship-listing-push-job-runner";
import {
  EbayDropshipInventoryPublicationTransportAdapter,
  PgDropshipInventoryListingIdentityReader,
  PgDropshipInventoryPublicationDestinationReader,
} from "../../infrastructure/dropship-ebay-inventory-publication.adapter";
import { PostgresDropshipEbayPushPublicationReader } from "../../infrastructure/dropship-ebay-push-publication.reader";
import { EbayMarketplaceRegistrationObserver } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import { DropshipEbayRegistrationCredentialAdapter } from "../../infrastructure/dropship-ebay-registration-credential-adapter";
import { DropshipListingPushWorkerService } from "../../application/dropship-listing-push-worker-service";
import { DropshipListingPushRecoveryService } from "../../application/dropship-listing-push-recovery-service";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type { DropshipMarketplaceCredentialRepository, DropshipMarketplaceStoreCredentials } from "../../infrastructure/dropship-marketplace-credentials";
import * as destinationHealth from "../../../oms/dropship-stock-destination-health";
import { FakeEbayInventory } from "../fixtures/fake-ebay-inventory";
import { listingPushRunsMigrationSql } from "../fixtures/listing-push-runs.fixture";
import { ebaySyncBackListingColumnsSql } from "../fixtures/ebay-sync-back.fixture";
import { DropshipError } from "../../domain/errors";

// P3 (PLAN-F2-v2 section 9.3): a Dropship eBay push end to end over real
// PostgreSQL: the real worker and its repository, the real eBay push provider and
// shared connector, the real quantity admission, planner and member reader, the
// real stock link gate and inventory writer, and (E7-E9) the real outbox with the
// real Dropship adapter. Only eBay HTTP is a stateful fake. Stubbed, as the plan
// states: the credential repository (a verified provider_user_id credential far
// from expiry), the fulfillment-policy guard (compatible, origin warehouse 1), the
// managed-location provider (the configured location, pre-seeded: no location
// call), and the push-time intent refresh (the queued intent).
const runtime = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  if (!runtime.pool) throw new Error("Disposable database is not initialized.");
  const value = Reflect.get(runtime.pool, key);
  return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const NOW = new Date("2026-10-21T12:00:00.000Z");
const MERCHANT_LOCATION = "cardshellz-dropship-wh-1";
const MARKETPLACE_CONFIG = { marketplaceId: "EBAY_US", merchantLocationKey: MERCHANT_LOCATION,
  businessPolicies: { paymentPolicyId: "payment", returnPolicyId: "return", fulfillmentPolicyId: "fulfillment" } };
/** result.push.context of a failure the worker that links stock first recorded (review V2-1, STOCK_LINK_AWARE_FAILURE_FIELD). */
const RECORDED_AFTER_LINK = { push: { status: "failed", retryable: true, context: { recordedWithAutomaticStockLink: true } } };
const SCOPE_KEY = quantityPublicationScopeLockKey({ destinationKind: "dropship_store_connection", connectionId: F.storeConnectionId,
  providerKey: "ebay", providerScopeType: "account", externalScopeId: F.accountId, externalInventoryItemId: F.sku, productId: null, productVariantId: null });

/** The worker-owned Dropship columns and tables the reduced composition schema lacks (owner migrations 0086, 0094). */
const WORKER_SCHEMA_SQL = `
  ALTER TABLE dropship.dropship_vendors ADD COLUMN IF NOT EXISTS member_id text,
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active', ADD COLUMN IF NOT EXISTS entitlement_status text NOT NULL DEFAULT 'active';
  ALTER TABLE dropship.dropship_store_connections ADD COLUMN IF NOT EXISTS setup_status text NOT NULL DEFAULT 'ready',
    ADD COLUMN IF NOT EXISTS access_token_ref text, ADD COLUMN IF NOT EXISTS refresh_token_ref text;
  -- Some of these columns already exist (nullable) in the reduced schema: set the launch-ready values explicitly.
  UPDATE dropship.dropship_store_connections SET access_token_ref='access-'||id, refresh_token_ref='refresh-'||id, setup_status='ready';
  ALTER TABLE dropship.dropship_store_listing_configs ADD COLUMN IF NOT EXISTS price_mode text NOT NULL DEFAULT 'vendor_defined',
    ADD COLUMN IF NOT EXISTS marketplace_config jsonb, ADD COLUMN IF NOT EXISTS required_config_keys jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS required_product_fields jsonb NOT NULL DEFAULT '[]';
  ALTER TABLE dropship.dropship_vendor_listings ADD COLUMN IF NOT EXISTS last_preview_hash text,
    ADD COLUMN IF NOT EXISTS vendor_retail_price_cents bigint, ADD COLUMN IF NOT EXISTS pushed_quantity integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_pushed_at timestamptz, ADD COLUMN IF NOT EXISTS metadata jsonb,
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
  CREATE UNIQUE INDEX IF NOT EXISTS p3_listing_store_variant ON dropship.dropship_vendor_listings(store_connection_id, product_variant_id);
  ALTER TABLE dropship.dropship_listing_push_jobs ADD COLUMN IF NOT EXISTS requested_scope jsonb, ADD COLUMN IF NOT EXISTS requested_by text,
    ADD COLUMN IF NOT EXISTS idempotency_key text, ADD COLUMN IF NOT EXISTS request_hash text, ADD COLUMN IF NOT EXISTS error_message text,
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS completed_at timestamptz;
  ALTER TABLE dropship.dropship_listing_push_job_items ADD COLUMN IF NOT EXISTS preview_hash text,
    ADD COLUMN IF NOT EXISTS external_listing_id text, ADD COLUMN IF NOT EXISTS error_code text, ADD COLUMN IF NOT EXISTS error_message text,
    ADD COLUMN IF NOT EXISTS idempotency_key text, ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
  CREATE TABLE IF NOT EXISTS dropship.dropship_audit_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id integer, store_connection_id integer, entity_type varchar(80) NOT NULL, entity_id varchar(255),
    event_type varchar(120) NOT NULL, actor_type varchar(40) NOT NULL DEFAULT 'system', actor_id varchar(255),
    severity varchar(20) NOT NULL DEFAULT 'info', payload jsonb, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS dropship.dropship_listing_sync_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    listing_id integer NOT NULL, event_type varchar(80) NOT NULL, source varchar(40) NOT NULL, payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now());
  INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(102,20,'P6'),(103,20,'P7'),(104,20,'P8') ON CONFLICT DO NOTHING;`;

/**
 * What PR A's publish runs migration references, which the reduced schema lacks (rebase of PR A onto Fix PR 2a): the
 * push jobs' and items' primary keys (0086), 0657's store owner index and 0091's selection revisions. The migration
 * itself then runs as production applies it, so the merged worker, job runner and ops repository read the run tables
 * and job columns production has (as dropship-listing-live-status and the worker repository suite do).
 */
const PUBLISH_RUNS_PREREQUISITES_SQL = `
  ALTER TABLE dropship.dropship_listing_push_jobs ADD PRIMARY KEY (id);
  ALTER TABLE dropship.dropship_listing_push_job_items ADD PRIMARY KEY (id);
  CREATE UNIQUE INDEX IF NOT EXISTS p3_store_owner_idx ON dropship.dropship_store_connections (id, vendor_id);
  CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_selection_rule_set_revisions (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id integer NOT NULL);`;

function signal() {
  let release!: () => void;
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}

function credential(): DropshipMarketplaceStoreCredentials {
  return { vendorId: F.vendorId, storeConnectionId: F.storeConnectionId, platform: "ebay", status: "connected", shopDomain: null,
    externalAccountId: F.accountId, providerEnvironment: "production", externalAccountIdentityScheme: "provider_user_id",
    externalAccountVerifiedAt: new Date("2026-05-01T00:00:00.000Z"), externalDisplayName: "dropship-seller", config: {},
    accessToken: "ebay-token", accessTokenRef: "access-22", accessTokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    refreshToken: "refresh-token", refreshTokenRef: "refresh-22", refreshTokenExpiresAt: null };
}

const credentials: DropshipMarketplaceCredentialRepository = {
  loadForStoreConnection: async () => credential(),
  replaceTokens: async () => credential(),
  recordAuthFailure: async (input) => ({ vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, platform: input.platform,
    previousStatus: "connected", status: input.status, transitioned: false }),
} as DropshipMarketplaceCredentialRepository;

function intent(patch: { quantity?: number; listingMode?: "live" | "draft_first"; inventoryMode?: string; productVariantId?: number; sku?: string } = {}) {
  return { platform: "ebay", listingMode: patch.listingMode ?? "live", inventoryMode: patch.inventoryMode ?? "managed_quantity_sync",
    priceMode: "vendor_defined", productVariantId: patch.productVariantId ?? F.variantId, sku: patch.sku ?? F.sku, title: "Pack of 5",
    description: "Five sleeves.", category: "Supplies", marketplaceCategoryId: "183438", marketplaceCategoryName: "Card Sleeves",
    storeCategoryNames: [], brand: "Card Shellz", gtin: null, mpn: "P5", condition: "new", itemSpecifics: {},
    imageUrls: ["https://cdn.example.test/p5.jpg"], weightGrams: 100, priceCents: 999, quantity: patch.quantity ?? 999,
    marketplaceConfig: MARKETPLACE_CONFIG };
}

dbDescribe.sequential("Dropship eBay push with its automatic stock link, end to end (P3)", () => {
  let database: InventoryCutoverTestDatabase;
  const dialect = new PgDialect();

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    await installDropshipEbayStockFixture(database.pool);
    await database.pool.query(WORKER_SCHEMA_SQL);
    await database.pool.query(PUBLISH_RUNS_PREREQUISITES_SQL);
    await database.pool.query(listingPushRunsMigrationSql());
    // The eBay sync-back listing columns the push path reads and writes (plan v4 §5), from the real migration; its
    // previous item numbers table references the listings' primary key (0086), which the reduced schema lacks.
    await database.pool.query("ALTER TABLE dropship.dropship_vendor_listings ADD PRIMARY KEY (id)");
    await database.pool.query(ebaySyncBackListingColumnsSql());
  }, 90_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; });

  /** One vendor listing and a queued (or already failed) push item for it. */
  async function queuePush(input: { jobId: number; itemId: number; listingId?: number; productVariantId?: number; sku?: string;
    quantity?: number; listingMode?: "live" | "draft_first"; inventoryMode?: string; status?: "queued" | "failed";
    errorCode?: string; result?: Record<string, unknown>; updatedAt?: Date; vendorId?: number; storeConnectionId?: number }) {
    const listingId = input.listingId ?? 1;
    const productVariantId = input.productVariantId ?? F.variantId;
    const vendorId = input.vendorId ?? F.vendorId;
    const storeConnectionId = input.storeConnectionId ?? F.storeConnectionId;
    const status = input.status ?? "queued";
    await database.pool.query(`INSERT INTO dropship.dropship_vendor_listings(id,vendor_id,store_connection_id,product_variant_id,platform,status,
        last_preview_hash,updated_at) VALUES($1,$2,$3,$4,'ebay',$5,$6,$7) ON CONFLICT DO NOTHING`,
    [listingId, vendorId, storeConnectionId, productVariantId, status === "failed" ? "failed" : "queued", `preview-${listingId}`, input.updatedAt ?? NOW]);
    await database.pool.query(`INSERT INTO dropship.dropship_listing_push_jobs(id,vendor_id,store_connection_id,job_type,status,requested_by,
        created_at,updated_at) SELECT $1,$2,$3,'push',$4,'member-7',$5,$5 WHERE NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_jobs WHERE id=$1)`,
    [input.jobId, vendorId, storeConnectionId, status, input.updatedAt ?? NOW]);
    await database.pool.query(`INSERT INTO dropship.dropship_listing_push_job_items(id,job_id,listing_id,product_variant_id,action,status,result,
        preview_hash,error_code,error_message,created_at,updated_at) VALUES($1,$2,$3,$4,'push',$5,$6::jsonb,$7,$8,$9,$10,$10)`,
    [input.itemId, input.jobId, listingId, productVariantId, status, JSON.stringify({ listingIntent: intent({ quantity: input.quantity,
      listingMode: input.listingMode, inventoryMode: input.inventoryMode, productVariantId, sku: input.sku }), ...input.result }),
    `preview-${listingId}`, input.errorCode ?? null, input.errorCode ? `Failed with ${input.errorCode}.` : null, input.updatedAt ?? NOW]);
  }

  function harness(options: { pool?: Pool; gateSleep?: (ms: number) => Promise<void>; providerSleep?: (ms: number) => Promise<void> } = {}) {
    const fake = new FakeEbayInventory();
    const logs: Array<DropshipLogEvent & { level: string }> = [];
    const record = (level: string) => (event: DropshipLogEvent) => { logs.push({ level, ...event }); };
    const stockLogger: DropshipStockLinkLogger = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
    const gateSleeps: number[] = [];
    const providerSleeps: number[] = [];
    const gate = createDropshipEbayStockReadinessGate({ pool: options.pool ?? database.pool, clock: { now: () => NOW },
      sleep: async ms => { gateSleeps.push(ms); await options.gateSleep?.(ms); }, logger: stockLogger });
    const preflight = { compatible: true, fulfillmentPolicyId: "fulfillment", capabilityEvidenceHash: "capability", originWarehouseId: 1, issues: [] };
    const location = { merchantLocationKey: MERCHANT_LOCATION, name: "Card Shellz Dropship", originWarehouseId: 1, action: "unchanged" as const };
    // The shared identity observer over the same fake eBay (a re-push of a published SKU proves its identity with it).
    const observer = new EbayMarketplaceRegistrationObserver(new DropshipEbayRegistrationCredentialAdapter({
      loadStoreConnection: async () => ({ id: F.storeConnectionId, vendorId: F.vendorId, platform: "ebay", status: "connected", marketplaceIds: ["EBAY_US"] }),
    }, { loadFreshForStoreConnection: async () => credential() }), {
      get: async input => {
        if (input.path.includes("/identity/")) return { status: 200, body: { userId: F.accountId, username: "dropship-seller" } };
        const response = await fake.fetch(`https://api.ebay.com${input.path}`, { method: "GET" });
        return { status: response.status, body: await response.json() };
      },
    });
    const provider = new EbayDropshipListingPushProvider(credentials, fake.fetch, { now: () => NOW },
      { evaluateForStoreConnection: async () => preflight, evaluateWithAccessToken: async () => preflight },
      { ensureForStoreConnection: async () => location, ensureWithAccessToken: async () => location },
      createDropshipEbayQuantityRequestAdmission, new PostgresDropshipEbayPushPublicationReader(database.pool, observer),
      { stockReadiness: gate, sleep: async ms => { providerSleeps.push(ms); await options.providerSleep?.(ms); },
        logger: { debug: () => {}, warn: () => {} } });
    const worker = new DropshipListingPushWorkerService({ repository: new PgDropshipListingPushWorkerRepository(database.pool),
      marketplacePush: provider, clock: { now: () => NOW }, logger: { info: record("info"), warn: record("warn"), error: record("error") } });
    const process = (jobId: number) => worker.processJob({ jobId, workerId: "worker-p3", idempotencyKey: `p3-job-${jobId}-${Date.now()}` });
    return { fake, logs, gateSleeps, providerSleeps, worker, process, gate };
  }

  /** The real outbox with the real Dropship eBay adapter over the same fake eBay. */
  function outboxWorker(fake: FakeEbayInventory, clock: { now: () => Date }) {
    const adapter = new EbayDropshipInventoryPublicationTransportAdapter(new PgDropshipInventoryPublicationDestinationReader(database.pool),
      { loadFreshForStoreConnection: async () => credential() }, { recordAuthFailure: credentials.recordAuthFailure },
      fake.fetch, clock, new PgDropshipInventoryListingIdentityReader(database.pool));
    return new InventoryPublicationOutboxService(new PostgresInventoryPublicationOutboxRepository(database.pool), { get: () => adapter },
      clock, () => `p3-lease-${Date.now()}-${Math.random()}`, new PostgresQuantityPublicationAdmission(database.pool, () => clock.now()));
  }
  const nextDue = async (targetId: number) => new Date((await database.pool.query<{ due: Date }>(`SELECT max(available_at)+interval '1 millisecond' AS due
    FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1`, [targetId])).rows[0]!.due);

  const item = async (itemId: number) => (await database.pool.query(`SELECT status,error_code,error_message,result,updated_at
    FROM dropship.dropship_listing_push_job_items WHERE id=$1`, [itemId])).rows[0];
  const listing = async (listingId = 1) => (await database.pool.query(`SELECT status,external_listing_id,external_offer_id
    FROM dropship.dropship_vendor_listings WHERE id=$1`, [listingId])).rows[0];
  const counts = (targetId: number | null) => countDropshipStockRows(database.pool, targetId);
  const epoch = async () => (await database.pool.query<{ epoch: string }>("SELECT epoch::text FROM inventory.cutover_admission_fence")).rows[0]!.epoch;
  const outboxRows = async (targetId: number) => (await database.pool.query(`SELECT desired_quantity::int,state,last_error_class
    FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1 ORDER BY desired_revision`, [targetId])).rows;
  const auditEvents = async (eventType: string) => (await database.pool.query(`SELECT entity_type,entity_id,actor_type,actor_id,severity,payload
    FROM dropship.dropship_audit_events WHERE event_type=$1 ORDER BY id`, [eventType])).rows;
  // The ops-health window is relative to the test's own clock, not the database's (it would expire 14 days after NOW).
  const healthWindow = sql`${NOW.toISOString()}::timestamptz - INTERVAL '14 days'`;
  const runHealth = async <T extends Record<string, unknown>>(statement: ReturnType<typeof sql>) => {
    const query = dialect.sqlToQuery(statement);
    return (await database.pool.query<T>(query.sql, query.params as unknown[])).rows;
  };
  const missingDestinationCount = async () =>
    (await runHealth<{ count: number }>(destinationHealth.dropshipStockDestinationMissingCountSql(healthWindow)))[0]!.count;
  const unverifiedOfferCount = async () =>
    (await runHealth<{ count: number }>(destinationHealth.dropshipEbayStockOfferUnverifiedCountSql()))[0]!.count;
  async function holdScope(): Promise<{ release: () => Promise<void> }> {
    const holder = await database.pool.connect();
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1,$2))", [SCOPE_KEY, PUBLICATION_TARGET_SCOPE_LOCK_SEED]);
    let released = false;
    return { release: async () => {
      if (released) return;
      released = true;
      await holder.query("SELECT pg_advisory_unlock_all()");
      holder.release();
    } };
  }

  it("E1: links a new SKU before its first eBay write and lists it at the canonical quantity", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await queuePush({ jobId: 1, itemId: 1 });
    const h = harness();

    const result = await h.process(1);

    expect(result.items[0]).toMatchObject({ status: "completed", errorCode: null });
    expect(await listing()).toEqual({ status: "active", external_listing_id: "fake-listing-1", external_offer_id: "fake-offer-1" });
    expect(h.fake.calls.map(call => `${call.method} ${call.path.split("?")[0]}`)).toEqual([
      "GET /sell/inventory/v1/offer",
      "PUT /sell/inventory/v1/inventory_item/P5",
      "POST /sell/inventory/v1/offer",
      "PUT /sell/inventory/v1/offer/fake-offer-1",
      "GET /sell/inventory/v1/offer/fake-offer-1",
      "GET /sell/inventory/v1/inventory_item/P5",
      "GET /sell/inventory/v1/offer",
      "POST /sell/inventory/v1/bulk_update_price_quantity",
      "POST /sell/inventory/v1/offer/fake-offer-1/publish",
    ]);
    // Canonical 17, never the intent's 999, on every quantity-bearing write.
    const [, putItem, postOffer, putOffer, , , , bulk] = h.fake.calls;
    expect((putItem!.body as { availability: { shipToLocationAvailability: { quantity: number } } }).availability.shipToLocationAvailability.quantity).toBe(17);
    expect((postOffer!.body as { availableQuantity: number }).availableQuantity).toBe(17);
    expect((putOffer!.body as { availableQuantity: number }).availableQuantity).toBe(17);
    expect(bulk!.body).toEqual({ requests: [{ sku: F.sku, shipToLocationAvailability: { quantity: 17 }, offers: [{ offerId: "fake-offer-1", availableQuantity: 17 }] }] });
    expect(h.fake.offers.get("fake-offer-1")).toMatchObject({ status: "PUBLISHED", availableQuantity: 17 });
    expect(await counts(targetId)).toMatchObject({ mappings: 1, drafts: 0, preparations: 1 });
    expect((await database.pool.query(`SELECT external_inventory_item_id,external_sku FROM inventory.publication_variant_mapping_versions
      WHERE publication_target_id=$1 AND lifecycle_status='sealed'`, [targetId])).rows).toEqual([{ external_inventory_item_id: F.sku, external_sku: F.sku }]);
    const linked = h.logs.find(log => log.code === "DROPSHIP_STOCK_LINK_ENSURE" && log.context?.outcome === "linked");
    expect(linked).toMatchObject({ level: "info", context: { job_id: 1, job_item_id: 1, listing_id: 1, product_id: F.productId,
      publication_target_id: targetId, command_key: dropshipEbayStockCommandKey(F.storeConnectionId, { kind: "listing_push", jobId: 1, jobItemId: 1, listingId: 1 }),
      fence_hold_ms: expect.any(Number) } });
    expect((await database.pool.query(`SELECT context->'requestedBy' AS requested_by FROM public.audit_events
      WHERE action='inventory_availability.dropship_ebay_stock.linked'`)).rows).toEqual([{ requested_by: "member-7" }]);
    expect(await missingDestinationCount()).toBe(0);
  });

  it("E2: serves a fresh job item for the live listing from the fast path and completes it", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await queuePush({ jobId: 1, itemId: 1 });
    const h = harness();
    await h.process(1);
    const before = await counts(targetId), epochBefore = await epoch();
    await queuePush({ jobId: 2, itemId: 2, quantity: 3 });

    const second = await h.process(2);

    expect(second.items[0]).toMatchObject({ status: "completed", errorCode: null, errorMessage: null });
    expect(await counts(targetId)).toEqual(before);
    expect(await epoch()).toBe(epochBefore);
    expect(h.logs.filter(log => log.context?.outcome === "already_linked")).toHaveLength(1);
    expect(h.fake.offersForSku(F.sku)).toHaveLength(1);
  });

  it("replays the same item after a post-link eBay failure: same command, no second link, then it lists", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await queuePush({ jobId: 1, itemId: 1 });
    const h = harness();
    // The worker dies right after the link committed, before any eBay write
    // (simulated: the hook throws once after the real link returns).
    const ensureLinked = h.gate.ensureLinked.bind(h.gate);
    let crash = true;
    h.gate.ensureLinked = async input => {
      await ensureLinked(input);
      if (crash) { crash = false; throw new DropshipError("P3_SIMULATED_WORKER_CRASH", "Worker stopped after the link.", { retryable: true }); }
    };
    const first = await h.process(1);
    expect(first.items[0]).toMatchObject({ status: "failed" });
    expect((await item(1)).result.push.retryable).toBe(true);
    expect(await counts(targetId)).toMatchObject({ mappings: 1, preparations: 1 });
    await database.pool.query(`UPDATE dropship.dropship_listing_push_job_items SET status='queued',error_code=NULL,error_message=NULL WHERE id=1;
      UPDATE dropship.dropship_listing_push_jobs SET status='queued' WHERE id=1`);

    const replay = await h.process(1);

    expect(replay.items[0]).toMatchObject({ status: "completed" });
    expect(await counts(targetId)).toMatchObject({ mappings: 1, preparations: 1 });
    expect(h.logs.filter(log => log.context?.outcome === "already_linked")).toHaveLength(1);
    // Same job item, so the same command: the fast path proved the link it made the first time.
    const keys = h.logs.filter(log => log.code === "DROPSHIP_STOCK_LINK_ENSURE").map(log => log.context?.command_key);
    expect(new Set(keys)).toEqual(new Set([dropshipEbayStockCommandKey(F.storeConnectionId, { kind: "listing_push", jobId: 1, jobItemId: 1, listingId: 1 })]));
    expect(h.fake.inventoryOrOfferMutations().length).toBeGreaterThan(0);
  });

  it("E3: refuses a zero-quantity push with no live destination before any inventory-item or offer write", async () => {
    await queuePush({ jobId: 1, itemId: 1, quantity: 0 });
    const h = harness();

    const result = await h.process(1);

    expect(result.items[0]).toMatchObject({ status: "failed", errorCode: "DROPSHIP_STOCK_DESTINATION_NOT_READY",
      errorMessage: "Card Shellz hasn't turned on stock updates for your eBay store yet." });
    expect((await item(1)).result.push).toMatchObject({ retryable: false, context: { inventoryCode: "STOCK_LISTING_TARGET_MISMATCH",
      operatorAction: true, targetCount: 0, classification: "permanent", requiresReview: true } });
    expect(h.fake.inventoryOrOfferMutations()).toEqual([]);
    expect(h.fake.calls.map(call => call.method)).toEqual(["GET"]);
    expect(await counts(null)).toMatchObject({ mappings: 0, outbox: 0, preparations: 0 });
    expect(h.logs.find(log => log.code === "DROPSHIP_LISTING_PUSH_ITEM_NEEDS_OPERATOR")).toMatchObject({ level: "error",
      context: { errorCode: "DROPSHIP_STOCK_DESTINATION_NOT_READY", inventoryCode: "STOCK_LISTING_TARGET_MISMATCH" } });
    expect(h.logs.find(log => log.context?.outcome === "refused")).toMatchObject({ level: "error" });
    // The store is managed live with push demand and no live destination: the critical ops issue counts it.
    expect(await missingDestinationCount()).toBe(1);
  });

  // Review MC-1 / CF-3: the ops-health issues use the stock link's own destination status, so a store whose one live
  // destination cannot publish (no sealed supply binding, an inactive policy channel) is reported too, and a hold is a warning.
  it.each([
    ["no destination", "missing", 1, 0, async () => {}],
    ["a disabled destination", "not_live", 1, 0, async () => { await createDropshipEbayTarget(database.pool, { state: "disabled" }); }],
    ["two live destinations", "duplicated", 1, 0, async () => {
      await createDropshipEbayTarget(database.pool);
      await createDropshipEbayTarget(database.pool, { fulfillmentNodeId: await addSecondFulfillmentNode(database.pool) });
    }],
    ["a live destination with an unsealed supply binding", "source_not_ready", 1, 0,
      async () => { await createDropshipEbayTarget(database.pool, { binding: "draft" }); }],
    ["a live destination whose policy channel is inactive", "source_not_ready", 1, 0, async () => {
      await createDropshipEbayTarget(database.pool);
      await database.pool.query("UPDATE channels.channels SET status='inactive' WHERE id=$1", [F.policyChannelId]);
    }],
    ["a held live destination", "held", 0, 1, async () => {
      const id = await createDropshipEbayTarget(database.pool);
      await database.pool.query(`UPDATE inventory.inventory_publication_targets SET held_at=transaction_timestamp(),hold_reason='Count review',
        held_by='operator',revision=revision+1 WHERE id=$1`, [id]);
    }],
    ["one ready live destination", "live", 0, 0, async () => { await createDropshipEbayTarget(database.pool); }],
  ] as const)("ops-health reports a managed store with %s as the stock link sees it (%s)", async (_name, status, critical, warning, setup) => {
    await setup();
    await queuePush({ jobId: 1, itemId: 1 });

    expect(await missingDestinationCount()).toBe(critical);
    expect((await readDropshipEbayStockDestination(database.pool, { storeConnectionId: F.storeConnectionId, accountId: F.accountId })).status)
      .toBe(status);
    expect((await runHealth<{ count: number }>(destinationHealth.dropshipStockDestinationHeldCountSql(healthWindow)))[0]!.count).toBe(warning);
    const sample = [...await runHealth(destinationHealth.dropshipStockDestinationMissingSampleSql(healthWindow, 10)),
      ...await runHealth(destinationHealth.dropshipStockDestinationHeldSampleSql(healthWindow, 10))];
    expect(sample).toEqual(status === "live" ? [] : [expect.objectContaining({ store_connection_id: F.storeConnectionId, vendor_id: F.vendorId,
      destination_status: status })]);
  });

  it("counts a store whose only demand is a failure waiting for its one-time re-send, until that re-send is spent", async () => {
    await queuePush({ jobId: 1, itemId: 1, status: "failed", errorCode: "PUBLICATION_LISTING_TARGET_UNMAPPED",
      updatedAt: new Date("2026-08-01T00:00:00.000Z") });
    await database.pool.query("UPDATE dropship.dropship_listing_push_job_items SET created_at='2026-08-01T00:00:00Z'");
    expect(await missingDestinationCount()).toBe(1);
    await database.pool.query(`UPDATE dropship.dropship_listing_push_job_items
      SET result = result || '{"automaticRequeue":{"count":1,"state":"exhausted"}}'::jsonb`);
    expect(await missingDestinationCount()).toBe(0);
  });

  it("E4: waits out a busy exact SKU scope with the bounded in-process retry, then links and lists", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await queuePush({ jobId: 1, itemId: 1 });
    const scope = await holdScope();
    const h = harness({ gateSleep: async () => { await scope.release(); } });
    try {
      const result = await h.process(1);
      expect(result.items[0]).toMatchObject({ status: "completed" });
    } finally { await scope.release(); }
    expect(h.gateSleeps).toEqual([500]);
    expect(h.logs.find(log => log.context?.outcome === "retry")).toMatchObject({ level: "debug",
      context: { inventory_code: "STOCK_MAPPING_PROVIDER_BUSY", attempt: 1 } });
    expect(await counts(targetId)).toMatchObject({ mappings: 1, preparations: 1 });
  });

  it.each([
    ["E6: a PUBLISHED AUCTION offer for the SKU", "EBAY_SYNC_MAPPING_INVALID", (fake: FakeEbayInventory) => { fake.seedOffer({ sku: F.sku, format: "AUCTION" }); }],
    // The plan named the resolver's DROPSHIP_EBAY_PUBLICATION_MAPPING_CHANGED; through the real reader and observer
    // the connector's identity proof refuses first (the observed publication is a two-member group, the draft one offer).
    ["E6b: a PUBLISHED offer whose listing is a two-member eBay group", "EBAY_SYNC_IDENTITY_CHANGED",
      (fake: FakeEbayInventory) => {
        fake.seedOffer({ sku: F.sku, listingId: "group-listing" });
        fake.seedOffer({ sku: "P6", listingId: "group-listing" });
        // A coherent two-member group listing on eBay (both members point back to the group).
        for (const sku of [F.sku, "P6"]) fake.items.set(sku, { sku, groupIds: ["GROUP-OF-TWO"], availability: { shipToLocationAvailability: { quantity: 4 } } });
        fake.groups.set("GROUP-OF-TWO", { variantSKUs: [F.sku, "P6"], title: "Group", aspects: {} });
      }],
  ])("%s is refused by the connector before the stock link: nothing linked, nothing written", async (_name, code, seed) => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await queuePush({ jobId: 1, itemId: 1 });
    const h = harness();
    seed(h.fake);

    const result = await h.process(1);

    expect(result.items[0]).toMatchObject({ status: "failed" });
    expect(result.items[0]!.errorCode).toBe(code);
    expect((await item(1)).result.push.retryable).toBe(false);
    expect(await counts(targetId)).toEqual({ mappings: 0, drafts: 0, outbox: 0, preparations: 0, audits: 0 });
    expect(h.fake.inventoryOrOfferMutations()).toEqual([]);
    expect(h.logs.some(log => log.code === "DROPSHIP_STOCK_LINK_ENSURE" && log.context?.outcome !== "not_applicable")).toBe(false);
  });

  it("E7: an outbox drain during the push waits for it (retryable), then verifies the canonical quantity", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await queuePush({ jobId: 1, itemId: 1 });
    const h = harness();
    let outboxNow = NOW;
    const outbox = outboxWorker(h.fake, { now: () => outboxNow });
    // Between the link's commit and the connector's first PUT: the outbox worker
    // claims the row the link queued while the offer does not exist yet.
    let drained = false;
    const ensureLinked = h.gate.ensureLinked.bind(h.gate);
    h.gate.ensureLinked = async input => {
      await ensureLinked(input);
      expect(h.fake.inventoryOrOfferMutations()).toEqual([]);
      outboxNow = await nextDue(targetId);
      expect(await outbox.processDue()).toMatchObject({ claimed: 1, verified: 0, failed: 1 });
      drained = true;
    };

    expect((await h.process(1)).items[0]).toMatchObject({ status: "completed" });
    expect(drained).toBe(true);
    expect(await outboxRows(targetId)).toEqual([{ desired_quantity: 17, state: "queued", last_error_class: "DROPSHIP_EBAY_LISTING_PUSH_IN_FLIGHT" }]);

    outboxNow = await nextDue(targetId);
    expect(await outbox.processDue()).toMatchObject({ claimed: 1, verified: 1, failed: 0 });
    expect((await outboxRows(targetId))[0]).toMatchObject({ desired_quantity: 17, state: "verified" });
  });

  it("E8: retries the publish-time admission while another publisher holds the exact SKU scope, then lists", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await queuePush({ jobId: 1, itemId: 1 });
    // Assigned inside the fake's hook, so the declared union is kept (no narrowing to null).
    let scope = null as { release: () => Promise<void> } | null;
    const h = harness({ providerSleep: async () => { await scope?.release(); } });
    h.fake.beforeRequest = async call => {
      // Right before the publish's own admitted request (its offer pre-read), another publisher takes the scope.
      if (!scope && call.method === "GET" && /^\/sell\/inventory\/v1\/offer\/[^/?]+$/.test(call.path)) scope = await holdScope();
    };
    try {
      expect((await h.process(1)).items[0]).toMatchObject({ status: "completed" });
    } finally { await scope?.release(); }
    expect(h.providerSleeps).toEqual([500]);
    expect(h.fake.offers.get("fake-offer-1")).toMatchObject({ status: "PUBLISHED", availableQuantity: 17 });
    expect(await counts(targetId)).toMatchObject({ mappings: 1 });
  });

  it("E9: never sends a quantity to a PUBLISHED offer that is not the listing's recorded offer", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await queuePush({ jobId: 1, itemId: 1 });
    const h = harness();
    await h.process(1);
    // eBay now shows another published offer for the SKU (the recorded one is gone).
    h.fake.offers.delete("fake-offer-1");
    h.fake.seedOffer({ sku: F.sku, offerId: "foreign-offer", availableQuantity: 4 });
    const bulkBefore = h.fake.bulkQuantityUpdates().length;
    const outboxNow = await nextDue(targetId);
    const outbox = outboxWorker(h.fake, { now: () => outboxNow });

    expect(await outbox.processDue()).toMatchObject({ claimed: 1, verified: 0, failed: 1 });

    expect(await outboxRows(targetId)).toEqual([{ desired_quantity: 17, state: "dead_letter", last_error_class: "DROPSHIP_EBAY_OFFER_IDENTITY_CHANGED" }]);
    expect(h.fake.bulkQuantityUpdates()).toHaveLength(bulkBefore);
    expect(h.fake.offers.get("foreign-offer")?.availableQuantity).toBe(4);
    // Review CF-5: the frozen published offer reaches the critical ops-health issue.
    expect(await unverifiedOfferCount()).toBe(1);
  });

  // Review CF-5: a push that published and then failed before its result was saved leaves a linked SKU whose
  // published offer no completed push recorded; the outbox refuses it for good, ops-health shows it, and the next
  // push of the listing records the offer and clears it.
  it("reports a published offer no completed push recorded, and clears it once the listing is pushed again", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await queuePush({ jobId: 1, itemId: 1 });
    const h = harness();
    await h.process(1);
    await database.pool.query("UPDATE dropship.dropship_vendor_listings SET external_offer_id=NULL, external_listing_id=NULL WHERE id=1");
    let outboxNow = await nextDue(targetId);
    const outbox = outboxWorker(h.fake, { now: () => outboxNow });

    expect(await outbox.processDue()).toMatchObject({ claimed: 1, verified: 0, failed: 1 });
    expect(await outboxRows(targetId)).toEqual([{ desired_quantity: 17, state: "dead_letter", last_error_class: "DROPSHIP_EBAY_OFFER_IDENTITY_UNPROVEN" }]);
    expect(await unverifiedOfferCount()).toBe(1);

    await queuePush({ jobId: 2, itemId: 2 });
    expect((await h.process(2)).items[0]).toMatchObject({ status: "completed" });
    expect(await listing()).toMatchObject({ external_offer_id: "fake-offer-1" });
    outboxNow = await nextDue(targetId);
    await outbox.processDue();
    expect((await outboxRows(targetId)).at(-1)).toMatchObject({ state: "verified" });
    expect(await unverifiedOfferCount()).toBe(0);
  });

  // Review AV1-1: the outbox gives up on a stock revision (its attempt cap) while it waits for a queued push and eBay
  // shows a PUBLISHED offer the listing never recorded; that push is then refused before its first write, so the offer
  // keeps its quantity. The dead letter has its own class and is reported once no push of the variant is running.
  it("reports a published offer whose stock revision the outbox gave up on while a push waited, once that push ends without writing", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await queuePush({ jobId: 1, itemId: 1 });
    const h = harness();
    await h.process(1);
    // As in the CF-5 case: published, then the push's result was not saved.
    await database.pool.query("UPDATE dropship.dropship_vendor_listings SET external_offer_id=NULL, external_listing_id=NULL WHERE id=1");
    await queuePush({ jobId: 2, itemId: 2 });
    const bulkBefore = h.fake.bulkQuantityUpdates().length;
    let outboxNow = NOW;
    const outbox = outboxWorker(h.fake, { now: () => outboxNow });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      outboxNow = await nextDue(targetId);
      expect(await outbox.processDue()).toMatchObject({ claimed: 1, verified: 0, failed: 1 });
      if (attempt === 1) {
        expect(await outboxRows(targetId)).toEqual([{ desired_quantity: 17, state: "queued", last_error_class: "DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT" }]);
      }
    }
    expect(await outboxRows(targetId)).toEqual([{ desired_quantity: 17, state: "dead_letter", last_error_class: "DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT" }]);
    // The queued push may still record the offer and write its quantity: not reported while it can.
    expect(await unverifiedOfferCount()).toBe(0);

    // That push is refused before its first eBay write (a stand-in for the hook's DROPSHIP_STOCK_SKU_CHANGED).
    const ensureLinked = h.gate.ensureLinked.bind(h.gate);
    h.gate.ensureLinked = async () => {
      throw new DropshipError("DROPSHIP_STOCK_SKU_CHANGED", "The item's SKU or details changed after it was queued.", { retryable: false });
    };
    expect((await h.process(2)).items[0]).toMatchObject({ status: "failed", errorCode: "DROPSHIP_STOCK_SKU_CHANGED" });
    expect(h.fake.bulkQuantityUpdates()).toHaveLength(bulkBefore);
    expect(h.fake.offers.get("fake-offer-1")).toMatchObject({ status: "PUBLISHED", availableQuantity: 17 });
    expect(await runHealth<{ last_error_class: string }>(destinationHealth.dropshipEbayStockOfferUnverifiedSampleSql(10)))
      .toEqual([expect.objectContaining({ store_connection_id: F.storeConnectionId, product_variant_id: F.variantId,
        last_error_class: "DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT" })]);

    // The next push records the offer and its admitted write makes a newer revision, which verifies and clears it.
    h.gate.ensureLinked = ensureLinked;
    await queuePush({ jobId: 3, itemId: 3 });
    expect((await h.process(3)).items[0]).toMatchObject({ status: "completed" });
    expect(await listing()).toMatchObject({ external_offer_id: "fake-offer-1" });
    outboxNow = await nextDue(targetId);
    await outbox.processDue();
    expect((await outboxRows(targetId)).at(-1)).toMatchObject({ state: "verified" });
    expect(await unverifiedOfferCount()).toBe(0);
  });

  it("E10: refuses a positive push of a store not set to live managed quantity before any eBay call", async () => {
    await createDropshipEbayTarget(database.pool);
    await database.pool.query("UPDATE dropship.dropship_store_listing_configs SET listing_mode='draft_first' WHERE store_connection_id=$1", [F.storeConnectionId]);
    await queuePush({ jobId: 1, itemId: 1, quantity: 5, listingMode: "draft_first" });
    const h = harness();

    const result = await h.process(1);

    expect(result.items[0]).toMatchObject({ status: "failed", errorCode: "DROPSHIP_STOCK_MODE_NOT_MANAGED",
      errorMessage: "Card Shellz only lists items with stock on eBay stores set to live listings with Card Shellz-managed quantity." });
    expect((await item(1)).result.push.retryable).toBe(false);
    expect(h.fake.calls).toEqual([]);
  });

  it("E11: a link busy past the in-process retry fails retryable and the sweep re-queues it after its wait", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await queuePush({ jobId: 1, itemId: 1 });
    const scope = await holdScope();
    const h = harness();
    try {
      expect((await h.process(1)).items[0]).toMatchObject({ status: "failed", errorCode: "DROPSHIP_STOCK_LINK_BUSY" });
    } finally { await scope.release(); }
    expect(h.gateSleeps).toEqual([500, 2_000, 5_000]);
    expect((await item(1)).result.push).toMatchObject({ retryable: true, context: { classification: "transient", operatorAction: false } });
    expect(h.fake.inventoryOrOfferMutations()).toEqual([]);

    const sweep = (at: Date) => runDropshipListingPushSweep({
      repository: new PgDropshipListingPushJobQueueRepository(database.pool),
      processJob: async input => { await h.worker.processJob(input); },
      recovery: new DropshipListingPushRecoveryService({
        liveStatusRepair: { restoreDemotedLiveListings: async () => ({ restored: [], reviewRequired: [], failed: [], skipped: 0 }) },
        accountVerificationRequeue: { requeueAccountVerificationFailures: async () => ({ requeued: [], failed: [] }) },
        stockLinkRequeue: new PgDropshipListingPushOpsRepository(database.pool), stockLinkBatchSize: 25,
        clock: { now: () => at }, logger: { info: () => {}, warn: () => {}, error: () => {} },
      }),
      now: at, workerId: "sweep-p3", logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    expect(await sweep(new Date(NOW.getTime() + 59_000))).toEqual({ processed: 0, failed: 0 });
    expect(await item(1)).toMatchObject({ status: "failed", error_code: "DROPSHIP_STOCK_LINK_BUSY" });
    expect(await auditEvents("listing_push_item_auto_requeued")).toEqual([]);

    expect(await sweep(new Date(NOW.getTime() + 61_000))).toEqual({ processed: 1, failed: 0 });
    expect(await item(1)).toMatchObject({ status: "completed", result: expect.objectContaining({ automaticRequeue: expect.objectContaining({
      count: 1, lastCode: "DROPSHIP_STOCK_LINK_BUSY", resend: false }) }) });
    expect(await auditEvents("listing_push_item_auto_requeued")).toEqual([expect.objectContaining({
      entity_type: "dropship_listing_push_job_item", entity_id: "1", actor_type: "system", actor_id: "system:dropship-stock-link-requeue",
      // Review V2-4: the vendor listing's status before and after, in the same audit row.
      payload: expect.objectContaining({ before: expect.objectContaining({ itemStatus: "failed", errorCode: "DROPSHIP_STOCK_LINK_BUSY", automaticRequeues: 0,
        listingStatus: "failed" }),
        after: expect.objectContaining({ itemStatus: "queued", automaticRequeues: 1, listingStatus: "queued" }) }) })]);
    expect(await counts(targetId)).toMatchObject({ mappings: 1 });
  });

  describe("owner decision Q4: one automatic re-send of a pre-link PUBLICATION_LISTING_TARGET_UNMAPPED failure", () => {
    const BEFORE_DEPLOY = new Date("2026-10-20T09:00:00.000Z");
    const failedBeforeDeploy = (extra: Partial<Parameters<typeof queuePush>[0]> = {}) => queuePush({ jobId: 1, itemId: 1, status: "failed",
      errorCode: "PUBLICATION_LISTING_TARGET_UNMAPPED", updatedAt: BEFORE_DEPLOY,
      result: { push: { status: "failed", errorCode: "PUBLICATION_LISTING_TARGET_UNMAPPED", retryable: false,
        context: { attemptId: null, operatorAction: false, classification: "permanent", requiresReview: true } } }, ...extra });
    const ops = () => new PgDropshipListingPushOpsRepository(database.pool);

    it("re-sends it once when the store has one live destination and the listing is still selected, and it lists", async () => {
      const targetId = await createDropshipEbayTarget(database.pool);
      await failedBeforeDeploy();
      const h = harness();

      const pass = await ops().requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 });

      expect(pass).toMatchObject({ requeued: [{ jobId: 1, itemIds: [1], items: [{ itemId: 1, errorCode: "PUBLICATION_LISTING_TARGET_UNMAPPED", attempt: 1 }] }],
        exhausted: [], skipped: [], failed: [] });
      expect(await item(1)).toMatchObject({ status: "queued", error_code: null, result: expect.objectContaining({
        automaticRequeue: expect.objectContaining({ count: 1, lastCode: "PUBLICATION_LISTING_TARGET_UNMAPPED", resend: true }),
        lastRetryRequest: expect.objectContaining({ actorType: "system", actorId: "system:dropship-stock-link-requeue" }) }) });
      // Item, job, listing and the audit row commit together.
      const writers = (await database.pool.query(`SELECT DISTINCT xid FROM (
        SELECT xmin::text AS xid FROM dropship.dropship_listing_push_job_items WHERE id=1
        UNION ALL SELECT xmin::text FROM dropship.dropship_listing_push_jobs WHERE id=1
        UNION ALL SELECT xmin::text FROM dropship.dropship_vendor_listings WHERE id=1
        UNION ALL SELECT xmin::text FROM dropship.dropship_audit_events WHERE event_type='listing_push_item_auto_requeued') w`)).rows;
      expect(writers).toHaveLength(1);
      expect(await auditEvents("listing_push_item_auto_requeued")).toEqual([expect.objectContaining({ entity_id: "1",
        payload: expect.objectContaining({ resend: true, recovery: "dropship_stock_link" }) })]);

      expect((await h.process(1)).items[0]).toMatchObject({ status: "completed" });
      expect(await counts(targetId)).toMatchObject({ mappings: 1, preparations: 1 });
      expect(await ops().requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 }))
        .toEqual({ requeued: [], exhausted: [], skipped: [], deferred: [], failed: [] });
    });

    it("never re-sends twice: a second refusal is marked exhausted once, for a human", async () => {
      await createDropshipEbayTarget(database.pool);
      await failedBeforeDeploy();
      await ops().requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 });
      // The re-sent push is refused the same way again (simulated: a link lost to a later retirement).
      await database.pool.query(`UPDATE dropship.dropship_listing_push_job_items SET status='failed',error_code='PUBLICATION_LISTING_TARGET_UNMAPPED' WHERE id=1;
        UPDATE dropship.dropship_listing_push_jobs SET status='failed' WHERE id=1`);

      const pass = await ops().requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 });
      expect(pass).toMatchObject({ requeued: [], exhausted: [{ itemId: 1, errorCode: "PUBLICATION_LISTING_TARGET_UNMAPPED", count: 1 }] });
      expect(await item(1)).toMatchObject({ status: "failed", result: expect.objectContaining({ automaticRequeue: expect.objectContaining({
        count: 1, state: "exhausted", stateCode: "DROPSHIP_LISTING_PUSH_AUTOMATIC_REQUEUE_EXHAUSTED" }) }) });
      expect(await auditEvents("listing_push_item_auto_requeue_exhausted")).toHaveLength(1);
      expect(await ops().requeueAutomaticStockLinkFailures({ now: new Date(NOW.getTime() + 86_400_000), workerId: "sweep-p3", limit: 25 }))
        .toEqual({ requeued: [], exhausted: [], skipped: [], deferred: [], failed: [] });
      expect(await auditEvents("listing_push_item_auto_requeue_exhausted")).toHaveLength(1);
    });

    it("waits, untouched, while the store has no single live destination, and re-sends once it has one", async () => {
      await failedBeforeDeploy();
      expect(await ops().requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 }))
        .toEqual({ requeued: [], exhausted: [], skipped: [], deferred: [], failed: [] });
      expect(await item(1)).toMatchObject({ status: "failed", result: expect.not.objectContaining({ automaticRequeue: expect.anything() }) });
      const targetId = await createDropshipEbayTarget(database.pool, { state: "disabled" });
      expect((await ops().requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 })).requeued).toEqual([]);
      expect(await auditEvents("listing_push_item_auto_requeued")).toEqual([]);

      // The destination is turned on later (the same activation steps the fixture uses).
      await database.pool.query(`UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,
        activated_by='fixture',activated_at=transaction_timestamp() WHERE id=$1`, [targetId]);
      await database.pool.query("UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=$1", [targetId]);
      expect((await ops().requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 })).requeued).toHaveLength(1);
    });

    /** The real destination reader, counting the stores it is asked about. */
    const countingOps = () => {
      const reads: number[] = [];
      const repository = new PgDropshipListingPushOpsRepository(database.pool, async input => {
        reads.push(input.storeConnectionId);
        return readDropshipEbayStockDestination(database.pool, input);
      });
      return { reads, pass: (now: Date = NOW) => repository.requeueAutomaticStockLinkFailures({ now, workerId: "sweep-p3", limit: 25 }) };
    };
    const untouched = async () => expect(await item(1)).toMatchObject({ status: "failed", error_code: "PUBLICATION_LISTING_TARGET_UNMAPPED",
      result: expect.not.objectContaining({ automaticRequeue: expect.anything() }) });

    // Review MC-2 / CF-6: the stores the pre-pass reads come from the same guarded selection as the re-send.
    it.each([
      ["superseded by the vendor's newer push of the listing", async () => { await queuePush({ jobId: 2, itemId: 2 }); }],
      ["whose listing has ended", async () => { await database.pool.query("UPDATE dropship.dropship_vendor_listings SET status='ended' WHERE id=1"); }],
      ["whose listing was previewed again since", async () => { await database.pool.query("UPDATE dropship.dropship_vendor_listings SET last_preview_hash='preview-new' WHERE id=1"); }],
    ])("never reads a destination for a re-send that cannot happen: an item %s", async (_name, change) => {
      await createDropshipEbayTarget(database.pool);
      await failedBeforeDeploy();
      await change();
      const ops = countingOps();

      expect(await ops.pass()).toEqual({ requeued: [], exhausted: [], skipped: [], deferred: [], failed: [] });
      expect(await ops.pass(new Date(NOW.getTime() + 86_400_000))).toEqual({ requeued: [], exhausted: [], skipped: [], deferred: [], failed: [] });
      expect(ops.reads).toEqual([]);
      await untouched();
    });

    // Review MC-3 (owner Q4: "failed ... before this deploys"): the worker that links stock marks its own UNMAPPED failures.
    it("does not re-send an UNMAPPED failure recorded by the worker that links stock, and reads no destination for it", async () => {
      await createDropshipEbayTarget(database.pool);
      await failedBeforeDeploy({ result: { push: { status: "failed", errorCode: "PUBLICATION_LISTING_TARGET_UNMAPPED", retryable: false,
        context: { attemptId: null, operatorAction: false, classification: "permanent", requiresReview: true, recordedWithAutomaticStockLink: true } } } });
      const ops = countingOps();

      expect(await ops.pass()).toEqual({ requeued: [], exhausted: [], skipped: [], deferred: [], failed: [] });
      expect(ops.reads).toEqual([]);
      await untouched();
      expect(await auditEvents("listing_push_item_auto_requeued")).toEqual([]);
    });

    // Review CF-2: a paused listing is looked at again later instead of losing its only automatic re-send.
    it("waits while the listing is only paused, without a mark, and re-sends it once it is unpaused", async () => {
      await createDropshipEbayTarget(database.pool);
      await failedBeforeDeploy();
      await database.pool.query("UPDATE dropship.dropship_vendor_listings SET status='paused' WHERE id=1");
      const ops = countingOps();

      const first = await ops.pass();
      expect(first).toMatchObject({ requeued: [], skipped: [], deferred: [{ itemId: 1, reason: "zero:listing_paused" }], failed: [] });
      await untouched();
      expect(await auditEvents("listing_push_item_auto_resend_skipped")).toEqual([]);

      await database.pool.query("UPDATE dropship.dropship_vendor_listings SET status='failed' WHERE id=1");
      // Within the recheck time the listing is not looked at again (and its store is not read for it).
      expect(await ops.pass(new Date(NOW.getTime() + 60_000))).toEqual({ requeued: [], exhausted: [], skipped: [], deferred: [], failed: [] });
      expect(ops.reads).toEqual([F.storeConnectionId]);
      const later = await ops.pass(new Date(NOW.getTime() + 15 * 60_000));
      expect(later.requeued).toEqual([expect.objectContaining({ jobId: 1, itemIds: [1] })]);
      expect(await item(1)).toMatchObject({ status: "queued", result: expect.objectContaining({
        automaticRequeue: expect.objectContaining({ count: 1, resend: true }) }) });
    });

    // Review MC-2: a destination read that fails the same way on every pass is not retried for ever.
    it("takes a store's re-sends out for review, with audit rows, when its destination cannot be read at all", async () => {
      await createDropshipEbayTarget(database.pool);
      await failedBeforeDeploy();
      let reads = 0;
      const unreadable = new PgDropshipListingPushOpsRepository(database.pool, async () => {
        reads += 1;
        throw Object.assign(new Error("Stored destination row does not match its schema."), { name: "ZodError" });
      });

      const pass = await unreadable.requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 });

      expect(pass.failed).toEqual([expect.objectContaining({ entity: "dropship_store_connection", entityId: F.storeConnectionId,
        classification: "permanent", markedForReview: true })]);
      expect(await item(1)).toMatchObject({ status: "failed", result: expect.objectContaining({ automaticRequeue: expect.objectContaining({
        state: "requires_review", stateCode: "DROPSHIP_STOCK_LINK_RESEND_DESTINATION_UNREADABLE" }) }) });
      expect(await auditEvents("listing_push_item_auto_requeue_review_required")).toEqual([expect.objectContaining({ entity_id: "1",
        actor_id: "system:dropship-stock-link-requeue", severity: "error" })]);
      expect(await unreadable.requeueAutomaticStockLinkFailures({ now: new Date(NOW.getTime() + 3_600_000), workerId: "sweep-p3", limit: 25 }))
        .toEqual({ requeued: [], exhausted: [], skipped: [], deferred: [], failed: [] });
      expect(reads).toBe(1);
    });

    // Review TW-1: the one-time re-send never adopts a published eBay listing the vendor listing never recorded.
    it("refuses, before any write, to adopt a published eBay listing with the SKU that the vendor listing never recorded", async () => {
      const targetId = await createDropshipEbayTarget(database.pool);
      await failedBeforeDeploy();
      const h = harness();
      // The vendor listed the SKU on eBay themselves after the failure.
      const vendorOffer = h.fake.seedOffer({ sku: F.sku, offerId: "vendor-offer", listingId: "vendor-listing", availableQuantity: 3 });
      expect((await ops().requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 })).requeued).toHaveLength(1);

      const result = await h.process(1);

      expect(result.items[0]).toMatchObject({ status: "failed", errorCode: "DROPSHIP_STOCK_RESEND_LISTING_FOUND",
        errorMessage: "eBay already has a published listing with this SKU in your store, so Card Shellz did not send this listing again automatically." });
      expect((await item(1)).result.push).toMatchObject({ retryable: false, context: { inventoryCode: "DROPSHIP_STOCK_UNRECORDED_PUBLISHED_LISTING",
        operatorAction: false, classification: "permanent" } });
      expect(h.fake.inventoryOrOfferMutations()).toEqual([]);
      expect(h.fake.offers.get("vendor-offer")).toEqual(vendorOffer);
      expect(await counts(targetId)).toEqual({ mappings: 0, drafts: 0, outbox: 0, preparations: 0, audits: 0 });
      expect(await listing()).toMatchObject({ external_listing_id: null, external_offer_id: null });
      // Spent: the at-cap pass marks it exhausted for a human; the vendor can still queue it themselves.
      expect((await ops().requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 })).requeued).toEqual([]);
    });

    // Review TW-6 (plan section 4): an earlier failed push left an inventory item at 0 and an UNPUBLISHED offer.
    it("re-sends onto the orphan an earlier failed push left (inventory item at 0, UNPUBLISHED offer) and publishes that same offer", async () => {
      const targetId = await createDropshipEbayTarget(database.pool);
      await failedBeforeDeploy();
      const h = harness();
      h.fake.items.set(F.sku, { sku: F.sku, availability: { shipToLocationAvailability: { quantity: 0 } } });
      h.fake.seedOffer({ sku: F.sku, offerId: "orphan-offer", status: "UNPUBLISHED", availableQuantity: 0 });
      let outboxNow = NOW;
      const outbox = outboxWorker(h.fake, { now: () => outboxNow });
      // An outbox drain between the link and the push's first write: the offer exists but is not published or recorded.
      const ensureLinked = h.gate.ensureLinked.bind(h.gate);
      const resolvedOffers: unknown[] = [];
      h.gate.ensureLinked = async input => {
        resolvedOffers.push(input.resolved);
        await ensureLinked(input);
        outboxNow = await nextDue(targetId);
        expect(await outbox.processDue()).toMatchObject({ claimed: 1, verified: 0, failed: 1 });
      };
      expect((await ops().requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 })).requeued).toHaveLength(1);

      expect((await h.process(1)).items[0]).toMatchObject({ status: "completed" });

      // eBay sync-back (SB5): the hook also gets the orphan offer exactly as this push's own lookup saw it.
      expect(resolvedOffers).toEqual([{ offers: [{ variantId: F.variantId, sku: F.sku, existingOfferId: "orphan-offer",
        observedOffer: expect.objectContaining({ offerId: "orphan-offer", status: "UNPUBLISHED", availableQuantity: 0 }) }],
      verifiedPublishedListingId: null }]);
      expect(h.fake.offersForSku(F.sku)).toEqual([expect.objectContaining({ offerId: "orphan-offer", status: "PUBLISHED", availableQuantity: 17 })]);
      expect(h.fake.calls.some(call => call.method === "POST" && call.path === "/sell/inventory/v1/offer")).toBe(false);
      expect(await counts(targetId)).toMatchObject({ mappings: 1, preparations: 1 });
      expect(await listing()).toMatchObject({ status: "active", external_offer_id: "orphan-offer" });
      expect((await outboxRows(targetId))[0]).toMatchObject({ desired_quantity: 17, state: "queued", last_error_class: "DROPSHIP_EBAY_LISTING_PUSH_IN_FLIGHT" });
      outboxNow = await nextDue(targetId);
      expect(await outbox.processDue()).toMatchObject({ claimed: 1, verified: 1, failed: 0 });
    });

    it("does not re-send a listing the vendor no longer selects: it is marked skipped once and never re-sent", async () => {
      await createDropshipEbayTarget(database.pool);
      await failedBeforeDeploy();
      await database.pool.query("INSERT INTO dropship.dropship_vendor_variant_overrides(vendor_id,product_variant_id,enabled_override) VALUES($1,$2,false)",
        [F.vendorId, F.variantId]);

      const pass = await ops().requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 });

      expect(pass).toMatchObject({ requeued: [], skipped: [{ itemId: 1, errorCode: "PUBLICATION_LISTING_TARGET_UNMAPPED", reason: expect.stringMatching(/^zero:/) }] });
      expect(await item(1)).toMatchObject({ status: "failed", result: expect.objectContaining({ automaticRequeue: expect.objectContaining({ state: "skipped" }) }) });
      expect(await auditEvents("listing_push_item_auto_resend_skipped")).toHaveLength(1);
      await database.pool.query("DELETE FROM dropship.dropship_vendor_variant_overrides");
      expect(await ops().requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 }))
        .toEqual({ requeued: [], exhausted: [], skipped: [], deferred: [], failed: [] });
    });
  });

  it("re-queues each passing code only after its wait, up to its cap, and leaves every other code alone", async () => {
    await createDropshipEbayTarget(database.pool);
    // One failed item per code and count, each on its own listing (store variant).
    const cases: Array<{ id: number; variant: number; store?: number; vendor?: number; code: string; count: number; waitMs: number | null }> = [
      { id: 1, variant: 101, code: "DROPSHIP_STOCK_LINK_BUSY", count: 0, waitMs: 60_000 },
      { id: 2, variant: 102, code: "PUBLICATION_SCOPE_BUSY", count: 1, waitMs: 300_000 },
      { id: 3, variant: 103, code: "DROPSHIP_STOCK_UPDATES_PAUSED", count: 2, waitMs: 14_400_000 },
      { id: 4, variant: 104, code: "DROPSHIP_STOCK_LINK_BUSY", count: 3, waitMs: null },
      { id: 5, variant: 101, store: 23, vendor: 11, code: "DROPSHIP_STOCK_DESTINATION_NOT_READY", count: 0, waitMs: null },
    ];
    for (const row of cases) {
      // Recorded by the worker that links stock first, as every re-queue code it records (review V2-1).
      await queuePush({ jobId: row.id, itemId: row.id, listingId: row.id, productVariantId: row.variant, storeConnectionId: row.store,
        vendorId: row.vendor, status: "failed", errorCode: row.code, updatedAt: NOW,
        result: { ...RECORDED_AFTER_LINK, ...(row.count ? { automaticRequeue: { count: row.count, lastCode: row.code } } : {}) } });
    }
    const ops = new PgDropshipListingPushOpsRepository(database.pool);
    const exhausted: Array<{ itemId: number; errorCode: string; count: number }> = [];
    const requeuedAt = async (offsetMs: number) => {
      const pass = await ops.requeueAutomaticStockLinkFailures({ now: new Date(NOW.getTime() + offsetMs), workerId: "sweep-p3", limit: 25 });
      exhausted.push(...pass.exhausted);
      return pass.requeued.flatMap(job => job.itemIds);
    };

    for (const row of cases.filter(entry => entry.waitMs !== null)) {
      expect(await requeuedAt(row.waitMs! - 1)).toEqual([]);
      expect(await requeuedAt(row.waitMs!)).toEqual([row.id]);
      expect(await item(row.id)).toMatchObject({ status: "queued", result: expect.objectContaining({
        automaticRequeue: expect.objectContaining({ count: row.count + 1, lastCode: row.code }) }) });
    }
    // At its cap: never re-queued, marked exhausted once (on the first pass). Another code: untouched.
    expect(await requeuedAt(86_400_000)).toEqual([]);
    expect(exhausted).toEqual([expect.objectContaining({ itemId: 4, errorCode: "DROPSHIP_STOCK_LINK_BUSY", count: 3 })]);
    expect(await item(4)).toMatchObject({ status: "failed", result: expect.objectContaining({
      automaticRequeue: expect.objectContaining({ count: 3, state: "exhausted" }) }) });
    expect(await auditEvents("listing_push_item_auto_requeue_exhausted")).toHaveLength(1);
    expect(await item(5)).toMatchObject({ status: "failed", error_code: "DROPSHIP_STOCK_DESTINATION_NOT_READY",
      result: expect.not.objectContaining({ automaticRequeue: expect.anything() }) });
  });

  // Review V2-1: owner Q4 approved re-sending old failures only for PUBLICATION_LISTING_TARGET_UNMAPPED. A passing code
  // recorded before this deploy (no marker; PR 1b told the vendor to queue it again) is never re-queued, marked or
  // audited, whatever its age; one recorded after it is re-queued after its wait. Review V2-4: that audit row carries
  // the vendor listing's status before and after (a live listing keeps its status).
  it("never re-queues a passing code recorded before the automatic stock link, whatever its age; a later one with its listing status", async () => {
    await createDropshipEbayTarget(database.pool);
    const LONG_AGO = new Date("2026-01-05T08:00:00.000Z");
    await queuePush({ jobId: 1, itemId: 1, listingId: 1, productVariantId: 101, status: "failed", errorCode: "PUBLICATION_SCOPE_BUSY",
      updatedAt: LONG_AGO, result: { push: { status: "failed", retryable: true, context: { attemptId: null, operatorAction: false } } } });
    await queuePush({ jobId: 2, itemId: 2, listingId: 2, productVariantId: 102, status: "failed", errorCode: "PUBLICATION_SCOPE_BUSY",
      updatedAt: NOW, result: RECORDED_AFTER_LINK });
    await database.pool.query("UPDATE dropship.dropship_vendor_listings SET status='active', external_listing_id='110000000002', external_offer_id='offer-2' WHERE id=2");
    const ops = new PgDropshipListingPushOpsRepository(database.pool);

    expect(await ops.requeueAutomaticStockLinkFailures({ now: new Date(NOW.getTime() + 60_000 - 1), workerId: "sweep-p3", limit: 25 }))
      .toEqual({ requeued: [], exhausted: [], skipped: [], deferred: [], failed: [] });
    const pass = await ops.requeueAutomaticStockLinkFailures({ now: new Date(NOW.getTime() + 60_000), workerId: "sweep-p3", limit: 25 });

    expect(pass.requeued.flatMap(job => job.itemIds)).toEqual([2]);
    expect(await item(1)).toMatchObject({ status: "failed", error_code: "PUBLICATION_SCOPE_BUSY",
      result: expect.not.objectContaining({ automaticRequeue: expect.anything() }) });
    expect(await auditEvents("listing_push_item_auto_requeued")).toEqual([expect.objectContaining({ entity_id: "2",
      payload: expect.objectContaining({ before: expect.objectContaining({ listingStatus: "active" }),
        after: expect.objectContaining({ listingStatus: "active" }) }) })]);
    expect(await listing(2)).toMatchObject({ status: "active" });
    // Never later either: no state mark, no audit row, nothing promised.
    expect(await ops.requeueAutomaticStockLinkFailures({ now: new Date(NOW.getTime() + 86_400_000), workerId: "sweep-p3", limit: 25 }))
      .toEqual({ requeued: [], exhausted: [], skipped: [], deferred: [], failed: [] });
    expect(await readAutomaticRequeuePendingItemIds(database.pool, 1)).toEqual([]);
    expect((await database.pool.query(`SELECT count(*)::int AS n FROM dropship.dropship_audit_events
      WHERE entity_type='dropship_listing_push_job_item' AND entity_id='1'`)).rows[0].n).toBe(0);
  });

  // Review V2-2: the vendor's email and portal say "tried again automatically" only for the items the sweep will
  // re-queue, read with the sweep's own guards (not only the item's code and count).
  it("tells which failed items the push sweep will re-queue, with the sweep's own store guards", async () => {
    await createDropshipEbayTarget(database.pool);
    await database.pool.query("ALTER TABLE dropship.dropship_store_connections ADD COLUMN IF NOT EXISTS config jsonb");
    await queuePush({ jobId: 1, itemId: 1, listingId: 1, productVariantId: 101, status: "failed", errorCode: "DROPSHIP_STOCK_LINK_BUSY",
      result: RECORDED_AFTER_LINK });
    await queuePush({ jobId: 1, itemId: 2, listingId: 2, productVariantId: 102, status: "failed", errorCode: "DROPSHIP_STOCK_LINK_BUSY",
      result: { ...RECORDED_AFTER_LINK, automaticRequeue: { count: 3, lastCode: "DROPSHIP_STOCK_LINK_BUSY" } } });
    await queuePush({ jobId: 1, itemId: 3, listingId: 3, productVariantId: 103, status: "failed", errorCode: "PUBLICATION_SCOPE_BUSY" });
    await queuePush({ jobId: 1, itemId: 4, listingId: 4, productVariantId: 104, status: "failed", errorCode: "DROPSHIP_STOCK_UPDATES_PAUSED",
      updatedAt: new Date(NOW.getTime() - 86_400_000), result: RECORDED_AFTER_LINK });
    const status = new PgDropshipListingPushStatusRepository(database.pool);
    const portal = async () => (await status.loadVendorJob({ vendorId: F.vendorId, jobId: 1 }))!.items
      .map(entry => [entry.itemId, entry.automaticRetryPending]);

    // Below its cap and recorded after the link, whatever the wait; not at the cap, not recorded before the link.
    expect(await readAutomaticRequeuePendingItemIds(database.pool, 1)).toEqual([1, 4]);
    expect(await portal()).toEqual([[1, true], [2, false], [3, false], [4, true]]);

    // A guard the item cannot show: the store must be reconnected, so the sweep re-queues nothing and nothing is promised.
    await database.pool.query("UPDATE dropship.dropship_store_connections SET status='needs_reauth' WHERE id=$1", [F.storeConnectionId]);
    expect(await readAutomaticRequeuePendingItemIds(database.pool, 1)).toEqual([]);
    expect(await portal()).toEqual([[1, false], [2, false], [3, false], [4, false]]);
    expect((await new PgDropshipListingPushOpsRepository(database.pool).requeueAutomaticStockLinkFailures({
      now: new Date(NOW.getTime() + 86_400_000), workerId: "sweep-p3", limit: 25 })).requeued).toEqual([]);
  });

  // Review V2-3: a marker that is not an object (only a manual edit or corruption) is marked exhausted once, with one
  // audit row; the mark replaces it instead of turning it into an array that every later pass would select again.
  it.each([["a string", JSON.stringify("x")], ["JSON null", "null"], ["an array", JSON.stringify([1])]])(
    "marks an item whose re-queue marker is %s exhausted once, and never again", async (_name, marker) => {
      await createDropshipEbayTarget(database.pool);
      await queuePush({ jobId: 1, itemId: 1, status: "failed", errorCode: "DROPSHIP_STOCK_LINK_BUSY", result: RECORDED_AFTER_LINK });
      await database.pool.query(`UPDATE dropship.dropship_listing_push_job_items SET result = result || jsonb_build_object('automaticRequeue', $1::jsonb)
        WHERE id=1`, [marker]);
      const ops = new PgDropshipListingPushOpsRepository(database.pool);

      expect((await ops.requeueAutomaticStockLinkFailures({ now: NOW, workerId: "sweep-p3", limit: 25 })).exhausted)
        .toEqual([expect.objectContaining({ itemId: 1, errorCode: "DROPSHIP_STOCK_LINK_BUSY" })]);
      expect((await item(1)).result.automaticRequeue).toMatchObject({ state: "exhausted", stateCode: "DROPSHIP_LISTING_PUSH_AUTOMATIC_REQUEUE_EXHAUSTED" });
      for (const offset of [10_000, 20_000, 86_400_000]) {
        expect(await ops.requeueAutomaticStockLinkFailures({ now: new Date(NOW.getTime() + offset), workerId: "sweep-p3", limit: 25 }))
          .toEqual({ requeued: [], exhausted: [], skipped: [], deferred: [], failed: [] });
      }
      expect(await auditEvents("listing_push_item_auto_requeue_exhausted")).toHaveLength(1);
      expect(await item(1)).toMatchObject({ status: "failed" });
    });

  // Rebase of PR A onto Fix PR 2a: a publish run reports its chunks' outcomes once, when it finishes (its email and
  // card; a chunk job sends no email of its own), and the account-check requeue already leaves its jobs alone
  // (accountRefusalCandidateSql). The stock link re-queue does the same (stockLinkCandidateSql, run_id null), in every
  // mode: no re-queue, exhausted mark, one-time re-send, destination read or promised retry for a run's item.
  it("leaves a publish run's chunk job to its run, whether the run is processing, finished or stopped", async () => {
    await createDropshipEbayTarget(database.pool);
    await database.pool.query("INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(105,20,'P9') ON CONFLICT DO NOTHING");
    const run = async (status: "processing" | "partial" | "cancelled") => (await database.pool.query<{ id: string }>(
      `INSERT INTO dropship.dropship_listing_push_runs (vendor_id, store_connection_id, scope, status, stop_reason, idempotency_key,
         request_hash, target_count, chunk_size, chunk_count, next_chunk_index, actor_type, cancel_requested_at, created_at, updated_at,
         completed_at)
       VALUES ($1, $2, 'all', $3, $4, $5, repeat('a', 64), 2, 500, 1, 1, 'vendor', $6, $7, $7, $8) RETURNING id`,
      [F.vendorId, F.storeConnectionId, status, status === "cancelled" ? "vendor_stop" : null, `p3-run-${status}`,
        status === "cancelled" ? NOW : null, NOW, status === "processing" ? null : NOW])).rows[0]!.id;
    const chunkOf = async (jobId: number, runId: string) => database.pool.query(
      "UPDATE dropship.dropship_listing_push_jobs SET run_id = $2, run_chunk_index = 0 WHERE id = $1", [jobId, runId]);
    // A run still processing, one finished (partial) and one the vendor stopped, each with a failed chunk job.
    await queuePush({ jobId: 1, itemId: 1, listingId: 1, productVariantId: 101, status: "failed", errorCode: "DROPSHIP_STOCK_LINK_BUSY",
      result: RECORDED_AFTER_LINK });
    await queuePush({ jobId: 2, itemId: 2, listingId: 2, productVariantId: 102, status: "failed", errorCode: "DROPSHIP_STOCK_LINK_BUSY",
      result: { ...RECORDED_AFTER_LINK, automaticRequeue: { count: 3, lastCode: "DROPSHIP_STOCK_LINK_BUSY" } } });
    // An UNMAPPED failure recorded before the link existed: owner Q4's one-time re-send, if it were not a run's.
    await queuePush({ jobId: 2, itemId: 5, listingId: 5, productVariantId: 105, sku: "P9", status: "failed",
      errorCode: "PUBLICATION_LISTING_TARGET_UNMAPPED", result: { push: { status: "failed", retryable: false,
        context: { attemptId: null, operatorAction: false, classification: "permanent", requiresReview: true } } } });
    await queuePush({ jobId: 3, itemId: 3, listingId: 3, productVariantId: 103, status: "failed", errorCode: "DROPSHIP_STOCK_UPDATES_PAUSED",
      result: RECORDED_AFTER_LINK });
    await chunkOf(1, await run("processing"));
    await chunkOf(2, await run("partial"));
    await chunkOf(3, await run("cancelled"));
    // The same facts outside a run: re-queued as before.
    await queuePush({ jobId: 4, itemId: 4, listingId: 4, productVariantId: 104, status: "failed", errorCode: "DROPSHIP_STOCK_LINK_BUSY",
      result: RECORDED_AFTER_LINK });
    const reads: number[] = [];
    const ops = new PgDropshipListingPushOpsRepository(database.pool, async input => {
      reads.push(input.storeConnectionId);
      return readDropshipEbayStockDestination(database.pool, input);
    });

    // Nothing is promised for a run's item (the failure email and the portal's automaticRetryPending read this).
    for (const jobId of [1, 2, 3]) expect(await readAutomaticRequeuePendingItemIds(database.pool, jobId), String(jobId)).toEqual([]);
    expect(await readAutomaticRequeuePendingItemIds(database.pool, 4)).toEqual([4]);
    await database.pool.query("ALTER TABLE dropship.dropship_store_connections ADD COLUMN IF NOT EXISTS config jsonb");
    const status = new PgDropshipListingPushStatusRepository(database.pool);
    const portal = async (jobId: number) => (await status.loadVendorJob({ vendorId: F.vendorId, jobId }))!.items
      .map(entry => [entry.itemId, entry.automaticRetryPending]);
    expect(await portal(1)).toEqual([[1, false]]);
    expect(await portal(4)).toEqual([[4, true]]);

    const pass = await ops.requeueAutomaticStockLinkFailures({ now: new Date(NOW.getTime() + 86_400_000), workerId: "sweep-p3", limit: 25 });

    expect(pass).toMatchObject({ requeued: [{ jobId: 4, itemIds: [4] }], exhausted: [], skipped: [], deferred: [], failed: [] });
    expect(reads).toEqual([]);
    for (const itemId of [1, 2, 3, 5]) {
      const row = await item(itemId);
      expect(row.status, String(itemId)).toBe("failed");
      expect(row.result.automaticRequeue?.state, String(itemId)).toBeUndefined();
      expect(row.result.lastRetryRequest, String(itemId)).toBeUndefined();
    }
    expect((await item(2)).result.automaticRequeue).toEqual({ count: 3, lastCode: "DROPSHIP_STOCK_LINK_BUSY" });
    expect((await database.pool.query(`SELECT id, status FROM dropship.dropship_listing_push_jobs WHERE id = ANY($1::int[]) ORDER BY id`, [[1, 2, 3, 4]])).rows)
      .toEqual([{ id: 1, status: "failed" }, { id: 2, status: "failed" }, { id: 3, status: "failed" }, { id: 4, status: "queued" }]);
    expect((await database.pool.query(`SELECT entity_id, event_type FROM dropship.dropship_audit_events
      WHERE entity_type = 'dropship_listing_push_job_item' ORDER BY id`)).rows).toEqual([{ entity_id: "4", event_type: "listing_push_item_auto_requeued" }]);
  });

  it("two concurrent links for one SKU make one mapping: the second waits out the fence and finds the link", async () => {
    const targetId = await createDropshipEbayTarget(database.pool);
    await queuePush({ jobId: 1, itemId: 1 });
    await queuePush({ jobId: 2, itemId: 2 });
    const reached = signal(), resume = signal();
    let paused = false;
    // Scheduling barrier only (SQL and results unchanged): the first link pauses right after it takes the fence.
    const pausing = new Proxy(database.pool, { get(target, key) {
      if (key === "connect") return async () => {
        const connected = await target.connect();
        return new Proxy(connected, { get(connection, field) {
          if (field === "query") return async (...args: unknown[]) => {
            const result = await Reflect.apply(connection.query, connection, args);
            if (!paused && String(args[0]).includes("acquire_cutover_admission_fence")) { paused = true; reached.release(); await resume.promise; }
            return result;
          };
          const value = Reflect.get(connection, field);
          return typeof value === "function" ? value.bind(connection) : value;
        } });
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const request = (jobId: number) => ({ vendorId: F.vendorId, storeConnectionId: F.storeConnectionId, jobId, jobItemId: jobId, listingId: 1,
      productVariantId: F.variantId, platform: "ebay" as const, listingIntent: intent() as never, existingExternalListingId: null,
      existingExternalOfferId: null, idempotencyKey: `p3-${jobId}` });
    const resolved = { offers: [{ variantId: F.variantId, sku: F.sku, existingOfferId: null }], verifiedPublishedListingId: null };
    const first = harness({ pool: pausing as Pool });
    let firstDone!: Promise<void>;
    const second = harness({ gateSleep: async () => { resume.release(); await firstDone; } });
    const epochBefore = await epoch();

    firstDone = first.gate.ensureLinked({ request: request(1), credential: credential(), environment: "production", sku: F.sku, resolved });
    await reached.promise;
    await second.gate.ensureLinked({ request: request(2), credential: credential(), environment: "production", sku: F.sku, resolved });
    await firstDone;

    expect(await counts(targetId)).toMatchObject({ mappings: 1, preparations: 1, outbox: 1 });
    expect(Number(await epoch())).toBe(Number(epochBefore) + 1);
    expect(second.gateSleeps).toEqual([500]);
    expect(first.logs.find(log => log.context?.outcome === "linked")).toBeDefined();
    expect(second.logs.find(log => log.context?.outcome === "already_linked")).toBeDefined();
  });

  it("E5: under legacy authority the push links nothing and sends the intent quantity", async () => {
    const legacy = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    try {
      await installWalmartPublicationInventoryFixture(legacy.pool, { includeWalmartMapping: false, targetState: "preview",
        includeQuantityRecoveryMigrations: true });
      await installCutoverAdmissionFixturePrerequisites(legacy.pool);
      // The same migration set as the canonical eBay fixture, without its activation.
      for (const name of ["236_inventory_cutover_admission.sql", "0721_inventory_publication_direct_enable.sql",
        "0742_ebay_publication_stock_readiness.sql", "900000008000018120001_ebay_automatic_sync_recovery.sql",
        "900000011000018230001_ebay_publication_preflight_recovery.sql"]) {
        await legacy.pool.query(readFileSync(resolve("migrations", name), "utf8"));
      }
      const state = async () => (await legacy.pool.query(`SELECT
        (SELECT authority FROM inventory.availability_runtime_authority) AS authority,
        (SELECT epoch::text FROM inventory.cutover_admission_fence) AS epoch,
        (SELECT count(*)::int FROM inventory.publication_variant_mapping_versions) AS mappings,
        (SELECT count(*)::int FROM inventory.inventory_publication_outbox) AS outbox,
        (SELECT count(*)::int FROM inventory.publication_mapping_preparations) AS preparations`)).rows[0];
      const before = await state();
      expect(before.authority).toBe("legacy");
      const fake = new FakeEbayInventory();
      const logs: string[] = [];
      const gate = createDropshipEbayStockReadinessGate({ pool: legacy.pool, clock: { now: () => NOW }, sleep: async () => {},
        logger: { debug: event => logs.push(String(event.context?.outcome)), info: () => {}, warn: () => {}, error: () => {} } });
      const preflight = { compatible: true, fulfillmentPolicyId: "fulfillment", capabilityEvidenceHash: "capability", originWarehouseId: 1, issues: [] };
      const location = { merchantLocationKey: MERCHANT_LOCATION, name: "Card Shellz Dropship", originWarehouseId: 1, action: "unchanged" as const };
      runtime.pool = legacy.pool;
      const provider = new EbayDropshipListingPushProvider(credentials, fake.fetch, { now: () => NOW },
        { evaluateForStoreConnection: async () => preflight, evaluateWithAccessToken: async () => preflight },
        { ensureForStoreConnection: async () => location, ensureWithAccessToken: async () => location },
        createDropshipEbayQuantityRequestAdmission, undefined, { stockReadiness: gate, sleep: async () => {} });

      await expect(provider.pushListing({ vendorId: F.vendorId, storeConnectionId: F.storeConnectionId, jobId: 1, jobItemId: 1, listingId: 1,
        productVariantId: F.variantId, platform: "ebay", listingIntent: intent({ quantity: 6 }) as never, existingExternalListingId: null,
        existingExternalOfferId: null, idempotencyKey: "p3-legacy" })).resolves.toMatchObject({ externalOfferId: "fake-offer-1" });

      expect(logs).toEqual(["not_applicable"]);
      expect(await state()).toEqual(before);
      const putItem = fake.calls.find(call => call.method === "PUT" && call.path.includes("/inventory_item/"));
      expect((putItem!.body as { availability: { shipToLocationAvailability: { quantity: number } } }).availability.shipToLocationAvailability.quantity).toBe(6);
    } finally {
      runtime.pool = database.pool;
      await legacy.close();
    }
  }, 90_000);
});
