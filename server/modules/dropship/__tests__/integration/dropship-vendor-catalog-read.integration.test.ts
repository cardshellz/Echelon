import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DropshipSelectionAtpService } from "../../application/dropship-selection-atp-service";
import { PgDropshipSelectionAtpRepository } from "../../infrastructure/dropship-selection-atp.repository";
import { PgDropshipVendorProvisioningRepository } from "../../infrastructure/dropship-vendor-provisioning.repository";
import { readHeadSelectionRevisionId } from "../../infrastructure/dropship-listing-push-run.repository";
import {
  dropshipCatalogCategoriesAnswerSchema,
  dropshipCatalogIdsAnswerSchema,
  dropshipCatalogSelectionSummarySchema,
} from "../../../../../shared/dropship/vendor-catalog-reads";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { listingPushRunsBaseFixtureSql } from "../fixtures/listing-push-runs.fixture";

/**
 * The vendor catalog reads against a real PostgreSQL (step 1 plan S2-5 §4.8,
 * TESTS2, TESTS9): the real candidate SQL and the real rules writer, with the
 * service's TypeScript evaluation on top. One small fixture for the meanings
 * (selection three ways, category id, stable order, categories, id lists,
 * the selection summary, the onboarding count) and a 30,000-size case for
 * time and heap. B runs this suite again under picks.
 */
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const NOW = new Date("2026-10-20T12:00:00.000Z");
const VENDOR = 10;
const STORE = 22;
const OTHER_VENDOR = 11;
const OTHER_STORE = 23;
const PERF_SIZES = 30_000;
const PERF_TIMEOUT_MS = 120_000;
/** §4.8's ceiling per request: the web dyno has 384 MB of heap (F20). */
const READ_TIME_CEILING_MS = 5_000;
const READ_HEAP_CEILING_BYTES = 64 * 1024 * 1024;

/** The catalog tables the candidate SQL joins that the shared fixture does not create (production names, reduced). */
const catalogReadFixtureSql = `
  ${listingPushRunsBaseFixtureSql}
  ALTER TABLE catalog.product_variants ADD COLUMN position integer NOT NULL DEFAULT 0;
  CREATE TABLE catalog.product_categories (id integer PRIMARY KEY, name varchar(100) NOT NULL);
  ALTER TABLE catalog.products ADD CONSTRAINT products_category_fk FOREIGN KEY (category_id)
    REFERENCES catalog.product_categories(id) ON DELETE SET NULL;
  CREATE TABLE catalog.product_lines (id integer PRIMARY KEY, name text NOT NULL);
  -- 0086's override columns the catalog read selects (the shared fixture keeps only what the push path reads).
  ALTER TABLE dropship.dropship_vendor_variant_overrides ADD COLUMN notes text,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
`;

describeDatabase.sequential("vendor catalog reads (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  let pool: Pool;

  const service = () => new DropshipSelectionAtpService({
    clock: { now: () => NOW },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    repository: new PgDropshipSelectionAtpRepository(pool),
    atp: { getVariantAtp: async (targets) => ({ authority: "canonical", quantities: new Map(targets.map((target) => [target.productVariantId, 4])) }) },
    listingTiers: { resolveForVendor: async () => ({ eligibility: listingTiers }) },
  });

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, catalogReadFixtureSql);
    pool = database.pool;
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE dropship.dropship_vendor_listings, dropship.dropship_audit_events,
      dropship.dropship_vendor_selection_rules, dropship.dropship_vendor_selection_rule_set_revisions,
      dropship.dropship_catalog_rules, dropship.dropship_vendor_variant_overrides,
      dropship.dropship_store_listing_configs, dropship.dropship_store_connections, dropship.dropship_vendors,
      catalog.product_line_products, catalog.product_lines, catalog.product_variants, catalog.products,
      catalog.product_categories RESTART IDENTITY CASCADE`);
    await pool.query(`
      INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (${VENDOR}, 'member-10'), (${OTHER_VENDOR}, 'member-11');
      INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform) VALUES (${STORE}, ${VENDOR}, 'ebay'), (${OTHER_STORE}, ${OTHER_VENDOR}, 'ebay');
      INSERT INTO dropship.dropship_catalog_rules (scope_type, action) VALUES ('catalog', 'include');
    `);
  });

  async function saveRules(vendorId: number, rules: Array<{ scopeType: string; productVariantId?: number }>, key: string): Promise<number> {
    const saved = await new PgDropshipSelectionAtpRepository(pool).replaceSelectionRules({
      vendorId, idempotencyKey: key, requestHash: createHash("sha256").update(key).digest("hex"),
      actor: { actorType: "vendor", actorId: `member-${vendorId}` }, now: NOW,
      rules: rules.map((rule, index) => ({
        scopeType: rule.scopeType, action: "include", productLineId: null, productId: null,
        productVariantId: rule.productVariantId ?? null, category: null, autoConnectNewSkus: true, autoListNewSkus: false,
        priority: 100 - index, metadata: {},
      })) as never,
    });
    return saved.revisionId;
  }

  /**
   * Products: 3 "Binder" (Binders, id 6), 1 and 2 both named "Envelope"
   * (Supplies, id 5), 4 "Loose Item" with a category name and no category id.
   * Sizes: 101, 102 (P1, positions 0 and 1), 201 (P2), 301 (P3), 401 (P4),
   * 501 (P3, hidden by Card Shellz), 601 (P1, not sellable). The vendor picks
   * 101, 102, 301, 401 and 501, and turns 102 off: selected 101, 301, 401.
   * On the store: 101 live, 301 queued with an id, 401 active without an id.
   */
  async function seedSmallCatalog(): Promise<number> {
    await pool.query(`
      INSERT INTO catalog.product_categories (id, name) VALUES (5, 'Supplies'), (6, 'Binders');
      INSERT INTO catalog.product_lines (id, name) VALUES (30, 'Line A');
      INSERT INTO catalog.products (id, sku, name, category, category_id) VALUES
        (1, 'ENV-A', 'Envelope', 'Supplies', 5), (2, 'ENV-B', 'Envelope', 'Supplies', 5),
        (3, 'BND', 'Binder', 'Binders', 6), (4, 'LSE', 'Loose Item', 'Loose', NULL);
      INSERT INTO catalog.product_line_products (product_id, product_line_id) VALUES (1, 30);
      INSERT INTO catalog.product_variants (id, product_id, sku, name, position, sales_eligibility) VALUES
        (101, 1, 'ENV-A-50', 'Pack of 50', 0, 'sellable'), (102, 1, 'ENV-A-100', 'Pack of 100', 1, 'sellable'),
        (201, 2, 'ENV-B-50', 'Pack of 50', 0, 'sellable'), (301, 3, 'BND-1', 'Single', 0, 'sellable'),
        (401, 4, 'LSE-1', 'Single', 0, 'sellable'), (501, 3, 'BND-2', 'Double', 1, 'sellable'),
        (601, 1, 'ENV-A-INT', 'Internal', 2, 'internal_only');
      INSERT INTO dropship.dropship_catalog_rules (scope_type, action, product_variant_id) VALUES ('variant', 'exclude', 501);
      INSERT INTO dropship.dropship_vendor_variant_overrides (vendor_id, product_variant_id, enabled_override) VALUES (${VENDOR}, 102, false);
      INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id) VALUES
        (${VENDOR}, ${STORE}, 101, 'ebay', 'active', 'EBAY-101'),
        (${VENDOR}, ${STORE}, 301, 'ebay', 'queued', 'EBAY-301'),
        (${VENDOR}, ${STORE}, 401, 'ebay', 'active', NULL);
    `);
    return saveRules(VENDOR, [101, 102, 301, 401, 501].map((productVariantId) => ({ scopeType: "variant", productVariantId })), "picks-0001");
  }

  const ids = async (input: Record<string, unknown>) => (await service().previewCatalog({ vendorId: VENDOR, limit: 200, ...input }))
    .rows.map((row) => row.productVariantId);

  it("filters by selection three ways in a stable order; not_selected holds a picked size turned off (TESTS2, CRIT C12)", async () => {
    await seedSmallCatalog();

    // The plan's order (§4.8): name, then size position, then the ids. Two products with one name interleave by
    // position, as they did before; the id tie-breakers make it the same on every read.
    expect(await ids({})).toEqual([301, 101, 201, 102, 401]);
    expect(await ids({ selection: "selected" })).toEqual([301, 101, 401]);
    expect(await ids({ selectedOnly: true })).toEqual([301, 101, 401]);
    expect(await ids({ selection: "not_selected" })).toEqual([201, 102]);
    const page = await service().previewCatalog({ vendorId: VENDOR, selection: "not_selected" });
    expect(page.rows.map((row) => row.selectionDecision.reason)).toEqual(["missing_vendor_include_rule", "disabled_by_vendor_override"]);
    expect(page.summary).toEqual({ matching: 5, matchingSelected: 3 });

    // Two products named "Envelope": the same order on every read and across pages.
    const paged = [];
    for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) paged.push(...await ids({ page: pageNumber, limit: 1 }));
    expect(paged).toEqual([301, 101, 201, 102, 401]);
  });

  it("filters by category id; a product with a category name and no id is only in the name filter", async () => {
    await seedSmallCatalog();

    expect(await ids({ categoryId: 5 })).toEqual([101, 201, 102]);
    expect(await ids({ categoryId: 6 })).toEqual([301]);
    expect(await ids({ category: "loose" })).toEqual([401]);
    expect(await ids({ categoryId: 999 })).toEqual([]);
    const rows = (await service().previewCatalog({ vendorId: VENDOR, categoryId: 5, includeFacets: false })).rows;
    expect(rows.map((row) => [row.categoryId, row.categoryName])).toEqual([[5, "Supplies"], [5, "Supplies"], [5, "Supplies"]]);
  });

  it("counts categories by id over the whole exposed catalog, whatever the page searches (D26)", async () => {
    await seedSmallCatalog();

    const answer = dropshipCatalogCategoriesAnswerSchema.parse(await service().listCatalogCategories({ vendorId: VENDOR }));
    expect(answer).toEqual({
      categories: [
        { categoryId: 6, name: "Binders", rowCount: 1, selectedCount: 1 },
        { categoryId: 5, name: "Supplies", rowCount: 3, selectedCount: 1 },
      ],
      uncategorizedCount: 1,
    });
    // A search narrows the table, not the category numbers.
    expect(await ids({ search: "binder" })).toEqual([301]);
    expect(await service().listCatalogCategories({ vendorId: VENDOR })).toEqual(answer);
    // A renamed category shows its current name.
    await pool.query(`UPDATE catalog.product_categories SET name = 'Binders & Albums' WHERE id = 6`);
    expect((await service().listCatalogCategories({ vendorId: VENDOR })).categories[0]).toMatchObject({ categoryId: 6, name: "Binders & Albums" });
  });

  it("lists only changeable ids (exposed, not turned off) for each purpose", async () => {
    await seedSmallCatalog();

    const add = dropshipCatalogIdsAnswerSchema.parse(await service().listCatalogIds({ vendorId: VENDOR, purpose: "add" }));
    expect(add).toEqual({ selectedIds: [101, 301, 401], notSelectedIds: [201], total: 4 });
    expect(await service().listCatalogIds({ vendorId: VENDOR, purpose: "remove", categoryId: 5 }))
      .toEqual({ selectedIds: [101], notSelectedIds: [201], total: 2 });
    expect(await service().listCatalogIds({ vendorId: VENDOR, purpose: "add", selection: "not_selected" }))
      .toEqual({ selectedIds: [], notSelectedIds: [201], total: 1 });
  });

  it("answers the selection summary with the run create's revision and counts the evaluator selects", async () => {
    const revision = await seedSmallCatalog();

    const summary = dropshipCatalogSelectionSummarySchema.parse(
      await service().readSelectionSummary({ vendorId: VENDOR, storeConnectionId: STORE }));
    const selected = await service().previewCatalog({ vendorId: VENDOR, selection: "selected" });
    expect(summary).toEqual({
      selectionRevisionId: revision, selectedTotal: selected.total, cap: 10_000, overCap: false,
      // Only 101 is live: 301 is queued (a push in progress), 401 has no eBay listing id.
      store: { storeConnectionId: STORE, live: 1, notLive: 2 },
    });
    expect(summary.selectionRevisionId).toBe(await readHeadSelectionRevisionId(pool, VENDOR));
    expect(await service().readSelectionSummary({ vendorId: VENDOR, storeConnectionId: null }))
      .toMatchObject({ selectedTotal: 3, store: null });

    // Another vendor's store is refused; a vendor who never saved has no revision and nothing selected.
    await expect(service().readSelectionSummary({ vendorId: VENDOR, storeConnectionId: OTHER_STORE }))
      .rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(await service().readSelectionSummary({ vendorId: OTHER_VENDOR, storeConnectionId: OTHER_STORE })).toEqual({
      selectionRevisionId: null, selectedTotal: 0, cap: 10_000, overCap: false,
      store: { storeConnectionId: OTHER_STORE, live: 0, notLive: 0 },
    });
  });

  it("keeps the onboarding count of include rules (dropship-vendor-provisioning.repository.ts getCatalogSetupSummary)", async () => {
    await seedSmallCatalog();

    expect(await new PgDropshipVendorProvisioningRepository(pool).getCatalogSetupSummary(VENDOR)).toEqual({
      adminExposureRuleCount: 1, vendorSelectionRuleCount: 5,
    });
  });

  it(`reads a ${PERF_SIZES.toLocaleString("en-US")}-size catalog within ${READ_TIME_CEILING_MS} ms and 64 MB per read, and refuses only the one-sided id lists (TESTS9, TESTS22)`, async () => {
    await pool.query(`INSERT INTO catalog.product_categories (id, name) SELECT c, 'Category ' || c FROM generate_series(1, 20) AS c`);
    await pool.query(`INSERT INTO catalog.products (id, sku, name, category, category_id)
      SELECT p, 'P' || p, 'Product ' || lpad(p::text, 5, '0'), 'Category ' || (1 + p % 20), 1 + p % 20
      FROM generate_series(1, $1::int / 10) AS p`, [PERF_SIZES]);
    await pool.query(`INSERT INTO catalog.product_variants (id, product_id, sku, name, position)
      SELECT g, 1 + (g - 1) / 10, 'SKU-' || g, 'Size ' || ((g - 1) % 10), (g - 1) % 10
      FROM generate_series(1, $1::int) AS g`, [PERF_SIZES]);
    await pool.query(`INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, status, external_listing_id)
      SELECT ${VENDOR}, ${STORE}, g, 'ebay', 'active', 'EBAY-' || g FROM generate_series(1, 2000) AS g`);
    await saveRules(VENDOR, [{ scopeType: "catalog" }], "everything-0001");

    const measure = async <T>(label: string, read: () => Promise<T>): Promise<T> => {
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      const result = await read();
      const elapsedMs = Math.round(performance.now() - started);
      const heapGrowth = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
      process.stdout.write(`[pg-record] ${label} over ${PERF_SIZES} sizes: ${elapsedMs} ms, heap +${(heapGrowth / 1024 / 1024).toFixed(1)} MB\n`);
      expect(elapsedMs, label).toBeLessThan(READ_TIME_CEILING_MS);
      expect(heapGrowth, label).toBeLessThan(READ_HEAP_CEILING_BYTES);
      return result;
    };

    const table = await measure("table page (includeFacets=false, 200 rows)", () => service().previewCatalog({
      vendorId: VENDOR, includeFacets: false, limit: 200, selection: "selected" }));
    expect(table).toMatchObject({ total: PERF_SIZES, facets: null, summary: { matching: PERF_SIZES, matchingSelected: PERF_SIZES } });
    expect(table.rows).toHaveLength(200);
    const categories = await measure("categories read", () => service().listCatalogCategories({ vendorId: VENDOR }));
    expect(categories.categories).toHaveLength(20);
    expect(categories.categories.reduce((sum, category) => sum + category.selectedCount, 0)).toBe(PERF_SIZES);
    const add = await measure("idsOnly purpose=add", () => service().listCatalogIds({ vendorId: VENDOR, purpose: "add" }));
    // Everything is selected: the add list is empty, the selected list is over the cap (null).
    expect(add).toEqual({ selectedIds: null, notSelectedIds: [], total: PERF_SIZES });
    const summary = await measure("selection summary", () => service().readSelectionSummary({ vendorId: VENDOR, storeConnectionId: STORE }));
    expect(summary).toMatchObject({ selectedTotal: PERF_SIZES, overCap: true, store: { live: 2000, notLive: PERF_SIZES - 2000 } });

    await expect(service().listCatalogIds({ vendorId: VENDOR, purpose: "remove" })).rejects.toMatchObject({
      code: "DROPSHIP_CATALOG_IDS_TOO_MANY", context: { total: PERF_SIZES, needed: PERF_SIZES },
    });
    // A vendor with nothing selected: removing is an empty list, adding everything is refused.
    expect(await service().listCatalogIds({ vendorId: OTHER_VENDOR, purpose: "remove" }))
      .toEqual({ selectedIds: [], notSelectedIds: null, total: PERF_SIZES });
    await expect(service().listCatalogIds({ vendorId: OTHER_VENDOR, purpose: "add" })).rejects.toMatchObject({
      code: "DROPSHIP_CATALOG_IDS_TOO_MANY", context: { needed: PERF_SIZES },
    });
    // One category at a time stays under the cap.
    expect((await service().listCatalogIds({ vendorId: OTHER_VENDOR, purpose: "add", categoryId: 3 })).notSelectedIds)
      .toHaveLength(PERF_SIZES / 20);
  }, PERF_TIMEOUT_MS);
});

const listingTiers = {
  pack: { tier: "pack" as const, eligible: true, reason: null, policyMinimumCents: 10_000, minimumCents: 10_000, alreadyOn: true,
    reserveShortfallCents: 0, balanceShortfallCents: 0, upcoming: null },
  case: { tier: "case" as const, eligible: true, reason: null, policyMinimumCents: 50_000, minimumCents: 50_000, alreadyOn: true,
    reserveShortfallCents: 0, balanceShortfallCents: 0, upcoming: null },
};
