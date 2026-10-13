import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { config } from "dotenv";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveListingPriceInput } from "../../../../../shared/dropship/listing-price";
import type { ProductListingSettingPatch } from "../../../../../shared/dropship/listing-setting-values";
import { MAX_EBAY_CATEGORY_NAME_LENGTH, MAX_EBAY_CATEGORY_PATH_DEPTH } from "../../../../../shared/dropship/ebay-category-rules";
import {
  MAX_LISTING_POLICY_ID_LENGTH,
  MAX_LISTING_POLICY_NAME_LENGTH,
  MAX_LISTING_SETTING_BULK_PRODUCTS,
  MAX_LISTING_SHELF_ID_LENGTH,
  MAX_LISTING_SHELF_NAME_LENGTH,
  MAX_LISTING_STORE_SHELVES,
} from "../../../../../shared/dropship/listing-setting-values";
import { MAX_BULK_TEXT_BYTES, MAX_STORE_LISTING_TEXT_BYTES } from "../../../../../shared/dropship/listing-setting-writes";
import { saveListingPriceInTransaction } from "../../application/dropship-listing-price-service";
import { DropshipListingSizePricesService } from "../../application/dropship-listing-size-prices-service";
import { DropshipListingProductSettingsService } from "../../application/dropship-listing-product-settings-service";
import { DropshipListingProductsBulkService } from "../../application/dropship-listing-products-bulk-service";
import { DropshipListingCategorySettingsService } from "../../application/dropship-listing-category-settings-service";
import { ListingSettingHeavyWriteGate } from "../../application/dropship-listing-setting-write-support";
import type { ListingSettingEbayPort } from "../../application/dropship-listing-setting-ebay-values";
import type { DropshipEbayListingSetupDiscovery } from "../../application/dropship-ebay-listing-setup-service";
import { DropshipPricingRulesService } from "../../application/dropship-pricing-rules-service";
import { DropshipError } from "../../domain/errors";
import { listingSettingChildKey, listingSettingRequestHash } from "../../domain/listing-setting-values";
import { PgDropshipListingPriceRepository } from "../../infrastructure/dropship-listing-price.repository";
import { PgDropshipListingContentRepository } from "../../infrastructure/dropship-listing-content.repository";
import { PgDropshipEbayListingPolicyOverrideRepository } from "../../infrastructure/dropship-ebay-listing-policy-override.repository";
import {
  PgDropshipListingSettingWritesRepository,
  mapListingSettingWriteError,
} from "../../infrastructure/dropship-listing-setting-writes.repository";
import { PgDropshipPricingRulesRepository } from "../../infrastructure/dropship-pricing-rules.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;
const NOW = new Date("2026-10-12T09:00:00.000Z");

/**
 * Every object the writers, the W9 flow, W1 and the fixture name. Each maps
 * into one isolated schema, and any other name fails the test, so a writer
 * that reaches a new table is seen here first. The stubs and the real
 * migrations are the listing-settings suite's (it runs the real candidate,
 * store context and .ops cost reads) plus the 8a suite's migration list.
 */
const OBJECTS: ReadonlySet<string> = new Set([
  "dropship.dropship_vendors", "dropship.dropship_store_connections", "dropship.dropship_store_listing_configs",
  "dropship.dropship_catalog_rules", "dropship.dropship_vendor_selection_rules", "dropship.dropship_vendor_variant_overrides",
  "dropship.dropship_pricing_policies", "dropship.dropship_vendor_listings", "dropship.dropship_cost_change_listing_holds",
  "dropship.dropship_audit_events",
  "dropship.dropship_listing_price_revisions", "dropship.dropship_listing_price_settings",
  "dropship.dropship_pricing_profile_revisions", "dropship.dropship_pricing_profiles",
  "dropship.dropship_pricing_reviews", "dropship.dropship_pricing_applications",
  "dropship.dropship_content_profile_revisions", "dropship.dropship_content_profiles",
  "dropship.dropship_listing_content_revisions", "dropship.dropship_listing_content_settings",
  "dropship.dropship_ebay_category_rule_revisions", "dropship.dropship_ebay_category_rule_profiles",
  "dropship.dropship_ebay_store_category_assignment_revisions", "dropship.dropship_ebay_store_category_assignments",
  "dropship.dropship_ebay_listing_policy_override_revisions", "dropship.dropship_ebay_listing_policy_overrides",
  "dropship.dropship_product_listing_setting_requests", "dropship.dropship_product_listing_setting_revisions",
  "dropship.dropship_product_listing_settings",
  "dropship.dropship_category_listing_setting_revisions", "dropship.dropship_category_listing_settings",
  "dropship.dropship_product_category_seen",
  "dropship.guard_listing_price_revision_immutable", "dropship.guard_listing_price_setting_coherence",
  "dropship.guard_pricing_profile_coherence", "dropship.guard_content_revision_immutable",
  "dropship.guard_content_profile_coherence", "dropship.guard_listing_content_coherence",
  "dropship.guard_ebay_category_rule_revision_immutable", "dropship.guard_ebay_category_rule_profile_coherence",
  "dropship.guard_product_listing_setting_revision_immutable", "dropship.guard_product_listing_setting_coherence",
  "dropship.guard_product_listing_setting_request_append_only",
  "dropship.guard_category_listing_setting_revision_immutable", "dropship.guard_category_listing_setting_coherence",
  "dropship.guard_product_category_seen",
  "catalog.products", "catalog.product_variants", "catalog.product_categories", "catalog.product_line_products", "catalog.product_assets",
  "ebay.ebay_category_mappings", "channels.channels", "public.shopify_variants", "public.app_settings",
  "membership.plans", "membership.member_subscriptions", "membership.plan_channel_access",
  "membership.plan_variant_overrides", "membership.plan_collection_exclusions", "membership.product_collections",
  "membership.plan_benefits", "membership.plan_benefit_assignments", "membership.plan_benefit_channel_policies",
]);

/** The migrations the writers run on: prices, pricing reviews, content, eBay category rules, inherit mode, the per-size panels, 8a. */
const REAL_MIGRATIONS = [
  "0657_dropship_listing_price_settings.sql", "0659_dropship_store_pricing_rules.sql",
  "0660_dropship_vendor_listing_content.sql", "0717_dropship_ebay_category_rules.sql",
  "0735_dropship_listing_price_inherit_mode.sql",
  // The probe reads the per-size policy and shelf revision tables (plan PR 9, 3.11).
  "215_dropship_ebay_product_category_scope.sql", "217_dropship_ebay_listing_policy_overrides.sql",
  "0738_dropship_product_listing_settings.sql", "0739_dropship_category_listing_settings.sql",
  "0740_dropship_pricing_review_kind.sql",
];

const MEMBER = "member-1";
const VENDOR = 10;
const STORE = 22;
const OTHER_VENDOR_STORE = 23; // vendor 11
const TOPLOADERS = 3;
/** The product the fixture's four sizes belong to. */
const PRODUCT_7 = 7;
/** Product 7's sizes, each with a retail price and an .ops cost. */
const SIZES = [101, 102, 103, 104] as const;
const BULK_FIRST_PRODUCT = 1_001;
const BULK_FIRST_SIZE = 100_000;
const SIZES_PER_BULK_PRODUCT = 10;
/** The heavy cases measure, never assert, their time; this only keeps a slow runner from failing them. */
const BULK_TEST_TIMEOUT_MS = 240_000;
const HEAP_SAMPLE_INTERVAL_MS = 20;
/**
 * The replay probe's load case (plan P16, "timed in 9a"): one vendor's price
 * revisions under other keys. Each prefix branch filters
 * left(idempotency_key, n) = prefix, which no index serves, so it reads every
 * revision the vendor has; W1 apply alone adds up to 10,000 per apply.
 */
const PROBE_LOAD_REVISIONS = 300_000;
/** The first run reads cold pages; the later ones show the steady cost. */
const PROBE_TIMED_RUNS = 3;
/** Upper bound on every wait in the concurrency case: a wait that never ends fails here instead of hanging the suite. */
const WAIT_LIMIT_MS = 5_000;
const POLL_INTERVAL_MS = 10;
/** The store default every case starts from (D1) and the one W1 reviews (D2). */
const D1 = { defaultRecipe: { basis: "product_cost", markupBps: 3_000, flatCents: 100, rounding: "cent" }, groups: [] } as const;
const D2 = { defaultRecipe: { basis: "product_cost", markupBps: 5_000, flatCents: 100, rounding: "cent" }, groups: [] } as const;

type Row = Record<string, unknown>;
interface StatementCounter { statements: number }
/** One measured run, as logged (plan 3.11, 7.12 PG 1-2): heap growth peaks over the run's start, in MiB. */
interface Measurement {
  measurement: string; flows: number; elapsedMs: number; statements: number;
  heapUsedPeakDeltaMiB: number; externalPeakDeltaMiB: number; arrayBuffersPeakDeltaMiB: number;
}

/** eBay values a seeded row carries (the stored contract's shapes, shared/dropship/listing-setting-values.ts). */
type EbayRowValues = {
  category: { categoryId: string; categoryName: string; path: readonly string[] };
  shelves: ReadonlyArray<{ id: string; name: string }>;
  shipping: { id: string; name: string }; returns: { id: string; name: string }; payment: { id: string; name: string };
};
/**
 * Names of the length a real store's are (HYPOTHESIS: no production sample was read). W6's combined edge and W12's
 * PG 8 seed rows with them, so the two heavy writers are measured over the same rows.
 */
const EBAY_TYPICAL: EbayRowValues = {
  category: { categoryId: "183454", categoryName: "Toploaders", path: ["Collectibles", "Trading Cards", "Card Sleeves & Toploaders", "Toploaders"] },
  shelves: [{ id: "11", name: "Supplies:Top" }],
  shipping: { id: "ship-a", name: "Ships in one day" }, returns: { id: "return-a", name: "Thirty days" },
  payment: { id: "pay-a", name: "eBay managed payments" },
};

/** The UTF-8 bytes of a row's eBay values: what a heavy write copies besides the texts, and the text budget does not count. */
const ebayValueBytes = (ebay: EbayRowValues) => Buffer.byteLength([ebay.category.categoryId, ebay.category.categoryName,
  ...ebay.category.path, ...ebay.shelves.flatMap((shelf) => [shelf.id, shelf.name]),
  ...[ebay.shipping, ebay.returns, ebay.payment].flatMap((policy) => [policy.id, policy.name])].join(""), "utf8");

/**
 * Opt-in heap diagnostics (`DROPSHIP_W6_HEAP_DIAGNOSTICS=1`), off in CI: the
 * forced collections below, W6's live-heap runs (the inputs of plan 3.10's
 * rule, which judges the live heap and needs the forced collections) and
 * W6's diagnostic runs. They add over half a minute of 10,000-product runs
 * that assert nothing about the heap, and setting a V8 flag after start is
 * documented as unpredictable, which a one-off measurement accepts and a
 * permanent suite need not. 9d's measurements of the rule were taken with
 * them on; in CI the stop-rule line logs the allocated figures only.
 */
const HEAP_DIAGNOSTICS = process.env.DROPSHIP_W6_HEAP_DIAGNOSTICS === "1";

/**
 * With the diagnostics on, a full collection before each measurement, so its
 * baseline is the live heap and not an earlier case's garbage. The runner
 * starts Node without --expose-gc; V8 exposes `gc` to a new context once the
 * flag is set. Off, or when that fails, there is no collection and the
 * numbers stay indicative, as they always are: nothing asserts them.
 */
const collectGarbage: (() => void) | null = HEAP_DIAGNOSTICS ? (() => {
  try {
    setFlagsFromString("--expose-gc");
    const gc: unknown = runInNewContext("gc");
    return typeof gc === "function" ? (gc as () => void) : null;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ measurement: "gc_unavailable", error: String(error) })}\n`);
    return null;
  }
})() : null;

describeDatabase.sequential("listing-settings writes on PostgreSQL (plan PR 9)", () => {
  const schema = `dropship_listing_setting_write_routes_${process.pid}`;
  let pool: pg.Pool;
  let created = false;
  const qualify = (sql: string) => sql.replace(/\b(dropship|membership|catalog|channels|public|ebay)\.([a-z_]+)\b/g, (name, _namespace, object) => {
    if (!OBJECTS.has(name)) throw new Error(`Unexpected database object: ${name}`);
    return `"${schema}"."${object}"`;
  });
  const execute = (sql: string, values?: unknown[]) => pool.query(qualify(sql), values);

  /**
   * The repositories' own SQL against the isolated schema; `counter` counts
   * every statement a pooled client runs (plan 3.11). `hook` runs before each
   * statement, so a concurrency case can pause a transaction at a chosen one
   * (gate) or record what each connection ran.
   */
  function scopedPool(counter?: StatementCounter, hook?: (sql: string, connection: number) => Promise<void> | void): Pool {
    let connections = 0;
    return {
      query: (sql: string, values?: unknown[]) => pool.query(qualify(sql), values),
      connect: async () => {
        const client = await pool.connect();
        const connection = connections++;
        return {
          query: async (sql: string, values?: unknown[]) => {
            if (counter) counter.statements += 1;
            if (hook) await hook(sql, connection);
            return client.query(qualify(sql), values);
          },
          release: (destroy?: boolean | Error) => client.release(destroy),
        };
      },
    } as unknown as Pool;
  }

  /** Pauses the first statement `match` accepts until `open()`; `reached` resolves when it is paused. */
  function gate(match: (sql: string) => boolean) {
    let reachedGate!: () => void;
    const reached = new Promise<void>((done) => { reachedGate = done; });
    let openGate!: () => void;
    const opened = new Promise<void>((done) => { openGate = done; });
    let fired = false;
    return {
      reached,
      open: () => openGate(),
      hook: async (sql: string) => {
        if (fired || !match(sql)) return;
        fired = true;
        reachedGate();
        await opened;
      },
    };
  }

  const log = { info: vi.fn() };
  const sizePrices = (counter?: StatementCounter) => new DropshipListingSizePricesService({
    repository: new PgDropshipListingSettingWritesRepository(scopedPool(counter)), clock: { now: () => NOW },
    timer: () => performance.now(), log });
  const pricingRules = () => new DropshipPricingRulesService({ repository: new PgDropshipPricingRulesRepository(scopedPool()),
    clock: { now: () => NOW }, newId: () => randomUUID(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  const key = (label: string) => `size-prices:${label}`;

  /** eBay as W5's eBay step sees it: one policy of each kind and two shelves, recorded. */
  const ebayCalls: string[] = [];
  const EBAY_DISCOVERY: DropshipEbayListingSetupDiscovery = { marketplaceId: "EBAY_US", merchantLocations: [], fulfillmentPolicies: [],
    returnPolicies: [{ id: "return-new", name: "Thirty days" }], paymentPolicies: [] };
  const fakeEbay: ListingSettingEbayPort = {
    describeCategories: async () => { ebayCalls.push("describe"); return new Map(); },
    discoverPolicies: async () => { ebayCalls.push("discover"); return EBAY_DISCOVERY; },
    loadFulfillmentCapability: async () => { ebayCalls.push("capability"); throw new Error("not used"); },
    listStoreShelves: async () => { ebayCalls.push("shelves"); return [{ categoryId: "11", categoryName: "Top", path: "Supplies:Top", level: 2 }]; },
  };
  const products = (repositoryPool: Pool = scopedPool()) => new DropshipListingProductSettingsService({
    repository: new PgDropshipListingSettingWritesRepository(repositoryPool), ebay: fakeEbay, clock: { now: () => NOW },
    timer: () => performance.now(), log });
  const productKey = (label: string) => `product-settings:${label}`;
  /** The store default's price of 101-104 after D1 (cost x 1.3 + $1.00), as the server answers them. */
  async function shownPrices(productId: number, body: Record<string, unknown>): Promise<Array<{ productVariantId: number; priceCents: number | null }>> {
    // A request that can only be refused as moved, naming every chosen size with the price the server computes; it writes nothing.
    const probe = await expectDropshipError(products().saveForMember(MEMBER, STORE, productId, { ...body,
      idempotencyKey: productKey(`shown-${randomUUID()}`), expectedPrices: [{ productVariantId: 2_000_000_000, priceCents: null }] }),
    "DROPSHIP_LISTING_PRICES_MOVED");
    return (probe.context?.sizes as Array<{ productVariantId: number; priceCents?: number | null }>)
      .filter((size) => size.productVariantId !== 2_000_000_000)
      .map((size) => ({ productVariantId: size.productVariantId, priceCents: size.priceCents ?? null }));
  }
  async function allWrites() {
    return {
      productRevisions: await count("dropship.dropship_product_listing_setting_revisions"),
      priceRevisions: await count("dropship.dropship_listing_price_revisions"),
      policyRevisions: await count("dropship.dropship_ebay_listing_policy_override_revisions"),
      shelfRevisions: await count("dropship.dropship_ebay_store_category_assignment_revisions"),
      contentRevisions: await count("dropship.dropship_listing_content_revisions"),
      audit: await count("dropship.dropship_audit_events"),
    };
  }

  /** One product with `total` sellable sizes, each with a retail price and an .ops cost, all chosen by vendor 10's catalog rule. */
  async function seedProductSizes(productId: number, firstSize: number, total: number): Promise<number[]> {
    await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type, shopify_product_id)
      VALUES ($1::int, 'BIG-' || $1::text, 'Big product', 'Toploaders', $2, 'toploader', (9100000000 + $1::int)::text)`, [productId, TOPLOADERS]);
    await execute(`INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, weight_grams, sales_eligibility)
      SELECT $1::int + i, $3::int, 'BIG-SIZE-' || i, 'Size ' || i, (7200000000 + i)::text, 100, 'sellable'
      FROM generate_series(0, $2::int - 1) i`, [firstSize, total, productId]);
    await execute(`INSERT INTO public.shopify_variants (id, product_id, sku, price)
      SELECT (7200000000 + i)::text, (9100000000 + $2::int)::text, 'BIG-SIZE-' || i, 9.99 FROM generate_series(0, $1::int - 1) i`, [total, productId]);
    await execute(`INSERT INTO membership.plan_variant_overrides
      SELECT 'ops-big-' || i, 'ops', (7200000000 + i)::text, (9100000000 + $2::int)::text, 'fixed_price', 6.00, NULL, true
      FROM generate_series(0, $1::int - 1) i`, [total, productId]);
    return Array.from({ length: total }, (_, index) => firstSize + index);
  }

  /** Per-size leftovers as today's per-size panels leave them, for one vendor's store (revision and current row each). */
  async function seedPolicyOverride(input: { vendorId?: number; storeId?: number; sizeId: number; fulfillment: string | null;
    returnPolicy?: string | null; label: string }): Promise<void> {
    const vendorId = input.vendorId ?? VENDOR;
    const storeId = input.storeId ?? STORE;
    const revision = await execute(`INSERT INTO dropship.dropship_ebay_listing_policy_override_revisions
      (vendor_id, store_connection_id, product_variant_id, idempotency_key, request_hash, fulfillment_policy_id, return_policy_id,
       actor_type, actor_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'vendor', 'seed', $8) RETURNING id`,
    [vendorId, storeId, input.sizeId, `seed-policy:${input.label}`, "d".repeat(64), input.fulfillment, input.returnPolicy ?? null, NOW]);
    await execute(`INSERT INTO dropship.dropship_ebay_listing_policy_overrides
      (vendor_id, store_connection_id, product_variant_id, revision_id, fulfillment_policy_id, return_policy_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [vendorId, storeId, input.sizeId, revision.rows[0].id, input.fulfillment, input.returnPolicy ?? null, NOW]);
  }
  async function seedShelf(input: { vendorId?: number; storeId?: number; sizeId: number; label: string }): Promise<void> {
    const vendorId = input.vendorId ?? VENDOR;
    const storeId = input.storeId ?? STORE;
    const revision = await execute(`INSERT INTO dropship.dropship_ebay_store_category_assignment_revisions
      (vendor_id, store_connection_id, product_variant_id, idempotency_key, request_hash, store_category_ids, store_category_names,
       actor_type, actor_id, created_at) VALUES ($1, $2, $3, $4, $5, '["11"]'::jsonb, '["Supplies:Top"]'::jsonb, 'vendor', 'seed', $6)
      RETURNING id`, [vendorId, storeId, input.sizeId, `seed-shelf:${input.label}`, "d".repeat(64), NOW]);
    await execute(`INSERT INTO dropship.dropship_ebay_store_category_assignments
      (vendor_id, store_connection_id, product_variant_id, revision_id, store_category_ids, store_category_names, created_at, updated_at)
      VALUES ($1, $2, $3, $4, '["11"]'::jsonb, '["Supplies:Top"]'::jsonb, $5, $5)`, [vendorId, storeId, input.sizeId, revision.rows[0].id, NOW]);
  }
  async function seedContent(input: { vendorId?: number; storeId?: number; sizeId: number; text: string | null; label: string }): Promise<number> {
    const vendorId = input.vendorId ?? VENDOR;
    const storeId = input.storeId ?? STORE;
    const revision = await execute(`INSERT INTO dropship.dropship_listing_content_revisions
      (vendor_id, store_connection_id, product_variant_id, previous_revision_id, custom_text, catalog_hash, idempotency_key, request_hash,
       actor_id, created_at) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, 'seed', $8) RETURNING id`,
    [vendorId, storeId, input.sizeId, input.text, "c".repeat(64), `seed-content:${input.label}`, "d".repeat(64), NOW]);
    await execute(`INSERT INTO dropship.dropship_listing_content_settings (vendor_id, store_connection_id, product_variant_id, revision_id)
      VALUES ($1, $2, $3, $4)`, [vendorId, storeId, input.sizeId, revision.rows[0].id]);
    return revision.rows[0].id as number;
  }
  async function addVendorStore(storeId: number, vendorId = VENDOR): Promise<void> {
    await execute(`INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, access_token_ref, refresh_token_ref, status, setup_status)
      VALUES ($1, $2, 'ebay', 'vault:a', 'vault:r', 'connected', 'ready')`, [storeId, vendorId]);
  }
  const row = (productVariantId: number, priceCents = 1_499, expectedRevisionId: number | null = null) =>
    ({ productVariantId, priceCents, expectedRevisionId });
  const requestHashOf = (rows: ReturnType<typeof row>[]) => listingSettingRequestHash({ operation: "size_prices_v1", storeConnectionId: STORE,
    rows: [...rows].sort((left, right) => left.productVariantId - right.productVariantId) });

  async function count(table: string, where = "true", values: unknown[] = []): Promise<number> {
    const result = await execute(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values);
    return (result.rows[0] as { n: number }).n;
  }
  async function writeCounts() {
    return {
      revisions: await count("dropship.dropship_listing_price_revisions"),
      settings: await count("dropship.dropship_listing_price_settings"),
      audit: await count("dropship.dropship_audit_events"),
    };
  }
  async function expectDropshipError(promise: Promise<unknown>, code: string): Promise<DropshipError> {
    const error = await promise.then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(DropshipError);
    expect((error as DropshipError).code).toBe(code);
    return error as DropshipError;
  }

  /** `total` sellable sizes, ten to a product, each with a retail price and an .ops cost, all chosen by vendor 10's catalog rule. */
  async function seedBulkSizes(total: number): Promise<{ productIds: number[]; sizeIds: number[] }> {
    const products = Math.ceil(total / SIZES_PER_BULK_PRODUCT);
    await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type, shopify_product_id)
      SELECT g, 'BULK-' || g, 'Bulk product ' || g, 'Toploaders', $3, 'toploader', (9000000000 + g)::text
      FROM generate_series($1::int, $2::int) g`, [BULK_FIRST_PRODUCT, BULK_FIRST_PRODUCT + products - 1, TOPLOADERS]);
    await execute(`INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, weight_grams, sales_eligibility)
      SELECT $1 + i, $3 + i / $4, 'BULK-SIZE-' || i, 'Size ' || i, (7100000000 + i)::text, 100, 'sellable'
      FROM generate_series(0, $2 - 1) i`, [BULK_FIRST_SIZE, total, BULK_FIRST_PRODUCT, SIZES_PER_BULK_PRODUCT]);
    await execute(`INSERT INTO public.shopify_variants (id, product_id, sku, price)
      SELECT (7100000000 + i)::text, (9000000000 + $2 + i / $3)::text, 'BULK-SIZE-' || i, 9.99 FROM generate_series(0, $1 - 1) i`,
    [total, BULK_FIRST_PRODUCT, SIZES_PER_BULK_PRODUCT]);
    await execute(`INSERT INTO membership.plan_variant_overrides
      SELECT 'ops-bulk-' || i, 'ops', (7100000000 + i)::text, (9000000000 + $2 + i / $3)::text, 'fixed_price', 6.00, NULL, true
      FROM generate_series(0, $1 - 1) i`, [total, BULK_FIRST_PRODUCT, SIZES_PER_BULK_PRODUCT]);
    return {
      productIds: Array.from({ length: products }, (_, index) => BULK_FIRST_PRODUCT + index),
      sizeIds: Array.from({ length: total }, (_, index) => BULK_FIRST_SIZE + index),
    };
  }

  /** Every measurement of this run, in order, for the heavy-write stop rule (plan 3.10). */
  const measurements: Measurement[] = [];

  /**
   * Elapsed time, statements and the growth of heapUsed, external and
   * arrayBuffers of `work` (each sampled every 20 ms, peak over the start),
   * written to stdout for the PR body (plan 4.4, 3.11); nothing asserts them.
   */
  async function measure<T>(label: string, flows: number, counter: StatementCounter, work: () => Promise<T>,
    extra: Record<string, unknown> = {}): Promise<T> {
    collectGarbage?.();
    const start = process.memoryUsage();
    const peak = { heapUsed: start.heapUsed, external: start.external, arrayBuffers: start.arrayBuffers };
    const sample = () => {
      const now = process.memoryUsage();
      peak.heapUsed = Math.max(peak.heapUsed, now.heapUsed);
      peak.external = Math.max(peak.external, now.external);
      peak.arrayBuffers = Math.max(peak.arrayBuffers, now.arrayBuffers);
      return now;
    };
    const sampler = setInterval(sample, HEAP_SAMPLE_INTERVAL_MS);
    const before = counter.statements;
    const started = process.hrtime.bigint();
    try {
      return await work();
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      clearInterval(sampler);
      const end = sample();
      const statements = counter.statements - before;
      const mib = (bytes: number) => Number((bytes / 1_048_576).toFixed(1));
      const record: Measurement = {
        measurement: label, flows, elapsedMs: Math.round(elapsedMs), statements,
        heapUsedPeakDeltaMiB: mib(peak.heapUsed - start.heapUsed),
        externalPeakDeltaMiB: mib(peak.external - start.external),
        arrayBuffersPeakDeltaMiB: mib(peak.arrayBuffers - start.arrayBuffers),
      };
      measurements.push(record);
      process.stdout.write(`${JSON.stringify({
        ...record, ...extra,
        statementsPerFlow: Number((statements / flows).toFixed(1)), elapsedMsPerFlow: Number((elapsedMs / flows).toFixed(2)),
        heapUsedDeltaMiB: mib(end.heapUsed - start.heapUsed), gcBeforeRun: collectGarbage !== null,
      })}\n`);
    }
  }

  /**
   * The heaviest point's live heap (the rule's input, plan 3.10): a full collection right before each revision
   * insert and before COMMIT, when the stored rows, the merged records and one statement's JSON are all held, so
   * what is left is what the write keeps, not garbage V8 has not collected yet. The forced collections change the
   * run's own allocation peak, so this runs apart from the allocated measurement. Shared by W6 and W12's clear.
   */
  function liveHeapProbe(): { hook: (sql: string) => void; peakBytes: () => number | null } {
    let peak: number | null = null;
    return {
      hook: (sql) => {
        if (!collectGarbage || !(sql === "COMMIT" || sql.startsWith("INSERT INTO dropship.dropship_product_listing_setting_revisions"))) return;
        collectGarbage();
        peak = Math.max(peak ?? 0, process.memoryUsage().heapUsed);
      },
      peakBytes: () => peak,
    };
  }

  /** A typed price for one size through W9's own service (the step 2 box), as a vendor sets one today. */
  async function typePrice(productVariantId: number, priceCents: number, label: string): Promise<number> {
    const repository = new PgDropshipListingPriceRepository(scopedPool());
    const input: SaveListingPriceInput = { priceCents, pricingMode: "fixed", expectedRevisionId: null, idempotencyKey: label };
    const result = await repository.execute({ memberId: MEMBER, storeConnectionId: STORE, productVariantId, idempotencyKey: label },
      (tx) => saveListingPriceInTransaction(tx, { storeConnectionId: STORE, productVariantId }, input, "f".repeat(64), NOW));
    return result.price.revisionId!;
  }

  /** A store default revision and the current pointer, as W1's apply writes them. */
  async function setStoreDefault(profile: unknown): Promise<number> {
    const current = await execute("SELECT revision_id FROM dropship.dropship_pricing_profiles WHERE store_connection_id = $1", [STORE]);
    const revision = await execute(`INSERT INTO dropship.dropship_pricing_profile_revisions
      (vendor_id, store_connection_id, previous_revision_id, profile, actor_id, created_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id`,
    [VENDOR, STORE, current.rows[0]?.revision_id ?? null, JSON.stringify(profile), MEMBER, NOW]);
    await execute(`INSERT INTO dropship.dropship_pricing_profiles (vendor_id, store_connection_id, revision_id) VALUES ($1, $2, $3)
      ON CONFLICT (store_connection_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`, [VENDOR, STORE, revision.rows[0].id]);
    return revision.rows[0].id as number;
  }

  /** Resolves or rejects with `promise`, or rejects once WAIT_LIMIT_MS passes (dropship-listing-config-revision.integration.test.ts). */
  async function within<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} did not finish within ${WAIT_LIMIT_MS} ms`)), WAIT_LIMIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Polls until `waiting` backends of this database wait on a lock while running SQL that contains `fragment`. */
  async function waitUntilLockWait(fragment: string, waiting: number): Promise<void> {
    const deadline = Date.now() + WAIT_LIMIT_MS;
    for (;;) {
      const result = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND position($1 in query) > 0`, [fragment]);
      if (result.rows[0].n >= waiting) return;
      if (Date.now() > deadline) throw new Error(`Expected ${waiting} backend(s) waiting on a lock in "${fragment}"; saw ${result.rows[0].n}`);
      await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS));
    }
  }

  beforeAll(async () => {
    if (!testUrl || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(testUrl)) {
      throw new Error("Listing setting write tests require a distinct, explicitly disposable PostgreSQL database.");
    }
    if (!/^dropship_listing_setting_write_routes_\d+$/.test(schema)) throw new Error("Invalid isolated schema.");
    pool = new pg.Pool({ connectionString: testUrl, max: 6, connectionTimeoutMillis: 5000,
      ssl: /localhost|127\.0\.0\.1/.test(testUrl) ? false : { rejectUnauthorized: true } });
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
    // The columns the reads and writers use, with the owning migrations' types
    // (as the listing-settings suite has them); the settings tables come from
    // their real migrations below, triggers included.
    await execute(`
      CREATE TABLE dropship.dropship_vendors (id integer PRIMARY KEY, member_id varchar(255) NOT NULL,
        current_subscription_id varchar(255), current_plan_id varchar(255), status varchar(30) NOT NULL,
        entitlement_status varchar(30) NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE dropship.dropship_store_connections (id integer PRIMARY KEY,
        vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id), platform varchar(30) NOT NULL,
        access_token_ref text, refresh_token_ref text, status varchar(30) NOT NULL, setup_status varchar(30) NOT NULL,
        last_sync_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE dropship.dropship_store_listing_configs (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        store_connection_id integer NOT NULL UNIQUE REFERENCES dropship.dropship_store_connections(id),
        platform varchar(30) NOT NULL, listing_mode varchar(40) NOT NULL,
        inventory_mode varchar(40) NOT NULL DEFAULT 'managed_quantity_sync', price_mode varchar(40) NOT NULL DEFAULT 'vendor_defined',
        marketplace_config jsonb NOT NULL DEFAULT '{}'::jsonb, required_config_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
        required_product_fields jsonb NOT NULL DEFAULT '[]'::jsonb, is_active boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE catalog.product_categories (id integer PRIMARY KEY, name varchar(100) NOT NULL);
      CREATE TABLE catalog.products (id integer PRIMARY KEY, sku varchar(100), name text NOT NULL, title text,
        description text, category varchar(100), category_id integer REFERENCES catalog.product_categories(id) ON DELETE SET NULL,
        ebay_browse_category_id varchar(50), ebay_browse_category_name text,
        brand text, condition text, item_specifics jsonb, is_active boolean NOT NULL DEFAULT true,
        product_type varchar(100), shopify_product_id varchar(100),
        inventory_tracking_default boolean NOT NULL DEFAULT true);
      CREATE TABLE catalog.product_variants (id integer PRIMARY KEY, product_id integer NOT NULL REFERENCES catalog.products(id),
        sku varchar(100), name text NOT NULL, gtin text, mpn text, weight_grams numeric(10,2),
        is_active boolean NOT NULL DEFAULT true, units_per_variant integer NOT NULL DEFAULT 1,
        uom_type varchar(30) NOT NULL DEFAULT 'pack', price_cents integer, shopify_variant_id varchar(100),
        requires_shipping boolean NOT NULL DEFAULT true, track_inventory boolean DEFAULT true,
        sales_eligibility varchar(30) NOT NULL DEFAULT 'sellable', inventory_tracking_override boolean);
      CREATE TABLE catalog.product_line_products (product_id integer NOT NULL, product_line_id integer NOT NULL);
      CREATE TABLE catalog.product_assets (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, product_id integer NOT NULL,
        product_variant_id integer, asset_type varchar(30) NOT NULL, url text, is_primary boolean NOT NULL DEFAULT false,
        position integer NOT NULL DEFAULT 0);
      CREATE TABLE channels.channels (id integer PRIMARY KEY, name text, provider text, type text, status text);
      CREATE TABLE ebay.ebay_category_mappings (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, channel_id integer NOT NULL,
        product_type_slug varchar(100) NOT NULL, ebay_browse_category_id varchar(50), ebay_browse_category_name text);
      CREATE TABLE public.shopify_variants (id varchar PRIMARY KEY, product_id text, sku text, price numeric(10,2));
      CREATE TABLE public.app_settings (id varchar PRIMARY KEY, dropship_channel_id integer);
      CREATE TABLE membership.plans (id varchar PRIMARY KEY, is_active boolean, includes_dropship boolean,
        flat_discount_bp integer, flat_discount_percent numeric(5,2));
      CREATE TABLE membership.member_subscriptions (id varchar PRIMARY KEY, member_id varchar, plan_id varchar);
      CREATE TABLE membership.plan_channel_access (plan_id varchar, channel_id integer, enabled boolean, UNIQUE(plan_id, channel_id));
      CREATE TABLE membership.plan_variant_overrides (id varchar PRIMARY KEY, plan_id varchar, variant_id text, product_id text,
        override_type text, fixed_price numeric(10,2), discount_percent numeric(5,2), is_active boolean);
      CREATE TABLE membership.plan_collection_exclusions (id varchar PRIMARY KEY, plan_id varchar, collection_id text);
      CREATE TABLE membership.product_collections (id varchar PRIMARY KEY, product_id text, collection_id text);
      CREATE TABLE membership.plan_benefits (id varchar PRIMARY KEY, kind text);
      CREATE TABLE membership.plan_benefit_assignments (id varchar PRIMARY KEY, plan_id varchar, benefit_id varchar,
        enabled boolean, percentage_bp integer, shipping_group_id integer);
      CREATE TABLE membership.plan_benefit_channel_policies (id varchar PRIMARY KEY, plan_benefit_assignment_id varchar,
        channel_id integer, mode text, enabled boolean, percentage_bp_override integer, UNIQUE(plan_benefit_assignment_id, channel_id));
      CREATE TABLE dropship.dropship_catalog_rules (id integer PRIMARY KEY, scope_type varchar(30) NOT NULL,
        action varchar(20) NOT NULL DEFAULT 'include', product_line_id integer, product_id integer, product_variant_id integer,
        category varchar(200), priority integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
        starts_at timestamptz, ends_at timestamptz, notes text, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE dropship.dropship_vendor_selection_rules (id integer PRIMARY KEY,
        vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id), scope_type varchar(30) NOT NULL,
        action varchar(20) NOT NULL DEFAULT 'include', product_line_id integer, product_id integer, product_variant_id integer,
        category varchar(200), auto_connect_new_skus boolean NOT NULL DEFAULT true, auto_list_new_skus boolean NOT NULL DEFAULT false,
        priority integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true, revision_id integer,
        updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE dropship.dropship_vendor_variant_overrides (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id), product_variant_id integer NOT NULL,
        enabled_override boolean, marketplace_quantity_cap integer, notes text);
      CREATE TABLE dropship.dropship_pricing_policies (id integer PRIMARY KEY, scope_type varchar(30) NOT NULL DEFAULT 'catalog',
        product_line_id integer, product_id integer, product_variant_id integer, category varchar(200),
        mode varchar(40) NOT NULL DEFAULT 'warn_only', floor_price_cents bigint, ceiling_price_cents bigint,
        warning_margin_bps integer, is_active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE dropship.dropship_vendor_listings (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
        store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id),
        product_variant_id integer NOT NULL, platform varchar(30) NOT NULL, external_listing_id varchar(255),
        status varchar(40) NOT NULL DEFAULT 'not_listed', vendor_retail_price_cents bigint, pushed_quantity integer NOT NULL DEFAULT 0,
        quantity_cap integer, last_pushed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (store_connection_id, product_variant_id));
      CREATE TABLE dropship.dropship_cost_change_listing_holds (id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        vendor_id integer NOT NULL, store_connection_id integer NOT NULL, product_variant_id integer NOT NULL,
        held_at timestamptz NOT NULL, released_at timestamptz, release_reason varchar(40), created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE dropship.dropship_audit_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer REFERENCES dropship.dropship_vendors(id) ON DELETE SET NULL,
        store_connection_id integer REFERENCES dropship.dropship_store_connections(id) ON DELETE SET NULL,
        entity_type text, entity_id text, event_type text,
        actor_type text, actor_id text, severity text, payload jsonb, created_at timestamptz);
    `);
    for (const file of REAL_MIGRATIONS) await execute(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
  });

  beforeEach(async () => {
    log.info.mockClear();
    const tables = [...OBJECTS].filter((name) => !name.startsWith("dropship.guard_"));
    await execute(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
    await execute(`
      INSERT INTO membership.plans VALUES ('ops', true, true, 1000, NULL);
      INSERT INTO membership.member_subscriptions VALUES ('sub-1', 'member-1', 'ops'), ('sub-2', 'member-2', 'ops');
      INSERT INTO dropship.dropship_vendors (id, member_id, current_subscription_id, current_plan_id, status, entitlement_status)
        VALUES (10, 'member-1', 'sub-1', 'ops', 'active', 'active'), (11, 'member-2', 'sub-2', 'ops', 'active', 'active');
      INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, access_token_ref, refresh_token_ref, status, setup_status)
        VALUES (22, 10, 'ebay', 'vault:22:a', 'vault:22:r', 'connected', 'ready'),
               (23, 11, 'ebay', 'vault:23:a', 'vault:23:r', 'connected', 'ready');
      INSERT INTO public.app_settings VALUES ('settings', 67);
      INSERT INTO channels.channels VALUES (67, 'Dropship', 'dropship', 'internal', 'active');
      INSERT INTO catalog.product_categories (id, name) VALUES (3, 'Toploaders');
      INSERT INTO catalog.products (id, sku, name, category, category_id, product_type, shopify_product_id)
        VALUES (7, 'TL', 'Toploader 3x4', 'Toploaders', 3, 'toploader', '8000000007');
      INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, weight_grams, sales_eligibility)
        VALUES (101, 7, 'TL-25', 'Pack of 25', '7000000101', 120.5, 'sellable'),
               (102, 7, 'TL-100', 'Pack of 100', '7000000102', 480, 'sellable'),
               (103, 7, 'TL-200', 'Pack of 200', '7000000103', 960, 'sellable'),
               (104, 7, 'TL-500', 'Pack of 500', '7000000104', 2400, 'sellable');
      INSERT INTO public.shopify_variants VALUES ('7000000101', '8000000007', 'TL-25', 8.99),
        ('7000000102', '8000000007', 'TL-100', 29.99), ('7000000103', '8000000007', 'TL-200', 54.99),
        ('7000000104', '8000000007', 'TL-500', 99.99);
      INSERT INTO membership.plan_variant_overrides VALUES
        ('ops-101', 'ops', '7000000101', '8000000007', 'fixed_price', 8.09, NULL, true),
        ('ops-102', 'ops', '7000000102', '8000000007', 'fixed_price', 24.00, NULL, true),
        ('ops-103', 'ops', '7000000103', '8000000007', 'fixed_price', 44.00, NULL, true),
        ('ops-104', 'ops', '7000000104', '8000000007', 'fixed_price', 80.00, NULL, true);
      INSERT INTO dropship.dropship_catalog_rules (id, scope_type, action) VALUES (1, 'catalog', 'include');
      INSERT INTO dropship.dropship_vendor_selection_rules (id, vendor_id, scope_type, action, priority)
        VALUES (1, 10, 'catalog', 'include', 0), (2, 11, 'catalog', 'include', 0);
    `);
    await setStoreDefault(D1);
  });

  afterAll(async () => {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool?.end();
  });

  describe("W8, exact prices for many sizes (PUT …/size-prices)", () => {
    it("saves 200 sizes through the wrapper and W9's flow in one commit, with 200 audit rows (measured)", async () => {
      const { sizeIds } = await seedBulkSizes(200);
      const rows = sizeIds.map((id) => row(id, 1_499));
      const counter: StatementCounter = { statements: 0 };

      const result = await measure("w8_200_sizes_through_the_service", 200, counter,
        () => sizePrices(counter).saveForMember(MEMBER, STORE, { idempotencyKey: key("two-hundred"), rows }));

      expect(result.outcome).toBe("changed");
      expect(result.sizes.map((size) => size.productVariantId)).toEqual(sizeIds);
      expect(await writeCounts()).toEqual({ revisions: 200, settings: 200, audit: 200 });
      const revisions = await execute(`SELECT product_variant_id, idempotency_key, request_hash, override_price_cents, pricing_mode, actor_id
        FROM dropship.dropship_listing_price_revisions ORDER BY product_variant_id`);
      const hash = requestHashOf(rows);
      revisions.rows.forEach((revision: Row, index) => {
        expect(revision).toEqual({ product_variant_id: sizeIds[index], idempotency_key: listingSettingChildKey(key("two-hundred"), "size", sizeIds[index]),
          request_hash: hash, override_price_cents: 1_499, pricing_mode: "fixed", actor_id: MEMBER });
      });
      expect(await count("dropship.dropship_audit_events", "event_type = 'listing_price_saved' AND actor_id = $1", [MEMBER])).toBe(200);
      // W8 writes no parent row: no ledger, no product or category revision (plan P19).
      expect(await count("dropship.dropship_product_listing_setting_requests")).toBe(0);
      expect(await count("dropship.dropship_product_listing_setting_revisions")).toBe(0);
      expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.size_prices_saved", expect.objectContaining({
        outcome: "changed", vendor_id: VENDOR, store_connection_id: STORE, changed_count: 200, size_count: 200 }));
    }, BULK_TEST_TIMEOUT_MS);

    it("rolls back every revision and audit row when one size is outside a blocking limit", async () => {
      await execute(`INSERT INTO dropship.dropship_pricing_policies (id, scope_type, product_variant_id, mode, floor_price_cents)
        VALUES (5, 'variant', 103, 'block_listing_push', 5000)`);

      const error = await expectDropshipError(sizePrices().saveForMember(MEMBER, STORE,
        { idempotencyKey: key("limit"), rows: [row(101), row(102), row(103), row(104)] }), "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT");

      expect(error.context).toMatchObject({ sizeCount: 1, sizes: [{ productVariantId: 103, priceCents: 1_499,
        blockers: ["pricing:below_floor:policy_5"] }] });
      expect(await writeCounts()).toEqual({ revisions: 0, settings: 0, audit: 0 });
    });

    it("gathers version conflicts: two stale sizes answer one 409 naming both, and nothing is written", async () => {
      const revision101 = await typePrice(101, 1_299, "typed-101");
      const revision102 = await typePrice(102, 2_999, "typed-102");
      const before = await writeCounts();

      const error = await expectDropshipError(sizePrices().saveForMember(MEMBER, STORE,
        { idempotencyKey: key("stale"), rows: [row(101), row(102), row(103)] }), "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT");

      expect(error.context).toMatchObject({ conflictCount: 2, conflicts: [
        { productVariantId: 101, expectedRevisionId: null, actualRevisionId: revision101 },
        { productVariantId: 102, expectedRevisionId: null, actualRevisionId: revision102 },
      ] });
      expect(await writeCounts()).toEqual(before);
    });

    it("answers a retry from the probe as replayed and writes nothing", async () => {
      const body = { idempotencyKey: key("retry"), rows: [row(102, 3_100), row(101, 1_250)] };
      const first = await sizePrices().saveForMember(MEMBER, STORE, body);
      const after = await writeCounts();
      // Prices and limits move after the commit; the retry is answered from what the request wrote.
      await execute(`INSERT INTO dropship.dropship_pricing_policies (id, scope_type, product_variant_id, mode, floor_price_cents)
        VALUES (6, 'variant', 101, 'block_listing_push', 5000)`);
      const counter: StatementCounter = { statements: 0 };

      const retry = await sizePrices(counter).saveForMember(MEMBER, STORE, body);

      expect(retry).toEqual({ outcome: "replayed",
        sizes: first.sizes.map((size) => ({ ...size, idempotentReplay: true })) });
      expect(await writeCounts()).toEqual(after);
      // BEGIN, request lock, store lock, owner rows, the gate's store read, the probe, COMMIT: no W9 flow, no write.
      expect(counter.statements).toBe(7);
    });

    it("refuses a key reused with another price on an overlapping size, and with a disjoint set of sizes (C-feas-6)", async () => {
      await sizePrices().saveForMember(MEMBER, STORE, { idempotencyKey: key("reused"), rows: [row(101), row(102)] });
      const after = await writeCounts();

      const overlapping = await expectDropshipError(sizePrices().saveForMember(MEMBER, STORE,
        { idempotencyKey: key("reused"), rows: [row(102, 999), row(103)] }), "DROPSHIP_IDEMPOTENCY_CONFLICT");
      expect(overlapping.context).toMatchObject({ mismatched: ["size.requestHash"], classification: "permanent" });
      await expectDropshipError(sizePrices().saveForMember(MEMBER, STORE,
        { idempotencyKey: key("reused"), rows: [row(103), row(104)] }), "DROPSHIP_IDEMPOTENCY_CONFLICT");

      expect(await writeCounts()).toEqual(after);
    });

    it("refuses a key whose policy, shelf or content child exists, reading each per-size table by the key's prefix", async () => {
      const childRows = [
        ["policy", `INSERT INTO dropship.dropship_ebay_listing_policy_override_revisions
          (vendor_id, store_connection_id, product_variant_id, idempotency_key, request_hash, fulfillment_policy_id, actor_type, actor_id)
          VALUES (10, 22, 101, $1, $2, 'ship-a', 'vendor', 'member-1')`],
        ["shelf", `INSERT INTO dropship.dropship_ebay_store_category_assignment_revisions
          (vendor_id, store_connection_id, product_variant_id, idempotency_key, request_hash, store_category_ids, store_category_names, actor_type, actor_id)
          VALUES (10, 22, 101, $1, $2, '["11"]'::jsonb, '["Top shelf"]'::jsonb, 'vendor', 'member-1')`],
        ["content", `INSERT INTO dropship.dropship_listing_content_revisions
          (vendor_id, store_connection_id, product_variant_id, previous_revision_id, custom_text, catalog_hash, idempotency_key, request_hash,
           actor_id, created_at)
          VALUES (10, 22, 101, NULL, 'Own words.', $3, $1, $2, 'member-1', $4)`],
      ] as const;
      for (const [kind, sql] of childRows) {
        const label = `child-${kind}`;
        const rows = [row(101)];
        const values: unknown[] = [listingSettingChildKey(key(label), kind, 101), requestHashOf(rows)];
        if (kind === "content") values.push("c".repeat(64), NOW);
        await execute(sql, values);

        const error = await expectDropshipError(sizePrices().saveForMember(MEMBER, STORE, { idempotencyKey: key(label), rows }),
          "DROPSHIP_IDEMPOTENCY_CONFLICT");
        expect(error.context?.mismatched).toEqual([kind]);
      }
      expect(await writeCounts()).toEqual({ revisions: 0, settings: 0, audit: 0 });
    });

    it("sees only the vendor's own rows: another vendor's size child under the same key is not this request's", async () => {
      const shared = key("same-words");
      await execute(`INSERT INTO dropship.dropship_listing_price_revisions
        (vendor_id, store_connection_id, product_variant_id, previous_revision_id, override_price_cents, idempotency_key, request_hash,
         actor_id, created_at, pricing_mode) VALUES (11, $1, 101, NULL, 999, $2, $3, 'member-2', $4, 'fixed')`,
      [OTHER_VENDOR_STORE, listingSettingChildKey(shared, "size", 101), "e".repeat(64), NOW]);

      const result = await sizePrices().saveForMember(MEMBER, STORE, { idempotencyKey: shared, rows: [row(101)] });

      expect(result.outcome).toBe("changed");
      expect(await count("dropship.dropship_listing_price_revisions", "vendor_id = 10")).toBe(1);
    });

    it("refuses a size that is not in the catalog, writing nothing", async () => {
      await expectDropshipError(sizePrices().saveForMember(MEMBER, STORE,
        { idempotencyKey: key("missing"), rows: [row(101), row(999_999)] }), "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE");
      expect(await writeCounts()).toEqual({ revisions: 0, settings: 0, audit: 0 });
    });

    it("measures 500 W9 flows through the wrapper and saveListingPriceInTransaction directly (plan P38)", async () => {
      const { productIds, sizeIds } = await seedBulkSizes(500);
      const counter: StatementCounter = { statements: 0 };
      const parent = key("five-hundred");
      const hash = listingSettingRequestHash({ operation: "size_prices_v1", measurement: 500 });

      await measure("w9_500_flows_through_the_wrapper", 500, counter, () => new PgDropshipListingSettingWritesRepository(scopedPool(counter))
        .execute({ memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: parent }, async (tx) => {
          await tx.lockCatalog({ productIds, productVariantIds: sizeIds });
          for (const productVariantId of sizeIds) {
            await saveListingPriceInTransaction(tx.sizePrice(productVariantId), { storeConnectionId: STORE, productVariantId },
              { priceCents: 1_499, pricingMode: "fixed", expectedRevisionId: null,
                idempotencyKey: listingSettingChildKey(parent, "size", productVariantId) }, hash, NOW);
          }
        }));

      expect(await writeCounts()).toEqual({ revisions: 500, settings: 500, audit: 500 });
    }, BULK_TEST_TIMEOUT_MS);

    it("times the replay probe over 300,000 of the vendor's price revisions under other keys (plan P16; logged, not asserted)", async () => {
      await execute(`INSERT INTO dropship.dropship_listing_price_revisions
        (vendor_id, store_connection_id, product_variant_id, previous_revision_id, override_price_cents, idempotency_key, request_hash,
         actor_id, created_at, pricing_mode)
        SELECT $1, $2, (ARRAY[101, 102, 103, 104])[1 + g % 4], NULL, 1499, 'probe-load:' || g, $3, $4, $5, 'fixed'
        FROM generate_series(1, $6::int) g`, [VENDOR, STORE, "b".repeat(64), MEMBER, NOW, PROBE_LOAD_REVISIONS]);
      // As autovacuum would have it in production: the planner knows the table's size.
      await execute("ANALYZE dropship.dropship_listing_price_revisions");
      const repository = new PgDropshipListingSettingWritesRepository(scopedPool());
      const probeMs: number[] = [];

      for (let run = 0; run < PROBE_TIMED_RUNS; run += 1) {
        const use = await repository.execute({ memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: key(`probe-load-${run}`) },
          async (tx) => {
            const started = performance.now();
            const found = await tx.findRequestKeyUse();
            probeMs.push(performance.now() - started);
            return found;
          });
        // None of the 300,000 is under this key's prefixes.
        expect(use).toEqual({ productRevision: null, categoryRevision: null, ledger: null, children: [] });
      }

      process.stdout.write(`${JSON.stringify({ measurement: "replay_probe_over_vendor_price_revisions", revisions: PROBE_LOAD_REVISIONS,
        elapsedMs: probeMs.map((ms) => Number(ms.toFixed(1))) })}\n`);
      expect(await count("dropship.dropship_listing_price_revisions", "vendor_id = $1", [VENDOR])).toBe(PROBE_LOAD_REVISIONS);
    }, BULK_TEST_TIMEOUT_MS);
  });

  describe("W1 apply reads committed data under the selection locks (P37, C-money-1)", () => {
    it("answers stale when a W9 release commits while the apply waits on the store lock, and changes no profile", async () => {
      const typed = await typePrice(101, 1_299, "typed-101");
      const profileBefore = (await execute("SELECT revision_id FROM dropship.dropship_pricing_profiles WHERE store_connection_id = $1", [STORE]))
        .rows[0].revision_id as number;
      // W1 reviews a new store default; the typed size is kept as it is.
      const review = await pricingRules().reviewForMember(MEMBER, STORE, { profile: D2, expectedRevisionId: profileBefore, releaseFixedOverrides: false });
      expect(review.summary.blocked).toBe(0);

      // A W9 release of the typed size (to `inherit`, checked against D1) saves, then holds the store lock until the gate opens.
      let saved!: () => void;
      const releaseSaved = new Promise<void>((done) => { saved = done; });
      let open!: () => void;
      const gate = new Promise<void>((done) => { open = done; });
      const release = new PgDropshipListingPriceRepository(scopedPool()).execute(
        { memberId: MEMBER, storeConnectionId: STORE, productVariantId: 101, idempotencyKey: "release-101" },
        async (tx) => {
          const result = await saveListingPriceInTransaction(tx, { storeConnectionId: STORE, productVariantId: 101 },
            { priceCents: null, pricingMode: "inherit", expectedRevisionId: typed, idempotencyKey: "release-101" }, "d".repeat(64), NOW);
          saved();
          await gate;
          return result;
        });
      let apply: Promise<unknown> | undefined;
      let outcome: unknown;
      try {
        await within(releaseSaved, "the W9 release's save");

        // W1 apply starts and waits on the store lock the release holds.
        apply = pricingRules().applyForMember(MEMBER, STORE, { reviewId: review.reviewId, reviewHash: review.reviewHash,
          idempotencyKey: "apply-race" }).then(() => null, (reason: unknown) => reason);
        await waitUntilLockWait("dropship_listing_push_job", 1);

        open();
        await expect(within(release, "the W9 release")).resolves.toMatchObject({ idempotentReplay: false,
          price: { productVariantId: 101, pricingMode: "inherit" } });
        outcome = await within(apply, "W1 apply");
      } finally {
        // A failed wait must not leave the release holding the store lock: the next case's TRUNCATE would wait on it.
        open();
        await within(Promise.allSettled([release, ...(apply ? [apply] : [])]), "the race case's clean-up");
      }

      // On SERIALIZABLE the apply's snapshot predates the release and it commits D2 over a size nobody checked against D2.
      expect(outcome).toBeInstanceOf(DropshipError);
      expect((outcome as DropshipError).code).toBe("DROPSHIP_PRICING_REVIEW_STALE");
      expect((await execute("SELECT revision_id FROM dropship.dropship_pricing_profiles WHERE store_connection_id = $1", [STORE]))
        .rows[0].revision_id).toBe(profileBefore);
      expect(await count("dropship.dropship_pricing_applications")).toBe(0);
      expect((await execute("SELECT pricing_mode FROM dropship.dropship_listing_price_settings WHERE product_variant_id = 101")).rows[0])
        .toEqual({ pricing_mode: "inherit" });
    });

    it("still applies a review nothing changed since, under READ COMMITTED", async () => {
      const current = (await execute("SELECT revision_id FROM dropship.dropship_pricing_profiles WHERE store_connection_id = $1", [STORE]))
        .rows[0].revision_id as number;
      const review = await pricingRules().reviewForMember(MEMBER, STORE, { profile: D2, expectedRevisionId: current, releaseFixedOverrides: false });

      const applied = await pricingRules().applyForMember(MEMBER, STORE, { reviewId: review.reviewId, reviewHash: review.reviewHash,
        idempotencyKey: "apply-quiet" });

      expect(applied.idempotentReplay).toBe(false);
      expect((await execute("SELECT revision_id FROM dropship.dropship_pricing_profiles WHERE store_connection_id = $1", [STORE]))
        .rows[0].revision_id).toBe(applied.revisionId);
    });
  });

  describe("W5, one product (PUT …/products/:productId, plan PR 9, section 6)", () => {
    const BIG_PRODUCT = 3_000;
    const BIG_FIRST_SIZE = 300_000;
    beforeEach(() => { ebayCalls.length = 0; });

    it("saves a product with 200 size prices and its clean-ups in one commit with every audit row, measured (PG 1, 8)", async () => {
      const sizes = await seedProductSizes(BIG_PRODUCT, BIG_FIRST_SIZE, 200);
      // Leftovers: 20 sizes keep a return policy after the shipping one is cleared, 10 lose their only id, 15 shelves, 5 own texts
      // and 2 sizes on the Card Shellz text (nothing to clear).
      for (const sizeId of sizes.slice(0, 20)) await seedPolicyOverride({ sizeId, fulfillment: "ship-a", returnPolicy: "ret-a", label: `kept-${sizeId}` });
      for (const sizeId of sizes.slice(20, 30)) await seedPolicyOverride({ sizeId, fulfillment: "ship-a", label: `gone-${sizeId}` });
      for (const sizeId of sizes.slice(30, 45)) await seedShelf({ sizeId, label: `${sizeId}` });
      for (const sizeId of sizes.slice(50, 55)) await seedContent({ sizeId, text: `Own words for ${sizeId}. Cards’ “best”.`, label: `${sizeId}` });
      for (const sizeId of sizes.slice(55, 57)) await seedContent({ sizeId, text: null, label: `${sizeId}` });
      const before = await allWrites();
      const counter: StatementCounter = { statements: 0 };
      const body = { idempotencyKey: productKey("two-hundred"), expectedRevisionId: null,
        patch: { shippingPolicy: null, storeShelf: { mode: "none" }, mainText: null },
        sizePrices: sizes.map((productVariantId) => ({ productVariantId, pricingMode: "fixed", priceCents: 1_499, expectedRevisionId: null })),
        expectedPrices: sizes.map((productVariantId) => ({ productVariantId, priceCents: 1_499 })) };

      const result = await measure("w5_200_sizes_with_clean_ups", 200, counter,
        () => products(scopedPool(counter)).saveForMember(MEMBER, STORE, BIG_PRODUCT, body));

      expect(result).toMatchObject({ outcome: "changed", productId: BIG_PRODUCT, clearedSizeCount: 50 });
      expect(result.sizes.map((size) => size.productVariantId)).toEqual(sizes);
      expect(await allWrites()).toEqual({ productRevisions: before.productRevisions + 1, priceRevisions: before.priceRevisions + 200,
        policyRevisions: before.policyRevisions + 30, shelfRevisions: before.shelfRevisions + 15, contentRevisions: before.contentRevisions + 5,
        audit: before.audit + 1 + 200 + 30 + 15 + 5 });
      // The policy rows: the shipping id cleared, the return id kept on 20; the 10 with no id left are gone.
      const policies = await execute(`SELECT product_variant_id, fulfillment_policy_id, return_policy_id FROM dropship.dropship_ebay_listing_policy_overrides
        WHERE store_connection_id = $1 ORDER BY product_variant_id`, [STORE]);
      expect(policies.rows).toEqual(sizes.slice(0, 20).map((id) => ({ product_variant_id: id, fulfillment_policy_id: null, return_policy_id: "ret-a" })));
      expect(await count("dropship.dropship_ebay_store_category_assignments", "store_connection_id = $1", [STORE])).toBe(0);
      const content = await execute(`SELECT s.product_variant_id, r.custom_text, r.previous_revision_id IS NOT NULL AS has_previous
        FROM dropship.dropship_listing_content_settings s JOIN dropship.dropship_listing_content_revisions r ON r.id = s.revision_id
        WHERE s.store_connection_id = $1 ORDER BY s.product_variant_id`, [STORE]);
      expect(content.rows).toEqual([...sizes.slice(50, 55).map((id) => ({ product_variant_id: id, custom_text: null, has_previous: true })),
        ...sizes.slice(55, 57).map((id) => ({ product_variant_id: id, custom_text: null, has_previous: false }))]);
      // Every child under the request's own prefixes, with the parent hash.
      const hashes = await execute(`SELECT DISTINCT request_hash FROM dropship.dropship_ebay_listing_policy_override_revisions
        WHERE idempotency_key LIKE 'ls:%'`);
      expect(hashes.rows).toHaveLength(1);
      const productRevision = await execute(`SELECT request_hash, shelf_mode, fulfillment_policy_id FROM dropship.dropship_product_listing_setting_revisions
        WHERE product_id = $1`, [BIG_PRODUCT]);
      expect(productRevision.rows).toEqual([{ request_hash: hashes.rows[0].request_hash, shelf_mode: "none", fulfillment_policy_id: null }]);
      expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.product_saved", expect.objectContaining({
        outcome: "changed", product_id: BIG_PRODUCT, size_count: 200, cleared_size_count: 50,
        cleared_by_kind: { policy: 30, shelf: 15, content: 5 } }));
    }, BULK_TEST_TIMEOUT_MS);

    it("writes nothing when a size is refused, and rolls back the product row and the size prices when a clean-up fails (PG 1)", async () => {
      await seedShelf({ sizeId: 101, label: "101" });
      await execute(`INSERT INTO dropship.dropship_pricing_policies (id, scope_type, product_variant_id, mode, floor_price_cents)
        VALUES (9, 'variant', 103, 'block_listing_push', 5000)`);
      const before = await allWrites();
      const body = { idempotencyKey: productKey("refused"), expectedRevisionId: null, patch: { storeShelf: { mode: "none" } },
        sizePrices: [101, 103].map((productVariantId) => ({ productVariantId, pricingMode: "fixed", priceCents: 1_499, expectedRevisionId: null })) };
      const shown = await shownPrices(PRODUCT_7, body);

      const refused = await expectDropshipError(products().saveForMember(MEMBER, STORE, PRODUCT_7, { ...body, expectedPrices: shown }),
        "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT");
      expect(refused.context).toMatchObject({ sizeCount: 1, sizes: [{ productVariantId: 103, refusal: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT" }] });
      expect(await allWrites()).toEqual(before);

      // A failure after the product row and the size prices are written rolls all of it back, audit rows included.
      await execute("DELETE FROM dropship.dropship_pricing_policies WHERE id = 9");
      const failing = scopedPool(undefined, (sql) => {
        if (sql.startsWith("WITH target AS MATERIALIZED") && sql.includes("dropship.dropship_ebay_store_category_assignments a")) {
          throw new Error("injected clean-up failure");
        }
      });
      await expect(products(failing).saveForMember(MEMBER, STORE, PRODUCT_7, { ...body, idempotencyKey: productKey("rolled-back"),
        expectedPrices: shown })).rejects.toThrow("injected clean-up failure");
      expect(await allWrites()).toEqual(before);
      expect(await count("dropship.dropship_ebay_store_category_assignments")).toBe(1);
    });

    it("commits a recipe change with a release: W9 judges the release against the new recipe, and commits the prices shown (PG 1)", async () => {
      // P14's write order on a real database (review round, M1): the product row first, so W9's in-transaction layer read
      // sees the new recipe. 101 is typed at 25.00 today; D1 (809 x 1.3 + 1.00) and retail (8.99) are both under a 20.00
      // blocking floor, so W9 could accept the release only by reading the recipe written earlier in the same transaction.
      const typed = await new PgDropshipListingPriceRepository(scopedPool()).execute(
        { memberId: MEMBER, storeConnectionId: STORE, productVariantId: 101, idempotencyKey: "typed-101" }, (tx) =>
          saveListingPriceInTransaction(tx, { storeConnectionId: STORE, productVariantId: 101 },
            { priceCents: 2_500, pricingMode: "fixed", expectedRevisionId: null, idempotencyKey: "typed-101" }, "e".repeat(64), NOW));
      await execute(`INSERT INTO dropship.dropship_pricing_policies (id, scope_type, product_variant_id, mode, floor_price_cents)
        VALUES (11, 'variant', 101, 'block_listing_push', 2000)`);
      // The new product recipe: retail x 3 (8.99 becomes 26.97 on 101), over the floor.
      const recipe = { basis: "catalog_retail", markupBps: 20_000, flatCents: 0, rounding: "cent" };
      const release = [{ productVariantId: 101, pricingMode: "inherit", expectedRevisionId: typed.price.revisionId }];

      // Control: the release alone leaves 101 on D1 / retail, under the floor, so the builder refuses it before any write.
      const before = await allWrites();
      const releaseOnly = { idempotencyKey: productKey("release-only"), expectedRevisionId: null, patch: {}, sizePrices: release };
      const refused = await expectDropshipError(products().saveForMember(MEMBER, STORE, PRODUCT_7,
        { ...releaseOnly, expectedPrices: await shownPrices(PRODUCT_7, releaseOnly) }), "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST");
      expect(refused.context).toMatchObject({ sizeCount: 1, sizes: [{ productVariantId: 101, beforePriceCents: 2_500, afterPriceCents: 899,
        refusal: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", blockers: ["pricing:below_floor:policy_11"] }] });
      expect(await allWrites()).toEqual(before);

      const body = { idempotencyKey: productKey("recipe-release"), expectedRevisionId: null, patch: { price: recipe }, sizePrices: release };
      const shown = await shownPrices(PRODUCT_7, body);
      expect(shown).toEqual([{ productVariantId: 101, priceCents: 2_697 }, { productVariantId: 102, priceCents: 8_997 },
        { productVariantId: 103, priceCents: 16_497 }, { productVariantId: 104, priceCents: 29_997 }]);

      const result = await products().saveForMember(MEMBER, STORE, PRODUCT_7, { ...body, expectedPrices: shown });

      expect(result).toMatchObject({ outcome: "changed", productId: PRODUCT_7, sizes: [{ productVariantId: 101 }] });
      const stored = await execute(`SELECT pricing_mode, override_price_cents FROM dropship.dropship_listing_price_settings
        WHERE store_connection_id = $1 AND product_variant_id = 101`, [STORE]);
      expect(stored.rows).toEqual([{ pricing_mode: "inherit", override_price_cents: null }]);
      // After the commit, the server prices the same recipe exactly as the vendor was shown.
      expect(await shownPrices(PRODUCT_7, { idempotencyKey: "after", expectedRevisionId: result.revisionId, patch: { price: recipe } }))
        .toEqual(shown);
    });

    it("answers a retry from the probe as replayed, in exactly 7 statements, writing nothing (PG 2)", async () => {
      await seedPolicyOverride({ sizeId: 102, fulfillment: "ship-a", label: "102" });
      const body = { idempotencyKey: productKey("retry"), expectedRevisionId: null, patch: { shippingPolicy: null, storeShelf: { mode: "none" } },
        sizePrices: [{ productVariantId: 101, pricingMode: "fixed", priceCents: 1_250, expectedRevisionId: null }] };
      const sent = { ...body, expectedPrices: await shownPrices(PRODUCT_7, body) };
      const first = await products().saveForMember(MEMBER, STORE, PRODUCT_7, sent);
      expect(first).toMatchObject({ outcome: "changed", clearedSizeCount: 1 });
      const after = await allWrites();
      // Limits move after the commit; the retry is answered from what the request wrote.
      await execute(`INSERT INTO dropship.dropship_pricing_policies (id, scope_type, product_variant_id, mode, floor_price_cents)
        VALUES (6, 'variant', 101, 'block_listing_push', 5000)`);
      const counter: StatementCounter = { statements: 0 };

      const retry = await products(scopedPool(counter)).saveForMember(MEMBER, STORE, PRODUCT_7, sent);

      expect(retry).toEqual({ outcome: "replayed", productId: PRODUCT_7, revisionId: first.revisionId, sizes: first.sizes, clearedSizeCount: null });
      expect(await allWrites()).toEqual(after);
      // BEGIN, request lock, store lock, owner rows, the gate's store read, the probe, COMMIT.
      expect(counter.statements).toBe(7);
    });

    it("leaves another vendor's and another store's leftover rows untouched (PG 3)", async () => {
      await addVendorStore(24);
      for (const [vendorId, storeId] of [[VENDOR, STORE], [11, OTHER_VENDOR_STORE], [VENDOR, 24]] as const) {
        await seedPolicyOverride({ vendorId, storeId, sizeId: 101, fulfillment: "ship-a", label: `${storeId}` });
        await seedShelf({ vendorId, storeId, sizeId: 101, label: `${storeId}` });
        await seedContent({ vendorId, storeId, sizeId: 101, text: "Own words.", label: `${storeId}` });
      }
      const result = await products().saveForMember(MEMBER, STORE, PRODUCT_7, { idempotencyKey: productKey("scoped"), expectedRevisionId: null,
        patch: { shippingPolicy: null, storeShelf: null, mainText: null } });

      expect(result).toMatchObject({ outcome: "changed", clearedSizeCount: 1 });
      for (const storeId of [OTHER_VENDOR_STORE, 24]) {
        expect(await count("dropship.dropship_ebay_listing_policy_overrides", "store_connection_id = $1 AND fulfillment_policy_id = 'ship-a'", [storeId])).toBe(1);
        expect(await count("dropship.dropship_ebay_store_category_assignments", "store_connection_id = $1", [storeId])).toBe(1);
        expect(await count("dropship.dropship_listing_content_revisions", "store_connection_id = $1", [storeId])).toBe(1);
      }
      expect(await count("dropship.dropship_ebay_listing_policy_overrides", "store_connection_id = $1", [STORE])).toBe(0);
      expect(await count("dropship.dropship_ebay_store_category_assignments", "store_connection_id = $1", [STORE])).toBe(0);
    });

    it("resets an own main text with a successor revision the coherence trigger accepts, audited by bytes and digest (PG 4)", async () => {
      const text = "Own words for the toploader. Cards’ “best” 🃏";
      const previous = await seedContent({ sizeId: 102, text, label: "102" });

      await products().saveForMember(MEMBER, STORE, PRODUCT_7, { idempotencyKey: productKey("content-reset"), expectedRevisionId: null,
        patch: { mainText: null } });

      const current = await execute(`SELECT r.id, r.previous_revision_id, r.custom_text, r.catalog_hash, r.idempotency_key
        FROM dropship.dropship_listing_content_settings s JOIN dropship.dropship_listing_content_revisions r ON r.id = s.revision_id
        WHERE s.store_connection_id = $1 AND s.product_variant_id = 102`, [STORE]);
      expect(current.rows[0]).toMatchObject({ previous_revision_id: previous, custom_text: null, catalog_hash: "c".repeat(64),
        idempotency_key: listingSettingChildKey(productKey("content-reset"), "content", 102) });
      const audit = await execute(`SELECT actor_type, actor_id, payload FROM dropship.dropship_audit_events WHERE event_type = 'listing_content_saved'`);
      expect(audit.rows).toEqual([{ actor_type: "vendor", actor_id: MEMBER, payload: {
        revisionId: current.rows[0].id, previousRevisionId: previous, after: null, requestKey: productKey("content-reset"),
        before: { bytes: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text, "utf8").digest("hex") } } }]);
      expect(JSON.stringify(audit.rows)).not.toContain("Own words");
    });

    it("pins PostgreSQL's name for the content revision key, and maps a real 23505 on it to the key conflict (PG 5)", async () => {
      const names = await pool.query<{ conname: string }>(`SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND c.contype = 'u'
          AND t.relname IN ('dropship_listing_content_revisions', 'dropship_ebay_listing_policy_override_revisions',
            'dropship_ebay_store_category_assignment_revisions') ORDER BY c.conname`, [schema]);
      expect(names.rows.map((row) => row.conname)).toEqual(expect.arrayContaining([
        "dropship_listing_content_revision_vendor_id_idempotency_key_key",
        "dropship_ebay_listing_policy_override_revision_idem_uk",
        "dropship_ebay_store_category_revision_idem_uk",
      ]));
      process.stdout.write(`${JSON.stringify({ measurement: "content_revision_key_constraint", names: names.rows.map((row) => row.conname) })}\n`);

      await seedContent({ sizeId: 101, text: "Own words.", label: "dup" });
      const failure = await execute(`INSERT INTO dropship.dropship_listing_content_revisions
        (vendor_id, store_connection_id, product_variant_id, previous_revision_id, custom_text, catalog_hash, idempotency_key, request_hash,
         actor_id, created_at) VALUES (10, 22, 102, NULL, NULL, $1, 'seed-content:dup', $2, 'seed', $3)`, ["c".repeat(64), "d".repeat(64), NOW])
        .then(() => null, (error: unknown) => error);
      expect(failure).toMatchObject({ code: "23505", constraint: "dropship_listing_content_revision_vendor_id_idempotency_key_key" });
      expect(mapListingSettingWriteError(failure)).toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT",
        context: { constraint: "dropship_listing_content_revision_vendor_id_idempotency_key_key", classification: "permanent" } });
    });

    describe("concurrency (PG 6)", () => {
      it("(a) waits for an old per-size policy writer that holds its feature lock; both finish, no deadlock", async () => {
        await seedPolicyOverride({ sizeId: 101, fulfillment: "ship-a", returnPolicy: "ret-a", label: "101" });
        const paused = gate((sql) => sql.includes("INSERT INTO dropship.dropship_ebay_listing_policy_override_revisions"));
        const oldWriter = new PgDropshipEbayListingPolicyOverrideRepository(scopedPool(undefined, paused.hook)).replaceAssignment({
          vendorId: VENDOR, storeConnectionId: STORE, productVariantId: 102, expectedRevisionId: null, fulfillmentPolicyId: null,
          returnPolicyId: "ret-b", paymentPolicyId: null, idempotencyKey: "old-policy-writer:1", requestHash: "e".repeat(64),
          actor: { actorType: "vendor", actorId: MEMBER }, now: NOW });
        let w5: Promise<unknown> | undefined;
        try {
          await within(paused.reached, "the old writer's revision insert");
          w5 = products().saveForMember(MEMBER, STORE, PRODUCT_7, { idempotencyKey: productKey("feature-lock"), expectedRevisionId: null,
            patch: { shippingPolicy: null } });
          await waitUntilLockWait("dropship_ebay_listing_policy_override", 1);
          paused.open();
          await expect(within(oldWriter, "the old writer")).resolves.toMatchObject({ idempotentReplay: false });
          await expect(within(w5, "W5")).resolves.toMatchObject({ outcome: "changed", clearedSizeCount: 1 });
        } finally {
          paused.open();
          await within(Promise.allSettled([oldWriter, ...(w5 ? [w5] : [])]), "the feature-lock case's clean-up");
        }
        const rows = await execute(`SELECT product_variant_id, fulfillment_policy_id, return_policy_id FROM dropship.dropship_ebay_listing_policy_overrides
          ORDER BY product_variant_id`);
        expect(rows.rows).toEqual([{ product_variant_id: 101, fulfillment_policy_id: null, return_policy_id: "ret-a" },
          { product_variant_id: 102, fulfillment_policy_id: null, return_policy_id: "ret-b" }]);
      });

      it("(b) sees a W9 save that commits while it waits on the store lock: 409 PRICES_MOVED, nothing written", async () => {
        const recipe = { basis: "catalog_retail", markupBps: 1_000, flatCents: 0, rounding: "cent" };
        const body = { idempotencyKey: productKey("w9-race"), expectedRevisionId: null, patch: { price: recipe } };
        const shown = await shownPrices(PRODUCT_7, body);
        let saved!: () => void;
        const priceSaved = new Promise<void>((done) => { saved = done; });
        let open!: () => void;
        const held = new Promise<void>((done) => { open = done; });
        const w9 = new PgDropshipListingPriceRepository(scopedPool()).execute(
          { memberId: MEMBER, storeConnectionId: STORE, productVariantId: 101, idempotencyKey: "typed-101-race" }, async (tx) => {
            const result = await saveListingPriceInTransaction(tx, { storeConnectionId: STORE, productVariantId: 101 },
              { priceCents: 1_299, pricingMode: "fixed", expectedRevisionId: null, idempotencyKey: "typed-101-race" }, "f".repeat(64), NOW);
            saved();
            await held;
            return result;
          });
        let w5: Promise<unknown> | undefined;
        let outcome: unknown;
        try {
          await within(priceSaved, "the W9 save");
          w5 = products().saveForMember(MEMBER, STORE, PRODUCT_7, { ...body, expectedPrices: shown }).then(() => null, (reason: unknown) => reason);
          await waitUntilLockWait("dropship_listing_push_job", 1);
          open();
          await within(w9, "W9");
          outcome = await within(w5, "W5");
        } finally {
          open();
          await within(Promise.allSettled([w9, ...(w5 ? [w5] : [])]), "the W9 race case's clean-up");
        }
        expect(outcome).toBeInstanceOf(DropshipError);
        expect(outcome).toMatchObject({ code: "DROPSHIP_LISTING_PRICES_MOVED", context: { sizeCount: 1,
          sizes: [{ productVariantId: 101, priceCents: 1_299, expectedPriceCents: shown.find((row) => row.productVariantId === 101)!.priceCents }] } });
        expect(await count("dropship.dropship_product_listing_setting_revisions")).toBe(0);
      });

      it("(c) serializes one key sent twice at once: the same body replays, another body is a conflict, another store is a conflict", async () => {
        const body = { idempotencyKey: productKey("twice"), expectedRevisionId: null, patch: { storeShelf: { mode: "none" } } };
        const paused = gate((sql) => sql === "COMMIT");
        const first = products(scopedPool(undefined, paused.hook)).saveForMember(MEMBER, STORE, PRODUCT_7, body);
        let second: Promise<unknown> | undefined;
        let third: Promise<unknown> | undefined;
        try {
          await within(paused.reached, "the first save's commit");
          second = products().saveForMember(MEMBER, STORE, PRODUCT_7, body);
          third = products().saveForMember(MEMBER, STORE, PRODUCT_7, { ...body, patch: { storeShelf: null } })
            .then(() => null, (reason: unknown) => reason);
          await waitUntilLockWait("dropship_listing_settings_request", 2);
          paused.open();
          const written = await within(first, "the first save");
          expect(written).toMatchObject({ outcome: "changed" });
          await expect(within(second, "the same body")).resolves.toEqual({ ...(written as object), outcome: "replayed", clearedSizeCount: null });
          await expect(within(third, "another body")).resolves.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT",
            context: { mismatched: ["productRevision.requestHash"] } });
        } finally {
          paused.open();
          await within(Promise.allSettled([first, ...(second ? [second] : []), ...(third ? [third] : [])]), "the same-key case's clean-up");
        }
        expect(await count("dropship.dropship_product_listing_setting_revisions")).toBe(1);

        // The member's second store, the same key: the probe sees the first store's row.
        await addVendorStore(24);
        const otherStore = await expectDropshipError(products().saveForMember(MEMBER, 24, PRODUCT_7, body), "DROPSHIP_IDEMPOTENCY_CONFLICT");
        expect(otherStore.context?.mismatched).toEqual(["productRevision.requestHash", "productRevision.storeConnectionId"]);
      });

      it("(d) answers a size Card Shellz adds between the size read and lockCatalog as PRICES_MOVED, naming it", async () => {
        const body = { idempotencyKey: productKey("new-size"), expectedRevisionId: null,
          patch: { price: { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" } } };
        const shown = await shownPrices(PRODUCT_7, body);
        let inserted = false;
        const racing = scopedPool(undefined, async (sql) => {
          if (inserted || !sql.startsWith("LOCK TABLE dropship.dropship_catalog_rules")) return;
          inserted = true;
          await execute(`INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, weight_grams, sales_eligibility)
            VALUES (105, 7, 'TL-1000', 'Pack of 1000', '7000000105', 4800, 'sellable')`);
        });

        const error = await expectDropshipError(products(racing).saveForMember(MEMBER, STORE, PRODUCT_7, { ...body, expectedPrices: shown }),
          "DROPSHIP_LISTING_PRICES_MOVED");

        expect(inserted).toBe(true);
        expect(error.context).toMatchObject({ sizeCount: 1, sizes: [{ productVariantId: 105 }] });
        expect(await count("dropship.dropship_product_listing_setting_revisions")).toBe(0);
      });
    });

    it("reads the preflight in a read-only snapshot with no lock, asks eBay for the new id only, and stores eBay's name (PG 7)", async () => {
      const statements: Array<{ connection: number; sql: string }> = [];
      const recording = scopedPool(undefined, (sql, connection) => { statements.push({ connection, sql }); });

      const result = await products(recording).saveForMember(MEMBER, STORE, PRODUCT_7, { idempotencyKey: productKey("preflight"),
        expectedRevisionId: null, patch: { returnPolicy: { id: "return-new" } } });

      expect(result).toMatchObject({ outcome: "changed" });
      expect(ebayCalls).toEqual(["discover"]);
      const preflight = statements.filter((row) => row.connection === 0).map((row) => row.sql);
      expect(preflight[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(preflight.at(-1)).toBe("COMMIT");
      expect(preflight.some((sql) => /pg_advisory|FOR SHARE|FOR UPDATE|LOCK TABLE|INSERT|UPDATE dropship/.test(sql))).toBe(false);
      expect(statements.filter((row) => row.connection === 1)[0].sql).toBe("BEGIN");
      const stored = await execute(`SELECT return_policy_id, return_policy_name FROM dropship.dropship_product_listing_setting_revisions
        WHERE product_id = $1`, [PRODUCT_7]);
      expect(stored.rows).toEqual([{ return_policy_id: "return-new", return_policy_name: "Thirty days" }]);
      // Why the preflight's owner read has no FOR SHARE: PostgreSQL refuses a row lock in a read-only transaction.
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await expect(client.query(`SELECT id FROM "${schema}".dropship_vendors FOR SHARE`)).rejects.toMatchObject({ code: "25006" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("refuses a W5 that raises a store at the text cap, accepts one that shortens, and times the count over 10,000 rows (PG 9)", async () => {
      const BULK_TEXT_FIRST_PRODUCT = 20_000;
      const ROWS = 10_000;
      const PART = MAX_STORE_LISTING_TEXT_BYTES / ROWS / 2;
      expect(Number.isInteger(PART)).toBe(true);
      await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type)
        SELECT g, 'TEXT-' || g, 'Text product ' || g, 'Toploaders', $3, 'toploader' FROM generate_series($1::int, $2::int) g`,
      [BULK_TEXT_FIRST_PRODUCT, BULK_TEXT_FIRST_PRODUCT + ROWS - 2, TOPLOADERS]);
      // Product 7 and 9,999 others, each with text above and below of PART ASCII bytes: the store sits exactly at the cap.
      await execute(`INSERT INTO dropship.dropship_product_listing_setting_revisions
        (vendor_id, store_connection_id, product_id, previous_revision_id, request_id, text_above_mode, text_above, text_below_mode, text_below,
         idempotency_key, request_hash, actor_type, actor_id, created_at)
        SELECT $1, $2, p.id, NULL, NULL, 'own', repeat('a', $3), 'own', repeat('b', $3), 'seed-text:' || p.id, $4, 'vendor', 'seed', $5
        FROM (SELECT 7 AS id UNION ALL SELECT g FROM generate_series($6::int, $7::int) g) p`,
      [VENDOR, STORE, PART, "d".repeat(64), NOW, BULK_TEXT_FIRST_PRODUCT, BULK_TEXT_FIRST_PRODUCT + ROWS - 2]);
      await execute(`INSERT INTO dropship.dropship_product_listing_settings (vendor_id, store_connection_id, product_id, revision_id)
        SELECT vendor_id, store_connection_id, product_id, id FROM dropship.dropship_product_listing_setting_revisions`);
      const encoding = (await pool.query<{ server_encoding: string }>("SHOW server_encoding")).rows[0].server_encoding;
      expect(encoding).toBe("UTF8");
      const repository = new PgDropshipListingSettingWritesRepository(scopedPool());
      const timedMs: number[] = [];
      for (let run = 0; run < 3; run += 1) {
        const bytes = await repository.execute({ memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: productKey(`count-${run}`) },
          async (tx) => {
            const started = performance.now();
            const counted = await tx.readListingTextBytes({ productIds: [PRODUCT_7], replacedFields: { textAbove: true, textBelow: false, mainText: false } });
            timedMs.push(performance.now() - started);
            return counted;
          });
        expect(bytes).toEqual({ storeBytes: MAX_STORE_LISTING_TEXT_BYTES, keptStoreBytes: MAX_STORE_LISTING_TEXT_BYTES - PART, targetBytes: 2 * PART });
      }
      process.stdout.write(`${JSON.stringify({ measurement: "read_listing_text_bytes_at_cap", rows: ROWS, bytes: MAX_STORE_LISTING_TEXT_BYTES,
        serverEncoding: encoding, elapsedMs: timedMs.map((ms) => Number(ms.toFixed(1))) })}\n`);
      const revision = (await execute(`SELECT revision_id FROM dropship.dropship_product_listing_settings WHERE product_id = 7`)).rows[0].revision_id as number;
      const before = await allWrites();

      const refused = await expectDropshipError(products().saveForMember(MEMBER, STORE, PRODUCT_7, { idempotencyKey: productKey("adds-text"),
        expectedRevisionId: revision, patch: { mainText: { text: "Own words." } } }), "DROPSHIP_LISTING_SETTINGS_TOO_LARGE");
      expect(refused.context).toMatchObject({ reason: "store_text_limit", textBytes: MAX_STORE_LISTING_TEXT_BYTES + 10,
        maxTextBytes: MAX_STORE_LISTING_TEXT_BYTES });
      expect(await allWrites()).toEqual(before);

      const shortened = await products().saveForMember(MEMBER, STORE, PRODUCT_7, { idempotencyKey: productKey("shortens"),
        expectedRevisionId: revision, patch: { textAbove: { mode: "own", text: "Short" } } });
      expect(shortened).toMatchObject({ outcome: "changed" });
      expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.product_saved", expect.objectContaining({
        store_text_bytes: MAX_STORE_LISTING_TEXT_BYTES - PART + 5 }));
    }, BULK_TEST_TIMEOUT_MS);
  });

  describe("W6, many products (POST …/products/bulk, plan PR 9, section 7)", () => {
    /** Catalog products the edges and the cap case seed, clear of the fixture's 7 and the W5 cases' ids. */
    const EDGE_FIRST_PRODUCT = 40_001;
    const SECOND_PRODUCT = 8;
    const MISSING_PRODUCT = 999_999;
    const bulkKey = (label: string) => `products-bulk:${label}`;
    /** One service over one gate, as the factory builds them; a second instance stands for a second dyno (R13). */
    const bulk = (repositoryPool: Pool = scopedPool(), heavyWrites = new ListingSettingHeavyWriteGate()) => new DropshipListingProductsBulkService({
      repository: new PgDropshipListingSettingWritesRepository(repositoryPool), ebay: fakeEbay, heavyWrites, clock: { now: () => NOW },
      timer: () => performance.now(), log });
    const own = (text: string) => ({ mode: "own", text });

    async function ledgerRows(): Promise<number> {
      return count("dropship.dropship_product_listing_setting_requests");
    }
    /** `total` catalog products from `first` (no sizes: W6 has no chosen check, plan P11). */
    async function seedCatalogProducts(first: number, total: number): Promise<number[]> {
      await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type)
        SELECT g, 'EDGE-' || g, 'Edge product ' || g, 'Toploaders', $3, 'toploader' FROM generate_series($1::int, $2::int) g`,
      [first, first + total - 1, TOPLOADERS]);
      return Array.from({ length: total }, (_, index) => first + index);
    }
    /** A current settings row for each product with own texts above and below, as an earlier save left them; the revision ids, by product. */
    async function seedStoredTexts(productIds: readonly number[], above: string, below: string): Promise<Map<number, number>> {
      await execute(`INSERT INTO dropship.dropship_product_listing_setting_revisions
        (vendor_id, store_connection_id, product_id, previous_revision_id, request_id, text_above_mode, text_above, text_below_mode, text_below,
         idempotency_key, request_hash, actor_type, actor_id, created_at)
        SELECT $1, $2, p, NULL, NULL, 'own', $3, 'own', $4, 'seed-text:' || p, $5, 'vendor', 'seed', $6 FROM unnest($7::int[]) p`,
      [VENDOR, STORE, above, below, "d".repeat(64), NOW, productIds]);
      await execute(`INSERT INTO dropship.dropship_product_listing_settings (vendor_id, store_connection_id, product_id, revision_id)
        SELECT vendor_id, store_connection_id, product_id, id FROM dropship.dropship_product_listing_setting_revisions
        WHERE idempotency_key LIKE 'seed-text:%' AND product_id = ANY($1::int[])`, [productIds]);
      const rows = await execute(`SELECT product_id, revision_id FROM dropship.dropship_product_listing_settings WHERE product_id = ANY($1::int[])`,
        [productIds]);
      return new Map(rows.rows.map((row): [number, number] => [row.product_id as number, row.revision_id as number]));
    }
    /** As autovacuum would have it in production: the planner knows the settings tables' sizes (the probe-load case's precedent). */
    async function analyzeSettings(): Promise<void> {
      await execute("ANALYZE dropship.dropship_product_listing_settings, dropship.dropship_product_listing_setting_revisions");
    }
    /**
     * A current settings row for each product with `text` as its own text above and below (both `none` when null), and
     * with no other value or with `ebay`'s category, shelves and three policies; the revision ids, by product.
     */
    async function seedSettingRows(productIds: readonly number[], ebay: EbayRowValues | null, text: string | null): Promise<Map<number, number>> {
      await execute(`INSERT INTO dropship.dropship_product_listing_setting_revisions
        (vendor_id, store_connection_id, product_id, previous_revision_id, request_id, text_above_mode, text_above, text_below_mode, text_below,
         ebay_category_id, ebay_category_name, ebay_category_path, shelf_mode, shelf_ids, shelf_names,
         fulfillment_policy_id, fulfillment_policy_name, return_policy_id, return_policy_name, payment_policy_id, payment_policy_name,
         idempotency_key, request_hash, actor_type, actor_id, created_at)
        SELECT $1, $2, p, NULL, NULL, $18, $19, $18, $19, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17,
          'seed-row:' || p, $3, 'vendor', 'seed', $4 FROM unnest($5::int[]) p`,
      [VENDOR, STORE, "d".repeat(64), NOW, productIds,
        ebay?.category.categoryId ?? null, ebay?.category.categoryName ?? null, ebay ? JSON.stringify(ebay.category.path) : null,
        ebay ? "own" : null, ebay ? JSON.stringify(ebay.shelves.map((shelf) => shelf.id)) : null,
        ebay ? JSON.stringify(ebay.shelves.map((shelf) => shelf.name)) : null,
        ebay?.shipping.id ?? null, ebay?.shipping.name ?? null, ebay?.returns.id ?? null, ebay?.returns.name ?? null,
        ebay?.payment.id ?? null, ebay?.payment.name ?? null, text === null ? "none" : "own", text]);
      await execute(`INSERT INTO dropship.dropship_product_listing_settings (vendor_id, store_connection_id, product_id, revision_id)
        SELECT vendor_id, store_connection_id, product_id, id FROM dropship.dropship_product_listing_setting_revisions
        WHERE idempotency_key LIKE 'seed-row:%'`);
      const rows = await execute(`SELECT product_id, revision_id FROM dropship.dropship_product_listing_settings WHERE product_id = ANY($1::int[])`,
        [productIds]);
      return new Map(rows.rows.map((row): [number, number] => [row.product_id as number, row.revision_id as number]));
    }
    const named = (productIds: readonly number[], revisions = new Map<number, number>()) =>
      productIds.map((productId) => ({ productId, expectedRevisionId: revisions.get(productId) ?? null }));
    beforeEach(async () => {
      ebayCalls.length = 0;
      await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type, shopify_product_id)
        VALUES ($1, 'TL-2', 'Toploader 2', 'Toploaders', $2, 'toploader', '8000000008')`, [SECOND_PRODUCT, TOPLOADERS]);
    });

    /*
     * PG 1 and 2: the heavy-write measurements (plan 3.10's computed rule, 7.12 PG 2). Each runs the whole W6 service on
     * a fresh store: the no-text runs give the fixed part at each product count (PG 1 at 10,000 is P0), and the six text
     * edges carry the budget's bytes. The rule judges their live heap (the `_live` re-runs, opt-in, see liveHeapProbe);
     * their allocated peaks are logged too. The text edges:
     * - (a), (b) P9's own: 2 x 4,000 characters with one U+2019 per text (8,004 B a product), stored. P9's 3,750
     *   products are 30,015,000 B, over a 30,000,000 budget (P9 counted the U+2019 as one byte), so (a) runs at the most
     *   products the budget admits, after 3,750 is refused; (b) at P9's 3,000;
     * - (c1), (c2) the budget's bytes stored over the 10,000-product cap, with and without a U+2019 per text;
     * - (d1), (d2) the same bytes set by the patch on 10,000 products with nothing stored.
     * A string with any character above U+00FF is held at two bytes per character, so the U+2019 edges are the heap's worst.
     */
    const P9_TEXT = `${"a".repeat(3_999)}’`;
    const P9_PRODUCT_BYTES = 2 * Buffer.byteLength(P9_TEXT, "utf8");
    const P9_PRODUCTS = Math.floor(MAX_BULK_TEXT_BYTES / P9_PRODUCT_BYTES);
    const P9_SMALLER = 3_000 * P9_PRODUCT_BYTES <= MAX_BULK_TEXT_BYTES ? 3_000 : Math.floor(0.8 * P9_PRODUCTS);
    /** Bytes per text so that 10,000 products of two texts carry the budget exactly. */
    const CAP_PART_BYTES = MAX_BULK_TEXT_BYTES / (2 * MAX_LISTING_SETTING_BULK_PRODUCTS);
    const CAP_TWO_BYTE = `${"a".repeat(CAP_PART_BYTES - 3)}’`;
    const CAP_ASCII = "a".repeat(CAP_PART_BYTES);
    /** The longest the stored contract and the columns allow: about 4,580 characters a row. */
    const EBAY_LONGEST: EbayRowValues = {
      category: { categoryId: "9".repeat(20), categoryName: "c".repeat(MAX_EBAY_CATEGORY_NAME_LENGTH),
        path: Array.from({ length: MAX_EBAY_CATEGORY_PATH_DEPTH }, (_, index) => `${index}`.padEnd(MAX_EBAY_CATEGORY_NAME_LENGTH, "p")) },
      shelves: Array.from({ length: MAX_LISTING_STORE_SHELVES }, (_, index) => ({ id: `${index}`.padEnd(MAX_LISTING_SHELF_ID_LENGTH, "s"),
        name: `${index}`.padEnd(MAX_LISTING_SHELF_NAME_LENGTH, "n") })),
      ...Object.fromEntries((["shipping", "returns", "payment"] as const).map((kind) => [kind,
        { id: kind.padEnd(MAX_LISTING_POLICY_ID_LENGTH, "i"), name: kind.padEnd(MAX_LISTING_POLICY_NAME_LENGTH, "n") }])) as
        Pick<EbayRowValues, "shipping" | "returns" | "payment">,
    };
    /**
     * `storedRows`: each product already has a settings row with `ebay`'s values when set, and `stored` as its own
     * texts (both `none` when null); `patch` replaces the edge's default patch.
     */
    type Edge = {
      label: string; products: number; stored: string | null; set: string | null;
      storedRows?: { ebay: EbayRowValues | null }; patch?: Record<string, unknown>;
    };
    const NO_TEXT_RUNS: readonly Edge[] = [...new Set([MAX_LISTING_SETTING_BULK_PRODUCTS, P9_PRODUCTS, P9_SMALLER])]
      .map((products) => ({ label: `w6_no_text_${products}`, products, stored: null, set: null }));
    /**
     * EBAY_TYPICAL with another shelf of the same length, so a patch that sets EBAY_TYPICAL's shelf (the one shelf
     * fakeEbay lists, "11", stored under its path "Supplies:Top") changes every row and leaves it holding all of
     * EBAY_TYPICAL.
     */
    const EBAY_TYPICAL_OTHER_SHELF: EbayRowValues = { ...EBAY_TYPICAL, shelves: [{ id: "12", name: "Supplies:Bin" }] };
    /**
     * The realistic worst combination: rows with typical eBay values and (c1)'s stored texts at the budget, over the
     * 10,000-product cap. The patch sets a shelf (one eBay call, outside the gate), so every new revision carries its
     * two stored texts and all of its eBay values.
     */
    const COMBINED_EDGE: Edge = {
      label: `w6_rows_ebay_typical_c1_cap_stored_two_byte_${MAX_LISTING_SETTING_BULK_PRODUCTS}`,
      products: MAX_LISTING_SETTING_BULK_PRODUCTS, stored: CAP_TWO_BYTE, set: null,
      storedRows: { ebay: EBAY_TYPICAL_OTHER_SHELF }, patch: { storeShelf: { mode: "own", shelfIds: [EBAY_TYPICAL.shelves[0].id] } },
    };
    /**
     * Not inputs of the rule (opt-in, HEAP_DIAGNOSTICS): what a stored edge carries apart from its text bytes. Rows with
     * no text (both texts `none`), and rows whose two own texts are one character each, so the second minus the first is
     * the cost of having own texts at all (see the stop-rule line). Then rows with no text that hold an eBay category,
     * shelves and three policies, which the bulk writer also reads, parses and copies and the text budget does not
     * count, at typical and at the longest lengths; their patch (`textAbove: null`) changes no eBay value, so every
     * new revision copies them all. Last, COMBINED_EDGE.
     */
    const DIAGNOSTIC_RUNS: readonly Edge[] = [
      { label: `w6_rows_no_text_${MAX_LISTING_SETTING_BULK_PRODUCTS}`, products: MAX_LISTING_SETTING_BULK_PRODUCTS, stored: null, set: null,
        storedRows: { ebay: null } },
      { label: `w6_rows_one_character_texts_${MAX_LISTING_SETTING_BULK_PRODUCTS}`, products: MAX_LISTING_SETTING_BULK_PRODUCTS, stored: "a",
        set: null },
      { label: `w6_rows_ebay_typical_${MAX_LISTING_SETTING_BULK_PRODUCTS}`, products: MAX_LISTING_SETTING_BULK_PRODUCTS, stored: null, set: null,
        storedRows: { ebay: EBAY_TYPICAL }, patch: { textAbove: null } },
      { label: `w6_rows_ebay_longest_${MAX_LISTING_SETTING_BULK_PRODUCTS}`, products: MAX_LISTING_SETTING_BULK_PRODUCTS, stored: null, set: null,
        storedRows: { ebay: EBAY_LONGEST }, patch: { textAbove: null } },
      COMBINED_EDGE,
    ];
    const TEXT_EDGES: readonly Edge[] = [
      { label: "w6_edge_a_p9_stored_two_byte", products: P9_PRODUCTS, stored: P9_TEXT, set: null },
      { label: "w6_edge_b_p9_smaller_stored_two_byte", products: P9_SMALLER, stored: P9_TEXT, set: null },
      { label: "w6_edge_c1_cap_stored_two_byte", products: MAX_LISTING_SETTING_BULK_PRODUCTS, stored: CAP_TWO_BYTE, set: null },
      { label: "w6_edge_c2_cap_stored_ascii", products: MAX_LISTING_SETTING_BULK_PRODUCTS, stored: CAP_ASCII, set: null },
      { label: "w6_edge_d1_cap_set_two_byte", products: MAX_LISTING_SETTING_BULK_PRODUCTS, stored: null, set: CAP_TWO_BYTE },
      { label: "w6_edge_d2_cap_set_ascii", products: MAX_LISTING_SETTING_BULK_PRODUCTS, stored: null, set: CAP_ASCII },
    ];
    const textBytesOf = (edge: Edge) => edge.products * 2 * Buffer.byteLength(edge.stored ?? edge.set ?? "", "utf8");

    /** Each `_live` run's live peak (MiB over its start), by edge label: the inputs of plan 3.10's rule. */
    const livePeaks = new Map<string, number | null>();
    async function runEdge(edge: Edge, mode: "rule" | "live" = "rule"): Promise<void> {
      const productIds = await seedCatalogProducts(EDGE_FIRST_PRODUCT, edge.products);
      const revisions = edge.storedRows ? await seedSettingRows(productIds, edge.storedRows.ebay, edge.stored)
        : edge.stored !== null ? await seedStoredTexts(productIds, edge.stored, edge.stored) : new Map<number, number>();
      await analyzeSettings();
      // A stored edge's patch changes only the shelf, so every new revision carries its stored texts.
      const patch = edge.patch ?? (edge.set === null ? { storeShelf: { mode: "none" } } : { textAbove: own(edge.set), textBelow: own(edge.set) });
      const textBytes = textBytesOf(edge);
      expect(textBytes).toBeLessThanOrEqual(MAX_BULK_TEXT_BYTES);
      const counter: StatementCounter = { statements: 0 };
      const probe = mode === "live" ? liveHeapProbe() : null;
      collectGarbage?.();
      const liveStart = process.memoryUsage().heapUsed;
      // Filled in while the write runs; measure() logs it after.
      const extra: Record<string, unknown> = { products: edge.products, textBytes,
        ...(edge.storedRows?.ebay ? { ebayValueBytesPerRow: ebayValueBytes(edge.storedRows.ebay) } : {}) };
      const result = await measure(mode === "live" ? `${edge.label}_live` : edge.label, edge.products, counter, async () => {
        const answer = await bulk(scopedPool(counter, probe?.hook)).saveBulkForMember(MEMBER, STORE,
          { idempotencyKey: bulkKey(edge.label), products: named(productIds, revisions), patch });
        const peak = probe?.peakBytes() ?? null;
        if (probe) {
          const live = peak === null ? null : Number(((peak - liveStart) / 1_048_576).toFixed(1));
          extra.livePeakDeltaMiB = live;
          livePeaks.set(edge.label, live);
        }
        return answer;
      }, extra);

      expect(result).toMatchObject({ outcome: "changed", productCount: edge.products, changedProductCount: edge.products, clearedSizeCount: 0 });
      expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.products_bulk_saved", expect.objectContaining({
        text_bytes: textBytes, product_count: edge.products, changed_count: edge.products }));
      // Every new revision carries the texts (copied or set), counted by PostgreSQL, not read back.
      const stored = await execute(`SELECT count(*)::int AS n, COALESCE(sum(octet_length(text_above) + octet_length(text_below)), 0)::bigint AS bytes
        FROM dropship.dropship_product_listing_setting_revisions WHERE request_id = $1`, [result.requestId]);
      expect(stored.rows[0]).toEqual({ n: edge.products, bytes: String(textBytes) });
      const ebay = edge.storedRows?.ebay;
      if (ebay) {
        // And the eBay values: the category and policies copied, the shelf copied or set by the patch.
        const carried = await execute(`SELECT count(*)::int AS n FROM dropship.dropship_product_listing_setting_revisions
          WHERE request_id = $1 AND ebay_category_id = $2 AND fulfillment_policy_id = $3 AND return_policy_id = $4
            AND payment_policy_id = $5 AND shelf_mode = 'own'`,
        [result.requestId, ebay.category.categoryId, ebay.shipping.id, ebay.returns.id, ebay.payment.id]);
        expect(carried.rows[0]).toEqual({ n: edge.products });
      }
    }

    for (const edge of NO_TEXT_RUNS) {
      const p0 = edge.products === MAX_LISTING_SETTING_BULK_PRODUCTS ? ", P0" : "";
      it(`measures ${edge.products} products with nothing stored (PG 1${p0})`, () => runEdge(edge), BULK_TEST_TIMEOUT_MS);
    }
    for (const edge of DIAGNOSTIC_RUNS) {
      it.runIf(HEAP_DIAGNOSTICS)(`measures ${edge.label} (PG 1, diagnostic)`, () => runEdge(edge), BULK_TEST_TIMEOUT_MS);
    }

    it("refuses P9's 3,750 products of 2 x 4,000 characters over the budget, before any lock or write (PG 2 (a))", async () => {
      const productIds = await seedCatalogProducts(EDGE_FIRST_PRODUCT, 3_750);
      const revisions = await seedStoredTexts(productIds, P9_TEXT, P9_TEXT);
      const before = await allWrites();
      const statements: string[] = [];
      const error = await expectDropshipError(bulk(scopedPool(undefined, (sql) => { statements.push(sql); })).saveBulkForMember(MEMBER, STORE,
        { idempotencyKey: bulkKey("p9-3750"), products: named(productIds, revisions), patch: { storeShelf: { mode: "none" } } }),
      "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE");
      expect(error.context).toMatchObject({ textBytes: 3_750 * P9_PRODUCT_BYTES, maxTextBytes: MAX_BULK_TEXT_BYTES, productCount: 3_750 });
      expect(3_750 * P9_PRODUCT_BYTES).toBeGreaterThan(MAX_BULK_TEXT_BYTES);
      expect(statements.some((sql) => sql.startsWith("LOCK TABLE") || /FOR UPDATE/.test(sql))).toBe(false);
      expect(await allWrites()).toEqual(before);
      expect(await ledgerRows()).toBe(0);
    }, BULK_TEST_TIMEOUT_MS);

    for (const edge of TEXT_EDGES) {
      it(`measures edge ${edge.label} at ${edge.products} products (PG 2)`, () => runEdge(edge), BULK_TEST_TIMEOUT_MS);
    }
    // The same runs again for their live heap at the heaviest point (opt-in; the rule's inputs, see liveHeapProbe).
    for (const edge of [...NO_TEXT_RUNS, ...DIAGNOSTIC_RUNS, ...TEXT_EDGES]) {
      it.runIf(HEAP_DIAGNOSTICS)(`measures the live heap of ${edge.label} (PG 2, opt-in)`, () => runEdge(edge, "live"), BULK_TEST_TIMEOUT_MS);
    }

    it("computes the heavy-write stop rule from this run's measurements (plan 3.10; logged, not asserted)", () => {
      const LIMIT_MIB = 128;
      /** P9's budget and the rule's ceiling: the rule never raises the budget above it. */
      const CEILING_BYTES = 30_000_000;
      const allocatedOf = (label: string) => measurements.find((entry) => entry.measurement === label)?.heapUsedPeakDeltaMiB ?? null;
      const liveOf = (label: string) => livePeaks.get(label) ?? null;
      const p0Label = `w6_no_text_${MAX_LISTING_SETTING_BULK_PRODUCTS}`;
      // Whole bytes first, so floating-point noise at an exact million cannot floor it to the million below.
      const floorToMillion = (bytes: number) => Math.floor(Math.round(bytes) / 1_000_000) * 1_000_000;
      /**
       * P0, h and floor_to_1,000,000((128 - P0) / h) from one kind of peak: h is the worst, over the text edges, of (the
       * edge's peak - the no-text peak at the same product count) / its text bytes. Null when a case did not run
       * (filtered out, or a live run with the diagnostics off). `ruleBytes` is null when no edge grows with its text.
       */
      function stopRule(peakOf: (label: string) => number | null) {
        const p0 = peakOf(p0Label);
        const edges = TEXT_EDGES.map((edge) => {
          const peak = peakOf(edge.label);
          const fixed = peakOf(`w6_no_text_${edge.products}`);
          return { label: edge.label, products: edge.products, textBytes: textBytesOf(edge), peak, fixed,
            heapMiBPerTextByte: peak === null || fixed === null ? null : (peak - fixed) / textBytesOf(edge) };
        });
        if (p0 === null || edges.some((edge) => edge.heapMiBPerTextByte === null)) return null;
        const h = Math.max(...edges.map((edge) => edge.heapMiBPerTextByte as number));
        return { p0MiB: p0, worstHeapMiBPerTextByte: h, worstEdge: edges.find((edge) => edge.heapMiBPerTextByte === h)?.label ?? null,
          anyEdgeOverLimit: p0 > LIMIT_MIB || edges.some((edge) => (edge.peak as number) > LIMIT_MIB),
          ruleBytes: h > 0 ? floorToMillion((LIMIT_MIB - p0) / h) : null, edges };
      }
      // The rule in force judges the live heap, capped at the ceiling. It needs the forced collections, so it is null
      // with the diagnostics off.
      const live = stopRule(liveOf);
      const liveRule = live && { ...live, computedMaxBulkTextBytes: Math.min(CEILING_BYTES, live.ruleBytes ?? CEILING_BYTES) };
      // Logged for comparison only: plan 3.10 as first written, on the allocated peak and with no ceiling. Without the
      // forced collections a baseline can hold an earlier case's garbage, so these figures are not comparable with the
      // recorded ones; `gcBeforeRuns` says which kind this line is.
      const allocated = stopRule(allocatedOf);
      const allocatedRule = allocated && { ...allocated, computedMaxBulkTextBytes: allocated.ruleBytes };
      if (!liveRule && !allocatedRule) return;

      // Diagnostic, not a rule input: the realistic worst combination, with all of its live growth over P0 charged to
      // its text bytes, and what the live rule would give were it one of the edges.
      const combinedLive = liveOf(COMBINED_EDGE.label);
      const combinedH = liveRule && combinedLive !== null ? (combinedLive - liveRule.p0MiB) / textBytesOf(COMBINED_EDGE) : null;
      const combinedEdge = { label: COMBINED_EDGE.label, products: COMBINED_EDGE.products, textBytes: textBytesOf(COMBINED_EDGE),
        ebayValueBytesPerRow: ebayValueBytes(EBAY_TYPICAL), allocatedPeakMiB: allocatedOf(COMBINED_EDGE.label), livePeakMiB: combinedLive,
        liveOverLimit: combinedLive === null ? null : combinedLive > LIMIT_MIB, liveHeapMiBPerTextByteOverP0: combinedH,
        liveRuleBytesIfAnEdge: liveRule && combinedH !== null ? Math.min(CEILING_BYTES,
          floorToMillion((LIMIT_MIB - liveRule.p0MiB) / Math.max(liveRule.worstHeapMiBPerTextByte, combinedH))) : null };
      // Diagnostic (allocated): the 10,000-product stored edges over a baseline that has rows with own texts of one
      // character, so the cost of having own texts is not counted per byte.
      const textRowsBaseline = allocatedOf(`w6_rows_one_character_texts_${MAX_LISTING_SETTING_BULK_PRODUCTS}`);
      const allocatedStoredEdgesOverTextRows = textRowsBaseline === null ? null : TEXT_EDGES.filter((edge) => edge.stored !== null
        && edge.products === MAX_LISTING_SETTING_BULK_PRODUCTS).map((edge) => ({ label: edge.label,
        heapMiBPerTextByte: ((allocatedOf(edge.label) as number) - textRowsBaseline) / textBytesOf(edge) }));
      process.stdout.write(`${JSON.stringify({ measurement: "w6_stop_rule", gcBeforeRuns: collectGarbage !== null,
        maxBulkTextBytes: MAX_BULK_TEXT_BYTES, limitMiB: LIMIT_MIB, ceilingBytes: CEILING_BYTES,
        liveRule, allocatedRule, combinedEdge, allocatedStoredEdgesOverTextRows,
        diagnosticRuns: DIAGNOSTIC_RUNS.map((edge) => ({ label: edge.label, allocatedPeakMiB: allocatedOf(edge.label),
          livePeakMiB: liveOf(edge.label) })) })}\n`);
    });

    it("rolls back on a stale product, and on a failed clean-up the revisions, the ledger, the audits and every clean-up (PG 3)", async () => {
      await seedPolicyOverride({ sizeId: 101, fulfillment: "ship-a", label: "101" });
      await seedShelf({ sizeId: 102, label: "102" });
      await seedContent({ sizeId: 103, text: "Own words.", label: "103" });
      await bulk().saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("seed"), products: named([SECOND_PRODUCT]),
        patch: { textAbove: own("Seeded.") } });
      const revision = (await execute("SELECT revision_id FROM dropship.dropship_product_listing_settings WHERE product_id = $1", [SECOND_PRODUCT]))
        .rows[0].revision_id as number;
      const before = await allWrites();
      const ledgerBefore = await ledgerRows();
      // A shelf none changes both products; the policy, shelf and main text resets clean a leftover each.
      const patch = { shippingPolicy: null, storeShelf: { mode: "none" }, mainText: null };

      // Stale: the vendor saw product 8 before its row; one stale product refuses all, before any write.
      const stale = await expectDropshipError(bulk().saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("stale"),
        products: named([PRODUCT_7, SECOND_PRODUCT]), patch }), "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT");
      expect(stale.context).toMatchObject({ conflictCount: 1,
        conflicts: [{ productId: SECOND_PRODUCT, expectedRevisionId: null, actualRevisionId: revision }] });
      expect(await allWrites()).toEqual(before);
      expect(await ledgerRows()).toBe(ledgerBefore);

      // The last clean-up fails after the ledger, the revisions, the audits, the policy and the shelf clean-ups: all roll back.
      const fresh = named([PRODUCT_7, SECOND_PRODUCT], new Map([[SECOND_PRODUCT, revision]]));
      const failing = scopedPool(undefined, (sql) => {
        if (sql.startsWith("WITH target AS MATERIALIZED") && sql.includes("FROM dropship.dropship_listing_content_settings s")) {
          throw new Error("injected content clean-up failure");
        }
      });
      await expect(bulk(failing).saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("rolled-back"), products: fresh, patch }))
        .rejects.toThrow("injected content clean-up failure");
      expect(await allWrites()).toEqual(before);
      expect(await ledgerRows()).toBe(ledgerBefore);
      expect(await count("dropship.dropship_ebay_listing_policy_overrides", "fulfillment_policy_id = 'ship-a'")).toBe(1);
      expect(await count("dropship.dropship_ebay_store_category_assignments")).toBe(1);

      // The same change then commits as one: one ledger row, two revisions with their audits, one row and audit per cleared size.
      const saved = await bulk().saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("committed"), products: fresh, patch });
      expect(saved).toMatchObject({ outcome: "changed", productCount: 2, changedProductCount: 2, clearedSizeCount: 3 });
      expect(await allWrites()).toEqual({ ...before, productRevisions: before.productRevisions + 2, policyRevisions: before.policyRevisions + 1,
        shelfRevisions: before.shelfRevisions + 1, contentRevisions: before.contentRevisions + 1, audit: before.audit + 2 + 3 });
      expect(await ledgerRows()).toBe(ledgerBefore + 1);
    });

    it("answers a retry from the probe's ledger row as replayed, in exactly 7 statements, writing nothing (PG 4)", async () => {
      await seedShelf({ sizeId: 101, label: "101" });
      const body = { idempotencyKey: bulkKey("retry"), products: named([SECOND_PRODUCT, PRODUCT_7]), patch: { storeShelf: { mode: "none" } } };
      const first = await bulk().saveBulkForMember(MEMBER, STORE, body);
      expect(first).toMatchObject({ outcome: "changed", productCount: 2, changedProductCount: 2, clearedSizeCount: 1 });
      // Product 7's row moves after the commit; the retry is answered from the ledger, not checked again.
      const current = (await execute("SELECT revision_id FROM dropship.dropship_product_listing_settings WHERE product_id = $1", [PRODUCT_7]))
        .rows[0].revision_id as number;
      await bulk().saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("later"), products: named([PRODUCT_7], new Map([[PRODUCT_7, current]])),
        patch: { textBelow: own("Later.") } });
      const moved = await allWrites();
      const counter: StatementCounter = { statements: 0 };

      const retry = await bulk(scopedPool(counter)).saveBulkForMember(MEMBER, STORE, body);

      expect(retry).toEqual({ outcome: "replayed", requestId: first.requestId, productCount: 2, changedProductCount: null, clearedSizeCount: null });
      expect(await allWrites()).toEqual(moved);
      expect(await ledgerRows()).toBe(2);
      // BEGIN, request lock, store lock, owner rows, the gate's store read, the probe, COMMIT.
      expect(counter.statements).toBe(7);
    });

    it("leaves another vendor's and another store's per-size rows untouched (PG 5)", async () => {
      await addVendorStore(24);
      for (const [vendorId, storeId] of [[VENDOR, STORE], [11, OTHER_VENDOR_STORE], [VENDOR, 24]] as const) {
        await seedPolicyOverride({ vendorId, storeId, sizeId: 101, fulfillment: "ship-a", label: `${storeId}` });
        await seedShelf({ vendorId, storeId, sizeId: 102, label: `${storeId}` });
        await seedContent({ vendorId, storeId, sizeId: 103, text: "Own words.", label: `${storeId}` });
      }
      const result = await bulk().saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("scoped"), products: named([PRODUCT_7]),
        patch: { shippingPolicy: null, storeShelf: null, mainText: null } });

      expect(result).toMatchObject({ outcome: "changed", clearedSizeCount: 3 });
      for (const storeId of [OTHER_VENDOR_STORE, 24]) {
        expect(await count("dropship.dropship_ebay_listing_policy_overrides", "store_connection_id = $1 AND fulfillment_policy_id = 'ship-a'", [storeId])).toBe(1);
        expect(await count("dropship.dropship_ebay_store_category_assignments", "store_connection_id = $1", [storeId])).toBe(1);
        expect(await count("dropship.dropship_listing_content_revisions", "store_connection_id = $1", [storeId])).toBe(1);
      }
      expect(await count("dropship.dropship_ebay_listing_policy_overrides", "store_connection_id = $1", [STORE])).toBe(0);
      expect(await count("dropship.dropship_ebay_store_category_assignments", "store_connection_id = $1", [STORE])).toBe(0);
    });

    it("refuses a paused store and another vendor's store, writing nothing (PG 6)", async () => {
      await execute("UPDATE dropship.dropship_store_connections SET status = 'paused' WHERE id = $1", [STORE]);
      const body = { idempotencyKey: bulkKey("paused"), products: named([PRODUCT_7]), patch: { storeShelf: { mode: "none" } } };
      const paused = await expectDropshipError(bulk().saveBulkForMember(MEMBER, STORE, body), "DROPSHIP_LISTING_STORE_BLOCKED");
      expect(paused.context).toMatchObject({ storeConnectionId: STORE, reason: "paused", classification: "permanent" });
      await expectDropshipError(bulk().saveBulkForMember(MEMBER, OTHER_VENDOR_STORE, { ...body, idempotencyKey: bulkKey("not-mine") }),
        "DROPSHIP_STORE_CONNECTION_REQUIRED");
      expect(await allWrites()).toEqual({ productRevisions: 0, priceRevisions: 0, policyRevisions: 0, shelfRevisions: 0, contentRevisions: 0, audit: 0 });
      expect(await ledgerRows()).toBe(0);
    });

    describe("concurrency (PG 7)", () => {
      it("(a) answers a second W6 through the same service with BUSY while the first holds the gate, without taking a connection", async () => {
        let connections = 0;
        const paused = gate((sql) => sql === "COMMIT");
        const inner = scopedPool(undefined, paused.hook);
        const counting = { ...inner, connect: async () => { connections += 1; return inner.connect(); } } as unknown as Pool;
        const service = bulk(counting);
        const first = service.saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("held"), products: named([PRODUCT_7]),
          patch: { storeShelf: { mode: "none" } } });
        try {
          await within(paused.reached, "the first W6's commit");
          const busy = await expectDropshipError(service.saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("refused"),
            products: named([SECOND_PRODUCT]), patch: { storeShelf: { mode: "none" } } }), "DROPSHIP_LISTING_SETTINGS_BUSY");
          expect(busy.context).toMatchObject({ reason: "heavy_write_in_progress", retryAfterSeconds: 5, classification: "transient" });
          expect(connections).toBe(1);
          paused.open();
          await expect(within(first, "the first W6")).resolves.toMatchObject({ outcome: "changed" });
        } finally {
          paused.open();
          await within(Promise.allSettled([first]), "the gate case's clean-up");
        }
        expect(await ledgerRows()).toBe(1);
      });

      it("(b) makes a W5 on one of its products wait on the store lock, then see the W6 commit", async () => {
        const paused = gate((sql) => sql === "COMMIT");
        const w6 = bulk(scopedPool(undefined, paused.hook)).saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("before-w5"),
          products: named([PRODUCT_7, SECOND_PRODUCT]), patch: { storeShelf: { mode: "none" } } });
        let w5: Promise<unknown> | undefined;
        let outcome: unknown;
        try {
          await within(paused.reached, "the W6 commit");
          w5 = products().saveForMember(MEMBER, STORE, PRODUCT_7, { idempotencyKey: productKey("after-w6"), expectedRevisionId: null,
            patch: { storeShelf: null } }).then(() => null, (reason: unknown) => reason);
          await waitUntilLockWait("dropship_listing_push_job", 1);
          paused.open();
          await expect(within(w6, "W6")).resolves.toMatchObject({ outcome: "changed", changedProductCount: 2 });
          outcome = await within(w5, "W5");
        } finally {
          paused.open();
          await within(Promise.allSettled([w6, ...(w5 ? [w5] : [])]), "the W5-after-W6 case's clean-up");
        }
        const written = (await execute("SELECT revision_id FROM dropship.dropship_product_listing_settings WHERE product_id = $1", [PRODUCT_7]))
          .rows[0].revision_id as number;
        expect(outcome).toMatchObject({ code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
          context: { conflicts: [{ productId: PRODUCT_7, expectedRevisionId: null, actualRevisionId: written }] } });
      });

      it("(c) serializes one key sent twice at once: the same body replays from the ledger, another body is a conflict, another store too", async () => {
        const body = { idempotencyKey: bulkKey("twice"), products: named([PRODUCT_7]), patch: { storeShelf: { mode: "none" } } };
        const paused = gate((sql) => sql === "COMMIT");
        const first = bulk(scopedPool(undefined, paused.hook)).saveBulkForMember(MEMBER, STORE, body);
        let second: Promise<unknown> | undefined;
        let third: Promise<unknown> | undefined;
        try {
          await within(paused.reached, "the first W6's commit");
          // Other service instances, each with its own gate (as on a second dyno), so they reach the request lock.
          second = bulk().saveBulkForMember(MEMBER, STORE, body);
          third = bulk().saveBulkForMember(MEMBER, STORE, { ...body, patch: { storeShelf: null } }).then(() => null, (reason: unknown) => reason);
          await waitUntilLockWait("dropship_listing_settings_request", 2);
          paused.open();
          const written = await within(first, "the first W6");
          expect(written).toMatchObject({ outcome: "changed" });
          await expect(within(second, "the same body")).resolves.toEqual({ ...(written as object), outcome: "replayed",
            changedProductCount: null, clearedSizeCount: null });
          await expect(within(third, "another body")).resolves.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT",
            context: { mismatched: ["ledger.requestHash"] } });
        } finally {
          paused.open();
          await within(Promise.allSettled([first, ...(second ? [second] : []), ...(third ? [third] : [])]), "the same-key case's clean-up");
        }
        expect(await ledgerRows()).toBe(1);

        await addVendorStore(24);
        const otherStore = await expectDropshipError(bulk().saveBulkForMember(MEMBER, 24, body), "DROPSHIP_IDEMPOTENCY_CONFLICT");
        expect(otherStore.context?.mismatched).toEqual(["ledger.requestHash", "ledger.storeConnectionId"]);
      });
    });

    it("answers a reset naming a product Card Shellz deleted without a fault: left out of the write and the clean-up (PG 8)", async () => {
      await seedPolicyOverride({ sizeId: 101, fulfillment: "ship-a", label: "101" });
      const withOthers = await bulk().saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("deleted-and-7"),
        products: named([PRODUCT_7, MISSING_PRODUCT]), patch: { shippingPolicy: null } });
      expect(withOthers).toMatchObject({ outcome: "changed", productCount: 2, changedProductCount: 0, clearedSizeCount: 1 });

      const alone = await bulk().saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("deleted-alone"),
        products: named([MISSING_PRODUCT]), patch: { shippingPolicy: null, mainText: null } });
      expect(alone).toMatchObject({ outcome: "unchanged", productCount: 1, changedProductCount: 0, clearedSizeCount: 0 });
      // The ledger row is written either way (plan D12), so a retry replays.
      expect(await ledgerRows()).toBe(2);
      expect(log.info).toHaveBeenLastCalledWith("dropship.listing_settings.products_bulk_saved", expect.objectContaining({ outcome: "unchanged" }));

      // A value for the deleted product is the writer's foreign key, answered as not found, naming it; nothing written.
      const before = { ...(await allWrites()), ledger: await ledgerRows() };
      const value = await expectDropshipError(bulk().saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("deleted-value"),
        products: named([PRODUCT_7, MISSING_PRODUCT]), patch: { textAbove: own("Above.") } }), "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND");
      expect(value.context).toMatchObject({ productId: MISSING_PRODUCT, classification: "permanent" });
      expect({ ...(await allWrites()), ledger: await ledgerRows() }).toEqual(before);
    });

    it("refuses a set text that carries the store to exactly cap + 1, writing nothing, and saves it on one product fewer, at the cap (PG 9)", async () => {
      const ROWS = 10_000;
      const ROOM = 10;
      const PART = MAX_STORE_LISTING_TEXT_BYTES / ROWS / 2;
      expect(Number.isInteger(PART)).toBe(true);
      const seeded = await seedCatalogProducts(EDGE_FIRST_PRODUCT, ROWS);
      await seedStoredTexts(seeded.slice(1), "a".repeat(PART), "b".repeat(PART));
      // The first product is ROOM bytes short, so the store sits ROOM bytes under the cap.
      await seedStoredTexts(seeded.slice(0, 1), "a".repeat(PART), "b".repeat(PART - ROOM));
      // A one-byte text on ROOM + 1 products is one byte over; on ROOM products it lands exactly at the cap.
      const targets = await seedCatalogProducts(EDGE_FIRST_PRODUCT + ROWS, ROOM + 1);
      const before = { ...(await allWrites()), ledger: await ledgerRows() };

      const refused = await expectDropshipError(bulk().saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("over-cap"),
        products: named(targets), patch: { textAbove: own("S") } }), "DROPSHIP_LISTING_SETTINGS_TOO_LARGE");
      expect(refused.context).toMatchObject({ reason: "store_text_limit", textBytes: MAX_STORE_LISTING_TEXT_BYTES + 1,
        maxTextBytes: MAX_STORE_LISTING_TEXT_BYTES });
      expect({ ...(await allWrites()), ledger: await ledgerRows() }).toEqual(before);

      const saved = await bulk().saveBulkForMember(MEMBER, STORE, { idempotencyKey: bulkKey("at-cap"),
        products: named(targets.slice(0, ROOM)), patch: { textAbove: own("S") } });
      expect(saved).toMatchObject({ outcome: "changed", changedProductCount: ROOM });
      expect(log.info).toHaveBeenLastCalledWith("dropship.listing_settings.products_bulk_saved", expect.objectContaining({
        store_text_bytes: MAX_STORE_LISTING_TEXT_BYTES, text_bytes: ROOM }));
    }, BULK_TEST_TIMEOUT_MS);
  });

  describe("W12, one category (PUT …/categories/:categoryId, plan PR 9, section 8)", () => {
    /** A second Toploaders product, with one size; product 9 starts in no category. */
    const SECOND_PRODUCT = 8;
    const SECOND_SIZE = 105;
    const OUTSIDE_PRODUCT = 9;
    const categoryKey = (label: string) => `category-settings:${label}`;
    /** One service over one gate, as the factory builds them. */
    const categories = (repositoryPool: Pool = scopedPool(), heavyWrites = new ListingSettingHeavyWriteGate()) =>
      new DropshipListingCategorySettingsService({ repository: new PgDropshipListingSettingWritesRepository(repositoryPool), ebay: fakeEbay,
        heavyWrites, clock: { now: () => NOW }, timer: () => performance.now(), log });
    const save = (body: Record<string, unknown>, repositoryPool?: Pool, storeId = STORE) =>
      categories(repositoryPool).saveForMember(MEMBER, storeId, TOPLOADERS, body);
    const body = (label: string, fields: Record<string, unknown> = {}) =>
      ({ idempotencyKey: categoryKey(label), expectedRevisionId: null, patch: { storeShelf: { mode: "none" } }, ...fields });

    /** A product's own row through 8a's writer, as a W5 save leaves it; its revision id. */
    async function saveOwn(productId: number, patch: ProductListingSettingPatch, label: string): Promise<number> {
      const saved = await new PgDropshipListingSettingWritesRepository(scopedPool()).execute(
        { memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: `seed-own:${label}` },
        (tx) => tx.saveProduct({ productId, expectedRevisionId: null, patch, requestHash: "d".repeat(64), now: NOW }));
      return saved.row!.revisionId;
    }
    async function categoryWrites() {
      return {
        ...(await allWrites()),
        categoryRevisions: await count("dropship.dropship_category_listing_setting_revisions"),
        categoryRows: await count("dropship.dropship_category_listing_settings"),
        ledger: await count("dropship.dropship_product_listing_setting_requests"),
        policyRows: await count("dropship.dropship_ebay_listing_policy_overrides"),
        shelfRows: await count("dropship.dropship_ebay_store_category_assignments"),
      };
    }

    beforeEach(async () => {
      ebayCalls.length = 0;
      await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type)
        VALUES ($1, 'TL-2', 'Toploader 2', 'Toploaders', $3, 'toploader'), ($2, 'SL', 'Sleeves', 'Sleeves', NULL, 'sleeve')`,
      [SECOND_PRODUCT, OUTSIDE_PRODUCT, TOPLOADERS]);
      await execute(`INSERT INTO catalog.product_variants (id, product_id, sku, name, sales_eligibility)
        VALUES ($1, $2, 'TL2-25', 'Pack of 25', 'sellable'), (106, $3, 'SL-25', 'Pack of 25', 'sellable')`,
      [SECOND_SIZE, SECOND_PRODUCT, OUTSIDE_PRODUCT]);
    });

    it("clears theirs with the category in one commit with every audit row, and rolls all of it back when a clean-up fails (PG 1)", async () => {
      // Product 7 holds its own shelf and text above, and size 101 a return policy; product 8 only leftovers on size 105.
      const own7 = await saveOwn(PRODUCT_7, { storeShelf: { mode: "none" }, textAbove: { mode: "own", text: "Product above." } }, "pg1-7");
      await seedPolicyOverride({ sizeId: 101, fulfillment: null, returnPolicy: "ret-101", label: "pg1-101" });
      await seedPolicyOverride({ sizeId: SECOND_SIZE, fulfillment: null, returnPolicy: "ret-105", label: "pg1-105" });
      await seedShelf({ sizeId: SECOND_SIZE, label: "pg1-105" });
      const request = body("pg1", { patch: { storeShelf: { mode: "none" }, returnPolicy: { id: "return-new" },
        textAbove: { mode: "own", text: "Category above." } }, clear: { fields: ["storeShelf", "returnPolicy", "textAbove"],
        products: [{ productId: SECOND_PRODUCT, expectedRevisionId: null }, { productId: PRODUCT_7, expectedRevisionId: own7 }] } });
      const before = await categoryWrites();

      // A failure in the shelf clean-up, after the category row, the products' clear and the policy clean-up were written.
      const failing = scopedPool(undefined, (sql) => {
        if (sql.startsWith("WITH target AS MATERIALIZED") && sql.includes("dropship_ebay_store_category_assignments a")) {
          throw new Error("injected shelf clean-up failure");
        }
      });
      await expect(save(request, failing)).rejects.toThrow("injected shelf clean-up failure");
      expect(await categoryWrites()).toEqual(before);
      // The failed attempt asked eBay too; count only the retry's calls.
      ebayCalls.length = 0;

      const statements: string[] = [];
      const result = await save(request, scopedPool(undefined, (sql) => { statements.push(sql); }));

      expect(result).toEqual({ outcome: "changed", categoryId: TOPLOADERS, revisionId: expect.any(Number), clearedProductCount: 2 });
      expect(ebayCalls).toEqual(["discover"]);
      const category = await execute(`SELECT category_name, idempotency_key, shelf_mode, return_policy_id, return_policy_name, text_above
        FROM dropship.dropship_category_listing_setting_revisions`);
      expect(category.rows).toEqual([{ category_name: "Toploaders", idempotency_key: categoryKey("pg1"), shelf_mode: "none",
        return_policy_id: "return-new", return_policy_name: "Thirty days", text_above: "Category above." }]);
      const ledger = await execute("SELECT operation, product_count FROM dropship.dropship_product_listing_setting_requests");
      expect(ledger.rows).toEqual([{ operation: "category_settings_clear", product_count: 1 }]);
      // Product 7's row loses its own values; product 8 had no row, so it has none (a no-op merge, plan P20).
      const products = await execute(`SELECT r.product_id, r.shelf_mode, r.text_above_mode, r.request_id IS NOT NULL AS bulk
        FROM dropship.dropship_product_listing_settings s JOIN dropship.dropship_product_listing_setting_revisions r ON r.id = s.revision_id`);
      expect(products.rows).toEqual([{ product_id: PRODUCT_7, shelf_mode: null, text_above_mode: null, bulk: true }]);
      expect(await categoryWrites()).toMatchObject({ policyRows: 0, shelfRows: 0, categoryRows: 1 });
      const audits = await execute(`SELECT event_type, count(*)::int AS n FROM dropship.dropship_audit_events
        WHERE created_at = $1 AND actor_id = $2 GROUP BY event_type ORDER BY event_type`, [NOW, MEMBER]);
      expect(audits.rows).toEqual([
        { event_type: "category_listing_settings_saved", n: 1 },
        { event_type: "ebay_listing_policy_override_replaced", n: 2 },
        { event_type: "ebay_store_category_assignment_replaced", n: 1 },
        // The seeded own row and the clear's.
        { event_type: "product_listing_settings_saved", n: 2 },
      ]);
      // The lock order of plan 8.6: lockCatalog (category, then products), the feature locks, then the rows.
      const index = (match: (sql: string) => boolean) => statements.findIndex(match);
      const order = [
        index((sql) => sql.startsWith("SELECT id FROM catalog.product_categories WHERE id = ANY")),
        index((sql) => sql.startsWith("SELECT id FROM catalog.products WHERE id = ANY")),
        index((sql) => sql.includes("hashtext('dropship_ebay_listing_policy_override')")),
        index((sql) => sql.includes("hashtext('dropship_ebay_store_category_assignment')")),
        index((sql) => sql.includes("FROM dropship.dropship_category_listing_settings s") && sql.includes("FOR UPDATE OF s")),
        index((sql) => sql.includes("FROM dropship.dropship_product_listing_settings s") && sql.includes("FOR UPDATE OF s")),
      ];
      expect(order.every((position) => position >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.category_saved", expect.objectContaining({
        outcome: "changed", category_id: TOPLOADERS, cleared_product_count: 2, cleared_size_count: 2,
        cleared_fields: ["storeShelf", "returnPolicy", "textAbove"], ebay_ms: expect.any(Number) }));
    });

    it("refuses a store that holds older group rules with nothing written (D16, PG 2)", async () => {
      await setStoreDefault({ ...D1, groups: [{ id: "g1", name: "Group", priority: 1, scope: { type: "product", productId: PRODUCT_7 },
        recipe: D1.defaultRecipe }] });
      const before = await categoryWrites();
      const pricing = await expectDropshipError(save(body("pg2-pricing")), "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT");
      expect(pricing.context).toMatchObject({ pricingGroups: 1, contentGroups: 0, ebayCategoryRules: 0 });

      await setStoreDefault(D1);
      const revision = await execute(`INSERT INTO dropship.dropship_ebay_category_rule_revisions
        (vendor_id, store_connection_id, previous_revision_id, profile, idempotency_key, request_hash, actor_id, created_at)
        VALUES ($1, $2, NULL, $3::jsonb, 'seed-rules', $4, $5, $6) RETURNING id`, [VENDOR, STORE, JSON.stringify({ version: 1,
        defaultCategory: null, rules: [{ id: "r1", name: "Rule", scope: { type: "product", productId: PRODUCT_7 },
          category: { categoryId: "183438", categoryName: "Toploaders", path: ["Toploaders"] } }] }), "c".repeat(64), MEMBER, NOW]);
      await execute(`INSERT INTO dropship.dropship_ebay_category_rule_profiles (vendor_id, store_connection_id, revision_id)
        VALUES ($1, $2, $3)`, [VENDOR, STORE, revision.rows[0].id]);
      const rules = await expectDropshipError(save(body("pg2-rules")), "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT");
      expect(rules.context).toMatchObject({ pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 1 });
      expect({ ...(await categoryWrites()), audit: before.audit }).toEqual({ ...before, audit: before.audit });
      expect(await count("dropship.dropship_category_listing_setting_revisions")).toBe(0);
    });

    it("compares and sets the category: a stale revision is a 409 with nothing written, the clear included (PG 3)", async () => {
      const first = await save(body("pg3-first"));
      expect(first).toMatchObject({ outcome: "changed", revisionId: expect.any(Number) });
      const own7 = await saveOwn(PRODUCT_7, { storeShelf: { mode: "none" } }, "pg3-7");
      const before = await categoryWrites();

      const stale = await expectDropshipError(save(body("pg3-stale", { patch: { storeShelf: { mode: "none" }, textBelow: { mode: "none" } },
        clear: { fields: ["storeShelf"], products: [{ productId: PRODUCT_7, expectedRevisionId: own7 }] } })),
      "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT");
      expect(stale.context).toMatchObject({ categoryId: TOPLOADERS, expectedRevisionId: null, actualRevisionId: first.revisionId });
      expect(await categoryWrites()).toEqual(before);

      // With the revision it saw, the same change saves.
      await expect(save(body("pg3-current", { expectedRevisionId: first.revisionId, patch: { storeShelf: { mode: "none" },
        textBelow: { mode: "none" } }, clear: { fields: ["storeShelf"], products: [{ productId: PRODUCT_7, expectedRevisionId: own7 }] } })))
        .resolves.toMatchObject({ outcome: "changed", clearedProductCount: 1 });
    });

    it("answers a clear-only request's retry from its ledger row, in exactly 7 statements, writing nothing (PG 4)", async () => {
      const first = await save(body("pg4-category"));
      const own7 = await saveOwn(PRODUCT_7, { storeShelf: { mode: "none" } }, "pg4-7");
      // Clear only: the category's shelf re-sent (unchanged) and the product's own shelf cleared.
      const clearOnly = body("pg4-clear", { expectedRevisionId: first.revisionId,
        clear: { fields: ["storeShelf"], products: [{ productId: PRODUCT_7, expectedRevisionId: own7 }] } });
      const written = await save(clearOnly);
      expect(written).toEqual({ outcome: "changed", categoryId: TOPLOADERS, revisionId: first.revisionId, clearedProductCount: 1 });
      expect(await count("dropship.dropship_category_listing_setting_revisions")).toBe(1);
      expect(await count("dropship.dropship_product_listing_setting_requests", "idempotency_key = $1", [categoryKey("pg4-clear")])).toBe(1);
      const before = await categoryWrites();

      const counter: StatementCounter = { statements: 0 };
      const replay = await save(clearOnly, scopedPool(counter));

      // The key wrote no category revision (the category was unchanged), yet the replay answers what the request answered:
      // the revision the request expected, which 8a's compare-and-set had found.
      expect(replay).toEqual({ outcome: "replayed", categoryId: TOPLOADERS, revisionId: written.revisionId, clearedProductCount: null });
      expect(log.info).toHaveBeenLastCalledWith("dropship.listing_settings.category_saved", expect.objectContaining({
        outcome: "replayed", before: [], after: [], changed_count: 0 }));
      expect(counter.statements).toBe(7);
      expect(await categoryWrites()).toEqual(before);
      // A key reused for another change is a conflict.
      await expect(expectDropshipError(save({ ...clearOnly, patch: { storeShelf: null, textAbove: { mode: "none" } },
        clear: { fields: ["textAbove"], products: [{ productId: PRODUCT_7, expectedRevisionId: own7 }] } }),
      "DROPSHIP_IDEMPOTENCY_CONFLICT")).resolves.toMatchObject({ context: { mismatched: ["ledger.requestHash"] } });
    });

    it("clears leftovers for this vendor and store only (PG 5)", async () => {
      await addVendorStore(24);
      await seedShelf({ sizeId: 101, label: "pg5-mine" });
      await seedShelf({ vendorId: 11, storeId: OTHER_VENDOR_STORE, sizeId: 101, label: "pg5-other-vendor" });
      await seedShelf({ storeId: 24, sizeId: 101, label: "pg5-other-store" });
      await seedPolicyOverride({ storeId: 24, sizeId: 102, fulfillment: null, returnPolicy: "ret-24", label: "pg5-other-store" });

      await expect(save(body("pg5", { clear: { fields: ["storeShelf"], products: [{ productId: PRODUCT_7, expectedRevisionId: null }] } })))
        .resolves.toMatchObject({ outcome: "changed", clearedProductCount: 1 });

      const shelves = await execute(`SELECT vendor_id, store_connection_id, product_variant_id FROM dropship.dropship_ebay_store_category_assignments
        ORDER BY vendor_id, store_connection_id`);
      expect(shelves.rows).toEqual([{ vendor_id: VENDOR, store_connection_id: 24, product_variant_id: 101 },
        { vendor_id: 11, store_connection_id: OTHER_VENDOR_STORE, product_variant_id: 101 }]);
      expect(await count("dropship.dropship_ebay_listing_policy_overrides", "store_connection_id = 24")).toBe(1);
      expect(await count("dropship.dropship_ebay_store_category_assignment_revisions", "idempotency_key LIKE 'ls:%'")).toBe(1);
      expect(await count("dropship.dropship_ebay_store_category_assignment_revisions", "idempotency_key LIKE 'ls:%' AND store_connection_id = $1",
        [STORE])).toBe(1);
    });

    describe("concurrency (PG 7)", () => {
      it("(a) makes a Card Shellz category rename wait behind its category FOR SHARE; the revision keeps the committed name", async () => {
        const paused = gate((sql) => sql.startsWith("SELECT id FROM catalog.products WHERE id = ANY"));
        const w12 = save(body("pg7a"), scopedPool(undefined, paused.hook));
        let rename: Promise<unknown> | undefined;
        try {
          await within(paused.reached, "W12's product lock");
          rename = execute("UPDATE catalog.product_categories SET name = 'Renamed toploaders' WHERE id = $1", [TOPLOADERS]);
          await waitUntilLockWait("Renamed toploaders", 1);
          paused.open();
          await expect(within(w12, "W12")).resolves.toMatchObject({ outcome: "changed" });
          await within(rename, "the rename");
        } finally {
          paused.open();
          await within(Promise.allSettled([w12, ...(rename ? [rename] : [])]), "the rename case's clean-up");
        }
        const stored = await execute("SELECT category_name FROM dropship.dropship_category_listing_setting_revisions");
        expect(stored.rows).toEqual([{ category_name: "Toploaders" }]);
        const live = await execute("SELECT name FROM catalog.product_categories WHERE id = $1", [TOPLOADERS]);
        expect(live.rows).toEqual([{ name: "Renamed toploaders" }]);
      });

      it("(b) sees a description group a content save commits while it waits on the store lock: 409 OLDER_RULES_PRESENT", async () => {
        let saved!: () => void;
        const profileSaved = new Promise<void>((done) => { saved = done; });
        let open!: () => void;
        const held = new Promise<void>((done) => { open = done; });
        const content = new PgDropshipListingContentRepository(scopedPool()).execute(
          { memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: "content-group:pg7b" }, async (tx) => {
            await tx.saveProfile({ expectedRevisionId: null, idempotencyKey: "content-group:pg7b", profile: {
              defaultTemplate: { introduction: "", footer: "" },
              groups: [{ id: "g1", name: "Group", priority: 1, scope: { type: "product", productId: PRODUCT_7 },
                template: { introduction: "Group above.", footer: "" } }] } }, "e".repeat(64), NOW);
            saved();
            await held;
          });
        let w12: Promise<unknown> | undefined;
        let outcome: unknown;
        try {
          await within(profileSaved, "the content save");
          w12 = save(body("pg7b")).then(() => null, (reason: unknown) => reason);
          await waitUntilLockWait("dropship_listing_push_job", 1);
          open();
          await within(content, "the content save's commit");
          outcome = await within(w12, "W12");
        } finally {
          open();
          await within(Promise.allSettled([content, ...(w12 ? [w12] : [])]), "the content race case's clean-up");
        }
        expect(outcome).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT",
          context: { pricingGroups: 0, contentGroups: 1, ebayCategoryRules: 0 } });
        expect(await count("dropship.dropship_category_listing_setting_revisions")).toBe(0);
      });

      it("(c) answers a product Card Shellz moves into the category between the read and the lock with 409 when clearing", async () => {
        const own7 = await saveOwn(PRODUCT_7, { storeShelf: { mode: "none" } }, "pg7c-7");
        let moved = false;
        const racing = scopedPool(undefined, async (sql) => {
          if (moved || !sql.startsWith("LOCK TABLE dropship.dropship_catalog_rules")) return;
          moved = true;
          await execute("UPDATE catalog.products SET category_id = $1 WHERE id = $2", [TOPLOADERS, OUTSIDE_PRODUCT]);
        });
        const before = await categoryWrites();

        const error = await expectDropshipError(save(body("pg7c", { clear: { fields: ["storeShelf"],
          products: [{ productId: PRODUCT_7, expectedRevisionId: own7 }] } }), racing), "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT");

        expect(moved).toBe(true);
        expect(error.context).toMatchObject({ categoryId: TOPLOADERS, conflicts: [{ productId: OUTSIDE_PRODUCT }], conflictCount: 1 });
        expect(await categoryWrites()).toEqual(before);
      });

      it("(d) holds the feature locks from the leftover read: an old policy writer waits, or commits first and makes the set differ", async () => {
        await seedPolicyOverride({ sizeId: 101, fulfillment: null, returnPolicy: "ret-101", label: "pg7d-101" });
        const clearReturns = (label: string) => body(label, { patch: { returnPolicy: { id: "return-new" } },
          clear: { fields: ["returnPolicy"], products: [{ productId: PRODUCT_7, expectedRevisionId: null }] } });
        const oldWriter = (label: string, repositoryPool: Pool = scopedPool()) => new PgDropshipEbayListingPolicyOverrideRepository(repositoryPool)
          .replaceAssignment({ vendorId: VENDOR, storeConnectionId: STORE, productVariantId: SECOND_SIZE, expectedRevisionId: null,
            fulfillmentPolicyId: null, returnPolicyId: "ret-105", paymentPolicyId: null, idempotencyKey: `old-policy-writer:${label}`,
            requestHash: "e".repeat(64), actor: { actorType: "vendor", actorId: MEMBER }, now: NOW });

        // 1. W12 holds both feature locks (paused right before its leftover read); the old writer waits on the policy one.
        const paused = gate((sql) => sql.startsWith("SELECT o.product_variant_id"));
        const w12 = save(clearReturns("pg7d-wait"), scopedPool(undefined, paused.hook));
        let writer: Promise<unknown> | undefined;
        try {
          await within(paused.reached, "W12's leftover read");
          writer = oldWriter("wait");
          await waitUntilLockWait("dropship_ebay_listing_policy_override", 1);
          paused.open();
          // W12 commits with the set it derived, and its clean-up's second request for the held locks returned at once.
          await expect(within(w12, "W12")).resolves.toMatchObject({ outcome: "changed", clearedProductCount: 1 });
          await expect(within(writer, "the old writer")).resolves.toMatchObject({ idempotentReplay: false });
        } finally {
          paused.open();
          await within(Promise.allSettled([w12, ...(writer ? [writer] : [])]), "the waiting case's clean-up");
        }
        const rows = await execute(`SELECT product_variant_id, return_policy_id FROM dropship.dropship_ebay_listing_policy_overrides
          ORDER BY product_variant_id`);
        expect(rows.rows).toEqual([{ product_variant_id: SECOND_SIZE, return_policy_id: "ret-105" }]);

        // 2. The old writer commits before W12's leftover read: W12 sees the new leftover, the set differs, 409; no deadlock.
        await execute("DELETE FROM dropship.dropship_ebay_listing_policy_overrides");
        await seedPolicyOverride({ sizeId: 101, fulfillment: null, returnPolicy: "ret-101", label: "pg7d-101-again" });
        let ranFirst = false;
        const before = scopedPool(undefined, async (sql) => {
          if (ranFirst || !sql.includes("hashtext('dropship_ebay_listing_policy_override')")) return;
          ranFirst = true;
          await within(oldWriter("first"), "the old writer, first");
        });
        const error = await expectDropshipError(within(save(clearReturns("pg7d-first"), before), "W12 after the writer"),
          "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT");
        expect(ranFirst).toBe(true);
        expect(error.context).toMatchObject({ conflicts: [{ productId: SECOND_PRODUCT }], conflictCount: 1 });
        expect(await count("dropship.dropship_ebay_listing_policy_overrides")).toBe(2);
      });

      it("(e) serializes one key sent twice at once: the same body replays, another body is a conflict, another store too (plan 3.12 #7)", async () => {
        const request = body("pg7e");
        const paused = gate((sql) => sql === "COMMIT");
        const first = save(request, scopedPool(undefined, paused.hook));
        let second: Promise<unknown> | undefined;
        let third: Promise<unknown> | undefined;
        try {
          await within(paused.reached, "the first save's commit");
          second = save(request);
          third = save({ ...request, patch: { storeShelf: null } }).then(() => null, (reason: unknown) => reason);
          await waitUntilLockWait("dropship_listing_settings_request", 2);
          paused.open();
          const written = await within(first, "the first save");
          expect(written).toMatchObject({ outcome: "changed" });
          await expect(within(second, "the same body")).resolves.toEqual({ ...(written as object), outcome: "replayed", clearedProductCount: null });
          await expect(within(third, "another body")).resolves.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT",
            context: { mismatched: ["categoryRevision.requestHash"] } });
        } finally {
          paused.open();
          await within(Promise.allSettled([first, ...(second ? [second] : []), ...(third ? [third] : [])]), "the same-key case's clean-up");
        }
        expect(await count("dropship.dropship_category_listing_setting_revisions")).toBe(1);
        await addVendorStore(24);
        const otherStore = await expectDropshipError(save(request, undefined, 24), "DROPSHIP_IDEMPOTENCY_CONFLICT");
        expect(otherStore.context?.mismatched).toEqual(["categoryRevision.requestHash", "categoryRevision.storeConnectionId"]);
      });
    });

    /*
     * PG 8 (v3r, C-feas-2): a clear of 10,000 products at the text edge, the budget's bytes stored two-byte (one U+2019 a
     * text), measured as 9d's edges are (time, statements, heap; its live peak with the opt-in diagnostics, the input of
     * plan 3.10's rule). Logged, never asserted. W12's worst clear: the rows also hold EBAY_TYPICAL's eBay values (9d's
     * combined edge's rows), and the clear names the shelf, not a text, so every new revision copies both stored texts
     * and every other eBay value, and the shelf clean-up runs over all 10,000 products.
     */
    const EDGE_PRODUCTS = MAX_LISTING_SETTING_BULK_PRODUCTS;
    const EDGE_FIRST_PRODUCT = 50_001;
    const EDGE_FIRST_SIZE = 500_001;
    const PART_BYTES = MAX_BULK_TEXT_BYTES / (2 * EDGE_PRODUCTS);
    const TWO_BYTE_TEXT = `${"a".repeat(PART_BYTES - 3)}’`;

    async function runClearEdge(mode: "rule" | "live"): Promise<void> {
      await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type)
        SELECT g, 'CLR-' || g, 'Clear product ' || g, 'Toploaders', $3, 'toploader' FROM generate_series($1::int, $2::int) g`,
      [EDGE_FIRST_PRODUCT, EDGE_FIRST_PRODUCT + EDGE_PRODUCTS - 1, TOPLOADERS]);
      await execute(`INSERT INTO catalog.product_variants (id, product_id, sku, name, sales_eligibility)
        SELECT $1::int + i, $2::int + i, 'CLR-SIZE-' || i, 'Size ' || i, 'sellable' FROM generate_series(0, $3::int - 1) i`,
      [EDGE_FIRST_SIZE, EDGE_FIRST_PRODUCT, EDGE_PRODUCTS]);
      const ebay = EBAY_TYPICAL;
      await execute(`INSERT INTO dropship.dropship_product_listing_setting_revisions
        (vendor_id, store_connection_id, product_id, previous_revision_id, request_id, text_above_mode, text_above, text_below_mode, text_below,
         ebay_category_id, ebay_category_name, ebay_category_path, shelf_mode, shelf_ids, shelf_names,
         fulfillment_policy_id, fulfillment_policy_name, return_policy_id, return_policy_name, payment_policy_id, payment_policy_name,
         idempotency_key, request_hash, actor_type, actor_id, created_at)
        SELECT $1, $2, p, NULL, NULL, 'own', $3, 'own', $3, $8, $9, $10::jsonb, 'own', $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17, $18,
          'seed-clear:' || p, $4, 'vendor', 'seed', $5
        FROM generate_series($6::int, $7::int) p`,
      [VENDOR, STORE, TWO_BYTE_TEXT, "d".repeat(64), NOW, EDGE_FIRST_PRODUCT, EDGE_FIRST_PRODUCT + EDGE_PRODUCTS - 1,
        ebay.category.categoryId, ebay.category.categoryName, JSON.stringify(ebay.category.path),
        JSON.stringify(ebay.shelves.map((shelf) => shelf.id)), JSON.stringify(ebay.shelves.map((shelf) => shelf.name)),
        ebay.shipping.id, ebay.shipping.name, ebay.returns.id, ebay.returns.name, ebay.payment.id, ebay.payment.name]);
      await execute(`INSERT INTO dropship.dropship_product_listing_settings (vendor_id, store_connection_id, product_id, revision_id)
        SELECT vendor_id, store_connection_id, product_id, id FROM dropship.dropship_product_listing_setting_revisions
        WHERE idempotency_key LIKE 'seed-clear:%'`);
      await execute("ANALYZE dropship.dropship_product_listing_settings, dropship.dropship_product_listing_setting_revisions, catalog.products, catalog.product_variants");
      const revisions = await execute(`SELECT product_id, revision_id FROM dropship.dropship_product_listing_settings
        WHERE product_id >= $1 ORDER BY product_id`, [EDGE_FIRST_PRODUCT]);
      const products = revisions.rows.map((row) => ({ productId: row.product_id as number, expectedRevisionId: row.revision_id as number }));
      const textBytes = EDGE_PRODUCTS * 2 * Buffer.byteLength(TWO_BYTE_TEXT, "utf8");
      expect(textBytes).toBe(MAX_BULK_TEXT_BYTES);

      const counter: StatementCounter = { statements: 0 };
      const probe = mode === "live" ? liveHeapProbe() : null;
      collectGarbage?.();
      const liveStart = process.memoryUsage().heapUsed;
      const label = `w12_clear_shelf_rows_ebay_typical_${EDGE_PRODUCTS}_cap_stored_two_byte${mode === "live" ? "_live" : ""}`;
      const extra: Record<string, unknown> = { products: EDGE_PRODUCTS, textBytes, ebayValueBytesPerRow: ebayValueBytes(ebay) };
      const result = await measure(label, EDGE_PRODUCTS, counter, async () => {
        const answer = await save(body(`pg8-${mode}`, { patch: { storeShelf: { mode: "none" } },
          clear: { fields: ["storeShelf"], products } }), scopedPool(counter, probe?.hook));
        const peak = probe?.peakBytes() ?? null;
        if (probe) extra.livePeakDeltaMiB = peak === null ? null : Number(((peak - liveStart) / 1_048_576).toFixed(1));
        return answer;
      }, extra);

      expect(result).toMatchObject({ outcome: "changed", clearedProductCount: EDGE_PRODUCTS });
      // Every cleared product's new revision drops its shelf and carries both stored texts and its other eBay values.
      const stored = await execute(`SELECT count(*)::int AS n, count(shelf_mode)::int AS shelves, count(ebay_category_id)::int AS categories,
        count(payment_policy_id)::int AS payments,
        COALESCE(sum(octet_length(text_above)) + sum(octet_length(text_below)), 0)::bigint AS text_bytes
        FROM dropship.dropship_product_listing_setting_revisions WHERE request_id IS NOT NULL`);
      expect(stored.rows[0]).toEqual({ n: EDGE_PRODUCTS, shelves: 0, categories: EDGE_PRODUCTS, payments: EDGE_PRODUCTS,
        text_bytes: String(textBytes) });
      expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.category_saved", expect.objectContaining({
        cleared_product_count: EDGE_PRODUCTS, changed_count: EDGE_PRODUCTS + 1 }));
    }

    it(`measures a clear of ${EDGE_PRODUCTS} products at the text edge, stored two-byte (PG 8)`, () => runClearEdge("rule"), BULK_TEST_TIMEOUT_MS);
    it.runIf(HEAP_DIAGNOSTICS)(`measures the live heap of that clear (PG 8, opt-in)`, () => runClearEdge("live"), BULK_TEST_TIMEOUT_MS);
  });
});
