import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readNormalizedSource(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const migration = readNormalizedSource(
  join(process.cwd(), "migrations", "134_po_line_quote_pricing.sql"),
);
const schema = readNormalizedSource(
  join(process.cwd(), "shared", "schema", "procurement.schema.ts"),
);

describe("PO line quote pricing migration", () => {
  it("adds quote basis, source, original quote, and rounding provenance", () => {
    for (const column of [
      "pricing_basis",
      "pricing_source",
      "purchase_uom",
      "purchase_uom_quantity",
      "pieces_per_purchase_uom",
      "quoted_unit_cost_mills",
      "quoted_total_cents",
      "pricing_remainder_mills",
      "quote_reference",
      "quoted_at",
      "quote_valid_until",
    ]) {
      expect(migration).toContain(column);
    }

    expect(migration).toContain("DEFAULT 'legacy_unknown'");
    expect(migration).toContain("DEFAULT 'legacy'");
    expect(migration).toContain("pricing_remainder_mills BIGINT NOT NULL DEFAULT 0");
  });

  it("labels legacy rows without recalculating their historical economics", () => {
    expect(migration).toContain("pricing_basis = COALESCE(pricing_basis, 'legacy_unknown')");
    expect(migration).toContain("pricing_source = COALESCE(pricing_source, 'legacy')");
    expect(migration).not.toMatch(/SET\s+unit_cost_(?:cents|mills)\s*=/i);
    expect(migration).not.toMatch(/SET\s+(?:line_total|total_product_cost)_cents\s*=/i);
  });

  it("keeps legacy nulls valid while constraining new quote values", () => {
    expect(migration).toContain("po_lines_pricing_basis_chk");
    expect(migration).toContain("'legacy_unknown'");
    expect(migration).toContain("'not_applicable'");
    expect(migration).toContain("'per_piece'");
    expect(migration).toContain("'per_purchase_uom'");
    expect(migration).toContain("'extended_total'");

    expect(migration).toContain("po_lines_pricing_source_chk");
    expect(migration).toContain("'vendor_catalog'");
    expect(migration).toContain("'recommendation'");
    expect(migration).toContain("purchase_uom_quantity IS NULL OR purchase_uom_quantity > 0");
    expect(migration).toContain("pieces_per_purchase_uom IS NULL OR pieces_per_purchase_uom > 0");
    expect(migration).toContain("quoted_unit_cost_mills IS NULL OR quoted_unit_cost_mills >= 0");
    expect(migration).toContain("quoted_total_cents IS NULL OR quoted_total_cents >= 0");
  });

  it("classifies historical non-product lines as quote pricing not applicable", () => {
    expect(migration).toContain(
      "WHERE line_type = 'product'\n  AND pricing_basis IN ('legacy_unknown', 'not_applicable')",
    );
    expect(migration).toContain("WHERE line_type <> 'product';");
    expect(migration).toContain("pricing_basis = 'not_applicable'");
    expect(migration).toContain("pricing_source = 'legacy'");
  });

  it("keeps legacy and non-product classifications free of quote provenance", () => {
    const start = migration.indexOf("ADD CONSTRAINT po_lines_explicit_pricing_consistency_chk");
    const end = migration.indexOf("END IF;", start);
    const constraint = migration.slice(start, end);

    expect(constraint).toContain("pricing_basis = 'legacy_unknown'");
    expect(constraint).toContain("AND line_type = 'product'");
    expect(constraint).toContain("pricing_basis = 'not_applicable'");
    expect(constraint).toContain("AND line_type <> 'product'");
    expect(constraint).not.toContain(
      "pricing_basis IN ('legacy_unknown', 'not_applicable') OR",
    );
    for (const invariant of [
      "purchase_uom IS NULL",
      "purchase_uom_quantity IS NULL",
      "pieces_per_purchase_uom IS NULL",
      "quoted_unit_cost_mills IS NULL",
      "quoted_total_cents IS NULL",
      "pricing_remainder_mills = 0",
      "quote_reference IS NULL",
      "quoted_at IS NULL",
      "quote_valid_until IS NULL",
    ]) {
      expect(constraint).toContain(invariant);
    }
  });

  it("enforces basis-specific PO quote shape and normalized pricing identities", () => {
    const start = migration.indexOf("ADD CONSTRAINT po_lines_explicit_pricing_consistency_chk");
    const end = migration.indexOf("END IF;", start);
    const constraint = migration.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(constraint).toContain("pricing_basis = 'legacy_unknown'");
    expect(constraint).toContain("pricing_basis = 'not_applicable'");
    expect(constraint).toContain("pricing_basis = 'per_piece'");
    expect(constraint).toContain("pricing_basis = 'per_purchase_uom'");
    expect(constraint).toContain("pricing_basis = 'extended_total'");
    expect(constraint).toContain("btrim(purchase_uom) <> ''");
    expect(constraint).toContain(
      "purchase_uom_quantity::bigint * pieces_per_purchase_uom::bigint",
    );
    expect(constraint).toContain(
      ") = unit_cost_mills::numeric * order_qty::numeric\n            + pricing_remainder_mills::numeric",
    );
    expect(constraint).toContain(
      "total_product_cost_cents::numeric = floor",
    );
    expect(constraint).toContain(
      "unit_cost_cents::numeric = floor((unit_cost_mills::numeric + 50) / 100)",
    );
    expect(constraint).toContain("packaging_cost_cents >= 0");
    expect(constraint).toContain("discount_cents >= 0");
    expect(constraint).toContain("tax_cents >= 0");
    expect(constraint).toContain(
      "line_total_cents::numeric =\n            total_product_cost_cents::numeric\n            + packaging_cost_cents::numeric\n            - discount_cents::numeric\n            + tax_cents::numeric",
    );
    expect(constraint).toContain("NULLIF(order_qty, 0)");
  });

  it("keeps source provenance consistent with quote basis and catalog lineage", () => {
    const start = migration.indexOf(
      "ADD CONSTRAINT po_lines_pricing_source_basis_consistency_chk",
    );
    const end = migration.indexOf("END IF;", start);
    const constraint = migration.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(constraint).toContain("pricing_basis = 'legacy_unknown'");
    expect(constraint).toContain("pricing_source = 'legacy'");
    expect(constraint).toContain(
      "pricing_basis IN ('per_piece', 'per_purchase_uom', 'extended_total')",
    );
    expect(constraint).toContain("pricing_source = 'manual'");
    expect(constraint).toContain("pricing_source IN ('vendor_catalog', 'recommendation')");
    expect(constraint).toContain("vendor_product_id IS NOT NULL");
    expect(constraint).toContain("quoted_at IS NOT NULL");
    expect(migration).toContain("po_lines_quote_dates_consistency_chk");
    expect(migration).toContain("quote_valid_until >= quoted_at::date");
  });

  it("adds reusable quote provenance and consistency to vendor catalog products", () => {
    const columnsStart = migration.indexOf("ALTER TABLE procurement.vendor_products");
    const columnsEnd = migration.indexOf(";", columnsStart);
    const columns = migration.slice(columnsStart, columnsEnd);
    expect(columns).toContain("pricing_basis VARCHAR(30) NOT NULL DEFAULT 'legacy_unknown'");
    expect(columns).toContain("purchase_uom VARCHAR(50)");
    expect(columns).toContain("quoted_unit_cost_mills BIGINT");
    expect(columns).toContain("pieces_per_purchase_uom INTEGER");
    expect(columns).toContain("quote_reference VARCHAR(255)");
    expect(columns).toContain("quoted_at TIMESTAMP");
    expect(columns).toContain("quote_valid_until DATE");
    expect(migration).toContain("UPDATE procurement.vendor_products");
    expect(migration).toContain("vendor_products_pricing_basis_chk");
    expect(migration).not.toContain("COALESCE(quoted_at, updated_at, created_at, NOW())");
    expect(migration).toContain("put the mapping back into the legacy review queue");

    const checkStart = migration.indexOf(
      "ADD CONSTRAINT vendor_products_explicit_pricing_consistency_chk",
    );
    const checkEnd = migration.indexOf("END IF;", checkStart);
    const constraint = migration.slice(checkStart, checkEnd);
    expect(checkStart).toBeGreaterThanOrEqual(0);
    expect(constraint).toContain("pricing_basis = 'legacy_unknown'");
    expect(constraint).toContain("purchase_uom IS NULL");
    expect(constraint).toContain("quoted_unit_cost_mills IS NULL");
    expect(constraint).toContain("pieces_per_purchase_uom IS NULL");
    expect(constraint).toContain("quote_reference IS NULL");
    expect(constraint).toContain("quoted_at IS NULL");
    expect(constraint).toContain("quote_valid_until IS NULL");
    expect(constraint).toContain("unit_cost_mills = quoted_unit_cost_mills");
    expect(constraint).toContain("btrim(purchase_uom) <> ''");
    expect(constraint).toContain("NULLIF(pieces_per_purchase_uom, 0)");
    expect(constraint).toContain(
      "unit_cost_cents::numeric = floor((unit_cost_mills::numeric + 50) / 100)",
    );
    expect(constraint).toContain("quoted_at IS NOT NULL");
    expect(constraint).toContain("quote_valid_until >= quoted_at::date");
    expect(migration).toContain("vendor_products_moq_positive_chk");
    expect(migration).toContain("CHECK (moq IS NULL OR moq > 0)");
    expect(migration).toContain("Cannot enforce positive vendor MOQ; invalid rows found");
    expect(migration).toContain("positive base-piece quantity or NULL");
    expect(migration).toContain("Minimum order quantity in base pieces");

    const legacyCleanupStart = migration.indexOf(
      "UPDATE procurement.vendor_products\nSET\n  purchase_uom = NULL",
    );
    const legacyCleanupEnd = migration.indexOf(";", legacyCleanupStart);
    const legacyCleanup = migration.slice(legacyCleanupStart, legacyCleanupEnd);
    expect(legacyCleanupStart).toBeGreaterThanOrEqual(0);
    expect(legacyCleanup).toContain("quoted_unit_cost_mills = NULL");
    expect(legacyCleanup).toContain("pieces_per_purchase_uom = NULL");
    expect(legacyCleanup).toContain("WHERE pricing_basis = 'legacy_unknown'");
  });

  it("preflights and closes nullable catalog identity and preferred-vendor ambiguity", () => {
    const mappingPreflight = migration.indexOf(
      "Cannot enforce unique vendor catalog mappings; duplicates found",
    );
    const mappingIndex = migration.indexOf(
      "CREATE UNIQUE INDEX IF NOT EXISTS vendor_products_vendor_product_variant_key_uidx",
    );
    const preferredPreflight = migration.indexOf(
      "Cannot enforce one active preferred vendor per product/configuration",
    );
    const preferredIndex = migration.indexOf(
      "CREATE UNIQUE INDEX IF NOT EXISTS vendor_products_one_active_preferred_key_uidx",
    );

    expect(mappingPreflight).toBeGreaterThanOrEqual(0);
    expect(mappingIndex).toBeGreaterThan(mappingPreflight);
    expect(preferredPreflight).toBeGreaterThan(mappingIndex);
    expect(preferredIndex).toBeGreaterThan(preferredPreflight);
    expect(migration).toContain("COALESCE(product_variant_id, 0)");
    expect(migration).toContain("WHERE is_active = 1\n    AND is_preferred = 1");
    expect(migration).toContain("array_agg(id ORDER BY id) AS mapping_ids");
    expect(migration).toContain("array_agg(vendor_id ORDER BY id) AS vendor_ids");
  });

  it("preflights duplicate active line numbers before adding the partial unique index", () => {
    const nullStatusBackfillPosition = migration.indexOf("SET status = 'open'");
    const statusNotNullPosition = migration.indexOf("ALTER COLUMN status SET NOT NULL");
    const preflightPosition = migration.indexOf("HAVING COUNT(*) > 1");
    const indexPosition = migration.indexOf(
      "CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_lines_po_id_line_number_active_uidx",
    );

    expect(nullStatusBackfillPosition).toBeGreaterThanOrEqual(0);
    expect(statusNotNullPosition).toBeGreaterThan(nullStatusBackfillPosition);
    expect(preflightPosition).toBeGreaterThan(statusNotNullPosition);
    expect(preflightPosition).toBeGreaterThanOrEqual(0);
    expect(indexPosition).toBeGreaterThan(preflightPosition);
    expect(migration).toContain("duplicate active rows found");
    expect(migration).toContain("purchase_order_id=%s line_number=%s count=%s");
    expect(migration).toContain("ON procurement.purchase_order_lines (purchase_order_id, line_number)");
    expect(migration).toContain("WHERE status <> 'cancelled'");
  });

  it("keeps Drizzle schema aligned and preserves the handoff composite index", () => {
    expect(schema).toContain("poLinePricingBasisEnum");
    expect(schema).toContain("poLinePricingSourceEnum");
    expect(schema).toContain("vendorProductPricingBasisEnum");
    expect(schema).toContain("purchase_order_lines_po_id_line_id_uidx");
    expect(schema).toContain("purchase_order_lines_po_id_line_number_active_uidx");
    expect(schema).toContain("pricingRemainderMills: bigint");
    expect(schema).toContain("vendor_products_explicit_pricing_consistency_chk");
    expect(schema).toContain("vendor_products_moq_positive_chk");
    expect(schema).toContain("po_lines_explicit_pricing_consistency_chk");
    expect(schema).toContain("po_lines_pricing_source_basis_consistency_chk");
    expect(schema).toContain("po_lines_quote_dates_consistency_chk");
    expect(schema).toContain(
      "${table.pricingBasis} = 'legacy_unknown'\n      AND ${table.lineType} = 'product'",
    );
    expect(schema).toContain(
      "${table.pricingBasis} = 'not_applicable'\n      AND ${table.lineType} <> 'product'",
    );
    expect(schema).toContain(
      "${table.pricingBasis} = 'legacy_unknown'\n      AND ${table.purchaseUom} IS NULL\n      AND ${table.quotedUnitCostMills} IS NULL\n      AND ${table.piecesPerPurchaseUom} IS NULL",
    );
    expect(schema).toContain("vendor_products_vendor_product_variant_key_uidx");
    expect(schema).toContain("vendor_products_one_active_preferred_key_uidx");
    expect(schema).toContain('status: varchar("status", { length: 20 }).notNull().default("open")');
  });
});
