import { createHash } from "node:crypto";
import { z } from "zod";
import { VARIANT_SALES_ELIGIBILITIES, type VariantSalesEligibility } from "@shared/catalog/variant-sales-eligibility";
import { VARIANT_UOM_TYPES } from "@shared/catalog/variant-uom";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import type { DropshipCatalogExposureRule, DropshipCatalogVariantCandidate } from "../../domain/catalog-exposure";
import { readDropshipListingStockSelection } from "../../stock-publication-selection";
import type { LegacyVendorSelectionRule } from "./legacy-vendor-selection";

/**
 * The equivalence and fingerprint fixture of PR B (step 1 plan S2-5, PLAN-B v4.1 §7.1, §15.3; TESTS-2,
 * SAFETY-12): one catalog, admin rules and vendor rules with every scope, read at three injected times.
 * Its stock selection under rules was recorded at main (cea5cb027) as `MAIN_SELECTION_GOLDEN`
 * (selection-oracle.golden.ts), so B's picks readers can be compared with what A's readers decided.
 *
 * Every column the stock selection reader reads is written explicitly (no column default decides a
 * fingerprint), and every id is fixed, so the same seed gives the same reads on any schema that has those
 * columns. The golden pins this text's sha256: change the seed and the golden no longer applies.
 */

/** The three injected times: before, inside and after the admin rules' windows (admin rules 3-5 below). */
export const SELECTION_ORACLE_TIMES = Object.freeze({
  T1: new Date("2026-10-24T09:00:00.000Z"),
  T2: new Date("2026-10-24T12:00:00.000Z"),
  T3: new Date("2026-10-24T15:00:00.000Z"),
});
export type SelectionOracleTime = keyof typeof SELECTION_ORACLE_TIMES;

/**
 * The columns the stock selection reader (SPR) reads that the shared listing-push-runs base fixture does
 * not create (production shapes: shared/schema/catalog.schema.ts, dropship.schema.ts), and the product
 * lines table the rules' product line scope names. Additive, so a base that already has one keeps it.
 */
export const selectionOracleColumnsSql = `
  ALTER TABLE dropship.dropship_store_connections ADD COLUMN IF NOT EXISTS external_account_id varchar(255),
    ADD COLUMN IF NOT EXISTS provider_environment varchar(30);
  ALTER TABLE catalog.products ADD COLUMN IF NOT EXISTS status varchar(20) DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS ebay_listing_excluded boolean NOT NULL DEFAULT false;
  ALTER TABLE catalog.product_variants ADD COLUMN IF NOT EXISTS ebay_listing_excluded boolean NOT NULL DEFAULT false;
  CREATE TABLE IF NOT EXISTS catalog.product_lines (id integer PRIMARY KEY, name text NOT NULL);
`;

/**
 * Catalog: products 1001-1004 share the category "Supplies" spelled with case, trailing-space, tab and
 * no-break-space variants; 1005 shares only a prefix; 1006 has none; 1007 is "Toploaders"; 1008 is
 * inactive. Sizes include a non-sellable one (2003), an inactive one (2004), one that does not ship (2012)
 * and one without inventory tracking (2062).
 *
 * Admin rules: 1 includes everything; 2 excludes product 1006 always; 3 excludes size 2022 only from
 * 10:00 to 14:00 (T2); 4 excludes product 1007 until 10:30 (T1); 5 excludes product 1005 from 13:00 (T3);
 * 6 is inactive.
 *
 * Vendors and their rules (store 40x belongs to vendor 30x; 407 is vendor 301's second, draft-first store;
 * 406 is paused):
 *   301  a catalog include; overrides off (2002), on with a cap (2001), empty (2011)
 *   302  rules that match nothing (an absent size, an absent category, an unused product line)
 *   303  overlapping includes on size 2001 (catalog, category, variant, product); override off on 2001
 *   304  include+exclude pairs: no-break-space category include, size exclude 2002, product line 8 include,
 *        product exclude 1003; an inactive include (1005) and an inactive exclude (2001)
 *   305  tab/case category include "Toploaders", product line 7 include, trailing-space category exclude
 *        "SUPPLIES ", size include 2041; override on (2061)
 *   306  a catalog include on a paused store
 *
 * Listings cover a live listing, a vendor limit (5 and 0), an ended one (with an older completed push),
 * a queued first push with a saved live intent, a failed one without ids, a paused one, and listings of
 * excluded, non-sellable, inactive-product and draft-store sizes.
 */
export const selectionOracleSeedSql = `
  INSERT INTO catalog.product_lines (id, name) VALUES (7, 'Sleeves'), (8, 'Toploaders');
  INSERT INTO catalog.products (id, sku, name, category, is_active, status, product_type, ebay_listing_excluded) VALUES
    (1001, 'P-1001', 'Product 1001', 'Supplies', true, 'active', 'sleeves', false),
    (1002, 'P-1002', 'Product 1002', 'SUPPLIES ', true, 'active', 'sleeves', false),
    (1003, 'P-1003', 'Product 1003', E'\\tsupplies', true, 'active', 'sleeves', false),
    (1004, 'P-1004', 'Product 1004', E'supplies\\u00A0', true, 'active', 'sleeves', false),
    (1005, 'P-1005', 'Product 1005', 'Supplies Pro', true, 'active', 'toploaders', false),
    (1006, 'P-1006', 'Product 1006', NULL, true, 'active', 'toploaders', false),
    (1007, 'P-1007', 'Product 1007', 'Toploaders', true, 'active', 'toploaders', false),
    (1008, 'P-1008', 'Product 1008', 'Supplies', false, 'active', 'sleeves', false);
  INSERT INTO catalog.product_line_products (product_id, product_line_id) VALUES
    (1001, 7), (1002, 7), (1003, 7), (1003, 8), (1005, 8), (1006, 8), (1007, 8);
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded) VALUES
    (2001, 1001, 'S-2001', 'Size 2001', 'pack', true, true, true, 'sellable', false),
    (2002, 1001, 'S-2002', 'Size 2002', 'case', true, true, true, 'sellable', false),
    (2003, 1001, 'S-2003', 'Size 2003', 'pack', true, true, true, 'internal_only', false),
    (2004, 1001, 'S-2004', 'Size 2004', 'pack', false, true, true, 'sellable', false),
    (2011, 1002, 'S-2011', 'Size 2011', 'pack', true, true, true, 'sellable', false),
    (2012, 1002, 'S-2012', 'Size 2012', 'case', true, false, true, 'sellable', false),
    (2021, 1003, 'S-2021', 'Size 2021', 'pack', true, true, true, 'sellable', false),
    (2022, 1003, 'S-2022', 'Size 2022', 'case', true, true, true, 'sellable', false),
    (2031, 1004, 'S-2031', 'Size 2031', 'pack', true, true, true, 'sellable', false),
    (2041, 1005, 'S-2041', 'Size 2041', 'pack', true, true, true, 'sellable', false),
    (2051, 1006, 'S-2051', 'Size 2051', 'pack', true, true, true, 'sellable', false),
    (2061, 1007, 'S-2061', 'Size 2061', 'pack', true, true, true, 'sellable', false),
    (2062, 1007, 'S-2062', 'Size 2062', 'case', true, true, false, 'sellable', false),
    (2071, 1008, 'S-2071', 'Size 2071', 'pack', true, true, true, 'sellable', false);

  INSERT INTO dropship.dropship_catalog_rules (id, scope_type, action, product_line_id, product_id, product_variant_id, category,
    starts_at, ends_at, is_active, priority) OVERRIDING SYSTEM VALUE VALUES
    (1, 'catalog', 'include', NULL, NULL, NULL, NULL, NULL, NULL, true, 0),
    (2, 'product', 'exclude', NULL, 1006, NULL, NULL, NULL, NULL, true, 10),
    (3, 'variant', 'exclude', NULL, NULL, 2022, NULL, '2026-10-24T10:00:00Z', '2026-10-24T14:00:00Z', true, 10),
    (4, 'product', 'exclude', NULL, 1007, NULL, NULL, NULL, '2026-10-24T10:30:00Z', true, 10),
    (5, 'product', 'exclude', NULL, 1005, NULL, NULL, '2026-10-24T13:00:00Z', NULL, true, 10),
    (6, 'catalog', 'exclude', NULL, NULL, NULL, NULL, NULL, NULL, false, 20);

  INSERT INTO dropship.dropship_vendors (id, member_id, status, entitlement_status) VALUES
    (301, 'member-301', 'active', 'active'), (302, 'member-302', 'active', 'active'), (303, 'member-303', 'active', 'active'),
    (304, 'member-304', 'active', 'active'), (305, 'member-305', 'active', 'active'), (306, 'member-306', 'active', 'active');
  INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status, external_account_id, provider_environment) VALUES
    (401, 301, 'ebay', 'connected', 'seller-401', 'production'), (402, 302, 'ebay', 'connected', 'seller-402', 'production'),
    (403, 303, 'ebay', 'connected', 'seller-403', 'production'), (404, 304, 'ebay', 'connected', 'seller-404', 'production'),
    (405, 305, 'ebay', 'connected', 'seller-405', 'production'), (406, 306, 'ebay', 'paused', 'seller-406', 'production'),
    (407, 301, 'ebay', 'connected', 'seller-407', 'production');
  INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode, inventory_mode, is_active) VALUES
    (401, 'ebay', 'live', 'managed_quantity_sync', true), (402, 'ebay', 'live', 'managed_quantity_sync', true),
    (403, 'ebay', 'live', 'managed_quantity_sync', true), (404, 'ebay', 'live', 'managed_quantity_sync', true),
    (405, 'ebay', 'live', 'managed_quantity_sync', true), (406, 'ebay', 'live', 'managed_quantity_sync', true),
    (407, 'ebay', 'draft_first', 'managed_quantity_sync', true);

  INSERT INTO dropship.dropship_vendor_selection_rules (id, vendor_id, scope_type, action, product_line_id, product_id,
    product_variant_id, category, auto_connect_new_skus, auto_list_new_skus, priority, is_active) OVERRIDING SYSTEM VALUE VALUES
    (11, 301, 'catalog', 'include', NULL, NULL, NULL, NULL, true, false, 0, true),
    (21, 302, 'variant', 'include', NULL, NULL, 2999, NULL, true, false, 0, true),
    (22, 302, 'category', 'include', NULL, NULL, NULL, 'Nothing here', true, false, 0, true),
    (23, 302, 'product_line', 'include', 99, NULL, NULL, NULL, true, false, 0, true),
    (31, 303, 'catalog', 'include', NULL, NULL, NULL, NULL, true, false, 0, true),
    (32, 303, 'category', 'include', NULL, NULL, NULL, 'supplies', true, true, 0, true),
    (33, 303, 'variant', 'include', NULL, NULL, 2001, NULL, false, false, 0, true),
    (34, 303, 'product', 'include', NULL, 1001, NULL, NULL, true, false, 0, true),
    (41, 304, 'category', 'include', NULL, NULL, NULL, E' Supplies\\u00A0', true, false, 0, true),
    (42, 304, 'variant', 'exclude', NULL, NULL, 2002, NULL, true, false, 0, true),
    (43, 304, 'product_line', 'include', 8, NULL, NULL, NULL, true, false, 0, true),
    (44, 304, 'product', 'exclude', NULL, 1003, NULL, NULL, true, false, 0, true),
    (45, 304, 'product', 'include', NULL, 1005, NULL, NULL, true, false, 0, false),
    (46, 304, 'variant', 'exclude', NULL, NULL, 2001, NULL, true, false, 0, false),
    (51, 305, 'category', 'include', NULL, NULL, NULL, E'\\tTOPLOADERS ', true, false, 0, true),
    (52, 305, 'product_line', 'include', 7, NULL, NULL, NULL, true, false, 0, true),
    (53, 305, 'category', 'exclude', NULL, NULL, NULL, 'SUPPLIES ', true, false, 0, true),
    (54, 305, 'variant', 'include', NULL, NULL, 2041, NULL, true, false, 0, true),
    (61, 306, 'catalog', 'include', NULL, NULL, NULL, NULL, true, false, 0, true);
  INSERT INTO dropship.dropship_vendor_variant_overrides (vendor_id, product_variant_id, enabled_override, marketplace_quantity_cap) VALUES
    (301, 2002, false, NULL), (301, 2001, true, 3), (301, 2011, NULL, NULL), (303, 2001, false, NULL), (305, 2061, true, NULL);

  INSERT INTO dropship.dropship_vendor_listings (id, vendor_id, store_connection_id, product_variant_id, platform, status,
    external_listing_id, external_offer_id, vendor_quantity_limit, created_at, updated_at) OVERRIDING SYSTEM VALUE VALUES
    (901, 301, 401, 2001, 'ebay', 'active', 'L-901', 'O-901', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (902, 301, 401, 2002, 'ebay', 'active', 'L-902', 'O-902', 5, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (903, 301, 401, 2011, 'ebay', 'ended', 'L-903', 'O-903', NULL, '2026-10-23T08:00:00Z', '2026-10-23T09:00:00Z'),
    (904, 301, 401, 2021, 'ebay', 'queued', NULL, NULL, NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (905, 301, 401, 2061, 'ebay', 'active', 'L-905', 'O-905', 0, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (906, 301, 401, 2003, 'ebay', 'active', 'L-906', 'O-906', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (907, 301, 401, 2071, 'ebay', 'active', 'L-907', 'O-907', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (908, 301, 401, 2022, 'ebay', 'active', 'L-908', 'O-908', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (911, 302, 402, 2001, 'ebay', 'active', 'L-911', 'O-911', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (921, 303, 403, 2001, 'ebay', 'active', 'L-921', 'O-921', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (922, 303, 403, 2002, 'ebay', 'active', 'L-922', 'O-922', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (931, 304, 404, 2002, 'ebay', 'active', 'L-931', 'O-931', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (932, 304, 404, 2021, 'ebay', 'active', 'L-932', 'O-932', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (933, 304, 404, 2031, 'ebay', 'active', 'L-933', 'O-933', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (934, 304, 404, 2041, 'ebay', 'failed', NULL, NULL, NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (941, 305, 405, 2061, 'ebay', 'active', 'L-941', 'O-941', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (942, 305, 405, 2001, 'ebay', 'active', 'L-942', 'O-942', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (943, 305, 405, 2041, 'ebay', 'paused', 'L-943', 'O-943', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (951, 306, 406, 2001, 'ebay', 'active', 'L-951', 'O-951', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (961, 301, 407, 2001, 'ebay', 'active', 'L-961', 'O-961', NULL, '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z');
  INSERT INTO dropship.dropship_listing_push_jobs (id, vendor_id, store_connection_id, job_type, status, created_at, updated_at)
    OVERRIDING SYSTEM VALUE VALUES (1051, 301, 401, 'push', 'processing', '2026-10-23T07:00:00Z', '2026-10-23T07:00:00Z');
  INSERT INTO dropship.dropship_listing_push_job_items (id, job_id, listing_id, product_variant_id, action, status, result, created_at)
    OVERRIDING SYSTEM VALUE VALUES
    (1101, 1051, 904, 2021, 'push', 'queued', '{"listingIntent":{"platform":"ebay","productVariantId":2021,"listingMode":"live","inventoryMode":"managed_quantity_sync"}}', '2026-10-23T08:30:00Z'),
    (1102, 1051, 903, 2011, 'push', 'completed', '{"listingIntent":{"platform":"ebay","productVariantId":2011,"listingMode":"live","inventoryMode":"managed_quantity_sync"}}', '2026-10-23T08:30:00Z');
`;

export function selectionOracleSeedSha256(): string {
  return createHash("sha256").update(selectionOracleSeedSql, "utf8").digest("hex");
}

/** One size's stock selection on one store at one time, with the fingerprint of its (store, product) read. */
export interface SelectionGoldenEntry {
  action: "publish" | "zero" | "read_only" | "none";
  reason: string;
  /** Absent from the reader's answer (an ended listing, an archived size) is recorded as null. */
  listingSelected: boolean | null;
  publishLimitUnits: number | null;
  fingerprint: string;
}

export function selectionGoldenKey(time: SelectionOracleTime, storeId: number, productId: number, sizeId: number): string {
  return `${time} store ${storeId} product ${productId} size ${sizeId}`;
}

const idRows = z.array(z.object({ id: z.number().int().positive() }));

/**
 * The stock selection reader (SPR, through its public module) for every (time, store, product), each read
 * naming all of the product's sizes, as one entry per size. Keys sorted, so two snapshots compare as text.
 */
export async function readSelectionOracleSnapshot(client: StockSelectionQueryClient): Promise<Record<string, SelectionGoldenEntry>> {
  const stores = idRows.parse((await client.query("SELECT id FROM dropship.dropship_store_connections ORDER BY id")).rows);
  const products = idRows.parse((await client.query("SELECT id FROM catalog.products ORDER BY id")).rows);
  const entries: [string, SelectionGoldenEntry][] = [];
  for (const time of Object.keys(SELECTION_ORACLE_TIMES) as SelectionOracleTime[]) {
    for (const store of stores) {
      for (const product of products) {
        const sizes = idRows.parse((await client.query(
          "SELECT id FROM catalog.product_variants WHERE product_id=$1 ORDER BY id", [product.id])).rows).map((row) => row.id);
        const read = await readDropshipListingStockSelection(client, {
          storeConnectionId: store.id, productId: product.id, productVariantIds: sizes, now: SELECTION_ORACLE_TIMES[time],
        });
        for (const variant of read.variants) {
          entries.push([selectionGoldenKey(time, store.id, product.id, variant.productVariantId), {
            action: variant.action,
            reason: variant.reason,
            listingSelected: variant.listingSelected ?? null,
            publishLimitUnits: variant.publishLimitUnits ?? null,
            fingerprint: read.fingerprint,
          }]);
        }
      }
    }
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

const candidateRowSchema = z.object({
  productId: z.number().int().positive(), productVariantId: z.number().int().positive(),
  productLineIds: z.array(z.number().int().positive()), category: z.string().nullable(),
  productIsActive: z.boolean(), variantIsActive: z.boolean(), variantUomType: z.enum(VARIANT_UOM_TYPES),
  salesEligibility: z.enum(VARIANT_SALES_ELIGIBILITIES).nullable(),
});
const ruleTargetSchema = {
  id: z.number().int().positive(), scopeType: z.enum(["catalog", "product_line", "category", "product", "variant"]),
  action: z.enum(["include", "exclude"]), productLineId: z.number().int().nullable(), productId: z.number().int().nullable(),
  productVariantId: z.number().int().nullable(), category: z.string().nullable(),
};
const adminRuleSchema = z.object({ ...ruleTargetSchema, startsAt: z.date().nullable(), endsAt: z.date().nullable() });
const vendorRuleSchema = z.object({
  ...ruleTargetSchema, vendorId: z.number().int().positive(), autoConnectNewSkus: z.boolean(), autoListNewSkus: z.boolean(),
  isActive: z.boolean(),
});
const overrideSchema = z.object({
  vendorId: z.number().int().positive(), productVariantId: z.number().int().positive(), enabledOverride: z.boolean().nullable(),
  marketplaceQuantityCap: z.number().int().nullable(),
});
const storeSchema = z.object({ id: z.number().int().positive(), vendorId: z.number().int().positive() });

export interface SelectionOracleInputs {
  candidates: (DropshipCatalogVariantCandidate & { salesEligibility: VariantSalesEligibility | null })[];
  adminRules: DropshipCatalogExposureRule[];
  /** Every vendor rule, active or not, in the reader's order (priority DESC, id ASC); the evaluator skips inactive ones. */
  vendorRules: Map<number, LegacyVendorSelectionRule[]>;
  overrides: Map<string, z.infer<typeof overrideSchema>>;
  stores: z.infer<typeof storeSchema>[];
}

/** The evaluator's inputs as stored: sizes, admin rules (active, the reader's order), vendor rules, overrides. */
export async function loadSelectionOracleInputs(client: StockSelectionQueryClient): Promise<SelectionOracleInputs> {
  const candidates = z.array(candidateRowSchema).parse((await client.query(`SELECT p.id AS "productId", v.id AS "productVariantId",
    ARRAY(SELECT product_line_id FROM catalog.product_line_products WHERE product_id=p.id ORDER BY product_line_id) AS "productLineIds",
    p.category, p.is_active AS "productIsActive", v.is_active AS "variantIsActive", v.uom_type AS "variantUomType",
    v.sales_eligibility AS "salesEligibility"
    FROM catalog.product_variants v JOIN catalog.products p ON p.id=v.product_id ORDER BY v.id`)).rows);
  const adminRules = z.array(adminRuleSchema).parse((await client.query(`SELECT id, scope_type AS "scopeType", action,
    product_line_id AS "productLineId", product_id AS "productId", product_variant_id AS "productVariantId", category,
    starts_at AS "startsAt", ends_at AS "endsAt" FROM dropship.dropship_catalog_rules WHERE is_active=true ORDER BY priority ASC, id ASC`)).rows);
  const vendorRuleRows = z.array(vendorRuleSchema).parse((await client.query(`SELECT id, vendor_id AS "vendorId", scope_type AS "scopeType",
    action, product_line_id AS "productLineId", product_id AS "productId", product_variant_id AS "productVariantId", category,
    auto_connect_new_skus AS "autoConnectNewSkus", auto_list_new_skus AS "autoListNewSkus", is_active AS "isActive"
    FROM dropship.dropship_vendor_selection_rules ORDER BY vendor_id, priority DESC, id ASC`)).rows);
  const overrideRows = z.array(overrideSchema).parse((await client.query(`SELECT vendor_id AS "vendorId", product_variant_id AS "productVariantId",
    enabled_override AS "enabledOverride", marketplace_quantity_cap AS "marketplaceQuantityCap"
    FROM dropship.dropship_vendor_variant_overrides ORDER BY vendor_id, product_variant_id`)).rows);
  const stores = z.array(storeSchema).parse((await client.query(
    `SELECT id, vendor_id AS "vendorId" FROM dropship.dropship_store_connections ORDER BY id`)).rows);
  const vendorRules = new Map<number, LegacyVendorSelectionRule[]>();
  for (const rule of vendorRuleRows) vendorRules.set(rule.vendorId, [...(vendorRules.get(rule.vendorId) ?? []), rule]);
  return {
    candidates,
    adminRules,
    vendorRules,
    overrides: new Map(overrideRows.map((row) => [`${row.vendorId}:${row.productVariantId}`, row])),
    stores,
  };
}
