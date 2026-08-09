import { z } from "zod";

export const CATALOG_EXPORT_DEFAULT_PAGE_SIZE = 500;
export const CATALOG_EXPORT_MAX_PAGE_SIZE = 1_000;

const cursorSchema = z.object({
  version: z.literal(1),
  afterVariantId: z.number().int().positive(),
}).strict();

const sourceIdSchema = z.string().trim().min(1).max(255);

export type CatalogExportItemKind = "inventory" | "non_inventory" | "service" | "unknown";
export type CatalogExportItemStatus = "active" | "archived";

export interface CatalogVariantSnapshot {
  variantId: number;
  productId: number;
  variantName: string;
  productName: string;
  variantSku: string | null;
  productSku: string | null;
  gtin: string | null;
  barcode: string | null;
  mpn: string | null;
  brand: string | null;
  baseUnit: string;
  inventoryType: string;
  productStatus: string | null;
  productIsActive: boolean;
  variantIsActive: boolean;
  productUpdatedAt: Date;
  variantUpdatedAt: Date;
}

export interface NormalizedCatalogExportItem {
  externalItemId: string;
  externalParentId: string;
  name: string;
  sku: string | null;
  gtin: string | null;
  kind: CatalogExportItemKind;
  status: CatalogExportItemStatus;
  sourceUpdatedAt: string;
  attributes: Record<string, string | number | boolean | null>;
}

export interface NormalizedCatalogExportPage {
  externalSourceId: string;
  items: NormalizedCatalogExportItem[];
  nextCursor: string | null;
}

export class InvalidCatalogExportCursorError extends Error {
  constructor() {
    super("Catalog export cursor is invalid.");
    this.name = "InvalidCatalogExportCursorError";
  }
}

export function validateCatalogExportSourceId(value: string | undefined): string {
  const result = sourceIdSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError("CATALOG_EXPORT_SOURCE_ID must contain 1 to 255 characters.");
  }
  return result.data;
}

export function encodeCatalogExportCursor(afterVariantId: number): string {
  if (!Number.isSafeInteger(afterVariantId) || afterVariantId < 1) {
    throw new TypeError("Catalog export cursor position must be a positive safe integer.");
  }
  return Buffer.from(JSON.stringify({ version: 1, afterVariantId }), "utf8").toString("base64url");
}

export function decodeCatalogExportCursor(cursor: string | null): number | null {
  if (cursor === null) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = cursorSchema.parse(JSON.parse(decoded));
    return parsed.afterVariantId;
  } catch {
    throw new InvalidCatalogExportCursorError();
  }
}

function catalogItemKind(inventoryType: string): CatalogExportItemKind {
  if (inventoryType === "inventory") return "inventory";
  if (inventoryType === "non_inventory") return "non_inventory";
  // Echelon's `expense` classification does not prove whether an item is a
  // service or another non-inventory item. Preserve that uncertainty rather
  // than manufacturing an accounting classification.
  return "unknown";
}

function catalogItemStatus(snapshot: CatalogVariantSnapshot): CatalogExportItemStatus {
  return snapshot.productIsActive
    && snapshot.variantIsActive
    && snapshot.productStatus === "active"
    ? "active"
    : "archived";
}

function normalizedOptionalIdentifier(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolvedItemName(snapshot: CatalogVariantSnapshot): string {
  const variantName = snapshot.variantName.trim();
  if (variantName) return variantName;
  const productName = snapshot.productName.trim();
  if (productName) return productName;
  throw new TypeError(`Catalog variant ${snapshot.variantId} has no usable name.`);
}

export function normalizeCatalogVariant(snapshot: CatalogVariantSnapshot): NormalizedCatalogExportItem {
  if (!Number.isSafeInteger(snapshot.variantId) || snapshot.variantId < 1) {
    throw new TypeError("Catalog variant ID must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(snapshot.productId) || snapshot.productId < 1) {
    throw new TypeError("Catalog product ID must be a positive safe integer.");
  }
  const sourceUpdatedAt = new Date(Math.max(
    snapshot.productUpdatedAt.getTime(),
    snapshot.variantUpdatedAt.getTime(),
  ));
  if (Number.isNaN(sourceUpdatedAt.getTime())) {
    throw new TypeError(`Catalog variant ${snapshot.variantId} has an invalid update timestamp.`);
  }

  return {
    externalItemId: `variant:${snapshot.variantId}`,
    externalParentId: `product:${snapshot.productId}`,
    name: resolvedItemName(snapshot),
    sku: normalizedOptionalIdentifier(snapshot.variantSku),
    gtin: normalizedOptionalIdentifier(snapshot.gtin),
    kind: catalogItemKind(snapshot.inventoryType),
    status: catalogItemStatus(snapshot),
    sourceUpdatedAt: sourceUpdatedAt.toISOString(),
    attributes: {
      productId: snapshot.productId,
      variantId: snapshot.variantId,
      productSku: normalizedOptionalIdentifier(snapshot.productSku),
      barcode: normalizedOptionalIdentifier(snapshot.barcode),
      mpn: normalizedOptionalIdentifier(snapshot.mpn),
      brand: normalizedOptionalIdentifier(snapshot.brand),
      baseUnit: snapshot.baseUnit,
      sourceInventoryType: snapshot.inventoryType,
    },
  };
}
