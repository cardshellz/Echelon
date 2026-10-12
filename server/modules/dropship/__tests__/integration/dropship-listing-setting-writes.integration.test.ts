import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { config } from "dotenv";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveListingPriceInput } from "../../../../../shared/dropship/listing-price";
import { saveListingPriceInTransaction } from "../../application/dropship-listing-price-service";
import { DropshipListingSizePricesService } from "../../application/dropship-listing-size-prices-service";
import { DropshipPricingRulesService } from "../../application/dropship-pricing-rules-service";
import { DropshipError } from "../../domain/errors";
import { listingSettingChildKey, listingSettingRequestHash } from "../../domain/listing-setting-values";
import { PgDropshipListingPriceRepository } from "../../infrastructure/dropship-listing-price.repository";
import { PgDropshipListingSettingWritesRepository } from "../../infrastructure/dropship-listing-setting-writes.repository";
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

describeDatabase.sequential("listing-settings writes on PostgreSQL (plan PR 9)", () => {
  const schema = `dropship_listing_setting_write_routes_${process.pid}`;
  let pool: pg.Pool;
  let created = false;
  const qualify = (sql: string) => sql.replace(/\b(dropship|membership|catalog|channels|public|ebay)\.([a-z_]+)\b/g, (name, _namespace, object) => {
    if (!OBJECTS.has(name)) throw new Error(`Unexpected database object: ${name}`);
    return `"${schema}"."${object}"`;
  });
  const execute = (sql: string, values?: unknown[]) => pool.query(qualify(sql), values);

  /** The repositories' own SQL against the isolated schema; `counter` counts every statement a pooled client runs (plan 3.11). */
  function scopedPool(counter?: StatementCounter): Pool {
    return {
      query: (sql: string, values?: unknown[]) => pool.query(qualify(sql), values),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql: string, values?: unknown[]) => {
            if (counter) counter.statements += 1;
            return client.query(qualify(sql), values);
          },
          release: (destroy?: boolean | Error) => client.release(destroy),
        };
      },
    } as unknown as Pool;
  }

  const log = { info: vi.fn() };
  const sizePrices = (counter?: StatementCounter) => new DropshipListingSizePricesService({
    repository: new PgDropshipListingSettingWritesRepository(scopedPool(counter)), clock: { now: () => NOW },
    timer: () => performance.now(), log });
  const pricingRules = () => new DropshipPricingRulesService({ repository: new PgDropshipPricingRulesRepository(scopedPool()),
    clock: { now: () => NOW }, newId: () => randomUUID(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  const key = (label: string) => `size-prices:${label}`;
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

  /** Elapsed time, statements and heap growth of `work`, written to stdout for the PR body (plan 4.4); nothing asserts them. */
  async function measure<T>(label: string, flows: number, counter: StatementCounter, work: () => Promise<T>): Promise<T> {
    const heapBefore = process.memoryUsage().heapUsed;
    let heapPeak = heapBefore;
    const sampler = setInterval(() => { heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed); }, HEAP_SAMPLE_INTERVAL_MS);
    const before = counter.statements;
    const started = process.hrtime.bigint();
    try {
      return await work();
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      clearInterval(sampler);
      const heapAfter = process.memoryUsage().heapUsed;
      heapPeak = Math.max(heapPeak, heapAfter);
      const statements = counter.statements - before;
      process.stdout.write(`${JSON.stringify({
        measurement: label, flows, elapsedMs: Math.round(elapsedMs), statements,
        statementsPerFlow: Number((statements / flows).toFixed(1)), elapsedMsPerFlow: Number((elapsedMs / flows).toFixed(2)),
        heapUsedDeltaMiB: Number(((heapAfter - heapBefore) / 1_048_576).toFixed(1)),
        heapUsedPeakDeltaMiB: Number(((heapPeak - heapBefore) / 1_048_576).toFixed(1)),
      })}\n`);
    }
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
});
