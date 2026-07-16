import { createHash } from "node:crypto";
import type { PoLinePricingInput } from "@shared/utils/po-line-pricing";
import { PurchasingError } from "./purchasing.service";
import {
  assessSupplierQuoteValidity,
  type SupplierQuoteValidityStatus,
} from "./supplier-quote-validity";

const PG_INTEGER_MAX = 2_147_483_647;
const MAX_IMPORT_ROWS = 200;
const MAX_QUOTE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const IMPORT_CONTRACT_VERSION = 1;

export type SupplierEvidencePricingBasis = "per_piece" | "per_purchase_uom";

export type SupplierEvidenceImportRow = {
  sku: string;
  vendorSku?: string | null;
  pricingBasis: SupplierEvidencePricingBasis;
  quotedUnitCost: string;
  purchaseUom?: string | null;
  piecesPerPurchaseUom?: number | null;
  quoteReference?: string | null;
  quotedAt: Date;
  quoteValidUntil?: string | null;
  moqPieces?: number | null;
  leadTimeDays: number;
  isPreferred: boolean;
};

export type SupplierEvidenceImportError = {
  rowNumber: number;
  sku: string | null;
  code: string;
  field?: string;
  message: string;
};

export type SupplierEvidenceCatalogEntry = {
  productId: number;
  productVariantId: number | null;
  vendorSku: string | null;
  pricing: PoLinePricingInput;
  quoteReference: string | null;
  quotedAt: Date;
  quoteValidUntil: string | null;
  packSize: number;
  moq: number;
  leadTimeDays: number;
  isPreferred: boolean;
};

export type SupplierEvidenceImportPreviewItem = {
  rowNumber: number;
  sku: string;
  productId: number;
  productVariantId: number | null;
  productName: string;
  variantName: string | null;
  action: "create" | "update" | "reactivate";
  existingVendorProductId: number | null;
  willDemoteVendorProductIds: number[];
  pricingBasis: SupplierEvidencePricingBasis;
  quotedUnitCost: string;
  normalizedUnitCostMills: number;
  purchaseUom: string | null;
  piecesPerPurchaseUom: number | null;
  quoteReference: string | null;
  quotedAt: string;
  quoteValidUntil: string | null;
  quoteValidityStatus: SupplierQuoteValidityStatus;
  moqPieces: number;
  leadTimeDays: number;
  isPreferred: boolean;
  warnings: string[];
};

export type SupplierEvidenceImportPreview = {
  contractVersion: number;
  generatedAt: string;
  previewHash: string;
  vendor: {
    id: number;
    code: string;
    name: string;
  };
  summary: {
    total: number;
    creates: number;
    updates: number;
    reactivations: number;
    preferredDemotions: number;
    warnings: number;
  };
  items: SupplierEvidenceImportPreviewItem[];
  catalogEntries: SupplierEvidenceCatalogEntry[];
};

export type SupplierEvidenceImportDependencies = {
  getVendorById(vendorId: number): Promise<any | undefined>;
  getAllProducts(includeInactive?: boolean): Promise<any[]>;
  getAllProductVariants(includeInactive?: boolean): Promise<any[]>;
  getVendorProductsByProductIds(productIds: number[]): Promise<any[]>;
  now?: () => Date;
};

function positivePgInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= PG_INTEGER_MAX;
}

function nonnegativePgInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= PG_INTEGER_MAX;
}

function normalizeSku(value: string): string {
  return value.trim().toUpperCase();
}

function isActive(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

function exactDollarsToMills(value: string): number | null {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(normalized);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(4, "0"));
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(fraction)) return null;
  const mills = whole * 10_000 + fraction;
  return Number.isSafeInteger(mills) ? mills : null;
}

function normalizedImportCost(mills: number): string {
  const whole = Math.floor(mills / 10_000);
  const fraction = String(mills % 10_000).padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}.0000`;
}

function mappingKey(productId: number, productVariantId: number | null): string {
  return `${productId}:${productVariantId ?? 0}`;
}

function stablePreviewHash(input: unknown): string {
  return createHash("sha256")
    .update(`supplier-evidence-import:v${IMPORT_CONTRACT_VERSION}:`)
    .update(JSON.stringify(input))
    .digest("hex");
}

function mappingFingerprint(mapping: any): Record<string, unknown> | null {
  if (!mapping) return null;
  return {
    id: Number(mapping.id),
    vendorId: Number(mapping.vendorId ?? mapping.vendor_id),
    productId: Number(mapping.productId ?? mapping.product_id),
    productVariantId: mapping.productVariantId == null && mapping.product_variant_id == null
      ? null
      : Number(mapping.productVariantId ?? mapping.product_variant_id),
    unitCostMills: mapping.unitCostMills ?? mapping.unit_cost_mills ?? null,
    pricingBasis: mapping.pricingBasis ?? mapping.pricing_basis ?? null,
    purchaseUom: mapping.purchaseUom ?? mapping.purchase_uom ?? null,
    quotedUnitCostMills: mapping.quotedUnitCostMills ?? mapping.quoted_unit_cost_mills ?? null,
    piecesPerPurchaseUom: mapping.piecesPerPurchaseUom ?? mapping.pieces_per_purchase_uom ?? null,
    quoteReference: mapping.quoteReference ?? mapping.quote_reference ?? null,
    quotedAt: mapping.quotedAt ?? mapping.quoted_at ?? null,
    quoteValidUntil: mapping.quoteValidUntil ?? mapping.quote_valid_until ?? null,
    moq: mapping.moq ?? null,
    leadTimeDays: mapping.leadTimeDays ?? mapping.lead_time_days ?? null,
    vendorSku: mapping.vendorSku ?? mapping.vendor_sku ?? null,
    isPreferred: Number(mapping.isPreferred ?? mapping.is_preferred ?? 0),
    isActive: Number(mapping.isActive ?? mapping.is_active ?? 0),
    updatedAt: mapping.updatedAt ?? mapping.updated_at ?? null,
  };
}

function pushError(
  errors: SupplierEvidenceImportError[],
  rowNumber: number,
  sku: string | null,
  code: string,
  message: string,
  field?: string,
) {
  errors.push({ rowNumber, sku, code, message, ...(field ? { field } : {}) });
}

function pricingForRow(
  row: SupplierEvidenceImportRow,
  rowNumber: number,
  sku: string,
  errors: SupplierEvidenceImportError[],
): {
  pricing: PoLinePricingInput;
  quotedUnitCostMills: number;
  purchaseUom: string | null;
  piecesPerPurchaseUom: number | null;
  packSize: number;
} | null {
  const quotedUnitCostMills = exactDollarsToMills(row.quotedUnitCost);
  if (quotedUnitCostMills === null) {
    pushError(
      errors,
      rowNumber,
      sku,
      "QUOTED_UNIT_COST_INVALID",
      "quotedUnitCost must be a non-negative dollar amount with no more than four decimal places",
      "quotedUnitCost",
    );
    return null;
  }

  if (row.pricingBasis === "per_piece") {
    if (row.purchaseUom || row.piecesPerPurchaseUom) {
      pushError(
        errors,
        rowNumber,
        sku,
        "PER_PIECE_UOM_FIELDS_NOT_ALLOWED",
        "purchaseUom and piecesPerPurchaseUom must be blank for per-piece pricing",
        "pricingBasis",
      );
      return null;
    }
    return {
      pricing: {
        basis: "per_piece",
        quantityPieces: 1,
        unitCostMills: quotedUnitCostMills,
      },
      quotedUnitCostMills,
      purchaseUom: null,
      piecesPerPurchaseUom: null,
      packSize: 1,
    };
  }

  const purchaseUom = row.purchaseUom?.trim() ?? "";
  if (!purchaseUom || purchaseUom.length > 50) {
    pushError(
      errors,
      rowNumber,
      sku,
      "PURCHASE_UOM_REQUIRED",
      "purchaseUom is required and cannot exceed 50 characters for purchase-UOM pricing",
      "purchaseUom",
    );
    return null;
  }
  if (!positivePgInteger(row.piecesPerPurchaseUom)) {
    pushError(
      errors,
      rowNumber,
      sku,
      "PIECES_PER_PURCHASE_UOM_INVALID",
      "piecesPerPurchaseUom must be a positive integer for purchase-UOM pricing",
      "piecesPerPurchaseUom",
    );
    return null;
  }
  return {
    pricing: {
      basis: "per_purchase_uom",
      purchaseUom,
      uomQuantity: 1,
      piecesPerUom: row.piecesPerPurchaseUom,
      quotedCostMillsPerUom: quotedUnitCostMills,
    },
    quotedUnitCostMills,
    purchaseUom,
    piecesPerPurchaseUom: row.piecesPerPurchaseUom,
    packSize: row.piecesPerPurchaseUom,
  };
}

export async function buildSupplierEvidenceImportPreview(input: {
  vendorId: number;
  rows: SupplierEvidenceImportRow[];
  dependencies: SupplierEvidenceImportDependencies;
}): Promise<SupplierEvidenceImportPreview> {
  const { vendorId, rows, dependencies } = input;
  if (!positivePgInteger(vendorId)) {
    throw new PurchasingError("vendorId must be a positive PostgreSQL integer", 400, {
      code: "SUPPLIER_EVIDENCE_VENDOR_ID_INVALID",
    });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new PurchasingError("rows must be a non-empty array", 400, {
      code: "SUPPLIER_EVIDENCE_ROWS_REQUIRED",
    });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new PurchasingError(`rows cannot contain more than ${MAX_IMPORT_ROWS} items`, 400, {
      code: "SUPPLIER_EVIDENCE_BATCH_TOO_LARGE",
      maximum: MAX_IMPORT_ROWS,
    });
  }

  const [vendor, products, variants] = await Promise.all([
    dependencies.getVendorById(vendorId),
    dependencies.getAllProducts(true),
    dependencies.getAllProductVariants(true),
  ]);
  if (!vendor) {
    throw new PurchasingError("Supplier not found", 404, {
      code: "SUPPLIER_EVIDENCE_VENDOR_NOT_FOUND",
      vendorId,
    });
  }
  if (!isActive(vendor.active)) {
    throw new PurchasingError("Supplier is inactive", 409, {
      code: "SUPPLIER_EVIDENCE_VENDOR_INACTIVE",
      vendorId,
    });
  }

  const productsBySku = new Map<string, any[]>();
  const productsById = new Map<number, any>();
  for (const product of products) {
    productsById.set(Number(product.id), product);
    const sku = normalizeSku(String(product.sku ?? product.baseSku ?? ""));
    if (!sku) continue;
    productsBySku.set(sku, [...(productsBySku.get(sku) ?? []), product]);
  }
  const variantsBySku = new Map<string, any[]>();
  const activeVariantsByProduct = new Map<number, any[]>();
  for (const variant of variants) {
    const sku = normalizeSku(String(variant.sku ?? ""));
    if (sku) variantsBySku.set(sku, [...(variantsBySku.get(sku) ?? []), variant]);
    if (isActive(variant.isActive ?? variant.is_active)) {
      const productId = Number(variant.productId ?? variant.product_id);
      activeVariantsByProduct.set(productId, [
        ...(activeVariantsByProduct.get(productId) ?? []),
        variant,
      ]);
    }
  }

  const candidateProductIds = rows.flatMap((row) => {
    const sku = normalizeSku(row.sku ?? "");
    const productMatches = productsBySku.get(sku) ?? [];
    const variantMatches = variantsBySku.get(sku) ?? [];
    if (productMatches.length + variantMatches.length !== 1) return [];
    const variant = variantMatches[0];
    if (variant) return [Number(variant.productId ?? variant.product_id)];
    return [Number(productMatches[0].id)];
  });
  const vendorProducts = await dependencies.getVendorProductsByProductIds(candidateProductIds);
  const mappingsByKey = new Map<string, any[]>();
  for (const mapping of vendorProducts) {
    const key = mappingKey(
      Number(mapping.productId ?? mapping.product_id),
      mapping.productVariantId == null && mapping.product_variant_id == null
        ? null
        : Number(mapping.productVariantId ?? mapping.product_variant_id),
    );
    mappingsByKey.set(key, [...(mappingsByKey.get(key) ?? []), mapping]);
  }

  const now = dependencies.now?.() ?? new Date();
  const errors: SupplierEvidenceImportError[] = [];
  const items: SupplierEvidenceImportPreviewItem[] = [];
  const catalogEntries: SupplierEvidenceCatalogEntry[] = [];
  const mappingHashState: Array<{
    existing: Record<string, unknown> | null;
    competingPreferred: Array<Record<string, unknown> | null>;
  }> = [];
  const firstRowBySku = new Map<string, number>();

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const sku = normalizeSku(row.sku ?? "");
    if (!sku || sku.length > 100) {
      pushError(errors, rowNumber, sku || null, "SKU_INVALID", "sku is required and cannot exceed 100 characters", "sku");
      continue;
    }
    const firstRow = firstRowBySku.get(sku);
    if (firstRow !== undefined) {
      pushError(
        errors,
        rowNumber,
        sku,
        "DUPLICATE_IMPORT_SKU",
        `sku duplicates CSV row ${firstRow}`,
        "sku",
      );
      continue;
    }
    firstRowBySku.set(sku, rowNumber);

    const productMatches = productsBySku.get(sku) ?? [];
    const variantMatches = variantsBySku.get(sku) ?? [];
    if (productMatches.length + variantMatches.length === 0) {
      pushError(errors, rowNumber, sku, "SKU_NOT_FOUND", "No Echelon product or variant matches this exact SKU", "sku");
      continue;
    }
    if (productMatches.length + variantMatches.length > 1) {
      pushError(
        errors,
        rowNumber,
        sku,
        "SKU_AMBIGUOUS",
        "The SKU matches more than one product or receive variant; repair catalog identity before import",
        "sku",
      );
      continue;
    }

    const variant = variantMatches[0] ?? null;
    const product = variant
      ? productsById.get(Number(variant.productId ?? variant.product_id))
      : productMatches[0];
    if (!product) {
      pushError(errors, rowNumber, sku, "PRODUCT_NOT_FOUND", "The matched variant has no parent product", "sku");
      continue;
    }
    if (!isActive(product.isActive ?? product.is_active)) {
      pushError(errors, rowNumber, sku, "PRODUCT_INACTIVE", "The matched product is inactive", "sku");
      continue;
    }
    if (variant && !isActive(variant.isActive ?? variant.is_active)) {
      pushError(errors, rowNumber, sku, "VARIANT_INACTIVE", "The matched receive variant is inactive", "sku");
      continue;
    }
    const productId = Number(product.id);
    if (!variant && (activeVariantsByProduct.get(productId)?.length ?? 0) > 0) {
      const sample = (activeVariantsByProduct.get(productId) ?? [])
        .slice(0, 5)
        .map((candidate) => candidate.sku)
        .filter(Boolean)
        .join(", ");
      pushError(
        errors,
        rowNumber,
        sku,
        "VARIANT_SKU_REQUIRED",
        `This product has active receive variants; use an exact variant SKU${sample ? ` such as ${sample}` : ""}`,
        "sku",
      );
      continue;
    }

    if (!nonnegativePgInteger(row.leadTimeDays)) {
      pushError(
        errors,
        rowNumber,
        sku,
        "LEAD_TIME_INVALID",
        "leadTimeDays must be a non-negative integer",
        "leadTimeDays",
      );
      continue;
    }
    const moq = row.moqPieces == null ? 1 : row.moqPieces;
    if (!positivePgInteger(moq)) {
      pushError(errors, rowNumber, sku, "MOQ_INVALID", "moqPieces must be a positive integer", "moqPieces");
      continue;
    }
    if (!(row.quotedAt instanceof Date) || Number.isNaN(row.quotedAt.getTime())) {
      pushError(errors, rowNumber, sku, "QUOTED_AT_INVALID", "quotedAt must be a valid date", "quotedAt");
      continue;
    }
    if (row.quotedAt.getTime() > now.getTime() + MAX_QUOTE_CLOCK_SKEW_MS) {
      pushError(errors, rowNumber, sku, "QUOTED_AT_IN_FUTURE", "quotedAt cannot be materially in the future", "quotedAt");
      continue;
    }
    const quotedDate = row.quotedAt.toISOString().slice(0, 10);
    if (row.quoteValidUntil && row.quoteValidUntil < quotedDate) {
      pushError(
        errors,
        rowNumber,
        sku,
        "QUOTE_DATE_INVALID",
        "quoteValidUntil cannot be earlier than quotedAt",
        "quoteValidUntil",
      );
      continue;
    }
    if (row.vendorSku && row.vendorSku.trim().length > 100) {
      pushError(errors, rowNumber, sku, "VENDOR_SKU_TOO_LONG", "vendorSku cannot exceed 100 characters", "vendorSku");
      continue;
    }
    if (row.quoteReference && row.quoteReference.trim().length > 255) {
      pushError(
        errors,
        rowNumber,
        sku,
        "QUOTE_REFERENCE_TOO_LONG",
        "quoteReference cannot exceed 255 characters",
        "quoteReference",
      );
      continue;
    }

    const pricing = pricingForRow(row, rowNumber, sku, errors);
    if (!pricing) continue;

    const productVariantId = variant ? Number(variant.id) : null;
    const key = mappingKey(productId, productVariantId);
    const mappings = mappingsByKey.get(key) ?? [];
    const existing = mappings.find((mapping) => Number(mapping.vendorId ?? mapping.vendor_id) === vendorId) ?? null;
    const competingPreferred = row.isPreferred
      ? mappings.filter((mapping) =>
          Number(mapping.vendorId ?? mapping.vendor_id) !== vendorId &&
          isActive(mapping.isActive ?? mapping.is_active) &&
          Number(mapping.isPreferred ?? mapping.is_preferred) === 1,
        )
      : [];
    const warnings: string[] = [];
    if (!row.vendorSku?.trim()) warnings.push("Vendor SKU is blank.");
    if (!row.quoteReference?.trim()) warnings.push("Quote reference is blank.");
    if (!row.isPreferred) warnings.push("This mapping will not become the preferred supplier for automation.");
    if (competingPreferred.length > 0) {
      warnings.push(`${competingPreferred.length} currently preferred mapping(s) will be demoted.`);
    }
    const quoteValidity = assessSupplierQuoteValidity({
      quotedAt: row.quotedAt,
      quoteValidUntil: row.quoteValidUntil,
      asOf: now,
      currentDate: now.toISOString().slice(0, 10),
    });
    if (quoteValidity.status === "expired") {
      warnings.push("The supplier-stated quote validity has expired; automation will continue to require quote review.");
    } else if (quoteValidity.status === "stale") {
      warnings.push(`The quote is older than ${quoteValidity.maxAgeDays} days; automation will continue to require quote review.`);
    }

    const action = !existing
      ? "create"
      : isActive(existing.isActive ?? existing.is_active)
        ? "update"
        : "reactivate";
    const normalizedCost = normalizedImportCost(pricing.quotedUnitCostMills);
    items.push({
      rowNumber,
      sku,
      productId,
      productVariantId,
      productName: String(product.name ?? sku),
      variantName: variant ? String(variant.name ?? variant.sku ?? sku) : null,
      action,
      existingVendorProductId: existing ? Number(existing.id) : null,
      willDemoteVendorProductIds: competingPreferred.map((mapping) => Number(mapping.id)).sort((a, b) => a - b),
      pricingBasis: row.pricingBasis,
      quotedUnitCost: normalizedCost,
      normalizedUnitCostMills: pricing.quotedUnitCostMills,
      purchaseUom: pricing.purchaseUom,
      piecesPerPurchaseUom: pricing.piecesPerPurchaseUom,
      quoteReference: row.quoteReference?.trim() || null,
      quotedAt: row.quotedAt.toISOString(),
      quoteValidUntil: row.quoteValidUntil || null,
      quoteValidityStatus: quoteValidity.status,
      moqPieces: moq,
      leadTimeDays: row.leadTimeDays,
      isPreferred: row.isPreferred,
      warnings,
    });
    catalogEntries.push({
      productId,
      productVariantId,
      vendorSku: row.vendorSku?.trim() || null,
      pricing: pricing.pricing,
      quoteReference: row.quoteReference?.trim() || null,
      quotedAt: row.quotedAt,
      quoteValidUntil: row.quoteValidUntil || null,
      packSize: pricing.packSize,
      moq,
      leadTimeDays: row.leadTimeDays,
      isPreferred: row.isPreferred,
    });
    mappingHashState.push({
      existing: mappingFingerprint(existing),
      competingPreferred: competingPreferred
        .map(mappingFingerprint)
        .sort((a, b) => Number(a?.id ?? 0) - Number(b?.id ?? 0)),
    });
  }

  if (errors.length > 0) {
    throw new PurchasingError("Supplier evidence import contains invalid rows", 422, {
      code: "SUPPLIER_EVIDENCE_IMPORT_INVALID",
      errors,
    });
  }

  const hashPayload = {
    contractVersion: IMPORT_CONTRACT_VERSION,
    vendorId,
    items: items.map((item, index) => ({
      sku: item.sku,
      productId: item.productId,
      productVariantId: item.productVariantId,
      action: item.action,
      existingVendorProductId: item.existingVendorProductId,
      willDemoteVendorProductIds: item.willDemoteVendorProductIds,
      pricingBasis: item.pricingBasis,
      quotedUnitCostMills: item.normalizedUnitCostMills,
      purchaseUom: item.purchaseUom,
      piecesPerPurchaseUom: item.piecesPerPurchaseUom,
      quoteReference: item.quoteReference,
      quotedAt: item.quotedAt,
      quoteValidUntil: item.quoteValidUntil,
      quoteValidityStatus: item.quoteValidityStatus,
      moqPieces: item.moqPieces,
      leadTimeDays: item.leadTimeDays,
      isPreferred: item.isPreferred,
      mappingState: mappingHashState[index],
    })),
  };

  return {
    contractVersion: IMPORT_CONTRACT_VERSION,
    generatedAt: now.toISOString(),
    previewHash: stablePreviewHash(hashPayload),
    vendor: {
      id: vendorId,
      code: String(vendor.code ?? vendorId),
      name: String(vendor.name ?? vendor.code ?? vendorId),
    },
    summary: {
      total: items.length,
      creates: items.filter((item) => item.action === "create").length,
      updates: items.filter((item) => item.action === "update").length,
      reactivations: items.filter((item) => item.action === "reactivate").length,
      preferredDemotions: items.reduce((sum, item) => sum + item.willDemoteVendorProductIds.length, 0),
      warnings: items.reduce((sum, item) => sum + item.warnings.length, 0),
    },
    items,
    catalogEntries,
  };
}

export function publicSupplierEvidenceImportPreview(
  preview: SupplierEvidenceImportPreview,
): Omit<SupplierEvidenceImportPreview, "catalogEntries"> {
  const { catalogEntries: _catalogEntries, ...publicPreview } = preview;
  return publicPreview;
}
