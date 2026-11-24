import { createHash } from "node:crypto";

export type SupplierEvidenceCatalogTarget = {
  productId: number;
  productVariantId?: number | null;
  isPreferred?: boolean;
};

type CatalogEvidenceRow = Readonly<Record<string, unknown>>;

function field(row: CatalogEvidenceRow, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake] ?? null;
}

function integerEvidence(value: unknown): string | null {
  return value == null ? null : String(value);
}

function timestampEvidence(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  // These catalog columns are PostgreSQL timestamp WITHOUT time zone. Drizzle
  // decodes their naive SQL text as UTC; raw execute returns the text unchanged.
  // Match that column contract instead of letting the host timezone shift it.
  const naiveSqlTimestamp = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text);
  const timestamp = new Date(naiveSqlTimestamp ? `${text}Z` : text);
  return Number.isNaN(timestamp.getTime()) ? String(value) : timestamp.toISOString();
}

function mappingEvidence(row: CatalogEvidenceRow): Record<string, unknown> {
  return {
    id: integerEvidence(row.id),
    vendorId: integerEvidence(field(row, "vendorId", "vendor_id")),
    productId: integerEvidence(field(row, "productId", "product_id")),
    productVariantId: integerEvidence(field(row, "productVariantId", "product_variant_id")),
    unitCostCents: integerEvidence(field(row, "unitCostCents", "unit_cost_cents")),
    unitCostMills: integerEvidence(field(row, "unitCostMills", "unit_cost_mills")),
    pricingBasis: field(row, "pricingBasis", "pricing_basis"),
    purchaseUom: field(row, "purchaseUom", "purchase_uom"),
    quotedUnitCostMills: integerEvidence(field(row, "quotedUnitCostMills", "quoted_unit_cost_mills")),
    piecesPerPurchaseUom: integerEvidence(field(row, "piecesPerPurchaseUom", "pieces_per_purchase_uom")),
    quoteReference: field(row, "quoteReference", "quote_reference"),
    quotedAt: timestampEvidence(field(row, "quotedAt", "quoted_at")),
    quoteValidUntil: field(row, "quoteValidUntil", "quote_valid_until"),
    packSize: integerEvidence(field(row, "packSize", "pack_size")),
    moq: integerEvidence(row.moq),
    leadTimeDays: integerEvidence(field(row, "leadTimeDays", "lead_time_days")),
    vendorSku: field(row, "vendorSku", "vendor_sku"),
    vendorProductName: field(row, "vendorProductName", "vendor_product_name"),
    isPreferred: integerEvidence(field(row, "isPreferred", "is_preferred")),
    isActive: integerEvidence(field(row, "isActive", "is_active")),
    updatedAt: timestampEvidence(field(row, "updatedAt", "updated_at")),
  };
}

/** The exact mappings an import may overwrite or demote; unrelated quotes are excluded. */
export function supplierEvidenceCatalogStateFingerprint(
  vendorId: number,
  targets: readonly SupplierEvidenceCatalogTarget[],
  mappings: readonly CatalogEvidenceRow[],
): string {
  const reviewed = targets.map((target) => {
    const scoped = mappings.filter((row) =>
      Number(field(row, "productId", "product_id")) === target.productId &&
      Number(field(row, "productVariantId", "product_variant_id") ?? 0) === (target.productVariantId ?? 0),
    );
    const affected = scoped.filter((row) =>
      Number(field(row, "vendorId", "vendor_id")) === vendorId ||
      (target.isPreferred === true && Number(field(row, "isActive", "is_active")) === 1 &&
        Number(field(row, "isPreferred", "is_preferred")) === 1),
    ).sort((left, right) => Number(left.id) - Number(right.id));
    return {
      productId: target.productId,
      productVariantId: target.productVariantId ?? null,
      isPreferred: target.isPreferred === true,
      mappings: affected.map(mappingEvidence),
    };
  }).sort((left, right) => left.productId - right.productId ||
    (left.productVariantId ?? 0) - (right.productVariantId ?? 0));
  return createHash("sha256").update("supplier-evidence-catalog-state:v1:")
    .update(JSON.stringify({ vendorId, reviewed })).digest("hex");
}
