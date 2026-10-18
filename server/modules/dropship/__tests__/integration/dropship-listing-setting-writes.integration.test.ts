import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { config } from "dotenv";
import pg, { type Pool, type PoolClient } from "pg";
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
import { DropshipListingPriceChangesService } from "../../application/dropship-listing-price-changes-service";
import { DropshipListingCategoryMovesService } from "../../application/dropship-listing-category-moves-service";
import { DropshipCategoryMarksJobService } from "../../application/dropship-category-marks-job-service";
import { DropshipRulesConversionJobService, RULES_CONVERSION_FAILED_EVENT } from "../../application/dropship-rules-conversion-job-service";
import { ListingSettingHeavyWriteGate } from "../../application/dropship-listing-setting-write-support";
import type { ListingSettingEbayPort } from "../../application/dropship-listing-setting-ebay-values";
import type { DropshipEbayListingSetupDiscovery } from "../../application/dropship-ebay-listing-setup-service";
import { DropshipPricingRulesService } from "../../application/dropship-pricing-rules-service";
import { RULES_CONVERSION_PLANNER_VERSION, checkRulesConversion } from "../../application/dropship-listing-rules-conversion";
import { DropshipListingRulesConversionNoticeService } from "../../application/dropship-listing-rules-conversion-notice-service";
import { DropshipListingSettingsService } from "../../application/dropship-listing-settings-service";
import {
  DropshipListingRulesConversionService,
  RULES_CONVERSION_APPLIED_ACTION,
  convertInTransaction,
  rulesConversionRequestHash,
  rulesConversionSystemKey,
} from "../../application/dropship-listing-rules-conversion-service";
import { olderGroupRuleCounts } from "../../application/dropship-listing-settings-facts";
import type { ListingSettingWriteTransaction, StoredPriceChangeReview } from "../../application/dropship-listing-setting-writes";
import { DropshipError } from "../../domain/errors";
import { listingConversionChildKey, listingSettingChildKey, listingSettingRequestHash } from "../../domain/listing-setting-values";
import { PgDropshipListingPriceRepository } from "../../infrastructure/dropship-listing-price.repository";
import { PgDropshipListingContentRepository, saveContentProfileWithClient } from "../../infrastructure/dropship-listing-content.repository";
import { saveEbayCategoryRulesProfileWithClient } from "../../infrastructure/dropship-ebay-category-rules.repository";
import {
  LISTING_RULE_CONVERSION_KEY_CONSTRAINT,
  findRuleConversionByKeyWithClient,
  hasRuleConversionWithClient,
  insertRuleConversionWithClient,
  type ListingRuleConversionInsert,
} from "../../infrastructure/dropship-listing-rule-conversions.writer";
import { savePricingProfileWithClient } from "../../infrastructure/dropship-pricing-profile.writer";
import { saveProductListingSettingsPerProductWithClient } from "../../infrastructure/dropship-product-listing-settings.repository";
import { PgDropshipEbayListingPolicyOverrideRepository } from "../../infrastructure/dropship-ebay-listing-policy-override.repository";
import {
  PgDropshipListingSettingWritesRepository,
  mapListingSettingWriteError,
} from "../../infrastructure/dropship-listing-setting-writes.repository";
import { PgDropshipPricingRulesRepository } from "../../infrastructure/dropship-pricing-rules.repository";
import { PgDropshipCategoryMarksJobSource } from "../../infrastructure/dropship-category-marks-job.source";
import { readListingResolverInputs } from "../../infrastructure/dropship-listing-resolver-inputs.reader";
import { PgDropshipListingRulesConversionRepository } from "../../infrastructure/dropship-listing-rules-conversion.repository";
import { PgDropshipListingSettingsRepository } from "../../infrastructure/dropship-listing-settings.repository";
import { PgDropshipListingRulesConversionNoticeRepository } from "../../infrastructure/dropship-listing-rules-conversion-notice.repository";
import { PgDropshipRulesConversionJobSource } from "../../infrastructure/dropship-rules-conversion-job.source";
import { LISTING_RULE_CONVERSIONS_MIGRATION_FILE } from "../fixtures/listing-rule-conversions-migration";

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
  // PR 11's conversion record (plan section 12) and its guard.
  "dropship.dropship_listing_rule_conversions",
  "dropship.guard_listing_price_revision_immutable", "dropship.guard_listing_price_setting_coherence",
  "dropship.guard_pricing_profile_coherence", "dropship.guard_content_revision_immutable",
  "dropship.guard_content_profile_coherence", "dropship.guard_listing_content_coherence",
  "dropship.guard_ebay_category_rule_revision_immutable", "dropship.guard_ebay_category_rule_profile_coherence",
  "dropship.guard_product_listing_setting_revision_immutable", "dropship.guard_product_listing_setting_coherence",
  "dropship.guard_product_listing_setting_request_append_only",
  "dropship.guard_category_listing_setting_revision_immutable", "dropship.guard_category_listing_setting_coherence",
  "dropship.guard_product_category_seen",
  "dropship.guard_listing_rule_conversion",
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
  // W7's apply ledger (plan PR 9, 9.3): the review id, its pairing CHECK, foreign key and one-apply index.
  "0750_dropship_price_change_apply_ledger.sql",
  // PR 11's conversion record (plan section 12), named by its fixture's constant: its number changes on adoption.
  LISTING_RULE_CONVERSIONS_MIGRATION_FILE,
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
   * run's own allocation peak, so this runs apart from the allocated measurement. Shared by W6 and W12's clear;
   * W7 also names its review insert, where a price check holds its rows and their JSON (`alsoAt`).
   */
  function liveHeapProbe(alsoAt: readonly string[] = []): { hook: (sql: string) => void; peakBytes: () => number | null } {
    let peak: number | null = null;
    const points = ["INSERT INTO dropship.dropship_product_listing_setting_revisions", ...alsoAt];
    return {
      hook: (sql) => {
        if (!collectGarbage || !(sql === "COMMIT" || points.some((point) => sql.startsWith(point)))) return;
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

    it("re-saves the same own main text against Card Shellz's product as it is now: changed with a new revision, then unchanged (PR 10b A2)", async () => {
      const text = "Own words for the toploader.";
      const OLD_HASH = "e".repeat(64);
      // Product 7's own main text, written against an older Card Shellz product; no size keeps text of its own.
      await execute(`INSERT INTO dropship.dropship_product_listing_setting_revisions
        (vendor_id, store_connection_id, product_id, previous_revision_id, request_id, body_text, body_catalog_hash,
         idempotency_key, request_hash, actor_type, actor_id, created_at)
        VALUES ($1, $2, $3, NULL, NULL, $4, $5, 'seed-body:7', $6, 'vendor', 'seed', $7)`, [VENDOR, STORE, PRODUCT_7, text, OLD_HASH, "d".repeat(64), NOW]);
      await execute(`INSERT INTO dropship.dropship_product_listing_settings (vendor_id, store_connection_id, product_id, revision_id)
        SELECT vendor_id, store_connection_id, product_id, id FROM dropship.dropship_product_listing_setting_revisions WHERE idempotency_key = 'seed-body:7'`);
      const seeded = (await execute(`SELECT revision_id FROM dropship.dropship_product_listing_settings WHERE store_connection_id = $1 AND product_id = $2`,
        [STORE, PRODUCT_7])).rows[0].revision_id as number;
      const current = async () => (await execute(`SELECT r.id, r.previous_revision_id, r.body_text, r.body_catalog_hash
        FROM dropship.dropship_product_listing_settings s JOIN dropship.dropship_product_listing_setting_revisions r ON r.id = s.revision_id
        WHERE s.store_connection_id = $1 AND s.product_id = $2`, [STORE, PRODUCT_7])).rows[0];

      // [Keep my text]: the same text, sent alone; W5 stamps the product as it is now, and the repository's
      // comparison (hash included) calls it a change, so a new revision is written (plan 5.4, A2).
      const kept = await products().saveForMember(MEMBER, STORE, PRODUCT_7, { idempotencyKey: productKey("keep-text"),
        expectedRevisionId: seeded, patch: { mainText: { text } } });
      expect(kept).toMatchObject({ outcome: "changed", clearedSizeCount: 0 });
      expect(kept.revisionId).not.toBe(seeded);
      const stamped = await current();
      expect(stamped).toMatchObject({ id: kept.revisionId, previous_revision_id: seeded, body_text: text });
      expect(stamped.body_catalog_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(stamped.body_catalog_hash).not.toBe(OLD_HASH);

      // The stamp is the product's hash now: the same text again is no change, and no revision is written.
      const again = await products().saveForMember(MEMBER, STORE, PRODUCT_7, { idempotencyKey: productKey("keep-text-again"),
        expectedRevisionId: kept.revisionId, patch: { mainText: { text } } });
      expect(again).toMatchObject({ outcome: "unchanged", revisionId: kept.revisionId });
      expect(await current()).toEqual(stamped);
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

  describe("W7's apply ledger, migration 0750 (plan PR 9, 9.3, 9.13 PG 1-4)", () => {
    const LEDGER = "dropship_product_listing_setting_requests";
    const LEDGER_TABLE = `dropship.${LEDGER}`;
    const RECIPE = { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "up_99" } as const;
    const CATEGORY_RECIPE = { basis: "product_cost", markupBps: 4_000, flatCents: 0, rounding: "cent" } as const;
    const W7_HASH = "c".repeat(64);
    const writes = (pool?: Pool) => new PgDropshipListingSettingWritesRepository(pool ?? scopedPool());
    const review = (fields: Partial<StoredPriceChangeReview> = {}): StoredPriceChangeReview => ({
      id: randomUUID(), kind: "product_prices", input: { productIds: [PRODUCT_7], price: RECIPE }, rows: [], reviewHash: "b".repeat(64),
      createdAt: NOW, ...fields } as StoredPriceChangeReview);
    /** A review stored through W7's own transaction, as its review step will (plan 9.5 step 3.7), with every statement recorded. */
    async function storeReview(stored: StoredPriceChangeReview, storeConnectionId = STORE, memberId = MEMBER): Promise<string[]> {
      const statements: string[] = [];
      await writes(scopedPool(undefined, (sql) => { statements.push(sql); }))
        .executeReview({ memberId, storeConnectionId }, (tx) => tx.storePriceChangeReview(stored));
      return statements;
    }
    function apply(input: { key: string; reviewId: string; storeConnectionId?: number; products?: Array<{ productId: number; expectedRevisionId: number | null }>;
      patch?: Record<string, unknown> }) {
      return writes().execute({ memberId: MEMBER, storeConnectionId: input.storeConnectionId ?? STORE, idempotencyKey: input.key },
        (tx) => tx.saveProductsBulk({ operation: "price_change_apply", reviewId: input.reviewId, products: input.products ?? [],
          patch: (input.patch ?? {}) as never, requestHash: W7_HASH, now: NOW }));
    }
    /** Every ledger constraint and index, as PostgreSQL holds them: name, kind, validated, definition. */
    async function ledgerShape() {
      const constraints = await pool.query(`SELECT conname, contype, convalidated, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`, [`"${schema}"."${LEDGER}"`]);
      const indexes = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
        [schema, LEDGER]);
      const columns = await pool.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, LEDGER]);
      return { constraints: constraints.rows, indexes: indexes.rows, columns: columns.rows };
    }
    async function pgError(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
      const error = await promise.then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(DropshipError);
      return error as { code?: string; constraint?: string };
    }
    const rawLedgerRow = (fields: { operation: string; reviewId: string | null; key: string; storeConnectionId?: number }) =>
      execute(`INSERT INTO ${LEDGER_TABLE} (vendor_id, store_connection_id, operation, review_id, idempotency_key, request_hash,
        product_count, actor_type, actor_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, 0, 'vendor', $7, $8)`,
      [VENDOR, fields.storeConnectionId ?? STORE, fields.operation, fields.reviewId, fields.key, W7_HASH, MEMBER, NOW]);

    it("re-runs over rows of all four operations: no error, every constraint still validated, the rows as they were (PG 1)", async () => {
      // A price check's transaction: the store lock and the owner rows only (no request, catalog or feature lock), one insert.
      const priced = review();
      const reviewStatements = await storeReview(priced);
      expect(reviewStatements.filter((sql) => sql.startsWith("SELECT pg_advisory_xact_lock"))).toEqual([
        "SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)"]);
      expect(reviewStatements.some((sql) => sql.startsWith("LOCK TABLE") || sql.includes("dropship_listing_settings_request"))).toBe(false);
      expect(reviewStatements.filter((sql) => sql.startsWith("INSERT"))).toHaveLength(1);
      const storedReview = await execute("SELECT kind, actor_id, review_hash FROM dropship.dropship_pricing_reviews WHERE id = $1", [priced.id]);
      expect(storedReview.rows).toEqual([{ kind: "product_prices", actor_id: MEMBER, review_hash: priced.reviewHash }]);

      // W6, then W12 with its category save and clear, then W13, then W7's apply of the review, each through its writer.
      const run = <T>(key: string, work: (tx: ListingSettingWriteTransaction) => Promise<T>) =>
        writes().execute({ memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: key }, work);
      await run("pg-0750:w6", (tx) => tx.saveProductsBulk({ operation: "product_settings_bulk",
        products: [{ productId: PRODUCT_7, expectedRevisionId: null }], patch: { storeShelf: { mode: "none" } }, requestHash: W7_HASH, now: NOW }));
      const afterW6 = (await execute("SELECT revision_id FROM dropship.dropship_product_listing_settings WHERE product_id = $1", [PRODUCT_7]))
        .rows[0].revision_id as number;
      await run("pg-0750:w12", async (tx) => {
        await tx.saveCategory({ categoryId: TOPLOADERS, expectedRevisionId: null, patch: { price: CATEGORY_RECIPE, storeShelf: { mode: "none" } },
          requestHash: W7_HASH, now: NOW });
        return tx.saveProductsBulk({ operation: "category_settings_clear", products: [{ productId: PRODUCT_7, expectedRevisionId: afterW6 }],
          patch: { storeShelf: null }, requestHash: W7_HASH, now: NOW });
      });
      await run("pg-0750:w13", (tx) => tx.acknowledgeCategoryMoves({ items: [{ productId: PRODUCT_7, shownCategoryId: TOPLOADERS }],
        requestHash: W7_HASH, now: NOW }));
      const afterW12 = (await execute("SELECT revision_id FROM dropship.dropship_product_listing_settings WHERE product_id = $1", [PRODUCT_7]))
        .rows[0].revision_id as number;
      const applied = await apply({ key: "pg-0750:w7", reviewId: priced.id, products: [{ productId: PRODUCT_7, expectedRevisionId: afterW12 }],
        patch: { price: RECIPE } });
      expect(applied.outcome).toBe("changed");
      // The product's own price and revision, and the category's, as the text-free facts read them on PostgreSQL (plan 8.2).
      const facts = await run("pg-0750:facts", (tx) => tx.loadSettingFacts({ productIds: [PRODUCT_7], categoryIds: [TOPLOADERS] }));
      expect(facts.products.get(PRODUCT_7)).toEqual({ revisionId: applied.changed[0].revisionId, price: RECIPE, ownFields: new Set(["price"]) });
      expect(facts.categories.get(TOPLOADERS)).toMatchObject({ price: CATEGORY_RECIPE });

      const rowsBefore = await execute(`SELECT operation, review_id, idempotency_key FROM ${LEDGER_TABLE} ORDER BY id`);
      expect(rowsBefore.rows).toEqual([
        { operation: "product_settings_bulk", review_id: null, idempotency_key: "pg-0750:w6" },
        { operation: "category_settings_clear", review_id: null, idempotency_key: "pg-0750:w12" },
        { operation: "category_moves_acknowledge", review_id: null, idempotency_key: "pg-0750:w13" },
        { operation: "price_change_apply", review_id: priced.id, idempotency_key: "pg-0750:w7" },
      ]);
      // The apply's audit rows name the review (plan 9.7, C-money-5).
      const audits = await execute(`SELECT payload->>'reviewId' AS review_id, payload->>'operation' AS operation FROM dropship.dropship_audit_events
        WHERE event_type = 'product_listing_settings_saved' ORDER BY id`);
      expect(audits.rows.map((row: Row) => [row.operation, row.review_id])).toEqual([
        ["product_settings_bulk", null], ["category_settings_clear", null], ["price_change_apply", priced.id]]);
      const shapeBefore = await ledgerShape();

      await execute(readFileSync(resolve(process.cwd(), "migrations", "0750_dropship_price_change_apply_ledger.sql"), "utf8"));

      const shapeAfter = await ledgerShape();
      expect(shapeAfter).toEqual(shapeBefore);
      expect(shapeAfter.constraints.length).toBeGreaterThanOrEqual(10);
      expect(shapeAfter.constraints.every((constraint: Row) => constraint.convalidated === true)).toBe(true);
      expect(shapeAfter.constraints.map((constraint: Row) => constraint.conname)).toEqual(expect.arrayContaining([
        `${LEDGER}_operation_chk`, `${LEDGER}_review_chk`, `${LEDGER}_review_fk`]));
      expect(shapeAfter.constraints.find((constraint: Row) => constraint.conname === `${LEDGER}_operation_chk`)?.definition)
        .toContain("'price_change_apply'");
      expect(shapeAfter.indexes.find((index: Row) => index.indexname === `${LEDGER}_review_idx`)?.indexdef)
        .toMatch(/CREATE UNIQUE INDEX \w+ ON .+ USING btree \(review_id\) WHERE \(review_id IS NOT NULL\)/);
      expect(shapeAfter.columns.find((column: Row) => column.column_name === "review_id")).toEqual({
        column_name: "review_id", data_type: "uuid", is_nullable: "YES" });
      expect((await execute(`SELECT operation, review_id, idempotency_key FROM ${LEDGER_TABLE} ORDER BY id`)).rows).toEqual(rowsBefore.rows);
    });

    it("refuses an apply row without a review, and any other operation with one, by the pairing CHECK (23514, PG 2)", async () => {
      const priced = review();
      await storeReview(priced);

      for (const [operation, reviewId] of [["price_change_apply", null], ["product_settings_bulk", priced.id],
        ["category_settings_clear", priced.id], ["category_moves_acknowledge", priced.id]] as const) {
        const error = await pgError(rawLedgerRow({ operation, reviewId, key: `pg-0750:pair-${operation}` }));
        expect({ operation, code: error.code, constraint: error.constraint })
          .toEqual({ operation, code: "23514", constraint: `${LEDGER}_review_chk` });
      }
      // The wrapper answers a CHECK as the fatal INVARIANT_FAILED, as for every CHECK (plan 3.9).
      expect(mapListingSettingWriteError(await pgError(rawLedgerRow({ operation: "price_change_apply", reviewId: null, key: "pg-0750:pair-map" }))))
        .toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", context: { constraint: `${LEDGER}_review_chk`, classification: "fatal" } });
      // The well-paired rows are accepted.
      await rawLedgerRow({ operation: "price_change_apply", reviewId: priced.id, key: "pg-0750:pair-ok" });
      await rawLedgerRow({ operation: "product_settings_bulk", reviewId: null, key: "pg-0750:pair-ok-w6" });
      expect(await count(LEDGER_TABLE)).toBe(2);
    });

    it("refuses an apply of another store's or another vendor's review by the foreign key (23503), writing nothing (PG 3)", async () => {
      const OTHER_STORE = 24;
      await addVendorStore(OTHER_STORE);
      const ownStore = review();
      await storeReview(ownStore);
      const otherVendor = review();
      await storeReview(otherVendor, OTHER_VENDOR_STORE, "member-2");

      // Store 22's review applied on the same vendor's store 24, and vendor 11's review applied by vendor 10.
      for (const [reviewId, storeConnectionId, label] of [[ownStore.id, OTHER_STORE, "store"], [otherVendor.id, STORE, "vendor"]] as const) {
        const error = await pgError(apply({ key: `pg-0750:fk-${label}`, reviewId, storeConnectionId }));
        // Left unmapped (a fault: the apply loads its review by vendor and store first), so it is the database's own error.
        expect({ label, code: error.code, constraint: error.constraint }).toEqual({ label, code: "23503", constraint: `${LEDGER}_review_fk` });
      }
      expect(await count(LEDGER_TABLE)).toBe(0);
      // Scoped reads never see another store's or vendor's review, nor its apply.
      await apply({ key: "pg-0750:fk-own", reviewId: ownStore.id });
      const scoped = await writes().execute({ memberId: MEMBER, storeConnectionId: OTHER_STORE, idempotencyKey: "pg-0750:fk-read" },
        async (tx) => [await tx.loadPriceChangeReview(ownStore.id), await tx.findPriceChangeApplyByReview(ownStore.id),
          await tx.loadPriceChangeReview(otherVendor.id)]);
      expect(scoped).toEqual([null, null, null]);
      await expect(writes().readPriceChangeReviewForMember({ memberId: "member-2", storeConnectionId: STORE, reviewId: ownStore.id }))
        .resolves.toBeNull();
      await expect(writes().readPriceChangeReviewForMember({ memberId: MEMBER, storeConnectionId: STORE, reviewId: ownStore.id }))
        .resolves.toEqual(ownStore);
    });

    it("refuses a second apply row for one review by its unique index (23505), mapped to the key conflict (PG 4)", async () => {
      const priced = review({ kind: "category_price", input: { categoryId: TOPLOADERS, expectedRevisionId: null, patch: { price: CATEGORY_RECIPE } } });
      await storeReview(priced);
      const first = await apply({ key: "pg-0750:once-a", reviewId: priced.id });
      expect(first).toMatchObject({ outcome: "unchanged", changed: [] });

      const found = await writes().execute({ memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: "pg-0750:once-read" },
        async (tx) => ({ review: await tx.loadPriceChangeReview(priced.id), applied: await tx.findPriceChangeApplyByReview(priced.id) }));
      // The load carries the rows' stored size: octet_length('[]') for a review with no row (plan 9.7's memory stop rule).
      expect(found).toEqual({ review: { ...priced, rowsBytes: 2 }, applied: { requestId: first.requestId, idempotencyKey: "pg-0750:once-a" } });

      // The index's name is what PostgreSQL reports, so the wrapper's map knows it.
      const raw = await pgError(rawLedgerRow({ operation: "price_change_apply", reviewId: priced.id, key: "pg-0750:once-raw" }));
      expect({ code: raw.code, constraint: raw.constraint }).toEqual({ code: "23505", constraint: `${LEDGER}_review_idx` });
      // Through the writer under another key: the 23505 is the permanent key conflict (a backstop, plan 3.7).
      const conflict = await expectDropshipError(apply({ key: "pg-0750:once-b", reviewId: priced.id }), "DROPSHIP_IDEMPOTENCY_CONFLICT");
      expect(conflict.context).toMatchObject({ constraint: `${LEDGER}_review_idx`, retryable: false, classification: "permanent" });
      expect((await execute(`SELECT idempotency_key FROM ${LEDGER_TABLE} WHERE review_id = $1`, [priced.id])).rows)
        .toEqual([{ idempotency_key: "pg-0750:once-a" }]);
    });
  });

  describe("W7, the price check and its apply (plan PR 9, 9.5-9.7, 9.13 PG 5-10)", () => {
    /** A second Toploaders product with one size, a retail price and an .ops cost. */
    const SECOND_PRODUCT = 8;
    const SECOND_SIZE = 105;
    /** 800-ish costs x 1.5: product 7's sizes 101-104 cost 8.09, 24.00, 44.00 and 80.00. */
    const RECIPE = { basis: "product_cost", markupBps: 5_000, flatCents: 0, rounding: "cent" } as const;
    const CATEGORY_RECIPE = { basis: "product_cost", markupBps: 2_500, flatCents: 0, rounding: "cent" } as const;
    const applyKey = (label: string) => `price-changes:${label}`;
    /** One service over one gate, as the factory builds them; a second instance stands for a second dyno. */
    const priceChanges = (repositoryPool: Pool = scopedPool(), heavyWrites = new ListingSettingHeavyWriteGate()) =>
      new DropshipListingPriceChangesService({ repository: new PgDropshipListingSettingWritesRepository(repositoryPool), ebay: fakeEbay,
        heavyWrites, clock: { now: () => NOW }, timer: () => performance.now(), log, newId: () => randomUUID() });
    const check = (body: Record<string, unknown>, repositoryPool?: Pool) => priceChanges(repositoryPool).reviewForMember(MEMBER, STORE, body);
    const applyOf = (review: { reviewId: string; reviewHash: string }, label: string, repositoryPool?: Pool, heavyWrites?: ListingSettingHeavyWriteGate) =>
      priceChanges(repositoryPool, heavyWrites).applyForMember(MEMBER, STORE,
        { reviewId: review.reviewId, reviewHash: review.reviewHash, idempotencyKey: applyKey(label) });

    /** A product's own row through 8a's writer, as a W5 save leaves it; its revision id. */
    async function ownRow(productId: number, patch: ProductListingSettingPatch, label: string): Promise<number> {
      const saved = await new PgDropshipListingSettingWritesRepository(scopedPool()).execute(
        { memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: `seed-own:${label}` },
        (tx) => tx.saveProduct({ productId, expectedRevisionId: null, patch, requestHash: "d".repeat(64), now: NOW }));
      return saved.row!.revisionId;
    }
    async function maxAuditId(): Promise<number> {
      return (await execute("SELECT COALESCE(max(id), 0)::int AS id FROM dropship.dropship_audit_events")).rows[0].id as number;
    }
    /**
     * The correlation (plan 9.7, v3r C-money-5): from one review id, every audit row its apply wrote. The ledger row
     * names the review and the key K; the category and clean-up audits name K, the bulk audits the review, and each
     * release's audit its revision, found by K's size child prefix (listingSettingChildKeyPrefix(K, "size")).
     */
    async function auditsOfReview(reviewId: string): Promise<number[]> {
      const result = await execute(`WITH ledger AS (
          SELECT vendor_id, idempotency_key, 'ls:' || encode(sha256(convert_to(idempotency_key, 'UTF8')), 'hex') || ':size:' AS size_prefix
          FROM dropship.dropship_product_listing_setting_requests WHERE review_id = $1::uuid),
        released AS (
          SELECT r.id FROM dropship.dropship_listing_price_revisions r JOIN ledger l ON r.vendor_id = l.vendor_id
          WHERE left(r.idempotency_key, length(l.size_prefix)) = l.size_prefix)
        SELECT a.id FROM dropship.dropship_audit_events a JOIN ledger l ON a.vendor_id = l.vendor_id
        WHERE a.payload->>'requestKey' = l.idempotency_key
           OR a.payload->>'reviewId' = $2::text
           OR (a.entity_type = 'dropship_listing_price_setting' AND (a.payload->'after'->>'revisionId')::bigint IN (SELECT id FROM released))
        ORDER BY a.id`, [reviewId, reviewId]);
      return result.rows.map((row: Row) => row.id as number);
    }
    async function auditIdsAfter(id: number): Promise<number[]> {
      return (await execute("SELECT id FROM dropship.dropship_audit_events WHERE id > $1 ORDER BY id", [id])).rows.map((row: Row) => row.id as number);
    }
    async function w7Writes() {
      return {
        ...(await allWrites()),
        reviews: await count("dropship.dropship_pricing_reviews"),
        ledger: await count("dropship.dropship_product_listing_setting_requests"),
        categoryRevisions: await count("dropship.dropship_category_listing_setting_revisions"),
      };
    }

    beforeEach(async () => {
      await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type, shopify_product_id)
        VALUES ($1, 'TL-2', 'Toploader 2', 'Toploaders', $2, 'toploader', '8000000008')`, [SECOND_PRODUCT, TOPLOADERS]);
      await execute(`INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, weight_grams, sales_eligibility)
        VALUES ($1, $2, 'TL2-25', 'Pack of 25', '7000000105', 120, 'sellable')`, [SECOND_SIZE, SECOND_PRODUCT]);
      await execute(`INSERT INTO public.shopify_variants VALUES ('7000000105', '8000000008', 'TL2-25', 12.99)`);
      await execute(`INSERT INTO membership.plan_variant_overrides VALUES ('ops-105', 'ops', '7000000105', '8000000008', 'fixed_price', 10.00, NULL, true)`);
    });

    it("applies a products check end to end: the product rows, the ledger row naming the review, 200 releases, one commit (PG 5)", async () => {
      const BIG_PRODUCT = 30_001;
      const sizeIds = await seedProductSizes(BIG_PRODUCT, 300_001, 200);
      // 200 typed prices, as W8 saves them (one request).
      await sizePrices().saveForMember(MEMBER, STORE, { idempotencyKey: key("pg5-typed"), rows: sizeIds.map((id) => row(id, 1_499)) });
      const reviewStatements: string[] = [];
      const review = await check({ kind: "product_prices", productIds: [BIG_PRODUCT, PRODUCT_7], price: RECIPE, releaseExactPrices: true },
        scopedPool(undefined, (sql) => { reviewStatements.push(sql); }));
      expect(review.summary).toEqual({ total: 204, changed: 204, released: 200, refused: 0 });
      // The check took the store lock and the owner rows, no request, catalog or feature lock, and wrote one row.
      expect(reviewStatements.filter((sql) => sql.startsWith("SELECT pg_advisory_xact_lock"))).toEqual([
        "SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)"]);
      expect(reviewStatements.some((sql) => sql.startsWith("LOCK TABLE") || /FOR UPDATE/.test(sql))).toBe(false);
      expect(reviewStatements.filter((sql) => sql.startsWith("INSERT"))).toEqual([expect.stringContaining("dropship.dropship_pricing_reviews")]);
      const stored = await execute("SELECT kind, actor_id, review_hash, jsonb_array_length(rows) AS rows FROM dropship.dropship_pricing_reviews WHERE id = $1",
        [review.reviewId]);
      expect(stored.rows).toEqual([{ kind: "product_prices", actor_id: MEMBER, review_hash: review.reviewHash, rows: 204 }]);

      const auditBefore = await maxAuditId();
      const counter: StatementCounter = { statements: 0 };
      const statements: string[] = [];
      const applied = await measure("w7_apply_products_200_releases", 200, counter,
        () => applyOf(review, "pg5", scopedPool(counter, (sql) => { statements.push(sql); })));

      expect(applied).toEqual({ outcome: "changed", reviewId: review.reviewId, requestId: expect.any(Number), changedProductCount: 2,
        releasedSizeCount: 200, categoryRevisionId: null });
      expect(statements.filter((sql) => sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK")).toEqual(["BEGIN", "COMMIT"]);
      const requestHash = listingSettingRequestHash({ operation: "price_change_apply_v1", storeConnectionId: STORE, reviewId: review.reviewId,
        reviewHash: review.reviewHash });
      const ledger = await execute(`SELECT id, operation, review_id, idempotency_key, request_hash, product_count, actor_id
        FROM dropship.dropship_product_listing_setting_requests`);
      expect(ledger.rows).toEqual([{ id: String(applied.requestId), operation: "price_change_apply", review_id: review.reviewId,
        idempotency_key: applyKey("pg5"), request_hash: requestHash, product_count: 2, actor_id: MEMBER }]);
      const products = await execute(`SELECT r.product_id, r.price_basis, r.price_markup_bps, r.request_id FROM dropship.dropship_product_listing_settings s
        JOIN dropship.dropship_product_listing_setting_revisions r ON r.id = s.revision_id ORDER BY r.product_id`);
      expect(products.rows).toEqual([PRODUCT_7, BIG_PRODUCT].map((productId) => ({ product_id: productId, price_basis: "product_cost",
        price_markup_bps: 5_000, request_id: String(applied.requestId) })));
      // Each release through W9's own flow, under its size child key, judged against the new product price.
      const released = await execute(`SELECT s.product_variant_id, s.pricing_mode, s.override_price_cents, r.idempotency_key, r.request_hash
        FROM dropship.dropship_listing_price_settings s JOIN dropship.dropship_listing_price_revisions r ON r.id = s.revision_id
        WHERE s.product_variant_id >= 300001 ORDER BY s.product_variant_id`);
      expect(released.rows).toHaveLength(200);
      released.rows.forEach((setting: Row, index) => expect(setting).toEqual({ product_variant_id: sizeIds[index], pricing_mode: "inherit",
        override_price_cents: null, idempotency_key: listingSettingChildKey(applyKey("pg5"), "size", sizeIds[index]), request_hash: requestHash }));

      // Every audit row the apply wrote, and only those, by the one-join correlation from the review (C-money-5).
      const written = await auditIdsAfter(auditBefore);
      expect(written).toHaveLength(2 + 200);
      expect(await count("dropship.dropship_audit_events", "id > $1 AND event_type = 'listing_price_saved'", [auditBefore])).toBe(200);
      expect(await count("dropship.dropship_audit_events", "id > $1 AND payload->>'reviewId' = $2", [auditBefore, review.reviewId])).toBe(2);
      expect(await auditsOfReview(review.reviewId)).toEqual(written);
      // W8's 200 earlier audits are not this review's.
      expect(await count("dropship.dropship_audit_events", "id <= $1", [auditBefore])).toBe(200);
      expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.price_change_applied", expect.objectContaining({
        outcome: "changed", review_id: review.reviewId, request_id: applied.requestId, request_key: applyKey("pg5"),
        changed_product_count: 2, released_size_count: 200, size_count: 200 }));
    }, BULK_TEST_TIMEOUT_MS);

    it("applies a release-only check: the ledger row with no product, the typed sizes released (PG 6)", async () => {
      const typed101 = await typePrice(101, 1_299, "pg6-101");
      await typePrice(102, 3_299, "pg6-102");
      const review = await check({ kind: "product_prices", productIds: [PRODUCT_7], releaseExactPrices: true });
      expect(review.rows.filter((entry) => entry.released).map((entry) => [entry.productVariantId, entry.settingRevisionId]))
        .toEqual([[101, typed101], [102, typed101 + 1]]);

      const applied = await applyOf(review, "pg6");

      expect(applied).toMatchObject({ outcome: "changed", changedProductCount: 0, releasedSizeCount: 2, categoryRevisionId: null });
      expect((await execute(`SELECT operation, review_id, product_count FROM dropship.dropship_product_listing_setting_requests`)).rows)
        .toEqual([{ operation: "price_change_apply", review_id: review.reviewId, product_count: 0 }]);
      expect(await count("dropship.dropship_product_listing_setting_revisions")).toBe(0);
      expect((await execute(`SELECT product_variant_id, pricing_mode FROM dropship.dropship_listing_price_settings ORDER BY product_variant_id`)).rows)
        .toEqual([{ product_variant_id: 101, pricing_mode: "inherit" }, { product_variant_id: 102, pricing_mode: "inherit" }]);
    });

    it("applies a category check: the category row, the cleared products, the clean-ups, every audit found from the review (PG 7)", async () => {
      // Product 7 holds its own price and shelf, and size 101 a shelf; product 8 has no row, only a shelf on size 105.
      const own7 = await ownRow(PRODUCT_7, { price: RECIPE, storeShelf: { mode: "none" } }, "pg7-7");
      await seedShelf({ sizeId: 101, label: "pg7-101" });
      await seedShelf({ sizeId: SECOND_SIZE, label: "pg7-105" });
      const body = { kind: "category_price", categoryId: TOPLOADERS, expectedRevisionId: null,
        patch: { price: CATEGORY_RECIPE, storeShelf: { mode: "none" } },
        clear: { fields: ["storeShelf", "price"], products: [{ productId: SECOND_PRODUCT, expectedRevisionId: null },
          { productId: PRODUCT_7, expectedRevisionId: own7 }] } };
      const review = await check(body);
      expect(review.summary).toMatchObject({ total: 5, refused: 0 });
      const auditBefore = await maxAuditId();

      const applied = await applyOf(review, "pg7");

      expect(applied).toEqual({ outcome: "changed", reviewId: review.reviewId, requestId: expect.any(Number), changedProductCount: 1,
        releasedSizeCount: 0, categoryRevisionId: expect.any(Number) });
      const category = await execute(`SELECT r.id, r.price_basis, r.price_markup_bps, r.shelf_mode, r.idempotency_key FROM dropship.dropship_category_listing_settings s
        JOIN dropship.dropship_category_listing_setting_revisions r ON r.id = s.revision_id`);
      expect(category.rows).toEqual([{ id: applied.categoryRevisionId, price_basis: "product_cost", price_markup_bps: 2_500, shelf_mode: "none",
        idempotency_key: applyKey("pg7") }]);
      // Product 7's own price and shelf are reset; product 8 had nothing on its row, so it wrote no revision.
      const product = await execute(`SELECT r.product_id, r.price_basis, r.shelf_mode FROM dropship.dropship_product_listing_settings s
        JOIN dropship.dropship_product_listing_setting_revisions r ON r.id = s.revision_id ORDER BY r.product_id`);
      expect(product.rows).toEqual([{ product_id: PRODUCT_7, price_basis: null, shelf_mode: null }]);
      expect(await count("dropship.dropship_ebay_store_category_assignments")).toBe(0);
      const written = await auditIdsAfter(auditBefore);
      // The category, product 7, and the two shelf clean-ups.
      expect(written).toHaveLength(4);
      expect(await auditsOfReview(review.reviewId)).toEqual(written);
      expect((await execute(`SELECT event_type FROM dropship.dropship_audit_events WHERE id > $1 ORDER BY id`, [auditBefore])).rows
        .map((entry: Row) => entry.event_type)).toEqual(["category_listing_settings_saved", "product_listing_settings_saved",
        "ebay_store_category_assignment_replaced", "ebay_store_category_assignment_replaced"]);
    });

    it("answers a retry from the probe as replayed in exactly 8 statements, and the key with another review as a conflict (PG 8)", async () => {
      await typePrice(101, 1_299, "pg8-101");
      const review = await check({ kind: "product_prices", productIds: [PRODUCT_7], price: RECIPE, releaseExactPrices: true });
      const first = await applyOf(review, "pg8");
      const before = await w7Writes();

      const counter: StatementCounter = { statements: 0 };
      const replay = await applyOf(review, "pg8", scopedPool(counter));

      expect(replay).toEqual({ ...first, outcome: "replayed", changedProductCount: null });
      // BEGIN, the request lock, the store lock, the owner rows, the gate, the probe, the review (the classifier's category), COMMIT.
      expect(counter.statements).toBe(8);
      expect(await w7Writes()).toEqual(before);
      expect(log.info).toHaveBeenLastCalledWith("dropship.listing_settings.price_change_applied", expect.objectContaining({
        outcome: "replayed", review_id: review.reviewId, released_size_count: 1 }));

      const other = await check({ kind: "product_prices", productIds: [PRODUCT_7], price: null });
      const conflict = await expectDropshipError(applyOf(other, "pg8"), "DROPSHIP_IDEMPOTENCY_CONFLICT");
      expect(conflict.context?.mismatched).toEqual(["ledger.requestHash", "size.requestHash"]);
      expect(await w7Writes()).toEqual({ ...before, reviews: before.reviews + 1 });
    });

    describe("concurrency (PG 9)", () => {
      it("(a) P3's race: a W9 save that commits while the apply waits on the store lock moves the prices: 409, nothing written", async () => {
        const review = await check({ kind: "product_prices", productIds: [PRODUCT_7], price: RECIPE });
        let saved!: () => void;
        const savedHere = new Promise<void>((done) => { saved = done; });
        let open!: () => void;
        const held = new Promise<void>((done) => { open = done; });
        const typed = new PgDropshipListingPriceRepository(scopedPool()).execute(
          { memberId: MEMBER, storeConnectionId: STORE, productVariantId: 101, idempotencyKey: "pg9a-typed" },
          async (tx) => {
            const result = await saveListingPriceInTransaction(tx, { storeConnectionId: STORE, productVariantId: 101 },
              { priceCents: 1_299, pricingMode: "fixed", expectedRevisionId: null, idempotencyKey: "pg9a-typed" }, "d".repeat(64), NOW);
            saved();
            await held;
            return result;
          });
        let apply: Promise<unknown> | undefined;
        let outcome: unknown;
        try {
          await within(savedHere, "the W9 save");
          apply = applyOf(review, "pg9a").then(() => null, (reason: unknown) => reason);
          await waitUntilLockWait("dropship_listing_push_job", 1);
          open();
          await within(typed, "the W9 save's commit");
          outcome = await within(apply, "the W7 apply");
        } finally {
          open();
          await within(Promise.allSettled([typed, ...(apply ? [apply] : [])]), "the race case's clean-up");
        }
        // Under READ COMMITTED the recompute after the store lock sees the typed price, which the review did not show.
        expect(outcome).toBeInstanceOf(DropshipError);
        expect(outcome).toMatchObject({ code: "DROPSHIP_LISTING_PRICES_MOVED", context: { sizeCount: 1, sizes: [{ productVariantId: 101,
          priceCents: 1_299 }] } });
        expect(await count("dropship.dropship_product_listing_setting_requests")).toBe(0);
        expect(await count("dropship.dropship_product_listing_setting_revisions")).toBe(0);
      });

      it("(b) two applies of one review under two keys at once: one commits, the other is 409 from the by-review read (C-money-1)", async () => {
        const review = await check({ kind: "product_prices", productIds: [PRODUCT_7], price: RECIPE });
        const paused = gate((sql) => sql === "COMMIT");
        const first = applyOf(review, "pg9b-first", scopedPool(undefined, paused.hook));
        let second: Promise<unknown> | undefined;
        try {
          await within(paused.reached, "the first apply's commit");
          // Another dyno's gate: the second waits on the store lock, not on the first one's request lock (another key).
          second = applyOf(review, "pg9b-second", scopedPool(), new ListingSettingHeavyWriteGate()).then(() => null, (reason: unknown) => reason);
          await waitUntilLockWait("dropship_listing_push_job", 1);
          paused.open();
          await expect(within(first, "the first apply")).resolves.toMatchObject({ outcome: "changed", changedProductCount: 1 });
          const refused = await within(second, "the second apply");
          expect(refused).toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT", context: { reviewId: review.reviewId, classification: "permanent" } });
          // Not the index's 23505: the by-review read saw the first apply's committed row (the store lock serialized them).
          expect((refused as DropshipError).context).not.toHaveProperty("constraint");
        } finally {
          paused.open();
          await within(Promise.allSettled([first, ...(second ? [second] : [])]), "the two-key case's clean-up");
        }
        expect((await execute("SELECT idempotency_key FROM dropship.dropship_product_listing_setting_requests")).rows)
          .toEqual([{ idempotency_key: applyKey("pg9b-first") }]);
      });

      it("(c) a W1 apply and a W7 apply on one store are serialized: W1 waits, then sees W7's prices and answers stale", async () => {
        const profileBefore = (await execute("SELECT revision_id FROM dropship.dropship_pricing_profiles WHERE store_connection_id = $1", [STORE]))
          .rows[0].revision_id as number;
        const w1Review = await pricingRules().reviewForMember(MEMBER, STORE, { profile: D2, expectedRevisionId: profileBefore, releaseFixedOverrides: false });
        const review = await check({ kind: "product_prices", productIds: [PRODUCT_7], price: RECIPE });
        const paused = gate((sql) => sql === "COMMIT");
        const w7 = applyOf(review, "pg9c", scopedPool(undefined, paused.hook));
        let w1: Promise<unknown> | undefined;
        try {
          await within(paused.reached, "the W7 apply's commit");
          w1 = pricingRules().applyForMember(MEMBER, STORE, { reviewId: w1Review.reviewId, reviewHash: w1Review.reviewHash,
            idempotencyKey: "pg9c-w1" }).then(() => null, (reason: unknown) => reason);
          await waitUntilLockWait("dropship_listing_push_job", 1);
          paused.open();
          await expect(within(w7, "the W7 apply")).resolves.toMatchObject({ outcome: "changed" });
          // Product 7's own price now beats the store default W1 reviewed, so its recompute differs.
          await expect(within(w1, "the W1 apply")).resolves.toMatchObject({ code: "DROPSHIP_PRICING_REVIEW_STALE" });
        } finally {
          paused.open();
          await within(Promise.allSettled([w7, ...(w1 ? [w1] : [])]), "the W1 and W7 case's clean-up");
        }
        expect((await execute("SELECT revision_id FROM dropship.dropship_pricing_profiles WHERE store_connection_id = $1", [STORE]))
          .rows[0].revision_id).toBe(profileBefore);
        expect(await count("dropship.dropship_pricing_applications")).toBe(0);
        expect(await count("dropship.dropship_product_listing_setting_requests")).toBe(1);
      });
    });

    /*
     * PG 10 (v3r, C-money-8, C-feas-2): W7 at the text edge. 10,000 products, one chosen size each, each product's row
     * holding its own shelf and both texts, two-byte (one U+2019 a text; W12's PG 8 rows without eBay values). A
     * products check sets a price on all of them and its apply rewrites every row (copying both texts); a category
     * check of their category clears the shelf on all of them. Each review and each apply logs elapsed_ms, statements
     * and the heap growth; the opt-in live runs (DROPSHIP_W6_HEAP_DIAGNOSTICS=1) log the live peak at the review
     * insert, each revision insert and COMMIT, which plan 9.7's memory stop rule judges (9d's live rule).
     *
     * The stop rule is in force (PR 9f): at the full 30,000,000 B of text this apply peaked at 132.5-132.9 MiB live,
     * over 128. So the review's rows, as PostgreSQL stores them, count toward the budget beside the text, and the
     * edge is the text that fills what the rows leave: a check of the same body first measures its stored rows, then
     * the rows are seeded with the texts that fit. Logged, never asserted.
     */
    const W7_EDGE_PRODUCTS = MAX_LISTING_SETTING_BULK_PRODUCTS;
    const W7_EDGE_FIRST_PRODUCT = 60_001;
    const W7_EDGE_FIRST_SIZE = 600_001;
    const W7_EDGE_CATEGORY = 4;
    const W7_LIVE_POINTS = ["INSERT INTO dropship.dropship_pricing_reviews"] as const;
    const LIMIT_MIB = 128;
    /** A text of `bytes` UTF-8 bytes with one U+2019 (3 bytes), so V8 holds it two-byte. */
    const twoByteText = (bytes: number) => `${"a".repeat(bytes - 3)}’`;
    const edgeBody = (kind: "product_prices" | "category_price", clear?: Array<{ productId: number; expectedRevisionId: number }>) =>
      kind === "product_prices"
        ? { kind, productIds: Array.from({ length: W7_EDGE_PRODUCTS }, (_, index) => W7_EDGE_FIRST_PRODUCT + index), price: RECIPE }
        : { kind, categoryId: W7_EDGE_CATEGORY, expectedRevisionId: null, patch: { price: CATEGORY_RECIPE, storeShelf: { mode: "none" } },
          ...(clear ? { clear: { fields: ["storeShelf"], products: clear } } : {}) };

    /** The edge's catalog: 10,000 products in their own category, one sellable size each with a retail price and an .ops cost. */
    async function seedPriceEdgeCatalog(): Promise<void> {
      const last = W7_EDGE_FIRST_PRODUCT + W7_EDGE_PRODUCTS - 1;
      await execute("INSERT INTO catalog.product_categories (id, name) VALUES ($1, 'Edge category')", [W7_EDGE_CATEGORY]);
      await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type, shopify_product_id)
        SELECT g, 'W7E-' || g, 'Price edge product ' || g, 'Edge category', $3, 'toploader', (9300000000 + g)::text
        FROM generate_series($1::int, $2::int) g`, [W7_EDGE_FIRST_PRODUCT, last, W7_EDGE_CATEGORY]);
      await execute(`INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, weight_grams, sales_eligibility)
        SELECT $1::int + i, $2::int + i, 'W7E-SIZE-' || i, 'Size ' || i, (7300000000 + i)::text, 100, 'sellable'
        FROM generate_series(0, $3::int - 1) i`, [W7_EDGE_FIRST_SIZE, W7_EDGE_FIRST_PRODUCT, W7_EDGE_PRODUCTS]);
      await execute(`INSERT INTO public.shopify_variants (id, product_id, sku, price)
        SELECT (7300000000 + i)::text, (9300000000 + $2::int + i)::text, 'W7E-SIZE-' || i, 9.99 FROM generate_series(0, $1::int - 1) i`,
      [W7_EDGE_PRODUCTS, W7_EDGE_FIRST_PRODUCT]);
      await execute(`INSERT INTO membership.plan_variant_overrides
        SELECT 'ops-w7e-' || i, 'ops', (7300000000 + i)::text, (9300000000 + $2::int + i)::text, 'fixed_price', 6.00, NULL, true
        FROM generate_series(0, $1::int - 1) i`, [W7_EDGE_PRODUCTS, W7_EDGE_FIRST_PRODUCT]);
    }

    /** Each edge product's row: its own shelf and both texts `text`; the products with their current revisions. */
    async function seedPriceEdgeRows(text: string): Promise<Array<{ productId: number; expectedRevisionId: number }>> {
      const last = W7_EDGE_FIRST_PRODUCT + W7_EDGE_PRODUCTS - 1;
      await execute(`INSERT INTO dropship.dropship_product_listing_setting_revisions
        (vendor_id, store_connection_id, product_id, previous_revision_id, request_id, text_above_mode, text_above, text_below_mode, text_below,
         shelf_mode, shelf_ids, shelf_names, idempotency_key, request_hash, actor_type, actor_id, created_at)
        SELECT $1, $2, p, NULL, NULL, 'own', $3, 'own', $3, 'own', '["11"]'::jsonb, '["Supplies:Top"]'::jsonb, 'seed-w7e:' || p, $4, 'vendor', 'seed', $5
        FROM generate_series($6::int, $7::int) p`, [VENDOR, STORE, text, "d".repeat(64), NOW, W7_EDGE_FIRST_PRODUCT, last]);
      await execute(`INSERT INTO dropship.dropship_product_listing_settings (vendor_id, store_connection_id, product_id, revision_id)
        SELECT vendor_id, store_connection_id, product_id, id FROM dropship.dropship_product_listing_setting_revisions
        WHERE idempotency_key LIKE 'seed-w7e:%'`);
      await execute(`ANALYZE dropship.dropship_product_listing_settings, dropship.dropship_product_listing_setting_revisions, catalog.products,
        catalog.product_variants, public.shopify_variants, membership.plan_variant_overrides`);
      const rows = await execute(`SELECT product_id, revision_id FROM dropship.dropship_product_listing_settings WHERE product_id >= $1
        ORDER BY product_id`, [W7_EDGE_FIRST_PRODUCT]);
      return rows.rows.map((entry: Row) => ({ productId: entry.product_id as number, expectedRevisionId: entry.revision_id as number }));
    }
    async function storedRowsBytes(reviewId: string): Promise<number> {
      return (await execute("SELECT octet_length(rows::text)::int AS bytes FROM dropship.dropship_pricing_reviews WHERE id = $1", [reviewId]))
        .rows[0].bytes as number;
    }

    /** One measured step; with `live`, its live peak over a collected start (the stop rule's input). */
    async function measured<T>(label: string, live: boolean, work: (pool: Pool) => Promise<T>, extra: Record<string, unknown>): Promise<T> {
      const counter: StatementCounter = { statements: 0 };
      const probe = live ? liveHeapProbe(W7_LIVE_POINTS) : null;
      collectGarbage?.();
      const liveStart = process.memoryUsage().heapUsed;
      const fields: Record<string, unknown> = { ...extra };
      return measure(live ? `${label}_live` : label, W7_EDGE_PRODUCTS, counter, async () => {
        const answer = await work(scopedPool(counter, probe?.hook));
        if (probe) {
          const peak = probe.peakBytes();
          const growth = peak === null ? null : Number(((peak - liveStart) / 1_048_576).toFixed(1));
          fields.livePeakDeltaMiB = growth;
          fields.overStopRuleLimit = growth === null ? null : growth > LIMIT_MIB;
        }
        return answer;
      }, fields);
    }

    async function runPriceEdge(kind: "product_prices" | "category_price", mode: "rule" | "live"): Promise<void> {
      await seedPriceEdgeCatalog();
      // The rows' stored size, from a check of the same rows before any text is stored (a shelf clear changes no price).
      const sizing = await check(edgeBody(kind));
      const rowsBytes = await storedRowsBytes(sizing.reviewId);
      const partBytes = Math.floor((MAX_BULK_TEXT_BYTES - rowsBytes) / (2 * W7_EDGE_PRODUCTS));
      const products = await seedPriceEdgeRows(twoByteText(partBytes));
      const textBytes = W7_EDGE_PRODUCTS * 2 * partBytes;
      expect(textBytes + rowsBytes).toBeLessThanOrEqual(MAX_BULK_TEXT_BYTES);
      const extra = { products: W7_EDGE_PRODUCTS, sizes: W7_EDGE_PRODUCTS, textBytes, reviewRowsBytes: rowsBytes,
        countedBytes: textBytes + rowsBytes, kind };
      const label = `w7_${kind === "product_prices" ? "products" : "category_clear"}_${W7_EDGE_PRODUCTS}_budget_stored_two_byte`;
      const review = await measured(`${label}_review`, mode === "live", (pool) => check(edgeBody(kind, products), pool), extra);
      expect(review.summary).toMatchObject({ total: W7_EDGE_PRODUCTS, refused: 0 });
      expect(await storedRowsBytes(review.reviewId)).toBe(rowsBytes);
      const applied = await measured(`${label}_apply`, mode === "live", (pool) => applyOf(review, `pg10-${kind}-${mode}`, pool), extra);
      expect(applied).toMatchObject({ outcome: "changed", changedProductCount: W7_EDGE_PRODUCTS, releasedSizeCount: 0 });
      expect(log.info).toHaveBeenLastCalledWith("dropship.listing_settings.price_change_applied", expect.objectContaining({
        text_bytes: textBytes, review_rows_bytes: rowsBytes }));
      // Every rewritten row carries both stored texts, counted by PostgreSQL.
      const stored = await execute(`SELECT count(*)::int AS n, COALESCE(sum(octet_length(text_above) + octet_length(text_below)), 0)::bigint AS bytes
        FROM dropship.dropship_product_listing_setting_revisions WHERE request_id = $1`, [applied.requestId]);
      expect(stored.rows[0]).toEqual({ n: W7_EDGE_PRODUCTS, bytes: String(textBytes) });
    }

    it(`measures a products check and apply of ${W7_EDGE_PRODUCTS} products at the budget, stored two-byte (PG 10)`,
      () => runPriceEdge("product_prices", "rule"), BULK_TEST_TIMEOUT_MS);
    it(`measures a category check and apply clearing ${W7_EDGE_PRODUCTS} products at the budget (PG 10)`,
      () => runPriceEdge("category_price", "rule"), BULK_TEST_TIMEOUT_MS);
    it.runIf(HEAP_DIAGNOSTICS)("measures the live heap of the products check and apply (PG 10, opt-in; plan 9.7's stop rule)",
      () => runPriceEdge("product_prices", "live"), BULK_TEST_TIMEOUT_MS);
    it.runIf(HEAP_DIAGNOSTICS)("measures the live heap of the category check and apply (PG 10, opt-in; plan 9.7's stop rule)",
      () => runPriceEdge("category_price", "live"), BULK_TEST_TIMEOUT_MS);

    it("refuses a check whose stored text fills the budget once its rows count, storing nothing (PG 10, the stop rule)", async () => {
      await seedPriceEdgeCatalog();
      // The text alone is at the budget (2 x 1,500 B a product), so only the rows take it over.
      const products = await seedPriceEdgeRows(twoByteText(MAX_BULK_TEXT_BYTES / (2 * W7_EDGE_PRODUCTS)));
      const before = await count("dropship.dropship_pricing_reviews");
      const error = await expectDropshipError(check(edgeBody("category_price", products)), "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE");
      // `reason` says that `textBytes` is the text and the rows together.
      expect(error.context).toMatchObject({ reason: "price_check_rows", maxTextBytes: MAX_BULK_TEXT_BYTES, productCount: W7_EDGE_PRODUCTS });
      expect(error.context?.textBytes as number).toBeGreaterThan(MAX_BULK_TEXT_BYTES);
      // Refused after its insert, in its transaction: the row rolled back with it.
      expect(await count("dropship.dropship_pricing_reviews")).toBe(before);
    }, BULK_TEST_TIMEOUT_MS);
  });

  describe("W13, \"Got it\" (POST …/category-moves/acknowledge), and the first-mark job (plan PR 9, 10.4, 10.5, 10.9)", () => {
    const LATER = new Date("2026-10-12T10:30:00.000Z");
    const JOB_KEY = "category-marks:2026-10-12T09";
    const SLEEVES = 5;
    const SECOND_PRODUCT = 8;
    const MISSING_PRODUCT = 999;
    const movesKey = (label: string) => `category-moves:${label}`;
    const moves = (repositoryPool: Pool = scopedPool(), now = LATER) => new DropshipListingCategoryMovesService({
      repository: new PgDropshipListingSettingWritesRepository(repositoryPool), clock: { now: () => now }, timer: () => performance.now(), log });
    const jobLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    /** The job as production wires it (dropship-category-marks.factory.ts), over the isolated schema: the real source and wrapper. */
    const job = (repositoryPool: Pool = scopedPool(), now = NOW) => new DropshipCategoryMarksJobService({
      source: new PgDropshipCategoryMarksJobSource(repositoryPool), repository: new PgDropshipListingSettingWritesRepository(repositoryPool),
      clock: { now: () => now }, timer: () => performance.now(), log: jobLog });
    const marksOf = async (storeId: number) => (await execute(`SELECT product_id, category_id, seen_at FROM dropship.dropship_product_category_seen
      WHERE store_connection_id = $1 ORDER BY product_id`, [storeId])).rows;
    const markWrites = async () => ({
      marks: await count("dropship.dropship_product_category_seen"),
      ledger: await count("dropship.dropship_product_listing_setting_requests"),
      audit: await count("dropship.dropship_audit_events"),
    });
    /** A Toploaders product with one sellable size: chosen by every vendor whose rules choose the catalog. */
    async function seedChosenProduct(productId: number, sizeId: number): Promise<void> {
      await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type, shopify_product_id)
        VALUES ($1::int, 'MARK-' || $1::text, 'Product ' || $1::text, 'Toploaders', $2, 'toploader', (8100000000 + $1::int)::text)`,
      [productId, TOPLOADERS]);
      await execute(`INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, weight_grams, sales_eligibility)
        VALUES ($1::int, $2::int, 'MARK-SIZE-' || $1::text, 'One', (7400000000 + $1::int)::text, 100, 'sellable')`, [sizeId, productId]);
    }
    const requestHashOfMoves = (storeConnectionId: number, items: Array<{ productId: number; shownCategoryId: number | null }>) =>
      listingSettingRequestHash({ operation: "category_moves_acknowledge_v1", storeConnectionId,
        items: [...items].sort((left, right) => left.productId - right.productId) });

    beforeEach(async () => {
      for (const mock of Object.values(jobLog)) mock.mockClear();
      await execute("INSERT INTO catalog.product_categories (id, name) VALUES (5, 'Sleeves')");
      // A second chosen product of the Toploaders category.
      await seedChosenProduct(SECOND_PRODUCT, 801);
    });

    it("acknowledges through the real wrapper: the shown category, a product moved again, one gone, with its ledger and audit rows", async () => {
      await job().runOnce();
      expect(await marksOf(STORE)).toEqual([{ product_id: PRODUCT_7, category_id: TOPLOADERS, seen_at: NOW },
        { product_id: SECOND_PRODUCT, category_id: TOPLOADERS, seen_at: NOW }]);
      // Card Shellz moves both to Sleeves; product 8 moves again (to no category) before the vendor confirms.
      await execute("UPDATE catalog.products SET category_id = $1 WHERE id IN (7, 8)", [SLEEVES]);
      await execute("UPDATE catalog.products SET category_id = NULL WHERE id = 8");
      const items = [{ productId: MISSING_PRODUCT, shownCategoryId: SLEEVES }, { productId: SECOND_PRODUCT, shownCategoryId: SLEEVES },
        { productId: PRODUCT_7, shownCategoryId: SLEEVES }];

      const result = await moves().acknowledgeForMember(MEMBER, STORE, { idempotencyKey: movesKey("got-it"), items });

      expect(result).toEqual({ outcome: "acknowledged", acknowledgedProductIds: [PRODUCT_7], movedAgainProductIds: [SECOND_PRODUCT] });
      expect(await marksOf(STORE)).toEqual([{ product_id: PRODUCT_7, category_id: SLEEVES, seen_at: LATER },
        { product_id: SECOND_PRODUCT, category_id: TOPLOADERS, seen_at: NOW }]);
      // Vendor 11's store keeps its own marks.
      expect(await marksOf(OTHER_VENDOR_STORE)).toEqual([{ product_id: PRODUCT_7, category_id: TOPLOADERS, seen_at: NOW },
        { product_id: SECOND_PRODUCT, category_id: TOPLOADERS, seen_at: NOW }]);
      const ledger = await execute(`SELECT vendor_id, store_connection_id, operation, idempotency_key, request_hash, product_count, actor_type, actor_id
        FROM dropship.dropship_product_listing_setting_requests`);
      expect(ledger.rows).toEqual([{ vendor_id: VENDOR, store_connection_id: STORE, operation: "category_moves_acknowledge",
        idempotency_key: movesKey("got-it"), request_hash: requestHashOfMoves(STORE, items), product_count: 1, actor_type: "vendor",
        actor_id: MEMBER }]);
      const audit = await execute(`SELECT event_type, actor_type, actor_id, payload FROM dropship.dropship_audit_events
        WHERE event_type = 'category_moves_acknowledged'`);
      expect(audit.rows).toEqual([{ event_type: "category_moves_acknowledged", actor_type: "vendor", actor_id: MEMBER,
        payload: expect.objectContaining({ requestKey: movesKey("got-it"),
          acknowledged: [{ productId: PRODUCT_7, hadMark: true, from: TOPLOADERS, to: SLEEVES }], acknowledgedCount: 1,
          movedAgain: [SECOND_PRODUCT], movedAgainCount: 1, notInCatalog: [MISSING_PRODUCT], notInCatalogCount: 1 }) }]);
      expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.category_moves_acknowledged", expect.objectContaining({
        outcome: "acknowledged", vendor_id: VENDOR, store_connection_id: STORE, item_count: 3, acknowledged_count: 1, moved_again_count: 1,
        acknowledged_product_ids: [PRODUCT_7], moved_again_product_ids: [SECOND_PRODUCT] }));
    });

    it("answers a retry from the probe's ledger row as replayed, in exactly 7 statements, writing nothing", async () => {
      await job().runOnce();
      await execute("UPDATE catalog.products SET category_id = $1 WHERE id = 7", [SLEEVES]);
      const body = { idempotencyKey: movesKey("retry"), items: [{ productId: PRODUCT_7, shownCategoryId: SLEEVES }] };
      await expect(moves().acknowledgeForMember(MEMBER, STORE, body)).resolves.toMatchObject({ outcome: "acknowledged" });
      // Card Shellz moves it again after the commit; the retry is answered from the ledger, not checked again.
      await execute("UPDATE catalog.products SET category_id = NULL WHERE id = 7");
      const before = await markWrites();
      const counter: StatementCounter = { statements: 0 };

      const retry = await moves(scopedPool(counter)).acknowledgeForMember(MEMBER, STORE, body);

      expect(retry).toEqual({ outcome: "replayed", acknowledgedProductIds: [], movedAgainProductIds: [] });
      expect(await markWrites()).toEqual(before);
      // BEGIN, request lock, store lock, owner rows, the gate's store read, the probe, COMMIT: no writer.
      expect(counter.statements).toBe(7);
    });

    it("refuses a key a W8 save used with the permanent 409, writing nothing", async () => {
      const shared = "shared-key:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
      await sizePrices().saveForMember(MEMBER, STORE, { idempotencyKey: shared, rows: [row(101)] });
      const before = await markWrites();

      const error = await expectDropshipError(moves().acknowledgeForMember(MEMBER, STORE, { idempotencyKey: shared,
        items: [{ productId: PRODUCT_7, shownCategoryId: TOPLOADERS }] }), "DROPSHIP_IDEMPOTENCY_CONFLICT");

      expect(error.context).toMatchObject({ storeConnectionId: STORE, mismatched: ["size", "size.requestHash"], classification: "permanent" });
      expect(await markWrites()).toEqual(before);
    });

    it("rolls the marks and the ledger row back with a failed audit row, then commits the same request once (3.12 #7)", async () => {
      await job().runOnce();
      await execute("UPDATE catalog.products SET category_id = $1 WHERE id IN (7, 8)", [SLEEVES]);
      const before = await markWrites();
      const marks = await marksOf(STORE);
      const body = { idempotencyKey: movesKey("atomic"), items: [{ productId: PRODUCT_7, shownCategoryId: SLEEVES },
        { productId: SECOND_PRODUCT, shownCategoryId: SLEEVES }] };
      // The audit row is the writer's last statement: the marks' upsert and the ledger row are written by then.
      const failing = scopedPool(undefined, (sql) => {
        if (sql.includes("'category_moves_acknowledged'")) throw new Error("injected audit failure");
      });

      await expect(moves(failing).acknowledgeForMember(MEMBER, STORE, body)).rejects.toThrow("injected audit failure");

      expect(await markWrites()).toEqual(before);
      expect(await marksOf(STORE)).toEqual(marks);
      expect(log.info).not.toHaveBeenCalled();

      // The rolled-back attempt spent no key: the same request commits once.
      await expect(moves().acknowledgeForMember(MEMBER, STORE, body)).resolves.toEqual({ outcome: "acknowledged",
        acknowledgedProductIds: [PRODUCT_7, SECOND_PRODUCT], movedAgainProductIds: [] });
      expect(await markWrites()).toEqual({ marks: before.marks, ledger: before.ledger + 1, audit: before.audit + 1 });
      expect(await marksOf(STORE)).toEqual([{ product_id: PRODUCT_7, category_id: SLEEVES, seen_at: LATER },
        { product_id: SECOND_PRODUCT, category_id: SLEEVES, seen_at: LATER }]);
    });

    it("refuses another vendor's store (the owner check) and a paused store (the gate), writing nothing", async () => {
      const body = { idempotencyKey: movesKey("gate"), items: [{ productId: PRODUCT_7, shownCategoryId: TOPLOADERS }] };
      await expectDropshipError(moves().acknowledgeForMember(MEMBER, OTHER_VENDOR_STORE, body), "DROPSHIP_STORE_CONNECTION_REQUIRED");
      await execute("UPDATE dropship.dropship_store_connections SET status = 'paused' WHERE id = $1", [STORE]);
      const paused = await expectDropshipError(moves().acknowledgeForMember(MEMBER, STORE, body), "DROPSHIP_LISTING_STORE_BLOCKED");
      expect(paused.context).toMatchObject({ reason: "paused", classification: "permanent" });
      expect(await markWrites()).toEqual({ marks: 0, ledger: 0, audit: 0 });
    });

    it("serializes one key sent twice at once: the same body replays, another body is a conflict, another store too", async () => {
      const body = { idempotencyKey: movesKey("twice"), items: [{ productId: PRODUCT_7, shownCategoryId: TOPLOADERS }] };
      const paused = gate((sql) => sql === "COMMIT");
      const first = moves(scopedPool(undefined, paused.hook)).acknowledgeForMember(MEMBER, STORE, body);
      let second: Promise<unknown> | undefined;
      let third: Promise<unknown> | undefined;
      try {
        await within(paused.reached, "the first Got it's commit");
        second = moves().acknowledgeForMember(MEMBER, STORE, body);
        third = moves().acknowledgeForMember(MEMBER, STORE, { ...body, items: [{ productId: PRODUCT_7, shownCategoryId: null }] })
          .then(() => null, (reason: unknown) => reason);
        await waitUntilLockWait("dropship_listing_settings_request", 2);
        paused.open();
        await expect(within(first, "the first Got it")).resolves.toEqual({ outcome: "acknowledged", acknowledgedProductIds: [PRODUCT_7],
          movedAgainProductIds: [] });
        await expect(within(second, "the same body")).resolves.toEqual({ outcome: "replayed", acknowledgedProductIds: [],
          movedAgainProductIds: [] });
        await expect(within(third, "another body")).resolves.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT",
          context: { mismatched: ["ledger.requestHash"] } });
      } finally {
        paused.open();
        await within(Promise.allSettled([first, ...(second ? [second] : []), ...(third ? [third] : [])]), "the same-key case's clean-up");
      }
      expect(await count("dropship.dropship_product_listing_setting_requests")).toBe(1);

      // The member's second store, the same key: the probe sees the first store's ledger row.
      await addVendorStore(24);
      const otherStore = await expectDropshipError(moves().acknowledgeForMember(MEMBER, 24, body), "DROPSHIP_IDEMPOTENCY_CONFLICT");
      expect(otherStore.context?.mismatched).toEqual(["ledger.requestHash", "ledger.storeConnectionId"]);
    });

    it("marks the chosen products of every eligible store once; a rerun in the same hour inserts and audits nothing", async () => {
      // Vendor 10's other stores: one needing a sign-in and one whose token refresh failed (marked), paused and Shopify (skipped).
      for (const [storeId, platform, status] of [[24, "ebay", "needs_reauth"], [25, "ebay", "refresh_failed"], [26, "ebay", "paused"],
        [27, "shopify", "connected"]] as const) {
        await execute(`INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, access_token_ref, refresh_token_ref, status, setup_status)
          VALUES ($1, $2, $3, 'vault:a', 'vault:r', $4, 'ready')`, [storeId, VENDOR, platform, status]);
      }
      // A closed vendor's store (skipped) and an onboarding vendor's store (marked), each choosing the whole catalog.
      await execute(`INSERT INTO membership.member_subscriptions VALUES ('sub-3', 'member-3', 'ops'), ('sub-4', 'member-4', 'ops');
        INSERT INTO dropship.dropship_vendors (id, member_id, current_subscription_id, current_plan_id, status, entitlement_status)
          VALUES (12, 'member-3', 'sub-3', 'ops', 'closed', 'active'), (13, 'member-4', 'sub-4', 'ops', 'onboarding', 'active');
        INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, access_token_ref, refresh_token_ref, status, setup_status)
          VALUES (28, 12, 'ebay', 'vault:a', 'vault:r', 'connected', 'ready'), (29, 13, 'ebay', 'vault:a', 'vault:r', 'connected', 'ready');
        INSERT INTO dropship.dropship_vendor_selection_rules (id, vendor_id, scope_type, action, priority)
          VALUES (3, 12, 'catalog', 'include', 0), (4, 13, 'catalog', 'include', 0);`);
      // Product 9's only size is not sellable (no one chooses it); vendor 10 leaves product 10 out.
      await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type, shopify_product_id)
          VALUES (9, 'NS', 'Not for sale', 'Toploaders', 3, 'toploader', '8000000009');
        INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, weight_grams, sales_eligibility)
          VALUES (901, 9, 'NS-1', 'One', '7000000901', 100, 'not_sellable');`);
      await seedChosenProduct(10, 1001);
      await execute(`INSERT INTO dropship.dropship_vendor_selection_rules (id, vendor_id, scope_type, action, product_id, priority)
        VALUES (5, 10, 'product', 'exclude', 10, 0)`);

      const result = await job().runOnce();

      expect(result).toMatchObject({ jobKey: JOB_KEY, storesScanned: 5, vendorsScanned: 3, vendorsFailed: 0, storesFailed: 0, insertedCount: 12 });
      const marked = await execute(`SELECT store_connection_id, array_agg(product_id ORDER BY product_id) AS products
        FROM dropship.dropship_product_category_seen GROUP BY store_connection_id ORDER BY store_connection_id`);
      expect(marked.rows).toEqual([
        { store_connection_id: STORE, products: [PRODUCT_7, SECOND_PRODUCT] },
        { store_connection_id: OTHER_VENDOR_STORE, products: [PRODUCT_7, SECOND_PRODUCT, 10] },
        { store_connection_id: 24, products: [PRODUCT_7, SECOND_PRODUCT] },
        { store_connection_id: 25, products: [PRODUCT_7, SECOND_PRODUCT] },
        { store_connection_id: 29, products: [PRODUCT_7, SECOND_PRODUCT, 10] },
      ]);
      expect(await count("dropship.dropship_product_category_seen", "seen_at <> $1 OR category_id <> $2", [NOW, TOPLOADERS])).toBe(0);
      const audit = await execute(`SELECT store_connection_id, entity_type, actor_type, actor_id, payload->>'insertedCount' AS inserted
        FROM dropship.dropship_audit_events WHERE event_type = 'category_marks_seeded' ORDER BY store_connection_id`);
      expect(audit.rows).toEqual([[STORE, 2], [OTHER_VENDOR_STORE, 3], [24, 2], [25, 2], [29, 3]].map(([storeId, inserted]) => ({
        store_connection_id: storeId, entity_type: "dropship_store_connection", actor_type: "system", actor_id: JOB_KEY,
        inserted: String(inserted) })));
      expect(jobLog.info).toHaveBeenCalledWith("dropship.listing_settings.category_marks_tick", expect.objectContaining({
        outcome: "completed", inserted_count: 12 }));
      const before = await markWrites();

      // Restarted later in the same hour (or a second dyno once the lock frees): the same key, nothing to insert.
      jobLog.info.mockClear();
      const rerun = await job(scopedPool(), new Date("2026-10-12T09:45:00.000Z")).runOnce();

      expect(rerun).toMatchObject({ jobKey: JOB_KEY, storesScanned: 5, insertedCount: 0, storesFailed: 0, vendorsFailed: 0 });
      expect(await markWrites()).toEqual(before);
      expect(jobLog.info).not.toHaveBeenCalled();
      expect(jobLog.debug).toHaveBeenCalledWith("dropship.listing_settings.category_marks_tick", expect.objectContaining({ inserted_count: 0 }));
    });

    describe("concurrency", () => {
      it("(a) makes the job's insert wait for a listing write holding the store lock, then marks", async () => {
        const paused = gate((sql) => sql === "COMMIT");
        const w5 = products(scopedPool(undefined, paused.hook)).saveForMember(MEMBER, STORE, PRODUCT_7, {
          idempotencyKey: productKey("before-marks"), expectedRevisionId: null, patch: { storeShelf: { mode: "none" } } });
        let tick: Promise<unknown> | undefined;
        try {
          await within(paused.reached, "the W5 commit");
          tick = job().runOnce();
          await waitUntilLockWait("dropship_listing_push_job", 1);
          expect(await count("dropship.dropship_product_category_seen")).toBe(0);
          paused.open();
          await expect(within(w5, "W5")).resolves.toMatchObject({ outcome: "changed" });
          await expect(within(tick, "the tick")).resolves.toMatchObject({ insertedCount: 4, storesFailed: 0 });
        } finally {
          paused.open();
          await within(Promise.allSettled([w5, ...(tick ? [tick] : [])]), "the store-lock case's clean-up");
        }
        expect(await marksOf(STORE)).toEqual([{ product_id: PRODUCT_7, category_id: TOPLOADERS, seen_at: NOW },
          { product_id: SECOND_PRODUCT, category_id: TOPLOADERS, seen_at: NOW }]);
      });

      it("(b) inserts nothing for a product a Got it marked while the job's insert waited", async () => {
        const paused = gate((sql) => sql === "COMMIT");
        const gotIt = moves(scopedPool(undefined, paused.hook)).acknowledgeForMember(MEMBER, STORE, { idempotencyKey: movesKey("during-tick"),
          items: [{ productId: PRODUCT_7, shownCategoryId: TOPLOADERS }] });
        let tick: Promise<unknown> | undefined;
        try {
          await within(paused.reached, "the Got it's commit");
          tick = job().runOnce();
          await waitUntilLockWait("dropship_listing_push_job", 1);
          paused.open();
          await expect(within(gotIt, "the Got it")).resolves.toMatchObject({ outcome: "acknowledged", acknowledgedProductIds: [PRODUCT_7] });
          // Store 22: only product 8 is new; store 23 (vendor 11): both.
          await expect(within(tick, "the tick")).resolves.toMatchObject({ insertedCount: 3, storesFailed: 0 });
        } finally {
          paused.open();
          await within(Promise.allSettled([gotIt, ...(tick ? [tick] : [])]), "the Got-it-during-tick case's clean-up");
        }
        // The Got it's mark is kept as it wrote it (its time, not the job's), and the job's audit names product 8 only.
        expect(await marksOf(STORE)).toEqual([{ product_id: PRODUCT_7, category_id: TOPLOADERS, seen_at: LATER },
          { product_id: SECOND_PRODUCT, category_id: TOPLOADERS, seen_at: NOW }]);
        const seeded = await execute(`SELECT payload FROM dropship.dropship_audit_events
          WHERE event_type = 'category_marks_seeded' AND store_connection_id = $1`, [STORE]);
        expect(seeded.rows).toEqual([{ payload: { jobKey: JOB_KEY, insertedCount: 1, productIds: [SECOND_PRODUCT] } }]);
      });
    });

    it("measures the job over 10,000 chosen products in one store, then one Got it for all 10,000 (logged, not asserted)", async () => {
      const PRODUCTS = MAX_LISTING_SETTING_BULK_PRODUCTS;
      const FIRST_PRODUCT = 20_001;
      const FIRST_SIZE = 300_001;
      // One store: vendor 11's is disconnected, so the tick scans one vendor and inserts in one store.
      await execute("UPDATE dropship.dropship_store_connections SET status = 'disconnected' WHERE id = $1", [OTHER_VENDOR_STORE]);
      await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type, shopify_product_id)
        SELECT g, 'MARK-' || g, 'Marked product ' || g, 'Toploaders', $3, 'toploader', (9200000000 + g)::text
        FROM generate_series($1::int, $2::int) g`, [FIRST_PRODUCT, FIRST_PRODUCT + PRODUCTS - 1, TOPLOADERS]);
      await execute(`INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, weight_grams, sales_eligibility)
        SELECT $1::int + i, $3::int + i, 'MARK-SIZE-' || i, 'Size ' || i, (7300000000 + i)::text, 100, 'sellable'
        FROM generate_series(0, $2::int - 1) i`, [FIRST_SIZE, PRODUCTS, FIRST_PRODUCT]);
      const counter: StatementCounter = { statements: 0 };

      const result = await measure(`first-mark job, ${PRODUCTS} chosen products`, PRODUCTS, counter, () => job(scopedPool(counter)).runOnce());

      // Product 7, product 8 and the 10,000.
      expect(result).toMatchObject({ storesScanned: 1, vendorsScanned: 1, insertedCount: PRODUCTS + 2, storesFailed: 0, vendorsFailed: 0 });
      expect(await count("dropship.dropship_product_category_seen", "store_connection_id = $1", [STORE])).toBe(PRODUCTS + 2);
      process.stdout.write(`${JSON.stringify({ measurement: "first-mark job tick", elapsed_ms: result.elapsedMs,
        inserted_count: result.insertedCount, statements: counter.statements })}\n`);

      // Card Shellz moves all of them; "Got it for all N" (plan 10.8 #1) at W13's bound, 10,000 items in one request.
      await execute("UPDATE catalog.products SET category_id = $1 WHERE id BETWEEN $2 AND $3",
        [SLEEVES, FIRST_PRODUCT, FIRST_PRODUCT + PRODUCTS - 1]);
      const items = Array.from({ length: PRODUCTS }, (_, index) => ({ productId: FIRST_PRODUCT + index, shownCategoryId: SLEEVES }));
      const gotItCounter: StatementCounter = { statements: 0 };

      const acknowledged = await measure(`W13 Got it for all ${PRODUCTS}`, PRODUCTS, gotItCounter,
        () => moves(scopedPool(gotItCounter)).acknowledgeForMember(MEMBER, STORE, { idempotencyKey: movesKey("all-10000"), items }));

      expect(acknowledged.acknowledgedProductIds).toHaveLength(PRODUCTS);
      expect(acknowledged.movedAgainProductIds).toEqual([]);
      expect(await count("dropship.dropship_product_category_seen", "store_connection_id = $1 AND category_id = $2 AND seen_at = $3",
        [STORE, SLEEVES, LATER])).toBe(PRODUCTS);
    }, BULK_TEST_TIMEOUT_MS);
  });

  describe("PR 11's conversion record and its writers (plan section 12, 7.A.2 rows 4-10, 7.A.3 PG)", () => {
    const RECORDS = "dropship_listing_rule_conversions";
    const RECORDS_TABLE = `dropship.${RECORDS}`;
    const CONVERSION_KEY = "ls-convert:0b8e7c1d-5f4a-4c3b-9a2e-1d0c9b8a7f6e";
    const SYSTEM_KEY = `rules-conversion:${STORE}`;
    const HASHES = { requestHash: "a".repeat(64), planHash: "b".repeat(64), writesHash: "c".repeat(64) };
    const RECIPE = { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "up_99" } as const;
    const LATER_SEEN = new Date("2026-10-13T08:00:00.000Z");
    type Client = Pick<PoolClient, "query">;

    /** One transaction on one pooled client, as the conversion will run (11c2): BEGIN, the work, COMMIT; ROLLBACK on any failure. */
    async function inTransaction<T>(work: (client: Client) => Promise<T>, repositoryPool: Pool = scopedPool()): Promise<T> {
      const client = await repositoryPool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    const record = (overrides: Partial<ListingRuleConversionInsert> = {}): ListingRuleConversionInsert => ({
      vendorId: VENDOR, storeConnectionId: STORE, idempotencyKey: CONVERSION_KEY, ...HASHES, clean: false, changedSizeCount: 3,
      categoryCount: 1, productCount: 2, pricingGroupsRemoved: 1, contentGroupsRemoved: 1, ebayRulesRemoved: 1,
      actor: { actorType: "vendor", actorId: MEMBER }, now: NOW, ...overrides });
    const systemRecord = (overrides: Partial<ListingRuleConversionInsert> = {}) => record({ idempotencyKey: SYSTEM_KEY, clean: true,
      changedSizeCount: 0, actor: { actorType: "system", actorId: "rules-conversion-job" }, ...overrides });
    /** A row written straight to the table (no writer), so the database's own rules are what refuses it. */
    function rawRecord(fields: Record<string, unknown> = {}) {
      const row: Record<string, unknown> = { vendor_id: VENDOR, store_connection_id: STORE, idempotency_key: `ls-convert:raw-${randomUUID()}`,
        request_hash: HASHES.requestHash, plan_hash: HASHES.planHash, writes_hash: HASHES.writesHash, clean: true, changed_size_count: 0,
        category_count: 0, product_count: 0, pricing_groups_removed: 0, content_groups_removed: 0, ebay_rules_removed: 0,
        actor_type: "system", actor_id: "rules-conversion-job", created_at: NOW, notice_seen_at: null, notice_seen_by: null, ...fields };
      const columns = Object.keys(row);
      return execute(`INSERT INTO ${RECORDS_TABLE} (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
        RETURNING id`, Object.values(row));
    }
    async function pgError(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string; message: string }> {
      const error = await promise.then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(DropshipError);
      return error as { code?: string; constraint?: string; message: string };
    }
    async function recordsShape() {
      const constraints = await pool.query(`SELECT conname, contype, convalidated, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`, [`"${schema}"."${RECORDS}"`]);
      const indexes = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
        [schema, RECORDS]);
      const triggers = await pool.query(`SELECT tgname, tgtype, tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal
        ORDER BY tgname`, [`"${schema}"."${RECORDS}"`]);
      return { constraints: constraints.rows, indexes: indexes.rows, triggers: triggers.rows };
    }
    const allRecords = async () => (await execute(`SELECT * FROM ${RECORDS_TABLE} ORDER BY id`)).rows;

    it("refuses by its CHECKs, 23514 each, what a record must never hold: D1 first, and accepts the rows the plan writes", async () => {
      for (const [label, fields, purpose] of [
        ["a system row that is not clean (D1)", { clean: false }, "system_clean_chk"],
        ["a clean system row that changed a size", { changed_size_count: 1 }, "clean_chk"],
        ["a clean vendor row that changed a size", { actor_type: "vendor", actor_id: MEMBER, changed_size_count: 2 }, "clean_chk"],
        ["an admin actor", { actor_type: "admin" }, "actor_chk"],
        ["a blank actor", { actor_id: "  " }, "actor_id_chk"],
        ["a short key", { idempotency_key: "short" }, "key_chk"],
        ["an upper-case plan hash", { plan_hash: "B".repeat(64) }, "hash_chk"],
        ["10,001 products", { product_count: 10_001 }, "count_chk"],
        ["a negative category count", { category_count: -1 }, "count_chk"],
        ["101 eBay rules removed", { ebay_rules_removed: 101 }, "removed_chk"],
        ["a vendor row with a notice", { actor_type: "vendor", actor_id: MEMBER, clean: false, changed_size_count: 1, notice_seen_at: NOW,
          notice_seen_by: MEMBER }, "notice_chk"],
        ["a notice with no reader", { notice_seen_at: NOW }, "notice_chk"],
        ["a notice read by a blank reader", { notice_seen_at: NOW, notice_seen_by: " " }, "notice_chk"],
      ] as const) {
        const error = await pgError(rawRecord(fields));
        expect({ label, code: error.code, constraint: error.constraint })
          .toEqual({ label, code: "23514", constraint: `dropship_listing_rule_conversion_${purpose}` });
      }
      // The wrapper answers a CHECK as the fatal INVARIANT_FAILED, as for every CHECK (plan 3.4).
      expect(mapListingSettingWriteError(await pgError(rawRecord({ clean: false })))).toMatchObject({
        code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
        context: { constraint: "dropship_listing_rule_conversion_system_clean_chk", classification: "fatal" } });
      // Another vendor's store: the owner foreign key (23503).
      const owner = await pgError(rawRecord({ store_connection_id: OTHER_VENDOR_STORE }));
      expect({ code: owner.code, constraint: owner.constraint }).toEqual({ code: "23503", constraint: "dropship_listing_rule_conversion_owner_fk" });
      expect(await count(RECORDS_TABLE)).toBe(0);

      // What the plan writes: a clean system row, a vendor row that is not clean, a vendor row that is, a system row seen once.
      await rawRecord();
      await rawRecord({ actor_type: "vendor", actor_id: MEMBER, clean: false, changed_size_count: 10_000, category_count: 10_000,
        product_count: 10_000, pricing_groups_removed: 100, content_groups_removed: 100, ebay_rules_removed: 100 });
      await rawRecord({ actor_type: "vendor", actor_id: MEMBER });
      await rawRecord({ notice_seen_at: NOW, notice_seen_by: MEMBER });
      expect(await count(RECORDS_TABLE)).toBe(4);
    });

    it("refuses every DELETE, and every UPDATE but marking a system row's notice seen once (the guard, 23514)", async () => {
      const vendorId = (await rawRecord({ actor_type: "vendor", actor_id: MEMBER, clean: false, changed_size_count: 2 })).rows[0].id as string;
      const systemId = (await rawRecord()).rows[0].id as string;
      const otherSystemId = (await rawRecord({ store_connection_id: OTHER_VENDOR_STORE, vendor_id: 11 })).rows[0].id as string;
      const update = (id: string, set: string, values: unknown[] = []) =>
        execute(`UPDATE ${RECORDS_TABLE} SET ${set} WHERE id = $1`, [id, ...values]);
      // Each attempt runs only when its turn comes, one at a time.
      const refusals: Array<[string, () => Promise<unknown>]> = [
        ["a vendor row's notice", () => update(vendorId, "notice_seen_at = $2, notice_seen_by = $3", [NOW, MEMBER])],
        ["a system row's notice time alone", () => update(systemId, "notice_seen_at = $2", [NOW])],
        ["a system row's notice with its plan hash", () => update(systemId, "notice_seen_at = $2, notice_seen_by = $3, plan_hash = $4",
          [NOW, MEMBER, "d".repeat(64)])],
        ["a system row's clean flag", () => update(systemId, "clean = false")],
        ["a system row's counts", () => update(systemId, "category_count = 1")],
        ["a system row's key", () => update(systemId, "idempotency_key = 'rules-conversion:other'")],
        ["a no-op update", () => update(vendorId, "actor_id = actor_id")],
        ["a delete of a vendor row", () => execute(`DELETE FROM ${RECORDS_TABLE} WHERE id = $1`, [vendorId])],
        ["a delete of a system row", () => execute(`DELETE FROM ${RECORDS_TABLE} WHERE id = $1`, [systemId])],
      ];
      for (const [label, attempt] of refusals) {
        const error = await pgError(attempt());
        expect({ label, code: error.code }).toEqual({ label, code: "23514" });
      }
      const before = await allRecords();

      // The one change allowed: the notice, null to values, on a system row.
      expect((await update(systemId, "notice_seen_at = $2, notice_seen_by = $3", [NOW, MEMBER])).rowCount).toBe(1);
      // Once: seeing it again, or clearing it, is refused.
      for (const [set, values] of [["notice_seen_at = $2, notice_seen_by = $3", [LATER_SEEN, "member-2"]],
        ["notice_seen_at = NULL, notice_seen_by = NULL", []]] as const) {
        expect((await pgError(update(systemId, set, [...values]))).code).toBe("23514");
      }
      // Its message names what the guard allows; the wrapper maps the trigger's 23514 to the fatal INVARIANT_FAILED.
      const again = await pgError(update(systemId, "notice_seen_at = $2, notice_seen_by = $3", [LATER_SEEN, "member-2"]));
      expect(again.message).toBe("A system conversion's notice is marked seen once, and nothing else changes");
      expect(mapListingSettingWriteError(again)).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
        context: { sqlState: "23514", classification: "fatal" } });
      expect((await pgError(execute(`DELETE FROM ${RECORDS_TABLE} WHERE id = $1`, [systemId]))).message)
        .toBe("Listing rule conversions are kept; they cannot be deleted");

      const after = await allRecords();
      expect(after).toEqual(before.map((row: Row) => String(row.id) === String(systemId)
        ? { ...row, notice_seen_at: NOW, notice_seen_by: MEMBER } : row));
      expect(after.find((row: Row) => String(row.id) === String(otherSystemId))).toMatchObject({ notice_seen_at: null });
    });

    it("re-runs over existing rows: no error, every constraint validated, the guard in place, the rows as they were", async () => {
      await rawRecord();
      await rawRecord({ actor_type: "vendor", actor_id: MEMBER, clean: false, changed_size_count: 4, notice_seen_at: null });
      const shapeBefore = await recordsShape();
      const rowsBefore = await allRecords();

      await execute(readFileSync(resolve(process.cwd(), "migrations", LISTING_RULE_CONVERSIONS_MIGRATION_FILE), "utf8"));

      const shapeAfter = await recordsShape();
      expect(shapeAfter).toEqual(shapeBefore);
      expect(shapeAfter.constraints.map((constraint: Row) => constraint.conname)).toEqual([
        "dropship_listing_rule_conversion_actor_chk", "dropship_listing_rule_conversion_actor_id_chk",
        "dropship_listing_rule_conversion_clean_chk", "dropship_listing_rule_conversion_count_chk",
        "dropship_listing_rule_conversion_hash_chk", "dropship_listing_rule_conversion_key_chk",
        LISTING_RULE_CONVERSION_KEY_CONSTRAINT, "dropship_listing_rule_conversion_notice_chk",
        "dropship_listing_rule_conversion_owner_fk", "dropship_listing_rule_conversion_removed_chk",
        "dropship_listing_rule_conversion_system_clean_chk", `${RECORDS}_pkey`,
      ]);
      expect(shapeAfter.constraints.every((constraint: Row) => constraint.convalidated === true)).toBe(true);
      expect(shapeAfter.indexes.map((index: Row) => index.indexname)).toEqual([
        "dropship_listing_rule_conversion_key_uk", "dropship_listing_rule_conversion_store_idx", `${RECORDS}_pkey`]);
      expect(shapeAfter.indexes.find((index: Row) => index.indexname === "dropship_listing_rule_conversion_store_idx")?.indexdef)
        .toMatch(/USING btree \(store_connection_id, id\)$/);
      expect(shapeAfter.triggers.map((trigger: Row) => [trigger.tgname, trigger.tgenabled])).toEqual([["listing_rule_conversion_guard", "O"]]);
      expect(await allRecords()).toEqual(rowsBefore);
      // The guard still refuses after the re-run.
      expect((await pgError(execute(`DELETE FROM ${RECORDS_TABLE}`))).code).toBe("23514");
    });

    it("records a conversion through its writer, claims the key (23505 is the key conflict), and finds it by key and by store", async () => {
      const inserted = await inTransaction((client) => insertRuleConversionWithClient(client, record()));
      expect(inserted).toMatchObject({ vendorId: VENDOR, storeConnectionId: STORE, idempotencyKey: CONVERSION_KEY, clean: false,
        changedSizeCount: 3, actorType: "vendor", actorId: MEMBER, createdAt: NOW.toISOString(), noticeSeenAt: null, noticeSeenBy: null });
      expect(Number.isSafeInteger(inserted.id)).toBe(true);

      // The key's real constraint name is the writer's, so a concurrent first use is the permanent 409.
      const raw = await pgError(rawRecord({ idempotency_key: CONVERSION_KEY, actor_type: "vendor", actor_id: MEMBER }));
      expect({ code: raw.code, constraint: raw.constraint }).toEqual({ code: "23505", constraint: LISTING_RULE_CONVERSION_KEY_CONSTRAINT });
      const conflict = await expectDropshipError(inTransaction((client) => insertRuleConversionWithClient(client,
        record({ ...HASHES, planHash: "e".repeat(64) }))), "DROPSHIP_IDEMPOTENCY_CONFLICT");
      expect(conflict.context).toMatchObject({ constraint: LISTING_RULE_CONVERSION_KEY_CONSTRAINT, classification: "permanent" });
      // The same key is another vendor's to use.
      await inTransaction((client) => insertRuleConversionWithClient(client, record({ vendorId: 11, storeConnectionId: OTHER_VENDOR_STORE })));
      expect(await count(RECORDS_TABLE)).toBe(2);

      const found = await inTransaction(async (client) => ({
        own: await findRuleConversionByKeyWithClient(client, { vendorId: VENDOR, idempotencyKey: CONVERSION_KEY }),
        missing: await findRuleConversionByKeyWithClient(client, { vendorId: VENDOR, idempotencyKey: SYSTEM_KEY }),
        store22: await hasRuleConversionWithClient(client, { storeConnectionId: STORE }),
        store24: await hasRuleConversionWithClient(client, { storeConnectionId: 24 }),
      }));
      expect(found).toEqual({ own: inserted, missing: null, store22: true, store24: false });

      // A system conversion on another store, then its notice: the record reads it back.
      await addVendorStore(24);
      const system = await inTransaction((client) => insertRuleConversionWithClient(client, systemRecord({ storeConnectionId: 24,
        idempotencyKey: "rules-conversion:24" })));
      await execute(`UPDATE ${RECORDS_TABLE} SET notice_seen_at = $2, notice_seen_by = $3 WHERE id = $1`, [system.id, NOW, MEMBER]);
      expect(await inTransaction((client) => findRuleConversionByKeyWithClient(client, { vendorId: VENDOR, idempotencyKey: "rules-conversion:24" })))
        .toEqual({ ...system, noticeSeenAt: NOW.toISOString(), noticeSeenBy: MEMBER });
      expect(await inTransaction((client) => hasRuleConversionWithClient(client, { storeConnectionId: 24 }))).toBe(true);
    });

    it("saves the pricing profile with its groups emptied: revision, head and audit row as the system, and no size price row (D11)", async () => {
      const grouped = { defaultRecipe: D1.defaultRecipe, groups: [{ id: "toploaders", name: "Toploaders rule", priority: 10,
        scope: { type: "category", category: "Toploaders" }, recipe: RECIPE }] };
      const emptied = { defaultRecipe: D1.defaultRecipe, groups: [] };
      const groupedRevision = await setStoreDefault(grouped);
      // A typed price and W1's rule adoption would both be per-size rows; the conversion must leave every one as it is.
      await typePrice(101, 1_299, "pg-convert:typed-101");
      const sizesBefore = (await execute("SELECT * FROM dropship.dropship_listing_price_revisions ORDER BY id")).rows;
      const settingsBefore = (await execute("SELECT * FROM dropship.dropship_listing_price_settings ORDER BY product_variant_id")).rows;
      const auditBefore = await count("dropship.dropship_audit_events");
      const target = { vendorId: VENDOR, storeConnectionId: STORE, actorId: "rules-conversion-job", actorType: "system" as const };

      const saved = await inTransaction(async (client) => {
        const conversion = await insertRuleConversionWithClient(client, systemRecord());
        const profile = await savePricingProfileWithClient(client, target,
          { expectedRevisionId: groupedRevision, profile: emptied, conversionId: conversion.id, now: NOW });
        return { conversion, profile };
      });

      expect(saved.profile).toEqual({ revisionId: expect.any(Number), previousRevisionId: groupedRevision });
      const revision = await execute(`SELECT previous_revision_id, profile, actor_id, created_at FROM dropship.dropship_pricing_profile_revisions
        WHERE id = $1`, [saved.profile.revisionId]);
      expect(revision.rows).toEqual([{ previous_revision_id: groupedRevision, profile: emptied, actor_id: "rules-conversion-job", created_at: NOW }]);
      expect((await execute("SELECT revision_id FROM dropship.dropship_pricing_profiles WHERE store_connection_id = $1", [STORE])).rows)
        .toEqual([{ revision_id: saved.profile.revisionId }]);
      const audits = await execute(`SELECT entity_type, entity_id, actor_type, actor_id, severity, payload, created_at
        FROM dropship.dropship_audit_events WHERE event_type = 'pricing_profile_saved'`);
      // The entity is the new revision, as W1's pricing_rules_applied rows name it: one id space under dropship_pricing_profile.
      expect(audits.rows).toEqual([{ entity_type: "dropship_pricing_profile", entity_id: String(saved.profile.revisionId), actor_type: "system",
        actor_id: "rules-conversion-job", severity: "info", created_at: NOW, payload: { conversionId: saved.conversion.id,
          revisionId: saved.profile.revisionId, previousRevisionId: groupedRevision, before: grouped, after: emptied } }]);
      expect(await count("dropship.dropship_audit_events")).toBe(auditBefore + 1);
      expect((await execute("SELECT * FROM dropship.dropship_listing_price_revisions ORDER BY id")).rows).toEqual(sizesBefore);
      expect((await execute("SELECT * FROM dropship.dropship_listing_price_settings ORDER BY product_variant_id")).rows).toEqual(settingsBefore);
      expect(await count("dropship.dropship_pricing_applications")).toBe(0);

      // A stale expected revision is W1's 409 before any INSERT; the transaction rolls back its conversion row with it.
      const revisionsBefore = await count("dropship.dropship_pricing_profile_revisions");
      await expectDropshipError(inTransaction(async (client) => {
        const conversion = await insertRuleConversionWithClient(client, systemRecord({ storeConnectionId: STORE,
          idempotencyKey: "rules-conversion:22-again" }));
        return savePricingProfileWithClient(client, target, { expectedRevisionId: groupedRevision, profile: emptied,
          conversionId: conversion.id, now: NOW });
      }), "DROPSHIP_PRICING_REVIEW_STALE");
      expect(await count("dropship.dropship_pricing_profile_revisions")).toBe(revisionsBefore);
      expect(await count(RECORDS_TABLE)).toBe(1);
      expect(await count("dropship.dropship_audit_events")).toBe(auditBefore + 1);
    });

    it("saves the description templates and the eBay rules document with the actor type it is given (D11)", async () => {
      const template = { introduction: "Hello", footer: "" };
      const groupedContent = { defaultTemplate: template, groups: [{ id: "toploaders", name: "Toploaders text", priority: 10,
        scope: { type: "category" as const, category: "Toploaders" }, template: { introduction: "For toploaders.", footer: "" } }] };
      const emptiedContent = { defaultTemplate: template, groups: [] };
      const category = { categoryId: "183454", categoryName: "Toploaders", path: ["Collectibles", "Toploaders"] };
      const groupedRules = { version: 1 as const, defaultCategory: category, rules: [{ id: "toploaders", name: "Toploaders rule",
        scope: { type: "category" as const, category: "Toploaders" }, category }] };
      const emptiedRules = { version: 1 as const, defaultCategory: category, rules: [] };
      const vendor = { vendorId: VENDOR, storeConnectionId: STORE, actorId: MEMBER };
      const system = { ...vendor, actorId: "rules-conversion-job", actorType: "system" as const };

      // Today's vendor saves (no actor type), then the conversion's (the system), each on one transaction.
      await inTransaction(async (client) => {
        await saveContentProfileWithClient(client, vendor, { expectedRevisionId: null, profile: groupedContent,
          idempotencyKey: "content:pg-convert-seed" }, HASHES.requestHash, NOW);
        await saveEbayCategoryRulesProfileWithClient(client, vendor, { expectedRevisionId: null, profile: groupedRules,
          idempotencyKey: "category-rules:pg-convert-seed", requestHash: HASHES.requestHash, now: NOW });
      });
      const heads = await execute(`SELECT (SELECT revision_id FROM dropship.dropship_content_profiles WHERE store_connection_id = $1) AS content,
        (SELECT revision_id FROM dropship.dropship_ebay_category_rule_profiles WHERE store_connection_id = $1) AS rules`, [STORE]);
      const { content: contentRevision, rules: rulesRevision } = heads.rows[0] as { content: number; rules: number };
      const contentKey = listingConversionChildKey(SYSTEM_KEY, "content_profile", STORE);
      const rulesKey = listingConversionChildKey(SYSTEM_KEY, "ebay_rules", STORE);
      const savedContent = await inTransaction(async (client) => {
        await insertRuleConversionWithClient(client, systemRecord());
        const result = await saveContentProfileWithClient(client, system, { expectedRevisionId: contentRevision, profile: emptiedContent,
          idempotencyKey: contentKey }, HASHES.requestHash, NOW);
        await saveEbayCategoryRulesProfileWithClient(client, system, { expectedRevisionId: rulesRevision, profile: emptiedRules,
          idempotencyKey: rulesKey, requestHash: HASHES.requestHash, now: NOW });
        return result;
      });
      // The content writer answers its new revision (the conversion's store audit row names it).
      expect(savedContent).toEqual({ revisionId: (await execute("SELECT revision_id FROM dropship.dropship_content_profiles WHERE store_connection_id = $1",
        [STORE])).rows[0].revision_id });

      const audits = await execute(`SELECT event_type, actor_type, actor_id FROM dropship.dropship_audit_events
        WHERE event_type IN ('listing_content_saved', 'ebay_category_rules_saved') ORDER BY id`);
      expect(audits.rows).toEqual([
        { event_type: "listing_content_saved", actor_type: "vendor", actor_id: MEMBER },
        { event_type: "ebay_category_rules_saved", actor_type: "vendor", actor_id: MEMBER },
        { event_type: "listing_content_saved", actor_type: "system", actor_id: "rules-conversion-job" },
        { event_type: "ebay_category_rules_saved", actor_type: "system", actor_id: "rules-conversion-job" },
      ]);
      const content = await execute(`SELECT r.previous_revision_id, r.profile, r.idempotency_key, r.actor_id FROM dropship.dropship_content_profiles p
        JOIN dropship.dropship_content_profile_revisions r ON r.id = p.revision_id WHERE p.store_connection_id = $1`, [STORE]);
      expect(content.rows).toEqual([{ previous_revision_id: contentRevision, profile: emptiedContent, idempotency_key: contentKey,
        actor_id: "rules-conversion-job" }]);
      const rules = await execute(`SELECT r.previous_revision_id, r.profile, r.idempotency_key FROM dropship.dropship_ebay_category_rule_profiles p
        JOIN dropship.dropship_ebay_category_rule_revisions r ON r.id = p.revision_id WHERE p.store_connection_id = $1`, [STORE]);
      // The version 1 document with no rules and its default kept (plan D7).
      expect(rules.rows).toEqual([{ previous_revision_id: rulesRevision, profile: emptiedRules, idempotency_key: rulesKey }]);
    });

    it("saves each product its own values on a real database: no ledger, request_id NULL, lc: keys, chained, audited", async () => {
      await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type, shopify_product_id)
        VALUES (8, 'TL-2', 'Toploader 35pt', 'Toploaders', 3, 'toploader', '8000000008')`);
      const writesBefore = await allWrites();
      const scope = { vendorId: VENDOR, storeConnectionId: STORE, requestKey: CONVERSION_KEY,
        actor: { actorType: "vendor" as const, actorId: MEMBER } };
      const textAbove = { mode: "own" as const, text: "From the toploader group." };

      const first = await inTransaction(async (client) => {
        const conversion = await insertRuleConversionWithClient(client, record());
        const products = await saveProductListingSettingsPerProductWithClient(client, scope, { conversionId: conversion.id,
          products: [{ productId: 8, expectedRevisionId: null, patch: { ebayCategory: { categoryId: "183454", categoryName: "Toploaders",
            path: ["Collectibles", "Toploaders"] } } },
          { productId: PRODUCT_7, expectedRevisionId: null, patch: { price: RECIPE, textAbove } }],
          requestHash: HASHES.requestHash, now: NOW });
        return { conversion, products };
      });

      expect(first.products.unchangedProductIds).toEqual([]);
      expect(first.products.changed.map((entry) => entry.productId)).toEqual([PRODUCT_7, 8]);
      const revisions = await execute(`SELECT product_id, previous_revision_id, request_id, idempotency_key, request_hash, actor_type, actor_id,
        price_basis, price_markup_bps, text_above_mode, text_above, ebay_category_id, created_at
        FROM dropship.dropship_product_listing_setting_revisions ORDER BY product_id`);
      expect(revisions.rows).toEqual([
        { product_id: PRODUCT_7, previous_revision_id: null, request_id: null, idempotency_key: listingConversionChildKey(CONVERSION_KEY, "product", PRODUCT_7),
          request_hash: HASHES.requestHash, actor_type: "vendor", actor_id: MEMBER, price_basis: "catalog_retail", price_markup_bps: 2_000,
          text_above_mode: "own", text_above: textAbove.text, ebay_category_id: null, created_at: NOW },
        { product_id: 8, previous_revision_id: null, request_id: null, idempotency_key: listingConversionChildKey(CONVERSION_KEY, "product", 8),
          request_hash: HASHES.requestHash, actor_type: "vendor", actor_id: MEMBER, price_basis: null, price_markup_bps: null,
          text_above_mode: null, text_above: null, ebay_category_id: "183454", created_at: NOW },
      ]);
      const currents = await execute("SELECT product_id, revision_id FROM dropship.dropship_product_listing_settings ORDER BY product_id");
      expect(currents.rows).toEqual(first.products.changed.map((entry) => ({ product_id: entry.productId, revision_id: entry.revisionId })));
      const audits = await execute(`SELECT entity_id, actor_type, actor_id, payload FROM dropship.dropship_audit_events
        WHERE event_type = 'product_listing_settings_saved' ORDER BY entity_id`);
      expect(audits.rows.map((row: Row) => [row.entity_id, row.actor_type, row.actor_id, (row.payload as Row).conversionId,
        (row.payload as Row).requestKey, (row.payload as Row).changedFields])).toEqual([
        [String(PRODUCT_7), "vendor", MEMBER, first.conversion.id, CONVERSION_KEY, ["price", "textAbove"]],
        ["8", "vendor", MEMBER, first.conversion.id, CONVERSION_KEY, ["ebayCategory"]],
      ]);
      // Texts by digest only in the audit rows (the full text is in the revision).
      expect(JSON.stringify(audits.rows)).not.toContain(textAbove.text);
      // No ledger request (its record is the conversion's), and no size row of any kind.
      expect(await count("dropship.dropship_product_listing_setting_requests")).toBe(0);
      const writesAfter = await allWrites();
      expect({ ...writesAfter, productRevisions: writesBefore.productRevisions, audit: writesBefore.audit }).toEqual(writesBefore);
      expect(writesAfter.productRevisions).toBe(writesBefore.productRevisions + 2);

      // A later conversion chains to the revision it read (the coherence trigger accepts it); a stale one is the
      // version conflict naming the product, and nothing it began is kept.
      const SECOND_KEY = "ls-convert:9f8e7d6c-5b4a-4c3b-8a2e-1d0c9b8a7f6e";
      const revision7 = first.products.changed[0].revisionId;
      await expectDropshipError(inTransaction(async (client) => {
        const conversion = await insertRuleConversionWithClient(client, record({ idempotencyKey: SECOND_KEY }));
        return saveProductListingSettingsPerProductWithClient(client, { ...scope, requestKey: SECOND_KEY }, { conversionId: conversion.id,
          products: [{ productId: PRODUCT_7, expectedRevisionId: null, patch: { textBelow: { mode: "none" } } }],
          requestHash: HASHES.requestHash, now: NOW });
      }), "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT");
      expect(await count(RECORDS_TABLE)).toBe(1);
      const chained = await inTransaction(async (client) => {
        const conversion = await insertRuleConversionWithClient(client, record({ idempotencyKey: SECOND_KEY }));
        return saveProductListingSettingsPerProductWithClient(client, { ...scope, requestKey: SECOND_KEY }, { conversionId: conversion.id,
          products: [{ productId: PRODUCT_7, expectedRevisionId: revision7, patch: { textBelow: { mode: "none" } } }],
          requestHash: HASHES.requestHash, now: NOW });
      });
      const latest = await execute(`SELECT previous_revision_id, price_basis, text_above, text_below_mode, idempotency_key
        FROM dropship.dropship_product_listing_setting_revisions WHERE id = $1`, [chained.changed[0].revisionId]);
      expect(latest.rows).toEqual([{ previous_revision_id: revision7, price_basis: "catalog_retail", text_above: textAbove.text,
        text_below_mode: "none", idempotency_key: listingConversionChildKey(SECOND_KEY, "product", PRODUCT_7) }]);
    });

    /** The one-time notice's read through the real read repository and service (11e1); stock is never read. */
    function noticeReader() {
      const repository = new PgDropshipListingSettingsRepository(scopedPool());
      const service = new DropshipListingSettingsService({ repository,
        stock: { atp: { getVariantAtp: async () => { throw new Error("The notice read stock."); } },
          overrides: { listVariantOverrides: async () => { throw new Error("The notice read stock caps."); } } },
        clock: { now: () => NOW }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
      return { repository, service };
    }
    /** [Got it] through the real notice service and its own transaction (11e1). */
    const noticeService = (repositoryPool: Pool = scopedPool()) => new DropshipListingRulesConversionNoticeService({
      repository: new PgDropshipListingRulesConversionNoticeRepository(repositoryPool), clock: { now: () => LATER_SEEN },
      timer: () => 0, log });
    const noticeAudits = () => execute(`SELECT vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id,
      severity, payload, created_at FROM dropship.dropship_audit_events WHERE event_type = 'listing_rules_conversion_notice_seen' ORDER BY id`);

    it("reads the store's latest conversion as its notice when it is an unseen system one (11e1, D19): never a vendor's, a seen one, one a vendor move followed or another store's", async () => {
      const vendorRow = (await rawRecord({ actor_type: "vendor", actor_id: MEMBER, clean: false, changed_size_count: 2 })).rows[0].id as string;
      const older = (await rawRecord({ category_count: 1, product_count: 1 })).rows[0].id as string;
      const newer = (await rawRecord({ category_count: 2, product_count: 5, created_at: LATER_SEEN })).rows[0].id as string;
      const otherStore = (await rawRecord({ store_connection_id: OTHER_VENDOR_STORE, vendor_id: 11 })).rows[0].id as string;
      const { repository, service } = noticeReader();

      expect(await repository.readConversionNotice({ memberId: MEMBER, storeConnectionId: STORE })).toMatchObject({ state: "ok",
        conversion: { id: Number(newer), actorType: "system", noticeSeenAt: null } });
      expect(await service.getConversionNoticeForMember(MEMBER, { storeConnectionId: STORE })).toEqual({ storeConnectionId: STORE,
        notice: { conversionId: Number(newer), convertedAt: LATER_SEEN.toISOString(), categoryCount: 2, productCount: 5 } });
      // Seen, it never shows again, and only the latest row counts: an older unseen row never shows (the vendor row never does).
      await expect(noticeService().acknowledgeForMember(MEMBER, STORE, { conversionId: Number(newer) })).resolves.toEqual({ outcome: "acknowledged" });
      expect(await service.getConversionNoticeForMember(MEMBER, { storeConnectionId: STORE })).toEqual({ storeConnectionId: STORE, notice: null });
      expect((await allRecords()).find((row: Row) => String(row.id) === String(older))).toMatchObject({ notice_seen_at: null });
      expect((await allRecords()).find((row: Row) => String(row.id) === String(vendorRow))).toMatchObject({ notice_seen_at: null });
      // Another vendor's store is its own: refused for member-1 (404), read by member-2.
      await expectDropshipError(service.getConversionNoticeForMember(MEMBER, { storeConnectionId: OTHER_VENDOR_STORE }),
        "DROPSHIP_STORE_CONNECTION_REQUIRED");
      expect((await service.getConversionNoticeForMember("member-2", { storeConnectionId: OTHER_VENDOR_STORE })).notice?.conversionId)
        .toBe(Number(otherStore));
      // The job's unseen notice, then the vendor's own move (D21: rules added back and moved again): the job's notice ends,
      // its row stays unseen, and the read answers none (D19: the vendor saw "Moved over." for his own move).
      await addVendorStore(24);
      const jobRow = (await rawRecord({ store_connection_id: 24, category_count: 3, product_count: 4 })).rows[0].id as string;
      expect((await service.getConversionNoticeForMember(MEMBER, { storeConnectionId: 24 })).notice?.conversionId).toBe(Number(jobRow));
      await rawRecord({ store_connection_id: 24, actor_type: "vendor", actor_id: MEMBER, clean: false, changed_size_count: 2 });
      expect(await service.getConversionNoticeForMember(MEMBER, { storeConnectionId: 24 })).toEqual({ storeConnectionId: 24, notice: null });
      expect((await allRecords()).find((row: Row) => String(row.id) === String(jobRow))).toMatchObject({ notice_seen_at: null });
      // A store with only the vendor's own conversion has none; a store not on eBay is the reads' 422.
      await addVendorStore(26);
      await rawRecord({ store_connection_id: 26, actor_type: "vendor", actor_id: MEMBER });
      expect(await service.getConversionNoticeForMember(MEMBER, { storeConnectionId: 26 })).toEqual({ storeConnectionId: 26, notice: null });
      await execute(`INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, access_token_ref, refresh_token_ref, status, setup_status)
        VALUES (25, $1, 'shopify', 'vault:a', 'vault:r', 'connected', 'ready')`, [VENDOR]);
      await expectDropshipError(service.getConversionNoticeForMember(MEMBER, { storeConnectionId: 25 }), "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY");
    });

    it("marks a notice seen once (11e1): its audit row in the same commit, then already_seen writing nothing; 404 for any other id", async () => {
      const systemId = Number((await rawRecord({ category_count: 2, product_count: 5 })).rows[0].id);
      const vendorId = Number((await rawRecord({ actor_type: "vendor", actor_id: MEMBER, clean: false, changed_size_count: 2 })).rows[0].id);
      const otherStoreId = Number((await rawRecord({ store_connection_id: OTHER_VENDOR_STORE, vendor_id: 11 })).rows[0].id);
      const before = await allRecords();

      await expect(noticeService().acknowledgeForMember(MEMBER, STORE, { conversionId: systemId })).resolves.toEqual({ outcome: "acknowledged" });
      // Only the two notice columns changed, on that row only: the one UPDATE the guard trigger allows.
      expect(await allRecords()).toEqual(before.map((row: Row) => Number(row.id) === systemId
        ? { ...row, notice_seen_at: LATER_SEEN, notice_seen_by: MEMBER } : row));
      expect((await noticeAudits()).rows).toEqual([{ vendor_id: VENDOR, store_connection_id: STORE, entity_type: "dropship_listing_rule_conversion",
        entity_id: String(systemId), event_type: "listing_rules_conversion_notice_seen", actor_type: "vendor", actor_id: MEMBER, severity: "info",
        payload: { conversionId: systemId, before: { noticeSeenAt: null, noticeSeenBy: null },
          after: { noticeSeenAt: LATER_SEEN.toISOString(), noticeSeenBy: MEMBER } }, created_at: LATER_SEEN }]);
      expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.rules_conversion_notice_seen", expect.objectContaining({
        outcome: "acknowledged", vendor_id: VENDOR, store_connection_id: STORE, conversion_id: systemId, actor_id: MEMBER }));
      const seen = await allRecords();

      // Again, from this device or another member's: already seen, nothing written (idempotent by state, no key).
      await expect(noticeService().acknowledgeForMember(MEMBER, STORE, { conversionId: systemId })).resolves.toEqual({ outcome: "already_seen" });
      expect(await allRecords()).toEqual(seen);
      expect((await noticeAudits()).rows).toHaveLength(1);
      // The guard still refuses any later change to the seen notice, so nothing but this transaction could ever mark it.
      const rewrite = await execute(`UPDATE ${RECORDS_TABLE} SET notice_seen_at = $2, notice_seen_by = $3 WHERE id = $1`,
        [systemId, NOW, "member-2"]).then(() => null, (error: unknown) => error as { code?: string });
      expect(rewrite?.code).toBe("23514");

      // A vendor's own conversion has no notice; another store's id is not this store's: both the permanent 404, nothing written.
      for (const conversionId of [vendorId, otherStoreId, 999_999]) {
        const error = await expectDropshipError(noticeService().acknowledgeForMember(MEMBER, STORE, { conversionId }),
          "DROPSHIP_LISTING_CONVERSION_NOTICE_NOT_FOUND");
        expect(error.context).toMatchObject({ storeConnectionId: STORE, conversionId, classification: "permanent" });
      }
      // Another vendor's store by member-1: the owner rows refuse it first; member-2 marks their own.
      await expectDropshipError(noticeService().acknowledgeForMember(MEMBER, OTHER_VENDOR_STORE, { conversionId: otherStoreId }),
        "DROPSHIP_STORE_CONNECTION_REQUIRED");
      expect(await allRecords()).toEqual(seen);
      await expect(noticeService().acknowledgeForMember("member-2", OTHER_VENDOR_STORE, { conversionId: otherStoreId }))
        .resolves.toEqual({ outcome: "acknowledged" });
      expect((await noticeAudits()).rows.map((row: Row) => [row.vendor_id, row.actor_id])).toEqual([[VENDOR, MEMBER], [11, "member-2"]]);
    });

    it("answers two presses of one notice at once (11e1): one acknowledged, the other waits on the row and answers already_seen; one audit row", async () => {
      const systemId = Number((await rawRecord()).rows[0].id);
      // The first press pauses after its UPDATE, holding the row lock, until the second has sent its own UPDATE.
      let releaseFirst: () => void = () => undefined;
      const firstHolds = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let firstUpdated: () => void = () => undefined;
      const firstReached = new Promise<void>((resolve) => { firstUpdated = resolve; });
      const first = noticeService(scopedPool(undefined, async (sql) => {
        if (/^INSERT INTO dropship\.dropship_audit_events/.test(sql.trim())) {
          firstUpdated();
          await firstHolds;
        }
      })).acknowledgeForMember(MEMBER, STORE, { conversionId: systemId });
      await firstReached;
      const second = noticeService().acknowledgeForMember(MEMBER, STORE, { conversionId: systemId });
      // The second must be blocked on the first's row lock in its UPDATE before the first commits: the case proves the wait.
      await waitUntilLockWait("SET notice_seen_at", 1);
      releaseFirst();
      expect(await Promise.all([first, second])).toEqual([{ outcome: "acknowledged" }, { outcome: "already_seen" }]);
      expect((await noticeAudits()).rows).toHaveLength(1);
      expect((await allRecords())[0]).toMatchObject({ notice_seen_at: LATER_SEEN, notice_seen_by: MEMBER });
    });
  });

  describe("PR 11's conversion apply: one transaction per store (plan 7.B.3, 7.B.4 PG (a)-(h))", () => {
    const SLEEVES = 5;
    const MAILERS = 6;
    const PRODUCT_8 = 8;
    const SIZE_801 = 801;
    const KEY_1 = "ls-convert:1f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
    const KEY_2 = "ls-convert:2f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
    const TOP_RECIPE = { basis: "product_cost", markupBps: 4_000, flatCents: 0, rounding: "cent" } as const;
    const STORE_TEMPLATE = { introduction: "Store above.", footer: "Store below." };
    const EBAY_DEFAULT = { categoryId: "261328", categoryName: "Card Supplies", path: ["Collectibles", "Card Supplies"] };
    const EBAY_TOP = { categoryId: "183439", categoryName: "Card Toploaders", path: ["Collectibles", "Card Toploaders"] };
    const EBAY_SLEEVES = { categoryId: "183438", categoryName: "Card Sleeves", path: ["Collectibles", "Card Sleeves"] };
    const PRICING = { defaultRecipe: D1.defaultRecipe, groups: [{ id: "toploaders", name: "Toploaders price", priority: 10,
      scope: { type: "category", category: "Toploaders" }, recipe: TOP_RECIPE }] };
    const CONTENT = { defaultTemplate: STORE_TEMPLATE, groups: [
      { id: "c-top", name: "Toploaders text", priority: 10, scope: { type: "category" as const, category: "Toploaders" },
        template: { introduction: "For toploaders.", footer: "Thanks." } },
      { id: "c-35", name: "35pt text", priority: 1, scope: { type: "product" as const, productId: PRODUCT_8 },
        template: { introduction: "Thick ones.", footer: "Thick footer." } },
    ] };
    const EBAY_RULES = { version: 1, defaultCategory: EBAY_DEFAULT, rules: [
      { id: "e-top", name: "Toploaders eBay", scope: { type: "category", category: "Toploaders" }, category: EBAY_TOP },
      { id: "e-sleeves", name: "Sleeves eBay", scope: { type: "category", category: "Sleeves" }, category: EBAY_SLEEVES },
    ] };
    const conversion = (repositoryPool: Pool = scopedPool(), heavyWrites = new ListingSettingHeavyWriteGate()) =>
      new DropshipListingRulesConversionService({ repository: new PgDropshipListingRulesConversionRepository(repositoryPool),
        clock: { now: () => NOW }, timer: () => performance.now(), log, heavyWrites });

    /** The dry run, exactly as GET …/conversion computes it (11a2): one read-only snapshot, then the planner. */
    async function dryRun(repositoryPool: Pool = scopedPool()) {
      const load = await new PgDropshipListingSettingsRepository(repositoryPool).loadConversionInputs({ memberId: MEMBER,
        storeConnectionId: STORE, now: NOW });
      if (load === null || load.state !== "ok" || load.costReadFailure !== null) throw new Error("The dry run did not load.");
      const { plan, diff } = checkRulesConversion(load.inputs);
      const body = (idempotencyKey: string) => ({ idempotencyKey, planHash: diff.hashes?.planHash, writesHash: diff.hashes?.writesHash });
      return { inputs: load.inputs, plan, diff, body };
    }

    /** A profile revision and its head, as the profile writers leave them (the coherence triggers check the chain). */
    async function seedProfile(table: "content" | "ebay", profile: unknown, idempotencyKey = `seed-${table}:${randomUUID()}`): Promise<number> {
      const [revisions, heads] = table === "content"
        ? ["dropship.dropship_content_profile_revisions", "dropship.dropship_content_profiles"]
        : ["dropship.dropship_ebay_category_rule_revisions", "dropship.dropship_ebay_category_rule_profiles"];
      const current = await execute(`SELECT revision_id FROM ${heads} WHERE store_connection_id = $1`, [STORE]);
      const revision = await execute(`INSERT INTO ${revisions} (vendor_id, store_connection_id, previous_revision_id, profile,
        idempotency_key, request_hash, actor_id, created_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8) RETURNING id`,
      [VENDOR, STORE, current.rows[0]?.revision_id ?? null, JSON.stringify(profile), idempotencyKey, "d".repeat(64), MEMBER, NOW]);
      await execute(`INSERT INTO ${heads} (vendor_id, store_connection_id, revision_id) VALUES ($1, $2, $3)
        ON CONFLICT (store_connection_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`, [VENDOR, STORE, revision.rows[0].id]);
      return revision.rows[0].id as number;
    }

    /** Every row the apply may write, in full where it is small, by count where it is not. */
    async function conversionState() {
      const rows = async (sql: string) => (await execute(sql)).rows;
      return {
        records: await rows("SELECT * FROM dropship.dropship_listing_rule_conversions ORDER BY id"),
        categoryRevisions: await count("dropship.dropship_category_listing_setting_revisions"),
        categoryRows: await rows("SELECT category_id, revision_id FROM dropship.dropship_category_listing_settings ORDER BY category_id"),
        productRevisions: await count("dropship.dropship_product_listing_setting_revisions"),
        productRows: await rows("SELECT product_id, revision_id FROM dropship.dropship_product_listing_settings ORDER BY product_id"),
        pricingRevisions: await count("dropship.dropship_pricing_profile_revisions"),
        contentRevisions: await count("dropship.dropship_content_profile_revisions"),
        ebayRevisions: await count("dropship.dropship_ebay_category_rule_revisions"),
        heads: await rows(`SELECT (SELECT revision_id FROM dropship.dropship_pricing_profiles WHERE store_connection_id = 22) AS pricing,
          (SELECT revision_id FROM dropship.dropship_content_profiles WHERE store_connection_id = 22) AS content,
          (SELECT revision_id FROM dropship.dropship_ebay_category_rule_profiles WHERE store_connection_id = 22) AS ebay`),
        marks: await rows("SELECT product_id, category_id, seen_at FROM dropship.dropship_product_category_seen ORDER BY store_connection_id, product_id"),
        ledger: await count("dropship.dropship_product_listing_setting_requests"),
        audit: await count("dropship.dropship_audit_events"),
      };
    }

    /** Every per-size row of every kind, in full (plan 7.B.4 (g), D6). */
    async function sizeRows() {
      const rows = async (table: string) => (await execute(`SELECT * FROM ${table} ORDER BY id`)).rows;
      const current = async (table: string) => (await execute(`SELECT * FROM ${table} ORDER BY store_connection_id, product_variant_id`)).rows;
      return {
        priceRevisions: await rows("dropship.dropship_listing_price_revisions"),
        prices: await current("dropship.dropship_listing_price_settings"),
        policyRevisions: await rows("dropship.dropship_ebay_listing_policy_override_revisions"),
        policies: await current("dropship.dropship_ebay_listing_policy_overrides"),
        shelfRevisions: await rows("dropship.dropship_ebay_store_category_assignment_revisions"),
        shelves: await current("dropship.dropship_ebay_store_category_assignments"),
        contentRevisions: await rows("dropship.dropship_listing_content_revisions"),
        contents: await current("dropship.dropship_listing_content_settings"),
      };
    }

    beforeEach(async () => {
      await execute("INSERT INTO catalog.product_categories (id, name) VALUES (5, 'Sleeves'), (6, 'Mailers')");
      await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type, shopify_product_id)
        VALUES (8, 'TL-35', 'Toploader 35pt', 'Toploaders', 3, 'toploader', '8000000008')`);
      await execute(`INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, weight_grams, sales_eligibility)
        VALUES (801, 8, 'TL35-25', 'Pack of 25', '7000000801', 100, 'sellable')`);
      await execute("INSERT INTO public.shopify_variants VALUES ('7000000801', '8000000008', 'TL35-25', 12.99)");
      await execute(`INSERT INTO membership.plan_variant_overrides VALUES ('ops-801', 'ops', '7000000801', '8000000008', 'fixed_price', 10.00,
        NULL, true)`);
      await setStoreDefault(PRICING);
      await seedProfile("content", CONTENT);
      await seedProfile("ebay", EBAY_RULES);
      // Product 7 already has its first mark; product 8 gets one from the move.
      await execute(`INSERT INTO dropship.dropship_product_category_seen (vendor_id, store_connection_id, product_id, category_id, seen_at)
        VALUES (10, 22, 7, 3, $1)`, [NOW]);
    });

    it("plans this store clean: every kind of write, nothing that changes (the fixture's own check)", async () => {
      const { plan, diff } = await dryRun();
      expect(diff.state).toBe("clean");
      expect(plan.categories.map((write) => [write.categoryId, write.settings])).toEqual([
        [TOPLOADERS, ["price", "ebayCategory", "textAbove", "textBelow"]], [SLEEVES, ["ebayCategory"]]]);
      expect(plan.products.map((write) => [write.productId, write.settings])).toEqual([[PRODUCT_8, ["textAbove", "textBelow"]]]);
      expect(plan.firstMarks).toEqual([PRODUCT_8]);
      expect([plan.profiles.pricing?.removedIds, plan.profiles.content?.removedIds, plan.profiles.ebayRules?.removedIds])
        .toEqual([["toploaders"], ["c-35", "c-top"], ["e-sleeves", "e-top"]]);
    });

    it("(b) commits the plan: groups emptied with the defaults kept, category and product rows, first marks, one audit row per mutation as the vendor", async () => {
      const { plan, diff, body } = await dryRun();
      const before = await conversionState();
      const answer = await conversion().applyForMember(MEMBER, STORE, body(KEY_1));

      expect(answer).toEqual({ outcome: "converted", conversionId: expect.any(Number), categoryCount: 2, productCount: 1 });
      const record = (await execute("SELECT * FROM dropship.dropship_listing_rule_conversions")).rows;
      expect(record).toEqual([expect.objectContaining({ id: String(answer.conversionId), vendor_id: VENDOR, store_connection_id: STORE,
        idempotency_key: KEY_1, request_hash: rulesConversionRequestHash(STORE, diff.hashes!.planHash), plan_hash: diff.hashes!.planHash,
        writes_hash: diff.hashes!.writesHash, clean: true, changed_size_count: 0, category_count: 2, product_count: 1,
        pricing_groups_removed: 1, content_groups_removed: 2, ebay_rules_removed: 2, actor_type: "vendor", actor_id: MEMBER,
        created_at: NOW, notice_seen_at: null, notice_seen_by: null })]);
      // The three profiles: groups (rules) emptied, the store defaults kept, version 1 eBay document with rules: [] (D7).
      const profiles = await execute(`SELECT
        (SELECT r.profile FROM dropship.dropship_pricing_profiles p JOIN dropship.dropship_pricing_profile_revisions r ON r.id = p.revision_id
          WHERE p.store_connection_id = 22) AS pricing,
        (SELECT r.profile FROM dropship.dropship_content_profiles p JOIN dropship.dropship_content_profile_revisions r ON r.id = p.revision_id
          WHERE p.store_connection_id = 22) AS content,
        (SELECT r.profile FROM dropship.dropship_ebay_category_rule_profiles p
          JOIN dropship.dropship_ebay_category_rule_revisions r ON r.id = p.revision_id WHERE p.store_connection_id = 22) AS ebay`);
      expect(profiles.rows).toEqual([{ pricing: { defaultRecipe: D1.defaultRecipe, groups: [] },
        content: { defaultTemplate: STORE_TEMPLATE, groups: [] }, ebay: { version: 1, defaultCategory: EBAY_DEFAULT, rules: [] } }]);
      // Category rows, each revision with the category's name at save and its lc: key; values as planned.
      const categories = await execute(`SELECT r.category_id, r.category_name, r.previous_revision_id, r.idempotency_key, r.request_hash,
        r.actor_type, r.actor_id, r.price_basis, r.price_markup_bps, r.ebay_category_id, r.text_above_mode, r.text_above, r.text_below
        FROM dropship.dropship_category_listing_settings s JOIN dropship.dropship_category_listing_setting_revisions r ON r.id = s.revision_id
        ORDER BY r.category_id`);
      const requestHash = rulesConversionRequestHash(STORE, diff.hashes!.planHash);
      expect(categories.rows).toEqual([
        { category_id: TOPLOADERS, category_name: "Toploaders", previous_revision_id: null,
          idempotency_key: listingConversionChildKey(KEY_1, "category", TOPLOADERS), request_hash: requestHash, actor_type: "vendor",
          actor_id: MEMBER, price_basis: "product_cost", price_markup_bps: 4_000, ebay_category_id: EBAY_TOP.categoryId,
          text_above_mode: "own", text_above: "For toploaders.", text_below: "Thanks." },
        { category_id: SLEEVES, category_name: "Sleeves", previous_revision_id: null,
          idempotency_key: listingConversionChildKey(KEY_1, "category", SLEEVES), request_hash: requestHash, actor_type: "vendor",
          actor_id: MEMBER, price_basis: null, price_markup_bps: null, ebay_category_id: EBAY_SLEEVES.categoryId,
          text_above_mode: null, text_above: null, text_below: null },
      ]);
      const products = await execute(`SELECT r.product_id, r.request_id, r.idempotency_key, r.request_hash, r.actor_type, r.actor_id,
        r.price_basis, r.text_above_mode, r.text_above, r.text_below FROM dropship.dropship_product_listing_settings s
        JOIN dropship.dropship_product_listing_setting_revisions r ON r.id = s.revision_id ORDER BY r.product_id`);
      expect(products.rows).toEqual([{ product_id: PRODUCT_8, request_id: null, idempotency_key: listingConversionChildKey(KEY_1, "product", PRODUCT_8),
        request_hash: requestHash, actor_type: "vendor", actor_id: MEMBER, price_basis: null, text_above_mode: "own",
        text_above: "Thick ones.", text_below: "Thick footer." }]);
      // First marks only for the product with none.
      expect((await conversionState()).marks).toEqual([{ product_id: PRODUCT_7, category_id: TOPLOADERS, seen_at: NOW },
        { product_id: PRODUCT_8, category_id: TOPLOADERS, seen_at: NOW }]);
      // One audit row per mutation, each as the vendor, each naming its own entity; the store's row last.
      const heads = (await conversionState()).heads[0] as { pricing: number; content: number; ebay: number };
      const audits = await execute(`SELECT entity_type, entity_id, event_type, actor_type, actor_id FROM dropship.dropship_audit_events
        ORDER BY id OFFSET $1`, [before.audit]);
      expect(audits.rows).toEqual([
        { entity_type: "dropship_category_listing_setting", entity_id: String(TOPLOADERS), event_type: "category_listing_settings_saved" },
        { entity_type: "dropship_category_listing_setting", entity_id: String(SLEEVES), event_type: "category_listing_settings_saved" },
        { entity_type: "dropship_product_listing_setting", entity_id: String(PRODUCT_8), event_type: "product_listing_settings_saved" },
        { entity_type: "dropship_pricing_profile", entity_id: String(heads.pricing), event_type: "pricing_profile_saved" },
        { entity_type: "dropship_content_profile", entity_id: String(STORE), event_type: "listing_content_saved" },
        { entity_type: "dropship_ebay_category_rules", entity_id: String(STORE), event_type: "ebay_category_rules_saved" },
        { entity_type: "dropship_store_connection", entity_id: String(STORE), event_type: "category_marks_seeded" },
        { entity_type: "dropship_store_connection", entity_id: String(STORE), event_type: "listing_rules_converted" },
      ].map((row) => ({ ...row, actor_type: "vendor", actor_id: MEMBER })));
      const storeAudit = await execute(`SELECT payload FROM dropship.dropship_audit_events WHERE event_type = 'listing_rules_converted'`);
      expect(storeAudit.rows).toEqual([{ payload: { conversionId: answer.conversionId, requestKey: KEY_1, planHash: diff.hashes!.planHash,
        writesHash: diff.hashes!.writesHash, clean: true, counts: { categories: 2, products: 1, changedSizes: 0, firstMarks: 1 },
        removed: { pricingGroups: [{ id: "toploaders", name: "Toploaders price", scopeType: "category" }],
          contentGroups: [{ id: "c-top", name: "Toploaders text", scopeType: "category" }, { id: "c-35", name: "35pt text", scopeType: "product" }],
          ebayRules: [{ id: "e-top", name: "Toploaders eBay", scopeType: "category" }, { id: "e-sleeves", name: "Sleeves eBay", scopeType: "category" }] },
        categoryIds: plan.categories.map((write) => write.categoryId), productIds: [PRODUCT_8],
        // The index to the three profile audit rows; the description and eBay rules rows' payloads do not name the conversion.
        revisions: { pricing: heads.pricing, content: heads.content, ebayRules: heads.ebay } } }]);
      // Each revision the store row names leads to exactly its profile's audit row (CLAUDE.md §10).
      const indexed = await execute(`SELECT event_type FROM dropship.dropship_audit_events
        WHERE (event_type = 'pricing_profile_saved' AND payload->>'revisionId' = $1)
          OR (event_type = 'listing_content_saved' AND payload->'after'->>'revisionId' = $2)
          OR (event_type = 'ebay_category_rules_saved' AND payload->>'revisionId' = $3) ORDER BY id`,
      [String(heads.pricing), String(heads.content), String(heads.ebay)]);
      expect(indexed.rows).toEqual([{ event_type: "pricing_profile_saved" }, { event_type: "listing_content_saved" },
        { event_type: "ebay_category_rules_saved" }]);
      // Vendor 11's store is untouched; no ledger request is written (the record is the conversion's).
      expect((await conversionState()).ledger).toBe(0);
      expect(await count("dropship.dropship_audit_events", "store_connection_id = $1", [OTHER_VENDOR_STORE])).toBe(0);
      // One INFO line after COMMIT, ids and counts only.
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith(RULES_CONVERSION_APPLIED_ACTION, expect.objectContaining({ outcome: "converted", vendor_id: VENDOR,
        store_connection_id: STORE, actor_type: "vendor", actor_id: MEMBER, request_key: KEY_1, conversion_id: answer.conversionId,
        clean: true, category_count: 2, product_count: 1, pricing_groups_removed: 1, content_groups_removed: 2, ebay_rules_removed: 2,
        changed_size_count: 0, marks_inserted: 1, elapsed_ms: expect.any(Number) }));
      expect(JSON.stringify(log.info.mock.calls)).not.toMatch(/Toploaders|Thick|Sleeves/);
    });

    it("(c) after it the store holds no older rule, the dry run says so, and a category save (W12) is no longer refused", async () => {
      const { body } = await dryRun();
      await conversion().applyForMember(MEMBER, STORE, body(KEY_1));
      const after = await dryRun();
      expect(after.diff).toMatchObject({ state: "no_older_rules", hashes: null });
      expect(olderGroupRuleCounts(after.inputs.listing)).toEqual({ pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 });
      const revision = (await execute("SELECT revision_id FROM dropship.dropship_category_listing_settings WHERE category_id = $1",
        [TOPLOADERS])).rows[0].revision_id as number;
      const saved = await new DropshipListingCategorySettingsService({ repository: new PgDropshipListingSettingWritesRepository(scopedPool()),
        ebay: fakeEbay, heavyWrites: new ListingSettingHeavyWriteGate(), clock: { now: () => NOW }, timer: () => performance.now(), log })
        .saveForMember(MEMBER, STORE, TOPLOADERS, { idempotencyKey: "category-settings:after-conversion", expectedRevisionId: revision,
          patch: { storeShelf: { mode: "none" } } });
      expect(saved).toMatchObject({ outcome: "changed", categoryId: TOPLOADERS });
      // Another apply finds nothing to convert, and records nothing.
      await expect(conversion().applyForMember(MEMBER, STORE, body(KEY_2))).resolves.toEqual({ outcome: "nothing_to_convert",
        conversionId: null, categoryCount: 0, productCount: 0 });
      expect(await count("dropship.dropship_listing_rule_conversions")).toBe(1);
    });

    it("(d) answers the same key again as replayed in 7 statements, and the key for another plan or store as the 409", async () => {
      const { body } = await dryRun();
      const first = await conversion().applyForMember(MEMBER, STORE, body(KEY_1));
      const before = await conversionState();
      const counter: StatementCounter = { statements: 0 };

      const again = await conversion(scopedPool(counter)).applyForMember(MEMBER, STORE, body(KEY_1));

      expect(again).toEqual({ ...first, outcome: "replayed" });
      expect(await conversionState()).toEqual(before);
      // BEGIN, the request lock, the store lock, the owner rows, the gate's store read, the record by key, ROLLBACK: no writer.
      expect(counter.statements).toBe(7);
      const other = await expectDropshipError(conversion().applyForMember(MEMBER, STORE, { ...body(KEY_1), planHash: "e".repeat(64) }),
        "DROPSHIP_IDEMPOTENCY_CONFLICT");
      expect(other.context).toMatchObject({ storeConnectionId: STORE, mismatched: ["requestHash"], classification: "permanent" });
      await addVendorStore(24);
      const otherStore = await expectDropshipError(conversion().applyForMember(MEMBER, 24, body(KEY_1)), "DROPSHIP_IDEMPOTENCY_CONFLICT");
      expect(otherStore.context?.mismatched).toEqual(["storeConnectionId", "requestHash"]);
      expect(await conversionState()).toEqual(before);
    });

    it.each([
      ["description templates", "content", "content_profile", "dropship_content_profile_revision_vendor_id_idempotency_key_key"],
      ["eBay rules", "ebay", "ebay_rules", "dropship_ebay_category_rule_revis_vendor_id_idempotency_key_key"],
    ] as const)("answers the system's clean conversion with the 409 key conflict when an older %s row holds its `lc:` key, writing nothing (D12)",
      async (_label, table, kind, constraint) => {
        // The vendor's head revision under the system's child key: a row saved before the save routes refused the reserved
        // prefixes (they answer 400 to this key now), written directly as such a row would be.
        const claimed = listingConversionChildKey(rulesConversionSystemKey(STORE), kind, STORE);
        await seedProfile(table, table === "content" ? CONTENT : EBAY_RULES, claimed);
        expect((await dryRun()).diff.state).toBe("clean");
        const before = await conversionState();
        const sizesBefore = await sizeRows();

        // The system job's transaction (11e2 builds the job; the repository and the transaction body are this PR's).
        const refused = await expectDropshipError(new PgDropshipListingRulesConversionRepository(scopedPool()).executeConversion(
          { actorType: "system", jobKey: "rules-conversion-job:2026-10-16T01", storeConnectionId: STORE },
          (tx) => convertInTransaction(tx, { kind: "system" }, NOW)), "DROPSHIP_IDEMPOTENCY_CONFLICT");

        // PostgreSQL's own name for the unnamed UNIQUE (vendor_id, idempotency_key), mapped to the permanent 409.
        expect(refused.context).toEqual({ constraint, retryable: false, classification: "permanent" });
        // Every write before it (the record, the categories, the product, the pricing and, for eBay, the templates) rolled back.
        expect(await conversionState()).toEqual(before);
        expect(await sizeRows()).toEqual(sizesBefore);
        expect(await count(table === "content" ? "dropship.dropship_content_profile_revisions" : "dropship.dropship_ebay_category_rule_revisions",
          "idempotency_key = $1", [claimed])).toBe(1);
      });

    it("(a) rolls everything back when its store audit row or any writer's first statement fails, then commits the same request once", async () => {
      const { body } = await dryRun();
      const before = await conversionState();
      const sizesBefore = await sizeRows();
      const failingAt = [
        "INSERT INTO dropship.dropship_listing_rule_conversions",
        "INSERT INTO dropship.dropship_category_listing_setting_revisions",
        "INSERT INTO dropship.dropship_product_listing_setting_revisions",
        "INSERT INTO dropship.dropship_pricing_profile_revisions",
        "INSERT INTO dropship.dropship_content_profile_revisions",
        "INSERT INTO dropship.dropship_ebay_category_rule_revisions",
        "INSERT INTO dropship.dropship_product_category_seen",
        "'listing_rules_converted'",
      ];
      for (const fragment of failingAt) {
        let injected = false;
        const failing = scopedPool(undefined, (sql) => {
          if (!injected && sql.includes(fragment)) {
            injected = true;
            throw new Error(`injected failure at ${fragment}`);
          }
        });
        await expect(conversion(failing).applyForMember(MEMBER, STORE, body(KEY_1))).rejects.toThrow(`injected failure at ${fragment}`);
        expect(injected).toBe(true);
        expect(await conversionState()).toEqual(before);
        expect(await sizeRows()).toEqual(sizesBefore);
      }
      expect(log.info).not.toHaveBeenCalled();

      // No rolled-back attempt spent the key: the same request commits once, and then replays.
      await expect(conversion().applyForMember(MEMBER, STORE, body(KEY_1))).resolves.toMatchObject({ outcome: "converted" });
      await expect(conversion().applyForMember(MEMBER, STORE, body(KEY_1))).resolves.toMatchObject({ outcome: "replayed" });
      expect(await count("dropship.dropship_listing_rule_conversions")).toBe(1);
      expect(await count("dropship.dropship_audit_events", "event_type = 'listing_rules_converted'")).toBe(1);
    });

    it("(g) touches no size price, policy, shelf or text row (D6)", async () => {
      await typePrice(102, 1_299, "pg-convert:typed-102");
      await seedPolicyOverride({ sizeId: 103, fulfillment: "ful-103", label: "convert-103" });
      await seedShelf({ sizeId: 104, label: "convert-104" });
      const { diff, body } = await dryRun();
      expect(diff.state).toBe("clean");
      const sizesBefore = await sizeRows();
      expect([sizesBefore.prices.length, sizesBefore.policies.length, sizesBefore.shelves.length]).toEqual([1, 1, 1]);

      await expect(conversion().applyForMember(MEMBER, STORE, body(KEY_1))).resolves.toMatchObject({ outcome: "converted" });

      expect(await sizeRows()).toEqual(sizesBefore);
      expect(await count("dropship.dropship_pricing_applications")).toBe(0);
    });

    it.each([
      ["a size that would lose its price (D9a): the 422, nothing written", async () => {
        // Folder 901: no Card Shellz category (its copy names "Folders", which no category has) and an .ops cost the plan
        // excludes, so only the Folders price group (from retail) prices it; after the move the store default (from cost) cannot.
        await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type, shopify_product_id)
          VALUES (9, 'FD', 'Folder', 'Folders', NULL, 'folder', '8000000009')`);
        await execute(`INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, weight_grams, sales_eligibility)
          VALUES (901, 9, 'FD-25', 'Pack of 25', '7000000901', 100, 'sellable')`);
        await execute("INSERT INTO public.shopify_variants VALUES ('7000000901', '8000000009', 'FD-25', 12.99)");
        await execute("INSERT INTO membership.product_collections VALUES ('pc-folders', '8000000009', 'col-folders')");
        await execute("INSERT INTO membership.plan_collection_exclusions VALUES ('ex-folders', 'ops', 'col-folders')");
        await setStoreDefault({ ...PRICING, groups: [...PRICING.groups, { id: "folders", name: "Folders price", priority: 5,
          scope: { type: "category", category: "Folders" }, recipe: { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "cent" } }] });
        const repository = new PgDropshipListingPriceRepository(scopedPool());
        const input: SaveListingPriceInput = { priceCents: null, pricingMode: "rules", expectedRevisionId: null, idempotencyKey: "pg-convert:rules-901" };
        await repository.execute({ memberId: MEMBER, storeConnectionId: STORE, productVariantId: 901, idempotencyKey: input.idempotencyKey },
          (tx) => saveListingPriceInTransaction(tx, { storeConnectionId: STORE, productVariantId: 901 }, input, "f".repeat(64), NOW));
        const { diff } = await dryRun();
        expect(diff.blocked.wouldLosePrice.map((size) => [size.productVariantId, size.priceCents])).toEqual([[901, 1_559]]);
        return { pool: scopedPool(), code: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST" };
      }],
      ["a cost read that times out under the locks: the transient 503, nothing written", async () => {
        let injected = false;
        const pool = scopedPool(undefined, (sql) => {
          if (!injected && sql.includes("FROM membership.plan_variant_overrides")) {
            injected = true;
            throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
          }
        });
        return { pool, code: "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE", injected: () => injected };
      }],
    ] as Array<[string, () => Promise<{ pool: Pool; code: string; injected?: () => boolean }>]>)(
      "refuses %s (plan 7.B.5)", async (_label, seed) => {
        const refusal = await seed();
        const { body } = await dryRun();
        const before = await conversionState();
        const sizesBefore = await sizeRows();

        await expectDropshipError(conversion(refusal.pool).applyForMember(MEMBER, STORE, body(KEY_1)), refusal.code);

        if (refusal.injected) expect(refusal.injected()).toBe(true);
        expect(await conversionState()).toEqual(before);
        expect(await sizeRows()).toEqual(sizesBefore);
        expect(log.info).not.toHaveBeenCalled();
      });

    describe("(e) a write that commits while the apply waits for the store lock, or a Card Shellz change, ends in CHANGED with nothing written", () => {
      /** Starts `work` on a pool that pauses at its COMMIT; resolves once it holds its locks there. */
      async function heldAtCommit<T>(work: (repositoryPool: Pool) => Promise<T>) {
        const paused = gate((sql) => sql === "COMMIT");
        const running = work(scopedPool(undefined, paused.hook));
        await within(paused.reached, "the other write's commit");
        return { running, open: paused.open };
      }

      it("a product save (W5's writer) commits first: the plan's product row moved, so settings_changed", async () => {
        const { body } = await dryRun();
        const held = await heldAtCommit((repositoryPool) => new PgDropshipListingSettingWritesRepository(repositoryPool).execute(
          { memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: "product-settings:race-8" },
          (tx) => tx.saveProduct({ productId: PRODUCT_8, expectedRevisionId: null, patch: { storeShelf: { mode: "none" } },
            requestHash: "d".repeat(64), now: NOW })));
        let applying: Promise<unknown> | undefined;
        try {
          applying = conversion().applyForMember(MEMBER, STORE, body(KEY_1)).then(() => null, (reason: unknown) => reason);
          await waitUntilLockWait("dropship_listing_push_job", 1);
          const waiting = await conversionState();
          held.open();
          await within(held.running, "the product save");
          const refused = await within(applying, "the apply");
          expect(refused).toBeInstanceOf(DropshipError);
          expect(refused).toMatchObject({ code: "DROPSHIP_LISTING_CONVERSION_CHANGED", context: { reason: "settings_changed",
            classification: "permanent" } });
          const after = await conversionState();
          // Only the product save's own revision, row and audit row: the apply wrote nothing.
          expect({ ...after, productRevisions: waiting.productRevisions, productRows: waiting.productRows, audit: waiting.audit })
            .toEqual(waiting);
          expect(after.records).toEqual([]);
          expect(after.productRevisions).toBe(waiting.productRevisions + 1);
          expect(after.audit).toBe(waiting.audit + 1);
        } finally {
          held.open();
          await within(Promise.allSettled([held.running, ...(applying ? [applying] : [])]), "the race's clean-up");
        }
      });

      it("an Older settings description group save commits first: the profile moved, so settings_changed", async () => {
        const { body } = await dryRun();
        const before = await conversionState();
        const contentHead = before.heads[0].content as number;
        const changed = { ...CONTENT, groups: [CONTENT.groups[0]] };
        const held = await heldAtCommit((repositoryPool) => new PgDropshipListingContentRepository(repositoryPool).execute(
          { memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: "content:race-profile" },
          (tx) => tx.saveProfile({ expectedRevisionId: contentHead, profile: changed, idempotencyKey: "content:race-profile" },
            "d".repeat(64), NOW)));
        let applying: Promise<unknown> | undefined;
        try {
          applying = conversion().applyForMember(MEMBER, STORE, body(KEY_1)).then(() => null, (reason: unknown) => reason);
          await waitUntilLockWait("dropship_listing_push_job", 1);
          held.open();
          await within(held.running, "the description group save");
          expect(await within(applying, "the apply")).toMatchObject({ code: "DROPSHIP_LISTING_CONVERSION_CHANGED",
            context: { reason: "settings_changed" } });
          // Only the description save's own revision, head and audit row: the apply wrote nothing.
          const after = await conversionState();
          expect(after.records).toEqual([]);
          expect(after.heads[0].content).not.toBe(contentHead);
          expect({ ...after, contentRevisions: before.contentRevisions, heads: before.heads, audit: before.audit }).toEqual(before);
          expect([after.contentRevisions, after.audit]).toEqual([before.contentRevisions + 1, before.audit + 1]);
        } finally {
          held.open();
          await within(Promise.allSettled([held.running, ...(applying ? [applying] : [])]), "the race's clean-up");
        }
      });

      it("Card Shellz moves a product between the check and the apply: only the listed changes moved, so listed_changes_moved", async () => {
        const { body } = await dryRun();
        // The move updates the id only; the product keeps its copy of the old name, which the older rules match.
        await execute("UPDATE catalog.products SET category_id = $1 WHERE id = $2", [SLEEVES, PRODUCT_8]);
        const before = await conversionState();
        const now = await dryRun();
        expect(now.diff.hashes!.writesHash).toBe((body(KEY_1)).writesHash);
        expect(now.diff.hashes!.planHash).not.toBe((body(KEY_1)).planHash);
        expect(await expectDropshipError(conversion().applyForMember(MEMBER, STORE, body(KEY_1)), "DROPSHIP_LISTING_CONVERSION_CHANGED"))
          .toMatchObject({ context: { reason: "listed_changes_moved" } });
        expect(await conversionState()).toEqual(before);
      });

      it("Card Shellz names a second category like a rule's between the check and the apply: the writes moved, so settings_changed", async () => {
        const { body } = await dryRun();
        await execute("UPDATE catalog.product_categories SET name = 'Sleeves' WHERE id = $1", [MAILERS]);
        const before = await conversionState();
        expect(await expectDropshipError(conversion().applyForMember(MEMBER, STORE, body(KEY_1)), "DROPSHIP_LISTING_CONVERSION_CHANGED"))
          .toMatchObject({ context: { reason: "settings_changed" } });
        expect(await conversionState()).toEqual(before);
      });

      it("two applies of one plan at once under one key: one converts, the other waits on the request lock and replays", async () => {
        const { body } = await dryRun();
        const held = await heldAtCommit((repositoryPool) => conversion(repositoryPool).applyForMember(MEMBER, STORE, body(KEY_1)));
        let second: Promise<unknown> | undefined;
        try {
          second = conversion().applyForMember(MEMBER, STORE, body(KEY_1));
          await waitUntilLockWait("dropship_listing_settings_request", 1);
          held.open();
          const first = await within(held.running, "the first apply");
          expect(first).toMatchObject({ outcome: "converted" });
          await expect(within(second, "the second apply")).resolves.toEqual({ ...first, outcome: "replayed" });
        } finally {
          held.open();
          await within(Promise.allSettled([held.running, ...(second ? [second] : [])]), "the race's clean-up");
        }
        expect(await count("dropship.dropship_listing_rule_conversions")).toBe(1);
        expect(await count("dropship.dropship_audit_events", "event_type = 'listing_rules_converted'")).toBe(1);
      });

      it("two applies of one plan at once under two keys: one converts, the other finds nothing to convert", async () => {
        const { body } = await dryRun();
        const held = await heldAtCommit((repositoryPool) => conversion(repositoryPool).applyForMember(MEMBER, STORE, body(KEY_1)));
        let second: Promise<unknown> | undefined;
        try {
          second = conversion().applyForMember(MEMBER, STORE, body(KEY_2));
          await waitUntilLockWait("dropship_listing_push_job", 1);
          held.open();
          await expect(within(held.running, "the first apply")).resolves.toMatchObject({ outcome: "converted" });
          await expect(within(second, "the second apply")).resolves.toEqual({ outcome: "nothing_to_convert", conversionId: null,
            categoryCount: 0, productCount: 0 });
        } finally {
          held.open();
          await within(Promise.allSettled([held.running, ...(second ? [second] : [])]), "the race's clean-up");
        }
        expect(await count("dropship.dropship_listing_rule_conversions")).toBe(1);
        expect(await count("dropship.dropship_audit_events", "event_type = 'listing_rules_converted'")).toBe(1);
      });
    });

    it("(f) a reader that took its snapshot before the commit still reads every resolver input as before: a push never sees a mix", async () => {
      const { inputs, body } = await dryRun();
      const resolverInput = { vendorId: VENDOR, storeConnectionId: STORE, candidates: inputs.listing.candidates,
        ruleEligibleCandidates: inputs.listing.candidates, platform: "ebay" as const };
      let first!: Awaited<ReturnType<typeof readListingResolverInputs>>;
      const reader = await scopedPool().connect();
      try {
        await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        first = await readListingResolverInputs(reader, resolverInput);
        expect(first.layers.categories.size + first.layers.products.size).toBe(0);

        await expect(conversion().applyForMember(MEMBER, STORE, body(KEY_1))).resolves.toMatchObject({ outcome: "converted" });

        // The same four readers on the open snapshot: the old layers with the old profiles, never the new layers with emptied groups.
        const second = await readListingResolverInputs(reader, resolverInput);
        expect(second).toEqual(first);
        await reader.query("COMMIT");
      } finally {
        reader.release();
      }
      // A snapshot taken after the commit reads the new layers, and the same values: the store was clean.
      const fresh = await scopedPool().connect();
      try {
        await fresh.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const after = await readListingResolverInputs(fresh, resolverInput);
        await fresh.query("COMMIT");
        expect([...after.layers.categories.keys()]).toEqual([TOPLOADERS]);
        expect([...after.layers.products.keys()]).toEqual([PRODUCT_8]);
        const cents = (inputs: typeof after) => [...inputs.rulePrices].map(([id, price]) => [id, price.priceCents]);
        expect(cents(after)).toEqual(cents(first));
        expect([...after.contents].map(([id, content]) => [id, content.descriptionHtml]))
          .toEqual([...first.contents].map(([id, content]) => [id, content.descriptionHtml]));
        expect([...after.ebayCategories!].map(([id, category]) => [id, category.categoryId]))
          .toEqual([...first.ebayCategories!].map(([id, category]) => [id, category.categoryId]));
        // The rule under the Toploaders sizes is the category's own now, no longer a group's.
        expect(after.rulePrices.get(101)?.ruleLevel).toBe("category");
        expect(first.rulePrices.get(101)).toMatchObject({ ruleId: "toploaders" });
        expect(first.rulePrices.get(101)?.ruleLevel).toBeUndefined();
      } finally {
        fresh.release();
      }
    });

    it("(h) measures a 10,000-product store: the dry run and the apply (logged, not asserted)", async () => {
      const total = MAX_LISTING_SETTING_BULK_PRODUCTS;
      const first = 20_001;
      // The fixture's own sizes leave the selection, so the store holds exactly 10,000 chosen sizes, one per product.
      await execute("UPDATE catalog.product_variants SET sales_eligibility = 'blocked' WHERE product_id IN (7, 8)");
      await execute(`INSERT INTO catalog.products (id, sku, name, category, category_id, product_type, shopify_product_id)
        SELECT g, 'CV-' || g, 'Converted product ' || g, 'Toploaders', $3, 'toploader', (9200000000 + g)::text
        FROM generate_series($1::int, $2::int) g`, [first, first + total - 1, TOPLOADERS]);
      await execute(`INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, weight_grams, sales_eligibility)
        SELECT 300000 + g, g, 'CV-SIZE-' || g, 'One', (7300000000 + g)::text, 100, 'sellable' FROM generate_series($1::int, $2::int) g`,
      [first, first + total - 1]);
      await execute(`INSERT INTO public.shopify_variants (id, product_id, sku, price)
        SELECT (7300000000 + g)::text, (9200000000 + g)::text, 'CV-SIZE-' || g, 9.99 FROM generate_series($1::int, $2::int) g`,
      [first, first + total - 1]);
      await execute(`INSERT INTO membership.plan_variant_overrides
        SELECT 'ops-cv-' || g, 'ops', (7300000000 + g)::text, (9200000000 + g)::text, 'fixed_price', 6.00, NULL, true
        FROM generate_series($1::int, $2::int) g`, [first, first + total - 1]);
      await execute("INSERT INTO catalog.product_line_products (product_id, product_line_id) SELECT g, 77 FROM generate_series($1::int, $2::int) g",
        [first, first + total - 1]);
      // Every product's own text from a product-line group: 10,000 product writes.
      await seedProfile("content", { defaultTemplate: STORE_TEMPLATE, groups: [{ id: "line", name: "Line text", priority: 1,
        scope: { type: "product_line", productLineId: 77 }, template: { introduction: "Line above.", footer: "Line below." } }] });
      const checkCounter: StatementCounter = { statements: 0 };
      const checked = await measure("rules_conversion_dry_run_10000", 1, checkCounter, () => dryRun(scopedPool(checkCounter)),
        { products: total });
      expect(checked.inputs.listing.candidates).toHaveLength(total);
      const applyCounter: StatementCounter = { statements: 0 };
      const answer = await measure("rules_conversion_apply_10000", 1, applyCounter,
        () => conversion(scopedPool(applyCounter)).applyForMember(MEMBER, STORE, checked.body(KEY_1)),
        { products: total, state: checked.diff.state, productWrites: checked.plan.products.length });
      process.stdout.write(`${JSON.stringify({ measurement: "rules_conversion_apply_10000_answer", ...answer })}\n`);
    }, BULK_TEST_TIMEOUT_MS);

    describe("PR 11e2's system job: clean stores moved over by the hour (plan 9.4 11e2 PG, 13, D1, D20)", () => {
      const JOB_KEY = "rules-conversion-job:2026-10-12T09";
      const TICK_ACTION = "dropship.listing_settings.rules_conversion_tick";
      const conversionJobLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const conversionJob = (repositoryPool: Pool = scopedPool(), now = NOW) => new DropshipRulesConversionJobService({
        source: new PgDropshipRulesConversionJobSource(repositoryPool),
        repository: new PgDropshipListingRulesConversionRepository(repositoryPool),
        clock: { now: () => now }, timer: () => performance.now(), log: conversionJobLog, failureContext: () => ({}) });
      /** The vendor's one-time notice through the real read service (11e1); stock is never read. */
      const noticeOf = () => new DropshipListingSettingsService({ repository: new PgDropshipListingSettingsRepository(scopedPool()),
        stock: { atp: { getVariantAtp: async () => { throw new Error("The notice read stock."); } },
          overrides: { listVariantOverrides: async () => { throw new Error("The notice read stock caps."); } } },
        clock: { now: () => NOW }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } })
        .getConversionNoticeForMember(MEMBER, { storeConnectionId: STORE });
      const failureRows = async () => (await execute(`SELECT vendor_id, store_connection_id, entity_type, entity_id, actor_type, actor_id,
        severity, payload, created_at FROM dropship.dropship_audit_events WHERE event_type = $1 ORDER BY id`, [RULES_CONVERSION_FAILED_EVENT])).rows;
      /** The store's three heads now, as the failure row names them. */
      const headsNow = async () => {
        const heads = (await conversionState()).heads[0] as { pricing: number | null; content: number | null; ebay: number | null };
        return { pricing: heads.pricing, content: heads.content, ebayRules: heads.ebay };
      };
      /** A store of `vendorId` with a pricing head holding one group (the older-rules state), as W1 leaves it. */
      async function storeWithGroup(storeId: number, vendorId: number, status = "connected", platform = "ebay"): Promise<void> {
        await execute(`INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, access_token_ref, refresh_token_ref, status, setup_status)
          VALUES ($1, $2, $3, 'vault:a', 'vault:r', $4, 'ready')`, [storeId, vendorId, platform, status]);
        const revision = await execute(`INSERT INTO dropship.dropship_pricing_profile_revisions
          (vendor_id, store_connection_id, previous_revision_id, profile, actor_id, created_at) VALUES ($1, $2, NULL, $3::jsonb, $4, $5) RETURNING id`,
        [vendorId, storeId, JSON.stringify(PRICING), MEMBER, NOW]);
        await execute("INSERT INTO dropship.dropship_pricing_profiles (vendor_id, store_connection_id, revision_id) VALUES ($1, $2, $3)",
          [vendorId, storeId, revision.rows[0].id]);
      }

      beforeEach(() => { for (const level of Object.values(conversionJobLog)) level.mockClear(); });

      it("converts a clean store once as the system (clean, its store key, the notice unseen); reruns insert and audit nothing", async () => {
        expect((await dryRun()).diff.state).toBe("clean");
        const before = await conversionState();

        const result = await conversionJob().runOnce();

        expect(result).toMatchObject({ jobKey: JOB_KEY, storesChecked: 1, converted: 1, notClean: 0, failed: 0, deferred: 0, deadLettered: 0 });
        const { records } = await conversionState();
        expect(records).toEqual([expect.objectContaining({ vendor_id: VENDOR, store_connection_id: STORE, idempotency_key: rulesConversionSystemKey(STORE),
          clean: true, changed_size_count: 0, category_count: 2, product_count: 1, pricing_groups_removed: 1, content_groups_removed: 2,
          ebay_rules_removed: 2, actor_type: "system", actor_id: JOB_KEY, created_at: NOW, notice_seen_at: null, notice_seen_by: null })]);
        // One audit row per mutation, every one the system's run.
        const audits = (await execute(`SELECT event_type, actor_type, actor_id FROM dropship.dropship_audit_events ORDER BY id OFFSET $1`,
          [before.audit])).rows;
        expect(audits.map((row: Row) => row.event_type)).toEqual(["category_listing_settings_saved", "category_listing_settings_saved",
          "product_listing_settings_saved", "pricing_profile_saved", "listing_content_saved", "ebay_category_rules_saved",
          "category_marks_seeded", "listing_rules_converted"]);
        expect(new Set(audits.map((row: Row) => `${row.actor_type}:${row.actor_id}`))).toEqual(new Set([`system:${JOB_KEY}`]));
        // No older rule left; the vendor is told once, with the record's counts (11e1).
        expect((await dryRun()).diff.state).toBe("no_older_rules");
        await expect(noticeOf()).resolves.toEqual({ storeConnectionId: STORE, notice: { conversionId: Number(records[0].id),
          convertedAt: NOW.toISOString(), categoryCount: 2, productCount: 1 } });
        expect(conversionJobLog.info).toHaveBeenCalledWith(RULES_CONVERSION_APPLIED_ACTION, expect.objectContaining({ outcome: "converted",
          vendor_id: VENDOR, store_connection_id: STORE, actor_type: "system", actor_id: JOB_KEY, request_key: rulesConversionSystemKey(STORE),
          clean: true, changed_size_count: 0 }));
        expect(conversionJobLog.info).toHaveBeenCalledWith(TICK_ACTION, expect.objectContaining({ converted_count: 1, converted_store_ids: [STORE],
          stores_left: 0 }));
        expect(conversionJobLog.warn).not.toHaveBeenCalled();
        expect(conversionJobLog.error).not.toHaveBeenCalled();
        const after = await conversionState();
        const sizes = await sizeRows();

        // Restarted later in the hour, and the next hour: nothing listed, nothing written, a quiet tick.
        conversionJobLog.info.mockClear();
        for (const now of [new Date("2026-10-12T09:45:00.000Z"), new Date("2026-10-12T10:05:00.000Z")]) {
          await expect(conversionJob(scopedPool(), now).runOnce()).resolves.toMatchObject({ storesChecked: 0, converted: 0 });
        }
        expect(await conversionState()).toEqual(after);
        expect(await sizeRows()).toEqual(sizes);
        expect(conversionJobLog.info).not.toHaveBeenCalled();
        expect(conversionJobLog.debug).toHaveBeenCalledWith(TICK_ACTION, expect.objectContaining({ stores_checked: 0, stores_left: 0 }));

        // Older settings adds a group back (D21): the store holds older rules again, but it was converted once, so the job
        // never lists it again; the vendor can move it from the sheet.
        await setStoreDefault(PRICING);
        expect((await dryRun()).diff.state).toBe("clean");
        const regrouped = await conversionState();
        await expect(conversionJob(scopedPool(), new Date("2026-10-12T11:05:00.000Z")).runOnce())
          .resolves.toMatchObject({ storesChecked: 0, converted: 0, notEligible: 0 });
        expect(await conversionState()).toEqual(regrouped);
      });

      it("leaves a store that is not clean exactly as it was, takes no store lock for it, and reports it at INFO every hour", async () => {
        // Two of product 7's sizes follow a named-size price group the move cannot carry (D5): their prices would change.
        await setStoreDefault({ ...PRICING, groups: [...PRICING.groups, { id: "two-sizes", name: "Two sizes", priority: 5,
          scope: { type: "listings", productVariantIds: [101, 102] },
          recipe: { basis: "product_cost", markupBps: 2_000, flatCents: 0, rounding: "cent" } }] });
        const { diff } = await dryRun();
        expect(diff.state).toBe("not_clean");
        expect(diff.rows.length).toBeGreaterThan(0);
        const before = { state: await conversionState(), sizes: await sizeRows(), writes: await allWrites() };
        const statements: string[] = [];

        for (const now of [NOW, new Date("2026-10-12T10:05:00.000Z")]) {
          conversionJobLog.info.mockClear();
          const result = await conversionJob(scopedPool(undefined, (sql) => { statements.push(sql); }), now).runOnce();
          expect(result).toMatchObject({ storesChecked: 1, notClean: 1, converted: 0, failed: 0, deferred: 0 });
          expect(conversionJobLog.info).toHaveBeenCalledExactlyOnceWith(TICK_ACTION, expect.objectContaining({ stores_left: 1, not_clean_count: 1,
            not_clean_stores: [{ store_connection_id: STORE, changed_size_count: diff.rows.length,
              would_lose_price_count: diff.blocked.wouldLosePrice.length, would_block_listing_count: diff.blocked.wouldBlockListing.length,
              too_much_text: diff.blocked.tooMuchText }] }));
        }

        expect({ state: await conversionState(), sizes: await sizeRows(), writes: await allWrites() }).toEqual(before);
        // Only the check's read-only snapshot ran: no transaction that locks the store or writes (plan 13.8).
        expect(statements.filter((sql) => sql.startsWith("BEGIN"))).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
          "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
        expect(statements.some((sql) => /advisory|FOR SHARE|FOR UPDATE|LOCK TABLE|INSERT|UPDATE /.test(sql))).toBe(false);
      });

      it("leaves a store whose vendor's .ops entitlement is not active: not eligible in the list, skipped by the gate under the lock, moved once active", async () => {
        expect((await dryRun()).diff.state).toBe("clean");
        // The vendor's own write gate refuses such a store (DROPSHIP_LISTING_ENTITLEMENT_BLOCKED); the job never writes it either.
        await execute("UPDATE dropship.dropship_vendors SET entitlement_status = 'lapsed' WHERE id = $1", [VENDOR]);
        const before = { state: await conversionState(), writes: await allWrites() };
        const statements: string[] = [];

        const result = await conversionJob(scopedPool(undefined, (sql) => { statements.push(sql); })).runOnce();

        expect(result).toMatchObject({ storesChecked: 0, notEligible: 1, converted: 0, failed: 0, deferred: 0, skipped: 0 });
        expect(conversionJobLog.info).toHaveBeenCalledExactlyOnceWith(TICK_ACTION, expect.objectContaining({ stores_left: 1,
          not_eligible_count: 1, not_eligible_store_ids: [STORE] }));
        // Only the store list ran: the store was never checked.
        expect(statements.some((sql) => sql.startsWith("BEGIN"))).toBe(false);

        // A job that listed the store before the entitlement lapsed meets the same rule under the store lock, and writes nothing.
        await expect(new PgDropshipListingRulesConversionRepository(scopedPool()).executeConversion(
          { actorType: "system", jobKey: JOB_KEY, storeConnectionId: STORE }, (tx) => convertInTransaction(tx, { kind: "system" }, NOW)))
          .resolves.toEqual({ outcome: "skipped", reason: "vendor_not_entitled" });
        expect({ state: await conversionState(), writes: await allWrites() }).toEqual(before);

        // Active again: the next tick checks the store and moves it.
        await execute("UPDATE dropship.dropship_vendors SET entitlement_status = 'active' WHERE id = $1", [VENDOR]);
        await expect(conversionJob().runOnce()).resolves.toMatchObject({ storesChecked: 1, converted: 1, notEligible: 0 });
      });

      it("waits for a listing write holding the store lock, then converts on what that write committed", async () => {
        const paused = gate((sql) => sql === "COMMIT");
        const w5 = new PgDropshipListingSettingWritesRepository(scopedPool(undefined, paused.hook)).execute(
          { memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: "product-settings:before-the-job" },
          (tx) => tx.saveProduct({ productId: PRODUCT_8, expectedRevisionId: null, patch: { storeShelf: { mode: "none" } },
            requestHash: "d".repeat(64), now: NOW }));
        let tick: Promise<unknown> | undefined;
        try {
          await within(paused.reached, "the product save's commit");
          tick = conversionJob().runOnce();
          // The check needs no lock; the conversion's transaction waits on the store lock the product save holds.
          await waitUntilLockWait("dropship_listing_push_job", 1);
          expect(await count("dropship.dropship_listing_rule_conversions")).toBe(0);
          paused.open();
          await within(w5, "the product save");
          await expect(within(tick, "the tick")).resolves.toMatchObject({ converted: 1, failed: 0, deferred: 0 });
        } finally {
          paused.open();
          await within(Promise.allSettled([w5, ...(tick ? [tick] : [])]), "the store-lock case's clean-up");
        }
        // The conversion built product 8's row on the revision the product save committed while it waited.
        const chain = await execute(`SELECT r.previous_revision_id, p.idempotency_key AS previous_key, r.actor_type
          FROM dropship.dropship_product_listing_settings s JOIN dropship.dropship_product_listing_setting_revisions r ON r.id = s.revision_id
          JOIN dropship.dropship_product_listing_setting_revisions p ON p.id = r.previous_revision_id WHERE s.product_id = $1`, [PRODUCT_8]);
        expect(chain.rows).toEqual([{ previous_revision_id: expect.any(Number), previous_key: "product-settings:before-the-job", actor_type: "system" }]);
      });

      it("the job and a vendor's apply at once, the vendor's first: the job waits on the store lock and finds the store already converted", async () => {
        const { body } = await dryRun();
        const paused = gate((sql) => sql === "COMMIT");
        const vendor = conversion(scopedPool(undefined, paused.hook)).applyForMember(MEMBER, STORE, body(KEY_1));
        let tick: Promise<unknown> | undefined;
        try {
          await within(paused.reached, "the vendor's commit");
          tick = conversionJob().runOnce();
          await waitUntilLockWait("dropship_listing_push_job", 1);
          paused.open();
          await expect(within(vendor, "the vendor's apply")).resolves.toMatchObject({ outcome: "converted" });
          await expect(within(tick, "the tick")).resolves.toMatchObject({ storesChecked: 1, converted: 0, alreadyConverted: 1, failed: 0 });
        } finally {
          paused.open();
          await within(Promise.allSettled([vendor, ...(tick ? [tick] : [])]), "the race's clean-up");
        }
        expect((await conversionState()).records).toEqual([expect.objectContaining({ actor_type: "vendor", idempotency_key: KEY_1 })]);
        expect(await count("dropship.dropship_audit_events", "event_type = 'listing_rules_converted'")).toBe(1);
        // A vendor's own move is never a notice.
        await expect(noticeOf()).resolves.toEqual({ storeConnectionId: STORE, notice: null });
      });

      it("the job and a vendor's apply at once, the job's first: the vendor waits on the store lock and finds nothing to convert", async () => {
        const { body } = await dryRun();
        let recorded = false;
        // The conversion's own COMMIT (after its record), not the check's read-only one.
        const paused = gate((sql) => {
          if (sql.includes("INSERT INTO dropship.dropship_listing_rule_conversions")) recorded = true;
          return recorded && sql === "COMMIT";
        });
        const tick = conversionJob(scopedPool(undefined, paused.hook)).runOnce();
        let vendor: Promise<unknown> | undefined;
        try {
          await within(paused.reached, "the job's commit");
          vendor = conversion().applyForMember(MEMBER, STORE, body(KEY_1));
          await waitUntilLockWait("dropship_listing_push_job", 1);
          paused.open();
          await expect(within(tick, "the tick")).resolves.toMatchObject({ converted: 1, failed: 0 });
          await expect(within(vendor, "the vendor's apply")).resolves.toEqual({ outcome: "nothing_to_convert", conversionId: null,
            categoryCount: 0, productCount: 0 });
        } finally {
          paused.open();
          await within(Promise.allSettled([tick, ...(vendor ? [vendor] : [])]), "the race's clean-up");
        }
        expect((await conversionState()).records).toEqual([expect.objectContaining({ actor_type: "system",
          idempotency_key: rulesConversionSystemKey(STORE) })]);
        await expect(noticeOf()).resolves.toMatchObject({ notice: { categoryCount: 2, productCount: 1 } });
      });

      it("records a fatal store once, skips it unchecked while its three heads and the planner are the ones it failed on, and re-arms it after a pricing save", async () => {
        const heads = await headsNow();
        let injected = false;
        const failing = scopedPool(undefined, (sql) => {
          if (!injected && sql.includes("INSERT INTO dropship.dropship_listing_rule_conversions")) {
            injected = true;
            throw Object.assign(new Error("new row violates check constraint"), { code: "23514", constraint: "injected_chk" });
          }
        });
        const before = await conversionState();
        const sizesBefore = await sizeRows();

        await expect(conversionJob(failing).runOnce()).resolves.toMatchObject({ storesChecked: 1, failed: 1, converted: 0 });

        expect(injected).toBe(true);
        expect(await failureRows()).toEqual([{ vendor_id: VENDOR, store_connection_id: STORE, entity_type: "dropship_store_connection",
          entity_id: String(STORE), actor_type: "system", actor_id: JOB_KEY, severity: "error", created_at: NOW,
          payload: { plannerVersion: RULES_CONVERSION_PLANNER_VERSION, revisions: heads, stage: "apply",
            errorCode: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", errorClass: "fatal", causeCode: "23514", jobKey: JOB_KEY } }]);
        expect(conversionJobLog.error).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.rules_conversion_failed",
          expect.objectContaining({ store_connection_id: STORE, record_outcome: "recorded", dead_lettered: true }));
        // The conversion rolled back whole: the failure row is the only new row.
        expect({ ...(await conversionState()), audit: before.audit }).toEqual(before);
        expect((await conversionState()).audit).toBe(before.audit + 1);
        expect(await sizeRows()).toEqual(sizesBefore);

        // The next hours, on a pool that would convert it: the source leaves it out, so nothing connects to check it.
        const statements: string[] = [];
        for (const now of [new Date("2026-10-12T10:05:00.000Z"), new Date("2026-10-12T11:05:00.000Z")]) {
          conversionJobLog.error.mockClear();
          conversionJobLog.info.mockClear();
          await expect(conversionJob(scopedPool(undefined, (sql) => { statements.push(sql); }), now).runOnce())
            .resolves.toMatchObject({ storesChecked: 0, deadLettered: 1, failed: 0 });
          expect(conversionJobLog.error).not.toHaveBeenCalled();
          expect(conversionJobLog.info).toHaveBeenCalledWith(TICK_ACTION, expect.objectContaining({ dead_lettered_count: 1,
            dead_lettered_store_ids: [STORE], stores_left: 1 }));
        }
        expect(statements).toEqual([]);
        expect(await failureRows()).toHaveLength(1);

        // A pricing save (the same groups, a new revision) moves the pricing head: the store is re-armed, checked and moved.
        await setStoreDefault(PRICING);
        await expect(conversionJob(scopedPool(), new Date("2026-10-12T12:05:00.000Z")).runOnce())
          .resolves.toMatchObject({ storesChecked: 1, converted: 1, deadLettered: 0 });
        expect((await conversionState()).records).toEqual([expect.objectContaining({ actor_type: "system" })]);
      });

      it("writes the failure row once, and nothing when a head moved since the list or the store is gone (the record's compare)", async () => {
        const heads = await headsNow();
        const repository = new PgDropshipListingRulesConversionRepository(scopedPool());
        const payload = { plannerVersion: RULES_CONVERSION_PLANNER_VERSION, revisions: heads, stage: "check" as const,
          errorCode: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", errorClass: "fatal" as const, causeCode: null, jobKey: JOB_KEY };
        const record = (input: Partial<Parameters<typeof repository.recordFailure>[0]> = {}) => repository.recordFailure({
          storeConnectionId: STORE, expectedVendorId: VENDOR, payload, now: NOW, ...input });

        // A pricing save since the list: the failure was planned from the old head, so nothing is written.
        const listedHeads = { ...heads };
        await setStoreDefault(PRICING);
        await expect(record({ payload: { ...payload, revisions: listedHeads } })).resolves.toBe("rules_changed");
        expect(await failureRows()).toEqual([]);
        // The heads as they are now: written once; the same record again writes nothing.
        const now = await headsNow();
        await expect(record({ payload: { ...payload, revisions: now } })).resolves.toBe("recorded");
        await expect(record({ payload: { ...payload, revisions: now } })).resolves.toBe("already_recorded");
        expect(await failureRows()).toEqual([expect.objectContaining({ entity_id: String(STORE), severity: "error", actor_type: "system",
          payload: { ...payload, revisions: now } })]);
        // Another vendor named for the store, or a store that is gone: nothing.
        await expect(record({ expectedVendorId: 11, payload: { ...payload, revisions: now, stage: "apply" } })).resolves.toBe("rules_changed");
        await expect(record({ storeConnectionId: 999 })).resolves.toBe("store_gone");
        expect(await failureRows()).toHaveLength(1);
      });

      it("lists the eligible stores with older rules and no conversion, and dead-letters only on all three heads and the planner version", async () => {
        // Vendor 10's needs-sign-in store with a group (eligible), its paused one (not eligible), its Shopify one and one it
        // converted itself (never listed); a closed vendor's store (not eligible); vendor 11's store 23 holds no older rule.
        await storeWithGroup(24, VENDOR, "needs_reauth");
        await storeWithGroup(25, VENDOR, "paused");
        await storeWithGroup(26, VENDOR, "connected", "shopify");
        await storeWithGroup(27, VENDOR);
        await execute(`INSERT INTO membership.member_subscriptions VALUES ('sub-3', 'member-3', 'ops');
          INSERT INTO dropship.dropship_vendors (id, member_id, current_subscription_id, current_plan_id, status, entitlement_status)
            VALUES (12, 'member-3', 'sub-3', 'ops', 'closed', 'active')`);
        await storeWithGroup(28, 12);
        const converter = await scopedPool().connect();
        try {
          await insertRuleConversionWithClient(converter, { vendorId: VENDOR, storeConnectionId: 27, idempotencyKey: KEY_2,
            requestHash: "a".repeat(64), planHash: "b".repeat(64), writesHash: "c".repeat(64), clean: false, changedSizeCount: 1,
            categoryCount: 1, productCount: 0, pricingGroupsRemoved: 1, contentGroupsRemoved: 0, ebayRulesRemoved: 0,
            actor: { actorType: "vendor", actorId: MEMBER }, now: NOW });
        } finally {
          converter.release();
        }
        const source = new PgDropshipRulesConversionJobSource(scopedPool());
        const heads = await headsNow();
        const list = () => source.listStores({ plannerVersion: RULES_CONVERSION_PLANNER_VERSION });
        const pricing24 = (await execute("SELECT revision_id FROM dropship.dropship_pricing_profiles WHERE store_connection_id = 24")).rows[0].revision_id;

        await expect(list()).resolves.toEqual({
          eligible: [{ vendorId: VENDOR, storeConnectionId: STORE, revisions: heads },
            { vendorId: VENDOR, storeConnectionId: 24, revisions: { pricing: pricing24, content: null, ebayRules: null } }],
          notEligibleStoreIds: [25, 28],
          deadLetteredStoreIds: [],
        });

        const failure = (storeId: number, revisions: unknown, plannerVersion: number, eventType = RULES_CONVERSION_FAILED_EVENT) => execute(
          `INSERT INTO dropship.dropship_audit_events (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type,
            actor_id, severity, payload, created_at) VALUES ($1, $2, 'dropship_store_connection', $3, $4, 'system', $5, 'error', $6::jsonb, $7)
            RETURNING id`, [VENDOR, storeId, String(storeId), eventType, JOB_KEY, JSON.stringify({ plannerVersion, revisions, stage: "apply",
            errorCode: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", errorClass: "fatal", causeCode: null, jobKey: JOB_KEY }), NOW]);
        const eligibleIds = async () => (await list()).eligible.map((store) => store.storeConnectionId);
        // Each near miss leaves store 22 eligible; only the exact match dead-letters it.
        for (const [label, write] of [
          ["the pricing head differs", () => failure(STORE, { ...heads, pricing: heads.pricing! + 1_000 }, RULES_CONVERSION_PLANNER_VERSION)],
          ["the description head differs", () => failure(STORE, { ...heads, content: null }, RULES_CONVERSION_PLANNER_VERSION)],
          ["the eBay rules head differs", () => failure(STORE, { ...heads, ebayRules: heads.ebayRules! + 1_000 }, RULES_CONVERSION_PLANNER_VERSION)],
          ["another planner version", () => failure(STORE, heads, RULES_CONVERSION_PLANNER_VERSION + 1)],
          ["another store's row", () => failure(24, heads, RULES_CONVERSION_PLANNER_VERSION)],
          ["another event", () => failure(STORE, heads, RULES_CONVERSION_PLANNER_VERSION, "listing_rules_converted")],
        ] as const) {
          const written = await write();
          expect([label, await eligibleIds()]).toEqual([label, [STORE, 24]]);
          await execute("DELETE FROM dropship.dropship_audit_events WHERE id = $1", [written.rows[0].id]);
        }
        await failure(STORE, heads, RULES_CONVERSION_PLANNER_VERSION);
        await expect(list()).resolves.toMatchObject({ deadLetteredStoreIds: [STORE], notEligibleStoreIds: [25, 28] });
        expect(await eligibleIds()).toEqual([24]);
        // A not-eligible store is reported as not eligible whatever it failed on.
        await failure(25, { pricing: (await execute("SELECT revision_id FROM dropship.dropship_pricing_profiles WHERE store_connection_id = 25"))
          .rows[0].revision_id, content: null, ebayRules: null }, RULES_CONVERSION_PLANNER_VERSION);
        await expect(list()).resolves.toMatchObject({ notEligibleStoreIds: [25, 28], deadLetteredStoreIds: [STORE] });
      });
    });
  });
});
