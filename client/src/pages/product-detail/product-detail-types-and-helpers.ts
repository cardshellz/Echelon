import type { CatalogGalleryAsset } from "@shared/catalog/product-assets";
import {
  createNewVendorCatalogQuoteDraft,
  evaluateVendorCatalogQuoteDraft,
  type VendorCatalogQuoteDraft,
  type VendorCatalogQuoteSnapshot,
} from "@/features/supplier-catalog/VendorCatalogQuoteEditor";
import {
  inferLegacyVariantUomType,
  type VariantUomType,
} from "@shared/catalog/variant-uom";
import type { ProductInventoryStrategy } from "@shared/catalog/inventory-strategy";
import type { VariantSalesEligibility } from "@shared/catalog/variant-sales-eligibility";

export interface ProductVariantRow {
  id: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
  barcode: string | null;
  imageUrl: string | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  shipsInOwnContainer: boolean;
  maxUnitsPerPackage: number | null;
  requiresShipping: boolean;
  trackInventory: boolean | null;
  inventoryTrackingOverride: boolean | null;
  salesEligibility: VariantSalesEligibility;
  hierarchyLevel: number;
  uomType?: VariantUomType | null;
  parentVariantId: number | null;
  isBaseUnit: boolean;
  isActive: boolean;
}

export interface ProductDetailData {
  id: number;
  productId: number;
  sku: string;
  name: string;
  title: string | null;
  description: string | null;
  categoryId: number | null;
  category: string | null;
  shippingGroupId: number | null;
  subcategory: string | null;
  brand: string | null;
  manufacturer: string | null;
  bulletPoints: string[] | null;
  tags: string[] | null;
  seoTitle: string | null;
  seoDescription: string | null;
  status: string | null;
  baseUnit: string;
  inventoryStrategy: ProductInventoryStrategy;
  inventoryTrackingDefault: boolean;
  isActive: boolean;
  leadTimeDays: number;
  safetyStockDays: number;
  shopifyProductId: string | null;
  variants: ProductVariantRow[];
  assets: CatalogGalleryAsset[];
}

export interface Settings {
  [key: string]: string;
}

export interface ProductCategory {
  id: number;
  name: string;
  slug: string;
  isActive: boolean;
}

export interface ShippingGroup {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
}

export interface ProductLocationAssignment {
  id: number;
  sku: string | null;
  location: string;
  isPrimary: number;
}

export interface ProductEditFormState {
  name: string;
  sku: string;
  baseUnit: string;
  inventoryStrategy: ProductInventoryStrategy;
  inventoryTrackingDefault: boolean;
  leadTimeDays: number;
  safetyStockDays: number;
}

export interface ProductContentFormState {
  title: string;
  description: string;
  bulletPoints: string;
  categoryId: string;
  shippingGroupId: string;
  subcategory: string;
  brand: string;
  manufacturer: string;
  tags: string;
  seoTitle: string;
  seoDescription: string;
  status: string;
}

export type VariantPackageAttributeKey = "weightGrams" | "lengthMm" | "widthMm" | "heightMm";
export type VariantPackagePayload = Partial<Record<VariantPackageAttributeKey, number | null>>;

export type VariantPackageInput = {
  weightLb: string;
  lengthIn: string;
  widthIn: string;
  heightIn: string;
};

export interface VariantFormState {
  uomType: VariantUomType;
  hierarchyLevel: number;
  unitsPerVariant: number;
  sku: string;
  name: string;
  barcode: string;
  parentVariantId: number | null;
  isBaseUnit: boolean;
  package: VariantPackageInput;
  shipsInOwnContainer: boolean;
  maxUnitsPerPackage: string;
  requiresShipping: boolean;
  inventoryTrackingOverride: boolean | null;
  salesEligibility: VariantSalesEligibility;
}

export type SupplierMappingForm = {
  vendorId: number;
  vendorSku: string;
  packSize: string;
  moq: string;
  leadTimeDays: string;
  isPreferred: boolean;
  notes: string;
  quote: VendorCatalogQuoteDraft;
  originalQuote: VendorCatalogQuoteSnapshot | null;
};

export interface InventoryRow {
  variant_id: number;
  sku: string;
  variant_name: string;
  hierarchy_level: number;
  units_per_variant: number;
  is_base_unit: boolean;
  level_id: number | null;
  location_id: number | null;
  variant_qty: number | null;
  reserved_qty: number | null;
  picked_qty: number | null;
  packed_qty: number;
  backorder_qty: number;
  level_updated_at: string | null;
  location_code: string | null;
  location_type: string | null;
  zone: string | null;
  is_pickable: number | null;
  warehouse_name: string | null;
}

export interface ChannelStatus {
  channelId: number;
  channelName: string;
  provider: string;
  isListed: boolean;
  listings: Array<{
    variantId: number;
    externalProductId: string | null;
    externalVariantId: string | null;
    syncStatus: string | null;
    syncError: string | null;
    lastSyncedAt: string | null;
  }>;
}

export interface AllocationChannel {
  id: number;
  name: string;
  provider: string;
  status: string;
}

export interface AllocationVariant {
  id: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
  atpUnits: number;
}

export interface ProductAllocation {
  id: number;
  channelId: number;
  productId: number;
  minAtpBase: number | null;
  maxAtpBase: number | null;
  isListed: number;
}

export interface VariantReservation {
  id: number;
  channelId: number;
  productVariantId: number;
  minStockBase: number | null;
  maxStockBase: number | null;
}

export interface FeedData {
  id: number;
  channelId: number;
  productVariantId: number;
  lastSyncedQty: number;
  lastSyncedAt: string | null;
  isActive: number;
}

export interface AllocationData {
  channels: AllocationChannel[];
  variants: AllocationVariant[];
  atpBase: number;
  productAllocations: ProductAllocation[];
  variantReservations: VariantReservation[];
  feeds: FeedData[];
}

export interface TransferTargetVariant {
  id: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
}

export interface ProductArchiveDependencies {
  blocked: boolean;
  dependencies: {
    inventory: {
      totalQty: number;
      bins: number;
      hasReserved: boolean;
      variants: {
        variantId: number;
        sku: string | null;
        totalQty: number;
        bins: number;
        reservedQty: number;
      }[];
      inventoryDetails: {
        variantId: number;
        sku: string | null;
        warehouseLocationId: number;
        locationCode: string;
        variantQty: number;
        reservedQty: number;
      }[];
    };
    shipments: { pending: number };
    channelFeeds: {
      active: number;
      details?: {
        channelName: string;
        provider: string;
        channelSku: string | null;
        variantSku: string | null;
      }[];
    };
    variants: { total: number; active: number };
  };
}

export interface VariantArchiveDependencies {
  blocked: boolean;
  dependencies: {
    inventory: {
      totalQty: number;
      bins: number;
      hasReserved: boolean;
      inventoryDetails: {
        warehouseLocationId: number;
        locationCode: string;
        variantQty: number;
        reservedQty: number;
      }[];
    };
    shipments: { pending: number };
    channelFeeds: {
      active: number;
      details?: {
        channelName: string;
        provider: string;
        channelSku: string | null;
      }[];
    };
  };
}

export function getVariantUomType(
  variant: Pick<ProductVariantRow, "uomType" | "hierarchyLevel" | "unitsPerVariant" | "isBaseUnit" | "parentVariantId">,
): VariantUomType {
  return variant.uomType ?? inferLegacyVariantUomType(variant);
}

export function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function safeInternalPath(path: string | null): string | null {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return null;
  return path;
}

export function createEmptySupplierMappingForm(): SupplierMappingForm {
  return {
    vendorId: 0,
    vendorSku: "",
    packSize: "1",
    moq: "1",
    leadTimeDays: "",
    isPreferred: false,
    notes: "",
    quote: createNewVendorCatalogQuoteDraft(),
    originalQuote: null,
  };
}

export const PG_INTEGER_MAX = 2_147_483_647;

export function parseSupplierOperationalInteger(
  value: string,
  label: string,
  minimum: number,
  required: boolean,
): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new Error(`${label} is required.`);
    return null;
  }
  if (!/^\d+$/.test(trimmed)) throw new Error(`${label} must be a whole number.`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > PG_INTEGER_MAX) {
    throw new Error(
      `${label} must be between ${minimum.toLocaleString("en-US")} and ${PG_INTEGER_MAX.toLocaleString("en-US")}.`,
    );
  }
  return parsed;
}

export function supplierOperationalValues(form: SupplierMappingForm) {
  return {
    packSize: parseSupplierOperationalInteger(form.packSize, "Operational pack", 1, true)!,
    moq: parseSupplierOperationalInteger(form.moq, "MOQ", 1, true)!,
    leadTimeDays: parseSupplierOperationalInteger(form.leadTimeDays, "Lead time", 0, false),
  };
}

export function supplierMappingSaveError(form: SupplierMappingForm): string | null {
  if (!(form.quote.state === "review_required" && form.originalQuote)) {
    const quoteError = evaluateVendorCatalogQuoteDraft(form.quote).error;
    if (quoteError) return quoteError;
  }
  try {
    supplierOperationalValues(form);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Enter valid supplier catalog values.";
  }
}

export async function supplierMappingError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null);
  return new Error(body?.message || body?.error || fallback);
}

export const GRAMS_PER_POUND = 453.59237;
export const MILLIMETERS_PER_INCH = 25.4;
// Derived from the constants above — do not introduce new base constants.
export const GRAMS_PER_OUNCE = GRAMS_PER_POUND / 16;
export const CUBIC_CM_PER_CUBIC_INCH = Math.pow(MILLIMETERS_PER_INCH / 10, 3);

export function emptyVariantPackageInput(): VariantPackageInput {
  return {
    weightLb: "",
    lengthIn: "",
    widthIn: "",
    heightIn: "",
  };
}

export function formatMeasurementInput(value: number | null | undefined, divisor: number): string {
  if (value === null || value === undefined) return "";
  return (value / divisor).toFixed(3).replace(/\.?0+$/, "");
}

export function variantPackageInputFromVariant(variant: ProductVariantRow): VariantPackageInput {
  return {
    weightLb: formatMeasurementInput(variant.weightGrams, GRAMS_PER_POUND),
    lengthIn: formatMeasurementInput(variant.lengthMm, MILLIMETERS_PER_INCH),
    widthIn: formatMeasurementInput(variant.widthMm, MILLIMETERS_PER_INCH),
    heightIn: formatMeasurementInput(variant.heightMm, MILLIMETERS_PER_INCH),
  };
}

export function parsePositiveMeasurement(rawValue: string, label: string): number | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return parsed;
}

/**
 * Convert a display-unit measurement to stored units (grams / millimeters).
 * Storage is numeric(10,2) (migration 185), so round to 2 decimals — NOT to
 * whole units. Rounding to whole mm was the round-trip bug: 6in → 152.4mm →
 * truncated to 152 → redisplayed as 5.984in. With 2-decimal storage, 6in →
 * 152.40mm → displays as exactly 6in.
 */
export function toStoredMeasurement(rawValue: string, label: string, multiplier: number): number | null {
  const parsed = parsePositiveMeasurement(rawValue, label);
  if (parsed === null) return null;

  const storedValue = Math.round(parsed * multiplier * 100) / 100;
  if (!Number.isFinite(storedValue) || storedValue <= 0) {
    throw new Error(`${label} is too small to store.`);
  }
  return storedValue;
}

/**
 * Integer-storage variant for rider/void columns (variant_shipping_attrs is
 * still integer — out of scope for the numeric(10,2) conversion).
 */
export function toStoredIntegerMeasurement(rawValue: string, label: string, multiplier: number): number | null {
  const parsed = parsePositiveMeasurement(rawValue, label);
  if (parsed === null) return null;

  const storedValue = Math.round(parsed * multiplier);
  if (!Number.isInteger(storedValue) || storedValue <= 0) {
    throw new Error(`${label} is too small to store.`);
  }
  return storedValue;
}

export function buildVariantPackagePayload(
  input: VariantPackageInput,
  blankMode: "null" | "omit",
): VariantPackagePayload {
  const payload: VariantPackagePayload = {};
  const fields: Array<{ key: VariantPackageAttributeKey; value: string; label: string; multiplier: number }> = [
    { key: "weightGrams", value: input.weightLb, label: "Package weight", multiplier: GRAMS_PER_POUND },
    { key: "lengthMm", value: input.lengthIn, label: "Package length", multiplier: MILLIMETERS_PER_INCH },
    { key: "widthMm", value: input.widthIn, label: "Package width", multiplier: MILLIMETERS_PER_INCH },
    { key: "heightMm", value: input.heightIn, label: "Package height", multiplier: MILLIMETERS_PER_INCH },
  ];

  for (const field of fields) {
    const trimmed = field.value.trim();
    if (!trimmed && blankMode === "omit") continue;
    payload[field.key] = toStoredMeasurement(trimmed, field.label, field.multiplier);
  }

  return payload;
}

export function buildVariantPackingFlagsPayload(input: {
  shipsInOwnContainer: boolean;
  maxUnitsPerPackage: string;
}): { shipsInOwnContainer: boolean; maxUnitsPerPackage: number | null } {
  const trimmed = input.maxUnitsPerPackage.trim();
  let maxUnitsPerPackage: number | null = null;
  if (trimmed) {
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("Max units per package must be a positive whole number.");
    }
    maxUnitsPerPackage = parsed;
  }
  return {
    shipsInOwnContainer: input.shipsInOwnContainer,
    maxUnitsPerPackage,
  };
}

export function buildVariantPackageDisplay(variant: ProductVariantRow) {
  const weight = formatMeasurementInput(variant.weightGrams, GRAMS_PER_POUND);
  const length = formatMeasurementInput(variant.lengthMm, MILLIMETERS_PER_INCH);
  const width = formatMeasurementInput(variant.widthMm, MILLIMETERS_PER_INCH);
  const height = formatMeasurementInput(variant.heightMm, MILLIMETERS_PER_INCH);

  if (!variant.weightGrams) {
    return {
      label: "Missing weight",
      detail: "Required for marketplace listing package data",
      className: "bg-red-50 text-red-700 border-red-300",
    };
  }

  if (!variant.lengthMm || !variant.widthMm || !variant.heightMm) {
    return {
      label: "Dims missing",
      detail: `${weight} lb · add L x W x H`,
      className: "bg-yellow-50 text-yellow-700 border-yellow-300",
    };
  }

  return {
    label: "Ready",
    detail: `${weight} lb · ${length} x ${width} x ${height} in`,
    className: "bg-green-50 text-green-700 border-green-300",
  };
}
