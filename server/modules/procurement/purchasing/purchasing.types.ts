import type { CommandAuthorityActor, PurchaseApprovalActor } from "../../identity";
import type { ProcurementSettingsSnapshot } from "@shared/procurement/procurement-settings";
import type { PoLineType, PoPhysicalStatus } from "@shared/schema/procurement.schema";
import type { PoLinePricingInput } from "@shared/utils/po-line-pricing";
import type { PurchaseOrderEntryTransaction } from "../purchase-order-entry.repository";
import type { RfqAllocationOverrideEvidence } from "../purchasing-rfq-allocation";

export const PG_INTEGER_MAX = 2_147_483_647;
export const MAX_INLINE_PO_LINES = 2_000;
export const MAX_BULK_CATALOG_ENTRIES = 2_000;
export const MAX_QUOTE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const PO_NUMBER_ALLOCATION_ATTEMPTS = 5;
export const ACCEPTABLE_PO_MATCH_VARIANCE_STATUSES = new Set([
  "price_discrepancy",
  "qty_discrepancy",
  "over_billed",
]);

export function requireUsdPurchaseOrderCurrency(value: unknown): string {
  const currency = String(value ?? "USD").trim().toUpperCase();
  if (currency !== "USD") {
    throw new PurchasingError(
      "Non-USD purchase orders require an explicit foreign-exchange rate authority",
      422,
      {
        code: "PO_FX_RATE_REQUIRED",
        currency,
        reportingCurrency: "USD",
      },
    );
  }
  return "USD";
}
export const PO_NUMBER_UNIQUE_CONSTRAINTS = new Set([
  "purchase_orders_po_number_active_uidx",
  "purchase_orders_po_number_unique",
  "purchase_orders_po_number_key",
]);

export function isPoNumberUniqueViolation(error: any): boolean {
  const databaseError = error?.code === "23505"
    ? error
    : error?.cause?.code === "23505"
      ? error.cause
      : null;
  if (!databaseError) return false;
  if (PO_NUMBER_UNIQUE_CONSTRAINTS.has(String(databaseError.constraint ?? ""))) return true;

  // node-postgres always includes the violated constraint for a real unique
  // violation. Keep the detail/message fallback for wrapped database clients
  // that discard that field, but never retry an unrelated unique failure.
  const diagnostic = `${databaseError.detail ?? ""} ${databaseError.message ?? ""}`.toLowerCase();
  return diagnostic.includes("po_number") || diagnostic.includes("po number");
}

export function isValidIsoDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export interface Storage {
  // Purchase Orders
  getPurchaseOrders(filters?: { status?: string | string[]; physicalStatus?: string | string[]; financialStatus?: string | string[]; vendorId?: number; search?: string; limit?: number; offset?: number }): Promise<any[]>;
  getPurchaseOrdersCount(filters?: { status?: string | string[]; physicalStatus?: string | string[]; financialStatus?: string | string[]; vendorId?: number; search?: string }): Promise<number>;
  getPurchaseOrderById(id: number, executor?: any): Promise<any>;
  getPurchaseOrderByPoNumber(poNumber: string): Promise<any>;
  createPurchaseOrder(data: any, historyData?: any, executor?: any): Promise<any>;
  updatePurchaseOrder(id: number, updates: any, executor?: any): Promise<any>;
  updatePurchaseOrderStatusWithHistory(id: number, updates: any, historyData: any, executor?: any): Promise<any>;
  deletePurchaseOrder(id: number, executor?: any): Promise<boolean>;
  getRecommendationPoHandoffForPo(purchaseOrderId: number): Promise<any | undefined>;
  generatePoNumber(executor: any, recordedAt?: Date): Promise<string>;

  // PO Lines
  getPurchaseOrderLines(purchaseOrderId: number, executor?: any): Promise<any[]>;
  getPurchaseOrderLineById(id: number, executor?: any): Promise<any>;
  createPurchaseOrderLine(data: any): Promise<any>;
  bulkCreatePurchaseOrderLines(lines: any[]): Promise<any[]>;
  updatePurchaseOrderLine(id: number, updates: any, executor?: any): Promise<any>;
  deletePurchaseOrderLine(id: number): Promise<boolean>;
  getRecommendationPoHandoffForLine(purchaseOrderLineId: number): Promise<any | undefined>;
  getOpenPoLinesForVariant(productVariantId: number): Promise<any[]>;

  // PO Status History
  createPoStatusHistory(data: any): Promise<any>;
  getPoStatusHistory(purchaseOrderId: number): Promise<any[]>;

  // PO Revisions
  createPoRevision(data: any): Promise<any>;
  getPoRevisions(purchaseOrderId: number): Promise<any[]>;

  // PO Receipts
  createPoReceipt(data: any): Promise<any>;
  getPoReceipts(purchaseOrderId: number): Promise<any[]>;
  getPoReceiptsByLine?(purchaseOrderLineId: number): Promise<any[]>;
  reconcilePoReceiptLine(input: {
    purchaseOrderLineId: number;
    receivingLineId: number;
    lineUpdates: Record<string, unknown>;
    receipt: Record<string, unknown>;
  }, executor?: any): Promise<{ applied: boolean; receipt?: any; purchaseOrderLine?: any }>;

  // Approval Tiers
  getAllPoApprovalTiers(): Promise<any[]>;
  getPoApprovalTierById(id: number): Promise<any>;
  getMatchingApprovalTier(totalCents: number): Promise<any>;

  // Vendor Products
  getVendorProducts(filters?: any, executor?: any): Promise<any[]>;
  getVendorProductById(id: number, executor?: any): Promise<any>;
  getPreferredVendorProduct(productId: number, productVariantId?: number): Promise<any>;

  // Vendors
  getVendorById(id: number, executor?: any): Promise<any>;

  // Products
  getProductVariantById(id: number, executor?: any): Promise<any>;
  getProductVariantsByProductId?(productId: number, executor?: any): Promise<any[]>;
  getProductById(id: number, executor?: any): Promise<any>;

  // Receiving
  createReceivingOrder(data: any, executor?: any): Promise<any>;
  getReceivingOrdersForPurchaseOrder?(purchaseOrderId: number, executor?: any): Promise<any[]>;
  getReceivingLines?(receivingOrderId: number, executor?: any): Promise<any[]>;
  deleteReceivingOrder?(id: number, executor?: any): Promise<boolean>;
  generateReceiptNumber(executor: any, recordedAt?: Date): Promise<string>;
  bulkCreateReceivingLines(lines: any[], executor?: any): Promise<any[]>;
  getReceivingLineById(id: number, executor?: any): Promise<any>;
  getReceivingOrderById(id: number, executor?: any): Promise<any>;

  // Inbound shipments
  getInboundShipmentById(id: number, executor?: any): Promise<any>;
  getInboundShipmentLines(inboundShipmentId: number, executor?: any): Promise<any[]>;
  getInboundShipmentLinesByPo(purchaseOrderId: number): Promise<any[]>;

  // Settings
  getSetting(key: string): Promise<string | null>;
}

export class PurchasingError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public details?: any,
  ) {
    super(message);
    this.name = "PurchasingError";
  }
}

export type PurchaseOrderLineInput = {
  lineId?: number;
  clientId?: string;
  lineType?: PoLineType;
  parentClientId?: string | null;
  description?: string | null;
  productId?: number | null;
  productVariantId?: number | null;
  expectedReceiveVariantId?: number | null;
  expectedReceiveUnitsPerVariant?: number | null;
  orderQty: number;
  unitCostCents?: number;
  unitCostMills?: number;
  totalProductCostCents?: number;
  packagingCostCents?: number;
  vendorProductId?: number | null;
  vendorSku?: string | null;
  notes?: string | null;
  pricing?: PoLinePricingInput;
  pricingSource?: "legacy" | "manual" | "vendor_catalog" | "recommendation";
  quoteReference?: string | null;
  quotedAt?: Date | null;
  quoteValidUntil?: string | null;
  catalogWrite?: {
    mode: "upsert";
    setPreferred?: boolean;
  };
};

export type CreatePurchaseOrderWithLinesInput = {
  vendorId: number;
  warehouseId?: number | null;
  poType?: string;
  priority?: string;
  expectedDeliveryDate?: Date | null;
  incoterms?: string | null;
  vendorNotes?: string | null;
  internalNotes?: string | null;
  lines: PurchaseOrderLineInput[];
};

export type UpdateDraftPurchaseOrderWithLinesInput =
  CreatePurchaseOrderWithLinesInput & {
    expectedUpdatedAt: Date;
  };

export type CreatePurchaseOrderInternalOptions = {
  // Internal financial owners reuse their existing transaction. Nested Drizzle
  // transactions are savepoints, so a PO-number conflict can retry atomically.
  transaction?: PurchaseOrderEntryTransaction;
  source?: "inline_editor" | "rfq_quote";
  additionalEvent?: {
    eventType: string;
    payload: Record<string, unknown>;
  };
};

export const EDITABLE_STATUSES = new Set(["draft"]);
// Broader set for amending existing lines (cost corrections, qty adjustments) — any non-terminal state
export const LINE_AMENDABLE_STATUSES = new Set(["draft", "pending_approval", "approved", "sent", "acknowledged", "partially_received"]);
export const CANCELLABLE_FROM = new Set(["draft", "pending_approval", "approved"]);
export const VOIDABLE_FROM = new Set(["sent", "acknowledged"]);
export const ACTIVE_RECEIPT_STATUSES = new Set(["draft", "open", "receiving", "verified"]);
export const TERMINAL_DELIVERY_SCHEDULE_STATUSES = new Set(["received", "closed", "cancelled", "short_closed"]);
export const PHYSICAL_LIFECYCLE_EVENTS: Partial<Record<PoPhysicalStatus, string>> = {
  sent: "sent_to_vendor",
  acknowledged: "vendor_acknowledged",
  shipped: "marked_shipped",
  in_transit: "marked_in_transit",
  arrived: "marked_arrived",
  receiving: "receiving_started",
  received: "received",
  short_closed: "closed_short",
  cancelled: "cancelled",
};

export type PoLifecycleCommandInput = {
  confirmedSentExternally?: unknown;
  expectedUpdatedAt?: unknown;
  expectedTotalCents?: unknown;
  expectedLinesFingerprint?: unknown;
  notes?: string;
  reason?: string;
  vendorRefNumber?: string;
  confirmedDeliveryDate?: Date;
};

// Signed mills <-> cents helpers for the typed-PO-lines pipeline.
//
// The shared millsToCents/centsToMills helpers reject negatives by design
// (main money path is always non-negative). Discount/rebate/adjustment
// lines have legitimately signed costs, so we wrap via absolute value +
// re-apply sign. Math still all integer; Rule #3 preserved.
//
// Keeping these local to the service instead of loosening the shared
// helper preserves the guard for everywhere else that consumes money.
export function signedMillsToCents(mills: number): number {
  if (!Number.isInteger(mills)) {
    throw new RangeError("signedMillsToCents requires an integer");
  }
  const sign = mills < 0 ? -1 : 1;
  const abs = Math.abs(mills);
  // Half-up toward +infinity for the absolute value; sign reapplied below.
  const cents = Math.floor((abs + 50) / 100);
  return sign * cents;
}

export function signedCentsToMills(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new RangeError("signedCentsToMills requires an integer");
  }
  return cents * 100;
}

export type PurchasingServiceOptions = {
  now?: () => Date;
  readApprovalActor?: (tx: any, userId: string) => Promise<PurchaseApprovalActor>;
  readCommandActor?: (tx: any, userId: string) => Promise<CommandAuthorityActor>;
  reconcileApprovedInvoiceCost?: (
    purchaseOrderLineId: number,
    tx: any,
    actorId?: string,
  ) => Promise<unknown>;
};

export interface PurchasingBaseContext {
  db: any;
  storage: Storage;
  now: () => Date;
  readApprovalActor: (tx: any, userId: string) => Promise<PurchaseApprovalActor>;
  readCommandActor: (tx: any, userId: string) => Promise<CommandAuthorityActor>;
  reconcileApprovedInvoiceCost?: (
    purchaseOrderLineId: number,
    tx: any,
    actorId?: string,
  ) => Promise<unknown>;
  lockInventoryCostGraph: (tx: any) => Promise<unknown>;
  resolveActor: (userId: string | null | undefined) => {
    actorType: "user" | "system";
    actorId: string;
  };
  emitPoEvent: (
    poId: number,
    eventType: string,
    userId: string | null | undefined,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
  emitPoEventTx: (
    tx: any,
    poId: number,
    eventType: string,
    userId: string | null | undefined,
    payload?: Record<string, unknown>,
    at?: Date,
  ) => Promise<void>;
  getProcurementSettings: () => Promise<ProcurementSettingsSnapshot>;
  getProcurementSettingsTx: (tx: any, lock?: boolean) => Promise<ProcurementSettingsSnapshot>;
}

export type PoTotalsBreakdown = {
  productSubtotalCents: number;
  discountTotalCents: number;
  feeTotalCents: number;
  taxTotalCents: number;
  adjustmentTotalCents: number;
  totalCents: number;
};

export type AllocatedLineCost = {
  purchaseOrderLineId: number;
  lineTotalCents: number;          // raw, before allocation
  allocatedCents: number;           // signed; can be negative for net-discount
  landedLineTotalCents: number;     // lineTotalCents + allocatedCents
  landedUnitCostMills: number;      // for stamping inventory lots
  landedUnitCostCents: number;      // back-compat, derived from mills
};

export type AllocationResult = {
  perLine: AllocatedLineCost[];
  pooledCents: number;              // total non-product cents allocated
  productSubtotalCents: number;     // sum of product line basis
  // Non-zero only when productSubtotalCents == 0 and pooledCents != 0,
  // i.e. fees/discounts exist with no product line to absorb them.
  unallocatedCents: number;
};

export type LifecycleExpectation = {
  status: string;
  updatedAtMs: number | null;
};

export type LockedLifecycleEconomics = {
  po: any;
  lines: any[];
  subtotalCents: number;
  totalCents: number;
  lineCount: number;
  receivedLineCount: number;
  newestLineUpdatedAtMs: number | null;
  correctedLegacyEconomics: boolean;
};

export type LifecycleQuoteClock = {
  evaluatedAt: Date;
  currentDate: string;
};

export type LockedSendResult = {
  po: any;
  status: "pending_approval" | "approved" | "sent";
  pendingApproval: boolean;
};

export type SendPurchaseOrderResult = {
  po: any;
  status: "pending_approval" | "approved";
  pdf: null;
  pendingApproval: boolean;
  dispatchRecorded: false;
};

export function bulkCatalogKey(productId: number, productVariantId: number | null): string {
  return `${productId}:${productVariantId ?? 0}`;
}

export function assertPositivePgInteger(value: unknown, field: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > PG_INTEGER_MAX
  ) {
    throw new PurchasingError(`${field} must be a positive PostgreSQL integer`, 400);
  }
}

export function assertNonnegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PurchasingError(`${field} must be a non-negative safe integer`, 400);
  }
}

export function assertOptionalCatalogText(
  value: unknown,
  field: string,
  maximumLength: number,
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new PurchasingError(
      `${field} must be a string of at most ${maximumLength} characters or null`,
      400,
    );
  }
}

export function rethrowVendorCatalogWriteError(error: any): never {
  if (
    error?.code === "23505" &&
    error?.constraint === "vendor_products_one_active_preferred_key_uidx"
  ) {
    throw new PurchasingError(
      "Another active preferred vendor mapping already exists for this product/configuration",
      409,
      { code: "VENDOR_CATALOG_PREFERRED_CONFLICT" },
    );
  }
  if (
    error?.code === "23505" &&
    (
      error?.constraint === "vendor_products_vendor_product_variant_key_uidx" ||
      error?.constraint === "vendor_products_vendor_product_variant_idx"
    )
  ) {
    throw new PurchasingError("Vendor catalog mapping already exists or changed concurrently", 409, {
      code: "VENDOR_CATALOG_MAPPING_CONFLICT",
    });
  }
  throw error;
}

export type BulkCatalogEntry = {
  productId: number;
  productVariantId?: number | null;
  // Per-unit cost. Either or both may be provided:
  //   * unitCostMills is authoritative (4-decimal precision).
  //   * unitCostCents is accepted for legacy/back-compat callers.
  // If both are provided they must agree (cents == millsToCents(mills)).
  unitCostCents?: number | null;
  unitCostMills?: number | null;
  pricing?: PoLinePricingInput;
  quoteReference?: string | null;
  quotedAt?: Date | null;
  quoteValidUntil?: string | null;
  packSize?: number | null;
  moq?: number | null;
  leadTimeDays?: number | null;
  vendorSku?: string | null;
  vendorProductName?: string | null;
  isPreferred?: boolean;
};

export type BulkCatalogResult = {
  created: Array<{
    vendorProductId: number;
    productId: number;
    productVariantId: number | null;
  }>;
  updated: Array<{
    vendorProductId: number;
    productId: number;
    productVariantId: number | null;
  }>;
  skipped: Array<{
    productId: number;
    productVariantId: number | null;
    reason: string;
  }>;
};

export type CatalogWritablePoLine = Pick<
  PurchaseOrderLineInput,
  | "productId"
  | "expectedReceiveVariantId"
  | "productVariantId"
  | "vendorProductId"
  | "vendorSku"
  | "pricing"
  | "quoteReference"
  | "quotedAt"
  | "quoteValidUntil"
  | "catalogWrite"
>;

export type CreateRfqBatchLineInput = {
  recommendationLineId: number;
  vendorId: number;
  vendorProductId?: number;
  vendorSku?: string | null;
  requestedPieces: number;
  quantityOverrideReason?: string | null;
  allocationOverrideApproved?: boolean;
};

export type PreparedRfqBatchLineInput = CreateRfqBatchLineInput & RfqAllocationOverrideEvidence & {
  recommendedPieces: number;
  alreadyAllocatedPieces: number;
};

export type PreloadLine = {
  productId: number;
  productVariantId: number | null;
  expectedReceiveVariantId: number | null;
  expectedReceiveUnitsPerVariant: number;
  productName: string;
  sku: string | null;
  variantDescription: string | null;
  uomLabel: string | null;
  suggestedQty: number;
  // Per-unit cost is returned in BOTH units so the editor can use mills
  // directly while legacy readers can continue consuming cents.
  unitCostCents: number;
  unitCostMills: number;
  catalogSource: "vendor_catalog" | "product_default" | "duplicate" | "manual";
  vendorProductId: number | null;
  pricingBasis: "legacy_unknown" | "per_piece" | "per_purchase_uom";
  purchaseUom: string | null;
  quotedUnitCostMills: number | null;
  piecesPerPurchaseUom: number | null;
  quoteReference: string | null;
  quotedAt: Date | null;
  quoteValidUntil: string | null;
};

export function signedRoundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === BigInt(0)) return BigInt(0);
  const sign = (numerator < BigInt(0)) !== (denominator < BigInt(0)) ? -1 : 1;
  const absNum = numerator < BigInt(0) ? -numerator : numerator;
  const absDen = denominator < BigInt(0) ? -denominator : denominator;
  const halfDen = absDen / BigInt(2);
  const rounded = (absNum + halfDen) / absDen;
  return sign === -1 ? -rounded : rounded;
}

export function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function safeIntegerMoney(value: bigint, field: string): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const min = BigInt(Number.MIN_SAFE_INTEGER);
  if (value > max || value < min) {
    throw new PurchasingError(`${field} exceeds the supported integer range`, 400, {
      code: "PO_MONEY_OUT_OF_RANGE",
      field,
    });
  }
  return Number(value);
}

export function storedMoneyAsBigInt(value: unknown, field: string): bigint {
  const numeric = value === null || value === undefined ? 0 : Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new PurchasingError(`Stored ${field} is not a safe integer`, 409, {
      code: "PO_STORED_MONEY_INVALID",
      field,
      value,
    });
  }
  return BigInt(numeric);
}

export function auditDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
