import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listingCatalogHash } from "../../application/dropship-listing-content-resolver";
import { DropshipListingPriceService } from "../../application/dropship-listing-price-service";
import { buildListingSettingsFacts } from "../../application/dropship-listing-settings-facts";
import type { ListingSettingsLoad } from "../../application/dropship-listing-settings-service";
import { PgDropshipListingContentRepository } from "../../infrastructure/dropship-listing-content.repository";
import { PgDropshipListingPreviewRepository } from "../../infrastructure/dropship-listing-preview.repository";
import { PgDropshipListingPriceRepository } from "../../infrastructure/dropship-listing-price.repository";
import { PgDropshipListingSettingsRepository } from "../../infrastructure/dropship-listing-settings.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;
const NOW = new Date("2026-10-06T12:00:00.000Z");
const HELD_AT = new Date("2026-10-05T09:30:00.000Z");

/**
 * Every object the reads, the fixture and the real writers name. Each maps into
 * one isolated schema, and any other name fails the test, so a read that
 * reaches a new table is seen here first.
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
  "dropship.guard_listing_price_revision_immutable", "dropship.guard_listing_price_setting_coherence",
  "dropship.guard_pricing_profile_coherence", "dropship.guard_content_revision_immutable",
  "dropship.guard_content_profile_coherence", "dropship.guard_listing_content_coherence",
  "dropship.guard_ebay_category_rule_revision_immutable", "dropship.guard_ebay_category_rule_profile_coherence",
  "catalog.products", "catalog.product_variants", "catalog.product_line_products", "catalog.product_assets",
  "ebay.ebay_category_mappings", "channels.channels", "public.shopify_variants", "public.app_settings",
  "membership.plans", "membership.member_subscriptions", "membership.plan_channel_access",
  "membership.plan_variant_overrides", "membership.plan_collection_exclusions", "membership.product_collections",
  "membership.plan_benefits", "membership.plan_benefit_assignments", "membership.plan_benefit_channel_policies",
]);

/**
 * Revision tables the load joins through an id the fingerprint already holds.
 * Their rows never change (each migration's immutability trigger), so the id
 * names the content exactly.
 */
const NAMED_BY_REVISION_ID: ReadonlyMap<string, string> = new Map([
  ["dropship_pricing_profile_revisions", "dropship_pricing_profiles.revision_id (migration 0659)"],
  ["dropship_content_profile_revisions", "dropship_content_profiles.revision_id (migration 0660)"],
  ["dropship_listing_content_revisions", "dropship_listing_content_settings.revision_id (migration 0660)"],
  ["dropship_ebay_category_rule_revisions", "dropship_ebay_category_rule_profiles.revision_id (migration 0717)"],
]);

const REAL_MIGRATIONS = [
  "0657_dropship_listing_price_settings.sql", "0659_dropship_store_pricing_rules.sql",
  "0660_dropship_vendor_listing_content.sql", "0717_dropship_ebay_category_rules.sql",
  "215_dropship_ebay_product_category_scope.sql", "217_dropship_ebay_listing_policy_overrides.sql",
];

const STORE_RULES = 22; // vendor 10, eBay, store pricing rules
const STORE_NO_RULES = 24; // vendor 10, eBay, no pricing rules
const STORE_SHOPIFY = 25; // vendor 10, not eBay
const STORE_OTHER_VENDOR = 23; // vendor 11

interface Statement { connection: number; sql: string }

describeDatabase.sequential("listing settings PostgreSQL read guarantees", () => {
  const schema = `dropship_listing_settings_${process.pid}`;
  let pool: pg.Pool;
  let created = false;
  const qualify = (sql: string) => sql.replace(/\b(dropship|membership|catalog|channels|public|ebay)\.([a-z_]+)\b/g, (name, _namespace, object) => {
    if (!OBJECTS.has(name)) throw new Error(`Unexpected database object: ${name}`);
    return `"${schema}"."${object}"`;
  });
  const execute = (sql: string, values?: unknown[]) => pool.query(qualify(sql), values);

  /**
   * The repositories' own SQL against the isolated schema. Records every
   * statement with the connection it ran on (0 for the pool itself), and can
   * run a hook after a statement, given that statement's own connection, to
   * look inside the transaction or interleave a concurrent write.
   */
  function scopedPool(options: {
    statements?: Statement[];
    afterStatement?: (sql: string, connection: Pick<pg.PoolClient, "query">) => Promise<void>;
  } = {}): Pool {
    let connections = 0;
    const run = async (target: Pick<pg.PoolClient, "query">, connection: number, sql: string, values?: unknown[]) => {
      options.statements?.push({ connection, sql });
      const result = await target.query(qualify(sql), values);
      await options.afterStatement?.(sql, target);
      return result;
    };
    return {
      query: (sql: string, values?: unknown[]) => run(pool, 0, sql, values),
      connect: async () => {
        const client = await pool.connect();
        const connection = ++connections;
        return {
          query: (sql: string, values?: unknown[]) => run(client, connection, sql, values),
          release: (destroy?: boolean | Error) => client.release(destroy),
        };
      },
    } as unknown as Pool;
  }

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const priceService = () => new DropshipListingPriceService({
    repository: new PgDropshipListingPriceRepository(scopedPool()), clock: { now: () => NOW }, logger });
  const settings = (options: Parameters<typeof scopedPool>[0] = {}, report = vi.fn()) =>
    new PgDropshipListingSettingsRepository(scopedPool(options), report);
  const fingerprint = (memberId = "member-1", storeConnectionId = STORE_RULES) =>
    settings().readFingerprint({ memberId, storeConnectionId });
  async function load(storeConnectionId = STORE_RULES, options: Parameters<typeof scopedPool>[0] = {}, report = vi.fn()) {
    return settings(options, report).load({ memberId: "member-1", storeConnectionId, now: NOW });
  }
  function okLoad(result: ListingSettingsLoad | null): Extract<ListingSettingsLoad, { state: "ok" }> {
    if (result?.state !== "ok") throw new Error(`Expected an ok load, got ${result?.state ?? "null"}.`);
    return result;
  }

  async function savePrice(storeConnectionId: number, productVariantId: number, priceCents: number | null, key: string) {
    const target = { storeConnectionId, productVariantId };
    const current = await priceService().getForMember("member-1", target);
    return priceService().saveForMember("member-1", target, { priceCents, expectedRevisionId: current.revisionId, idempotencyKey: key });
  }
  async function saveOwnText(productVariantId: number, customText: string, key: string) {
    const [candidate] = await new PgDropshipListingPreviewRepository(scopedPool()).listCatalogCandidates([productVariantId]);
    const repository = new PgDropshipListingContentRepository(scopedPool());
    await repository.execute({ memberId: "member-1", storeConnectionId: STORE_RULES, productVariantId, idempotencyKey: key }, async (tx) => {
      const saved = await tx.loadSaved(productVariantId);
      await tx.saveListing(productVariantId, { customText, expectedRevisionId: saved?.revisionId ?? null,
        expectedCatalogHash: listingCatalogHash(candidate), expectedProfileRevisionId: null, idempotencyKey: key },
      createHash("sha256").update(key).digest("hex"), NOW);
    });
  }
  async function saveTemplates(introduction: string, key: string) {
    const repository = new PgDropshipListingContentRepository(scopedPool());
    await repository.execute({ memberId: "member-1", storeConnectionId: STORE_RULES, idempotencyKey: key }, async (tx) => {
      const current = await tx.loadProfile();
      await tx.saveProfile({ expectedRevisionId: current.revisionId, idempotencyKey: key,
        profile: { defaultTemplate: { introduction, footer: "" }, groups: [] } }, createHash("sha256").update(key).digest("hex"), NOW);
    });
  }
  /** A new head revision, as the pricing rules writer appends one; the trigger checks the predecessor. */
  async function savePricingProfile(markupBps: number) {
    const current = await execute("SELECT revision_id FROM dropship.dropship_pricing_profiles WHERE store_connection_id = $1", [STORE_RULES]);
    const revision = await execute(`INSERT INTO dropship.dropship_pricing_profile_revisions
      (vendor_id, store_connection_id, previous_revision_id, profile, actor_id, created_at) VALUES (10, $1, $2, $3::jsonb, 'member-1', $4) RETURNING id`,
    [STORE_RULES, current.rows[0]?.revision_id ?? null, JSON.stringify({
      defaultRecipe: { basis: "product_cost", markupBps, flatCents: 100, rounding: "cent" }, groups: [] }), NOW]);
    await execute(`INSERT INTO dropship.dropship_pricing_profiles (vendor_id, store_connection_id, revision_id) VALUES (10, $1, $2)
      ON CONFLICT (store_connection_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`, [STORE_RULES, revision.rows[0].id]);
  }
  async function saveCategoryRules(categoryId: string) {
    const current = await execute("SELECT revision_id FROM dropship.dropship_ebay_category_rule_profiles WHERE store_connection_id = $1", [STORE_RULES]);
    const revision = await execute(`INSERT INTO dropship.dropship_ebay_category_rule_revisions
      (vendor_id, store_connection_id, previous_revision_id, profile, idempotency_key, request_hash, actor_id, created_at)
      VALUES (10, $1, $2, $3::jsonb, $4, $5, 'member-1', $6) RETURNING id`,
    [STORE_RULES, current.rows[0]?.revision_id ?? null, JSON.stringify({ version: 1, rules: [],
      defaultCategory: { categoryId, categoryName: "Card Sleeves", path: ["Collectibles", "Card Sleeves"] } }),
    `category-${categoryId}`, "c".repeat(64), NOW]);
    await execute(`INSERT INTO dropship.dropship_ebay_category_rule_profiles (vendor_id, store_connection_id, revision_id) VALUES (10, $1, $2)
      ON CONFLICT (store_connection_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`, [STORE_RULES, revision.rows[0].id]);
  }
  /** As dropship-ebay-listing-policy-override.repository.ts: a revision, then the current row. */
  async function setPolicyOverride(productVariantId: number, fulfillmentPolicyId: string) {
    const revision = await execute(`INSERT INTO dropship.dropship_ebay_listing_policy_override_revisions
      (vendor_id, store_connection_id, product_variant_id, idempotency_key, request_hash, fulfillment_policy_id, actor_type, actor_id)
      VALUES (10, $1, $2, $3, $4, $5, 'vendor', 'member-1') RETURNING id`,
    [STORE_RULES, productVariantId, `policy-${productVariantId}-${fulfillmentPolicyId}`, "d".repeat(64), fulfillmentPolicyId]);
    await execute(`INSERT INTO dropship.dropship_ebay_listing_policy_overrides
      (vendor_id, store_connection_id, product_variant_id, revision_id, fulfillment_policy_id) VALUES (10, $1, $2, $3, $4)
      ON CONFLICT (store_connection_id, product_variant_id) DO UPDATE SET revision_id = EXCLUDED.revision_id,
        fulfillment_policy_id = EXCLUDED.fulfillment_policy_id`, [STORE_RULES, productVariantId, revision.rows[0].id, fulfillmentPolicyId]);
  }
  /** As dropship-ebay-store-category.repository.ts: a revision, then the current row. */
  async function setShelf(productVariantId: number, shelf: string) {
    const revision = await execute(`INSERT INTO dropship.dropship_ebay_store_category_assignment_revisions
      (vendor_id, store_connection_id, product_variant_id, idempotency_key, request_hash, store_category_ids, store_category_names, actor_type, actor_id)
      VALUES (10, $1, $2, $3, $4, '["11"]'::jsonb, $5::jsonb, 'vendor', 'member-1') RETURNING id`,
    [STORE_RULES, productVariantId, `shelf-${productVariantId}-${shelf}`, "e".repeat(64), JSON.stringify([shelf])]);
    await execute(`INSERT INTO dropship.dropship_ebay_store_category_assignments
      (vendor_id, store_connection_id, product_variant_id, revision_id, store_category_ids, store_category_names)
      VALUES (10, $1, $2, $3, '["11"]'::jsonb, $4::jsonb)
      ON CONFLICT (store_connection_id, product_variant_id) DO UPDATE SET revision_id = EXCLUDED.revision_id,
        store_category_names = EXCLUDED.store_category_names`, [STORE_RULES, productVariantId, revision.rows[0].id, JSON.stringify([shelf])]);
  }
  /** Row contents of every table in the isolated schema, to prove a read changed nothing. */
  async function databaseState(): Promise<Record<string, string | null>> {
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [schema]);
    const state: Record<string, string | null> = {};
    for (const { table_name: table } of tables.rows) {
      // Names come from the catalog of this test's own schema, never from input.
      const digest = await pool.query<{ digest: string | null }>(
        `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS digest FROM "${schema}"."${table}" t`);
      state[table] = digest.rows[0].digest;
    }
    return state;
  }

  beforeAll(async () => {
    if (!testUrl || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(testUrl)) {
      throw new Error("Listing settings tests require a distinct explicitly disposable PostgreSQL database.");
    }
    if (!/^dropship_listing_settings_\d+$/.test(schema)) throw new Error("Invalid isolated schema.");
    pool = new pg.Pool({ connectionString: testUrl, max: 6, connectionTimeoutMillis: 5000,
      ssl: /localhost|127\.0\.0\.1/.test(testUrl) ? false : { rejectUnauthorized: true } });
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
    // The columns the reads and writers use, with the owning migrations' types
    // (0086, 0094, 0713, and the Shellz Club cost source). The settings tables
    // come from their real migrations below, triggers included.
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
      CREATE TABLE catalog.products (id integer PRIMARY KEY, sku varchar(100), name text NOT NULL, title text,
        description text, category varchar(100), ebay_browse_category_id varchar(50), ebay_browse_category_name text,
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
      CREATE UNIQUE INDEX listing_settings_live_hold_idx ON dropship.dropship_cost_change_listing_holds (store_connection_id, product_variant_id)
        WHERE released_at IS NULL;
      CREATE TABLE dropship.dropship_audit_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer, store_connection_id integer, entity_type text, entity_id text, event_type text,
        actor_type text, actor_id text, severity text, payload jsonb, created_at timestamptz);
    `);
    for (const file of REAL_MIGRATIONS) await execute(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
  });

  beforeEach(async () => {
    logger.info.mockClear(); logger.warn.mockClear(); logger.error.mockClear();
    const tables = [...OBJECTS].filter((name) => !name.startsWith("dropship.guard_"));
    await execute(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
    await execute(`
      INSERT INTO membership.plans VALUES ('ops', true, true, 1000, NULL);
      INSERT INTO membership.member_subscriptions VALUES ('sub-1', 'member-1', 'ops'), ('sub-2', 'member-2', 'ops');
      INSERT INTO dropship.dropship_vendors (id, member_id, current_subscription_id, current_plan_id, status, entitlement_status)
        VALUES (10, 'member-1', 'sub-1', 'ops', 'active', 'active'), (11, 'member-2', 'sub-2', 'ops', 'active', 'active');
      INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, access_token_ref, refresh_token_ref, status, setup_status)
        VALUES (22, 10, 'ebay', 'vault:22:a', 'vault:22:r', 'connected', 'ready'),
               (24, 10, 'ebay', 'vault:24:a', 'vault:24:r', 'connected', 'ready'),
               (25, 10, 'shopify', 'vault:25:a', 'vault:25:r', 'connected', 'ready'),
               (23, 11, 'ebay', 'vault:23:a', 'vault:23:r', 'connected', 'ready');
      INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode, marketplace_config)
        VALUES (22, 'ebay', 'draft_first', '{"businessPolicies":{"fulfillmentPolicyId":"ship-a","returnPolicyId":"return-a","paymentPolicyId":"pay-a"}}');
      INSERT INTO public.app_settings VALUES ('settings', 67);
      INSERT INTO channels.channels VALUES (67, 'Dropship', 'dropship', 'internal', 'active'), (69, 'Card Shellz eBay', 'ebay', 'internal', 'active');
      INSERT INTO ebay.ebay_category_mappings (channel_id, product_type_slug, ebay_browse_category_id, ebay_browse_category_name)
        VALUES (69, 'toploader', '183438', 'Toploaders');
      INSERT INTO catalog.products (id, sku, name, category, product_type, shopify_product_id)
        VALUES (7, 'TL', 'Toploader 3x4', 'Toploaders', 'toploader', '8000000007'), (8, 'SL', 'Penny sleeves', 'Sleeves', 'sleeve', '8000000008');
      INSERT INTO catalog.product_variants (id, product_id, sku, name, shopify_variant_id, weight_grams, sales_eligibility)
        VALUES (101, 7, 'TL-25', 'Pack of 25', '7000000101', 120.5, 'sellable'),
               (102, 7, 'TL-100', 'Pack of 100', '7000000102', 480, 'sellable'),
               (103, 7, 'TL-200', 'Pack of 200', NULL, 960, 'sellable'),
               (104, 7, 'TL-CASE', 'Case', NULL, 9000, 'not_sellable'),
               (105, 7, 'TL-500', 'Pack of 500', '7000000105', 2400, 'sellable'),
               (201, 8, 'SL-100', 'Pack of 100', '7000000201', 60, 'sellable');
      -- Shopify ids are numeric, as the cost source requires (normalizeShopifyCostIdentity).
      INSERT INTO public.shopify_variants VALUES ('7000000101', '8000000007', 'TL-25', 8.99),
        ('7000000102', '8000000007', 'TL-100', 29.99), ('7000000105', '8000000007', 'TL-500', 99.99),
        ('7000000201', '8000000008', 'SL-100', 4.99);
      INSERT INTO membership.plan_variant_overrides VALUES
        ('ops-101', 'ops', '7000000101', '8000000007', 'fixed_price', 8.09, NULL, true),
        ('ops-102', 'ops', '7000000102', '8000000007', 'fixed_price', 24.00, NULL, true),
        ('ops-105', 'ops', '7000000105', '8000000007', 'fixed_price', 80.00, NULL, true),
        ('ops-201', 'ops', '7000000201', '8000000008', 'fixed_price', 3.00, NULL, true);
      INSERT INTO dropship.dropship_catalog_rules (id, scope_type, action) VALUES (1, 'catalog', 'include');
      -- Vendor 10 chooses the whole catalog except the 500 pack; vendor 11 chooses everything.
      INSERT INTO dropship.dropship_vendor_selection_rules (id, vendor_id, scope_type, action, product_variant_id, priority)
        VALUES (1, 10, 'catalog', 'include', NULL, 0), (2, 10, 'variant', 'exclude', 105, 10), (3, 11, 'catalog', 'include', NULL, 0);
      INSERT INTO dropship.dropship_pricing_policies (id, scope_type, mode, floor_price_cents) VALUES (1, 'catalog', 'warn_only', 500);
      INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, external_listing_id, status, vendor_retail_price_cents)
        VALUES (10, 22, 101, 'ebay', 'ebay-22-101', 'active', 1299), (10, 24, 101, 'ebay', 'ebay-24-101', 'active', 1099);
    `);
    await savePricingProfile(3000);
    await savePrice(STORE_RULES, 101, 1299, "rules-store-101-exact");
    await savePrice(STORE_RULES, 201, null, "rules-store-201-catalog");
    await savePrice(STORE_NO_RULES, 201, 599, "plain-store-201-exact");
    await setPolicyOverride(102, "ship-b");
    await setShelf(101, "Toploaders");
    await saveOwnText(201, "Our own words about these sleeves.", "own-text-201");
    await execute(`INSERT INTO dropship.dropship_cost_change_listing_holds (vendor_id, store_connection_id, product_variant_id, held_at)
      VALUES (10, 22, 102, $1)`, [HELD_AT]);
  });

  afterAll(async () => {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool?.end();
  });

  it("reads a store in one read-only snapshot on one connection and changes nothing", async () => {
    const before = await databaseState();
    const statements: Statement[] = [];
    const modes: Array<{ isolation: string; readOnly: string }> = [];
    const result = okLoad(await load(STORE_RULES, { statements, afterStatement: async (sql, connection) => {
      if (!sql.startsWith("BEGIN")) return;
      // Asked on the load's own connection inside its transaction; not recorded.
      const isolation = await connection.query("SHOW transaction_isolation");
      const readOnly = await connection.query("SHOW transaction_read_only");
      modes.push({ isolation: isolation.rows[0].transaction_isolation, readOnly: readOnly.rows[0].transaction_read_only });
    } }));
    expect(modes).toEqual([{ isolation: "repeatable read", readOnly: "on" }]);
    expect(new Set(statements.map((statement) => statement.connection))).toEqual(new Set([1]));
    expect(statements[0].sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(statements.at(-1)?.sql).toBe("COMMIT");
    // No statement writes or locks: no data changes, no row or table locks.
    for (const { sql } of statements) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|LOCK TABLE|FOR UPDATE|FOR SHARE|pg_advisory\w*)\b/i);
    }
    expect(await databaseState()).toEqual(before);
    expect(result.inputs.candidates.map((row) => row.productVariantId)).toEqual([101, 102, 103, 201]);
  });

  it("checks ownership with one statement and no transaction", async () => {
    const statements: Statement[] = [];
    const repository = settings({ statements });
    expect(await repository.readFingerprint({ memberId: "member-1", storeConnectionId: STORE_RULES })).toMatch(/^[a-f0-9]{64}$/);
    expect(statements.map((statement) => statement.connection)).toEqual([0]);
  });

  it("refuses a store the member's vendor does not own, before reading anything else", async () => {
    expect(await fingerprint("member-2", STORE_RULES)).toBeNull();
    expect(await fingerprint("member-1", STORE_OTHER_VENDOR)).toBeNull();
    expect(await fingerprint("member-9", STORE_RULES)).toBeNull();
    const statements: Statement[] = [];
    expect(await settings({ statements }).load({ memberId: "member-2", storeConnectionId: STORE_RULES, now: NOW })).toBeNull();
    expect(statements.map((statement) => statement.sql.trim().split(/\s+/)[0])).toEqual(["BEGIN", "WITH", "COMMIT"]);
  });

  it("names a store that is not on eBay without reading the catalog", async () => {
    const statements: Statement[] = [];
    const result = await load(STORE_SHOPIFY, { statements });
    expect(result).toMatchObject({ state: "not_ebay", store: { storeConnectionId: STORE_SHOPIFY, platform: "shopify" } });
    expect(statements.some((statement) => /\bcatalog\./.test(statement.sql))).toBe(false);
  });

  it("keeps every read inside the snapshot its fingerprint describes", async () => {
    const before = await fingerprint();
    let interleaved = false;
    const result = okLoad(await load(STORE_RULES, { afterStatement: async (sql) => {
      // Right after the fingerprint (the snapshot's first read), another
      // connection saves a price and releases the hold, and commits.
      if (interleaved || !sql.trimStart().startsWith("WITH owner")) return;
      interleaved = true;
      await savePrice(STORE_RULES, 102, 1999, "concurrent-102");
      await execute("UPDATE dropship.dropship_cost_change_listing_holds SET released_at = $1, release_reason = 'repriced'", [NOW]);
    } }));
    expect(interleaved).toBe(true);
    expect(result.fingerprint).toBe(before);
    expect(result.inputs.savedPrices.has(102)).toBe(false);
    expect(result.inputs.pausedSince.get(102)).toEqual(HELD_AT);
    expect(await fingerprint()).not.toBe(before);
    const after = okLoad(await load());
    expect(after.inputs.savedPrices.get(102)).toMatchObject({ overridePriceCents: 1999 });
    expect(after.inputs.pausedSince.has(102)).toBe(false);
  });

  it("gives every size the price, source and cost the per-size price read gives", async () => {
    const expected = {
      [STORE_RULES]: { 101: [1299, "exact"], 102: [3220, "rules"], 103: [null, "none"], 201: [499, "catalog_price"] },
      [STORE_NO_RULES]: { 101: [1099, "last_published"], 102: [2999, "catalog_price"], 103: [null, "none"], 201: [599, "exact"] },
    } as const;
    const SOURCE_NAMES = { override: "exact", rules: "rules", catalog_default: "catalog_price", saved_listing: "last_published", unavailable: "none" } as const;
    for (const storeConnectionId of [STORE_RULES, STORE_NO_RULES] as const) {
      const facts = buildListingSettingsFacts(okLoad(await load(storeConnectionId)).inputs);
      const prices = facts.sizes.map((size) => size.price);
      expect(prices.map((price) => price.productVariantId).sort()).toEqual([101, 102, 103, 201]);
      for (const price of prices) {
        const single = await priceService().getForMember("member-1", { storeConnectionId, productVariantId: price.productVariantId });
        expect([price.priceCents, price.source]).toEqual(expected[storeConnectionId][price.productVariantId as 101 | 102 | 103 | 201]);
        expect(price.priceCents).toBe(single.effectivePriceCents);
        expect(price.source).toBe(SOURCE_NAMES[single.source]);
        expect(price.costCents).toBe(single.productCostCents ?? null);
        expect(price.settingRevisionId).toBe(single.revisionId);
        if (price.source === "rules") {
          expect(price.rule?.name).toBe(single.ruleName);
          expect(price.basis).toBe(single.ruleBasis);
        }
      }
    }
  });

  it("reads the store's own settings, costs, holds and the sizes it could still choose", async () => {
    const result = okLoad(await load());
    const facts = buildListingSettingsFacts(result.inputs);
    expect(result.costReadFailed).toBe(false);
    expect([...result.inputs.costs].map(([id, cost]) => [id, cost.status === "available" ? cost.unitCostCents : cost.status]))
      .toEqual([[101, 809], [102, 2400], [103, "unavailable"], [201, 300]]);
    expect(result.inputs.policyOverrides.get(102)).toMatchObject({ fulfillmentPolicyId: "ship-b" });
    expect(result.inputs.shelfAssignments.get(101)).toEqual(["Toploaders"]);
    expect(result.inputs.contentSettings.get(201)).toMatchObject({ customText: "Our own words about these sleeves." });
    expect(result.inputs.pausedSince).toEqual(new Map([[102, HELD_AT]]));
    // Size 105 is offered but excluded by the vendor; the case is not sellable.
    expect(Object.fromEntries(result.inputs.sizesTotalByProductId)).toEqual({ 7: 4, 8: 1 });
    expect(facts.products.map((product) => [product.row.productId, product.row.sizesChosen, product.row.sizesTotal])).toEqual([[8, 1, 1], [7, 3, 4]]);
    const sleeves = facts.sizes.find((size) => size.price.productVariantId === 201)!;
    expect(sleeves.price.limits).toEqual([{ policyId: 1, floorCents: 500, ceilingCents: null, mode: "warn", breached: "below_floor" }]);
    expect(sleeves.fixes).toContain("no_ebay_category");
    expect(facts.sizes.find((size) => size.price.productVariantId === 103)!.price.issue).toBe("pricing_basis_unavailable");
  });

  const changes: Array<[string, () => Promise<unknown>]> = [
    ["an exact price", () => savePrice(STORE_RULES, 102, 1999, "change-exact-102")],
    ["a price reset to the catalog price", () => savePrice(STORE_RULES, 101, null, "change-reset-101")],
    ["the pricing rules", () => savePricingProfile(4000)],
    ["the description templates", () => saveTemplates("Shipped in a rigid mailer.", "change-templates")],
    ["a size's own description", () => saveOwnText(201, "Newer words.", "change-own-text-201")],
    ["the eBay category rules", () => saveCategoryRules("261328")],
    ["a policy override set", () => setPolicyOverride(101, "ship-c")],
    // dropship-ebay-listing-policy-override.repository.ts deletes the row on reset.
    ["a policy override reset", () => execute("DELETE FROM dropship.dropship_ebay_listing_policy_overrides WHERE product_variant_id = 102")],
    ["a store shelf set", () => setShelf(102, "Mailers")],
    // dropship-ebay-store-category.repository.ts deletes the row on clear.
    ["a store shelf cleared", () => execute("DELETE FROM dropship.dropship_ebay_store_category_assignments WHERE product_variant_id = 101")],
    ["the vendor's selection", () => execute("UPDATE dropship.dropship_vendor_selection_rules SET is_active = false WHERE id = 2")],
    ["a size switched off", () => execute("INSERT INTO dropship.dropship_vendor_variant_overrides (vendor_id, product_variant_id, enabled_override) VALUES (10, 102, false)")],
    ["Card Shellz exposure", () => execute("UPDATE dropship.dropship_catalog_rules SET ends_at = $1 WHERE id = 1", [NOW])],
    ["a Card Shellz price limit", () => execute("UPDATE dropship.dropship_pricing_policies SET floor_price_cents = 600 WHERE id = 1")],
    ["a cost-change hold placed", () => execute(`INSERT INTO dropship.dropship_cost_change_listing_holds
      (vendor_id, store_connection_id, product_variant_id, held_at) VALUES (10, 22, 101, $1)`, [NOW])],
    ["a cost-change hold released", () => execute("UPDATE dropship.dropship_cost_change_listing_holds SET released_at = $1 WHERE product_variant_id = 102", [NOW])],
    ["a published listing's price", () => execute("UPDATE dropship.dropship_vendor_listings SET vendor_retail_price_cents = 1399 WHERE store_connection_id = 22")],
    ["a published listing's status", () => execute("UPDATE dropship.dropship_vendor_listings SET status = 'ended' WHERE store_connection_id = 22")],
    ["the store's default policies", () => execute(`UPDATE dropship.dropship_store_listing_configs
      SET marketplace_config = jsonb_set(marketplace_config, '{businessPolicies,returnPolicyId}', '"return-b"') WHERE store_connection_id = 22`)],
    ["the vendor's standing", () => execute("UPDATE dropship.dropship_vendors SET status = 'paused' WHERE id = 10")],
    ["the vendor's entitlement", () => execute("UPDATE dropship.dropship_vendors SET entitlement_status = 'lapsed' WHERE id = 10")],
    ["the store's connection", () => execute("UPDATE dropship.dropship_store_connections SET status = 'needs_reauth' WHERE id = 22")],
    ["the store's tokens", () => execute("UPDATE dropship.dropship_store_connections SET refresh_token_ref = NULL WHERE id = 22")],
  ];
  it.each(changes)("changes the fingerprint when %s changes", async (_change, change) => {
    const before = await fingerprint();
    await change();
    expect(await fingerprint()).not.toBe(before);
  });

  const unrelated: Array<[string, () => Promise<unknown>]> = [
    ["another store's price", () => savePrice(STORE_NO_RULES, 102, 1999, "other-store-102")],
    ["another vendor's selection", () => execute("UPDATE dropship.dropship_vendor_selection_rules SET priority = 5 WHERE vendor_id = 11")],
    ["another store's hold", () => execute(`INSERT INTO dropship.dropship_cost_change_listing_holds
      (vendor_id, store_connection_id, product_variant_id, held_at) VALUES (10, 24, 101, $1)`, [NOW])],
    ["columns the views do not read", () => execute(`
      UPDATE dropship.dropship_store_connections SET last_sync_at = now(), updated_at = now() WHERE id = 22;
      UPDATE dropship.dropship_vendors SET updated_at = now() WHERE id = 10;
      UPDATE dropship.dropship_vendor_listings SET last_pushed_at = now(), updated_at = now(), pushed_quantity = 7 WHERE store_connection_id = 22;
      UPDATE dropship.dropship_store_listing_configs SET updated_at = now() WHERE store_connection_id = 22`)],
    ["an inactive Card Shellz rule", () => execute("INSERT INTO dropship.dropship_catalog_rules (id, scope_type, action, is_active) VALUES (2, 'catalog', 'exclude', false)")],
  ];
  it.each(unrelated)("keeps the fingerprint when only %s changes", async (_change, change) => {
    const before = await fingerprint();
    await change();
    expect(await fingerprint()).toBe(before);
  });

  it("has every Dropship table a load reads in the fingerprint", async () => {
    const fingerprintStatements: Statement[] = [];
    await settings({ statements: fingerprintStatements }).readFingerprint({ memberId: "member-1", storeConnectionId: STORE_RULES });
    const loadStatements: Statement[] = [];
    okLoad(await load(STORE_RULES, { statements: loadStatements }));
    const tablesIn = (rows: Statement[]) => new Set(rows.flatMap((row) => [...row.sql.matchAll(/\bdropship\.([a-z_]+)/g)].map((match) => match[1])));
    const covered = tablesIn(fingerprintStatements);
    const uncovered = [...tablesIn(loadStatements)].filter((table) => !covered.has(table) && !NAMED_BY_REVISION_ID.has(table));
    expect(uncovered).toEqual([]);
  });

  it("builds the views without costs when the cost source fails, inside the same snapshot", async () => {
    const report = vi.fn();
    await execute("ALTER TABLE membership.plan_variant_overrides RENAME TO plan_variant_overrides_unavailable");
    try {
      const result = okLoad(await load(STORE_RULES, {}, report));
      expect(result.costReadFailed).toBe(true);
      expect([...result.inputs.costs.values()].every((cost) => cost.status === "unavailable")).toBe(true);
      // Reads after the failed cost read still ran in the snapshot.
      expect(result.inputs.savedPrices.get(101)).toMatchObject({ overridePriceCents: 1299 });
      expect(result.inputs.pausedSince.has(102)).toBe(true);
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ vendorId: 10, storeConnectionId: STORE_RULES, variantCount: 4 }));
    } finally {
      await pool.query(`ALTER TABLE "${schema}".plan_variant_overrides_unavailable RENAME TO plan_variant_overrides`);
    }
  });

  it("gives the store defaults and no sizes when more than 10,000 sizes are chosen", async () => {
    await execute(`INSERT INTO catalog.products (id, sku, name, category, product_type) VALUES (9, 'BULK', 'Bulk sleeves', 'Sleeves', 'sleeve');
      INSERT INTO catalog.product_variants (id, product_id, sku, name, sales_eligibility)
        SELECT 100000 + x, 9, 'BULK-' || x, 'Size ' || x, 'sellable' FROM generate_series(1, 10000) x`);
    const result = await load();
    expect(result).toMatchObject({ state: "too_large", store: { storeConnectionId: STORE_RULES },
      storeLevel: { pricing: { revisionId: 1 }, listingConfig: { storeConnectionId: STORE_RULES } } });
  });
});
