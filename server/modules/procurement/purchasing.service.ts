/**
 * Purchasing service for Echelon WMS.
 *
 * Handles the full PO lifecycle:
 * - PO number generation, CRUD, line management, totals
 * - State machine: draft → pending_approval → approved → sent → acknowledged
 *   → partially_received → received → closed (+ cancelled/void)
 * - Multi-level approval tier checking
 * - Revision tracking for post-send amendments
 * - Receipt-from-PO creation (links to ReceivingService)
 * - Reorder-to-PO generation
 */

import { randomUUID } from "node:crypto";
import { eq, and, sql, inArray, ne, lte, desc, getTableColumns } from "drizzle-orm";
import {
  inboundShipmentLines,
  landedCostSnapshots,
  vendorInvoiceLines,
  vendorInvoices as vendorInvoicesTable,
  vendorInvoicePoLinks as vendorInvoicePoLinksTable,
  apPayments as apPaymentsTable,
  apPaymentAllocations as apPaymentAllocationsTable,
  purchaseOrders as purchaseOrdersTable,
  purchaseOrderLines as purchaseOrderLinesTable,
  poApprovalTiers as poApprovalTiersTable,
  poStatusHistory as poStatusHistoryTable,
  poEvents as poEventsTable,
  purchasingRecommendationPoHandoffs as purchasingRecommendationPoHandoffsTable,
  auditEvents as auditEventsTable,
  products as productsTable,
  productVariants as productVariantsTable,
  vendors as vendorsTable,
  vendorProducts as vendorProductsTable,
  purchaseRecommendationLines as purchaseRecommendationLinesTable,
  requestForQuotes as requestForQuotesTable,
  requestForQuoteLines as requestForQuoteLinesTable,
  warehouseSettings as warehouseSettingsTable,
} from "@shared/schema";
import type { PoLineType, PoPhysicalStatus, PoFinancialStatus } from "@shared/schema/procurement.schema";
import {
  PO_LINE_TYPES,
  isPoLineType,
  poPriorityEnum,
  poTypeEnum,
} from "@shared/schema/procurement.schema";
import { Decimal } from "decimal.js";
import {
  centsToMills,
  millsToCents,
} from "@shared/utils/money";
import {
  normalizePoLinePricing,
  type NormalizedPoLinePricing,
  type PoLinePricingInput,
} from "@shared/utils/po-line-pricing";
import {
  detectQtyVariance,
  detectPastDue,
  detectMatchMismatch,
} from "./po-exceptions.service";
import {
  PoLifecycleError,
  buildFinancialTransitionChange,
  buildPhysicalTransitionChange,
  getAllowedLegacyTransitions,
  type PoLifecycleCommand,
} from "./purchase-order-lifecycle.service";
import {
  buildPoCloseChange,
  buildPoCloseShortChange,
  buildPoCloseShortLinePatch,
} from "./purchase-order-close.service";
import {
  findOpenPoLineByProduct as findOpenPoLineByProductWithStorage,
  reconcilePurchaseOrderReceipt,
  type ReceivingReconciliationLine,
} from "./purchase-order-receipt-reconciliation.service";
import {
  lockAndLoadActiveRfqAllocations,
  purchasingSkuAllocationKey,
} from "./purchasing-rfq.service";
import {
  deliveryDateIso,
  sameDeliveryDate,
  validateDeliverySchedulePatch,
  type DeliverySchedulePatch,
} from "./purchase-order-delivery-schedule";
import {
  buildPurchaseOrderDraftHeaderChange,
  purchaseOrderDraftHeaderPatchSchema,
} from "./purchase-order-draft-header";
import {
  createPurchaseOrderLineCommands,
  PurchaseOrderLineCommandError,
  vendorCatalogPricingMatches,
  vendorCatalogQuoteUsability,
} from "./purchase-order-line-commands";
import { assessSupplierQuoteValidity } from "./supplier-quote-validity";
import {
  createPurchaseRecommendationSnapshotService,
  type CreatePurchaseRecommendationRunInput,
} from "./purchase-recommendation-snapshot.service";
import type { FinancialCommandDescriptor } from "../../platform/commands/transactional-command.service";

const PG_INTEGER_MAX = 2_147_483_647;
const MAX_INLINE_PO_LINES = 2_000;
const MAX_BULK_CATALOG_ENTRIES = 2_000;
const MAX_QUOTE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const PO_NUMBER_ALLOCATION_ATTEMPTS = 5;
const PO_NUMBER_UNIQUE_CONSTRAINTS = new Set([
  "purchase_orders_po_number_active_uidx",
  "purchase_orders_po_number_unique",
  "purchase_orders_po_number_key",
]);

function isPoNumberUniqueViolation(error: any): boolean {
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

function isValidIsoDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// ── Minimal dependency interfaces ───────────────────────────────────

interface Storage {
  // Purchase Orders
  getPurchaseOrders(filters?: { status?: string | string[]; physicalStatus?: string | string[]; financialStatus?: string | string[]; vendorId?: number; search?: string; limit?: number; offset?: number }): Promise<any[]>;
  getPurchaseOrdersCount(filters?: { status?: string | string[]; physicalStatus?: string | string[]; financialStatus?: string | string[]; vendorId?: number; search?: string }): Promise<number>;
  getPurchaseOrderById(id: number): Promise<any>;
  getPurchaseOrderByPoNumber(poNumber: string): Promise<any>;
  createPurchaseOrder(data: any, historyData?: any): Promise<any>;
  updatePurchaseOrder(id: number, updates: any, historyData?: any): Promise<any>;
  updatePurchaseOrderStatusWithHistory(id: number, updates: any, historyData?: any): Promise<any>;
  deletePurchaseOrder(id: number): Promise<boolean>;
  getRecommendationPoHandoffForPo(purchaseOrderId: number): Promise<any | undefined>;
  generatePoNumber(): Promise<string>;

  // PO Lines
  getPurchaseOrderLines(purchaseOrderId: number): Promise<any[]>;
  getPurchaseOrderLineById(id: number): Promise<any>;
  createPurchaseOrderLine(data: any): Promise<any>;
  bulkCreatePurchaseOrderLines(lines: any[]): Promise<any[]>;
  updatePurchaseOrderLine(id: number, updates: any): Promise<any>;
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
  }): Promise<{ applied: boolean; receipt?: any; purchaseOrderLine?: any }>;

  // Approval Tiers
  getAllPoApprovalTiers(): Promise<any[]>;
  getPoApprovalTierById(id: number): Promise<any>;
  getMatchingApprovalTier(totalCents: number): Promise<any>;

  // Vendor Products
  getVendorProducts(filters?: any): Promise<any[]>;
  getVendorProductById(id: number): Promise<any>;
  getPreferredVendorProduct(productId: number, productVariantId?: number): Promise<any>;

  // Vendors
  getVendorById(id: number): Promise<any>;

  // Products
  getProductVariantById(id: number): Promise<any>;
  getProductVariantsByProductId?(productId: number): Promise<any[]>;
  getProductById(id: number): Promise<any>;

  // Receiving
  createReceivingOrder(data: any): Promise<any>;
  getReceivingOrdersForPurchaseOrder?(purchaseOrderId: number): Promise<any[]>;
  getReceivingLines?(receivingOrderId: number): Promise<any[]>;
  deleteReceivingOrder?(id: number): Promise<boolean>;
  generateReceiptNumber(): Promise<string>;
  bulkCreateReceivingLines(lines: any[]): Promise<any[]>;
  getReceivingLineById(id: number): Promise<any>;
  getReceivingOrderById(id: number): Promise<any>;

  // Inbound shipments
  getInboundShipmentById(id: number): Promise<any>;
  getInboundShipmentLines(inboundShipmentId: number): Promise<any[]>;
  getInboundShipmentLinesByPo(purchaseOrderId: number): Promise<any[]>;

  // Settings
  getSetting(key: string): Promise<string | null>;
}

// ── Error class ─────────────────────────────────────────────────────

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

type CreatePurchaseOrderInternalOptions = {
  additionalEvent?: {
    eventType: string;
    payload: Record<string, unknown>;
  };
};

const EDITABLE_STATUSES = new Set(["draft"]);
// Broader set for amending existing lines (cost corrections, qty adjustments) — any non-terminal state
const LINE_AMENDABLE_STATUSES = new Set(["draft", "pending_approval", "approved", "sent", "acknowledged", "partially_received"]);
const CANCELLABLE_FROM = new Set(["draft", "pending_approval", "approved"]);
const VOIDABLE_FROM = new Set(["sent", "acknowledged"]);
const RECEIVABLE_SHIPMENT_STATUSES = new Set(["at_port", "customs_clearance", "delivered", "costing", "closed"]);
const ACTIVE_RECEIPT_STATUSES = new Set(["draft", "open", "receiving", "verified"]);
const TERMINAL_DELIVERY_SCHEDULE_STATUSES = new Set(["received", "closed", "cancelled", "short_closed"]);
const PHYSICAL_LIFECYCLE_EVENTS: Partial<Record<PoPhysicalStatus, string>> = {
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

type PoLifecycleCommandInput = {
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
function signedMillsToCents(mills: number): number {
  if (!Number.isInteger(mills)) {
    throw new RangeError("signedMillsToCents requires an integer");
  }
  const sign = mills < 0 ? -1 : 1;
  const abs = Math.abs(mills);
  // Half-up toward +infinity for the absolute value; sign reapplied below.
  const cents = Math.floor((abs + 50) / 100);
  return sign * cents;
}

function signedCentsToMills(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new RangeError("signedCentsToMills requires an integer");
  }
  return cents * 100;
}

// ── Service ─────────────────────────────────────────────────────────

export type PurchasingService = ReturnType<typeof createPurchasingService>;

export function createPurchasingService(
  db: any,
  storage: Storage,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  const lineCommands = createPurchaseOrderLineCommands(db, {
    persistCatalogWrites: async (tx, vendorId, lines, userId) => {
      try {
        return await persistPurchaseOrderCatalogWritesTx(tx, vendorId, lines, userId);
      } catch (error: any) {
        if (error instanceof PurchasingError) {
          throw new PurchaseOrderLineCommandError(
            error.message,
            error.statusCode,
            error.details,
          );
        }
        throw error;
      }
    },
  });

  async function runLineCommand<T>(command: () => Promise<T>): Promise<T> {
    try {
      return await command();
    } catch (error: any) {
      if (error instanceof PurchaseOrderLineCommandError) {
        throw new PurchasingError(error.message, error.statusCode, error.details);
      }
      throw error;
    }
  }

  const hardenedAddLine = (
    purchaseOrderId: number,
    input: unknown,
    userId?: string,
  ) => runLineCommand(() => lineCommands.addLine(purchaseOrderId, input, userId));

  const hardenedAddBulkLines = (
    purchaseOrderId: number,
    input: unknown,
    userId?: string,
  ) => runLineCommand(() => lineCommands.addBulkLines(purchaseOrderId, input, userId));

  const hardenedUpdateLine = (
    lineId: number,
    input: unknown,
    userId?: string,
  ) => runLineCommand(() => lineCommands.updateLine(lineId, input, userId));

  const hardenedCancelLine = (
    lineId: number,
    input: unknown,
    userId?: string,
  ) => runLineCommand(() => lineCommands.cancelLine(lineId, input, userId));

  const hardenedAddLineCommand = (
    purchaseOrderId: number,
    input: unknown,
    userId: string | undefined,
    descriptor: FinancialCommandDescriptor,
  ) => runLineCommand(() => lineCommands.addLineCommand(
    purchaseOrderId,
    input,
    userId,
    descriptor,
  ));

  const hardenedAddBulkLinesCommand = (
    purchaseOrderId: number,
    input: unknown,
    userId: string | undefined,
    descriptor: FinancialCommandDescriptor,
  ) => runLineCommand(() => lineCommands.addBulkLinesCommand(
    purchaseOrderId,
    input,
    userId,
    descriptor,
  ));

  const hardenedUpdateLineCommand = (
    lineId: number,
    input: unknown,
    userId: string | undefined,
    descriptor: FinancialCommandDescriptor,
  ) => runLineCommand(() => lineCommands.updateLineCommand(lineId, input, userId, descriptor));

  const hardenedCancelLineCommand = (
    lineId: number,
    input: unknown,
    userId: string | undefined,
    descriptor: FinancialCommandDescriptor,
  ) => runLineCommand(() => lineCommands.cancelLineCommand(lineId, input, userId, descriptor));

  // ── Helpers ─────────────────────────────────────────────────────

  // calculateLineCosts
  //
  // Unit cost source-of-truth resolution (Spec F Phase 1 — totals-based):
  //
  //   NEW SHAPE (preferred for product lines):
  //     If totalProductCostCents is provided (non-null), it is the source of
  //     truth. Derived fields are computed from it:
  //       lineTotalCents = totalProductCostCents + packagingCostCents
  //       unitCostMills  = round_half_up(totalProductCostCents * 100 / qty)
  //       unitCostCents  = round_half_up(unitCostMills / 100)
  //
  //   OLD SHAPE (backward compat):
  //     If totalProductCostCents is NOT provided, falls back to
  //     unitCostMills (authoritative) or unitCostCents (legacy).
  //     totalProductCostCents is derived: round(unitCostMills * qty / 100).
  //
  //   If BOTH are sent, the new shape (totals) wins.
  //
  // Discount and tax continue to apply at the cent-subtotal level.
  function calculateLineCosts(line: {
    orderQty: number;
    unitCostCents: number;
    unitCostMills?: number | null;
    totalProductCostCents?: number | null;
    packagingCostCents?: number | null;
    discountPercent?: string | number;
    taxRatePercent?: string | number;
  }) {
    const qty = Number(line.orderQty) || 0;
    const hasTotals =
      typeof line.totalProductCostCents === "number" &&
      line.totalProductCostCents !== null;

    let subtotalCents: number;
    let resolvedTotalProductCostCents: number;
    let resolvedPackagingCostCents: number;
    let resolvedUnitCostMills: number;
    let resolvedUnitCostCents: number;

    if (hasTotals) {
      // NEW SHAPE: totals are source of truth.
      resolvedTotalProductCostCents = line.totalProductCostCents as number;
      resolvedPackagingCostCents = Number(line.packagingCostCents) || 0;
      subtotalCents = resolvedTotalProductCostCents + resolvedPackagingCostCents;
      // Normalize the product quote only. Packaging remains its own exact-cent
      // layer and must never be folded into the vendor's per-piece quote.
      resolvedUnitCostMills =
        qty > 0
          ? Number(
              signedRoundHalfUpDiv(
                BigInt(resolvedTotalProductCostCents) * BigInt(100),
                BigInt(qty),
              ),
            )
          : 0;
      resolvedUnitCostCents =
        qty > 0
          ? signedMillsToCents(resolvedUnitCostMills)
          : 0;
    } else {
      // OLD SHAPE: mills or cents as source (backward compat).
      const millsAuthoritative =
        typeof line.unitCostMills === "number" &&
        Number.isInteger(line.unitCostMills);

      subtotalCents = millsAuthoritative
        ? Number(
            signedRoundHalfUpDiv(
              BigInt(line.unitCostMills as number) * BigInt(qty),
              BigInt(100),
            ),
          )
        : qty * (Number(line.unitCostCents) || 0);

      resolvedTotalProductCostCents = subtotalCents;
      resolvedPackagingCostCents = 0;
      resolvedUnitCostMills = millsAuthoritative
        ? (line.unitCostMills as number)
        : signedCentsToMills(Number(line.unitCostCents) || 0);
      resolvedUnitCostCents = millsAuthoritative
        ? signedMillsToCents(line.unitCostMills as number)
        : Number(line.unitCostCents) || 0;
    }

    const subtotal = new Decimal(subtotalCents);
    const discountPct = new Decimal(line.discountPercent || 0);
    const discount = subtotal.times(discountPct).dividedBy(100).round();
    const taxable = subtotal.minus(discount);
    const taxPct = new Decimal(line.taxRatePercent || 0);
    const tax = taxable.times(taxPct).dividedBy(100).round();

    return {
      subtotalCents: subtotal.toNumber(),
      discountCents: discount.toNumber(),
      taxCents: tax.toNumber(),
      lineTotalCents: taxable.plus(tax).toNumber(),
      // Totals-based fields (Spec F Phase 1)
      totalProductCostCents: resolvedTotalProductCostCents,
      packagingCostCents: resolvedPackagingCostCents,
      unitCostMills: resolvedUnitCostMills,
      unitCostCents: resolvedUnitCostCents,
    };
  }

  // Totals breakdown by line type. Pure function — takes a list of lines
  // and returns the net totals in cents. The math is sign-aware via
  // line_total_cents (discounts/rebates have negative lineTotalCents,
  // adjustments are signed).
  //
  // Used by recalculateTotals and by callers that want the type-by-type
  // breakdown without round-tripping through the DB.
  type PoTotalsBreakdown = {
    productSubtotalCents: number;
    discountTotalCents: number;
    feeTotalCents: number;
    taxTotalCents: number;
    adjustmentTotalCents: number;
    totalCents: number;
  };

  function computePoTotalsFromLines(lines: any[]): PoTotalsBreakdown {
    let productSubtotal = BigInt(0);
    let discountTotal = BigInt(0);
    let feeTotal = BigInt(0);
    let taxTotal = BigInt(0);
    let adjustmentTotal = BigInt(0);
    for (const line of lines) {
      if (line.status === "cancelled") continue;
      const lineTotal = BigInt(Number(line.lineTotalCents) || 0);
      const type: PoLineType = (line.lineType as PoLineType) ?? "product";
      switch (type) {
        case "product":
          productSubtotal += lineTotal;
          break;
        case "discount":
        case "rebate":
          discountTotal += lineTotal;
          break;
        case "fee":
          feeTotal += lineTotal;
          break;
        case "tax":
          taxTotal += lineTotal;
          break;
        case "adjustment":
          adjustmentTotal += lineTotal;
          break;
      }
    }
    const total =
      productSubtotal + discountTotal + feeTotal + taxTotal + adjustmentTotal;
    return {
      productSubtotalCents: Number(productSubtotal),
      discountTotalCents: Number(discountTotal),
      feeTotalCents: Number(feeTotal),
      taxTotalCents: Number(taxTotal),
      adjustmentTotalCents: Number(adjustmentTotal),
      totalCents: Number(total),
    };
  }

  // ── Typed-line cost allocator (Option C, 2026-04-28) ──────────────────
  //
  // Distributes non-product line totals (discount / fee / tax / adjustment)
  // across product lines proportionally so each product line's effective
  // landed unit cost reflects the true cost-per-unit after the PO is
  // settled. This is what makes downstream COGS, margin, and inventory
  // valuation correct on PO-header-discount or PO-header-fee scenarios.
  //
  // Allocation rules:
  //   * Basis: product line total in cents (qty × unit_cost). Lines with
  //     zero or negative basis are skipped (they receive nothing).
  //   * Non-product line totals (the "to-allocate" pool) are summed from
  //     all non-product lines on the PO regardless of parent_line_id.
  //     Today the parent_line_id is stored but does NOT pin the allocation
  //     — PO-level discounts/fees spread across all products. Future work:
  //     when parent_line_id is set, target only that product line.
  //   * Each product line gets share = lineTotal / sum(productTotals).
  //   * Allocated cents = round_half_up(allocateCents × share).
  //   * Rounding remainder is added to the largest-basis line so the sum
  //     stays exact (mirrors shipment-tracking.runAllocation pattern).
  //   * Effective landed line total = lineTotal + allocatedCents.
  //   * Effective landed unit cost (mills) = round_half_up(
  //       effectiveLandedTotal × 100 / qty).
  //
  // Pure function. No DB access. Caller is responsible for fetching lines
  // and writing results back wherever they're consumed (currently:
  // receiving, when stamping inventory lots).

  type AllocatedLineCost = {
    purchaseOrderLineId: number;
    lineTotalCents: number;          // raw, before allocation
    allocatedCents: number;           // signed; can be negative for net-discount
    landedLineTotalCents: number;     // lineTotalCents + allocatedCents
    landedUnitCostMills: number;      // for stamping inventory lots
    landedUnitCostCents: number;      // back-compat, derived from mills
  };

  type AllocationResult = {
    perLine: AllocatedLineCost[];
    pooledCents: number;              // total non-product cents allocated
    productSubtotalCents: number;     // sum of product line basis
    // Non-zero only when productSubtotalCents == 0 and pooledCents != 0,
    // i.e. fees/discounts exist with no product line to absorb them.
    unallocatedCents: number;
  };

  function computeAllocatedLineCosts(lines: any[]): AllocationResult {
    // Partition lines by type. Cancelled lines never participate.
    const productLines: any[] = [];
    let pooledCents = 0;
    for (const line of lines) {
      if (line.status === "cancelled") continue;
      const type: PoLineType = (line.lineType as PoLineType) ?? "product";
      const lineTotal = Number(line.lineTotalCents) || 0;
      if (type === "product") {
        productLines.push(line);
      } else {
        // discount / fee / tax / rebate / adjustment all flow into the pool.
        // Sign-aware: discount/rebate are negative, fee/tax are positive,
        // adjustment is signed. Sum is also signed.
        pooledCents += lineTotal;
      }
    }

    // Compute basis (= raw line totals in cents) for each product line.
    // Lines with zero or negative basis are skipped from share computation
    // but still surface in `perLine` with allocatedCents=0 (so the caller
    // can stamp them with a clean record).
    const productSubtotalCents = productLines.reduce(
      (sum, l) => sum + (Number(l.lineTotalCents) || 0),
      0,
    );

    // Edge: no product lines or zero/negative product subtotal. Nothing to
    // allocate against — surface the pool as "unallocated" so the caller can
    // decide what to do (most likely: error or warn the user).
    if (productLines.length === 0 || productSubtotalCents <= 0) {
      return {
        perLine: productLines.map((l) => ({
          purchaseOrderLineId: Number(l.id),
          lineTotalCents: Number(l.lineTotalCents) || 0,
          allocatedCents: 0,
          landedLineTotalCents: Number(l.lineTotalCents) || 0,
          landedUnitCostMills:
            typeof l.unitCostMills === "number"
              ? l.unitCostMills
              : centsToMills(Number(l.unitCostCents) || 0),
          landedUnitCostCents: Number(l.unitCostCents) || 0,
        })),
        pooledCents,
        productSubtotalCents,
        unallocatedCents: pooledCents,
      };
    }

    // Allocate. Track running total to detect the rounding remainder.
    const perLine: AllocatedLineCost[] = [];
    let allocatedSoFar = 0;
    let maxBasis = 0;
    let maxBasisIdx = 0;

    for (let i = 0; i < productLines.length; i++) {
      const line = productLines[i];
      const lineTotalCents = Number(line.lineTotalCents) || 0;
      const qty = Number(line.orderQty) || 0;
      const basis = lineTotalCents > 0 ? lineTotalCents : 0;

      // share = basis / productSubtotalCents.
      // allocatedCents = round_half_up_away_from_zero(pool * basis / productSubtotal).
      // BigInt + signed half-up helper for deterministic rounding (Rule #2)
      // and overflow safety.
      let allocatedCents = 0;
      if (basis > 0) {
        allocatedCents = Number(
          signedRoundHalfUpDiv(
            BigInt(pooledCents) * BigInt(basis),
            BigInt(productSubtotalCents),
          ),
        );
      }
      allocatedSoFar += allocatedCents;

      if (basis > maxBasis) {
        maxBasis = basis;
        maxBasisIdx = i;
      }

      const landedLineTotalCents = lineTotalCents + allocatedCents;
      // landed unit cost in mills = round_half_up(landed_line_total_cents * 100 / qty).
      // BigInt to stay safe on large pooled totals.
      const landedUnitCostMills =
        qty > 0
          ? Number(
              signedRoundHalfUpDiv(
                BigInt(landedLineTotalCents) * BigInt(100),
                BigInt(qty),
              ),
            )
          : 0;
      const landedUnitCostCents =
        qty > 0
          ? Number(
              signedRoundHalfUpDiv(BigInt(landedLineTotalCents), BigInt(qty)),
            )
          : 0;

      perLine.push({
        purchaseOrderLineId: Number(line.id),
        lineTotalCents,
        allocatedCents,
        landedLineTotalCents,
        landedUnitCostMills,
        landedUnitCostCents,
      });
    }

    // Distribute rounding remainder to the largest-basis line so the
    // total reconciles exactly. Mirrors shipment-tracking.runAllocation.
    const remainder = pooledCents - allocatedSoFar;
    if (remainder !== 0 && perLine.length > 0) {
      const target = perLine[maxBasisIdx];
      target.allocatedCents += remainder;
      target.landedLineTotalCents += remainder;
      const qty = Number(productLines[maxBasisIdx].orderQty) || 0;
      if (qty > 0) {
        target.landedUnitCostMills = Number(
          signedRoundHalfUpDiv(
            BigInt(target.landedLineTotalCents) * BigInt(100),
            BigInt(qty),
          ),
        );
        target.landedUnitCostCents = Number(
          signedRoundHalfUpDiv(BigInt(target.landedLineTotalCents), BigInt(qty)),
        );
      }
    }

    return {
      perLine,
      pooledCents,
      productSubtotalCents,
      unallocatedCents: 0,
    };
  }

  // Helper: signed BigInt half-up division (toward +infinity for positives,
  // toward -infinity for negatives — i.e. away from zero on the half-cent).
  // Returns a JS number; safe for any value that fits Number.MAX_SAFE_INTEGER
  // post-division (which is fine for any real-world cent total).
  function signedRoundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
    if (denominator === BigInt(0)) return BigInt(0);
    const sign = (numerator < BigInt(0)) !== (denominator < BigInt(0)) ? -1 : 1;
    const absNum = numerator < BigInt(0) ? -numerator : numerator;
    const absDen = denominator < BigInt(0) ? -denominator : denominator;
    const halfDen = absDen / BigInt(2);
    const rounded = (absNum + halfDen) / absDen;
    return sign === -1 ? -rounded : rounded;
  }

  async function recalculateTotals(purchaseOrderId: number, userId?: string): Promise<any> {
    const lines = await storage.getPurchaseOrderLines(purchaseOrderId);
    let subtotalCents = BigInt(0);
    let lineCount = 0;
    let receivedLineCount = 0;

    for (const line of lines) {
      if (line.status === "cancelled") continue;
      const costs = calculateLineCosts(line);
      subtotalCents += BigInt(costs.lineTotalCents);
      lineCount++;
      if (line.status === "received") receivedLineCount++;

      // Update line total if changed
      if (line.lineTotalCents !== costs.lineTotalCents) {
        await storage.updatePurchaseOrderLine(line.id, {
          lineTotalCents: costs.lineTotalCents,
          discountCents: costs.discountCents,
          taxCents: costs.taxCents,
        });
      }
    }

    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    const headerDiscount = BigInt(po?.discountCents || 0);
    const headerTax = BigInt(po?.taxCents || 0);
    const headerShipping = BigInt(po?.shippingCostCents || 0);
    
    const totalCents = subtotalCents - headerDiscount + headerTax + headerShipping;

    // recalculateTotals does NOT change PO status; it only refreshes totals.
    // Use the plain update helper so we don't write a spurious po_status_history
    // row (which would violate the to_status NOT NULL constraint when called
    // with no historyData). Regression of commit 4c0a3cc.
    return await storage.updatePurchaseOrder(purchaseOrderId, {
      subtotalCents: Number(subtotalCents),
      totalCents: Number(totalCents),
      lineCount,
      receivedLineCount,
      updatedBy: userId,
    });
  }

  type LifecycleExpectation = {
    status: string;
    updatedAtMs: number | null;
  };

  type LockedLifecycleEconomics = {
    po: any;
    lines: any[];
    subtotalCents: number;
    totalCents: number;
    lineCount: number;
    receivedLineCount: number;
    newestLineUpdatedAtMs: number | null;
    correctedLegacyEconomics: boolean;
  };

  async function observeLifecycleState(
    id: number,
    allowedStatuses: readonly string[],
    invalidMessage: (status: string) => string,
  ): Promise<LifecycleExpectation> {
    const observed = await storage.getPurchaseOrderById(id);
    if (!observed) throw new PurchasingError("Purchase order not found", 404);
    if (!allowedStatuses.includes(observed.status)) {
      throw new PurchasingError(invalidMessage(observed.status), 400);
    }
    const updatedAtMs = observed.updatedAt == null
      ? null
      : new Date(observed.updatedAt).getTime();
    return {
      status: observed.status,
      updatedAtMs: Number.isNaN(updatedAtMs) ? null : updatedAtMs,
    };
  }

  function assertLifecycleExpectation(po: any, expectation: LifecycleExpectation): void {
    const lockedUpdatedAtMs = po.updatedAt == null ? null : new Date(po.updatedAt).getTime();
    const timestampChanged =
      expectation.updatedAtMs !== null &&
      (Number.isNaN(lockedUpdatedAtMs) || lockedUpdatedAtMs !== expectation.updatedAtMs);
    if (po.status !== expectation.status || timestampChanged) {
      throw new PurchasingError(
        "Purchase order changed while the lifecycle action was waiting for its lock",
        409,
        {
          code: "PO_LIFECYCLE_CONFLICT",
          expectedStatus: expectation.status,
          currentStatus: po.status,
        },
      );
    }
  }

  async function lockLifecycleEconomics(
    tx: any,
    id: number,
    expectation: LifecycleExpectation,
  ): Promise<LockedLifecycleEconomics> {
    const headerRows = await tx
      .select()
      .from(purchaseOrdersTable)
      .where(eq(purchaseOrdersTable.id, id))
      .limit(1)
      .for("update");
    const po = headerRows[0];
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertLifecycleExpectation(po, expectation);

    // Header-first lock ordering matches all hardened line commands. Once the
    // header is locked, no line writer can enter; locking every active line
    // then gives this transaction a stable economic snapshot.
    const lines = await tx
      .select({
        ...getTableColumns(purchaseOrderLinesTable),
        // Keep calendar-date comparisons in the database session's timezone.
        // Deriving this from the JavaScript Date's UTC representation can move
        // a near-midnight quote onto the wrong day.
        quotedAtDate: sql<string | null>`${purchaseOrderLinesTable.quotedAt}::date::text`,
      })
      .from(purchaseOrderLinesTable)
      .where(and(
        eq(purchaseOrderLinesTable.purchaseOrderId, id),
        ne(purchaseOrderLinesTable.status, "cancelled"),
      ))
      .orderBy(purchaseOrderLinesTable.id)
      .for("update");

    if (!lines.some((line: any) => Number(line.orderQty) > 0)) {
      throw new PurchasingError("PO must have at least one line with quantity > 0", 400);
    }

    let subtotal = BigInt(0);
    let receivedLineCount = 0;
    let newestLineUpdatedAtMs: number | null = null;
    let correctedLegacyEconomics = false;
    const explicitQuoteBases = new Set(["per_piece", "per_purchase_uom", "extended_total"]);

    for (const line of lines) {
      let trustedLineTotal = storedMoneyAsBigInt(line.lineTotalCents, "line_total_cents");

      // Explicit quote rows are protected by the quote-pricing database
      // identity constraint, including sub-cent remainder math. Re-deriving
      // those rows from rounded cents would destroy that precision. Legacy
      // rows have no such invariant, so repair their derived cent fields while
      // holding the row lock and use the repaired amount in the decision.
      if (!explicitQuoteBases.has(String(line.pricingBasis ?? "legacy_unknown"))) {
        const costs = calculateLineCosts(line);
        for (const [field, value] of Object.entries({
          line_total_cents: costs.lineTotalCents,
          discount_cents: costs.discountCents,
          tax_cents: costs.taxCents,
        })) {
          if (!Number.isSafeInteger(value)) {
            throw new PurchasingError(`Stored line cannot produce a safe ${field}`, 409, {
              code: "PO_LIFECYCLE_LINE_MONEY_INVALID",
              lineId: line.id,
              field,
            });
          }
        }
        trustedLineTotal = BigInt(costs.lineTotalCents);
        if (
          Number(line.lineTotalCents) !== costs.lineTotalCents ||
          Number(line.discountCents ?? 0) !== costs.discountCents ||
          Number(line.taxCents ?? 0) !== costs.taxCents
        ) {
          const repaired = await tx
            .update(purchaseOrderLinesTable)
            .set({
              lineTotalCents: costs.lineTotalCents,
              discountCents: costs.discountCents,
              taxCents: costs.taxCents,
              updatedAt: sql`date_trunc('milliseconds', transaction_timestamp())`,
            })
            .where(and(
              eq(purchaseOrderLinesTable.id, line.id),
              eq(purchaseOrderLinesTable.purchaseOrderId, id),
              ne(purchaseOrderLinesTable.status, "cancelled"),
            ))
            .returning({ id: purchaseOrderLinesTable.id });
          if (!repaired[0]) {
            throw new PurchasingError("A purchase order line changed during lifecycle validation", 409, {
              code: "PO_LIFECYCLE_LINE_CONFLICT",
              lineId: line.id,
            });
          }
          correctedLegacyEconomics = true;
        }
      }

      subtotal += trustedLineTotal;
      if (line.status === "received") receivedLineCount++;
      if (line.updatedAt != null) {
        const lineUpdatedAtMs = new Date(line.updatedAt).getTime();
        if (!Number.isNaN(lineUpdatedAtMs)) {
          newestLineUpdatedAtMs = newestLineUpdatedAtMs === null
            ? lineUpdatedAtMs
            : Math.max(newestLineUpdatedAtMs, lineUpdatedAtMs);
        }
      }
    }

    const total =
      subtotal -
      storedMoneyAsBigInt(po.discountCents, "discount_cents") +
      storedMoneyAsBigInt(po.taxCents, "tax_cents") +
      storedMoneyAsBigInt(po.shippingCostCents, "shipping_cost_cents");

    return {
      po,
      lines,
      subtotalCents: safeIntegerMoney(subtotal, "subtotal_cents"),
      totalCents: safeIntegerMoney(total, "total_cents"),
      lineCount: lines.length,
      receivedLineCount,
      newestLineUpdatedAtMs,
      correctedLegacyEconomics,
    };
  }

  async function getMatchingApprovalTierTx(tx: any, totalCents: number): Promise<any | null> {
    const rows = await tx
      .select()
      .from(poApprovalTiersTable)
      .where(and(
        lte(poApprovalTiersTable.thresholdCents, totalCents),
        eq(poApprovalTiersTable.active, 1),
      ))
      .orderBy(desc(poApprovalTiersTable.thresholdCents))
      .limit(1)
      .for("share");
    return rows[0] ?? null;
  }

  async function getActiveApprovalTiersTx(tx: any): Promise<any[]> {
    return await tx
      .select()
      .from(poApprovalTiersTable)
      .where(eq(poApprovalTiersTable.active, 1))
      .orderBy(poApprovalTiersTable.id)
      .for("share");
  }

  function lifecycleTotalsPatch(economics: LockedLifecycleEconomics) {
    return {
      subtotalCents: economics.subtotalCents,
      totalCents: economics.totalCents,
      lineCount: economics.lineCount,
      receivedLineCount: economics.receivedLineCount,
    };
  }

  type LifecycleQuoteClock = {
    evaluatedAt: Date;
    currentDate: string;
  };

  async function getLifecycleQuoteClockTx(tx: any): Promise<LifecycleQuoteClock> {
    const result = await tx.execute(sql`
      SELECT
        transaction_timestamp() AS quote_evaluated_at,
        current_date::text AS quote_current_date
    `);
    const row = result.rows?.[0];
    const evaluatedAt = row?.quote_evaluated_at instanceof Date
      ? row.quote_evaluated_at
      : new Date(String(row?.quote_evaluated_at ?? ""));
    const currentDate = String(row?.quote_current_date ?? "");
    if (
      Number.isNaN(evaluatedAt.getTime()) ||
      !isValidIsoDateOnly(currentDate)
    ) {
      throw new PurchasingError("Database quote-validation clock is unavailable", 500, {
        code: "PO_QUOTE_CLOCK_UNAVAILABLE",
      });
    }
    return { evaluatedAt, currentDate };
  }

  function lifecycleQuoteError(
    line: any,
    status: "invalid" | "future" | "expired" | "stale",
    currentDate: string,
  ): PurchasingError {
    const messages = {
      invalid: "A purchase-order line has invalid quote dates",
      future: "A purchase-order line quote is dated in the future",
      expired: "A purchase-order line quote has expired",
      stale: "A purchase-order line quote is stale and has no explicit validity date",
    } as const;
    return new PurchasingError(messages[status], 409, {
      code: `PO_LINE_QUOTE_${status.toUpperCase()}`,
      lineId: line.id,
      lineNumber: line.lineNumber ?? null,
      pricingSource: line.pricingSource ?? null,
      pricingBasis: line.pricingBasis ?? null,
      quotedAt: line.quotedAt ?? null,
      quoteValidUntil: line.quoteValidUntil ?? null,
      currentDate,
    });
  }

  async function assertLifecycleQuotesReadyTx(
    tx: any,
    economics: LockedLifecycleEconomics,
  ): Promise<void> {
    const unreviewedLegacyProduct = economics.lines.find((line: any) =>
      (line.lineType ?? "product") === "product" &&
      (line.pricingBasis ?? "legacy_unknown") === "legacy_unknown",
    );
    if (unreviewedLegacyProduct) {
      throw new PurchasingError(
        "A legacy product line must be reviewed and given an explicit vendor quote basis before submission or sending",
        409,
        {
          code: "PO_LINE_QUOTE_REVIEW_REQUIRED",
          lineId: unreviewedLegacyProduct.id,
          lineNumber: unreviewedLegacyProduct.lineNumber ?? null,
          pricingSource: unreviewedLegacyProduct.pricingSource ?? "legacy",
          pricingBasis: unreviewedLegacyProduct.pricingBasis ?? "legacy_unknown",
        },
      );
    }

    const datedOrTrustedLines = economics.lines.filter((line: any) =>
      line.pricingSource === "vendor_catalog" ||
      line.pricingSource === "recommendation" ||
      line.quotedAt != null ||
      line.quoteValidUntil != null,
    );
    if (datedOrTrustedLines.length === 0) return;

    const clock = await getLifecycleQuoteClockTx(tx);
    for (const line of datedOrTrustedLines) {
      const validUntil = line.quoteValidUntil == null
        ? null
        : String(line.quoteValidUntil).slice(0, 10);
      if (validUntil !== null && !isValidIsoDateOnly(validUntil)) {
        throw lifecycleQuoteError(line, "invalid", clock.currentDate);
      }
      if (validUntil !== null && validUntil < clock.currentDate) {
        throw lifecycleQuoteError(line, "expired", clock.currentDate);
      }

      // Manual quotes may intentionally omit a quote date. A stated date,
      // and every trusted catalog/recommendation snapshot, must still be
      // current at the moment approval or sending commits.
      if (line.quotedAt == null) {
        if (line.pricingSource === "vendor_catalog" || line.pricingSource === "recommendation") {
          throw lifecycleQuoteError(line, "invalid", clock.currentDate);
        }
        continue;
      }
      const validity = assessSupplierQuoteValidity({
        quotedAt: line.quotedAt,
        quotedAtDate: line.quotedAtDate ?? null,
        quoteValidUntil: validUntil,
        asOf: clock.evaluatedAt,
        currentDate: clock.currentDate,
      });
      if (validity.status === "invalid" || validity.status === "future" || validity.status === "expired" || validity.status === "stale") {
        throw lifecycleQuoteError(line, validity.status, clock.currentDate);
      }
    }

    const trustedLines = datedOrTrustedLines.filter((line: any) =>
      line.pricingSource === "vendor_catalog" || line.pricingSource === "recommendation",
    );
    if (trustedLines.length === 0) return;
    const vendorProductIds = [...new Set(trustedLines.map((line: any) => Number(line.vendorProductId)))]
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .sort((left, right) => left - right);
    if (vendorProductIds.length !== new Set(trustedLines.map((line: any) => Number(line.vendorProductId))).size) {
      throw new PurchasingError("A trusted purchase-order line is missing vendor catalog provenance", 409, {
        code: "PO_LINE_VENDOR_CATALOG_PROVENANCE_INVALID",
      });
    }
    const catalogRows = await tx
      .select()
      .from(vendorProductsTable)
      .where(inArray(vendorProductsTable.id, vendorProductIds))
      .orderBy(vendorProductsTable.id)
      .for("share");
    const catalogById = new Map<number, any>(
      catalogRows.map((row: any) => [Number(row.id), row]),
    );
    for (const line of trustedLines) {
      const vendorProduct = catalogById.get(Number(line.vendorProductId));
      if (
        !vendorProduct ||
        Number(vendorProduct.isActive ?? 0) !== 1 ||
        Number(vendorProduct.vendorId) !== Number(economics.po.vendorId) ||
        Number(vendorProduct.productId) !== Number(line.productId)
      ) {
        throw new PurchasingError(
          "A trusted vendor catalog mapping is no longer active for this PO vendor and product",
          409,
          {
            code: "PO_LINE_VENDOR_CATALOG_PROVENANCE_INACTIVE",
            lineId: line.id,
            vendorProductId: line.vendorProductId ?? null,
          },
        );
      }
    }
  }

  async function updateLockedLifecycleHeader(
    tx: any,
    economics: LockedLifecycleEconomics,
    patch: Record<string, unknown>,
  ): Promise<any> {
    const po = economics.po;
    const conditions = [
      eq(purchaseOrdersTable.id, po.id),
      eq(purchaseOrdersTable.status, po.status),
    ];
    if (po.physicalStatus != null) {
      conditions.push(eq(purchaseOrdersTable.physicalStatus, po.physicalStatus));
    }
    if (po.updatedAt != null) {
      conditions.push(eq(purchaseOrdersTable.updatedAt, po.updatedAt));
    }
    const rows = await tx
      .update(purchaseOrdersTable)
      .set({
        ...patch,
        updatedAt: sql`date_trunc('milliseconds', transaction_timestamp())`,
      })
      .where(and(...conditions))
      .returning();
    if (!rows[0]) {
      throw new PurchasingError("Purchase order changed during the lifecycle transition", 409, {
        code: "PO_LIFECYCLE_CONFLICT",
      });
    }
    return rows[0];
  }

  function approvalCoversLockedEconomics(
    economics: LockedLifecycleEconomics,
    tier: any,
  ): boolean {
    const approvedAtMs = economics.po.approvedAt == null
      ? Number.NaN
      : new Date(economics.po.approvedAt).getTime();
    if (
      Number.isNaN(approvedAtMs) ||
      Number(economics.po.approvalTierId) !== Number(tier.id) ||
      economics.correctedLegacyEconomics
    ) {
      return false;
    }
    return economics.newestLineUpdatedAtMs === null || economics.newestLineUpdatedAtMs <= approvedAtMs;
  }

  // recordStatusChange removed in favor of storage.updatePurchaseOrderStatusWithHistory

  function assertTransition(currentStatus: string, targetStatus: string) {
    const allowed = getAllowedLegacyTransitions(currentStatus);
    if (!allowed.includes(targetStatus)) {
      throw new PurchasingError(
        `Cannot transition from '${currentStatus}' to '${targetStatus}'`,
        400,
      );
    }
  }

  function toPurchasingError(error: unknown): never {
    if (error instanceof PoLifecycleError) {
      throw new PurchasingError(error.message, error.statusCode, error.details);
    }
    throw error;
  }

  async function updatePurchaseOrderStatusWithHistoryTx(
    tx: any,
    id: number,
    updates: Record<string, unknown>,
    historyData: {
      fromStatus?: string;
      toStatus?: string;
      changedBy?: string;
      notes?: string;
    },
  ): Promise<any | null> {
    if (!historyData?.toStatus) {
      throw new Error("updatePurchaseOrderStatusWithHistoryTx requires historyData.toStatus");
    }

    const result = await tx.update(purchaseOrdersTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(purchaseOrdersTable.id, id))
      .returning();

    const updatedPo = result[0] || null;
    if (updatedPo) {
      await tx.insert(poStatusHistoryTable).values({
        ...historyData,
        purchaseOrderId: id,
      });
    }
    return updatedPo;
  }

  async function updatePurchaseOrderLineTx(
    tx: any,
    id: number,
    updates: Record<string, unknown>,
  ): Promise<any | null> {
    const result = await tx.update(purchaseOrderLinesTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(purchaseOrderLinesTable.id, id))
      .returning();
    return result[0] || null;
  }

  async function updatePurchaseOrderStatusWithEvent(
    id: number,
    updates: Record<string, unknown>,
    historyData: {
      fromStatus?: string;
      toStatus?: string;
      changedBy?: string;
      notes?: string;
    },
    eventType: string,
    userId: string | null | undefined,
    payload?: Record<string, unknown>,
  ): Promise<any | null> {
    return db.transaction(async (tx: any) => {
      const updated = await updatePurchaseOrderStatusWithHistoryTx(
        tx,
        id,
        updates,
        historyData,
      );
      await emitPoEventTx(tx, id, eventType, userId, payload);
      return updated;
    });
  }

  // ── Dual-track state machine functions (migration 0565) ──────────────────

  /**
   * Transition the physical (goods-movement) status of a PO.
   *
   * Validates through purchase-order-lifecycle.service, stamps the appropriate
   * lifecycle timestamp, syncs the legacy `status` column for back-compat,
   * and writes a po_status_history row with old/new physical status.
   *
   * Rule #7: status history and po_events are written in the same transaction
   * so a lifecycle action cannot leave an audit gap.
   */
  async function transitionPhysical(
    poId: number,
    target: PoPhysicalStatus,
    userId?: string,
    notes?: string,
    extraPatch?: Record<string, any>,
    historyFromStatus?: string,
  ): Promise<any> {
    const po = await storage.getPurchaseOrderById(poId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    const change = (() => {
      try {
        return buildPhysicalTransitionChange({
          po,
          target,
          userId,
          notes,
          extraPatch,
          historyFromStatus,
        });
      } catch (error) {
        return toPurchasingError(error);
      }
    })();
    const eventType = PHYSICAL_LIFECYCLE_EVENTS[target];
    const result = await db.transaction(async (tx: any) => {
      const updated = await updatePurchaseOrderStatusWithHistoryTx(
        tx,
        poId,
        change.patch,
        change.history,
      );

      if (eventType) {
        await emitPoEventTx(tx, poId, eventType, userId, {
          from_status: change.history.fromStatus,
          to_status: change.history.toStatus,
          physical_status: target,
        });
      }

      return updated;
    });

    // ── Exception detection hooks (event-driven, Phase 1) ──────────────────
    // Run after the DB write so detection reads fresh data.
    // Non-blocking: detection failures should not roll back the status transition.
    try {
      // Qty variance: detect after goods are received.
      if (target === "received") {
        await detectQtyVariance(poId);
      }
      // Past-due: lazy detection on any physical transition.
      await detectPastDue(poId);
    } catch (detectionErr) {
      // Log but don't throw — detection is best-effort, not transactional.
      console.error("[po-exceptions] detection hook failed in transitionPhysical:", detectionErr);
    }

    return result;
  }

  /**
   * Transition the financial (AP/payment) status of a PO.
   *
   * Validates through purchase-order-lifecycle.service, stamps lifecycle
   * timestamps, and writes a po_status_history row.
   *
   * Does NOT modify the legacy `status` column — that is owned by the
   * physical track.
   */
  async function transitionFinancial(
    poId: number,
    target: PoFinancialStatus,
    userId?: string,
    notes?: string,
    extraPatch?: Record<string, any>,
  ): Promise<any> {
    const po = await storage.getPurchaseOrderById(poId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    const change = (() => {
      try {
        return buildFinancialTransitionChange({
          po,
          target,
          userId,
          notes,
          extraPatch,
        });
      } catch (error) {
        return toPurchasingError(error);
      }
    })();
    const patch = change.patch;

    return await storage.updatePurchaseOrderStatusWithHistory(
      poId,
      patch,
      change.history,
    );
  }

  /**
   * Recompute financial aggregates for a PO from source-of-truth tables.
   *
   * Sums invoiced_amount_cents and paid_amount_cents from non-voided
   * vendor_invoices linked via vendor_invoice_po_links. Updates
   * invoicedTotalCents, paidTotalCents, outstandingCents, and derives
   * a new financialStatus.
   *
   * This is a pure recompute — idempotent, safe to call multiple times
   * (Rule #6). Uses direct DB query for accuracy (the storage interface
   * doesn't expose invoice aggregates).
   *
   * Rule #3: all arithmetic in BigInt cents. No floats.
   */
  async function recomputeFinancialAggregates(poId: number): Promise<void> {
    const po = await storage.getPurchaseOrderById(poId);
    if (!po) return;

    // Sum invoiced and paid amounts from non-voided invoices linked to this PO.
    const invoiceRows = await db
      .select({
        invoicedAmountCents: vendorInvoicesTable.invoicedAmountCents,
        paidAmountCents: vendorInvoicesTable.paidAmountCents,
      })
      .from(vendorInvoicePoLinksTable)
      .innerJoin(
        vendorInvoicesTable,
        eq(vendorInvoicePoLinksTable.vendorInvoiceId, vendorInvoicesTable.id),
      )
      .where(
        and(
          eq(vendorInvoicePoLinksTable.purchaseOrderId, poId),
          ne(vendorInvoicesTable.status, "voided"),
        ),
      );

    // Integer-only arithmetic (Rule #3).
    let invoicedTotal = BigInt(0);
    let paidTotal = BigInt(0);
    for (const row of invoiceRows) {
      invoicedTotal += BigInt(Number(row.invoicedAmountCents) || 0);
      paidTotal += BigInt(Number(row.paidAmountCents) || 0);
    }
    const outstanding = invoicedTotal > paidTotal ? invoicedTotal - paidTotal : BigInt(0);

    // Derive the new financial status from the computed aggregates.
    const currentFinancial = (po.financialStatus ?? "unbilled") as PoFinancialStatus;
    let newFinancial: PoFinancialStatus;

    if (currentFinancial === "disputed") {
      // Disputed stays disputed until explicitly resolved.
      newFinancial = "disputed";
    } else if (invoicedTotal === BigInt(0)) {
      newFinancial = "unbilled";
    } else if (paidTotal >= invoicedTotal) {
      newFinancial = "paid";
    } else if (paidTotal > BigInt(0)) {
      newFinancial = "partially_paid";
    } else {
      newFinancial = "invoiced";
    }

    const now = new Date();
    const patch: Record<string, any> = {
      invoicedTotalCents: Number(invoicedTotal),
      paidTotalCents: Number(paidTotal),
      outstandingCents: Number(outstanding),
      financialStatus: newFinancial,
      updatedBy: undefined, // system recompute — no actor
    };

    // Stamp first-invoiced timestamp when transitioning out of unbilled.
    if (currentFinancial === "unbilled" && newFinancial !== "unbilled" && !po.firstInvoicedAt) {
      patch.firstInvoicedAt = now;
    }
    // Stamp first-paid timestamp.
    if (
      (currentFinancial === "unbilled" || currentFinancial === "invoiced") &&
      (newFinancial === "partially_paid" || newFinancial === "paid") &&
      !po.firstPaidAt
    ) {
      patch.firstPaidAt = now;
    }
    // Stamp fully-paid timestamp.
    if (newFinancial === "paid" && !po.fullyPaidAt) {
      patch.fullyPaidAt = now;
    }

    // Use plain update (no status-history row) — this is a system recompute,
    // not a business event. The financial status change is implicit.
    await storage.updatePurchaseOrder(poId, patch);
  }

  // ── PO CRUD ─────────────────────────────────────────────────────

  async function createPO(data: {
    vendorId: number;
    warehouseId?: number;
    poType?: string;
    priority?: string;
    expectedDeliveryDate?: Date;
    shipToAddress?: string;
    shippingMethod?: string;
    incoterms?: string;
    freightTerms?: string;
    vendorNotes?: string;
    internalNotes?: string;
    source?: "manual" | "auto_draft" | "reorder";
    createdBy?: string;
  }) {
    // Validate vendor
    const vendor = await storage.getVendorById(data.vendorId);
    if (!vendor) throw new PurchasingError("Vendor not found", 404);

    let lastConflictingPoNumber: string | null = null;
    for (let attempt = 1; attempt <= PO_NUMBER_ALLOCATION_ATTEMPTS; attempt++) {
      const poNumber = await storage.generatePoNumber();
      try {
        return await storage.createPurchaseOrder({
          poNumber,
          vendorId: data.vendorId,
          warehouseId: data.warehouseId,
          status: "draft",
          poType: data.poType || "standard",
          priority: data.priority || "normal",
          expectedDeliveryDate: data.expectedDeliveryDate,
          shipToAddress: data.shipToAddress,
          shippingMethod: data.shippingMethod,
          incoterms: data.incoterms,
          freightTerms: data.freightTerms,
          vendorNotes: data.vendorNotes,
          internalNotes: data.internalNotes,
          source: data.source ?? "manual",
          currency: vendor.currency || "USD",
          paymentTermsDays: vendor.paymentTermsDays,
          paymentTermsType: vendor.paymentTermsType,
          shipFromAddress: vendor.shipFromAddress,
          createdBy: data.createdBy,
          updatedBy: data.createdBy,
        }, {
          fromStatus: null,
          toStatus: "draft",
          changedBy: data.createdBy,
          notes: "PO created"
        });
      } catch (error: any) {
        if (!isPoNumberUniqueViolation(error)) throw error;
        lastConflictingPoNumber = poNumber;
        if (attempt < PO_NUMBER_ALLOCATION_ATTEMPTS) continue;
      }
    }

    throw new PurchasingError(
      "Could not allocate a unique PO number after concurrent create attempts",
      409,
      {
        code: "PO_NUMBER_ALLOCATION_EXHAUSTED",
        attempts: PO_NUMBER_ALLOCATION_ATTEMPTS,
        lastPoNumber: lastConflictingPoNumber,
      },
    );
  }

  async function lockCleanDraftHeaderForMutation(
    tx: any,
    id: number,
  ): Promise<any> {
    const locked = await tx
      .select()
      .from(purchaseOrdersTable)
      .where(eq(purchaseOrdersTable.id, id))
      .limit(1)
      .for("update");
    const po = locked[0];
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    const physicalStatus = po.physicalStatus ?? po.status;
    const financialStatus = po.financialStatus ?? "unbilled";
    if (
      po.status !== "draft" ||
      physicalStatus !== "draft" ||
      financialStatus !== "unbilled"
    ) {
      throw new PurchasingError(`Cannot edit PO in '${po.status}' status`, 400, {
        code: "PO_NOT_EDITABLE",
        status: po.status,
        physicalStatus,
        financialStatus,
      });
    }
    if (
      storedMoneyAsBigInt(po.invoicedTotalCents, "invoiced_total_cents") !== BigInt(0) ||
      storedMoneyAsBigInt(po.paidTotalCents, "paid_total_cents") !== BigInt(0)
    ) {
      throw new PurchasingError("Cannot edit a draft after financial activity exists", 409, {
        code: "PO_DRAFT_HAS_FINANCIAL_ACTIVITY",
      });
    }

    const recommendationHandoffs = await tx
      .select({ id: purchasingRecommendationPoHandoffsTable.id })
      .from(purchasingRecommendationPoHandoffsTable)
      .where(eq(purchasingRecommendationPoHandoffsTable.purchaseOrderId, id))
      .limit(1);
    if (recommendationHandoffs[0]) {
      throw new PurchasingError(
        "Cannot edit the header of a recommendation-created PO; cancel it and accept a new recommendation",
        409,
        {
          code: "RECOMMENDATION_PO_HEADER_AMEND_BLOCKED",
          handoffId: recommendationHandoffs[0].id,
        },
      );
    }

    return po;
  }

  function cleanDraftHeaderCasConditions(po: any): any[] {
    const conditions = [
      eq(purchaseOrdersTable.id, po.id),
      eq(purchaseOrdersTable.status, "draft"),
      eq(purchaseOrdersTable.physicalStatus, "draft"),
      eq(purchaseOrdersTable.financialStatus, "unbilled"),
    ];
    if (po.updatedAt != null) {
      conditions.push(eq(purchaseOrdersTable.updatedAt, po.updatedAt));
    }
    return conditions;
  }

  async function updatePO(
    id: number,
    requested: unknown,
    userId?: string,
  ) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new PurchasingError("Purchase order id must be a positive integer", 400, {
        code: "INVALID_PURCHASE_ORDER_ID",
      });
    }
    const parsed = purchaseOrderDraftHeaderPatchSchema.safeParse(requested);
    if (!parsed.success) {
      throw new PurchasingError("Invalid draft purchase order header update", 400, {
        code: "INVALID_PO_DRAFT_HEADER_PATCH",
        issues: parsed.error.issues,
      });
    }

    return db.transaction(async (tx: any) => {
      const po = await lockCleanDraftHeaderForMutation(tx, id);

      const change = buildPurchaseOrderDraftHeaderChange(po, parsed.data);
      if (change.changedFields.length === 0) return po;

      const result = await tx
        .update(purchaseOrdersTable)
        .set({
          ...change.patch,
          ...(userId ? { updatedBy: userId } : {}),
          updatedAt: sql`date_trunc('milliseconds', transaction_timestamp())`,
        })
        .where(and(...cleanDraftHeaderCasConditions(po)))
        .returning();
      const updated = result[0];
      if (!updated) {
        throw new PurchasingError("Purchase order changed while the edit was being applied", 409, {
          code: "PO_DRAFT_EDIT_CONFLICT",
        });
      }

      await emitPoEventTx(tx, id, "edited", userId, {
        changed_fields: change.changedFields,
        before: change.before,
        after: change.after,
      });
      return updated;
    });
  }

  async function updateDeliverySchedule(
    id: number,
    input: DeliverySchedulePatch & { notes?: string },
    userId?: string,
  ) {
    if (!Number.isSafeInteger(id) || id <= 0 || id > PG_INTEGER_MAX) {
      throw new PurchasingError("Purchase order id must be a positive integer", 400, {
        code: "INVALID_PURCHASE_ORDER_ID",
      });
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new PurchasingError("Delivery schedule update is required", 400, {
        code: "DELIVERY_SCHEDULE_INVALID_PATCH",
      });
    }
    const hasExpected = input.expectedDeliveryDate !== undefined;
    const hasConfirmed = input.confirmedDeliveryDate !== undefined;
    if (!hasExpected && !hasConfirmed) {
      throw new PurchasingError("At least one delivery schedule date is required", 400, {
        code: "DELIVERY_SCHEDULE_EMPTY_PATCH",
      });
    }

    return db.transaction(async (tx: any) => {
      const locked = await tx
        .select()
        .from(purchaseOrdersTable)
        .where(eq(purchaseOrdersTable.id, id))
        .limit(1)
        .for("update");
      const po = locked[0];
      if (!po) throw new PurchasingError("Purchase order not found", 404);

      const physicalStatus = po.physicalStatus ?? po.status;
      if (
        TERMINAL_DELIVERY_SCHEDULE_STATUSES.has(po.status) ||
        TERMINAL_DELIVERY_SCHEDULE_STATUSES.has(physicalStatus)
      ) {
        throw new PurchasingError("Cannot update the delivery schedule on a terminal PO", 400, {
          code: "DELIVERY_SCHEDULE_TERMINAL_PO",
          status: po.status,
          physicalStatus,
        });
      }

      const issues = validateDeliverySchedulePatch(po, input);
      if (issues.length > 0) {
        const issue = issues[0];
        throw new PurchasingError(issue.message, 400, issue);
      }

      const patch: Record<string, Date | null> = {};
      const changes: string[] = [];
      if (hasExpected && !sameDeliveryDate(po.expectedDeliveryDate, input.expectedDeliveryDate)) {
        patch.expectedDeliveryDate = input.expectedDeliveryDate ?? null;
        changes.push("requested delivery date");
      }
      if (hasConfirmed && !sameDeliveryDate(po.confirmedDeliveryDate, input.confirmedDeliveryDate)) {
        patch.confirmedDeliveryDate = input.confirmedDeliveryDate ?? null;
        changes.push("vendor confirmed delivery date");
      }
      if (changes.length === 0) return po;

      const before = {
        expected_delivery_date: deliveryDateIso(po.expectedDeliveryDate),
        confirmed_delivery_date: deliveryDateIso(po.confirmedDeliveryDate),
      };
      const after = {
        expected_delivery_date: hasExpected
          ? deliveryDateIso(input.expectedDeliveryDate)
          : before.expected_delivery_date,
        confirmed_delivery_date: hasConfirmed
          ? deliveryDateIso(input.confirmedDeliveryDate)
          : before.confirmed_delivery_date,
      };
      const notes = input.notes?.trim() || `Updated ${changes.join(" and ")}`;
      const conditions = [
        eq(purchaseOrdersTable.id, id),
        eq(purchaseOrdersTable.status, po.status),
      ];
      if (po.physicalStatus != null) {
        conditions.push(eq(purchaseOrdersTable.physicalStatus, po.physicalStatus));
      }
      if (po.updatedAt != null) {
        conditions.push(eq(purchaseOrdersTable.updatedAt, po.updatedAt));
      }
      const updatedRows = await tx
        .update(purchaseOrdersTable)
        .set({
          ...patch,
          ...(userId ? { updatedBy: userId } : {}),
          updatedAt: sql`date_trunc('milliseconds', transaction_timestamp())`,
        })
        .where(and(...conditions))
        .returning();
      const updated = updatedRows[0];
      if (!updated) {
        throw new PurchasingError(
          "Purchase order changed while the delivery schedule update was being applied",
          409,
          { code: "PO_DELIVERY_SCHEDULE_CONFLICT" },
        );
      }

      await tx.insert(poStatusHistoryTable).values({
        purchaseOrderId: id,
        fromStatus: po.status,
        toStatus: po.status,
        changedBy: userId,
        notes,
      });
      await emitPoEventTx(tx, id, "delivery_schedule_updated", userId, {
        before,
        after,
        notes,
      });
      return updated;
    });
  }

  async function deletePO(id: number) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    if (po.status !== "draft") {
      throw new PurchasingError("Can only delete POs in draft status", 400);
    }
    const recommendationHandoff = await storage.getRecommendationPoHandoffForPo(id);
    if (recommendationHandoff) {
      throw new PurchasingError(
        "Cannot delete a recommendation-created PO; cancel it to preserve the handoff audit trail",
        409,
        { code: "RECOMMENDATION_PO_DELETE_BLOCKED", handoffId: recommendationHandoff.id },
      );
    }
    return await storage.deletePurchaseOrder(id);
  }

  // ── INCOTERMS & HEADER CHARGES ────────────────────────────────────
  // Incoterms and header charges are approval inputs. They may only change on
  // a financially clean draft, and the totals + audit event must commit with
  // the edit so an approved amount can never be altered through this endpoint.

  async function updateIncotermsAndCharges(
      id: number,
      updates: {
        incoterms?: string | null;
        discountCents?: number;
        taxCents?: number;
        shippingCostCents?: number;
        overReceiptTolerancePct?: number;
      },
      userId?: string,
    ) {
      if (!Number.isSafeInteger(id) || id <= 0 || id > PG_INTEGER_MAX) {
        throw new PurchasingError("Purchase order id must be a positive integer", 400, {
          code: "INVALID_PURCHASE_ORDER_ID",
        });
      }
      if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
        throw new PurchasingError("Incoterms or header charges update is required", 400, {
          code: "INVALID_PO_HEADER_CHARGES_PATCH",
        });
      }

      const suppliedFields = [
        "incoterms",
        "discountCents",
        "taxCents",
        "shippingCostCents",
        "overReceiptTolerancePct",
      ].filter((field) => (updates as Record<string, unknown>)[field] !== undefined);
      if (suppliedFields.length === 0) {
        throw new PurchasingError("At least one incoterm or header charge field is required", 400, {
          code: "INVALID_PO_HEADER_CHARGES_PATCH",
        });
      }

      let normalizedIncoterms: string | null | undefined;
      if (updates.incoterms !== undefined) {
        if (updates.incoterms !== null && typeof updates.incoterms !== "string") {
          throw new PurchasingError("incoterms must be a string or null", 400, {
            code: "INVALID_PO_HEADER_CHARGES_PATCH",
            field: "incoterms",
          });
        }
        normalizedIncoterms = typeof updates.incoterms === "string"
          ? updates.incoterms.trim() || null
          : null;
        if (normalizedIncoterms != null && normalizedIncoterms.length > 10) {
          throw new PurchasingError("incoterms must be at most 10 characters", 400, {
            code: "INVALID_PO_HEADER_CHARGES_PATCH",
            field: "incoterms",
          });
        }
      }
      for (const field of ["discountCents", "taxCents", "shippingCostCents"] as const) {
        const value = updates[field];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
          throw new PurchasingError(`${field} must be a non-negative integer number of cents`, 400, {
            code: "INVALID_PO_HEADER_CHARGES_PATCH",
            field,
          });
        }
      }
      if (
        updates.overReceiptTolerancePct !== undefined &&
        (
          !Number.isFinite(updates.overReceiptTolerancePct) ||
          updates.overReceiptTolerancePct < 0 ||
          updates.overReceiptTolerancePct > 100 ||
          Math.round(updates.overReceiptTolerancePct * 100) / 100 !==
            updates.overReceiptTolerancePct
        )
      ) {
        throw new PurchasingError(
          "overReceiptTolerancePct must be between 0 and 100 with at most two decimal places",
          400,
          {
            code: "INVALID_PO_HEADER_CHARGES_PATCH",
            field: "overReceiptTolerancePct",
          },
        );
      }

      return db.transaction(async (tx: any) => {
        const po = await lockCleanDraftHeaderForMutation(tx, id);
        const patch: Record<string, unknown> = {};
        const changedFields: string[] = [];
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        const track = (
          column: string,
          auditField: string,
          current: unknown,
          requested: unknown,
          stored: unknown = requested,
        ) => {
          if (requested === undefined || requested === current) return;
          changedFields.push(auditField);
          before[auditField] = current ?? null;
          after[auditField] = requested ?? null;
          patch[column] = stored;
        };

        track("incoterms", "incoterms", po.incoterms ?? null, normalizedIncoterms);
        track(
          "discountCents",
          "discount_cents",
          Number(po.discountCents ?? 0),
          updates.discountCents,
        );
        track("taxCents", "tax_cents", Number(po.taxCents ?? 0), updates.taxCents);
        track(
          "shippingCostCents",
          "shipping_cost_cents",
          Number(po.shippingCostCents ?? 0),
          updates.shippingCostCents,
        );
        track(
          "overReceiptTolerancePct",
          "over_receipt_tolerance_pct",
          Number(po.overReceiptTolerancePct ?? 0),
          updates.overReceiptTolerancePct,
          updates.overReceiptTolerancePct === undefined
            ? undefined
            : String(updates.overReceiptTolerancePct),
        );
        if (changedFields.length === 0) return po;

        const lines = await tx
          .select()
          .from(purchaseOrderLinesTable)
          .where(and(
            eq(purchaseOrderLinesTable.purchaseOrderId, id),
            ne(purchaseOrderLinesTable.status, "cancelled"),
          ))
          .orderBy(purchaseOrderLinesTable.id)
          .for("update");
        let subtotal = BigInt(0);
        let receivedLineCount = 0;
        for (const line of lines) {
          subtotal += storedMoneyAsBigInt(line.lineTotalCents, "line_total_cents");
          if (line.status === "received") receivedLineCount++;
        }

        const discountCents = updates.discountCents === undefined
          ? storedMoneyAsBigInt(po.discountCents, "discount_cents")
          : BigInt(updates.discountCents);
        const taxCents = updates.taxCents === undefined
          ? storedMoneyAsBigInt(po.taxCents, "tax_cents")
          : BigInt(updates.taxCents);
        const shippingCostCents = updates.shippingCostCents === undefined
          ? storedMoneyAsBigInt(po.shippingCostCents, "shipping_cost_cents")
          : BigInt(updates.shippingCostCents);
        const computedTotal = subtotal - discountCents + taxCents + shippingCostCents;
        if (computedTotal < BigInt(0)) {
          throw new PurchasingError(
            "Header discount cannot make the purchase order total negative",
            400,
            {
              code: "PO_TOTAL_NEGATIVE",
              subtotalCents: safeIntegerMoney(subtotal, "subtotal_cents"),
              discountCents: safeIntegerMoney(discountCents, "discount_cents"),
              taxCents: safeIntegerMoney(taxCents, "tax_cents"),
              shippingCostCents: safeIntegerMoney(shippingCostCents, "shipping_cost_cents"),
            },
          );
        }
        const subtotalCents = safeIntegerMoney(subtotal, "subtotal_cents");
        const totalCents = safeIntegerMoney(computedTotal, "total_cents");
        before.subtotal_cents = Number(po.subtotalCents ?? 0);
        before.total_cents = Number(po.totalCents ?? 0);
        after.subtotal_cents = subtotalCents;
        after.total_cents = totalCents;

        const updatedRows = await tx
          .update(purchaseOrdersTable)
          .set({
            ...patch,
            subtotalCents,
            totalCents,
            lineCount: lines.length,
            receivedLineCount,
            ...(userId ? { updatedBy: userId } : {}),
            updatedAt: sql`date_trunc('milliseconds', transaction_timestamp())`,
          })
          .where(and(...cleanDraftHeaderCasConditions(po)))
          .returning();
        const updated = updatedRows[0];
        if (!updated) {
          throw new PurchasingError("Purchase order changed while header charges were being applied", 409, {
            code: "PO_DRAFT_EDIT_CONFLICT",
          });
        }

        await emitPoEventTx(tx, id, "incoterms_charges_updated", userId, {
          changed_fields: changedFields,
          before,
          after,
        });
        return updated;
      });
  }

  // ── LINE MANAGEMENT ─────────────────────────────────────────────

  async function addLine(purchaseOrderId: number, data: {
    productId: number;
    productVariantId?: number | null;
    expectedReceiveVariantId?: number | null;
    expectedReceiveUnitsPerVariant?: number | null;
    vendorProductId?: number;
    orderQty: number;
    unitCostCents: number;
    unitCostMills?: number | null;
    totalProductCostCents?: number | null;
    packagingCostCents?: number | null;
    unitOfMeasure?: string;
    unitsPerUom?: number;
    discountPercent?: number;
    taxRatePercent?: number;
    expectedDeliveryDate?: Date;
    vendorSku?: string;
    description?: string;
    notes?: string;
  }, userId?: string) {
    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    if (!EDITABLE_STATUSES.has(po.status)) {
      throw new PurchasingError(`Cannot add lines to PO in '${po.status}' status`, 400);
    }

    // Cache product info. The PO buys product pieces; the variant is the
    // expected receive configuration used by receiving/AP downstream.
    const receiveVariantId = data.expectedReceiveVariantId ?? data.productVariantId ?? null;
    const variant = receiveVariantId ? await storage.getProductVariantById(receiveVariantId) : null;
    if (receiveVariantId && !variant) throw new PurchasingError("Expected receive variant not found", 404);
    const product = await storage.getProductById(data.productId);
    if (!product) throw new PurchasingError("Product not found", 404);

    // Determine next line number
    const existingLines = await storage.getPurchaseOrderLines(purchaseOrderId);
    const nextLineNumber = existingLines.length > 0
      ? Math.max(...existingLines.map((l: any) => l.lineNumber)) + 1
      : 1;

    const costs = calculateLineCosts({
      orderQty: data.orderQty,
      unitCostCents: data.unitCostCents,
      unitCostMills: data.unitCostMills,
      totalProductCostCents: data.totalProductCostCents,
      packagingCostCents: data.packagingCostCents,
      discountPercent: data.discountPercent,
      taxRatePercent: data.taxRatePercent,
    });

    const line = await storage.createPurchaseOrderLine({
      purchaseOrderId,
      lineNumber: nextLineNumber,
      productId: data.productId,
      productVariantId: receiveVariantId,
      expectedReceiveVariantId: receiveVariantId,
      vendorProductId: data.vendorProductId,
      sku: product.sku || variant?.sku,
      productName: product.name,
      vendorSku: data.vendorSku,
      description: data.description,
      unitOfMeasure: data.unitOfMeasure || variant?.name?.split(" ")[0]?.toLowerCase() || product.baseUnit,
      unitsPerUom: data.unitsPerUom || variant?.unitsPerVariant || 1,
      expectedReceiveUnitsPerVariant:
        data.expectedReceiveUnitsPerVariant || data.unitsPerUom || variant?.unitsPerVariant || 1,
      orderQty: data.orderQty,
      unitCostCents: costs.unitCostCents,
      unitCostMills: costs.unitCostMills,
      totalProductCostCents: costs.totalProductCostCents,
      packagingCostCents: costs.packagingCostCents,
      discountPercent: String(data.discountPercent || 0),
      taxRatePercent: String(data.taxRatePercent || 0),
      discountCents: costs.discountCents,
      taxCents: costs.taxCents,
      lineTotalCents: costs.lineTotalCents,
      expectedDeliveryDate: data.expectedDeliveryDate,
      notes: data.notes,
      status: "open",
    });

    await recalculateTotals(purchaseOrderId, userId);
    return line;
  }

  async function addBulkLines(purchaseOrderId: number, lines: Array<{
    productId: number;
    productVariantId?: number | null;
    expectedReceiveVariantId?: number | null;
    expectedReceiveUnitsPerVariant?: number | null;
    vendorProductId?: number;
    orderQty: number;
    unitCostCents: number;
    unitCostMills?: number | null;
    totalProductCostCents?: number | null;
    packagingCostCents?: number | null;
    unitOfMeasure?: string;
    vendorSku?: string;
    description?: string;
  }>, userId?: string) {
    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    if (!EDITABLE_STATUSES.has(po.status)) {
      throw new PurchasingError(`Cannot add lines to PO in '${po.status}' status`, 400);
    }

    const existingLines = await storage.getPurchaseOrderLines(purchaseOrderId);
    let nextLineNumber = existingLines.length > 0
      ? Math.max(...existingLines.map((l: any) => l.lineNumber)) + 1
      : 1;

    const lineData: any[] = [];
    for (const line of lines) {
      const receiveVariantId = line.expectedReceiveVariantId ?? line.productVariantId ?? null;
      const variant = receiveVariantId ? await storage.getProductVariantById(receiveVariantId) : null;
      if (receiveVariantId && !variant) throw new PurchasingError("Expected receive variant not found", 404);
      const product = await storage.getProductById(line.productId);
      if (!product) continue;

      const costs = calculateLineCosts({
        orderQty: line.orderQty,
        unitCostCents: line.unitCostCents,
        unitCostMills: line.unitCostMills,
        totalProductCostCents: line.totalProductCostCents,
        packagingCostCents: line.packagingCostCents,
      });

      lineData.push({
        purchaseOrderId,
        lineNumber: nextLineNumber++,
        productId: line.productId,
        productVariantId: receiveVariantId,
        expectedReceiveVariantId: receiveVariantId,
        vendorProductId: line.vendorProductId,
        sku: product.sku || variant?.sku,
        productName: product.name,
        vendorSku: line.vendorSku,
        description: line.description,
        unitOfMeasure: line.unitOfMeasure || "each",
        unitsPerUom: variant?.unitsPerVariant || 1,
        expectedReceiveUnitsPerVariant:
          line.expectedReceiveUnitsPerVariant || variant?.unitsPerVariant || 1,
        orderQty: line.orderQty,
        unitCostCents: costs.unitCostCents,
        unitCostMills: costs.unitCostMills,
        totalProductCostCents: costs.totalProductCostCents,
        packagingCostCents: costs.packagingCostCents,
        lineTotalCents: costs.lineTotalCents,
        discountCents: costs.discountCents,
        taxCents: costs.taxCents,
        status: "open",
      });
    }

    const created = await storage.bulkCreatePurchaseOrderLines(lineData);
    await recalculateTotals(purchaseOrderId, userId);
    return created;
  }

  async function updateLine(lineId: number, updates: Record<string, any>, userId?: string) {
    const line = await storage.getPurchaseOrderLineById(lineId);
    if (!line) throw new PurchasingError("PO line not found", 404);

    const po = await storage.getPurchaseOrderById(line.purchaseOrderId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    if (!LINE_AMENDABLE_STATUSES.has(po.status)) {
      throw new PurchasingError(`Cannot edit lines on PO in '${po.status}' status`, 400);
    }

    const recommendationHandoff = await storage.getRecommendationPoHandoffForLine(lineId);
    if (recommendationHandoff) {
      throw new PurchasingError(
        "Cannot amend a recommendation-created PO line; cancel the PO and accept a new recommendation",
        409,
        { code: "RECOMMENDATION_PO_LINE_AMEND_BLOCKED", handoffId: recommendationHandoff.id },
      );
    }

    const normalizedUpdates = { ...updates };
    const receiveVariantId =
      normalizedUpdates.expectedReceiveVariantId ??
      normalizedUpdates.productVariantId ??
      null;

    if (
      normalizedUpdates.expectedReceiveUnitsPerVariant !== undefined &&
      normalizedUpdates.expectedReceiveUnitsPerVariant !== null &&
      (
        !Number.isInteger(normalizedUpdates.expectedReceiveUnitsPerVariant) ||
        normalizedUpdates.expectedReceiveUnitsPerVariant <= 0
      )
    ) {
      throw new PurchasingError("expected_receive_units_per_variant must be a positive integer", 400);
    }

    if (receiveVariantId !== null) {
      if (!Number.isInteger(receiveVariantId) || receiveVariantId <= 0) {
        throw new PurchasingError("expected_receive_variant_id must be a positive integer", 400);
      }
      const variant = await storage.getProductVariantById(receiveVariantId);
      if (!variant) throw new PurchasingError("Expected receive variant not found", 404);

      normalizedUpdates.productVariantId = receiveVariantId;
      normalizedUpdates.expectedReceiveVariantId = receiveVariantId;
      normalizedUpdates.unitsPerUom =
        normalizedUpdates.unitsPerUom ?? variant.unitsPerVariant ?? 1;
      normalizedUpdates.expectedReceiveUnitsPerVariant =
        normalizedUpdates.expectedReceiveUnitsPerVariant ??
        variant.unitsPerVariant ??
        1;
    }

    const updated = await storage.updatePurchaseOrderLine(lineId, normalizedUpdates);

    // Cascade receive-configuration/SKU changes to downstream records.
    if (
      normalizedUpdates.productVariantId ||
      normalizedUpdates.expectedReceiveVariantId ||
      normalizedUpdates.sku
    ) {
      const newVariantId =
        normalizedUpdates.expectedReceiveVariantId ??
        normalizedUpdates.productVariantId ??
        line.expectedReceiveVariantId ??
        line.productVariantId;
      const newSku = normalizedUpdates.sku ?? line.sku;
      if (!newVariantId) {
        console.warn(`[Purchasing] Skipped receive config cascade for PO line ${lineId}: no receive variant`);
        await recalculateTotals(line.purchaseOrderId, userId);
        return updated;
      }
      try {
        // Look up the receive configuration's units-per-variant for carton recalc.
        const newVariant = await storage.getProductVariantById(newVariantId);
        const newUpc = newVariant?.unitsPerVariant ?? 1;

        // Inbound shipment lines linked to this PO line — update variant, SKU, and recalc cartons
        const affectedShipmentLines = await db.select()
          .from(inboundShipmentLines)
          .where(eq(inboundShipmentLines.purchaseOrderLineId, lineId));
        for (const sl of affectedShipmentLines) {
          const newCartons = newUpc > 1 ? Math.ceil(sl.qtyShipped / newUpc) : null;
          await db.update(inboundShipmentLines)
            .set({ productVariantId: newVariantId, sku: newSku, cartonCount: newCartons, updatedAt: new Date() })
            .where(eq(inboundShipmentLines.id, sl.id));
        }
        // Landed cost snapshots
        await db.update(landedCostSnapshots)
          .set({ productVariantId: newVariantId })
          .where(eq(landedCostSnapshots.purchaseOrderLineId, lineId));
        // Vendor invoice lines
        await db.update(vendorInvoiceLines)
          .set({ productVariantId: newVariantId })
          .where(eq(vendorInvoiceLines.purchaseOrderLineId, lineId));
        console.log(`[Purchasing] Cascaded receive config change on PO line ${lineId}: variant=${newVariantId} sku=${newSku} upc=${newUpc}`);
      } catch (err: any) {
        console.warn(`[Purchasing] Failed to cascade receive config change for PO line ${lineId}: ${err.message}`);
      }
    }

    await recalculateTotals(line.purchaseOrderId, userId);
    return updated;
  }

  async function deleteLine(lineId: number, userId?: string) {
    const line = await storage.getPurchaseOrderLineById(lineId);
    if (!line) throw new PurchasingError("PO line not found", 404);

    const po = await storage.getPurchaseOrderById(line.purchaseOrderId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    if (!EDITABLE_STATUSES.has(po.status)) {
      throw new PurchasingError(`Cannot delete lines on PO in '${po.status}' status`, 400);
    }

    const recommendationHandoff = await storage.getRecommendationPoHandoffForLine(lineId);
    if (recommendationHandoff) {
      throw new PurchasingError(
        "Cannot delete a recommendation-created PO line; cancel the PO and accept a new recommendation",
        409,
        { code: "RECOMMENDATION_PO_LINE_DELETE_BLOCKED", handoffId: recommendationHandoff.id },
      );
    }

    await storage.deletePurchaseOrderLine(lineId);
    await recalculateTotals(line.purchaseOrderId, userId);
    return true;
  }

  // ── STATUS TRANSITIONS ──────────────────────────────────────────

  async function writeLifecycleAuditTx(
    tx: any,
    purchaseOrderId: number,
    histories: Array<{
      fromStatus: string | null;
      toStatus: string;
      changedBy?: string;
      notes?: string;
    }>,
    events: Array<{ type: string; payload: Record<string, unknown> }>,
    userId?: string,
  ): Promise<void> {
    for (const history of histories) {
      await tx.insert(poStatusHistoryTable).values({
        purchaseOrderId,
        ...history,
        changedBy: history.changedBy ?? userId ?? null,
      });
    }
    for (const event of events) {
      await emitPoEventTx(tx, purchaseOrderId, event.type, userId, event.payload);
    }
  }

  async function moveLockedPoToPendingApproval(
    tx: any,
    economics: LockedLifecycleEconomics,
    tier: any,
    userId?: string,
    approvalInvalidated = false,
  ): Promise<any> {
    const fromStatus = economics.po.status;
    const updated = await updateLockedLifecycleHeader(tx, economics, {
      ...lifecycleTotalsPatch(economics),
      status: "pending_approval",
      physicalStatus: "draft",
      approvalTierId: tier.id,
      approvedBy: null,
      approvedAt: null,
      approvalNotes: null,
      updatedBy: userId ?? null,
    });
    await writeLifecycleAuditTx(
      tx,
      economics.po.id,
      [{
        fromStatus,
        toStatus: "pending_approval",
        notes: approvalInvalidated
          ? `Approval invalidated by changed economics; ${tier.tierName} approval is required`
          : `Approval required: ${tier.tierName}`,
      }],
      [{
        type: "submitted",
        payload: {
          from_status: fromStatus,
          to_status: "pending_approval",
          tier_id: tier.id,
          tier_name: tier.tierName,
          total_cents: economics.totalCents,
          approval_invalidated: approvalInvalidated,
        },
      }],
      userId,
    );
    return updated;
  }

  type LockedSendResult = {
    po: any;
    status: "pending_approval" | "sent";
    pendingApproval: boolean;
  };

  async function sendWithLockedEconomics(
    poId: number,
    userId: string | undefined,
    expectation: LifecycleExpectation,
    options: {
      allowDraft: boolean;
      soloModeOnly: boolean;
      sentNotes: string;
    },
  ): Promise<LockedSendResult> {
    return db.transaction(async (tx: any) => {
      const economics = await lockLifecycleEconomics(tx, poId, expectation);
      const po = economics.po;
      if (po.status !== "approved" && !(options.allowDraft && po.status === "draft")) {
        throw new PurchasingError(
          `Cannot send PO in '${po.status}' status`,
          409,
          { code: "PO_LIFECYCLE_CONFLICT" },
        );
      }
      if ((po.physicalStatus ?? "draft") !== "draft") {
        throw new PurchasingError(
          `Cannot send PO with physical status '${po.physicalStatus}'`,
          409,
          { code: "PO_LIFECYCLE_PHYSICAL_CONFLICT" },
        );
      }

      await assertLifecycleQuotesReadyTx(tx, economics);

      let requireApproval = false;
      if (options.soloModeOnly) {
        const activeTiers = await getActiveApprovalTiersTx(tx);
        if (activeTiers.length > 0) {
          throw new PurchasingError(
            "Approval tiers are configured. Use the individual Submit/Approve/Send steps.",
            400,
          );
        }
      } else {
        const settings = await getProcurementSettingsTx(tx);
        requireApproval = settings.requireApproval;
      }

      const tier = requireApproval
        ? await getMatchingApprovalTierTx(tx, economics.totalCents)
        : null;
      if (tier) {
        if (po.status === "draft") {
          const pendingPo = await moveLockedPoToPendingApproval(tx, economics, tier, userId);
          return { po: pendingPo, status: "pending_approval", pendingApproval: true };
        }
        if (!approvalCoversLockedEconomics(economics, tier)) {
          const pendingPo = await moveLockedPoToPendingApproval(
            tx,
            economics,
            tier,
            userId,
            true,
          );
          return { po: pendingPo, status: "pending_approval", pendingApproval: true };
        }
      }

      const dbTimestamp = sql`date_trunc('milliseconds', transaction_timestamp())`;
      const autoApproved = po.status === "draft";
      const approvalNotes = requireApproval
        ? "Auto-approved (no matching tier)"
        : options.soloModeOnly
          ? "Auto-approved (solo mode - no approval tiers)"
          : "Auto-approved (approval not required)";
      const updated = await updateLockedLifecycleHeader(tx, economics, {
        ...lifecycleTotalsPatch(economics),
        status: "sent",
        physicalStatus: "sent",
        ...(autoApproved ? {
          approvedBy: userId ?? null,
          approvedAt: dbTimestamp,
          approvalNotes,
          approvalTierId: null,
        } : {}),
        sentToVendorAt: dbTimestamp,
        orderDate: po.orderDate ?? dbTimestamp,
        updatedBy: userId ?? null,
      });

      const histories: Array<{ fromStatus: string | null; toStatus: string; notes?: string }> = [];
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      if (autoApproved) {
        histories.push({ fromStatus: "draft", toStatus: "approved", notes: approvalNotes });
        events.push({
          type: "approved",
          payload: {
            from_status: "draft",
            to_status: "approved",
            auto: true,
            require_approval: requireApproval,
            total_cents: economics.totalCents,
          },
        });
      }
      histories.push({ fromStatus: "approved", toStatus: "sent", notes: options.sentNotes });
      events.push({
        type: "sent_to_vendor",
        payload: {
          method: "pdf_placeholder",
          pdf_placeholder: true,
          total_cents: economics.totalCents,
        },
      });
      await writeLifecycleAuditTx(tx, poId, histories, events, userId);
      return { po: updated, status: "sent", pendingApproval: false };
    });
  }

  async function submit(id: number, userId?: string) {
    const expectation = await observeLifecycleState(
      id,
      ["draft"],
      (status) => `Cannot submit PO in '${status}' status`,
    );
    return db.transaction(async (tx: any) => {
      const economics = await lockLifecycleEconomics(tx, id, expectation);
      await assertLifecycleQuotesReadyTx(tx, economics);
      const tier = await getMatchingApprovalTierTx(tx, economics.totalCents);
      if (tier) {
        return moveLockedPoToPendingApproval(tx, economics, tier, userId);
      }

      const dbTimestamp = sql`date_trunc('milliseconds', transaction_timestamp())`;
      const updated = await updateLockedLifecycleHeader(tx, economics, {
        ...lifecycleTotalsPatch(economics),
        status: "approved",
        approvalTierId: null,
        approvedBy: userId ?? null,
        approvedAt: dbTimestamp,
        approvalNotes: "Auto-approved (below approval threshold)",
        updatedBy: userId ?? null,
      });
      await writeLifecycleAuditTx(
        tx,
        id,
        [{ fromStatus: "draft", toStatus: "approved", notes: "Auto-approved (below threshold)" }],
        [{
          type: "approved",
          payload: {
            from_status: "draft",
            to_status: "approved",
            auto: true,
            reason: "below_threshold",
            total_cents: economics.totalCents,
          },
        }],
        userId,
      );
      return updated;
    });
  }

  async function returnToDraft(id: number, userId?: string, notes?: string) {
    const expectation = await observeLifecycleState(
      id,
      ["pending_approval"],
      (status) => `Cannot return PO in '${status}' status to draft`,
    );
    return db.transaction(async (tx: any) => {
      const economics = await lockLifecycleEconomics(tx, id, expectation);
      const updated = await updateLockedLifecycleHeader(tx, economics, {
        ...lifecycleTotalsPatch(economics),
        status: "draft",
        physicalStatus: "draft",
        approvalTierId: null,
        approvedBy: null,
        approvedAt: null,
        approvalNotes: null,
        updatedBy: userId ?? null,
      });
      await writeLifecycleAuditTx(
        tx,
        id,
        [{
          fromStatus: economics.po.status,
          toStatus: "draft",
          notes: notes || "Returned to draft",
        }],
        [{
          type: "returned_to_draft",
          payload: {
            from_status: economics.po.status,
            to_status: "draft",
            notes: notes ?? null,
            total_cents: economics.totalCents,
          },
        }],
        userId,
      );
      return updated;
    });
  }

  async function approve(id: number, userId?: string, notes?: string) {
    const expectation = await observeLifecycleState(
      id,
      ["draft", "pending_approval"],
      (status) => `Cannot approve PO in '${status}' status`,
    );
    return db.transaction(async (tx: any) => {
      const economics = await lockLifecycleEconomics(tx, id, expectation);
      await assertLifecycleQuotesReadyTx(tx, economics);
      const currentTier = await getMatchingApprovalTierTx(tx, economics.totalCents);
      if (
        economics.po.status === "pending_approval" &&
        currentTier &&
        Number(economics.po.approvalTierId) !== Number(currentTier.id)
      ) {
        throw new PurchasingError(
          "Purchase order economics changed to a different approval tier; submit it again",
          409,
          {
            code: "PO_APPROVAL_TIER_CHANGED",
            previousTierId: economics.po.approvalTierId ?? null,
            currentTierId: currentTier.id,
            totalCents: economics.totalCents,
          },
        );
      }

      const dbTimestamp = sql`date_trunc('milliseconds', transaction_timestamp())`;
      const updated = await updateLockedLifecycleHeader(tx, economics, {
        ...lifecycleTotalsPatch(economics),
        status: "approved",
        approvalTierId: currentTier?.id ?? economics.po.approvalTierId ?? null,
        approvedBy: userId ?? null,
        approvedAt: dbTimestamp,
        approvalNotes: notes ?? null,
        updatedBy: userId ?? null,
      });
      await writeLifecycleAuditTx(
        tx,
        id,
        [{ fromStatus: economics.po.status, toStatus: "approved", notes: notes || "Approved" }],
        [{
          type: "approved",
          payload: {
            from_status: economics.po.status,
            to_status: "approved",
            notes: notes ?? null,
            tier_id: currentTier?.id ?? economics.po.approvalTierId ?? null,
            total_cents: economics.totalCents,
          },
        }],
        userId,
      );
      return updated;
    });
  }

  async function send(id: number, userId?: string) {
    const expectation = await observeLifecycleState(
      id,
      ["approved"],
      (status) => `Cannot send PO in '${status}' status`,
    );
    const result = await sendWithLockedEconomics(id, userId, expectation, {
      allowDraft: false,
      soloModeOnly: false,
      sentNotes: "Sent to vendor",
    });
    return result.po;
  }

  /**
   * Combined "Send to Vendor" flow for solo mode (no approval tiers configured).
   * Saves → auto-approves → sets status to "sent" in one operation.
   * Returns the updated PO. Caller can then optionally open the email dialog.
   */
  async function sendToVendor(id: number, userId?: string) {
    const expectation = await observeLifecycleState(
      id,
      ["draft", "approved"],
      (status) => `Cannot send-to-vendor from '${status}' status. Use individual steps.`,
    );
    const result = await sendWithLockedEconomics(id, userId, expectation, {
      allowDraft: true,
      soloModeOnly: true,
      sentNotes: "Sent to vendor (solo mode)",
    });
    return result.po;
  }

  async function acknowledge(id: number, data: { vendorRefNumber?: string; confirmedDeliveryDate?: Date }, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "acknowledged");

    if (data.confirmedDeliveryDate !== undefined) {
      const issues = validateDeliverySchedulePatch(po, {
        confirmedDeliveryDate: data.confirmedDeliveryDate,
      });
      if (issues.length > 0) {
        const issue = issues[0];
        throw new PurchasingError(issue.message, 400, issue);
      }
    }

    const result = await transitionPhysical(id, "acknowledged", userId, "Vendor acknowledged", {
      vendorAckDate: new Date(),
      vendorRefNumber: data.vendorRefNumber,
      confirmedDeliveryDate: data.confirmedDeliveryDate,
    });

    return result;
  }

  async function cancel(id: number, reason: string, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    if (!reason) throw new PurchasingError("Cancel reason is required", 400);

    if (!CANCELLABLE_FROM.has(po.status) && !VOIDABLE_FROM.has(po.status)) {
      throw new PurchasingError(`Cannot cancel/void PO in '${po.status}' status`, 400);
    }

    const lines = await storage.getPurchaseOrderLines(id);
    const change = (() => {
      try {
        return buildPhysicalTransitionChange({
          po,
          target: "cancelled",
          userId,
          notes: reason,
          extraPatch: { cancelReason: reason },
        });
      } catch (error) {
        return toPurchasingError(error);
      }
    })();

    const result = await db.transaction(async (tx: any) => {
      for (const line of lines) {
        if (line.status === "open") {
          await updatePurchaseOrderLineTx(tx, line.id, {
            status: "cancelled",
            cancelledQty: line.orderQty,
          });
        }
      }

      const updated = await updatePurchaseOrderStatusWithHistoryTx(
        tx,
        id,
        change.patch,
        change.history,
      );
      await emitPoEventTx(tx, id, "cancelled", userId, {
        from_status: change.history.fromStatus,
        to_status: change.history.toStatus,
        physical_status: "cancelled",
        reason,
      });
      return updated;
    });

    try {
      await detectPastDue(id);
    } catch (detectionErr) {
      console.error("[po-exceptions] detection hook failed in cancel:", detectionErr);
    }

    return result;
  }

  /**
   * Close a PO.
   *
   * Before closing, checks for 3-way match discrepancies on any linked
   * vendor invoices. If any invoice line has a match_status that is not
   * 'matched' or 'pending', the close is refused with a 409 error.
   *
   * There is no forceOverride flag on close(). To close despite mismatches,
   * use closeShort(reason) which records per-line close-short reasons and
   * is the single "close with known issues" path.
   */
  async function persistCompletedVendorPurchaseEvidenceTx(
    tx: any,
    purchaseOrderId: number,
    purchasedAt: Date,
    userId?: string,
  ): Promise<void> {
    const purchasedLines = await tx
      .select({
        vendorProductId: purchaseOrderLinesTable.vendorProductId,
        unitCostCents: purchaseOrderLinesTable.unitCostCents,
        unitCostMills: purchaseOrderLinesTable.unitCostMills,
        receivedQty: purchaseOrderLinesTable.receivedQty,
      })
      .from(purchaseOrderLinesTable)
      .where(and(
        eq(purchaseOrderLinesTable.purchaseOrderId, purchaseOrderId),
        eq(purchaseOrderLinesTable.lineType, "product"),
        ne(purchaseOrderLinesTable.status, "cancelled"),
        sql`${purchaseOrderLinesTable.vendorProductId} IS NOT NULL`,
        sql`${purchaseOrderLinesTable.receivedQty} > 0`,
      ));

    const totalsByVendorProductId = new Map<
      number,
      { extendedCostMills: bigint; receivedQty: bigint }
    >();
    for (const line of purchasedLines) {
      const vendorProductId = Number(line.vendorProductId);
      if (!Number.isSafeInteger(vendorProductId) || vendorProductId <= 0) continue;
      const receivedQty = BigInt(line.receivedQty ?? 0);
      if (receivedQty <= BigInt(0)) continue;
      const unitCostMills = BigInt(
        line.unitCostMills ?? centsToMills(Number(line.unitCostCents ?? 0)),
      );
      const current = totalsByVendorProductId.get(vendorProductId) ?? {
        extendedCostMills: BigInt(0),
        receivedQty: BigInt(0),
      };
      current.extendedCostMills += unitCostMills * receivedQty;
      current.receivedQty += receivedQty;
      totalsByVendorProductId.set(vendorProductId, current);
    }
    const costByVendorProductId = new Map<
      number,
      { lastCostMills: number; lastCostCents: number }
    >();
    for (const [vendorProductId, totals] of totalsByVendorProductId) {
      const roundedUnitCostMills =
        (totals.extendedCostMills * BigInt(2) + totals.receivedQty) /
        (totals.receivedQty * BigInt(2));
      const lastCostMills = safeIntegerMoney(roundedUnitCostMills, "last_cost_mills");
      costByVendorProductId.set(vendorProductId, {
        lastCostMills,
        lastCostCents: millsToCents(lastCostMills),
      });
    }
    if (costByVendorProductId.size === 0) return;

    const vendorProductIds = [...costByVendorProductId.keys()];
    const currentRows = await tx
      .select()
      .from(vendorProductsTable)
      .where(inArray(vendorProductsTable.id, vendorProductIds))
      .for("update");
    const { actorType, actorId } = resolveActor(userId);
    const auditRows: Array<Record<string, unknown>> = [];

    for (const current of currentRows) {
      const priorPurchasedAt = current.lastPurchasedAt instanceof Date
        ? current.lastPurchasedAt
        : current.lastPurchasedAt
          ? new Date(current.lastPurchasedAt)
          : null;
      if (
        priorPurchasedAt &&
        !Number.isNaN(priorPurchasedAt.getTime()) &&
        priorPurchasedAt.getTime() > purchasedAt.getTime()
      ) {
        continue;
      }
      const lastCost = costByVendorProductId.get(Number(current.id));
      if (!lastCost) continue;
      const updatedRows = await tx
        .update(vendorProductsTable)
        .set({
          lastPurchasedAt: purchasedAt,
          lastCostMills: lastCost.lastCostMills,
          lastCostCents: lastCost.lastCostCents,
          updatedAt: now(),
        })
        .where(eq(vendorProductsTable.id, Number(current.id)))
        .returning();
      const updated = updatedRows[0];
      if (!updated) {
        throw new PurchasingError("Supplier purchase evidence could not be updated", 409, {
          code: "VENDOR_CATALOG_PURCHASE_EVIDENCE_CONFLICT",
          vendorProductId: Number(current.id),
        });
      }
      auditRows.push({
        level: "AUDIT",
        actor: `${actorType}:${actorId}`,
        action: "vendor_catalog.purchase_evidence_updated",
        target: `vendor_product:${updated.id}`,
        changes: {
          before: catalogAuditSnapshot(current),
          after: catalogAuditSnapshot(updated),
        },
        context: {
          purchaseOrderId,
          vendorProductId: updated.id,
          vendorId: updated.vendorId,
          productId: updated.productId,
          productVariantId: updated.productVariantId ?? null,
        },
      });
    }

    if (auditRows.length > 0) {
      await tx.insert(auditEventsTable).values(auditRows);
    }
  }

  async function close(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    // ── 3-way match gate ────────────────────────────────────────────
    // Check linked invoices for match discrepancies before allowing close.
    // This replaces the former payment-time gate; receipts exist by close
    // time so the match is actually possible.
    const poLinks = await db
      .select({ vendorInvoiceId: vendorInvoicePoLinksTable.vendorInvoiceId })
      .from(vendorInvoicePoLinksTable)
      .where(eq(vendorInvoicePoLinksTable.purchaseOrderId, id));

    if (poLinks.length > 0) {
      const invoiceIds = [...new Set(poLinks.map((l: any) => l.vendorInvoiceId as number))] as number[];

      const mismatchedLines: Array<{ invoiceId: number; invoiceNumber: string; matchStatus: string }> = await db
        .select({
          invoiceId: vendorInvoiceLines.vendorInvoiceId,
          invoiceNumber: vendorInvoicesTable.invoiceNumber,
          matchStatus: vendorInvoiceLines.matchStatus,
        })
        .from(vendorInvoiceLines)
        .innerJoin(vendorInvoicesTable, eq(vendorInvoiceLines.vendorInvoiceId, vendorInvoicesTable.id))
        .where(
          and(
            inArray(vendorInvoiceLines.vendorInvoiceId, invoiceIds),
            sql`${vendorInvoiceLines.matchStatus} NOT IN ('matched', 'pending')`,
          ),
        );

      if (mismatchedLines.length > 0) {
        // Refresh exceptions on each linked invoice so the PO detail page
        // shows the discrepancy before the user tries close-short.
        for (const invId of invoiceIds) {
          await detectMatchMismatch(invId as number);
        }

        const invoiceNumbers = [...new Set(mismatchedLines.map((l) => l.invoiceNumber))];
        throw new PurchasingError(
          `Cannot close PO — 3-way match discrepancy. Invoice${invoiceNumbers.length !== 1 ? "s" : ""} ${invoiceNumbers.join(", ")} have ${mismatchedLines.length} line${mismatchedLines.length !== 1 ? "s" : ""} with match issues. Use close-short (with reason) to close anyway.`,
          409,
        );
      }
    }

    const change = (() => {
      try {
        return buildPoCloseChange({ po, userId, notes });
      } catch (error) {
        return toPurchasingError(error);
      }
    })();

    return db.transaction(async (tx: any) => {
      const updated = await updatePurchaseOrderStatusWithHistoryTx(
        tx,
        id,
        change.patch,
        change.history,
      );
      await emitPoEventTx(tx, id, "closed", userId, {
        from_status: change.history.fromStatus,
        to_status: change.history.toStatus,
        notes: notes ?? null,
      });
      await persistCompletedVendorPurchaseEvidenceTx(
        tx,
        id,
        change.patch.closedAt instanceof Date ? change.patch.closedAt : now(),
        userId,
      );
      return updated;
    });
  }

  async function closeShort(id: number, reason: string, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    if (!reason) throw new PurchasingError("Close-short reason is required", 400);

    const lines = await storage.getPurchaseOrderLines(id);

    const change = (() => {
      try {
        return buildPoCloseShortChange({ po, reason, userId });
      } catch (error) {
        return toPurchasingError(error);
      }
    })();

    return db.transaction(async (tx: any) => {
      for (const line of lines) {
        const linePatch = buildPoCloseShortLinePatch(line, reason);
        if (linePatch) {
          await updatePurchaseOrderLineTx(tx, line.id, linePatch);
        }
      }

      const updated = await updatePurchaseOrderStatusWithHistoryTx(
        tx,
        id,
        change.patch,
        change.history,
      );
      await emitPoEventTx(tx, id, "closed_short", userId, {
        from_status: change.history.fromStatus,
        to_status: change.history.toStatus,
        reason,
      });
      await persistCompletedVendorPurchaseEvidenceTx(
        tx,
        id,
        change.patch.closedAt instanceof Date ? change.patch.closedAt : now(),
        userId,
      );
      return updated;
    });
  }

  // ── LIFECYCLE COMMAND DISPATCH ─────────────────────────────────

  async function executeLifecycleCommand(
    id: number,
    command: PoLifecycleCommand,
    input: PoLifecycleCommandInput = {},
    userId?: string,
  ) {
    switch (command) {
      case "submit":
        return submit(id, userId);
      case "return_to_draft":
        return returnToDraft(id, userId, input.notes);
      case "approve":
        return approve(id, userId, input.notes);
      case "send":
        return send(id, userId);
      case "send_to_vendor":
        return sendToVendor(id, userId);
      case "acknowledge":
        return acknowledge(
          id,
          {
            vendorRefNumber: input.vendorRefNumber,
            confirmedDeliveryDate: input.confirmedDeliveryDate,
          },
          userId,
        );
      case "mark_shipped":
        return transitionPhysical(id, "shipped", userId, input.notes);
      case "mark_in_transit":
        return transitionPhysical(id, "in_transit", userId, input.notes);
      case "mark_arrived":
        return transitionPhysical(id, "arrived", userId, input.notes);
      case "create_receipt":
        return createReceiptFromPO(id, userId);
      case "cancel":
        return cancel(id, input.reason ?? "", userId);
      case "close":
        return close(id, userId, input.notes);
      case "close_short":
        return closeShort(id, input.reason ?? "", userId);
      default: {
        const exhaustive: never = command;
        throw new PurchasingError(`Unknown PO lifecycle command '${exhaustive}'`, 400, {
          command: exhaustive,
        });
      }
    }
  }

  // ── RECEIVING INTEGRATION ───────────────────────────────────────

  async function createReceiptFromPO(purchaseOrderId: number, userId?: string) {
    return await db.transaction(async (tx: any) => {
      if (typeof tx.execute === "function") {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtext('procurement.create_receipt_from_po'),
            ${purchaseOrderId}
          )
        `);
      }
      return await createReceiptFromPOUnlocked(purchaseOrderId, userId);
    });
  }

  async function getReusableReceiptForPO(purchaseOrderId: number) {
    const existingReceipts =
      typeof storage.getReceivingOrdersForPurchaseOrder === "function"
        ? await storage.getReceivingOrdersForPurchaseOrder(purchaseOrderId)
        : [];

    return existingReceipts.find((receipt: any) =>
      ["draft", "open", "receiving", "verified"].includes(receipt.status),
    );
  }

  async function createReceiptFromPOUnlocked(purchaseOrderId: number, userId?: string) {
    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    const openStatuses = ["sent", "acknowledged", "partially_received"];
    if (!openStatuses.includes(po.status)) {
      throw new PurchasingError(`Cannot create receipt for PO in '${po.status}' status`, 400);
    }

    const reusableReceipt = await getReusableReceiptForPO(purchaseOrderId);
    if (reusableReceipt) {
      return { ...reusableReceipt, reusedExisting: true };
    }

    const lines = await storage.getPurchaseOrderLines(purchaseOrderId);
    const receivableLines = lines.filter((l: any) =>
      // Only product lines are physically received. Discount/fee/tax/rebate/
      // adjustment lines are accounting-only and never create inventory.
      // Rows without lineType (pre-migration-0563) default to 'product'.
      ((l.lineType ?? "product") === "product") &&
      (l.status === "open" || l.status === "partially_received") &&
      (l.orderQty - (l.receivedQty || 0) - (l.cancelledQty || 0)) > 0
    );

    if (receivableLines.length === 0) {
      throw new PurchasingError("No receivable lines on this PO", 400);
    }

    // Create receiving order
    const receiptNumber = await storage.generateReceiptNumber();
    let receivingOrder;
    try {
      receivingOrder = await storage.createReceivingOrder({
        receiptNumber,
        poNumber: po.poNumber,
        purchaseOrderId: po.id,
        sourceType: "po",
        vendorId: po.vendorId,
        warehouseId: po.warehouseId,
        status: "draft",
        expectedDate: po.expectedDeliveryDate || po.confirmedDeliveryDate,
        createdBy: userId,
      });
    } catch (error: any) {
      if (error?.code === "23505") {
        const conflictReceipt = await getReusableReceiptForPO(purchaseOrderId);
        if (conflictReceipt) {
          return { ...conflictReceipt, reusedExisting: true };
        }

        throw new PurchasingError(
          `Receipt number '${receiptNumber}' already in use by an active record.`,
          409,
        );
      }
      throw error;
    }

    // Auto-assign putaway locations from product_locations if available
    let productLocationMap = new Map<number, number>(); // productVariantId → warehouseLocationId
    try {
      const allProductLocations = await (storage as any).getAllProductLocations?.() ?? [];
      for (const pl of allProductLocations) {
        if (pl.productVariantId && pl.warehouseLocationId && pl.status === "active" && pl.isPrimary) {
          // Only use primary active locations
          if (!productLocationMap.has(pl.productVariantId)) {
            productLocationMap.set(pl.productVariantId, pl.warehouseLocationId);
          }
        }
      }
    } catch {
      // Non-critical — if product_locations lookup fails, just skip auto-assign
    }

    // The divisor that turns ordered pieces into receive-pack (case) counts
    // MUST come from the SAME variant we stamp on the line. Previously packSize
    // was sourced from poLine.expectedReceiveUnitsPerVariant/unitsPerUom, a
    // field that can be unset (→ 1) even when expectedReceiveVariantId points
    // at a "Case of N" variant — so we stamped the case variant but divided by
    // 1, showing ordered PIECES labeled as cases (269640 pieces → "269640
    // cases" instead of 360; RCV-20260710-003). Look up each resolved
    // variant's authoritative unitsPerVariant so variant and divisor can never
    // disagree — the same discipline createReceiptFromShipment and the client's
    // applyVariant already use.
    const poUnitsPerVariantById = new Map<number, number>();
    for (const poLine of receivableLines) {
      const variantId = poLine.expectedReceiveVariantId ?? poLine.productVariantId ?? null;
      if (variantId && !poUnitsPerVariantById.has(variantId)) {
        try {
          const variant = await storage.getProductVariantById(variantId);
          if (variant) {
            poUnitsPerVariantById.set(variantId, Math.max(1, variant.unitsPerVariant || 1));
          }
        } catch { /* non-critical: fall back to PO receive units below */ }
      }
    }

    // Create receiving lines from PO lines.
    //
    // Stamp BOTH cents and mills on the new receiving_line so receive-time
    // precision matches the PO line. Mills is authoritative when present;
    // otherwise we derive mills from cents via centsToMills (no rounding).
    // Keeps receiving_lines consistent with the (post-0562) contract in
    // receiving.service.ts: mills is the source of truth, cents mirrors.
    const receivingLineData = receivableLines.map((poLine: any) => {
      const resolvedVariantId =
        poLine.expectedReceiveVariantId ?? poLine.productVariantId ?? null;
      // Prefer the stamped variant's own unitsPerVariant; only fall back to the
      // PO's UOM fields when the variant is unknown/unresolvable.
      const packSize =
        (resolvedVariantId ? poUnitsPerVariantById.get(resolvedVariantId) : undefined) ??
        poLine.expectedReceiveUnitsPerVariant ??
        poLine.unitsPerUom ??
        1;
      const autoLocationId = (resolvedVariantId && productLocationMap.get(resolvedVariantId)) || null;
      const hasPoMills =
        typeof poLine.unitCostMills === "number" &&
        Number.isInteger(poLine.unitCostMills) &&
        poLine.unitCostMills >= 0;
      const unitCostMills = hasPoMills
        ? (poLine.unitCostMills as number)
        : (typeof poLine.unitCostCents === "number" && poLine.unitCostCents >= 0
            ? centsToMills(poLine.unitCostCents)
            : null);
      const unitCost = hasPoMills
        ? millsToCents(poLine.unitCostMills as number)
        : (typeof poLine.unitCostCents === "number" ? poLine.unitCostCents : null);
      return {
        receivingOrderId: receivingOrder.id,
        productVariantId: resolvedVariantId,
        productId: poLine.productId,
        sku: poLine.sku,
        productName: poLine.productName,
        expectedQty: Math.ceil(
          (poLine.orderQty - (poLine.receivedQty || 0) - (poLine.cancelledQty || 0)) / packSize
        ),
        receivedQty: 0,
        damagedQty: 0,
        purchaseOrderLineId: poLine.id,
        unitCost,
        unitCostMills,
        putawayLocationId: autoLocationId,
        status: "pending",
      };
    });

    await storage.bulkCreateReceivingLines(receivingLineData);
    return receivingOrder;
  }

  type ShipmentReceiptExistingState =
    | { kind: "none" }
    | { kind: "active"; receipt: any }
    | { kind: "empty_active"; receipt: any; lineCount: 0 }
    | { kind: "zero_post_closed"; receipt: any; summary: ShipmentReceiptPostingSummary }
    | { kind: "closed"; receipt: any };

  type ShipmentReceiveOption = {
    shipmentId: number;
    shipmentNumber: string | null;
    status: string | null;
    purchaseOrderId: number;
    lineCount: number;
    qtyShipped: number;
    receivedBaseQty: number;
    remainingBaseQty: number;
    missingPurchaseOrderLineCount: number;
    receivable: boolean;
    action: "create_receipt" | "open_existing_receipt" | "repair_empty_receipt" | "void_zero_post_receipt" | "blocked";
    reason: string | null;
    freightWillCarry: boolean;
    estimatedTotalCostCents: number | null;
    actualTotalCostCents: number | null;
    existingReceiptId: number | null;
    existingReceiptStatus: string | null;
    existingReceiptLineCount: number | null;
  };

  type ShipmentReceiptPostingSummary = {
    lineCount: number;
    expectedQty: number;
    receivedQty: number;
    poReceiptCount: number;
    inventoryLotCount: number;
    inventoryTransactionCount: number;
    postingStateKnown: boolean;
  };

  type ShipmentReceiptCoverageSummary = {
    totalExpectedBaseQty: number;
    totalReceivedBaseQty: number;
    totalRemainingBaseQty: number;
    remainingLines: any[];
  };

  type ShipmentCartonReceivePackInspection = {
    status: "no_carton_count" | "fractional_carton" | "pack";
    cartonCount: number | null;
    shippedQty: number | null;
    unitsPerVariant: number | null;
    issue: string | null;
  };

  type ShipmentReceiptPackResolutionLine = {
    shipmentLineId: number | null;
    purchaseOrderId: number | null;
    purchaseOrderLineId: number | null;
    sku: string | null;
    productId: number | null;
    productName: string | null;
    qtyShipped: number | null;
    cartonCount: number | null;
    unitsPerCarton: number | null;
    status:
      | "resolved"
      | "no_carton_count"
      | "fractional_carton"
      | "missing_product"
      | "missing_variant"
      | "invalid_po_line";
    blocking: boolean;
    issue: string | null;
    matchedVariant: {
      id: number;
      sku: string | null;
      name: string | null;
      unitsPerVariant: number;
    } | null;
    activeVariants: Array<{
      id: number;
      sku: string | null;
      name: string | null;
      unitsPerVariant: number;
    }>;
  };

  function parsePositiveInteger(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function activeReceiptStatus(status: unknown): boolean {
    return ACTIVE_RECEIPT_STATUSES.has(String(status ?? ""));
  }

  async function getShipmentReceiptPostingSummary(receivingOrderId: number): Promise<ShipmentReceiptPostingSummary> {
    const fallback: ShipmentReceiptPostingSummary = {
      lineCount: 0,
      expectedQty: 0,
      receivedQty: 0,
      poReceiptCount: 0,
      inventoryLotCount: 0,
      inventoryTransactionCount: 0,
      postingStateKnown: false,
    };

    try {
      const result = await db.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM procurement.receiving_lines WHERE receiving_order_id = ${receivingOrderId}) AS line_count,
          (SELECT COALESCE(SUM(expected_qty), 0)::int FROM procurement.receiving_lines WHERE receiving_order_id = ${receivingOrderId}) AS expected_qty,
          (SELECT COALESCE(SUM(received_qty), 0)::int FROM procurement.receiving_lines WHERE receiving_order_id = ${receivingOrderId}) AS received_qty,
          (SELECT COUNT(*)::int FROM procurement.po_receipts WHERE receiving_order_id = ${receivingOrderId}) AS po_receipt_count,
          (SELECT COUNT(*)::int FROM inventory.inventory_lots WHERE receiving_order_id = ${receivingOrderId}) AS inventory_lot_count,
          (
            SELECT COUNT(*)::int
            FROM inventory.inventory_transactions
            WHERE receiving_order_id = ${receivingOrderId}
              AND voided_at IS NULL
          ) AS inventory_transaction_count
      `);
      const row = result?.rows?.[0];
      if (!row) return fallback;
      return {
        lineCount: Number(row.line_count ?? 0),
        expectedQty: Number(row.expected_qty ?? 0),
        receivedQty: Number(row.received_qty ?? 0),
        poReceiptCount: Number(row.po_receipt_count ?? 0),
        inventoryLotCount: Number(row.inventory_lot_count ?? 0),
        inventoryTransactionCount: Number(row.inventory_transaction_count ?? 0),
        postingStateKnown: true,
      };
    } catch (error) {
      console.warn("[Procurement] Failed to inspect shipment receipt posting summary", {
        receivingOrderId,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  function isZeroPostClosedShipmentReceipt(summary: ShipmentReceiptPostingSummary): boolean {
    return summary.postingStateKnown &&
      summary.lineCount > 0 &&
      summary.receivedQty === 0 &&
      summary.poReceiptCount === 0 &&
      summary.inventoryLotCount === 0 &&
      summary.inventoryTransactionCount === 0;
  }

  async function getClosedShipmentReceivedBaseQtyByPoLine(
    purchaseOrderId: number,
    inboundShipmentId: number,
  ): Promise<Map<number, number>> {
    const result = await db.execute(sql`
      SELECT
        rl.purchase_order_line_id,
        COALESCE(SUM(rl.received_qty * COALESCE(pv.units_per_variant, 1)), 0)::int AS received_base_qty
      FROM procurement.receiving_orders ro
      JOIN procurement.receiving_lines rl ON rl.receiving_order_id = ro.id
      LEFT JOIN catalog.product_variants pv ON pv.id = rl.product_variant_id
      WHERE ro.purchase_order_id = ${purchaseOrderId}
        AND ro.inbound_shipment_id = ${inboundShipmentId}
        AND ro.status = 'closed'
        AND rl.purchase_order_line_id IS NOT NULL
      GROUP BY rl.purchase_order_line_id
    `);

    const receivedByPoLine = new Map<number, number>();
    for (const row of result?.rows ?? []) {
      const poLineId = parsePositiveInteger(row.purchase_order_line_id);
      if (!poLineId) continue;
      receivedByPoLine.set(poLineId, Number(row.received_base_qty ?? 0));
    }
    return receivedByPoLine;
  }

  function adjustShipmentLineToRemainingBaseQty(line: any, remainingBaseQty: number): any {
    const adjusted = { ...line, qtyShipped: remainingBaseQty, qty_shipped: remainingBaseQty };
    const pack = deriveShipmentCartonReceivePack(line);
    if (pack) {
      adjusted.cartonCount =
        remainingBaseQty > 0 && remainingBaseQty % pack.unitsPerVariant === 0
          ? remainingBaseQty / pack.unitsPerVariant
          : null;
      adjusted.carton_count = adjusted.cartonCount;
    }
    return adjusted;
  }

  function summarizeShipmentReceiptCoverage(
    shipmentLines: any[],
    receivedBaseQtyByPoLine: Map<number, number>,
  ): ShipmentReceiptCoverageSummary {
    const unappliedReceivedByPoLine = new Map(receivedBaseQtyByPoLine);
    const remainingLines: any[] = [];
    let totalExpectedBaseQty = 0;
    let totalReceivedBaseQty = 0;

    for (const line of shipmentLines) {
      const expectedBaseQty = Number(line.qtyShipped ?? line.qty_shipped) || 0;
      if (expectedBaseQty <= 0) continue;
      totalExpectedBaseQty += expectedBaseQty;

      const poLineId = parsePositiveInteger(line.purchaseOrderLineId ?? line.purchase_order_line_id);
      const availableReceived = poLineId ? (unappliedReceivedByPoLine.get(poLineId) ?? 0) : 0;
      const appliedReceived = Math.min(Math.max(availableReceived, 0), expectedBaseQty);
      if (poLineId) {
        unappliedReceivedByPoLine.set(poLineId, Math.max(0, availableReceived - appliedReceived));
      }
      totalReceivedBaseQty += appliedReceived;

      const remainingBaseQty = expectedBaseQty - appliedReceived;
      if (remainingBaseQty > 0) {
        remainingLines.push(adjustShipmentLineToRemainingBaseQty(line, remainingBaseQty));
      }
    }

    return {
      totalExpectedBaseQty,
      totalReceivedBaseQty,
      totalRemainingBaseQty: Math.max(0, totalExpectedBaseQty - totalReceivedBaseQty),
      remainingLines,
    };
  }

  function variantIsActive(variant: any): boolean {
    return variant?.isActive !== false && variant?.is_active !== false;
  }

  function variantUnitsPerVariant(variant: any): number {
    const units = Number(variant?.unitsPerVariant ?? variant?.units_per_variant);
    return Number.isInteger(units) && units > 0 ? units : 1;
  }

  function inspectShipmentCartonReceivePack(line: any): ShipmentCartonReceivePackInspection {
    const cartonCount = parsePositiveInteger(line?.cartonCount ?? line?.carton_count);
    const shippedQty = parsePositiveInteger(line?.qtyShipped ?? line?.qty_shipped);
    if (!cartonCount || !shippedQty) {
      return {
        status: "no_carton_count",
        cartonCount,
        shippedQty,
        unitsPerVariant: null,
        issue: null,
      };
    }
    if (shippedQty % cartonCount !== 0) {
      return {
        status: "fractional_carton",
        cartonCount,
        shippedQty,
        unitsPerVariant: null,
        issue: `Shipment line ${line?.sku ?? line?.id ?? ""} has ${shippedQty} shipped units across ${cartonCount} cartons; units per carton must be a whole number before receiving.`,
      };
    }
    return {
      status: "pack",
      cartonCount,
      shippedQty,
      unitsPerVariant: shippedQty / cartonCount,
      issue: null,
    };
  }

  function deriveShipmentCartonReceivePack(line: any): { cartonCount: number; unitsPerVariant: number } | null {
    const inspected = inspectShipmentCartonReceivePack(line);
    if (inspected.status === "no_carton_count") return null;
    if (inspected.status === "fractional_carton") {
      throw new PurchasingError(
        inspected.issue ?? "Shipment carton quantity cannot be resolved.",
        400,
        { shipmentLineId: line?.id ?? null, qtyShipped: inspected.shippedQty, cartonCount: inspected.cartonCount },
      );
    }
    return { cartonCount: inspected.cartonCount as number, unitsPerVariant: inspected.unitsPerVariant as number };
  }

  function chooseActiveVariantByUnits(variants: any[], unitsPerVariant: number): any | null {
    return variants.find(
      (variant) =>
        parsePositiveInteger(variant?.id) &&
        variantIsActive(variant) &&
        variantUnitsPerVariant(variant) === unitsPerVariant,
    ) ?? null;
  }

  function chooseFallbackReceiveVariant(variants: any[], qtyShipped: unknown): any | null {
    const shippedQty = Number(qtyShipped);
    const activeVariants = variants
      .filter((variant) => parsePositiveInteger(variant?.id) && variantIsActive(variant))
      .map((variant) => ({ variant, unitsPerVariant: variantUnitsPerVariant(variant) }))
      .sort((a, b) => b.unitsPerVariant - a.unitsPerVariant);

    if (activeVariants.length === 0) return null;

    if (Number.isInteger(shippedQty) && shippedQty > 0) {
      const exactFit = activeVariants.find(
        ({ unitsPerVariant }) => unitsPerVariant <= shippedQty && shippedQty % unitsPerVariant === 0,
      );
      if (exactFit) return exactFit.variant;

      const largestNotExceedingShipment = activeVariants.find(
        ({ unitsPerVariant }) => unitsPerVariant <= shippedQty,
      );
      if (largestNotExceedingShipment) return largestNotExceedingShipment.variant;
    }

    return activeVariants[activeVariants.length - 1]?.variant ?? null;
  }

  function summarizeActiveVariants(variants: any[]): ShipmentReceiptPackResolutionLine["activeVariants"] {
    return variants
      .filter((variant) => parsePositiveInteger(variant?.id) && variantIsActive(variant))
      .map((variant) => ({
        id: parsePositiveInteger(variant.id) as number,
        sku: variant.sku ?? null,
        name: variant.name ?? null,
        unitsPerVariant: variantUnitsPerVariant(variant),
      }))
      .sort((a, b) => b.unitsPerVariant - a.unitsPerVariant || a.id - b.id);
  }

  function emptyShipmentReceiptError(
    receipt: any,
    purchaseOrderId: number,
    inboundShipmentId: number,
  ): PurchasingError {
    return new PurchasingError(
      "An empty draft receipt already exists for this shipment and PO. Clean up that draft receipt, then receive the shipment again.",
      409,
      {
        code: "EMPTY_SHIPMENT_RECEIPT",
        receivingOrderId: receipt?.id ?? null,
        purchaseOrderId,
        inboundShipmentId,
      },
    );
  }

  async function getReceiptForShipmentPo(
    purchaseOrderId: number,
    inboundShipmentId: number,
  ): Promise<ShipmentReceiptExistingState> {
    const receipts =
      typeof storage.getReceivingOrdersForPurchaseOrder === "function"
        ? await storage.getReceivingOrdersForPurchaseOrder(purchaseOrderId)
        : [];
    const matchingReceipts = receipts.filter(
      (candidate: any) =>
        Number(candidate.inboundShipmentId) === inboundShipmentId &&
        candidate.status !== "cancelled",
    );
    if (matchingReceipts.length === 0) return { kind: "none" };

    const activeReceipt = matchingReceipts.find((candidate: any) => activeReceiptStatus(candidate.status));
    if (activeReceipt) {
      if (typeof storage.getReceivingLines === "function") {
        const lines = await storage.getReceivingLines(activeReceipt.id);
        if (lines.length === 0) return { kind: "empty_active", receipt: activeReceipt, lineCount: 0 };
      }
      return { kind: "active", receipt: activeReceipt };
    }

    for (const receipt of matchingReceipts) {
      const summary = await getShipmentReceiptPostingSummary(receipt.id);
      if (isZeroPostClosedShipmentReceipt(summary)) {
        return { kind: "zero_post_closed", receipt, summary };
      }
    }

    return { kind: "closed", receipt: matchingReceipts[0] };
  }

  function buildShipmentReceiveOption(params: {
    shipment: any | null;
    purchaseOrderId: number;
    inboundShipmentId: number;
    shipmentLines: any[];
    existing: ShipmentReceiptExistingState;
    coverage: ShipmentReceiptCoverageSummary;
  }): ShipmentReceiveOption {
    const { shipment, purchaseOrderId, inboundShipmentId, shipmentLines, existing, coverage } = params;
    const status = shipment?.status ?? null;
    const missingPurchaseOrderLineCount = shipmentLines.filter((line: any) => !line.purchaseOrderLineId).length;
    const shipmentIsReceivable = status ? RECEIVABLE_SHIPMENT_STATUSES.has(status) : false;
    const lineCount = shipmentLines.length;
    const qtyShipped = shipmentLines.reduce((sum, line: any) => sum + (Number(line.qtyShipped) || 0), 0);

    let action: ShipmentReceiveOption["action"] = "create_receipt";
    let reason: string | null = null;
    let receivable = true;

    if (!shipment) {
      receivable = false;
      action = "blocked";
      reason = `Shipment ${inboundShipmentId} was referenced by PO lines but no shipment row was found.`;
    } else if (!shipmentIsReceivable) {
      receivable = false;
      action = "blocked";
      reason = `Shipment is ${String(status).replace(/_/g, " ")}, so it is not physically receivable yet.`;
    } else if (lineCount === 0) {
      receivable = false;
      action = "blocked";
      reason = "Shipment has no positive-quantity lines for this PO.";
    } else if (missingPurchaseOrderLineCount > 0) {
      receivable = false;
      action = "blocked";
      reason = `${missingPurchaseOrderLineCount} shipment line(s) are missing PO line links.`;
    } else if (existing.kind === "active") {
      action = "open_existing_receipt";
      reason = "A receipt is already open for this shipment and PO.";
    } else if (existing.kind === "empty_active") {
      receivable = false;
      action = "repair_empty_receipt";
      reason = "A draft shipment receipt exists but has no lines. Clean it up, then receive this shipment again so the pack checks can run.";
    } else if (existing.kind === "zero_post_closed") {
      receivable = false;
      action = "void_zero_post_receipt";
      reason = "A closed receipt exists for this shipment and PO, but it posted zero received quantity. Void that zero-post receipt, then receive this shipment again.";
    } else if (existing.kind === "closed" && coverage.totalRemainingBaseQty <= 0) {
      receivable = false;
      action = "blocked";
      reason = "This shipment has already been received for this PO.";
    } else if (existing.kind === "closed") {
      action = "create_receipt";
      reason = `A prior shipment receipt was short; ${coverage.totalRemainingBaseQty} of ${coverage.totalExpectedBaseQty} shipped base units remain to receive.`;
    }

    const existingReceipt = existing.kind === "none" ? null : existing.receipt;
    const existingReceiptLineCount =
      existing.kind === "empty_active" ? existing.lineCount :
      existing.kind === "zero_post_closed" ? existing.summary.lineCount :
      null;
    return {
      shipmentId: inboundShipmentId,
      shipmentNumber: shipment?.shipmentNumber ?? null,
      status,
      purchaseOrderId,
      lineCount,
      qtyShipped,
      receivedBaseQty: coverage.totalReceivedBaseQty,
      remainingBaseQty: coverage.totalRemainingBaseQty,
      missingPurchaseOrderLineCount,
      receivable,
      action,
      reason,
      freightWillCarry: receivable && action !== "blocked",
      estimatedTotalCostCents: shipment?.estimatedTotalCostCents ?? null,
      actualTotalCostCents: shipment?.actualTotalCostCents ?? null,
      existingReceiptId: existingReceipt?.id ?? null,
      existingReceiptStatus: existingReceipt?.status ?? null,
      existingReceiptLineCount,
    };
  }

  async function getPurchaseOrderReceiveOptions(purchaseOrderId: number) {
    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    const shipmentLines = await storage.getInboundShipmentLinesByPo(purchaseOrderId);
    const positiveShipmentLines = shipmentLines.filter((line: any) => Number(line.qtyShipped) > 0);
    const linesByShipment = new Map<number, any[]>();
    for (const line of positiveShipmentLines) {
      const shipmentId = parsePositiveInteger(line.inboundShipmentId);
      if (!shipmentId) continue;
      const lines = linesByShipment.get(shipmentId) ?? [];
      lines.push(line);
      linesByShipment.set(shipmentId, lines);
    }

    const shipmentOptions: ShipmentReceiveOption[] = [];
    for (const [shipmentId, lines] of linesByShipment) {
      const [shipment, existing, receivedBaseQtyByPoLine] = await Promise.all([
        storage.getInboundShipmentById(shipmentId),
        getReceiptForShipmentPo(purchaseOrderId, shipmentId),
        getClosedShipmentReceivedBaseQtyByPoLine(purchaseOrderId, shipmentId),
      ]);
      const coverage = summarizeShipmentReceiptCoverage(lines, receivedBaseQtyByPoLine);
      shipmentOptions.push(buildShipmentReceiveOption({
        shipment,
        purchaseOrderId,
        inboundShipmentId: shipmentId,
        shipmentLines: lines,
        existing,
        coverage,
      }));
    }

    shipmentOptions.sort((a, b) => {
      const rank = Number(b.receivable) - Number(a.receivable);
      if (rank !== 0) return rank;
      return b.shipmentId - a.shipmentId;
    });

    const poDirectAllowed = ["sent", "acknowledged", "partially_received"].includes(po.status);
    const linkedShipmentCount = shipmentOptions.length;
    return {
      purchaseOrderId,
      poNumber: po.poNumber,
      status: po.status,
      physicalStatus: po.physicalStatus ?? null,
      shipmentOptions,
      poDirect: {
        allowed: poDirectAllowed,
        reason: poDirectAllowed ? null : `Cannot create receipt for PO in '${po.status}' status`,
        warning: linkedShipmentCount > 0
          ? "PO-direct receiving does not attach shipment freight to the received lots."
          : "No inbound shipment exists for this PO. PO-direct receiving is appropriate for no-freight or domestic receipts.",
      },
    };
  }

  // Shipment-scoped receive options: one option per PO with positive lines on
  // this shipment. Powers the multi-PO receive picker on the shipment page and
  // the post-close "receive next PO" chaining. Reuses the exact per-(shipment,
  // PO) state machine the PO page uses (buildShipmentReceiveOption), so both
  // surfaces always agree on receivability.
  async function getShipmentPoReceiveOptions(inboundShipmentId: number) {
    const shipment = await storage.getInboundShipmentById(inboundShipmentId);
    if (!shipment) throw new PurchasingError("Inbound shipment not found", 404);

    const shipmentLines = await storage.getInboundShipmentLines(inboundShipmentId);
    const positiveLines = shipmentLines.filter((line: any) => Number(line.qtyShipped) > 0);
    const linesByPo = new Map<number, any[]>();
    let unlinkedLineCount = 0;
    for (const line of positiveLines) {
      const poId = parsePositiveInteger(line.purchaseOrderId);
      if (!poId) {
        unlinkedLineCount++;
        continue;
      }
      const lines = linesByPo.get(poId) ?? [];
      lines.push(line);
      linesByPo.set(poId, lines);
    }

    const purchaseOrders: Array<ShipmentReceiveOption & { poNumber: string | null; poStatus: string | null }> = [];
    for (const [poId, lines] of linesByPo) {
      const [po, existing, receivedBaseQtyByPoLine] = await Promise.all([
        storage.getPurchaseOrderById(poId),
        getReceiptForShipmentPo(poId, inboundShipmentId),
        getClosedShipmentReceivedBaseQtyByPoLine(poId, inboundShipmentId),
      ]);
      const coverage = summarizeShipmentReceiptCoverage(lines, receivedBaseQtyByPoLine);
      const option = buildShipmentReceiveOption({
        shipment,
        purchaseOrderId: poId,
        inboundShipmentId,
        shipmentLines: lines,
        existing,
        coverage,
      });
      purchaseOrders.push({
        ...option,
        poNumber: (po as any)?.poNumber ?? null,
        poStatus: (po as any)?.status ?? null,
      });
    }

    purchaseOrders.sort((a, b) => {
      const rank = Number(b.receivable) - Number(a.receivable);
      if (rank !== 0) return rank;
      return a.purchaseOrderId - b.purchaseOrderId;
    });

    return {
      shipmentId: inboundShipmentId,
      shipmentNumber: (shipment as any)?.shipmentNumber ?? null,
      status: (shipment as any)?.status ?? null,
      unlinkedLineCount,
      purchaseOrders,
    };
  }

  async function getShipmentReceiptPackResolution(
    inboundShipmentId: number,
    options: { purchaseOrderId?: number } = {},
  ) {
    const shipment = await storage.getInboundShipmentById(inboundShipmentId);
    if (!shipment) throw new PurchasingError("Inbound shipment not found", 404);

    const shipmentLines = await storage.getInboundShipmentLines(inboundShipmentId);
    const linkedShipmentLines = shipmentLines.filter(
      (sl: any) => Number(sl.qtyShipped) > 0 && sl.purchaseOrderId && sl.purchaseOrderLineId,
    );
    const poIds = Array.from(
      new Set(linkedShipmentLines.map((sl: any) => Number(sl.purchaseOrderId)).filter((id: number) => Number.isInteger(id) && id > 0)),
    ).sort((a, b) => a - b);
    const requestedPoId = parsePositiveInteger(options.purchaseOrderId);
    if (!requestedPoId && poIds.length !== 1) {
      throw new PurchasingError(
        "This shipment's lines span multiple POs; choose which PO to receive.",
        409,
        { purchaseOrderIds: poIds },
      );
    }
    const purchaseOrderId = requestedPoId ?? (poIds[0] as number | undefined);
    if (!purchaseOrderId || !poIds.includes(purchaseOrderId)) {
      throw new PurchasingError(
        `Shipment ${inboundShipmentId} has no receivable lines for PO ${purchaseOrderId ?? "unknown"}.`,
        404,
        { purchaseOrderIds: poIds },
      );
    }

    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new PurchasingError("Linked purchase order not found", 404);

    const poLines = await storage.getPurchaseOrderLines(purchaseOrderId);
    const poLineById = new Map<number, any>(poLines.map((line: any) => [line.id, line]));
    const receivableShipmentLines = linkedShipmentLines.filter(
      (sl: any) => Number(sl.purchaseOrderId) === purchaseOrderId,
    );

    const productIds = new Set<number>();
    for (const sl of receivableShipmentLines) {
      const poLine = poLineById.get(sl.purchaseOrderLineId);
      const productId = parsePositiveInteger(poLine?.productId);
      if (productId) productIds.add(productId);
    }

    const variantsByProductId = new Map<number, any[]>();
    if (typeof storage.getProductVariantsByProductId === "function") {
      for (const productId of productIds) {
        try {
          variantsByProductId.set(productId, await storage.getProductVariantsByProductId(productId));
        } catch {
          variantsByProductId.set(productId, []);
        }
      }
    }

    const lines: ShipmentReceiptPackResolutionLine[] = receivableShipmentLines.map((sl: any) => {
      const poLine = poLineById.get(sl.purchaseOrderLineId);
      const productId = parsePositiveInteger(poLine?.productId);
      const inspectedPack = inspectShipmentCartonReceivePack(sl);
      const activeVariants = productId
        ? summarizeActiveVariants(variantsByProductId.get(productId) ?? [])
        : [];
      const matchedVariant = inspectedPack.unitsPerVariant
        ? activeVariants.find((variant) => variant.unitsPerVariant === inspectedPack.unitsPerVariant) ?? null
        : null;

      let status: ShipmentReceiptPackResolutionLine["status"] = "resolved";
      let blocking = false;
      let issue: string | null = null;

      if (!poLine) {
        status = "invalid_po_line";
        blocking = true;
        issue = "Shipment line is linked to a PO line that was not found on this purchase order.";
      } else if (inspectedPack.status === "fractional_carton") {
        status = "fractional_carton";
        blocking = true;
        issue = inspectedPack.issue;
      } else if (inspectedPack.status === "no_carton_count") {
        status = "no_carton_count";
        blocking = false;
        issue = "Shipment line has no carton count; receipt creation will use the existing receive configuration.";
      } else if (!productId) {
        status = "missing_product";
        blocking = true;
        issue = "Shipment cartons are present, but the PO line has no product_id to resolve a receive variant.";
      } else if (!matchedVariant) {
        status = "missing_variant";
        blocking = true;
        issue = `Shipment cartons imply ${inspectedPack.cartonCount} carton${inspectedPack.cartonCount === 1 ? "" : "s"} of ${inspectedPack.unitsPerVariant} units, but product ${productId} has no active receive variant with units_per_variant=${inspectedPack.unitsPerVariant}.`;
      }

      return {
        shipmentLineId: parsePositiveInteger(sl.id),
        purchaseOrderId: parsePositiveInteger(sl.purchaseOrderId),
        purchaseOrderLineId: parsePositiveInteger(sl.purchaseOrderLineId),
        sku: poLine?.sku ?? sl.sku ?? null,
        productId,
        productName: poLine?.productName ?? poLine?.product_name ?? null,
        qtyShipped: parsePositiveInteger(sl.qtyShipped ?? sl.qty_shipped),
        cartonCount: inspectedPack.cartonCount,
        unitsPerCarton: inspectedPack.unitsPerVariant,
        status,
        blocking,
        issue,
        matchedVariant,
        activeVariants,
      };
    });

    const blockingLines = lines.filter((line) => line.blocking);
    const shipmentIsReceivable = RECEIVABLE_SHIPMENT_STATUSES.has((shipment as any).status);
    return {
      shipmentId: inboundShipmentId,
      shipmentNumber: shipment.shipmentNumber ?? shipment.shipment_number ?? null,
      status: shipment.status ?? null,
      purchaseOrderId,
      poNumber: po.poNumber ?? po.po_number ?? null,
      canCreateReceipt: shipmentIsReceivable && linkedShipmentLines.length > 0 && blockingLines.length === 0,
      unresolvedCount: blockingLines.length,
      lineCount: lines.length,
      issue: shipmentIsReceivable
        ? (lines.length === 0 ? "Shipment has no positive-quantity lines linked to this PO." : null)
        : `Cannot receive a shipment in '${(shipment as any).status}' status.`,
      lines,
    };
  }

  /**
   * Create a receiving order against an inbound SHIPMENT (the freight-bearing
   * leg). Mirrors createReceiptFromPO's line-building, but:
   *   - Expected qty comes from each shipment line's qtyShipped (the goods on
   *     THIS container), not the PO line's full orderQty;
   *   - stamps inbound_shipment_id + source_type='shipment' on the order, so the
   *     lots created at close inherit the shipment link + go provisional, and the
   *     shipment's finalized landed cost attaches to exactly these lots.
   * Cost is still stamped from the PO line (the AP source of truth).
   *
   * NOTE: cost stamping mirrors createReceiptFromPO. Shipment lines already
   * carry the resolved receive variant.
   */
  async function createReceiptFromShipment(
    inboundShipmentId: number,
    userId?: string,
    options: { purchaseOrderId?: number } = {},
  ) {
    const shipment = await storage.getInboundShipmentById(inboundShipmentId);
    if (!shipment) throw new PurchasingError("Inbound shipment not found", 404);

    // Goods must be physically here (or being costed/closed) to receive them.
    if (!RECEIVABLE_SHIPMENT_STATUSES.has((shipment as any).status)) {
      throw new PurchasingError(`Cannot receive a shipment in '${(shipment as any).status}' status`, 400);
    }

    const shipmentLines = await storage.getInboundShipmentLines(inboundShipmentId);
    const linkedShipmentLines = shipmentLines.filter(
      (sl: any) => Number(sl.qtyShipped) > 0 && sl.purchaseOrderId && sl.purchaseOrderLineId,
    );
    if (linkedShipmentLines.length === 0) {
      throw new PurchasingError("Shipment has no receivable lines", 400);
    }

    const poIds = Array.from(
      new Set(linkedShipmentLines.map((sl: any) => Number(sl.purchaseOrderId)).filter((id: number) => Number.isInteger(id) && id > 0)),
    ).sort((a, b) => a - b);
    const requestedPoId = parsePositiveInteger(options.purchaseOrderId);
    if (!requestedPoId && poIds.length !== 1) {
      throw new PurchasingError(
        "This shipment's lines span multiple POs; choose which PO to receive.",
        409,
        { purchaseOrderIds: poIds },
      );
    }
    const purchaseOrderId = requestedPoId ?? (poIds[0] as number);
    if (!poIds.includes(purchaseOrderId)) {
      throw new PurchasingError(
        `Shipment ${inboundShipmentId} has no receivable lines for PO ${purchaseOrderId}.`,
        404,
        { purchaseOrderIds: poIds },
      );
    }

    const receivableShipmentLines = linkedShipmentLines.filter(
      (sl: any) => Number(sl.purchaseOrderId) === purchaseOrderId,
    );
    const receivedBaseQtyByPoLine = await getClosedShipmentReceivedBaseQtyByPoLine(
      purchaseOrderId,
      inboundShipmentId,
    );
    const coverage = summarizeShipmentReceiptCoverage(receivableShipmentLines, receivedBaseQtyByPoLine);
    const receiptShipmentLines = coverage.remainingLines;
    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new PurchasingError("Linked purchase order not found", 404);

    const existingReceipt = await getReceiptForShipmentPo(purchaseOrderId, inboundShipmentId);
    if (existingReceipt.kind === "active") return { ...existingReceipt.receipt, reusedExisting: true };
    if (existingReceipt.kind === "empty_active") {
      throw emptyShipmentReceiptError(existingReceipt.receipt, purchaseOrderId, inboundShipmentId);
    }
    if (existingReceipt.kind === "zero_post_closed") {
      throw new PurchasingError(
        "A closed zero-post receipt already exists for this shipment and PO. Void that receipt, then receive the shipment again.",
        409,
        {
          code: "ZERO_POST_SHIPMENT_RECEIPT",
          receivingOrderId: existingReceipt.receipt.id,
          purchaseOrderId,
          inboundShipmentId,
        },
      );
    }
    if (existingReceipt.kind === "closed" && coverage.totalRemainingBaseQty <= 0) {
      throw new PurchasingError(
        "This shipment has already been received for this PO.",
        409,
        { receivingOrderId: existingReceipt.receipt.id, purchaseOrderId, inboundShipmentId },
      );
    }
    if (receiptShipmentLines.length === 0) {
      throw new PurchasingError(
        "This shipment has no remaining quantity to receive for this PO.",
        409,
        {
          code: "SHIPMENT_ALREADY_FULLY_RECEIVED",
          purchaseOrderId,
          inboundShipmentId,
          receivedBaseQty: coverage.totalReceivedBaseQty,
          expectedBaseQty: coverage.totalExpectedBaseQty,
        },
      );
    }

    const poLines = await storage.getPurchaseOrderLines(purchaseOrderId);
    const poLineById = new Map<number, any>(poLines.map((l: any) => [l.id, l]));
    const invalidLinkedLine = receivableShipmentLines.find((sl: any) => {
      const poLine = poLineById.get(sl.purchaseOrderLineId);
      const linePurchaseOrderId = parsePositiveInteger(poLine?.purchaseOrderId);
      return !poLine || (linePurchaseOrderId !== null && linePurchaseOrderId !== purchaseOrderId);
    });
    if (invalidLinkedLine) {
      throw new PurchasingError(
        "Shipment line PO links are inconsistent; receiving is blocked until the line links are repaired.",
        409,
        {
          inboundShipmentId,
          inboundShipmentLineId: invalidLinkedLine.id,
          purchaseOrderId,
          purchaseOrderLineId: invalidLinkedLine.purchaseOrderLineId ?? null,
        },
      );
    }

    const unitsPerVariantById = new Map<number, number>();
    const fallbackVariantsByProductId = new Map<number, any[]>();
    const explicitVariantIds = new Set<number>();
    for (const sl of receiptShipmentLines) {
      const poLine = poLineById.get(sl.purchaseOrderLineId);
      const variantId = parsePositiveInteger(
        sl.productVariantId ?? poLine?.expectedReceiveVariantId ?? poLine?.productVariantId,
      );
      if (variantId) explicitVariantIds.add(variantId);
    }
    for (const variantId of explicitVariantIds) {
      try {
        const variant = await storage.getProductVariantById(variantId);
        if (variant) {
          unitsPerVariantById.set(variantId, Math.max(1, variant.unitsPerVariant || 1));
        }
      } catch { /* non-critical: fall back to PO receive units */ }
    }
    if (typeof storage.getProductVariantsByProductId === "function") {
      const productIdsNeedingFallback = new Set<number>();
      for (const sl of receiptShipmentLines) {
        const poLine = poLineById.get(sl.purchaseOrderLineId);
        const productId = parsePositiveInteger(poLine?.productId);
        const hasExplicitVariant = parsePositiveInteger(
          sl.productVariantId ?? poLine?.expectedReceiveVariantId ?? poLine?.productVariantId,
        );
        const shipmentReceivePack = deriveShipmentCartonReceivePack(sl);
        if (productId && (!hasExplicitVariant || shipmentReceivePack)) productIdsNeedingFallback.add(productId);
      }
      for (const productId of productIdsNeedingFallback) {
        try {
          const variants = await storage.getProductVariantsByProductId(productId);
          fallbackVariantsByProductId.set(productId, variants);
        } catch { /* non-critical: fall back to PO receive units */ }
      }
    }
    // Primary putaway locations keyed by receive variant.
    const productLocationMap = new Map<number, number>();
    try {
      const allProductLocations = (await (storage as any).getAllProductLocations?.()) ?? [];
      for (const pl of allProductLocations) {
        if (pl.productVariantId && pl.warehouseLocationId && pl.status === "active" && pl.isPrimary) {
          if (!productLocationMap.has(pl.productVariantId)) {
            productLocationMap.set(pl.productVariantId, pl.warehouseLocationId);
          }
        }
      }
    } catch { /* non-critical */ }

    // Build receiving lines from SHIPMENT lines. When the shipment carries a
    // carton count, the shipment's carton math is the receipt authority; the
    // product variant must exactly match the implied units-per-carton so
    // inventory posting still lands in the right variant units.
    const receivingLineData = receiptShipmentLines.map((sl: any) => {
      const poLine = poLineById.get(sl.purchaseOrderLineId);
      const productId = parsePositiveInteger(poLine?.productId);
      const shipmentReceivePack = deriveShipmentCartonReceivePack(sl);
      if (shipmentReceivePack && !productId) {
        throw new PurchasingError(
          `Shipment line ${poLine?.sku ?? sl.sku ?? sl.id} has carton count but no product_id on its PO line; cannot resolve a receive variant.`,
          400,
          {
            shipmentLineId: sl.id ?? null,
            purchaseOrderLineId: sl.purchaseOrderLineId ?? null,
            qtyShipped: sl.qtyShipped,
            cartonCount: shipmentReceivePack.cartonCount,
            unitsPerVariant: shipmentReceivePack.unitsPerVariant,
          },
        );
      }
      const shipmentReceiveVariant = productId && shipmentReceivePack
        ? chooseActiveVariantByUnits(
            fallbackVariantsByProductId.get(productId) ?? [],
            shipmentReceivePack.unitsPerVariant,
          )
        : null;
      if (shipmentReceivePack && productId && !shipmentReceiveVariant) {
        throw new PurchasingError(
          `Shipment line ${poLine?.sku ?? sl.sku ?? sl.id} expects ${shipmentReceivePack.cartonCount} carton${shipmentReceivePack.cartonCount === 1 ? "" : "s"} of ${shipmentReceivePack.unitsPerVariant}, but product ${productId} has no active receive variant with units_per_variant=${shipmentReceivePack.unitsPerVariant}. Update the product receive variant before creating the receipt.`,
          400,
          {
            shipmentLineId: sl.id ?? null,
            purchaseOrderLineId: sl.purchaseOrderLineId ?? null,
            productId,
            qtyShipped: sl.qtyShipped,
            cartonCount: shipmentReceivePack.cartonCount,
            unitsPerVariant: shipmentReceivePack.unitsPerVariant,
          },
        );
      }
      const fallbackVariant = productId
        ? chooseFallbackReceiveVariant(fallbackVariantsByProductId.get(productId) ?? [], sl.qtyShipped)
        : null;
      const resolvedVariantId =
        shipmentReceiveVariant?.id ?? sl.productVariantId ?? poLine?.expectedReceiveVariantId ?? poLine?.productVariantId ?? fallbackVariant?.id ?? null;
      const packSize = Math.max(
        1,
        shipmentReceivePack?.unitsPerVariant ??
          (resolvedVariantId ? unitsPerVariantById.get(resolvedVariantId) : undefined) ??
          (fallbackVariant ? Number(fallbackVariant.unitsPerVariant) : undefined) ??
          poLine?.expectedReceiveUnitsPerVariant ??
          poLine?.unitsPerUom ??
          1,
      );
      const autoLocationId = (resolvedVariantId && productLocationMap.get(resolvedVariantId)) || null;
      const hasPoMills =
        typeof poLine?.unitCostMills === "number" &&
        Number.isInteger(poLine.unitCostMills) &&
        poLine.unitCostMills >= 0;
      const unitCostMills = hasPoMills
        ? (poLine.unitCostMills as number)
        : (typeof poLine?.unitCostCents === "number" && poLine.unitCostCents >= 0
            ? centsToMills(poLine.unitCostCents)
            : null);
      const unitCost = hasPoMills
        ? millsToCents(poLine.unitCostMills as number)
        : (typeof poLine?.unitCostCents === "number" ? poLine.unitCostCents : null);
      return {
        productVariantId: resolvedVariantId,
        productId,
        sku: poLine?.sku ?? sl.sku,
        productName: poLine?.productName,
        expectedQty: shipmentReceivePack?.cartonCount ?? Math.ceil(Number(sl.qtyShipped) / packSize),
        receivedQty: 0,
        damagedQty: 0,
        purchaseOrderLineId: sl.purchaseOrderLineId,
        unitCost,
        unitCostMills,
        putawayLocationId: autoLocationId,
        status: "pending",
      };
    });

    if (receivingLineData.length === 0) {
      throw new PurchasingError("Shipment has no receivable lines for this PO.", 400, {
        purchaseOrderId,
        inboundShipmentId,
      });
    }

    const expectedLineCount = receivingLineData.length;
    const expectedTotalUnits = receivingLineData.reduce(
      (sum: number, line: any) => sum + (Number(line.expectedQty) || 0),
      0,
    );

    const receiptNumber = await storage.generateReceiptNumber();
    let receivingOrder;
    try {
      receivingOrder = await storage.createReceivingOrder({
        receiptNumber,
        poNumber: po.poNumber,
        purchaseOrderId: po.id,
        inboundShipmentId,
        sourceType: "shipment",
        vendorId: po.vendorId,
        warehouseId: po.warehouseId,
        status: "draft",
        expectedDate: po.expectedDeliveryDate || po.confirmedDeliveryDate,
        expectedLineCount,
        expectedTotalUnits,
        createdBy: userId,
      });
    } catch (error: any) {
      if (error?.code === "23505") {
        const conflict = await getReceiptForShipmentPo(purchaseOrderId, inboundShipmentId);
        if (conflict.kind === "active") return { ...conflict.receipt, reusedExisting: true };
        if (conflict.kind === "empty_active") {
          throw emptyShipmentReceiptError(conflict.receipt, purchaseOrderId, inboundShipmentId);
        }
        if (conflict.kind === "zero_post_closed") {
          throw new PurchasingError(
            "A closed zero-post receipt already exists for this shipment and PO. Void that receipt, then receive the shipment again.",
            409,
            {
              code: "ZERO_POST_SHIPMENT_RECEIPT",
              receivingOrderId: conflict.receipt.id,
              purchaseOrderId,
              inboundShipmentId,
            },
          );
        }
        if (conflict.kind === "closed") {
          throw new PurchasingError(
            "This shipment has already been received for this PO.",
            409,
            { receivingOrderId: conflict.receipt.id, purchaseOrderId, inboundShipmentId },
          );
        }
        throw new PurchasingError(`Receipt number '${receiptNumber}' already in use by an active record.`, 409);
      }
      throw error;
    }

    const receivingLinesToCreate = receivingLineData.map((line: any) => ({
      ...line,
      receivingOrderId: receivingOrder.id,
    }));
    try {
      await storage.bulkCreateReceivingLines(receivingLinesToCreate as any);
    } catch (error) {
      if (typeof storage.deleteReceivingOrder === "function") {
        try {
          await storage.deleteReceivingOrder(receivingOrder.id);
        } catch (cleanupError) {
          console.error("[Purchasing] Failed to clean up shipment receipt header after line creation failed:", {
            receivingOrderId: receivingOrder.id,
            inboundShipmentId,
            purchaseOrderId,
            cleanupError,
          });
        }
      }
      throw error;
    }
    return receivingOrder;
  }

  /**
   * Called by ReceivingService when a receiving order linked to a PO is closed.
   * Updates PO line received quantities and auto-transitions PO status.
   */
  /**
   * Find an open product PO line on the given PO that matches a product ID.
   * Returns the single matching line, or null if there are zero or multiple
   * matches (ambiguous — caller should leave unlinked and warn).
   *
   * "Open" means the line is not cancelled/received/closed and has remaining
   * quantity (orderQty > receivedQty + cancelledQty).
   */
  async function findOpenPoLineByProduct(
    poId: number,
    productId: number,
  ): Promise<any | null> {
    return findOpenPoLineByProductWithStorage(storage, poId, productId);
  }

  async function onReceivingOrderClosed(
    receivingOrderId: number,
    receivingLines: ReceivingReconciliationLine[],
  ) {
    const result = await reconcilePurchaseOrderReceipt({
      storage,
      receivingOrderId,
      receivingLines,
      recalculateTotals,
    });

    if (result.purchaseOrderId && result.poStatusUpdate?.legacyStatus === "received") {
      try {
        await detectQtyVariance(result.purchaseOrderId);
      } catch (error) {
        console.error("[po-exceptions] qty variance detection failed after receiving close:", error);
      }
    }

    return result;
  }

  // ── PROCUREMENT SETTINGS (Spec A) ───────────────────────────────────────
  //
  // These live on inventory.warehouse_settings (DEFAULT row) per spec §12.
  // Whitelisted here to prevent arbitrary key writes from the PATCH endpoint.
  // Only `requireApproval` and `autoSendOnApprove` affect Spec A directly;
  // the remaining keys are scaffolded for Specs B and C.

  const PROCUREMENT_SETTING_KEYS = [
    "requireApproval",
    "autoSendOnApprove",
    "requireAcknowledgeBeforeReceive",
    "hideIncotermsDomestic",
    "enableShipmentTracking",
    "autoPutawayLocation",
    "autoCloseOnReconcile",
    "oneClickReceiveStart",
    "useNewPoEditor",
  ] as const;
  type ProcurementSettingKey = typeof PROCUREMENT_SETTING_KEYS[number];
  const PROCUREMENT_SETTING_KEY_SET = new Set<string>(PROCUREMENT_SETTING_KEYS);

  // Defaults mirror the NOT NULL DEFAULT clauses in migration 0557. Returned
  // when no DEFAULT row exists yet (new install, test DB).
  const PROCUREMENT_SETTING_DEFAULTS: Record<ProcurementSettingKey, boolean> = {
    requireApproval: false,
    autoSendOnApprove: true,
    requireAcknowledgeBeforeReceive: false,
    hideIncotermsDomestic: true,
    enableShipmentTracking: true,
    autoPutawayLocation: true,
    autoCloseOnReconcile: true,
    oneClickReceiveStart: true,
    useNewPoEditor: false,
  };

  async function getProcurementSettings(): Promise<Record<ProcurementSettingKey, boolean>> {
    const rows = await db
      .select({
        requireApproval: warehouseSettingsTable.requireApproval,
        autoSendOnApprove: warehouseSettingsTable.autoSendOnApprove,
        requireAcknowledgeBeforeReceive: warehouseSettingsTable.requireAcknowledgeBeforeReceive,
        hideIncotermsDomestic: warehouseSettingsTable.hideIncotermsDomestic,
        enableShipmentTracking: warehouseSettingsTable.enableShipmentTracking,
        autoPutawayLocation: warehouseSettingsTable.autoPutawayLocation,
        autoCloseOnReconcile: warehouseSettingsTable.autoCloseOnReconcile,
        oneClickReceiveStart: warehouseSettingsTable.oneClickReceiveStart,
        useNewPoEditor: warehouseSettingsTable.useNewPoEditor,
      })
      .from(warehouseSettingsTable)
      .where(eq(warehouseSettingsTable.warehouseCode, "DEFAULT"))
      .limit(1);

    if (rows.length === 0) {
      // Fallback: first row. Covers edge cases where no DEFAULT code exists.
      const fallback = await db
        .select({
          requireApproval: warehouseSettingsTable.requireApproval,
          autoSendOnApprove: warehouseSettingsTable.autoSendOnApprove,
          requireAcknowledgeBeforeReceive: warehouseSettingsTable.requireAcknowledgeBeforeReceive,
          hideIncotermsDomestic: warehouseSettingsTable.hideIncotermsDomestic,
          enableShipmentTracking: warehouseSettingsTable.enableShipmentTracking,
          autoPutawayLocation: warehouseSettingsTable.autoPutawayLocation,
          autoCloseOnReconcile: warehouseSettingsTable.autoCloseOnReconcile,
          oneClickReceiveStart: warehouseSettingsTable.oneClickReceiveStart,
          useNewPoEditor: warehouseSettingsTable.useNewPoEditor,
        })
        .from(warehouseSettingsTable)
        .limit(1);
      if (fallback.length === 0) return { ...PROCUREMENT_SETTING_DEFAULTS };
      return fallback[0] as Record<ProcurementSettingKey, boolean>;
    }
    return rows[0] as Record<ProcurementSettingKey, boolean>;
  }

  async function getProcurementSettingsTx(
    tx: any,
  ): Promise<Record<ProcurementSettingKey, boolean>> {
    const projection = {
      requireApproval: warehouseSettingsTable.requireApproval,
      autoSendOnApprove: warehouseSettingsTable.autoSendOnApprove,
      requireAcknowledgeBeforeReceive: warehouseSettingsTable.requireAcknowledgeBeforeReceive,
      hideIncotermsDomestic: warehouseSettingsTable.hideIncotermsDomestic,
      enableShipmentTracking: warehouseSettingsTable.enableShipmentTracking,
      autoPutawayLocation: warehouseSettingsTable.autoPutawayLocation,
      autoCloseOnReconcile: warehouseSettingsTable.autoCloseOnReconcile,
      oneClickReceiveStart: warehouseSettingsTable.oneClickReceiveStart,
      useNewPoEditor: warehouseSettingsTable.useNewPoEditor,
    };
    const rows = await tx
      .select(projection)
      .from(warehouseSettingsTable)
      .where(eq(warehouseSettingsTable.warehouseCode, "DEFAULT"))
      .limit(1)
      .for("share");
    if (rows[0]) return rows[0] as Record<ProcurementSettingKey, boolean>;

    const fallback = await tx
      .select(projection)
      .from(warehouseSettingsTable)
      .limit(1)
      .for("share");
    return fallback[0]
      ? fallback[0] as Record<ProcurementSettingKey, boolean>
      : { ...PROCUREMENT_SETTING_DEFAULTS };
  }

  async function updateProcurementSetting(
    key: string,
    value: boolean,
    userId?: string,
  ): Promise<Record<ProcurementSettingKey, boolean>> {
    if (!PROCUREMENT_SETTING_KEY_SET.has(key)) {
      throw new PurchasingError(`Unknown procurement setting: ${key}`, 400);
    }
    if (typeof value !== "boolean") {
      throw new PurchasingError(`Procurement setting '${key}' must be a boolean`, 400);
    }
    // Drizzle column names match the schema keys. Use a dynamic set object.
    const patch: Record<string, any> = { [key]: value, updatedAt: new Date() };
    const result = await db
      .update(warehouseSettingsTable)
      .set(patch)
      .where(eq(warehouseSettingsTable.warehouseCode, "DEFAULT"))
      .returning();
    // If no DEFAULT row yet, apply to first row.
    if (result.length === 0) {
      await db
        .update(warehouseSettingsTable)
        .set(patch);
    }
    console.log(`[Purchasing] procurement setting "${key}" set to ${value} by ${userId ?? "system"}`);
    return getProcurementSettings();
  }

  // ── PO EVENT STREAM (Spec A) ─────────────────────────────────────────────
  //
  // Append-only audit stream. Rule #8 (Auditability): every event captures
  // actor (user_id or 'system:auto') and timestamp. Before/after state goes
  // in payload when meaningful.

  function resolveActor(userId: string | null | undefined): { actorType: "user" | "system"; actorId: string } {
    if (userId && userId.length > 0) {
      return { actorType: "user", actorId: userId };
    }
    return { actorType: "system", actorId: "system:auto" };
  }

  // Emit outside of a caller-owned transaction. Prefer the txn variant inside
  // create/send flows so the event lands atomically with the state change.
  async function emitPoEvent(
    poId: number,
    eventType: string,
    userId: string | null | undefined,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const { actorType, actorId } = resolveActor(userId);
    await db.insert(poEventsTable).values({
      poId,
      eventType,
      actorType,
      actorId,
      payloadJson: payload ?? null,
    });
  }

  async function emitPoEventTx(
    tx: any,
    poId: number,
    eventType: string,
    userId: string | null | undefined,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const { actorType, actorId } = resolveActor(userId);
    await tx.insert(poEventsTable).values({
      poId,
      eventType,
      actorType,
      actorId,
      payloadJson: payload ?? null,
    });
  }

  // ── NEW INLINE-CREATE FLOW (Spec A) ───────────────────────────────────
  //
  // Replaces the two-step "createPO" + "addBulkLines" flow with a single
  // transactional create-with-lines. Rule #3 (Data Integrity): all money
  // arrives in integer cents, validated via zod-style checks at the boundary.
  // Rule #7 (DB Discipline): header + lines + status history + po_events are
  // inserted in one transaction so a partial row can never leak.

  // Type-aware line validation (migration 0563).
  //
  // Rules per line_type:
  //
  //   product     requires productId; cost >= 0; qty > 0.
  //   discount    no variant; cost <= 0; qty == 1.
  //   fee         no variant; cost >= 0; qty >= 1.
  //   tax         no variant; cost >= 0; qty == 1.
  //   rebate      no variant; cost <= 0; qty == 1.
  //   adjustment  no variant; cost signed (any integer); qty == 1.
  //
  // Non-product lines ALSO require a non-empty description. clientId and
  // parentClientId are request-scoped and resolved to DB ids inside the
  // insert transaction; parent must resolve to a product line in the same
  // payload (no chains, no cycles).
  function validateCreateWithLinesInput(
    input: CreatePurchaseOrderWithLinesInput,
    options: { allowExistingLineIds?: boolean } = {},
  ): void {
    if (!input || typeof input !== "object") {
      throw new PurchasingError("Request body is required", 400);
    }
    if (
      !Number.isSafeInteger(input.vendorId) ||
      input.vendorId <= 0 ||
      input.vendorId > PG_INTEGER_MAX
    ) {
      throw new PurchasingError("vendor_id is required", 400);
    }
    if (
      input.warehouseId !== undefined &&
      input.warehouseId !== null &&
      (!Number.isSafeInteger(input.warehouseId) ||
        input.warehouseId <= 0 ||
        input.warehouseId > PG_INTEGER_MAX)
    ) {
      throw new PurchasingError("warehouse_id must be a positive integer or null", 400);
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new PurchasingError("At least one line is required", 400);
    }
    if (input.lines.length > MAX_INLINE_PO_LINES) {
      throw new PurchasingError(
        `A purchase order may contain at most ${MAX_INLINE_PO_LINES} lines`,
        400,
      );
    }
    if (input.poType !== undefined && !poTypeEnum.includes(input.poType as any)) {
      throw new PurchasingError(`po_type must be one of ${poTypeEnum.join(", ")}`, 400);
    }
    if (input.priority !== undefined && !poPriorityEnum.includes(input.priority as any)) {
      throw new PurchasingError(`priority must be one of ${poPriorityEnum.join(", ")}`, 400);
    }
    if (
      input.expectedDeliveryDate !== undefined &&
      input.expectedDeliveryDate !== null &&
      (!(input.expectedDeliveryDate instanceof Date) || Number.isNaN(input.expectedDeliveryDate.getTime()))
    ) {
      throw new PurchasingError("expected_delivery_date must be a valid date", 400);
    }

    // First pass: per-line shape + type rules. Build clientId->index map
    // for the second pass (parent resolution).
    const clientIdToIndex = new Map<string, number>();
    const existingLineIds = new Set<number>();
    for (const [idx, line] of input.lines.entries()) {
      const label = `lines[${idx}]`;
      if (!line || typeof line !== "object") {
        throw new PurchasingError(`${label} is invalid`, 400);
      }
      if (line.lineId !== undefined && line.lineId !== null) {
        if (!options.allowExistingLineIds) {
          throw new PurchasingError(`${label}.line_id is not valid when creating a PO`, 400);
        }
        if (
          !Number.isSafeInteger(line.lineId) ||
          line.lineId <= 0 ||
          line.lineId > PG_INTEGER_MAX
        ) {
          throw new PurchasingError(`${label}.line_id must be a positive integer`, 400);
        }
        if (existingLineIds.has(line.lineId)) {
          throw new PurchasingError(`${label}.line_id ${line.lineId} is duplicated`, 400);
        }
        existingLineIds.add(line.lineId);
      }

      const lineType: PoLineType = line.lineType ?? "product";
      if (!isPoLineType(lineType)) {
        throw new PurchasingError(
          `${label}.line_type must be one of ${PO_LINE_TYPES.join(", ")}`,
          400,
        );
      }

      // Description rule: required on non-product lines, optional on product.
      if (lineType !== "product") {
        const desc = typeof line.description === "string" ? line.description.trim() : "";
        if (desc.length === 0) {
          throw new PurchasingError(
            `${label}.description is required for ${lineType} lines`,
            400,
          );
        }
      }

      // Product rule.
      if (lineType === "product") {
        if (
          !Number.isSafeInteger(line.productId) ||
          (line.productId as number) <= 0 ||
          (line.productId as number) > PG_INTEGER_MAX
        ) {
          throw new PurchasingError(`${label}.product_id is required`, 400);
        }
        for (const [field, value] of [
          ["product_variant_id", line.productVariantId],
          ["expected_receive_variant_id", line.expectedReceiveVariantId],
          ["vendor_product_id", line.vendorProductId],
        ] as const) {
          if (
            value !== undefined &&
            value !== null &&
            (!Number.isSafeInteger(value) || value <= 0 || value > PG_INTEGER_MAX)
          ) {
            throw new PurchasingError(`${label}.${field} must be a positive integer`, 400);
          }
        }
        if (
          line.expectedReceiveUnitsPerVariant !== undefined &&
          line.expectedReceiveUnitsPerVariant !== null &&
          (
            !Number.isSafeInteger(line.expectedReceiveUnitsPerVariant) ||
              line.expectedReceiveUnitsPerVariant <= 0 ||
              line.expectedReceiveUnitsPerVariant > PG_INTEGER_MAX
          )
        ) {
          throw new PurchasingError(
            `${label}.expected_receive_units_per_variant must be a positive integer`,
            400,
          );
        }
      } else {
        if (
          line.productId !== undefined &&
          line.productId !== null
        ) {
          throw new PurchasingError(
            `${label}.product_id is only valid on product lines`,
            400,
          );
        }
        if (
          line.productVariantId !== undefined &&
          line.productVariantId !== null
        ) {
          throw new PurchasingError(
            `${label}.product_variant_id is only valid on product lines`,
            400,
          );
        }
        if (
          line.expectedReceiveVariantId !== undefined &&
          line.expectedReceiveVariantId !== null
        ) {
          throw new PurchasingError(
            `${label}.expected_receive_variant_id is only valid on product lines`,
            400,
          );
        }
        if (
          line.expectedReceiveUnitsPerVariant !== undefined &&
          line.expectedReceiveUnitsPerVariant !== null
        ) {
          throw new PurchasingError(
            `${label}.expected_receive_units_per_variant is only valid on product lines`,
            400,
          );
        }
      }

      let normalizedQuotePricing: NormalizedPoLinePricing | null = null;
      if (line.pricing !== undefined) {
        if (lineType !== "product") {
          throw new PurchasingError(`${label}.pricing is only valid on product lines`, 400);
        }
        try {
          normalizedQuotePricing = normalizePoLinePricing(line.pricing);
        } catch (error: any) {
          throw new PurchasingError(`${label}.pricing is invalid: ${error.message}`, 400, {
            code: "PO_LINE_PRICING_INVALID",
            lineIndex: idx,
          });
        }
        if (line.orderQty !== normalizedQuotePricing.orderQty) {
          throw new PurchasingError(
            `${label}.quantity_ordered must equal the piece quantity derived from pricing`,
            400,
            {
              code: "PO_LINE_PRICING_QUANTITY_MISMATCH",
              quantityOrdered: line.orderQty,
              pricingQuantityPieces: normalizedQuotePricing.orderQty,
            },
          );
        }
      }
      if (
        line.pricingSource !== undefined &&
        !["legacy", "manual", "vendor_catalog", "recommendation"].includes(line.pricingSource)
      ) {
        throw new PurchasingError(`${label}.pricing_source is invalid`, 400);
      }
      if (line.pricingSource === "vendor_catalog" && !line.vendorProductId) {
        throw new PurchasingError(
          `${label}.vendor_product_id is required for vendor_catalog pricing`,
          400,
        );
      }
      if (
        normalizedQuotePricing &&
        line.pricingSource !== undefined &&
        line.pricingSource !== "manual" &&
        line.pricingSource !== "vendor_catalog"
      ) {
        throw new PurchasingError(
          `${label}.pricing_source cannot claim trusted legacy or recommendation provenance`,
          400,
          { code: "PO_LINE_PRICING_SOURCE_FORBIDDEN" },
        );
      }
      if (
        !normalizedQuotePricing &&
        line.pricingSource !== undefined &&
        line.pricingSource !== "legacy"
      ) {
        throw new PurchasingError(
          `${label}.pricing_source must be legacy when no explicit quote basis is supplied`,
          400,
          { code: "PO_LINE_PRICING_SOURCE_INVALID_FOR_LEGACY" },
        );
      }
      if (
        line.vendorSku !== undefined &&
        line.vendorSku !== null &&
        (typeof line.vendorSku !== "string" || line.vendorSku.length > 100)
      ) {
        throw new PurchasingError(`${label}.vendor_sku must be at most 100 characters`, 400);
      }
      if (
        line.quoteReference !== undefined &&
        line.quoteReference !== null &&
        (typeof line.quoteReference !== "string" || line.quoteReference.length > 255)
      ) {
        throw new PurchasingError(`${label}.quote_reference must be at most 255 characters`, 400);
      }
      if (
        line.quotedAt !== undefined &&
        line.quotedAt !== null &&
        (!(line.quotedAt instanceof Date) || Number.isNaN(line.quotedAt.getTime()))
      ) {
        throw new PurchasingError(`${label}.quoted_at must be a valid date`, 400);
      }
      if (
        line.quotedAt instanceof Date &&
        line.quotedAt.getTime() > now().getTime() + MAX_QUOTE_CLOCK_SKEW_MS
      ) {
        throw new PurchasingError(`${label}.quoted_at cannot be materially in the future`, 400, {
          code: "PO_LINE_QUOTED_AT_IN_FUTURE",
          lineIndex: idx,
        });
      }
      if (
        line.quoteValidUntil !== undefined &&
        line.quoteValidUntil !== null &&
        (
          typeof line.quoteValidUntil !== "string" ||
          !isValidIsoDateOnly(line.quoteValidUntil)
        )
      ) {
        throw new PurchasingError(`${label}.quote_valid_until must be YYYY-MM-DD`, 400);
      }
      if (
        line.quotedAt instanceof Date &&
        line.quoteValidUntil &&
        line.quoteValidUntil < line.quotedAt.toISOString().slice(0, 10)
      ) {
        throw new PurchasingError(
          `${label}.quote_valid_until cannot be earlier than quoted_at`,
          400,
          { code: "PO_LINE_QUOTE_DATE_INVALID", lineIndex: idx },
        );
      }
      if (line.catalogWrite !== undefined) {
        if (
          !line.catalogWrite ||
          typeof line.catalogWrite !== "object" ||
          line.catalogWrite.mode !== "upsert" ||
          Object.keys(line.catalogWrite).some(
            (key) => key !== "mode" && key !== "setPreferred",
          ) ||
          (
            line.catalogWrite.setPreferred !== undefined &&
            typeof line.catalogWrite.setPreferred !== "boolean"
          )
        ) {
          throw new PurchasingError(`${label}.catalog_write is invalid`, 400, {
            code: "PO_LINE_CATALOG_WRITE_INVALID",
            lineIndex: idx,
          });
        }
        if (lineType !== "product" || !normalizedQuotePricing) {
          throw new PurchasingError(
            `${label}.catalog_write requires explicit product quote pricing`,
            400,
            { code: "PO_LINE_CATALOG_WRITE_PRICING_REQUIRED", lineIndex: idx },
          );
        }
        if (normalizedQuotePricing.pricingBasis === "extended_total") {
          throw new PurchasingError(
            `${label}.catalog_write cannot reuse a quantity-specific extended total`,
            400,
            { code: "PO_LINE_CATALOG_WRITE_EXTENDED_TOTAL", lineIndex: idx },
          );
        }
        if ((line.pricingSource ?? "manual") !== "manual") {
          throw new PurchasingError(
            `${label}.catalog_write is only valid when the PO line consumes a manual quote`,
            400,
            { code: "PO_LINE_CATALOG_WRITE_SOURCE_INVALID", lineIndex: idx },
          );
        }
        if (!(line.quotedAt instanceof Date)) {
          throw new PurchasingError(
            `${label}.quoted_at is required when saving reusable catalog pricing`,
            400,
            { code: "PO_LINE_CATALOG_WRITE_QUOTED_AT_REQUIRED", lineIndex: idx },
          );
        }
      }

      // Qty rule.
      if (!Number.isSafeInteger(line.orderQty) || line.orderQty > PG_INTEGER_MAX) {
        throw new PurchasingError(
          `${label}.quantity_ordered must be an integer`,
          400,
        );
      }
      if (lineType === "product") {
        if (line.orderQty <= 0) {
          throw new PurchasingError(
            `${label}.quantity_ordered must be > 0 for product lines`,
            400,
          );
        }
      } else if (lineType === "fee") {
        if (line.orderQty < 1) {
          throw new PurchasingError(
            `${label}.quantity_ordered must be >= 1 for fee lines`,
            400,
          );
        }
      } else {
        if (line.orderQty !== 1) {
          throw new PurchasingError(
            `${label}.quantity_ordered must be 1 for ${lineType} lines`,
            400,
          );
        }
      }

      // Cost rule — integer; sign varies by type.
      // Spec F Phase 1: accept totalProductCostCents (new shape) OR
      // unitCostMills/unitCostCents (old shape). At least one must be provided.
      const hasCents =
        line.unitCostCents !== undefined && line.unitCostCents !== null;
      const hasMills =
        line.unitCostMills !== undefined && line.unitCostMills !== null;
      const hasTotals =
        line.totalProductCostCents !== undefined &&
        line.totalProductCostCents !== null;

      if (normalizedQuotePricing && (hasCents || hasMills || hasTotals)) {
        throw new PurchasingError(
          `${label}: pricing cannot be combined with legacy unit/total cost fields`,
          400,
          { code: "PO_LINE_PRICING_AMBIGUOUS" },
        );
      }
      if (!normalizedQuotePricing && !hasCents && !hasMills && !hasTotals) {
        throw new PurchasingError(
          `${label}.pricing or a legacy unit/total cost field is required`,
          400,
        );
      }
      if (hasMills && !Number.isSafeInteger(line.unitCostMills)) {
        throw new PurchasingError(
          `${label}.unit_cost_mills must be an integer`,
          400,
        );
      }
      if (hasCents && !Number.isSafeInteger(line.unitCostCents)) {
        throw new PurchasingError(
          `${label}.unit_cost_cents must be an integer`,
          400,
        );
      }
      if (hasTotals && !Number.isSafeInteger(line.totalProductCostCents)) {
        throw new PurchasingError(
          `${label}.total_product_cost_cents must be an integer`,
          400,
        );
      }
      if (
        line.packagingCostCents !== undefined &&
        line.packagingCostCents !== null &&
        (!Number.isSafeInteger(line.packagingCostCents) ||
          (lineType === "product" && line.packagingCostCents < 0))
      ) {
        throw new PurchasingError(
          `${label}.packaging_cost_cents must be a non-negative integer for product lines`,
          400,
        );
      }

      // Sign check (type-specific). Use totals if present, else mills, else cents.
      const primaryCost = normalizedQuotePricing
        ? normalizedQuotePricing.totalProductCostCents
        : hasTotals
          ? (line.totalProductCostCents as number)
          : hasMills
            ? (line.unitCostMills as number)
            : (line.unitCostCents as number);
      switch (lineType) {
        case "product":
        case "fee":
        case "tax":
          if (primaryCost < 0) {
            throw new PurchasingError(
              `${label}: ${lineType} lines require a non-negative cost`,
              400,
            );
          }
          break;
        case "discount":
        case "rebate":
          if (primaryCost > 0) {
            throw new PurchasingError(
              `${label}: ${lineType} lines require a non-positive cost`,
              400,
            );
          }
          break;
        case "adjustment":
          // signed; either sign allowed.
          break;
      }

      // Cents/mills agreement check (authoritative source is mills).
      // Only applies when old shape is used (no totals provided).
      // Signed-aware so discount/rebate/adjustment pairs validate too.
      if (hasMills && hasCents && !hasTotals) {
        const expectedCents = signedMillsToCents(line.unitCostMills as number);
        if (expectedCents !== (line.unitCostCents as number)) {
          throw new PurchasingError(
            `${label}: unit_cost_mills (${line.unitCostMills}) and unit_cost_cents (${line.unitCostCents}) disagree; expected cents=${expectedCents}`,
            400,
          );
        }
      }

      // Register clientId for parent resolution (second pass).
      if (typeof line.clientId === "string" && line.clientId.length > 0) {
        if (clientIdToIndex.has(line.clientId)) {
          throw new PurchasingError(
            `${label}.clientId "${line.clientId}" is duplicated in this request`,
            400,
          );
        }
        clientIdToIndex.set(line.clientId, idx);
      }
    }

    // Second pass: parentClientId resolution.
    for (const [idx, line] of input.lines.entries()) {
      const label = `lines[${idx}]`;
      const parentClientId = line.parentClientId;
      if (parentClientId === undefined || parentClientId === null || parentClientId === "") {
        continue;
      }
      const lineType: PoLineType = line.lineType ?? "product";
      if (lineType === "product") {
        throw new PurchasingError(
          `${label}.parent_client_id is only valid on non-product lines`,
          400,
        );
      }
      if (typeof parentClientId !== "string") {
        throw new PurchasingError(
          `${label}.parent_client_id must be a string`,
          400,
        );
      }
      if (parentClientId === line.clientId) {
        throw new PurchasingError(
          `${label}.parent_client_id cannot reference itself`,
          400,
        );
      }
      const parentIdx = clientIdToIndex.get(parentClientId);
      if (parentIdx === undefined) {
        throw new PurchasingError(
          `${label}.parent_client_id "${parentClientId}" does not match any line in this request`,
          400,
        );
      }
      const parent = input.lines[parentIdx];
      const parentType: PoLineType = parent.lineType ?? "product";
      if (parentType !== "product") {
        throw new PurchasingError(
          `${label}.parent_client_id must reference a product line (found '${parentType}')`,
          400,
        );
      }
    }
  }

  type ResolvedPurchaseOrderLine = {
    line: CreatePurchaseOrderWithLinesInput["lines"][number];
    lineType: PoLineType;
    variant: any;
    product: any;
    vendorProduct: any;
    costs: ReturnType<typeof calculateLineCosts>;
    pricing: NormalizedPoLinePricing | null;
  };

  async function resolvePurchaseOrderLines(
    input: CreatePurchaseOrderWithLinesInput,
  ): Promise<ResolvedPurchaseOrderLine[]> {
    return Promise.all(
      input.lines.map(async (line) => {
        const lineType: PoLineType = line.lineType ?? "product";
        let variant: any = null;
        let product: any = null;
        let vendorProduct: any = null;
        if (lineType === "product") {
          product = await storage.getProductById(line.productId as number);
          if (!product) {
            throw new PurchasingError(`Product ${line.productId} not found`, 404);
          }
          if (product.isActive === false || product.status === "archived") {
            throw new PurchasingError(`Product ${line.productId} is inactive`, 409, {
              code: "PO_LINE_PRODUCT_INACTIVE",
              productId: line.productId,
            });
          }
          const expectedReceiveVariantId =
            line.expectedReceiveVariantId ?? line.productVariantId ?? null;
          if (expectedReceiveVariantId) {
            variant = await storage.getProductVariantById(expectedReceiveVariantId);
            if (!variant) {
              throw new PurchasingError(
                `Expected receive variant ${expectedReceiveVariantId} not found`,
                404,
              );
            }
            if (
              Number.isInteger(variant.productId) &&
              Number(variant.productId) !== Number(product.id)
            ) {
              throw new PurchasingError(
                `Expected receive variant ${expectedReceiveVariantId} does not belong to product ${product.id}`,
                400,
              );
            }
            if (variant.isActive === false) {
              throw new PurchasingError(
                `Expected receive variant ${expectedReceiveVariantId} is inactive`,
                409,
                { code: "PO_LINE_RECEIVE_VARIANT_INACTIVE" },
              );
            }
            if (
              line.expectedReceiveUnitsPerVariant != null &&
              Number(variant.unitsPerVariant) !== line.expectedReceiveUnitsPerVariant
            ) {
              throw new PurchasingError(
                `Expected receive variant ${expectedReceiveVariantId} quantity changed`,
                409,
                {
                  code: "PO_LINE_RECEIVE_UNITS_MISMATCH",
                  submittedUnits: line.expectedReceiveUnitsPerVariant,
                  actualUnits: variant.unitsPerVariant,
                },
              );
            }
          }

          if (line.vendorProductId !== undefined && line.vendorProductId !== null) {
            vendorProduct = await storage.getVendorProductById(line.vendorProductId);
            if (
              !vendorProduct ||
              Number(vendorProduct.vendorId) !== input.vendorId ||
              Number(vendorProduct.productId) !== Number(product.id) ||
              (
                vendorProduct.productVariantId != null &&
                Number(vendorProduct.productVariantId) !== (variant?.id ?? null)
              ) ||
              Number(vendorProduct.isActive ?? 0) !== 1
            ) {
              throw new PurchasingError(
                `Vendor product ${line.vendorProductId} does not match vendor ${input.vendorId} and product ${product.id}`,
                400,
              );
            }
          }
          if (line.pricingSource === "vendor_catalog") {
            if (!vendorProduct || !line.pricing) {
              throw new PurchasingError(
                "vendor_catalog pricing requires vendorProductId and explicit pricing",
                400,
                { code: "PO_LINE_VENDOR_CATALOG_SOURCE_REQUIRES_LINK" },
              );
            }
            if (!vendorCatalogPricingMatches(vendorProduct, line.pricing)) {
              throw new PurchasingError(
                `Vendor product ${line.vendorProductId} pricing no longer matches the submitted quote`,
                409,
                {
                  code: "PO_LINE_VENDOR_CATALOG_PRICE_MISMATCH",
                  vendorProductId: line.vendorProductId,
                  catalogPricingBasis: vendorProduct.pricingBasis ?? "legacy_unknown",
                },
              );
            }
          }
        }

        const pricing = line.pricing ? normalizePoLinePricing(line.pricing) : null;
        const packagingCostCents = Number(line.packagingCostCents) || 0;
        const costs = pricing
          ? {
              subtotalCents: pricing.totalProductCostCents + packagingCostCents,
              discountCents: 0,
              taxCents: 0,
              lineTotalCents: pricing.totalProductCostCents + packagingCostCents,
              totalProductCostCents: pricing.totalProductCostCents,
              packagingCostCents,
              unitCostMills: pricing.unitCostMills,
              unitCostCents: pricing.unitCostCents,
            }
          : calculateLineCosts({
              orderQty: line.orderQty,
              unitCostCents: Number(line.unitCostCents) || 0,
              unitCostMills: typeof line.unitCostMills === "number" ? line.unitCostMills : null,
              totalProductCostCents:
                typeof line.totalProductCostCents === "number" ? line.totalProductCostCents : null,
              packagingCostCents:
                typeof line.packagingCostCents === "number" ? line.packagingCostCents : null,
            });
        for (const [field, value] of Object.entries(costs)) {
          if (!Number.isSafeInteger(value)) {
            throw new PurchasingError(`Calculated ${field} exceeds the supported integer range`, 400, {
              code: "PO_LINE_MONEY_OUT_OF_RANGE",
              field,
            });
          }
        }
        return { line, lineType, variant, product, vendorProduct, costs, pricing };
      }),
    );
  }

  async function lockAndValidatePurchaseOrderReferences(
    tx: any,
    vendorId: number,
    resolvedLines: readonly ResolvedPurchaseOrderLine[],
  ): Promise<any> {
    const vendorRows = await tx
      .select()
      .from(vendorsTable)
      .where(eq(vendorsTable.id, vendorId))
      .limit(1)
      .for("share");
    const vendor = vendorRows[0];
    if (!vendor) throw new PurchasingError("Vendor not found", 404);
    if (Number(vendor.active) !== 1) {
      throw new PurchasingError("Vendor is inactive", 409, {
        code: "PO_VENDOR_INACTIVE",
        vendorId,
      });
    }

    const productLines = resolvedLines.filter((resolved) => resolved.lineType === "product");
    const productIds = [...new Set(
      productLines.map((resolved) => Number(resolved.line.productId)),
    )].sort((a, b) => a - b);
    const liveProducts = productIds.length === 0
      ? []
      : await tx
          .select()
          .from(productsTable)
          .where(inArray(productsTable.id, productIds))
          .orderBy(productsTable.id)
          .for("share");
    const productsById = new Map<number, any>(
      liveProducts.map((row: any) => [Number(row.id), row]),
    );
    for (const resolved of productLines) {
      const productId = Number(resolved.line.productId);
      const live = productsById.get(productId);
      if (!live) throw new PurchasingError(`Product ${productId} not found`, 404);
      if (live.isActive === false || live.status === "archived") {
        throw new PurchasingError(`Product ${productId} is inactive`, 409, {
          code: "PO_LINE_PRODUCT_INACTIVE",
          productId,
        });
      }
      resolved.product = live;
    }

    const variantIds = [...new Set(
      productLines
        .map((resolved) =>
          resolved.line.expectedReceiveVariantId ?? resolved.line.productVariantId ?? null,
        )
        .filter((id): id is number => id !== null),
    )].sort((a, b) => a - b);
    const liveVariants = variantIds.length === 0
      ? []
      : await tx
          .select()
          .from(productVariantsTable)
          .where(inArray(productVariantsTable.id, variantIds))
          .orderBy(productVariantsTable.id)
          .for("share");
    const variantsById = new Map<number, any>(
      liveVariants.map((row: any) => [Number(row.id), row]),
    );
    for (const resolved of productLines) {
      const variantId =
        resolved.line.expectedReceiveVariantId ?? resolved.line.productVariantId ?? null;
      if (variantId === null) {
        resolved.variant = null;
        continue;
      }
      const live = variantsById.get(Number(variantId));
      if (!live) {
        throw new PurchasingError(`Expected receive variant ${variantId} not found`, 404);
      }
      if (Number(live.productId) !== Number(resolved.product.id)) {
        throw new PurchasingError(
          `Expected receive variant ${variantId} does not belong to product ${resolved.product.id}`,
          400,
        );
      }
      if (live.isActive === false) {
        throw new PurchasingError(`Expected receive variant ${variantId} is inactive`, 409, {
          code: "PO_LINE_RECEIVE_VARIANT_INACTIVE",
          productVariantId: variantId,
        });
      }
      if (
        resolved.line.expectedReceiveUnitsPerVariant != null &&
        Number(live.unitsPerVariant) !== resolved.line.expectedReceiveUnitsPerVariant
      ) {
        throw new PurchasingError(`Expected receive variant ${variantId} quantity changed`, 409, {
          code: "PO_LINE_RECEIVE_UNITS_MISMATCH",
          submittedUnits: resolved.line.expectedReceiveUnitsPerVariant,
          actualUnits: live.unitsPerVariant,
        });
      }
      resolved.variant = live;
    }

    const linkedLines = productLines.filter(
      (resolved) => resolved.line.vendorProductId !== undefined && resolved.line.vendorProductId !== null,
    );
    const vendorProductIds = [...new Set(
      linkedLines.map((resolved) => Number(resolved.line.vendorProductId)),
    )].sort((a, b) => a - b);
    const liveVendorProducts = vendorProductIds.length === 0
      ? []
      : await tx
          .select()
          .from(vendorProductsTable)
          .where(inArray(vendorProductsTable.id, vendorProductIds))
          .orderBy(vendorProductsTable.id)
          .for("share");
    const liveById = new Map<number, any>(
      liveVendorProducts.map((row: any) => [Number(row.id), row]),
    );

    for (const resolved of productLines) {
      const vendorProductId = resolved.line.vendorProductId == null
        ? null
        : Number(resolved.line.vendorProductId);
      if (vendorProductId === null) {
        resolved.vendorProduct = null;
        continue;
      }
      const live = liveById.get(vendorProductId);
      const expectedVariantId = resolved.variant?.id ?? null;
      if (
        !live ||
        Number(live.vendorId) !== vendorId ||
        Number(live.productId) !== Number(resolved.product.id) ||
        (live.productVariantId != null && Number(live.productVariantId) !== expectedVariantId) ||
        Number(live.isActive ?? 0) !== 1
      ) {
        throw new PurchasingError(
          `Vendor product ${vendorProductId} changed before the PO could be saved`,
          409,
          { code: "PO_LINE_VENDOR_PRODUCT_MISMATCH", vendorProductId },
        );
      }
      resolved.vendorProduct = live;

      if (resolved.line.pricingSource !== "vendor_catalog") continue;
      if (
        !resolved.line.pricing ||
        !vendorCatalogPricingMatches(live, resolved.line.pricing)
      ) {
        throw new PurchasingError(
          `Vendor product ${vendorProductId} pricing changed before the PO could be saved`,
          409,
          {
            code: "PO_LINE_VENDOR_CATALOG_PRICE_MISMATCH",
            vendorProductId,
            catalogPricingBasis: live.pricingBasis ?? "legacy_unknown",
          },
        );
      }
      const quoteUsability = vendorCatalogQuoteUsability(live, now());
      if (!quoteUsability.usable) {
        throw new PurchasingError(
          `Vendor product ${vendorProductId} has an expired, stale, future-dated, or unverified quote`,
          409,
          { code: quoteUsability.code, vendorProductId },
        );
      }
    }
    return vendor;
  }


  async function assertNoDraftLineDownstreamLinks(
    tx: any,
    lineIds: readonly number[],
  ): Promise<void> {
    if (lineIds.length === 0) return;
    const ids = sql.join(lineIds.map((id) => sql`${id}`), sql`, `);
    const result = await tx.execute(sql`
      SELECT blocked.line_id, blocked.blocker
      FROM (
        SELECT purchase_order_line_id AS line_id, 'inbound_shipment_lines'::text AS blocker
          FROM procurement.inbound_shipment_lines
          WHERE purchase_order_line_id IN (${ids})
        UNION ALL
        SELECT purchase_order_line_id, 'po_receipts'::text
          FROM procurement.po_receipts
          WHERE purchase_order_line_id IN (${ids})
        UNION ALL
        SELECT purchase_order_line_id, 'vendor_invoice_lines'::text
          FROM procurement.vendor_invoice_lines
          WHERE purchase_order_line_id IN (${ids})
        UNION ALL
        SELECT purchase_order_line_id, 'landed_cost_snapshots'::text
          FROM procurement.landed_cost_snapshots
          WHERE purchase_order_line_id IN (${ids})
        UNION ALL
        SELECT purchase_order_line_id, 'landed_cost_adjustments'::text
          FROM procurement.landed_cost_adjustments
          WHERE purchase_order_line_id IN (${ids})
        UNION ALL
        SELECT purchase_order_line_id, 'receiving_lines'::text
          FROM procurement.receiving_lines
          WHERE purchase_order_line_id IN (${ids})
        UNION ALL
        SELECT po_line_id, 'inventory_lots'::text
          FROM inventory.inventory_lots
          WHERE po_line_id IN (${ids})
        UNION ALL
        SELECT parent_line_id, 'active_child_lines'::text
          FROM procurement.purchase_order_lines
          WHERE parent_line_id IN (${ids})
            AND id NOT IN (${ids})
            AND status <> 'cancelled'
      ) AS blocked
      LIMIT 100
    `);
    const blockers = (result.rows ?? []).map((row: any) => ({
      lineId: Number(row.line_id),
      blocker: String(row.blocker),
    }));
    if (blockers.length > 0) {
      throw new PurchasingError(
        "Draft lines have downstream or dependent records and cannot be replaced",
        409,
        { code: "PO_DRAFT_LINE_DOWNSTREAM_LINKS", blockers },
      );
    }
  }

  function buildPurchaseOrderLineValues(
    purchaseOrderId: number,
    resolved: ResolvedPurchaseOrderLine,
    lineNumber: number,
  ): Record<string, unknown> {
    const isProduct = resolved.lineType === "product";
    const trustedCatalog =
      isProduct && resolved.line.pricingSource === "vendor_catalog"
        ? resolved.vendorProduct
        : null;
    return {
      purchaseOrderId,
      lineNumber,
      productId: isProduct ? resolved.product.id : null,
      productVariantId: isProduct ? (resolved.variant?.id ?? null) : null,
      expectedReceiveVariantId: isProduct ? (resolved.variant?.id ?? null) : null,
      vendorProductId: isProduct ? (resolved.line.vendorProductId ?? null) : null,
      sku: isProduct ? (resolved.product.sku ?? resolved.variant?.sku ?? null) : null,
      productName: isProduct ? resolved.product.name : null,
      vendorSku: isProduct
        ? (trustedCatalog ? (trustedCatalog.vendorSku ?? null) : (resolved.line.vendorSku ?? null))
        : null,
      description: resolved.line.description ?? null,
      notes: resolved.line.notes ?? null,
      unitOfMeasure: isProduct
        ? (resolved.variant?.name?.split(" ")[0]?.toLowerCase() ?? "each")
        : null,
      unitsPerUom: isProduct ? (resolved.variant?.unitsPerVariant || 1) : 1,
      expectedReceiveUnitsPerVariant: isProduct
        ? (resolved.line.expectedReceiveUnitsPerVariant || resolved.variant?.unitsPerVariant || 1)
        : 1,
      orderQty: resolved.pricing?.orderQty ?? resolved.line.orderQty,
      unitCostCents: resolved.costs.unitCostCents,
      unitCostMills: resolved.costs.unitCostMills,
      totalProductCostCents: isProduct ? resolved.costs.totalProductCostCents : 0,
      packagingCostCents: isProduct ? resolved.costs.packagingCostCents : 0,
      discountCents: resolved.costs.discountCents,
      taxCents: resolved.costs.taxCents,
      lineTotalCents: resolved.costs.lineTotalCents,
      pricingBasis: isProduct
        ? (resolved.pricing?.pricingBasis ?? "legacy_unknown")
        : "not_applicable",
      pricingSource: isProduct
        ? (resolved.pricing ? (resolved.line.pricingSource ?? "manual") : "legacy")
        : "manual",
      purchaseUom: resolved.pricing?.purchaseUom ?? null,
      purchaseUomQuantity: resolved.pricing?.purchaseUomQuantity ?? null,
      piecesPerPurchaseUom: resolved.pricing?.piecesPerPurchaseUom ?? null,
      quotedUnitCostMills: resolved.pricing?.quotedUnitCostMills ?? null,
      quotedTotalCents: resolved.pricing?.quotedTotalCents ?? null,
      pricingRemainderMills: resolved.pricing?.pricingRemainderMills ?? 0,
      quoteReference: isProduct
        ? (trustedCatalog ? (trustedCatalog.quoteReference ?? null) : (resolved.line.quoteReference ?? null))
        : null,
      quotedAt: isProduct
        ? (trustedCatalog ? (trustedCatalog.quotedAt ?? null) : (resolved.line.quotedAt ?? null))
        : null,
      quoteValidUntil: isProduct
        ? (trustedCatalog ? (trustedCatalog.quoteValidUntil ?? null) : (resolved.line.quoteValidUntil ?? null))
        : null,
      lineType: resolved.lineType,
      parentLineId: null,
      status: "open",
    };
  }

  async function applyPurchaseOrderParentLineLinks(
    tx: any,
    resolvedLines: ResolvedPurchaseOrderLine[],
    persistedLines: any[],
    updatedAt?: Date,
  ): Promise<void> {
    const clientIdToLineId = new Map<string, number>();
    resolvedLines.forEach((resolved, index) => {
      const clientId = resolved.line.clientId;
      const lineId = persistedLines[index]?.id;
      if (typeof clientId === "string" && clientId.length > 0 && Number.isInteger(lineId)) {
        clientIdToLineId.set(clientId, lineId);
      }
    });

    for (let index = 0; index < resolvedLines.length; index++) {
      const parentClientId = resolvedLines[index].line.parentClientId;
      if (!parentClientId) continue;
      const parentLineId = clientIdToLineId.get(parentClientId);
      const childLineId = persistedLines[index]?.id;
      if (!parentLineId || !Number.isInteger(childLineId)) {
        throw new PurchasingError("Unable to resolve draft line parent linkage", 409, {
          code: "PO_DRAFT_PARENT_LINK_CONFLICT",
          parentClientId,
        });
      }
      await tx
        .update(purchaseOrderLinesTable)
        .set({ parentLineId, ...(updatedAt ? { updatedAt } : {}) })
        .where(eq(purchaseOrderLinesTable.id, childLineId));
      persistedLines[index].parentLineId = parentLineId;
    }
  }

  function safeIntegerMoney(value: bigint, field: string): number {
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

  function storedMoneyAsBigInt(value: unknown, field: string): bigint {
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

  function auditDate(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const parsed = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  function snapshotDraftHeader(po: any): Record<string, unknown> {
    return {
      vendor_id: po.vendorId,
      warehouse_id: po.warehouseId ?? null,
      po_type: po.poType ?? null,
      priority: po.priority ?? null,
      expected_delivery_date: auditDate(po.expectedDeliveryDate),
      incoterms: po.incoterms ?? null,
      vendor_notes: po.vendorNotes ?? null,
      internal_notes: po.internalNotes ?? null,
      currency: po.currency ?? null,
      payment_terms_days: po.paymentTermsDays ?? null,
      payment_terms_type: po.paymentTermsType ?? null,
      ship_from_address: po.shipFromAddress ?? null,
      subtotal_cents: po.subtotalCents ?? 0,
      discount_cents: po.discountCents ?? 0,
      tax_cents: po.taxCents ?? 0,
      shipping_cost_cents: po.shippingCostCents ?? 0,
      total_cents: po.totalCents ?? 0,
      line_count: po.lineCount ?? 0,
      updated_at: auditDate(po.updatedAt),
    };
  }

  function snapshotDraftLine(line: any): Record<string, unknown> {
    return {
      id: line.id,
      line_number: line.lineNumber,
      line_type: line.lineType ?? "product",
      parent_line_id: line.parentLineId ?? null,
      product_id: line.productId ?? null,
      product_variant_id: line.productVariantId ?? null,
      expected_receive_variant_id: line.expectedReceiveVariantId ?? null,
      expected_receive_units_per_variant: line.expectedReceiveUnitsPerVariant ?? 1,
      vendor_product_id: line.vendorProductId ?? null,
      sku: line.sku ?? null,
      product_name: line.productName ?? null,
      description: line.description ?? null,
      order_qty: line.orderQty,
      unit_cost_cents: line.unitCostCents ?? 0,
      unit_cost_mills: line.unitCostMills ?? null,
      total_product_cost_cents: line.totalProductCostCents ?? 0,
      packaging_cost_cents: line.packagingCostCents ?? 0,
      pricing_basis: line.pricingBasis ?? "legacy_unknown",
      pricing_source: line.pricingSource ?? "legacy",
      purchase_uom: line.purchaseUom ?? null,
      purchase_uom_quantity: line.purchaseUomQuantity ?? null,
      pieces_per_purchase_uom: line.piecesPerPurchaseUom ?? null,
      quoted_unit_cost_mills: line.quotedUnitCostMills ?? null,
      quoted_total_cents: line.quotedTotalCents ?? null,
      pricing_remainder_mills: line.pricingRemainderMills ?? 0,
      quote_reference: line.quoteReference ?? null,
      quoted_at: auditDate(line.quotedAt),
      quote_valid_until: line.quoteValidUntil ?? null,
      discount_cents: line.discountCents ?? 0,
      tax_cents: line.taxCents ?? 0,
      line_total_cents: line.lineTotalCents ?? 0,
      status: line.status ?? "open",
    };
  }

  async function createPurchaseOrderWithLines(
    input: CreatePurchaseOrderWithLinesInput,
    userId?: string,
    internalOptions?: CreatePurchaseOrderInternalOptions,
  ): Promise<any> {
    validateCreateWithLinesInput(input);

    const vendor = await storage.getVendorById(input.vendorId);
    if (!vendor) throw new PurchasingError("Vendor not found", 404);
    const resolvedLines = await resolvePurchaseOrderLines(input);

    const subtotalCentsBigInt = resolvedLines.reduce(
      (sum, r) => sum + BigInt(r.costs.lineTotalCents),
      BigInt(0),
    );
    const subtotalCents = safeIntegerMoney(subtotalCentsBigInt, "subtotal_cents");

    // Single transaction: header + lines + status history + po_events['created'].
    // A concurrent creator can choose the same max+1 number. The unique index
    // is the arbiter; a conflict rolls back the whole attempt and retries with
    // a freshly generated number.
    const createAttempt = async (poNumber: string) => db.transaction(async (tx: any) => {
      await persistPurchaseOrderCatalogWritesTx(
        tx,
        input.vendorId,
        resolvedLines.map((resolved) => resolved.line),
        userId,
      );
      // Close the catalog-price TOCTOU window before any PO rows are written.
      const lockedVendor = await lockAndValidatePurchaseOrderReferences(
        tx,
        input.vendorId,
        resolvedLines,
      );
      const [header] = await tx
        .insert(purchaseOrdersTable)
        .values({
          poNumber,
          vendorId: input.vendorId,
          warehouseId: input.warehouseId ?? null,
          status: "draft",
          poType: input.poType ?? "standard",
          priority: input.priority ?? "normal",
          expectedDeliveryDate: input.expectedDeliveryDate ?? null,
          incoterms: input.incoterms ?? null,
          vendorNotes: input.vendorNotes ?? null,
          internalNotes: input.internalNotes ?? null,
          currency: lockedVendor.currency || "USD",
          paymentTermsDays: lockedVendor.paymentTermsDays,
          paymentTermsType: lockedVendor.paymentTermsType,
          shipFromAddress: lockedVendor.shipFromAddress,
          subtotalCents,
          totalCents: subtotalCents, // no header discount/tax/shipping on inline create
          lineCount: resolvedLines.length,
          createdBy: userId ?? null,
          updatedBy: userId ?? null,
        })
        .returning();

      const lineRows = resolvedLines.map((resolved, index) =>
        buildPurchaseOrderLineValues(header.id, resolved, index + 1),
      );
      const insertedLines = await tx
        .insert(purchaseOrderLinesTable)
        .values(lineRows)
        .returning({
          id: purchaseOrderLinesTable.id,
          lineNumber: purchaseOrderLinesTable.lineNumber,
        });

      await applyPurchaseOrderParentLineLinks(tx, resolvedLines, insertedLines);

      // Status history: creation row (from NULL -> 'draft').
      await tx.insert(poStatusHistoryTable).values({
        purchaseOrderId: header.id,
        fromStatus: null,
        toStatus: "draft",
        changedBy: userId ?? null,
        notes: "PO created (inline)",
      });

      // Event stream.
      await emitPoEventTx(tx, header.id, "created", userId, {
        source: "inline_editor",
        line_count: resolvedLines.length,
        subtotal_cents: subtotalCents,
      });

      if (internalOptions?.additionalEvent) {
        await emitPoEventTx(
          tx,
          header.id,
          internalOptions.additionalEvent.eventType,
          userId,
          internalOptions.additionalEvent.payload,
        );
      }

      return header;
    });

    let lastConflictingPoNumber: string | null = null;
    for (let attempt = 1; attempt <= PO_NUMBER_ALLOCATION_ATTEMPTS; attempt++) {
      const poNumber = await storage.generatePoNumber();
      try {
        return await createAttempt(poNumber);
      } catch (error: any) {
        if (!isPoNumberUniqueViolation(error)) throw error;
        lastConflictingPoNumber = poNumber;
        if (attempt < PO_NUMBER_ALLOCATION_ATTEMPTS) continue;
      }
    }

    throw new PurchasingError(
      "Could not allocate a unique PO number after concurrent create attempts",
      409,
      {
        code: "PO_NUMBER_ALLOCATION_EXHAUSTED",
        attempts: PO_NUMBER_ALLOCATION_ATTEMPTS,
        lastPoNumber: lastConflictingPoNumber,
      },
    );
  }

  // ── DRAFT FULL-REPLACEMENT FLOW ─────────────────────────────────────────
  //
  // Locks the draft header and lines, checks an optimistic version, preserves
  // retained line ids, cancels removed lines, inserts only new lines, and
  // records the complete before/after state in one transaction.

  async function updateDraftPurchaseOrderWithLines(
    id: number,
    input: UpdateDraftPurchaseOrderWithLinesInput,
    userId?: string,
  ): Promise<{ po: any; lines: any[] }> {
    if (!Number.isSafeInteger(id) || id <= 0 || id > PG_INTEGER_MAX) {
      throw new PurchasingError("Purchase order id must be a positive integer", 400, {
        code: "INVALID_PURCHASE_ORDER_ID",
      });
    }
    if (!input || typeof input !== "object") {
      throw new PurchasingError("Request body is required", 400);
    }
    if (
      !(input.expectedUpdatedAt instanceof Date) ||
      Number.isNaN(input.expectedUpdatedAt.getTime())
    ) {
      throw new PurchasingError("expected_updated_at must be a valid date", 400, {
        code: "PO_DRAFT_EXPECTED_VERSION_REQUIRED",
      });
    }
    validateCreateWithLinesInput(input, { allowExistingLineIds: true });

    const vendor = await storage.getVendorById(input.vendorId);
    if (!vendor) throw new PurchasingError("Vendor not found", 404);
    const resolvedLines = await resolvePurchaseOrderLines(input);
    const subtotalCents = safeIntegerMoney(
      resolvedLines.reduce(
        (sum, resolved) => sum + BigInt(resolved.costs.lineTotalCents),
        BigInt(0),
      ),
      "subtotal_cents",
    );

    return db.transaction(async (tx: any) => {
      const lockedHeaders = await tx
        .select()
        .from(purchaseOrdersTable)
        .where(eq(purchaseOrdersTable.id, id))
        .limit(1)
        .for("update");
      const currentPo = lockedHeaders[0];
      if (!currentPo) throw new PurchasingError("Purchase order not found", 404);

      const recommendationHandoffs = await tx
        .select({ id: purchasingRecommendationPoHandoffsTable.id })
        .from(purchasingRecommendationPoHandoffsTable)
        .where(eq(purchasingRecommendationPoHandoffsTable.purchaseOrderId, id))
        .limit(1);
      if (recommendationHandoffs[0]) {
        throw new PurchasingError(
          "Cannot replace lines on a recommendation-created PO; cancel it and accept a new recommendation",
          409,
          {
            code: "RECOMMENDATION_PO_LINE_AMEND_BLOCKED",
            handoffId: recommendationHandoffs[0].id,
          },
        );
      }

      const physicalStatus = currentPo.physicalStatus ?? currentPo.status;
      const financialStatus = currentPo.financialStatus ?? "unbilled";
      if (
        currentPo.status !== "draft" ||
        physicalStatus !== "draft" ||
        financialStatus !== "unbilled"
      ) {
        throw new PurchasingError(`Cannot edit PO in '${currentPo.status}' status`, 400, {
          code: "PO_NOT_EDITABLE",
          status: currentPo.status,
          physicalStatus,
          financialStatus,
        });
      }
      if (
        storedMoneyAsBigInt(currentPo.invoicedTotalCents, "invoiced_total_cents") !== BigInt(0) ||
        storedMoneyAsBigInt(currentPo.paidTotalCents, "paid_total_cents") !== BigInt(0)
      ) {
        throw new PurchasingError("Cannot replace lines after financial activity exists", 409, {
          code: "PO_DRAFT_HAS_FINANCIAL_ACTIVITY",
        });
      }

      const currentUpdatedAt = new Date(currentPo.updatedAt);
      if (
        Number.isNaN(currentUpdatedAt.getTime()) ||
        currentUpdatedAt.getTime() !== input.expectedUpdatedAt.getTime()
      ) {
        throw new PurchasingError("This draft changed after it was loaded", 409, {
          code: "PO_DRAFT_EDIT_STALE",
          expected_updated_at: input.expectedUpdatedAt.toISOString(),
          current_updated_at: auditDate(currentPo.updatedAt),
        });
      }

      const existingLines = await tx
        .select()
        .from(purchaseOrderLinesTable)
        .where(eq(purchaseOrderLinesTable.purchaseOrderId, id))
        .for("update");
      const activeExistingLines = existingLines.filter((line: any) => line.status !== "cancelled");
      const activeById = new Map<number, any>(
        activeExistingLines.map((line: any) => [Number(line.id), line]),
      );

      const nonEditableLine = activeExistingLines.find((line: any) =>
        (line.status ?? "open") !== "open" ||
        Number(line.receivedQty ?? 0) !== 0 ||
        Number(line.damagedQty ?? 0) !== 0 ||
        Number(line.returnedQty ?? 0) !== 0 ||
        Number(line.cancelledQty ?? 0) !== 0,
      );
      if (nonEditableLine) {
        throw new PurchasingError("Cannot replace draft lines after inventory activity exists", 409, {
          code: "PO_DRAFT_LINE_HAS_ACTIVITY",
          line_id: nonEditableLine.id,
          line_status: nonEditableLine.status,
        });
      }

      for (const resolved of resolvedLines) {
        const lineId = resolved.line.lineId;
        if (lineId !== undefined && !activeById.has(lineId)) {
          throw new PurchasingError(`Line ${lineId} is not an active line on this PO`, 409, {
            code: "PO_DRAFT_LINE_OWNERSHIP",
            line_id: lineId,
            purchase_order_id: id,
          });
        }
      }

      await assertNoDraftLineDownstreamLinks(
        tx,
        activeExistingLines.map((line: any) => Number(line.id)),
      );
      await persistPurchaseOrderCatalogWritesTx(
        tx,
        input.vendorId,
        resolvedLines.map((resolved) => resolved.line),
        userId,
      );
      const lockedVendor = await lockAndValidatePurchaseOrderReferences(
        tx,
        input.vendorId,
        resolvedLines,
      );

      const latestStoredTimestamp = [currentPo, ...activeExistingLines].reduce(
        (latest, row: any) => {
          const value = new Date(row.updatedAt).getTime();
          return Number.isNaN(value) ? latest : Math.max(latest, value);
        },
        currentUpdatedAt.getTime(),
      );
      const changedAt = new Date(
        Math.max(now().getTime(), latestStoredTimestamp + 1),
      );
      const beforeHeader = snapshotDraftHeader(currentPo);
      const beforeLines = activeExistingLines
        .slice()
        .sort((a: any, b: any) => Number(a.lineNumber) - Number(b.lineNumber))
        .map(snapshotDraftLine);
      const retainedLineIds = new Set(
        resolvedLines
          .map((resolved) => resolved.line.lineId)
          .filter((lineId): lineId is number => lineId !== undefined),
      );
      const cancelledLineIds: number[] = [];

      for (const existingLine of activeExistingLines) {
        if (retainedLineIds.has(existingLine.id)) continue;
        const cancelled = await tx
          .update(purchaseOrderLinesTable)
          .set({
            status: "cancelled",
            cancelledQty: existingLine.orderQty,
            parentLineId: null,
            updatedAt: changedAt,
          })
          .where(and(
            eq(purchaseOrderLinesTable.id, existingLine.id),
            eq(purchaseOrderLinesTable.purchaseOrderId, id),
            eq(purchaseOrderLinesTable.status, "open"),
          ))
          .returning({ id: purchaseOrderLinesTable.id });
        if (!cancelled[0]) {
          throw new PurchasingError("A draft line changed while the edit was being applied", 409, {
            code: "PO_DRAFT_EDIT_CONFLICT",
            line_id: existingLine.id,
          });
        }
        cancelledLineIds.push(existingLine.id);
      }

      // Retained line numbers may swap. Stage them at unique negative ids so
      // the active (PO, line_number) unique index cannot see a transient
      // duplicate while the final 1..N sequence is written.
      if (retainedLineIds.size > 0) {
        await tx
          .update(purchaseOrderLinesTable)
          .set({
            lineNumber: sql`-${purchaseOrderLinesTable.id}`,
            updatedAt: changedAt,
          })
          .where(and(
            eq(purchaseOrderLinesTable.purchaseOrderId, id),
            inArray(purchaseOrderLinesTable.id, [...retainedLineIds]),
            eq(purchaseOrderLinesTable.status, "open"),
          ));
      }

      const persistedLines: any[] = [];
      const addedLineIds: number[] = [];
      for (let index = 0; index < resolvedLines.length; index++) {
        const resolved = resolvedLines[index];
        const values = buildPurchaseOrderLineValues(id, resolved, index + 1);
        let persisted: any;
        if (resolved.line.lineId !== undefined) {
          const updatedRows = await tx
            .update(purchaseOrderLinesTable)
            .set({ ...values, updatedAt: changedAt })
            .where(and(
              eq(purchaseOrderLinesTable.id, resolved.line.lineId),
              eq(purchaseOrderLinesTable.purchaseOrderId, id),
              eq(purchaseOrderLinesTable.status, "open"),
            ))
            .returning();
          persisted = updatedRows[0];
          if (!persisted) {
            throw new PurchasingError("A draft line changed while the edit was being applied", 409, {
              code: "PO_DRAFT_EDIT_CONFLICT",
              line_id: resolved.line.lineId,
            });
          }
        } else {
          const insertedRows = await tx
            .insert(purchaseOrderLinesTable)
            .values({ ...values, createdAt: changedAt, updatedAt: changedAt })
            .returning();
          persisted = insertedRows[0];
          if (!persisted) {
            throw new PurchasingError("Failed to insert a draft line", 500, {
              code: "PO_DRAFT_LINE_INSERT_FAILED",
              line_number: index + 1,
            });
          }
          addedLineIds.push(persisted.id);
        }
        persistedLines.push(persisted);
      }

      await applyPurchaseOrderParentLineLinks(tx, resolvedLines, persistedLines, changedAt);

      const discountCents = storedMoneyAsBigInt(currentPo.discountCents, "discount_cents");
      const taxCents = storedMoneyAsBigInt(currentPo.taxCents, "tax_cents");
      const shippingCostCents = storedMoneyAsBigInt(
        currentPo.shippingCostCents,
        "shipping_cost_cents",
      );
      const totalCents = safeIntegerMoney(
        BigInt(subtotalCents) - discountCents + taxCents + shippingCostCents,
        "total_cents",
      );
      const vendorChanged = Number(currentPo.vendorId) !== input.vendorId;
      const headerPatch = {
        vendorId: input.vendorId,
        warehouseId: input.warehouseId === undefined ? currentPo.warehouseId : input.warehouseId,
        poType: input.poType ?? currentPo.poType ?? "standard",
        priority: input.priority ?? currentPo.priority ?? "normal",
        expectedDeliveryDate: input.expectedDeliveryDate ?? null,
        incoterms: input.incoterms ?? null,
        vendorNotes: input.vendorNotes ?? null,
        internalNotes: input.internalNotes ?? null,
        currency: vendorChanged ? (lockedVendor.currency || "USD") : currentPo.currency,
        paymentTermsDays: vendorChanged ? lockedVendor.paymentTermsDays : currentPo.paymentTermsDays,
        paymentTermsType: vendorChanged ? lockedVendor.paymentTermsType : currentPo.paymentTermsType,
        shipFromAddress: vendorChanged ? lockedVendor.shipFromAddress : currentPo.shipFromAddress,
        subtotalCents,
        totalCents,
        lineCount: persistedLines.length,
        receivedLineCount: 0,
        updatedBy: userId ?? null,
        updatedAt: changedAt,
      };
      const updatedHeaders = await tx
        .update(purchaseOrdersTable)
        .set(headerPatch)
        .where(and(
          eq(purchaseOrdersTable.id, id),
          eq(purchaseOrdersTable.status, "draft"),
          eq(purchaseOrdersTable.physicalStatus, "draft"),
          eq(purchaseOrdersTable.financialStatus, "unbilled"),
          eq(purchaseOrdersTable.updatedAt, currentPo.updatedAt),
        ))
        .returning();
      const updatedPo = updatedHeaders[0];
      if (!updatedPo) {
        throw new PurchasingError("Purchase order changed while the edit was being applied", 409, {
          code: "PO_DRAFT_EDIT_CONFLICT",
        });
      }

      await emitPoEventTx(tx, id, "edited", userId, {
        source: "inline_editor",
        expected_updated_at: input.expectedUpdatedAt.toISOString(),
        added_line_ids: addedLineIds,
        cancelled_line_ids: cancelledLineIds,
        before: {
          header: beforeHeader,
          lines: beforeLines,
        },
        after: {
          header: snapshotDraftHeader(updatedPo),
          lines: persistedLines.map(snapshotDraftLine),
        },
      });

      return {
        po: updatedPo,
        lines: persistedLines.map((line, index) => ({
          ...line,
          clientId: resolvedLines[index].line.clientId,
        })),
      };
    });
  }

  // ── NEW SEND FLOW (Spec A) ───────────────────────────────────────────────
  //
  // Replaces Submit -> Approve -> Send with a single call that honors the
  // current procurement settings:
  //  - require_approval=true AND tier matches on total  → pending_approval
  //  - else  → cascade draft→approved→sent in one transaction
  //
  // PDF is STUBBED. Returning { pdf_placeholder: true, reason } keeps the
  // wire contract stable for when real generation lands.

  type SendPurchaseOrderResult = {
    po: any;
    status: string;
    pdf: { pdf_placeholder: true; reason: string } | null;
    pendingApproval: boolean;
  };

  async function sendPurchaseOrder(
    poId: number,
    userId?: string,
  ): Promise<SendPurchaseOrderResult> {
    const expectation = await observeLifecycleState(
      poId,
      ["draft", "approved"],
      (status) => `Cannot send PO in '${status}' status (must be draft or approved)`,
    );
    const result = await sendWithLockedEconomics(poId, userId, expectation, {
      allowDraft: true,
      soloModeOnly: false,
      sentNotes: "Sent to vendor (PDF placeholder)",
    });
    return {
      po: result.po,
      status: result.status,
      pdf: result.pendingApproval
        ? null
        : {
            pdf_placeholder: true,
            reason: "PDF generation not yet implemented",
          },
      pendingApproval: result.pendingApproval,
    };
  }

  // ── DUPLICATE (Spec A) ──────────────────────────────────────────────────
  //
  // Duplicate an existing PO's lines into a fresh draft. Per spec §11.4 the
  // A current, usable catalog quote is preferred. Only a same-vendor copy may
  // fall back to source product economics, and explicit quotes become manual.

  function requiredDuplicateStoredInteger(
    value: unknown,
    field: string,
    src: any,
  ): number {
    if (value === null || value === undefined || !Number.isSafeInteger(Number(value))) {
      throw new PurchasingError(
        `Source PO line ${src.id} has invalid ${field} quote provenance`,
        409,
        {
          code: "PO_DUPLICATE_SOURCE_PRICING_INVALID",
          sourceLineId: src.id,
          field,
        },
      );
    }
    return Number(value);
  }

  function duplicateSourcePricing(src: any): PoLinePricingInput | null {
    let pricing: PoLinePricingInput | null = null;
    switch (src.pricingBasis) {
      case "per_piece":
        pricing = {
          basis: "per_piece",
          quantityPieces: requiredDuplicateStoredInteger(src.orderQty, "order_qty", src),
          unitCostMills: requiredDuplicateStoredInteger(
            src.quotedUnitCostMills,
            "quoted_unit_cost_mills",
            src,
          ),
        };
        break;
      case "per_purchase_uom":
        pricing = {
          basis: "per_purchase_uom",
          purchaseUom: String(src.purchaseUom ?? ""),
          uomQuantity: requiredDuplicateStoredInteger(
            src.purchaseUomQuantity,
            "purchase_uom_quantity",
            src,
          ),
          piecesPerUom: requiredDuplicateStoredInteger(
            src.piecesPerPurchaseUom,
            "pieces_per_purchase_uom",
            src,
          ),
          quotedCostMillsPerUom: requiredDuplicateStoredInteger(
            src.quotedUnitCostMills,
            "quoted_unit_cost_mills",
            src,
          ),
        };
        break;
      case "extended_total":
        pricing = {
          basis: "extended_total",
          quantityPieces: requiredDuplicateStoredInteger(src.orderQty, "order_qty", src),
          quotedTotalCents: requiredDuplicateStoredInteger(
            src.quotedTotalCents,
            "quoted_total_cents",
            src,
          ),
        };
        break;
      default:
        return null;
    }

    try {
      const normalized = normalizePoLinePricing(pricing);
      if (normalized.orderQty !== Number(src.orderQty)) {
        throw new RangeError("stored quote quantity does not equal order_qty");
      }
    } catch (error: any) {
      throw new PurchasingError(
        `Source PO line ${src.id} has invalid stored quote provenance and cannot be duplicated safely`,
        409,
        {
          code: "PO_DUPLICATE_SOURCE_PRICING_INVALID",
          sourceLineId: src.id,
          pricingBasis: src.pricingBasis,
          reason: error?.message ?? "invalid stored quote",
        },
      );
    }
    return pricing;
  }

  function duplicateManualQuoteDate(value: unknown, src: any): Date | null {
    if (value === null || value === undefined) return null;
    const parsed = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(parsed.getTime())) {
      throw new PurchasingError(
        `Source PO line ${src.id} has an invalid quoted_at value`,
        409,
        { code: "PO_DUPLICATE_SOURCE_QUOTE_DATE_INVALID", sourceLineId: src.id },
      );
    }
    return parsed;
  }

  function duplicateManualValidUntil(value: unknown, src: any): string | null {
    if (value === null || value === undefined) return null;
    const dateOnly = value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).slice(0, 10);
    if (!isValidIsoDateOnly(dateOnly)) {
      throw new PurchasingError(
        `Source PO line ${src.id} has an invalid quote_valid_until value`,
        409,
        { code: "PO_DUPLICATE_SOURCE_QUOTE_DATE_INVALID", sourceLineId: src.id },
      );
    }
    return dateOnly;
  }

  function duplicateCatalogPricing(
    vendorProduct: any,
    orderQty: number,
  ): PoLinePricingInput | null {
    if (Number(vendorProduct?.isActive) !== 1) return null;
    if (!vendorCatalogQuoteUsability(vendorProduct, now()).usable) return null;

    let pricing: PoLinePricingInput | null = null;
    if (vendorProduct.pricingBasis === "per_piece") {
      if (vendorProduct.quotedUnitCostMills == null) return null;
      pricing = {
        basis: "per_piece",
        quantityPieces: orderQty,
        unitCostMills: Number(vendorProduct.quotedUnitCostMills),
      };
    } else if (vendorProduct.pricingBasis === "per_purchase_uom") {
      if (vendorProduct.quotedUnitCostMills == null) return null;
      const piecesPerUom = Number(vendorProduct.piecesPerPurchaseUom);
      if (
        !Number.isSafeInteger(piecesPerUom) ||
        piecesPerUom <= 0 ||
        orderQty % piecesPerUom !== 0
      ) {
        return null;
      }
      pricing = {
        basis: "per_purchase_uom",
        purchaseUom: String(vendorProduct.purchaseUom ?? ""),
        uomQuantity: orderQty / piecesPerUom,
        piecesPerUom,
        quotedCostMillsPerUom: Number(vendorProduct.quotedUnitCostMills),
      };
    } else {
      return null;
    }

    try {
      const normalized = normalizePoLinePricing(pricing);
      return normalized.orderQty === orderQty &&
        vendorCatalogPricingMatches(vendorProduct, pricing)
        ? pricing
        : null;
    } catch {
      return null;
    }
  }

  async function findDuplicateCatalogQuote(
    targetVendorId: number,
    src: any,
  ): Promise<{ vendorProduct: any; pricing: PoLinePricingInput } | null> {
    const productId = Number(src.productId);
    const receiveVariantId = src.expectedReceiveVariantId ?? src.productVariantId ?? null;
    const catalogRows = await storage.getVendorProducts({
      vendorId: targetVendorId,
      productId,
      isActive: 1,
    }) ?? [];

    const candidates = catalogRows
      .filter((row: any) =>
        Number(row.vendorId) === targetVendorId &&
        Number(row.productId) === productId &&
        Number(row.isActive) === 1 &&
        (
          row.productVariantId == null ||
          Number(row.productVariantId) === Number(receiveVariantId)
        ),
      )
      .sort((left: any, right: any) => {
        const leftExact = left.productVariantId != null ? 1 : 0;
        const rightExact = right.productVariantId != null ? 1 : 0;
        if (leftExact !== rightExact) return rightExact - leftExact;
        const preferred = Number(right.isPreferred ?? 0) - Number(left.isPreferred ?? 0);
        if (preferred !== 0) return preferred;
        return Number(left.id) - Number(right.id);
      });

    for (const vendorProduct of candidates) {
      const pricing = duplicateCatalogPricing(vendorProduct, Number(src.orderQty));
      if (pricing) return { vendorProduct, pricing };
    }
    return null;
  }

  function duplicateLegacyCost(src: any): Pick<
    PurchaseOrderLineInput,
    "unitCostMills" | "unitCostCents" | "totalProductCostCents"
  > {
    if (src.lineType === "product" || src.lineType == null) {
      if (src.totalProductCostCents !== null && src.totalProductCostCents !== undefined) {
        const total = Number(src.totalProductCostCents);
        if (Number.isSafeInteger(total) && total >= 0) {
          return { totalProductCostCents: total };
        }
      }
    }
    if (src.unitCostMills !== null && src.unitCostMills !== undefined) {
      const mills = Number(src.unitCostMills);
      if (Number.isSafeInteger(mills)) return { unitCostMills: mills };
    }
    if (src.unitCostCents !== null && src.unitCostCents !== undefined) {
      const cents = Number(src.unitCostCents);
      if (Number.isSafeInteger(cents)) return { unitCostCents: cents };
    }
    throw new PurchasingError(
      `Source PO line ${src.id} has invalid legacy economics and cannot be duplicated safely`,
      409,
      { code: "PO_DUPLICATE_SOURCE_LEGACY_PRICE_INVALID", sourceLineId: src.id },
    );
  }

  function duplicateProductPackagingCost(src: any): number {
    const packagingCostCents = Number(src.packagingCostCents ?? 0);
    if (!Number.isSafeInteger(packagingCostCents) || packagingCostCents < 0) {
      throw new PurchasingError(
        `Source PO line ${src.id} has invalid packaging economics and cannot be duplicated safely`,
        409,
        {
          code: "PO_DUPLICATE_SOURCE_PACKAGING_INVALID",
          sourceLineId: src.id,
          packagingCostCents: src.packagingCostCents,
        },
      );
    }
    return packagingCostCents;
  }

  async function duplicatePurchaseOrder(
    sourceId: number,
    overrides: { vendorId?: number; expectedDeliveryDate?: Date | null } | undefined,
    userId?: string,
  ): Promise<any> {
    const source = await storage.getPurchaseOrderById(sourceId);
    if (!source) throw new PurchasingError("Source purchase order not found", 404);
    const sourceLines = await storage.getPurchaseOrderLines(sourceId);
    if (sourceLines.length === 0) {
      throw new PurchasingError("Source PO has no lines to duplicate", 400);
    }

    const targetVendorId = overrides?.vendorId ?? source.vendorId;
    const targetVendorChanged = Number(targetVendorId) !== Number(source.vendorId);

    // Resolve product pricing without changing the stored piece quantity.
    // Catalog provenance is trusted only after the create transaction locks it.
    //
    // Preserve line_type + parent relationships from the source. Since the
    // duplicated PO gets new DB ids, we remap parents via client-side ids.
    // Source line.id → synthesized clientId; child lines reference their
    // parent's synthesized clientId.
    const clientIdBySourceId = new Map<number, string>();
    for (const src of sourceLines) {
      if (src.status === "cancelled") continue;
      clientIdBySourceId.set(src.id, `dup-${src.id}`);
    }

    const dupLines: CreatePurchaseOrderWithLinesInput["lines"] = [];
    for (const src of sourceLines) {
      if (src.status === "cancelled") continue;
      const srcLineType: PoLineType = (src.lineType as PoLineType) ?? "product";

      const parentClientId =
        typeof src.parentLineId === "number"
          ? clientIdBySourceId.get(src.parentLineId) ?? null
          : null;

      const baseLine: PurchaseOrderLineInput = {
        clientId: clientIdBySourceId.get(src.id),
        lineType: srcLineType,
        parentClientId,
        productId: srcLineType === "product" ? Number(src.productId) : null,
        productVariantId: srcLineType === "product"
          ? (src.expectedReceiveVariantId ?? src.productVariantId ?? null)
          : null,
        expectedReceiveVariantId: srcLineType === "product"
          ? (src.expectedReceiveVariantId ?? src.productVariantId ?? null)
          : null,
        expectedReceiveUnitsPerVariant: srcLineType === "product"
          ? (src.expectedReceiveUnitsPerVariant ?? src.unitsPerUom ?? 1)
          : undefined,
        orderQty: src.orderQty,
        description: src.description ?? null,
        vendorSku: src.vendorSku ?? null,
        notes: src.notes ?? null,
      };

      if (srcLineType !== "product") {
        if (targetVendorChanged) {
          throw new PurchasingError(
            `Line ${src.lineNumber ?? src.id} is a ${srcLineType} line and must be reviewed for the target vendor`,
            409,
            {
              code: "PO_DUPLICATE_TARGET_VENDOR_NON_PRODUCT_REVIEW_REQUIRED",
              sourcePoId: source.id,
              sourceLineId: src.id,
              lineType: srcLineType,
              targetVendorId,
            },
          );
        }
        dupLines.push({ ...baseLine, ...duplicateLegacyCost(src) });
        continue;
      }

      const packagingCostCents = duplicateProductPackagingCost(src);
      if (targetVendorChanged && packagingCostCents !== 0) {
        throw new PurchasingError(
          `Product line ${src.lineNumber ?? src.id} has a packaging cost that must be re-entered for the target vendor`,
          409,
          {
            code: "PO_DUPLICATE_TARGET_VENDOR_PACKAGING_REVIEW_REQUIRED",
            sourcePoId: source.id,
            sourceLineId: src.id,
            productId: src.productId,
            targetVendorId,
            packagingCostCents,
          },
        );
      }

      const catalogQuote = await findDuplicateCatalogQuote(targetVendorId, src);
      if (catalogQuote) {
        dupLines.push({
          ...baseLine,
          pricing: catalogQuote.pricing,
          pricingSource: "vendor_catalog",
          vendorProductId: Number(catalogQuote.vendorProduct.id),
          vendorSku: catalogQuote.vendorProduct.vendorSku ?? null,
          packagingCostCents,
        });
        continue;
      }

      if (targetVendorChanged) {
        throw new PurchasingError(
          `Product line ${src.lineNumber ?? src.id} has no active, usable catalog quote for the target vendor`,
          409,
          {
            code: "PO_DUPLICATE_TARGET_VENDOR_QUOTE_REQUIRED",
            sourcePoId: source.id,
            sourceLineId: src.id,
            productId: src.productId,
            expectedReceiveVariantId:
              src.expectedReceiveVariantId ?? src.productVariantId ?? null,
            targetVendorId,
          },
        );
      }

      const sourcePricing = duplicateSourcePricing(src);
      if (sourcePricing) {
        dupLines.push({
          ...baseLine,
          pricing: sourcePricing,
          pricingSource: "manual",
          vendorProductId: null,
          quoteReference: src.quoteReference ?? null,
          quotedAt: duplicateManualQuoteDate(src.quotedAt, src),
          quoteValidUntil: duplicateManualValidUntil(src.quoteValidUntil, src),
          packagingCostCents,
        });
      } else {
        dupLines.push({
          ...baseLine,
          ...duplicateLegacyCost(src),
          pricingSource: "legacy",
          vendorProductId: null,
          packagingCostCents,
        });
      }
    }

    if (dupLines.length === 0) {
      throw new PurchasingError("Source PO has no active lines to duplicate", 400);
    }

    const created = await createPurchaseOrderWithLines(
      {
        vendorId: targetVendorId,
        warehouseId: source.warehouseId ?? null,
        poType: source.poType ?? "standard",
        priority: source.priority ?? "normal",
        expectedDeliveryDate: overrides?.expectedDeliveryDate ?? null,
        incoterms: targetVendorChanged ? null : (source.incoterms ?? null),
        vendorNotes: targetVendorChanged ? null : (source.vendorNotes ?? null),
        internalNotes: source.internalNotes ?? null,
        lines: dupLines,
      },
      userId,
      {
        additionalEvent: {
          eventType: "duplicated_from",
          payload: {
            source_po_id: source.id,
            source_po_number: source.poNumber,
            line_count: dupLines.length,
          },
        },
      },
    );

    return created;
  }

  // ── BULK UPSERT VENDOR CATALOG (Spec A follow-up) ─────────────────
  //
  // Idempotent bulk upsert of entries into procurement.vendor_products for a
  // single vendor. Backs the "Add to catalog?" modal on PO save.
  //
  // Rule #3: unitCostCents is a required integer — no floats.
  // Rule #6: idempotency is enforced at the route layer via Idempotency-Key.
  // Rule #7: the whole batch runs inside one transaction; a failure on any
  //          entry rolls back the batch.
  // Rule #8: every create/update emits a structured audit log line with the
  //          actor and before/after state.

  type BulkCatalogEntry = {
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

  type BulkCatalogResult = {
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

  type CatalogWritablePoLine = Pick<
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

  async function persistPurchaseOrderCatalogWritesTx(
    tx: any,
    vendorId: number,
    lines: CatalogWritablePoLine[],
    userId?: string | null,
  ): Promise<Array<number | null>> {
    const targets = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.catalogWrite?.mode === "upsert");
    if (targets.length === 0) return lines.map(() => null);

    const entries: BulkCatalogEntry[] = targets.map(({ line, index }) => {
      if (!line.pricing || line.pricing.basis === "extended_total") {
        throw new PurchasingError(
          `lines[${index}].catalog_write requires reusable per-piece or purchase-UOM pricing`,
          400,
          { code: "PO_LINE_CATALOG_WRITE_PRICING_REQUIRED", lineIndex: index },
        );
      }
      if (!(line.quotedAt instanceof Date) || Number.isNaN(line.quotedAt.getTime())) {
        throw new PurchasingError(
          `lines[${index}].quoted_at is required when saving reusable catalog pricing`,
          400,
          { code: "PO_LINE_CATALOG_WRITE_QUOTED_AT_REQUIRED", lineIndex: index },
        );
      }
      const productId = Number(line.productId);
      assertPositivePgInteger(productId, `lines[${index}].productId`);
      return {
        productId,
        productVariantId: line.expectedReceiveVariantId ?? line.productVariantId ?? null,
        vendorSku: line.vendorSku,
        pricing: line.pricing,
        quoteReference: line.quoteReference,
        quotedAt: line.quotedAt,
        quoteValidUntil: line.quoteValidUntil,
        packSize: line.pricing.basis === "per_purchase_uom"
          ? line.pricing.piecesPerUom
          : 1,
        ...(line.catalogWrite?.setPreferred === undefined
          ? {}
          : { isPreferred: line.catalogWrite.setPreferred }),
      };
    });

    const result = await bulkUpsertVendorCatalog(vendorId, entries, userId, tx);
    const persisted = [...result.created, ...result.updated];
    const idByKey = new Map(
      persisted.map((row) => [
        bulkCatalogKey(row.productId, row.productVariantId),
        row.vendorProductId,
      ]),
    );
    const ids = lines.map(() => null as number | null);
    targets.forEach(({ line, index }) => {
      const variantId = line.expectedReceiveVariantId ?? line.productVariantId ?? null;
      const vendorProductId = idByKey.get(bulkCatalogKey(Number(line.productId), variantId));
      if (!vendorProductId) {
        throw new PurchasingError("Vendor catalog mapping was not returned after upsert", 409, {
          code: "PO_LINE_CATALOG_WRITE_RESULT_MISSING",
          lineIndex: index,
        });
      }
      line.vendorProductId = vendorProductId;
      ids[index] = vendorProductId;
    });
    return ids;
  }

  type ValidatedBulkCatalogEntry = {
    entry: BulkCatalogEntry;
    index: number;
    variantId: number | null;
    resolvedPricing: {
      unitCostMills: number;
      unitCostCents: number;
      pricingBasis: "legacy_unknown" | "per_piece" | "per_purchase_uom";
      purchaseUom: string | null;
      quotedUnitCostMills: number | null;
      piecesPerPurchaseUom: number | null;
      quoteReference: string | null;
      quotedAt: Date | null;
      quoteValidUntil: string | null;
    };
  };

  function bulkCatalogKey(productId: number, productVariantId: number | null): string {
    return `${productId}:${productVariantId ?? 0}`;
  }

  function assertPositivePgInteger(value: unknown, field: string): asserts value is number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > PG_INTEGER_MAX
    ) {
      throw new PurchasingError(`${field} must be a positive PostgreSQL integer`, 400);
    }
  }

  function assertNonnegativeSafeInteger(value: unknown, field: string): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new PurchasingError(`${field} must be a non-negative safe integer`, 400);
    }
  }

  function assertOptionalCatalogText(
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

  function resolveBulkCatalogEntryPricing(entry: BulkCatalogEntry, index: number) {
    if (entry.pricing) {
      if (entry.pricing.basis === "extended_total") {
        throw new PurchasingError(
          `entries[${index}].pricing is quantity-specific and cannot be reused as a catalog price`,
          400,
          { code: "VENDOR_CATALOG_EXTENDED_TOTAL_NOT_REUSABLE" },
        );
      }
      let normalized: NormalizedPoLinePricing;
      try {
        normalized = normalizePoLinePricing(entry.pricing);
      } catch (error: any) {
        throw new PurchasingError(`entries[${index}].pricing is invalid: ${error.message}`, 400, {
          code: "VENDOR_CATALOG_PRICING_INVALID",
          index,
        });
      }
      if (!(entry.quotedAt instanceof Date) || Number.isNaN(entry.quotedAt.getTime())) {
        throw new PurchasingError(
          `entries[${index}].quotedAt is required for an explicit reusable vendor catalog quote`,
          400,
          { code: "VENDOR_CATALOG_QUOTED_AT_REQUIRED", index },
        );
      }
      if (
        entry.unitCostMills !== undefined &&
        entry.unitCostMills !== null &&
        entry.unitCostMills !== normalized.unitCostMills
      ) {
        throw new PurchasingError(
          `entries[${index}].unitCostMills does not match normalized pricing`,
          400,
        );
      }
      if (
        entry.unitCostCents !== undefined &&
        entry.unitCostCents !== null &&
        entry.unitCostCents !== normalized.unitCostCents
      ) {
        throw new PurchasingError(
          `entries[${index}].unitCostCents does not match normalized pricing`,
          400,
        );
      }
      return {
        unitCostMills: normalized.unitCostMills,
        unitCostCents: normalized.unitCostCents,
        pricingBasis: entry.pricing.basis,
        purchaseUom: normalized.purchaseUom,
        quotedUnitCostMills: normalized.quotedUnitCostMills,
        piecesPerPurchaseUom: normalized.piecesPerPurchaseUom,
        quoteReference: entry.quoteReference?.trim() || null,
        quotedAt: entry.quotedAt ?? null,
        quoteValidUntil: entry.quoteValidUntil ?? null,
      };
    }

    try {
      const hasMills = entry.unitCostMills !== undefined && entry.unitCostMills !== null;
      const unitCostMills = hasMills
        ? Number(entry.unitCostMills)
        : centsToMills(Number(entry.unitCostCents));
      return {
        unitCostMills,
        unitCostCents: millsToCents(unitCostMills),
        pricingBasis: "legacy_unknown" as const,
        purchaseUom: null,
        quotedUnitCostMills: null,
        piecesPerPurchaseUom: null,
        quoteReference: null,
        quotedAt: null,
        quoteValidUntil: null,
      };
    } catch (error: any) {
      throw new PurchasingError(`entries[${index}] price is invalid: ${error.message}`, 400, {
        code: "VENDOR_CATALOG_PRICING_INVALID",
        index,
      });
    }
  }

  function catalogAuditSnapshot(row: any): Record<string, unknown> {
    return {
      unitCostCents: row?.unitCostCents ?? row?.unit_cost_cents ?? null,
      unitCostMills: row?.unitCostMills ?? row?.unit_cost_mills ?? null,
      pricingBasis: row?.pricingBasis ?? row?.pricing_basis ?? null,
      purchaseUom: row?.purchaseUom ?? row?.purchase_uom ?? null,
      quotedUnitCostMills:
        row?.quotedUnitCostMills ?? row?.quoted_unit_cost_mills ?? null,
      piecesPerPurchaseUom:
        row?.piecesPerPurchaseUom ?? row?.pieces_per_purchase_uom ?? null,
      packSize: row?.packSize ?? row?.pack_size ?? null,
      moq: row?.moq ?? null,
      leadTimeDays: row?.leadTimeDays ?? row?.lead_time_days ?? null,
      isPreferred: row?.isPreferred ?? row?.is_preferred ?? null,
      isActive: row?.isActive ?? row?.is_active ?? null,
      vendorSku: row?.vendorSku ?? row?.vendor_sku ?? null,
      vendorProductName: row?.vendorProductName ?? row?.vendor_product_name ?? null,
      quoteReference: row?.quoteReference ?? row?.quote_reference ?? null,
      quotedAt: row?.quotedAt ?? row?.quoted_at ?? null,
      quoteValidUntil: row?.quoteValidUntil ?? row?.quote_valid_until ?? null,
      lastPurchasedAt: row?.lastPurchasedAt ?? row?.last_purchased_at ?? null,
      lastCostMills: row?.lastCostMills ?? row?.last_cost_mills ?? null,
      lastCostCents: row?.lastCostCents ?? row?.last_cost_cents ?? null,
    };
  }

  function rethrowVendorCatalogWriteError(error: any): never {
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

  async function lockVendorProductReferences(
    tx: any,
    vendorId: number,
    productId: number,
    productVariantId: number | null,
  ): Promise<void> {
    const vendorRows = await tx.execute(sql`
      SELECT id, active
      FROM procurement.vendors
      WHERE id = ${vendorId}
      FOR UPDATE
    `);
    const vendor = vendorRows.rows?.[0];
    if (!vendor) throw new PurchasingError("Vendor not found", 404);
    if (Number(vendor.active) !== 1) {
      throw new PurchasingError("Vendor is inactive", 409, {
        code: "VENDOR_CATALOG_VENDOR_INACTIVE",
        vendorId,
      });
    }

    const productRows = await tx.execute(sql`
      SELECT id, is_active
      FROM catalog.products
      WHERE id = ${productId}
      FOR UPDATE
    `);
    const product = productRows.rows?.[0];
    if (!product) {
      throw new PurchasingError(`Product ${productId} not found`, 404, {
        code: "VENDOR_CATALOG_PRODUCT_NOT_FOUND",
        productId,
      });
    }
    if (product.is_active !== true) {
      throw new PurchasingError(`Product ${productId} is inactive`, 409, {
        code: "VENDOR_CATALOG_PRODUCT_INACTIVE",
        productId,
      });
    }

    if (productVariantId === null) return;
    const variantRows = await tx.execute(sql`
      SELECT id, product_id, is_active
      FROM catalog.product_variants
      WHERE id = ${productVariantId}
      FOR UPDATE
    `);
    const variant = variantRows.rows?.[0];
    if (!variant) {
      throw new PurchasingError(`Product variant ${productVariantId} not found`, 404, {
        code: "VENDOR_CATALOG_VARIANT_NOT_FOUND",
        productId,
        productVariantId,
      });
    }
    if (Number(variant.product_id) !== productId) {
      throw new PurchasingError(
        `Product variant ${productVariantId} does not belong to product ${productId}`,
        400,
        {
          code: "VENDOR_CATALOG_VARIANT_PRODUCT_MISMATCH",
          productId,
          productVariantId,
          actualProductId: Number(variant.product_id),
        },
      );
    }
    if (variant.is_active !== true) {
      throw new PurchasingError(`Product variant ${productVariantId} is inactive`, 409, {
        code: "VENDOR_CATALOG_VARIANT_INACTIVE",
        productId,
        productVariantId,
      });
    }
  }

  async function demoteCompetingPreferredMappings(
    tx: any,
    input: {
      vendorId: number;
      productId: number;
      productVariantId: number | null;
      updatedAt: Date;
    },
  ): Promise<Array<{ before: Record<string, unknown>; after: any }>> {
    const result = await tx.execute(sql`
      UPDATE procurement.vendor_products
      SET
        is_preferred = 0,
        updated_at = ${input.updatedAt}
      WHERE product_id = ${input.productId}
        AND COALESCE(product_variant_id, 0) = ${input.productVariantId ?? 0}
        AND vendor_id <> ${input.vendorId}
        AND is_active = 1
        AND is_preferred = 1
      RETURNING *
    `);
    return (result.rows ?? []).map((row: any) => ({
      before: catalogAuditSnapshot({ ...row, is_preferred: 1 }),
      after: row,
    }));
  }

  function appendPreferredDemotionAudits(
    target: Array<Record<string, unknown>>,
    demotions: Array<{ before: Record<string, unknown>; after: any }>,
    actorType: "user" | "system",
    actorId: string,
    promoted: { vendorId: number; productId: number; productVariantId: number | null },
  ): void {
    for (const demotion of demotions) {
      const vendorProductId = Number(demotion.after.id);
      target.push({
        level: "AUDIT",
        actor: `${actorType}:${actorId}`,
        action: "vendor_catalog.preferred_demoted",
        target: `vendor_product:${vendorProductId}`,
        changes: {
          before: demotion.before,
          after: catalogAuditSnapshot(demotion.after),
        },
        context: {
          vendorProductId,
          vendorId: Number(demotion.after.vendor_id),
          productId: promoted.productId,
          productVariantId: promoted.productVariantId,
          promotedVendorId: promoted.vendorId,
        },
      });
    }
  }

  function validateStoredVendorProductQuote(
    row: Record<string, any>,
    timestamp: Date,
  ): void {
    const explicit = row.pricingBasis === "per_piece" || row.pricingBasis === "per_purchase_uom";
    if (!explicit) {
      if (row.quoteReference != null || row.quotedAt != null || row.quoteValidUntil != null) {
        throw new PurchasingError("Legacy catalog pricing cannot carry quote metadata", 400, {
          code: "VENDOR_CATALOG_QUOTE_METADATA_REQUIRES_PRICING",
        });
      }
      return;
    }
    if (!(row.quotedAt instanceof Date) || Number.isNaN(row.quotedAt.getTime())) {
      throw new PurchasingError("Explicit catalog pricing requires quotedAt", 400, {
        code: "VENDOR_CATALOG_QUOTED_AT_REQUIRED",
      });
    }
    if (row.quotedAt.getTime() > timestamp.getTime() + MAX_QUOTE_CLOCK_SKEW_MS) {
      throw new PurchasingError("quotedAt cannot be materially in the future", 400, {
        code: "VENDOR_CATALOG_QUOTED_AT_IN_FUTURE",
      });
    }
    if (
      row.quoteValidUntil != null &&
      (
        typeof row.quoteValidUntil !== "string" ||
        !isValidIsoDateOnly(row.quoteValidUntil)
      )
    ) {
      throw new PurchasingError("quoteValidUntil must be a real YYYY-MM-DD date", 400);
    }
    if (
      row.quoteValidUntil &&
      row.quoteValidUntil < row.quotedAt.toISOString().slice(0, 10)
    ) {
      throw new PurchasingError("quoteValidUntil cannot be earlier than quotedAt", 400, {
        code: "VENDOR_CATALOG_QUOTE_DATE_INVALID",
      });
    }
  }

  async function createVendorProduct(
    data: Record<string, any>,
    userId?: string | null,
  ): Promise<any> {
    assertPositivePgInteger(data.vendorId, "vendorId");
    assertPositivePgInteger(data.productId, "productId");
    if (data.productVariantId !== undefined && data.productVariantId !== null) {
      assertPositivePgInteger(data.productVariantId, "productVariantId");
    }
    const variantId = data.productVariantId ?? null;
    const writeTime = now();
    validateStoredVendorProductQuote(data, writeTime);
    const { actorType, actorId } = resolveActor(userId);

    try {
      return await db.transaction(async (tx: any) => {
        await lockVendorProductReferences(tx, data.vendorId, data.productId, variantId);
        const auditRows: Array<Record<string, unknown>> = [];
        if (Number(data.isActive ?? 1) === 1 && Number(data.isPreferred ?? 0) === 1) {
          const demotions = await demoteCompetingPreferredMappings(tx, {
            vendorId: data.vendorId,
            productId: data.productId,
            productVariantId: variantId,
            updatedAt: writeTime,
          });
          appendPreferredDemotionAudits(
            auditRows,
            demotions,
            actorType,
            actorId,
            { vendorId: data.vendorId, productId: data.productId, productVariantId: variantId },
          );
        }
        const insertedRows = await tx
          .insert(vendorProductsTable)
          .values({ ...data, productVariantId: variantId })
          .returning();
        const row = insertedRows[0];
        if (!row) throw new PurchasingError("Vendor catalog mapping was not created", 409);
        auditRows.push({
          level: "AUDIT",
          actor: `${actorType}:${actorId}`,
          action: "vendor_catalog.created",
          target: `vendor_product:${row.id}`,
          changes: { before: null, after: catalogAuditSnapshot(row) },
          context: {
            vendorId: row.vendorId,
            vendorProductId: row.id,
            productId: row.productId,
            productVariantId: row.productVariantId ?? null,
          },
        });
        await tx.insert(auditEventsTable).values(auditRows);
        return row;
      });
    } catch (error: any) {
      rethrowVendorCatalogWriteError(error);
    }
  }

  async function updateVendorProduct(
    id: number,
    updates: Record<string, any>,
    userId?: string | null,
  ): Promise<any | null> {
    assertPositivePgInteger(id, "vendorProductId");
    for (const identityField of ["vendorId", "productId", "productVariantId"]) {
      if (Object.prototype.hasOwnProperty.call(updates, identityField)) {
        throw new PurchasingError(
          "Vendor-product identity is immutable; create a new mapping and deactivate this one",
          409,
          { code: "VENDOR_CATALOG_IDENTITY_IMMUTABLE", field: identityField },
        );
      }
    }
    const snapshot = await storage.getVendorProductById(id);
    if (!snapshot) return null;
    const { actorType, actorId } = resolveActor(userId);
    const writeTime = now();

    try {
      return await db.transaction(async (tx: any) => {
        await lockVendorProductReferences(
          tx,
          Number(snapshot.vendorId),
          Number(snapshot.productId),
          snapshot.productVariantId == null ? null : Number(snapshot.productVariantId),
        );
        const lockedRows = await tx
          .select()
          .from(vendorProductsTable)
          .where(eq(vendorProductsTable.id, id))
          .limit(1)
          .for("update");
        const current = lockedRows[0];
        if (!current) return null;
        if (
          Number(current.vendorId) !== Number(snapshot.vendorId) ||
          Number(current.productId) !== Number(snapshot.productId) ||
          (current.productVariantId == null ? null : Number(current.productVariantId)) !==
            (snapshot.productVariantId == null ? null : Number(snapshot.productVariantId))
        ) {
          throw new PurchasingError("Vendor-product identity changed concurrently; retry", 409, {
            code: "VENDOR_CATALOG_CONFLICT_RETRY",
          });
        }

        const effective = { ...current, ...updates };
        validateStoredVendorProductQuote(effective, writeTime);
        const auditRows: Array<Record<string, unknown>> = [];
        if (Number(effective.isActive ?? 0) === 1 && Number(effective.isPreferred ?? 0) === 1) {
          const demotions = await demoteCompetingPreferredMappings(tx, {
            vendorId: Number(current.vendorId),
            productId: Number(current.productId),
            productVariantId: current.productVariantId == null
              ? null
              : Number(current.productVariantId),
            updatedAt: writeTime,
          });
          appendPreferredDemotionAudits(
            auditRows,
            demotions,
            actorType,
            actorId,
            {
              vendorId: Number(current.vendorId),
              productId: Number(current.productId),
              productVariantId: current.productVariantId == null
                ? null
                : Number(current.productVariantId),
            },
          );
        }
        const updatedRows = await tx
          .update(vendorProductsTable)
          .set({ ...updates, updatedAt: writeTime })
          .where(eq(vendorProductsTable.id, id))
          .returning();
        const row = updatedRows[0];
        if (!row) return null;
        const deactivated = Number(current.isActive ?? 0) === 1 && Number(row.isActive ?? 0) === 0;
        auditRows.push({
          level: "AUDIT",
          actor: `${actorType}:${actorId}`,
          action: deactivated ? "vendor_catalog.deactivated" : "vendor_catalog.updated",
          target: `vendor_product:${row.id}`,
          changes: {
            before: catalogAuditSnapshot(current),
            after: catalogAuditSnapshot(row),
          },
          context: {
            vendorId: row.vendorId,
            vendorProductId: row.id,
            productId: row.productId,
            productVariantId: row.productVariantId ?? null,
          },
        });
        await tx.insert(auditEventsTable).values(auditRows);
        return row;
      });
    } catch (error: any) {
      rethrowVendorCatalogWriteError(error);
    }
  }

  async function deactivateVendorProduct(
    id: number,
    userId?: string | null,
  ): Promise<boolean> {
    const row = await updateVendorProduct(id, { isActive: 0 }, userId);
    return row !== null;
  }

  async function snapshotPurchaseRecommendations(
    input: CreatePurchaseRecommendationRunInput,
    userId?: string | null,
  ) {
    try {
      return await createPurchaseRecommendationSnapshotService(db).createRun(input, userId);
    } catch (error: any) {
      if (error instanceof RangeError) {
        throw new PurchasingError(error.message, 400, { code: "PURCHASE_RECOMMENDATION_RUN_INVALID" });
      }
      throw error;
    }
  }

  type CreateRfqBatchLineInput = {
    recommendationLineId: number;
    vendorId: number;
    vendorSku?: string | null;
    requestedPieces: number;
    quantityOverrideReason?: string | null;
  };

  async function createRfqBatch(input: {
    idempotencyKey: string;
    requestNote?: string | null;
    responseDueDate?: string | null;
    lines: CreateRfqBatchLineInput[];
  }, userId?: string | null): Promise<{ rfqs: any[]; lines: any[]; reused: boolean }> {
    const idempotencyKey = input.idempotencyKey?.trim();
    if (!idempotencyKey || idempotencyKey.length > 160) {
      throw new PurchasingError("idempotencyKey is required and cannot exceed 160 characters", 400);
    }
    assertOptionalCatalogText(input.requestNote, "requestNote", 20_000);
    if (input.responseDueDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(input.responseDueDate)) {
      throw new PurchasingError("responseDueDate must use YYYY-MM-DD format", 400);
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 500) {
      throw new PurchasingError("lines must contain between 1 and 500 selections", 400);
    }
    const duplicateKeys = new Set<string>();
    for (const [index, line] of input.lines.entries()) {
      assertPositivePgInteger(line.recommendationLineId, `lines[${index}].recommendationLineId`);
      assertPositivePgInteger(line.vendorId, `lines[${index}].vendorId`);
      assertPositivePgInteger(line.requestedPieces, `lines[${index}].requestedPieces`);
      assertOptionalCatalogText(line.vendorSku, `lines[${index}].vendorSku`, 100);
      assertOptionalCatalogText(line.quantityOverrideReason, `lines[${index}].quantityOverrideReason`, 2_000);
      const duplicateKey = `${line.vendorId}:${line.recommendationLineId}`;
      if (duplicateKeys.has(duplicateKey)) {
        throw new PurchasingError(`lines[${index}] duplicates a recommendation for the same supplier`, 400);
      }
      duplicateKeys.add(duplicateKey);
    }

    const vendorIds = Array.from(new Set(input.lines.map((line) => line.vendorId)));
    const writeTime = now();
    const { actorType, actorId } = resolveActor(userId);

    try {
      return await db.transaction(async (tx: any) => {
        const priorRfqs = await tx.select().from(requestForQuotesTable).where(and(
          eq(requestForQuotesTable.idempotencyKey, idempotencyKey),
          inArray(requestForQuotesTable.vendorId, vendorIds),
        ));
        if (priorRfqs.length > 0) {
          if (priorRfqs.length !== vendorIds.length) {
            throw new PurchasingError("The idempotency key was already used for a different supplier grouping", 409, {
              code: "RFQ_IDEMPOTENCY_CONFLICT",
            });
          }
          const priorLines = await tx.select().from(requestForQuoteLinesTable).where(
            inArray(requestForQuoteLinesTable.rfqId, priorRfqs.map((rfq: any) => rfq.id)),
          );
          return { rfqs: priorRfqs, lines: priorLines, reused: true };
        }

        const vendorRows = await tx.select().from(vendorsTable).where(inArray(vendorsTable.id, vendorIds)).for("update");
        const vendorById = new Map(vendorRows.map((vendor: any) => [Number(vendor.id), vendor]));
        if (vendorRows.length !== vendorIds.length || vendorRows.some((vendor: any) => Number(vendor.active) !== 1)) {
          throw new PurchasingError("Every RFQ supplier must exist and be active", 409, {
            code: "RFQ_VENDOR_INACTIVE_OR_MISSING",
          });
        }

        const recommendationIds = Array.from(new Set(input.lines.map((line) => line.recommendationLineId)));
        const recommendationRows = await tx.select().from(purchaseRecommendationLinesTable).where(
          inArray(purchaseRecommendationLinesTable.id, recommendationIds),
        ).for("update");
        const recommendationById = new Map(recommendationRows.map((line: any) => [Number(line.id), line]));
        if (recommendationRows.length !== recommendationIds.length) {
          throw new PurchasingError("One or more recommendation lines no longer exist", 409, {
            code: "RFQ_RECOMMENDATION_MISSING",
          });
        }

        const allocatedBySku = await lockAndLoadActiveRfqAllocations(tx, recommendationRows);

        const grouped = new Map<number, CreateRfqBatchLineInput[]>();
        for (const selection of input.lines) {
          const recommendation = recommendationById.get(selection.recommendationLineId) as any;
          if (!recommendation || recommendation.status !== "open") {
            throw new PurchasingError("A selected recommendation is no longer open", 409, {
              code: "RFQ_RECOMMENDATION_CLOSED",
              recommendationLineId: selection.recommendationLineId,
            });
          }
          const allocationKey = purchasingSkuAllocationKey(recommendation);
          const alreadyAllocated = allocatedBySku.get(allocationKey) ?? 0;
          const remaining = Number(recommendation.recommendedPieces) - alreadyAllocated;
          if (selection.requestedPieces > remaining) {
            throw new PurchasingError("Requested RFQ quantity exceeds the recommendation's remaining quantity", 409, {
              code: "RFQ_ALLOCATION_EXCEEDED",
              recommendationLineId: selection.recommendationLineId,
              recommendedPieces: recommendation.recommendedPieces,
              alreadyAllocated,
              remainingPieces: Math.max(remaining, 0),
            });
          }
          if (selection.requestedPieces !== remaining && (selection.quantityOverrideReason?.trim().length ?? 0) < 3) {
            throw new PurchasingError("A reason is required when changing the suggested RFQ quantity", 400, {
              code: "RFQ_QUANTITY_REASON_REQUIRED",
              recommendationLineId: selection.recommendationLineId,
            });
          }
          allocatedBySku.set(allocationKey, alreadyAllocated + selection.requestedPieces);
          const group = grouped.get(selection.vendorId) ?? [];
          group.push(selection);
          grouped.set(selection.vendorId, group);
        }

        const createdRfqs: any[] = [];
        const createdLines: any[] = [];
        const auditRows: Array<Record<string, unknown>> = [];
        for (const [vendorId, selections] of grouped.entries()) {
          const insertedRfqs = await tx.insert(requestForQuotesTable).values({
            rfqNumber: `RFQ-${writeTime.toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`,
            vendorId,
            idempotencyKey,
            status: "draft",
            requestNote: input.requestNote?.trim() || null,
            currency: String((vendorById.get(vendorId) as any)?.currency ?? "USD").toUpperCase(),
            responseDueDate: input.responseDueDate ?? null,
            createdBy: userId ?? null,
          }).returning();
          const rfq = insertedRfqs[0];
          if (!rfq) throw new PurchasingError("RFQ header was not created", 409);
          createdRfqs.push(rfq);

          for (const selection of selections) {
            const recommendation = recommendationById.get(selection.recommendationLineId) as any;
            const variantId = recommendation.productVariantId ?? null;
            await lockVendorProductReferences(tx, vendorId, Number(recommendation.productId), variantId);
            const mappingRows = await tx.select().from(vendorProductsTable).where(and(
              eq(vendorProductsTable.vendorId, vendorId),
              eq(vendorProductsTable.productId, Number(recommendation.productId)),
              sql`COALESCE(${vendorProductsTable.productVariantId}, 0) = ${variantId ?? 0}`,
            )).limit(1).for("update");
            const existingMapping = mappingRows[0] ?? null;
            const makePreferred = recommendation.preferredVendorId == null;
            if (makePreferred) {
              const demotions = await demoteCompetingPreferredMappings(tx, {
                vendorId,
                productId: Number(recommendation.productId),
                productVariantId: variantId,
                updatedAt: writeTime,
              });
              appendPreferredDemotionAudits(auditRows, demotions, actorType, actorId, {
                vendorId,
                productId: Number(recommendation.productId),
                productVariantId: variantId,
              });
            }

            let vendorProduct: any;
            let catalogAction: "created" | "updated";
            if (existingMapping) {
              const updated = await tx.update(vendorProductsTable).set({
                isActive: 1,
                ...(makePreferred ? { isPreferred: 1 } : {}),
                ...(selection.vendorSku !== undefined ? { vendorSku: selection.vendorSku?.trim() || null } : {}),
                updatedAt: writeTime,
              }).where(eq(vendorProductsTable.id, existingMapping.id)).returning();
              vendorProduct = updated[0];
              catalogAction = "updated";
            } else {
              const inserted = await tx.insert(vendorProductsTable).values({
                vendorId,
                productId: Number(recommendation.productId),
                productVariantId: variantId,
                vendorSku: selection.vendorSku?.trim() || null,
                unitCostCents: null,
                unitCostMills: null,
                pricingBasis: "legacy_unknown",
                isPreferred: makePreferred ? 1 : 0,
                isActive: 1,
              }).returning();
              vendorProduct = inserted[0];
              catalogAction = "created";
            }
            if (!vendorProduct) throw new PurchasingError("Supplier catalog mapping was not saved", 409);

            const insertedLines = await tx.insert(requestForQuoteLinesTable).values({
              rfqId: rfq.id,
              recommendationLineId: selection.recommendationLineId,
              vendorProductId: Number(vendorProduct.id),
              requestedPieces: selection.requestedPieces,
              status: "draft",
              quantityOverrideReason: selection.quantityOverrideReason?.trim() || null,
              purchaseUom: vendorProduct.purchaseUom ?? null,
              piecesPerPurchaseUom: vendorProduct.piecesPerPurchaseUom ?? null,
              requestedPurchaseUomQty: vendorProduct.piecesPerPurchaseUom
                ? String(selection.requestedPieces / Number(vendorProduct.piecesPerPurchaseUom))
                : null,
            }).returning();
            const rfqLine = insertedLines[0];
            if (!rfqLine) throw new PurchasingError("RFQ line was not created", 409);
            createdLines.push(rfqLine);
            auditRows.push({
              level: "AUDIT",
              actor: `${actorType}:${actorId}`,
              action: `vendor_catalog.rfq_${catalogAction}`,
              target: `vendor_product:${vendorProduct.id}`,
              changes: { after: catalogAuditSnapshot(vendorProduct) },
              context: { recommendationLineId: recommendation.id, rfqId: rfq.id, requestedPieces: selection.requestedPieces },
            });
          }
          auditRows.push({
            level: "AUDIT",
            actor: `${actorType}:${actorId}`,
            action: "purchase_rfq.batch_created",
            target: `request_for_quote:${rfq.id}`,
            changes: { after: { rfqNumber: rfq.rfqNumber, vendorId, lineCount: selections.length, status: "draft" } },
            context: { idempotencyKey },
          });
        }
        if (auditRows.length > 0) await tx.insert(auditEventsTable).values(auditRows);
        return { rfqs: createdRfqs, lines: createdLines, reused: false };
      });
    } catch (error: any) {
      if (error?.code === "23514" && String(error?.message ?? "").includes("allocation exceeds")) {
        throw new PurchasingError("Another RFQ consumed some of this recommendation; refresh and try again", 409, {
          code: "RFQ_ALLOCATION_CONFLICT",
        });
      }
      rethrowVendorCatalogWriteError(error);
    }
  }

  async function bulkUpsertVendorCatalog(
    vendorId: number,
    entries: BulkCatalogEntry[],
    userId: string | null | undefined,
    existingTransaction?: any,
  ): Promise<BulkCatalogResult> {
    assertPositivePgInteger(vendorId, "vendorId");
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new PurchasingError("entries must be a non-empty array", 400);
    }
    if (entries.length > MAX_BULK_CATALOG_ENTRIES) {
      throw new PurchasingError(
        `entries cannot contain more than ${MAX_BULK_CATALOG_ENTRIES} items`,
        400,
        { code: "VENDOR_CATALOG_BATCH_TOO_LARGE", maximum: MAX_BULK_CATALOG_ENTRIES },
      );
    }

    // Reject the entire request before opening a transaction if any boundary
    // value or duplicate business key is invalid.
    const validatedEntries: ValidatedBulkCatalogEntry[] = [];
    const firstIndexByKey = new Map<string, number>();
    const boundaryNow = now();
    for (const [idx, entry] of entries.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new PurchasingError(`entries[${idx}] must be an object`, 400);
      }
      assertPositivePgInteger(entry.productId, `entries[${idx}].productId`);
      if (entry.productVariantId !== undefined && entry.productVariantId !== null) {
        assertPositivePgInteger(
          entry.productVariantId,
          `entries[${idx}].productVariantId`,
        );
      }
      const variantId = entry.productVariantId ?? null;
      const key = bulkCatalogKey(entry.productId, variantId);
      const firstIndex = firstIndexByKey.get(key);
      if (firstIndex !== undefined) {
        throw new PurchasingError(
          `entries[${idx}] duplicates entries[${firstIndex}] for product ${entry.productId}` +
            (variantId === null ? " at product level" : ` variant ${variantId}`),
          400,
          {
            code: "VENDOR_CATALOG_DUPLICATE_ENTRY",
            firstIndex,
            duplicateIndex: idx,
            productId: entry.productId,
            productVariantId: variantId,
          },
        );
      }
      firstIndexByKey.set(key, idx);

      const hasCents = entry.unitCostCents !== undefined && entry.unitCostCents !== null;
      const hasMills = entry.unitCostMills !== undefined && entry.unitCostMills !== null;
      if (!entry.pricing && !hasCents && !hasMills) {
        throw new PurchasingError(
          `entries[${idx}].pricing, unitCostCents, or unitCostMills is required`,
          400,
        );
      }
      if (hasCents) {
        assertNonnegativeSafeInteger(
          entry.unitCostCents,
          `entries[${idx}].unitCostCents`,
        );
      }
      if (hasMills) {
        assertNonnegativeSafeInteger(
          entry.unitCostMills,
          `entries[${idx}].unitCostMills`,
        );
      }
      if (hasCents && hasMills) {
        const expected = millsToCents(entry.unitCostMills as number);
        if (expected !== entry.unitCostCents) {
          throw new PurchasingError(
            `entries[${idx}]: unitCostMills (${entry.unitCostMills}) and unitCostCents (${entry.unitCostCents}) disagree; expected cents=${expected}`,
            400,
          );
        }
      }

      assertOptionalCatalogText(
        entry.quoteReference,
        `entries[${idx}].quoteReference`,
        255,
      );
      const hasQuoteMetadata =
        entry.quoteReference !== undefined ||
        entry.quotedAt !== undefined ||
        entry.quoteValidUntil !== undefined;
      if (!entry.pricing && hasQuoteMetadata) {
        throw new PurchasingError(
          `entries[${idx}] quote metadata requires an explicit reusable pricing basis`,
          400,
          { code: "VENDOR_CATALOG_QUOTE_METADATA_REQUIRES_PRICING", index: idx },
        );
      }
      if (
        entry.quotedAt !== undefined &&
        entry.quotedAt !== null &&
        (!(entry.quotedAt instanceof Date) || Number.isNaN(entry.quotedAt.getTime()))
      ) {
        throw new PurchasingError(`entries[${idx}].quotedAt must be a valid date`, 400);
      }
      if (
        entry.quotedAt &&
        entry.quotedAt.getTime() > boundaryNow.getTime() + MAX_QUOTE_CLOCK_SKEW_MS
      ) {
        throw new PurchasingError(
          `entries[${idx}].quotedAt cannot be materially in the future`,
          400,
          { code: "VENDOR_CATALOG_QUOTED_AT_IN_FUTURE", index: idx },
        );
      }
      if (
        entry.quoteValidUntil !== undefined &&
        entry.quoteValidUntil !== null &&
        (
          typeof entry.quoteValidUntil !== "string" ||
          !isValidIsoDateOnly(entry.quoteValidUntil)
        )
      ) {
        throw new PurchasingError(
          `entries[${idx}].quoteValidUntil must be a real YYYY-MM-DD date`,
          400,
        );
      }
      if (
        entry.pricing &&
        entry.quoteValidUntil &&
        entry.quoteValidUntil < entry.quotedAt!.toISOString().slice(0, 10)
      ) {
        throw new PurchasingError(
          `entries[${idx}].quoteValidUntil cannot be earlier than quotedAt`,
          400,
          { code: "VENDOR_CATALOG_QUOTE_DATE_INVALID", index: idx },
        );
      }

      const resolvedPricing = resolveBulkCatalogEntryPricing(entry, idx);
      if (
        resolvedPricing.piecesPerPurchaseUom !== null &&
        resolvedPricing.piecesPerPurchaseUom > PG_INTEGER_MAX
      ) {
        throw new PurchasingError(
          `entries[${idx}].pricing.piecesPerUom exceeds the PostgreSQL integer range`,
          400,
        );
      }
      if (entry.packSize !== undefined && entry.packSize !== null) {
        assertPositivePgInteger(entry.packSize, `entries[${idx}].packSize`);
      }
      if (entry.moq !== undefined && entry.moq !== null) {
        assertPositivePgInteger(entry.moq, `entries[${idx}].moq`);
      }
      if (entry.leadTimeDays !== undefined && entry.leadTimeDays !== null) {
        if (
          typeof entry.leadTimeDays !== "number" ||
          !Number.isSafeInteger(entry.leadTimeDays) ||
          entry.leadTimeDays < 0 ||
          entry.leadTimeDays > PG_INTEGER_MAX
        ) {
          throw new PurchasingError(
            `entries[${idx}].leadTimeDays must be a non-negative PostgreSQL integer`,
            400,
          );
        }
      }
      if (entry.isPreferred !== undefined && typeof entry.isPreferred !== "boolean") {
        throw new PurchasingError(`entries[${idx}].isPreferred must be a boolean`, 400);
      }
      assertOptionalCatalogText(entry.vendorSku, `entries[${idx}].vendorSku`, 100);
      assertOptionalCatalogText(
        entry.vendorProductName,
        `entries[${idx}].vendorProductName`,
        20_000,
      );

      validatedEntries.push({ entry, index: idx, variantId, resolvedPricing });
    }

    const { actorType, actorId } = resolveActor(userId);
    const result: BulkCatalogResult = { created: [], updated: [], skipped: [] };

    const execute = async (tx: any) => {
      // Lock references in a stable order. This makes validation current at
      // commit time and serializes overlapping batches for one vendor.
      const vendorLock = await tx.execute(sql`
        SELECT id, active
        FROM procurement.vendors
        WHERE id = ${vendorId}
        FOR UPDATE
      `);
      const vendor = vendorLock.rows?.[0];
      if (!vendor) throw new PurchasingError("Vendor not found", 404);
      if (Number(vendor.active) !== 1) {
        throw new PurchasingError("Vendor is inactive", 409, {
          code: "VENDOR_CATALOG_VENDOR_INACTIVE",
          vendorId,
        });
      }

      const productIds = [...new Set(validatedEntries.map(({ entry }) => entry.productId))]
        .sort((a, b) => a - b);
      const productLock = await tx.execute(sql`
        SELECT id, is_active
        FROM catalog.products
        WHERE id IN (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})
        ORDER BY id
        FOR UPDATE
      `);
      const productsById = new Map<number, any>(
        (productLock.rows ?? []).map((row: any) => [Number(row.id), row]),
      );
      for (const productId of productIds) {
        const product = productsById.get(productId);
        if (!product) {
          throw new PurchasingError(`Product ${productId} not found`, 404, {
            code: "VENDOR_CATALOG_PRODUCT_NOT_FOUND",
            productId,
          });
        }
        if (product.is_active !== true) {
          throw new PurchasingError(`Product ${productId} is inactive`, 409, {
            code: "VENDOR_CATALOG_PRODUCT_INACTIVE",
            productId,
          });
        }
      }

      const variantIds = [...new Set(
        validatedEntries
          .map(({ variantId }) => variantId)
          .filter((id): id is number => id !== null),
      )].sort((a, b) => a - b);
      const variantsById = new Map<number, any>();
      if (variantIds.length > 0) {
        const variantLock = await tx.execute(sql`
          SELECT id, product_id, is_active
          FROM catalog.product_variants
          WHERE id IN (${sql.join(variantIds.map((id) => sql`${id}`), sql`, `)})
          ORDER BY id
          FOR UPDATE
        `);
        for (const row of variantLock.rows ?? []) {
          variantsById.set(Number(row.id), row);
        }
      }
      for (const { entry, variantId } of validatedEntries) {
        if (variantId === null) continue;
        const variant = variantsById.get(variantId);
        if (!variant) {
          throw new PurchasingError(`Product variant ${variantId} not found`, 404, {
            code: "VENDOR_CATALOG_VARIANT_NOT_FOUND",
            productId: entry.productId,
            productVariantId: variantId,
          });
        }
        if (Number(variant.product_id) !== entry.productId) {
          throw new PurchasingError(
            `Product variant ${variantId} does not belong to product ${entry.productId}`,
            400,
            {
              code: "VENDOR_CATALOG_VARIANT_PRODUCT_MISMATCH",
              productId: entry.productId,
              productVariantId: variantId,
              actualProductId: Number(variant.product_id),
            },
          );
        }
        if (variant.is_active !== true) {
          throw new PurchasingError(`Product variant ${variantId} is inactive`, 409, {
            code: "VENDOR_CATALOG_VARIANT_INACTIVE",
            productId: entry.productId,
            productVariantId: variantId,
          });
        }
      }

      const auditRows: Array<Record<string, unknown>> = [];
      const quoteWriteTime = boundaryNow;
      for (const { entry, variantId, resolvedPricing } of validatedEntries) {
        if (entry.isPreferred === true) {
          const demotions = await demoteCompetingPreferredMappings(tx, {
            vendorId,
            productId: entry.productId,
            productVariantId: variantId,
            updatedAt: quoteWriteTime,
          });
          appendPreferredDemotionAudits(
            auditRows,
            demotions,
            actorType,
            actorId,
            { vendorId, productId: entry.productId, productVariantId: variantId },
          );
        }
        const quotedAt = resolvedPricing.pricingBasis === "legacy_unknown"
          ? null
          : resolvedPricing.quotedAt;
        const insertResult = await tx.execute(sql`
          INSERT INTO procurement.vendor_products (
            vendor_id,
            product_id,
            product_variant_id,
            vendor_sku,
            vendor_product_name,
            unit_cost_cents,
            unit_cost_mills,
            pricing_basis,
            purchase_uom,
            quoted_unit_cost_mills,
            pieces_per_purchase_uom,
            quote_reference,
            quoted_at,
            quote_valid_until,
            pack_size,
            moq,
            lead_time_days,
            is_preferred,
            is_active
          ) VALUES (
            ${vendorId},
            ${entry.productId},
            ${variantId},
            ${entry.vendorSku ?? null},
            ${entry.vendorProductName ?? null},
            ${resolvedPricing.unitCostCents},
            ${resolvedPricing.unitCostMills},
            ${resolvedPricing.pricingBasis},
            ${resolvedPricing.purchaseUom},
            ${resolvedPricing.quotedUnitCostMills},
            ${resolvedPricing.piecesPerPurchaseUom},
            ${resolvedPricing.quoteReference},
            ${quotedAt},
            ${resolvedPricing.quoteValidUntil},
            ${entry.packSize ?? resolvedPricing.piecesPerPurchaseUom ?? 1},
            ${entry.moq ?? 1},
            ${entry.leadTimeDays ?? null},
            ${entry.isPreferred ? 1 : 0},
            1
          )
          ON CONFLICT (
            vendor_id,
            product_id,
            (COALESCE(product_variant_id, 0))
          ) DO NOTHING
          RETURNING *
        `);
        const inserted = insertResult.rows?.[0];
        let row: any;
        let before: Record<string, unknown> | null = null;
        let action: "created" | "updated";

        if (inserted) {
          row = inserted;
          result.created.push({
            vendorProductId: Number(row.id),
            productId: Number(row.product_id),
            productVariantId: row.product_variant_id == null
              ? null
              : Number(row.product_variant_id),
          });
          action = "created";
        } else {
          // ON CONFLICT waits for a concurrent inserter. Re-select with a row
          // lock to capture a stable before-image and prevent lost updates.
          const existingResult = await tx.execute(sql`
            SELECT *
            FROM procurement.vendor_products
            WHERE vendor_id = ${vendorId}
              AND product_id = ${entry.productId}
              AND COALESCE(product_variant_id, 0) = ${variantId ?? 0}
            FOR UPDATE
          `);
          const existing = existingResult.rows?.[0];
          if (!existing) {
            throw new PurchasingError(
              "Vendor catalog conflict could not be resolved; retry the request",
              409,
              {
                code: "VENDOR_CATALOG_CONFLICT_RETRY",
                vendorId,
                productId: entry.productId,
                productVariantId: variantId,
              },
            );
          }
          if (entry.isPreferred === undefined && Number(existing.is_preferred ?? 0) === 1) {
            const demotions = await demoteCompetingPreferredMappings(tx, {
              vendorId,
              productId: entry.productId,
              productVariantId: variantId,
              updatedAt: quoteWriteTime,
            });
            appendPreferredDemotionAudits(
              auditRows,
              demotions,
              actorType,
              actorId,
              { vendorId, productId: entry.productId, productVariantId: variantId },
            );
          }
          before = catalogAuditSnapshot(existing);
          const patch: Record<string, unknown> = {
            unitCostCents: resolvedPricing.unitCostCents,
            unitCostMills: resolvedPricing.unitCostMills,
            pricingBasis: resolvedPricing.pricingBasis,
            purchaseUom: resolvedPricing.purchaseUom,
            quotedUnitCostMills: resolvedPricing.quotedUnitCostMills,
            piecesPerPurchaseUom: resolvedPricing.piecesPerPurchaseUom,
            quoteReference: resolvedPricing.quoteReference,
            quotedAt,
            quoteValidUntil: resolvedPricing.quoteValidUntil,
            isActive: 1,
            updatedAt: now(),
          };
          if (entry.packSize !== undefined && entry.packSize !== null) {
            patch.packSize = entry.packSize;
          } else if (resolvedPricing.piecesPerPurchaseUom !== null) {
            patch.packSize = resolvedPricing.piecesPerPurchaseUom;
          }
          if (entry.moq !== undefined && entry.moq !== null) patch.moq = entry.moq;
          if (entry.leadTimeDays !== undefined && entry.leadTimeDays !== null) {
            patch.leadTimeDays = entry.leadTimeDays;
          }
          if (entry.vendorSku !== undefined && entry.vendorSku !== null) {
            patch.vendorSku = entry.vendorSku;
          }
          if (entry.vendorProductName !== undefined && entry.vendorProductName !== null) {
            patch.vendorProductName = entry.vendorProductName;
          }
          if (entry.isPreferred !== undefined) {
            patch.isPreferred = entry.isPreferred ? 1 : 0;
          }

          const updatedRows = await tx
            .update(vendorProductsTable)
            .set(patch)
            .where(eq(vendorProductsTable.id, Number(existing.id)))
            .returning();
          row = updatedRows[0];
          if (!row) {
            throw new PurchasingError("Vendor catalog row disappeared during update", 409, {
              code: "VENDOR_CATALOG_CONFLICT_RETRY",
              vendorProductId: Number(existing.id),
            });
          }
          result.updated.push({
            vendorProductId: Number(row.id),
            productId: Number(row.productId),
            productVariantId: row.productVariantId == null
              ? null
              : Number(row.productVariantId),
          });
          action = "updated";
        }

        const vendorProductId = Number(row.id);
        auditRows.push({
          level: "AUDIT",
          actor: `${actorType}:${actorId}`,
          action: `vendor_catalog.${action}`,
          target: `vendor_product:${vendorProductId}`,
          changes: {
            before,
            after: catalogAuditSnapshot(row),
          },
          context: {
            vendorId,
            vendorProductId,
            productId: entry.productId,
            productVariantId: variantId,
          },
        });
      }

      // Audit persistence is deliberately atomic with the catalog changes.
      // A failed audit insert rolls back every row in the batch.
      if (auditRows.length > 0) {
        await tx.insert(auditEventsTable).values(auditRows);
      }
    };

    try {
      if (existingTransaction) {
        await execute(existingTransaction);
      } else {
        await db.transaction(execute);
      }
    } catch (error: any) {
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
        error?.constraint === "vendor_products_vendor_product_variant_key_uidx"
      ) {
        throw new PurchasingError("Vendor catalog mapping changed concurrently; retry", 409, {
          code: "VENDOR_CATALOG_CONFLICT_RETRY",
        });
      }
      throw error;
    }

    return result;
  }
  //
  // Returns vendor + suggested lines in one round trip so the editor page
  // can render without a cascade of follow-up fetches.

  type PreloadLine = {
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

  async function getNewPoPreload(params: {
    vendorId?: number;
    variantIds?: number[];
    duplicateFrom?: number;
  }): Promise<{
    vendor: any | null;
    lines: PreloadLine[];
    sourcePo: { poNumber: string; note: string } | null;
  }> {
    const { vendorId, variantIds, duplicateFrom } = params;

    // Duplicate path takes precedence: use source PO's vendor + lines.
    if (duplicateFrom !== undefined) {
      const source = await storage.getPurchaseOrderById(duplicateFrom);
      if (!source) throw new PurchasingError("Source purchase order not found", 404);
      const [vendor, srcLines] = await Promise.all([
        storage.getVendorById(source.vendorId),
        storage.getPurchaseOrderLines(duplicateFrom),
      ]);
      const lines: PreloadLine[] = [];
      for (const src of srcLines) {
        if (src.status === "cancelled") continue;
        // Source priority (duplicate path):
        //   source line.unit_cost_mills → centsToMills(source line.unit_cost_cents)
        //   overridden by matching vendor_products.unit_cost_mills / cents.
        let unitCostMills: number =
          typeof src.unitCostMills === "number" && src.unitCostMills >= 0
            ? src.unitCostMills
            : centsToMills(Number(src.unitCostCents || 0));
        let catalogSource: PreloadLine["catalogSource"] = "duplicate";
        let vendorProductId: number | null = src.vendorProductId ?? null;
        let pricingBasis: PreloadLine["pricingBasis"] =
          src.pricingBasis === "per_piece" || src.pricingBasis === "per_purchase_uom"
            ? src.pricingBasis
            : "legacy_unknown";
        let purchaseUom: string | null = src.purchaseUom ?? null;
        let quotedUnitCostMills: number | null = src.quotedUnitCostMills ?? null;
        let piecesPerPurchaseUom: number | null = src.piecesPerPurchaseUom ?? null;
        let quoteReference: string | null = src.quoteReference ?? null;
        let quotedAt: Date | null = src.quotedAt ?? null;
        let quoteValidUntil: string | null = src.quoteValidUntil ?? null;
        try {
          const vp = await storage.getPreferredVendorProduct(
            src.productId,
            src.expectedReceiveVariantId ?? src.productVariantId,
          );
          if (vp && vp.vendorId === source.vendorId) {
            if (typeof vp.unitCostMills === "number" && vp.unitCostMills >= 0) {
              unitCostMills = vp.unitCostMills;
              catalogSource = "vendor_catalog";
            } else if (typeof vp.unitCostCents === "number") {
              unitCostMills = centsToMills(vp.unitCostCents);
              catalogSource = "vendor_catalog";
            }
            vendorProductId = vp.id ?? null;
            pricingBasis =
              vp.pricingBasis === "per_piece" || vp.pricingBasis === "per_purchase_uom"
                ? vp.pricingBasis
                : "legacy_unknown";
            purchaseUom = vp.purchaseUom ?? null;
            quotedUnitCostMills = vp.quotedUnitCostMills ?? null;
            piecesPerPurchaseUom = vp.piecesPerPurchaseUom ?? null;
            quoteReference = vp.quoteReference ?? null;
            quotedAt = vp.quotedAt ?? null;
            quoteValidUntil = vp.quoteValidUntil ?? null;
          }
        } catch {
          // non-fatal
        }
        lines.push({
          productId: src.productId,
          productVariantId: src.expectedReceiveVariantId ?? src.productVariantId,
          expectedReceiveVariantId: src.expectedReceiveVariantId ?? src.productVariantId,
          expectedReceiveUnitsPerVariant: src.expectedReceiveUnitsPerVariant ?? src.unitsPerUom ?? 1,
          productName: src.productName ?? "",
          sku: src.sku ?? null,
          variantDescription: null,
          uomLabel: src.unitOfMeasure ?? null,
          suggestedQty: src.orderQty,
          unitCostCents: millsToCents(unitCostMills),
          unitCostMills,
          catalogSource,
          vendorProductId,
          pricingBasis,
          purchaseUom,
          quotedUnitCostMills,
          piecesPerPurchaseUom,
          quoteReference,
          quotedAt,
          quoteValidUntil,
        });
      }
      return {
        vendor: vendor ?? null,
        lines,
        sourcePo: {
          poNumber: source.poNumber,
          note: `Duplicated from ${source.poNumber}`,
        },
      };
    }

    const vendor = vendorId ? await storage.getVendorById(vendorId) : null;

    const lines: PreloadLine[] = [];
    if (Array.isArray(variantIds) && variantIds.length > 0) {
      for (const vid of variantIds) {
        if (!Number.isInteger(vid) || vid <= 0) continue;
        const variant = await storage.getProductVariantById(vid);
        if (!variant) continue;
        const product = await storage.getProductById(variant.productId);
        if (!product) continue;
        // Source priority (variant path) per spec:
        //   vendor_products.unit_cost_mills
        //   → centsToMills(vendor_products.unit_cost_cents)
        //   → centsToMills(variant.standardCostCents)
        //   → centsToMills(variant.lastCostCents)
        //   → 0
        let unitCostMills: number = centsToMills(
          Number(variant.standardCostCents ?? variant.lastCostCents ?? 0),
        );
        let catalogSource: PreloadLine["catalogSource"] = "product_default";
        let vendorProductId: number | null = null;
        let pricingBasis: PreloadLine["pricingBasis"] = "legacy_unknown";
        let purchaseUom: string | null = null;
        let quotedUnitCostMills: number | null = null;
        let piecesPerPurchaseUom: number | null = null;
        let quoteReference: string | null = null;
        let quotedAt: Date | null = null;
        let quoteValidUntil: string | null = null;
        if (vendorId) {
          try {
            const vp = await storage.getPreferredVendorProduct(product.id, variant.id);
            if (vp && vp.vendorId === vendorId) {
              if (typeof vp.unitCostMills === "number" && vp.unitCostMills >= 0) {
                unitCostMills = vp.unitCostMills;
                catalogSource = "vendor_catalog";
              } else if (typeof vp.unitCostCents === "number") {
                unitCostMills = centsToMills(vp.unitCostCents);
                catalogSource = "vendor_catalog";
              }
              vendorProductId = vp.id ?? null;
              pricingBasis =
                vp.pricingBasis === "per_piece" || vp.pricingBasis === "per_purchase_uom"
                  ? vp.pricingBasis
                  : "legacy_unknown";
              purchaseUom = vp.purchaseUom ?? null;
              quotedUnitCostMills = vp.quotedUnitCostMills ?? null;
              piecesPerPurchaseUom = vp.piecesPerPurchaseUom ?? null;
              quoteReference = vp.quoteReference ?? null;
              quotedAt = vp.quotedAt ?? null;
              quoteValidUntil = vp.quoteValidUntil ?? null;
            }
          } catch {
            // non-fatal
          }
        }
        lines.push({
          productId: product.id,
          productVariantId: variant.id,
          expectedReceiveVariantId: variant.id,
          expectedReceiveUnitsPerVariant: variant.unitsPerVariant || 1,
          productName: product.name ?? "",
          sku: product.sku ?? variant.sku ?? null,
          variantDescription: variant.name ?? null,
          uomLabel: variant.name?.split(" ")[0]?.toLowerCase() ?? null,
          // No reorder_quantity column today. Default to 1 so the row is
          // usable; users edit qty in the lines editor.
          suggestedQty: 1,
          unitCostCents: millsToCents(unitCostMills),
          unitCostMills,
          catalogSource,
          vendorProductId,
          pricingBasis,
          purchaseUom,
          quotedUnitCostMills,
          piecesPerPurchaseUom,
          quoteReference,
          quotedAt,
          quoteValidUntil,
        });
      }
    }

    return { vendor, lines, sourcePo: null };
  }

  // ── ON-ORDER QUERY ──────────────────────────────────────

  async function getOnOrderQty(productVariantId: number): Promise<{
    onOrderQty: number;
    openPoCount: number;
    earliestExpectedDate: Date | null;
  }> {
    const openLines = await storage.getOpenPoLinesForVariant(productVariantId);
    let total = 0;
    let earliestDate: Date | null = null;
    const poIds = new Set<number>();

    for (const line of openLines) {
      const remaining = line.orderQty - (line.receivedQty || 0) - (line.cancelledQty || 0);
      if (remaining > 0) {
        total += remaining;
        poIds.add(line.purchaseOrderId);

        const lineDate = line.expectedDeliveryDate || line.promisedDate;
        if (lineDate && (!earliestDate || lineDate < earliestDate)) {
          earliestDate = lineDate;
        }
      }
    }

    return {
      onOrderQty: total,
      openPoCount: poIds.size,
      earliestExpectedDate: earliestDate,
    };
  }

  // ── PUBLIC API ──────────────────────────────────────────────────

  return {
    // PO CRUD
    createPO,
    updatePO,
    updateDeliverySchedule,
    deletePO,
    getPurchaseOrders: (filters?: any) => storage.getPurchaseOrders(filters),
    getPurchaseOrdersCount: (filters?: any) => storage.getPurchaseOrdersCount(filters),
    getPurchaseOrderById: (id: number) => storage.getPurchaseOrderById(id),
    getPurchaseOrderByPoNumber: (poNumber: string) => storage.getPurchaseOrderByPoNumber(poNumber),

    // Lines
    addLine: hardenedAddLine,
    addLineCommand: hardenedAddLineCommand,
    updateIncotermsAndCharges,
    addBulkLines: hardenedAddBulkLines,
    addBulkLinesCommand: hardenedAddBulkLinesCommand,
    updateLine: hardenedUpdateLine,
    updateLineCommand: hardenedUpdateLineCommand,
    deleteLine: hardenedCancelLine,
    cancelLineCommand: hardenedCancelLineCommand,
    getPurchaseOrderLines: (poId: number) => storage.getPurchaseOrderLines(poId),
    getPurchaseOrderLineById: (id: number) => storage.getPurchaseOrderLineById(id),

    // Status transitions
    submit,
    returnToDraft,
    approve,
    send,
    sendToVendor,
    acknowledge,
    cancel,
    close,
    closeShort,
    executeLifecycleCommand,

    // Recalculate
    recalculateTotals,
    computePoTotalsFromLines,
    computeAllocatedLineCosts,
    getAllocatedLineCostsForPo: async (poId: number) => {
      const lines = await storage.getPurchaseOrderLines(poId);
      return computeAllocatedLineCosts(lines);
    },

    // Receiving integration
    createReceiptFromPO,
    createReceiptFromShipment,
    getShipmentReceiptPackResolution,
    getPurchaseOrderReceiveOptions,
    getShipmentPoReceiveOptions,
    onReceivingOrderClosed,

    // Dual-track lifecycle (migration 0565)
    transitionPhysical,
    transitionFinancial,
    recomputeFinancialAggregates,
    findOpenPoLineByProduct,

    // On-order query
    getOnOrderQty,

    // History / Audit
    getPoStatusHistory: (poId: number) => storage.getPoStatusHistory(poId),
    getPoRevisions: (poId: number) => storage.getPoRevisions(poId),
    getPoReceipts: (poId: number) => storage.getPoReceipts(poId),

    // Approval tiers
    getApprovalTiers: () => storage.getAllPoApprovalTiers(),
    getApprovalTierById: (id: number) => storage.getPoApprovalTierById(id),
    createApprovalTier: (data: any) => (storage as any).createPoApprovalTier(data),
    updateApprovalTier: (id: number, updates: any) => (storage as any).updatePoApprovalTier(id, updates),
    deleteApprovalTier: (id: number) => (storage as any).deletePoApprovalTier(id),

    // Vendor Products
    getVendorProducts: (filters?: any) => storage.getVendorProducts(filters),
    getVendorProductById: (id: number) => storage.getVendorProductById(id),
    getPreferredVendorProduct: (productId: number, variantId?: number) => storage.getPreferredVendorProduct(productId, variantId),
    createVendorProduct,
    updateVendorProduct,
    deleteVendorProduct: deactivateVendorProduct,
    bulkUpsertVendorCatalog,
    snapshotPurchaseRecommendations,
    createRfqBatch,

    // Spec A: inline create, one-click send, duplicate, preload, settings.
    createPurchaseOrderWithLines,
    updateDraftPurchaseOrderWithLines,
    sendPurchaseOrder,
    duplicatePurchaseOrder,
    getNewPoPreload,
    getProcurementSettings,
    updateProcurementSetting,
    emitPoEvent,
  };
}
