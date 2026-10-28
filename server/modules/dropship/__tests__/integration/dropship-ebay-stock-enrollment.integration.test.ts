import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StockLinkDestination, StockLinkOfferLookup } from "@shared/types/stock-link";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-composition-database.fixture";
import {
  DROPSHIP_EBAY_STOCK as F, countDropshipStockRows, createDropshipEbayTarget, installDropshipEbayStockFixture, sealDropshipMapping,
} from "../../../inventory-planning/__tests__/fixtures/dropship-ebay-stock.fixture";
import { stockLinksMigrationSql } from "../../../inventory-planning/__tests__/fixtures/stock-link.fixture";
import type { StockLinkOfferAdapter } from "../../../inventory-planning/application/stock-link.ports";
import { createStockLinkService } from "../../../inventory-planning/infrastructure/stock-link.factory";
import { dropshipEbayStockCommandKey } from "../../../inventory-planning/quantity-publication";
import { enrollmentEvidenceHash } from "../../../inventory-planning/domain/stock-link-enrollment";
import { DropshipEbayStockLinkSource } from "../../infrastructure/dropship-ebay-stock-link-source";

// Channels PR3 over real PostgreSQL: the stock-link tick's listing enrollment for a Dropship eBay store, with the real
// Dropship source SQL, the real selection reader, the real check rows (M1) and the real Dropship writer
// (ensureDropshipEbayStockReady: fence, keys, receipts, audit, outbox). Only eBay is a stand-in (offers per SKU).
const runtime = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  if (!runtime.pool) throw new Error("Disposable database is not initialized.");
  const value = Reflect.get(runtime.pool, key);
  return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const NOW = new Date("2026-10-28T12:00:00.000Z");
const LISTING_ID = 70;
const OFFER_ID = "5001";
const EBAY_LISTING_ID = "3990";

/**
 * PR A's publish run tables, reduced to the columns the source reads (the real migration and its keys run in
 * dropship-listing-push-runs.integration.test.ts and the push stock-link suite).
 */
const PUBLISH_RUNS_REDUCED_SQL = `
  CREATE TABLE IF NOT EXISTS dropship.dropship_listing_push_runs (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_connection_id integer NOT NULL, status varchar(20) NOT NULL);
  CREATE TABLE IF NOT EXISTS dropship.dropship_listing_push_run_targets (run_id bigint NOT NULL, product_variant_id integer NOT NULL,
    chunk_index integer NOT NULL DEFAULT 0, outcome varchar(20) NOT NULL, PRIMARY KEY (run_id, product_variant_id));`;

dbDescribe.sequential("Dropship eBay listing enrollment, real PostgreSQL (channels PR3)", () => {
  let database: InventoryCutoverTestDatabase;
  let targetId: number;
  let offers: Map<string, StockLinkOfferLookup["offers"]>;
  let lookups: string[];
  const adapter: StockLinkOfferAdapter = {
    destinationKind: "dropship_store_connection", providerKey: "ebay",
    async findOffersBySku(_destination: StockLinkDestination, sku: string) {
      lookups.push(sku);
      return { observedAt: NOW.toISOString(), sku, marketplaceId: "EBAY_US", offers: offers.get(sku) ?? [] };
    },
  };
  const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const tick = () => createStockLinkService({ pool: database.pool, bindings: [{ kind: "listing_enrollment", adapter,
    source: new DropshipEbayStockLinkSource() }], clock: () => NOW, monotonicNow: () => 0, random: () => 0.5, logger: quiet }).tick();
  const checkRow = async (productVariantId: number = F.variantId) => (await database.pool.query(`SELECT status, reason_code,
      error_class FROM inventory.stock_link_checks WHERE publication_target_id=$1 AND product_variant_id=$2`, [targetId, productVariantId])).rows[0];
  const outbox = async () => (await database.pool.query<{ desired_quantity: number }>(`SELECT desired_quantity::int
    FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1 ORDER BY desired_revision`, [targetId])).rows;
  const published = (sku = F.sku, ...offerIds: string[]) => offers.set(sku, (offerIds.length ? offerIds : [OFFER_ID])
    .map(offerId => ({ offerId, sku, status: "PUBLISHED" as const, listingId: EBAY_LISTING_ID })));
  const liveListing = async (overrides: { status?: string; offerId?: string | null; productVariantId?: number; listingId?: number } = {}) =>
    database.pool.query(`INSERT INTO dropship.dropship_vendor_listings(id,vendor_id,store_connection_id,product_variant_id,platform,status,
      external_listing_id,external_offer_id,updated_at) VALUES($1,$2,$3,$4,'ebay',$5,$6,$7,transaction_timestamp())`,
    [overrides.listingId ?? LISTING_ID, F.vendorId, F.storeConnectionId, overrides.productVariantId ?? F.variantId, overrides.status ?? "active",
      EBAY_LISTING_ID, overrides.offerId === undefined ? OFFER_ID : overrides.offerId]);
  const expectNoLink = async () => {
    expect(await countDropshipStockRows(database.pool, targetId)).toMatchObject({ mappings: 0, drafts: 0, outbox: 0, preparations: 0 });
  };

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    await installDropshipEbayStockFixture(database.pool);
    await database.pool.query(PUBLISH_RUNS_REDUCED_SQL);
    await database.pool.query(stockLinksMigrationSql());
    targetId = await createDropshipEbayTarget(database.pool);
    offers = new Map();
    lookups = [];
  }, 60_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; });

  it("links an already-live listing's recorded PUBLISHED offer by SKU, with the writer's key, receipt, audit and quantity", async () => {
    await liveListing();
    published();
    const summary = await tick();
    expect(summary).toMatchObject({ outcome: "completed", destinations: 1, claimed: 1, lookups: 1, links: 1, applies: 1 });
    expect(await checkRow()).toEqual({ status: "linked", reason_code: null, error_class: null });
    expect((await database.pool.query(`SELECT external_inventory_item_id, external_sku FROM inventory.publication_variant_mapping_versions
      WHERE publication_target_id=$1 AND lifecycle_status='sealed'`, [targetId])).rows).toEqual([{ external_inventory_item_id: F.sku, external_sku: F.sku }]);
    expect(await outbox()).toEqual([{ desired_quantity: 17 }]);
    // The command key is dropshipEbayStockCommandKey(store, {kind:"live_listing_enrollment", listingId, evidenceHash}) byte for byte.
    const evidenceHash = enrollmentEvidenceHash({ storeConnectionId: F.storeConnectionId, listingId: LISTING_ID, productVariantId: F.variantId,
      sku: F.sku, offerId: OFFER_ID, ebayListingId: EBAY_LISTING_ID, headRevision: "0" });
    const commandKey = dropshipEbayStockCommandKey(F.storeConnectionId, { kind: "live_listing_enrollment", listingId: LISTING_ID, evidenceHash });
    expect((await database.pool.query("SELECT idempotency_key, actor FROM inventory.publication_mapping_preparations")).rows)
      .toEqual([{ idempotency_key: `dropship-ebay-stock:${commandKey}`, actor: "system:dropship-stock-enrollment" }]);
    expect((await database.pool.query(`SELECT action, actor FROM public.audit_events WHERE action='inventory_availability.dropship_ebay_stock.linked'`)).rows)
      .toEqual([{ action: "inventory_availability.dropship_ebay_stock.linked", actor: "system:dropship-stock-enrollment" }]);

    // The next tick finds nothing due (linked rows are looked at again tomorrow) and writes nothing new.
    const again = await tick();
    expect(again).toMatchObject({ claimed: 0, lookups: 0, links: 0 });
    expect(await countDropshipStockRows(database.pool, targetId)).toMatchObject({ mappings: 1, outbox: 1, preparations: 1 });
  });

  it("waits when the SKU is not on sale or not listed on eBay; nothing is linked", async () => {
    await liveListing();
    offers.set(F.sku, [{ offerId: OFFER_ID, sku: F.sku, status: "UNPUBLISHED", listingId: null }]);
    await tick();
    expect(await checkRow()).toMatchObject({ status: "waiting", reason_code: "STOCK_LINK_NOT_ON_SALE" });
    await expectNoLink();
  });

  it("flags two PUBLISHED offers of one SKU and never picks one", async () => {
    await liveListing();
    published(F.sku, OFFER_ID, "5002");
    await tick();
    expect(await checkRow()).toMatchObject({ status: "flagged", reason_code: "STOCK_LINK_SKU_DUPLICATE" });
    await expectNoLink();
  });

  it("skips a listing with an open push job: no eBay lookup, no link", async () => {
    await liveListing();
    published();
    await database.pool.query(`INSERT INTO dropship.dropship_listing_push_jobs(id,vendor_id,store_connection_id,job_type,status)
      VALUES(1,$1,$2,'push','queued')`, [F.vendorId, F.storeConnectionId]);
    await database.pool.query(`INSERT INTO dropship.dropship_listing_push_job_items(id,job_id,listing_id,product_variant_id,action,status,result)
      VALUES(1,1,$1,$2,'push','queued','{}'::jsonb)`, [LISTING_ID, F.variantId]);
    await tick();
    expect(lookups).toEqual([]);
    expect(await checkRow()).toMatchObject({ status: "waiting", reason_code: "STOCK_LINK_LISTING_BUSY" });
    await expectNoLink();
  });

  it("skips a listing in a processing publish run whose chunk is not expanded yet", async () => {
    await liveListing();
    published();
    const run = (await database.pool.query<{ id: string }>(`INSERT INTO dropship.dropship_listing_push_runs(store_connection_id,status)
      VALUES($1,'processing') RETURNING id::text`, [F.storeConnectionId])).rows[0]!;
    await database.pool.query(`INSERT INTO dropship.dropship_listing_push_run_targets(run_id,product_variant_id,chunk_index,outcome)
      VALUES($1,$2,1,'pending')`, [run.id, F.variantId]);
    await tick();
    expect(lookups).toEqual([]);
    expect(await checkRow()).toMatchObject({ status: "waiting", reason_code: "STOCK_LINK_LISTING_BUSY" });
    await expectNoLink();
    // Once the run finished with the size, the listing links on its next check.
    await database.pool.query("UPDATE dropship.dropship_listing_push_runs SET status='completed'");
    await database.pool.query("UPDATE inventory.stock_link_checks SET next_check_at=$1", [NOW]);
    await tick();
    expect(await checkRow()).toMatchObject({ status: "linked" });
  });

  it("skips a listing with an open end request (failed waits for staff and stays open)", async () => {
    await liveListing();
    published();
    await database.pool.query("INSERT INTO dropship.dropship_listing_end_requests(listing_id,state) VALUES($1,'failed')", [LISTING_ID]);
    await tick();
    expect(lookups).toEqual([]);
    expect(await checkRow()).toMatchObject({ status: "waiting", reason_code: "STOCK_LINK_LISTING_ENDING" });
    await expectNoLink();
  });

  it("does not look after an ended listing or one whose push never recorded an offer", async () => {
    await liveListing({ status: "ended" });
    await liveListing({ productVariantId: 102, listingId: 71, offerId: null });
    published();
    await tick();
    expect(lookups).toEqual([]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.stock_link_checks")).rows[0].n).toBe(0);
    await expectNoLink();
  });

  it("never newly links a listing of a store that left managed live mode (its zero would overwrite the vendor's quantity)", async () => {
    await liveListing();
    published();
    await database.pool.query("UPDATE dropship.dropship_store_listing_configs SET inventory_mode='manual_quantity' WHERE store_connection_id=$1",
      [F.storeConnectionId]);
    // A row the sweep made while the store was managed is claimed after it left (the sweep is past it this tick):
    // the source reads the listing as not managed, so the row is removed and nothing is looked up or linked.
    await database.pool.query(`INSERT INTO inventory.stock_link_destinations(publication_target_id,sweep_cursor_variant_id,created_at,updated_at)
      VALUES($1,$2,$3,$3)`, [targetId, F.variantId, NOW]);
    await database.pool.query(`INSERT INTO inventory.stock_link_checks(publication_target_id,product_variant_id,status,next_check_at,created_at,updated_at)
      VALUES($1,$2,'waiting',$3,$3,$3)`, [targetId, F.variantId, NOW]);
    await tick();
    expect(lookups).toEqual([]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.stock_link_checks")).rows[0].n).toBe(0);
    await expectNoLink();
  });

  it("links a removed size (vendor un-picked it, the listing is still live) at quantity 0", async () => {
    await liveListing();
    published();
    await database.pool.query("DELETE FROM dropship.dropship_vendor_selected_variants WHERE vendor_id=$1 AND product_variant_id=$2",
      [F.vendorId, F.variantId]);
    await tick();
    expect(await checkRow()).toMatchObject({ status: "linked" });
    expect(await outbox()).toEqual([{ desired_quantity: 0 }]);
  });

  it("keeps an already-linked size without reading eBay or calling the writer", async () => {
    await liveListing();
    published();
    await sealDropshipMapping(database.pool, targetId, F.variantId, F.sku);
    await tick();
    expect(lookups).toEqual([]);
    expect(await checkRow()).toMatchObject({ status: "linked" });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.publication_mapping_preparations")).rows[0].n).toBe(0);
  });
});
