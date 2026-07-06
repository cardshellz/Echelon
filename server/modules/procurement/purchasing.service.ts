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

import { eq, and, sql, inArray, ne } from "drizzle-orm";
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
  poStatusHistory as poStatusHistoryTable,
  poEvents as poEventsTable,
  vendorProducts as vendorProductsTable,
  warehouseSettings as warehouseSettingsTable,
} from "@shared/schema";
import type { PoLineType, PoPhysicalStatus, PoFinancialStatus } from "@shared/schema/procurement.schema";
import {
  PO_LINE_TYPES,
  isPoLineType,
} from "@shared/schema/procurement.schema";
import { Decimal } from "decimal.js";
import {
  centsToMills,
  millsToCents,
  computeLineTotalCentsFromMills,
} from "@shared/utils/money";
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
  generatePoNumber(): Promise<string>;

  // PO Lines
  getPurchaseOrderLines(purchaseOrderId: number): Promise<any[]>;
  getPurchaseOrderLineById(id: number): Promise<any>;
  createPurchaseOrderLine(data: any): Promise<any>;
  bulkCreatePurchaseOrderLines(lines: any[]): Promise<any[]>;
  updatePurchaseOrderLine(id: number, updates: any): Promise<any>;
  deletePurchaseOrderLine(id: number): Promise<boolean>;
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

const EDITABLE_STATUSES = new Set(["draft"]);
// Broader set for amending existing lines (cost corrections, qty adjustments) — any non-terminal state
const LINE_AMENDABLE_STATUSES = new Set(["draft", "pending_approval", "approved", "sent", "acknowledged", "partially_received"]);
const CANCELLABLE_FROM = new Set(["draft", "pending_approval", "approved"]);
const VOIDABLE_FROM = new Set(["sent", "acknowledged"]);
const RECEIVABLE_SHIPMENT_STATUSES = new Set(["at_port", "customs_clearance", "delivered", "costing", "closed"]);
const ACTIVE_RECEIPT_STATUSES = new Set(["draft", "open", "receiving", "verified"]);
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

export function createPurchasingService(db: any, storage: Storage) {

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
      // Derive per-unit from subtotal (product + packaging) / qty so the
      // full cost basis flows through to inventory lots and COGS.
      resolvedUnitCostMills =
        qty > 0
          ? Number(
              signedRoundHalfUpDiv(
                BigInt(subtotalCents) * BigInt(100),
                BigInt(qty),
              ),
            )
          : 0;
      resolvedUnitCostCents =
        qty > 0
          ? Number(
              signedRoundHalfUpDiv(
                BigInt(subtotalCents),
                BigInt(qty),
              ),
            )
          : 0;
    } else {
      // OLD SHAPE: mills or cents as source (backward compat).
      const millsAuthoritative =
        typeof line.unitCostMills === "number" &&
        Number.isInteger(line.unitCostMills) &&
        line.unitCostMills > 0;

      subtotalCents = millsAuthoritative
        ? computeLineTotalCentsFromMills(line.unitCostMills as number, qty)
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
    createdBy?: string;
  }) {
    // Validate vendor
    const vendor = await storage.getVendorById(data.vendorId);
    if (!vendor) throw new PurchasingError("Vendor not found", 404);

    const poNumber = await storage.generatePoNumber();

    try {
      const po = await storage.createPurchaseOrder({
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
      return po;
    } catch (error: any) {
      if (error?.code === "23505") {
        throw new PurchasingError(
          `PO number '${poNumber}' already in use by an active record.`,
          409,
        );
      }
      throw error;
    }
  }

  async function updatePO(id: number, updates: Record<string, any>, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    if (!EDITABLE_STATUSES.has(po.status)) {
      throw new PurchasingError(`Cannot edit PO in '${po.status}' status`, 400);
    }

    // updatePO is a generic edit (notes, priority, etc.). No status change,
    // so we use the plain update helper. Previously used
    // updatePurchaseOrderStatusWithHistory which required historyData we
    // weren't supplying, causing to_status NOT NULL violations on any
    // non-status field edit.
    return await storage.updatePurchaseOrder(id, { ...updates, updatedBy: userId });
  }

  async function deletePO(id: number) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    if (po.status !== "draft") {
      throw new PurchasingError("Can only delete POs in draft status", 400);
    }
    return await storage.deletePurchaseOrder(id);
  }

  // ── INCOTERMS & HEADER CHARGES ────────────────────────────────────
  // Allows updating incoterms + shipping/tax charges at any non-cancelled status.
  // Discount is limited to draft. All changes are audit-trailed.

  function fmtCents(cents: number | null | undefined): string {
    return `$${((Number(cents) || 0) / 100).toFixed(2)}`;
  }

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
      const po = await storage.getPurchaseOrderById(id);
      if (!po) throw new PurchasingError("Purchase order not found", 404);
      if (po.status === "cancelled") throw new PurchasingError("Cannot update a cancelled PO", 400);
  
      const changes: string[] = [];
      const patch: Record<string, any> = {};
  
      if (updates.incoterms !== undefined && updates.incoterms !== po.incoterms) {
        changes.push(`Incoterms: ${po.incoterms || "none"} → ${updates.incoterms || "none"}`);
        patch.incoterms = updates.incoterms;
      }
      if (updates.discountCents !== undefined && updates.discountCents !== Number(po.discountCents)) {
        if (po.status !== "draft") throw new PurchasingError("Discount can only be changed in draft status", 400);
        changes.push(`Discount: ${fmtCents(po.discountCents)} → ${fmtCents(updates.discountCents)}`);
        patch.discountCents = updates.discountCents;
      }
      if (updates.taxCents !== undefined && updates.taxCents !== Number(po.taxCents)) {
        changes.push(`Tax: ${fmtCents(po.taxCents)} → ${fmtCents(updates.taxCents)}`);
        patch.taxCents = updates.taxCents;
      }
      if (updates.shippingCostCents !== undefined && updates.shippingCostCents !== Number(po.shippingCostCents)) {
        changes.push(`Shipping: ${fmtCents(po.shippingCostCents)} → ${fmtCents(updates.shippingCostCents)}`);
        patch.shippingCostCents = updates.shippingCostCents;
      }
      if (updates.overReceiptTolerancePct !== undefined && updates.overReceiptTolerancePct !== Number(po.overReceiptTolerancePct)) {
        changes.push(`Over-Receipt Tolerance: ${Number(po.overReceiptTolerancePct || 0)}% → ${updates.overReceiptTolerancePct}%`);
        patch.overReceiptTolerancePct = String(updates.overReceiptTolerancePct);
      }

    if (changes.length === 0) return po;

    patch.updatedBy = userId;
    // No status transition here — incoterms/charges edits don't change PO
    // status, they just modify header fields. Use the plain update helper.
    // (The earlier call site passed historyData with wrong field names
    // oldStatus/newStatus/changeNotes that don't map to po_status_history
    // columns, so to_status stayed NULL and the insert blew up.)
    // Audit trail is still captured on po_events via the parent mutation.
    await storage.updatePurchaseOrder(id, patch);
    return await recalculateTotals(id, userId);
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
      unitCostCents: data.unitCostCents,
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
        unitCostCents: line.unitCostCents,
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

    await storage.deletePurchaseOrderLine(lineId);
    await recalculateTotals(line.purchaseOrderId, userId);
    return true;
  }

  // ── STATUS TRANSITIONS ──────────────────────────────────────────

  async function submit(id: number, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    // Validate at least 1 non-cancelled line with qty > 0
    const lines = await storage.getPurchaseOrderLines(id);
    const activeLines = lines.filter((l: any) => l.status !== "cancelled" && l.orderQty > 0);
    if (activeLines.length === 0) {
      throw new PurchasingError("PO must have at least one line with quantity > 0", 400);
    }

    // Recalculate totals before checking approval
    await recalculateTotals(id, userId);
    const updatedPo = await storage.getPurchaseOrderById(id);
    const totalCents = Number(updatedPo.totalCents || 0);

    // Check approval tiers
    const tier = await storage.getMatchingApprovalTier(totalCents);

    if (tier) {
      // Needs approval
      assertTransition(po.status, "pending_approval");
      return updatePurchaseOrderStatusWithEvent(
        id,
        {
          status: "pending_approval",
          approvalTierId: tier.id,
          updatedBy: userId,
        },
        {
          fromStatus: po.status,
          toStatus: "pending_approval",
          changedBy: userId,
          notes: `Approval required: ${tier.tierName}`,
        },
        "submitted",
        userId,
        {
          from_status: po.status,
          to_status: "pending_approval",
          tier_id: tier.id,
          tier_name: tier.tierName,
          total_cents: totalCents,
        },
      );
    } else {
      // Auto-approve (no tier matches)
      assertTransition(po.status, "approved");
      return updatePurchaseOrderStatusWithEvent(
        id,
        {
          status: "approved",
          approvedBy: userId,
          approvedAt: new Date(),
          approvalNotes: "Auto-approved (below approval threshold)",
          updatedBy: userId,
        },
        {
          fromStatus: po.status,
          toStatus: "approved",
          changedBy: userId,
          notes: "Auto-approved (below threshold)",
        },
        "approved",
        userId,
        {
          from_status: po.status,
          to_status: "approved",
          auto: true,
          reason: "below_threshold",
          total_cents: totalCents,
        },
      );
    }
  }

  async function returnToDraft(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "draft");

    return updatePurchaseOrderStatusWithEvent(
      id,
      {
        status: "draft",
        approvalTierId: null,
        approvedBy: null,
        approvedAt: null,
        approvalNotes: null,
        updatedBy: userId,
      },
      {
        fromStatus: po.status,
        toStatus: "draft",
        changedBy: userId,
        notes: notes || "Returned to draft",
      },
      "returned_to_draft",
      userId,
      {
        from_status: po.status,
        to_status: "draft",
        notes: notes ?? null,
      },
    );
  }

  async function approve(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "approved");

    return updatePurchaseOrderStatusWithEvent(
      id,
      {
        status: "approved",
        approvedBy: userId,
        approvedAt: new Date(),
        approvalNotes: notes,
        updatedBy: userId,
      },
      {
        fromStatus: po.status,
        toStatus: "approved",
        changedBy: userId,
        notes: notes || "Approved",
      },
      "approved",
      userId,
      {
        from_status: po.status,
        to_status: "approved",
        notes: notes ?? null,
      },
    );
  }

  async function send(id: number, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "sent");

    const result = await transitionPhysical(id, "sent", userId, "Sent to vendor", {
      orderDate: new Date(),
    });

    return result;
  }

  /**
   * Combined "Send to Vendor" flow for solo mode (no approval tiers configured).
   * Saves → auto-approves → sets status to "sent" in one operation.
   * Returns the updated PO. Caller can then optionally open the email dialog.
   */
  async function sendToVendor(id: number, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    // Only works from draft or approved status
    if (!["draft", "approved"].includes(po.status)) {
      throw new PurchasingError(
        `Cannot send-to-vendor from '${po.status}' status. Use individual steps.`,
        400,
      );
    }

    // Check if we're in solo mode (no approval tiers)
    const tiers = await storage.getAllPoApprovalTiers();
    if (tiers.length > 0) {
      throw new PurchasingError(
        "Approval tiers are configured. Use the individual Submit/Approve/Send steps.",
        400,
      );
    }

    // If draft, validate and auto-approve first
    if (po.status === "draft") {
      const lines = await storage.getPurchaseOrderLines(id);
      const activeLines = lines.filter((l: any) => l.status !== "cancelled" && l.orderQty > 0);
      if (activeLines.length === 0) {
        throw new PurchasingError("PO must have at least one line with quantity > 0", 400);
      }

      // Recalculate totals
      await recalculateTotals(id, userId);

      // Auto-approve
      await updatePurchaseOrderStatusWithEvent(
        id,
        {
        status: "approved",
        approvedBy: userId,
        approvedAt: new Date(),
        approvalNotes: "Auto-approved (solo mode — no approval tiers)",
        updatedBy: userId,
        },
        {
          fromStatus: "draft",
          toStatus: "approved",
          changedBy: userId,
          notes: "Auto-approved (solo mode)",
        },
        "approved",
        userId,
        {
          from_status: "draft",
          to_status: "approved",
          auto: true,
          reason: "solo_mode",
        },
      );
    }

    // Now send
    return await transitionPhysical(
      id,
      "sent",
      userId,
      "Sent to vendor (solo mode)",
      { orderDate: new Date() },
      "approved",
    );
  }

  async function acknowledge(id: number, data: { vendorRefNumber?: string; confirmedDeliveryDate?: Date }, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "acknowledged");

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
      const packSize =
        poLine.expectedReceiveUnitsPerVariant ?? poLine.unitsPerUom ?? 1;
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

  // ── REORDER → PO ───────────────────────────────────────────────

  async function createPOFromReorder(items: Array<{
    productId: number;
    productVariantId: number;
    suggestedQty: number;
    vendorId?: number;
  }>, userId?: string) {
    // Group items by vendor (preferred vendor or specified)
    const vendorGroups = new Map<number, typeof items>();

    for (const item of items) {
      let vendorId = item.vendorId;

      if (!vendorId) {
        // Look up preferred vendor
        const vp = await storage.getPreferredVendorProduct(item.productId, item.productVariantId);
        if (vp) {
          vendorId = vp.vendorId;
        }
      }

      if (!vendorId) {
        throw new PurchasingError(
          `No vendor found for product variant ${item.productVariantId}. Set a preferred vendor first.`,
          400,
        );
      }

      if (!vendorGroups.has(vendorId)) {
        vendorGroups.set(vendorId, []);
      }
      vendorGroups.get(vendorId)!.push(item);
    }

    const createdPOs: any[] = [];

    for (const [vendorId, groupItems] of vendorGroups) {
      // Find existing draft PO for this vendor to append to
      const existingDrafts = await storage.getPurchaseOrders({ vendorId, status: "draft", limit: 1 });
      let po;
      let isNew = false;
      if (existingDrafts && existingDrafts.length > 0) {
        po = existingDrafts[0];
      } else {
        po = await createPO({ vendorId, createdBy: userId });
        isNew = true;
      }

      const existingLines = isNew ? [] : await storage.getPurchaseOrderLines(po.id);
      const lineDataToCreate: any[] = [];
      let linesUpdated = false;

      for (const item of groupItems) {
        const existingLine = existingLines.find((l: any) => l.productId === item.productId && l.productVariantId === item.productVariantId);
        
        if (existingLine) {
          // If the suggested qty is higher than the existing drafted qty, update the line
          if (item.suggestedQty > existingLine.orderQty) {
            await updateLine(existingLine.id, { orderQty: item.suggestedQty }, userId);
            linesUpdated = true;
          }
        } else {
          const vp = await storage.getPreferredVendorProduct(item.productId, item.productVariantId);
          lineDataToCreate.push({
            productId: item.productId,
            productVariantId: item.productVariantId,
            vendorProductId: vp?.id,
            orderQty: item.suggestedQty,
            unitCostCents: vp?.unitCostCents || 0,
            vendorSku: vp?.vendorSku,
          });
        }
      }

      if (lineDataToCreate.length > 0) {
        await addBulkLines(po.id, lineDataToCreate, userId);
      } else if (linesUpdated) {
        await recalculateTotals(po.id, userId);
      }

      const finalPo = await storage.getPurchaseOrderById(po.id);
      createdPOs.push(finalPo);
    }

    return createdPOs;
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

  type CreatePurchaseOrderWithLinesInput = {
    vendorId: number;
    warehouseId?: number;
    poType?: string;
    priority?: string;
    expectedDeliveryDate?: Date | null;
    incoterms?: string | null;
    vendorNotes?: string | null;
    internalNotes?: string | null;
    lines: Array<{
      // Request-time identifier used to link child lines (discount/adjustment)
      // to a parent product line before the parent has a DB id.
      // Optional; if absent for a line that is referenced by a child, server
      // auto-generates one.
      clientId?: string;

      // Line taxonomy (migration 0563). Defaults to 'product'.
      // See PO_LINE_TYPES in procurement.schema for the full set.
      lineType?: PoLineType;

      // Only valid on non-product lines. References another line's
      // clientId in the SAME request payload. Parent must resolve to a
      // product line; no chains.
      parentClientId?: string | null;

      // Required on non-product lines; product lines cache product_name/sku
      // from product_id and receive configuration from expected_receive_*.
      description?: string | null;

      // Required on product lines only. Must be null/absent on other types.
      productId?: number | null;
      productVariantId?: number | null;
      expectedReceiveVariantId?: number | null;
      expectedReceiveUnitsPerVariant?: number | null;

      // Product lines: qty > 0. Fee: qty >= 1. All other types: qty == 1.
      orderQty: number;

      // Per-unit cost (OLD SHAPE — backward compat). Either or both may be provided:
      //   * unitCostMills is authoritative (4-decimal precision).
      //   * unitCostCents is accepted for legacy/back-compat callers.
      //   * If both are provided, they MUST agree (cents == round(mills/100)).
      // Sign constraints vary by lineType (see validateCreateWithLinesInput).
      unitCostCents?: number;
      unitCostMills?: number;

      // Totals-based cost (NEW SHAPE — Spec F Phase 1, preferred for product lines).
      // If totalProductCostCents is provided, it is the source of truth.
      // unitCostMills/unitCostCents become derived. If BOTH shapes are sent,
      // totals win and per-unit is recomputed.
      totalProductCostCents?: number;
      packagingCostCents?: number;

      vendorProductId?: number | null;
    }>;
  };

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
  function validateCreateWithLinesInput(input: CreatePurchaseOrderWithLinesInput): void {
    if (!input || typeof input !== "object") {
      throw new PurchasingError("Request body is required", 400);
    }
    if (!Number.isInteger(input.vendorId) || input.vendorId <= 0) {
      throw new PurchasingError("vendor_id is required", 400);
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new PurchasingError("At least one line is required", 400);
    }

    // First pass: per-line shape + type rules. Build clientId->index map
    // for the second pass (parent resolution).
    const clientIdToIndex = new Map<string, number>();
    for (const [idx, line] of input.lines.entries()) {
      const label = `lines[${idx}]`;
      if (!line || typeof line !== "object") {
        throw new PurchasingError(`${label} is invalid`, 400);
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
          !Number.isInteger(line.productId) ||
          (line.productId as number) <= 0
        ) {
          throw new PurchasingError(`${label}.product_id is required`, 400);
        }
        if (
          line.expectedReceiveUnitsPerVariant !== undefined &&
          line.expectedReceiveUnitsPerVariant !== null &&
          (
            !Number.isInteger(line.expectedReceiveUnitsPerVariant) ||
            line.expectedReceiveUnitsPerVariant <= 0
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

      // Qty rule.
      if (!Number.isInteger(line.orderQty)) {
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

      if (!hasCents && !hasMills && !hasTotals) {
        throw new PurchasingError(
          `${label}.unit_cost_cents, unit_cost_mills, or total_product_cost_cents is required`,
          400,
        );
      }
      if (hasMills && !Number.isInteger(line.unitCostMills)) {
        throw new PurchasingError(
          `${label}.unit_cost_mills must be an integer`,
          400,
        );
      }
      if (hasCents && !Number.isInteger(line.unitCostCents)) {
        throw new PurchasingError(
          `${label}.unit_cost_cents must be an integer`,
          400,
        );
      }
      if (hasTotals && !Number.isInteger(line.totalProductCostCents)) {
        throw new PurchasingError(
          `${label}.total_product_cost_cents must be an integer`,
          400,
        );
      }
      if (
        line.packagingCostCents !== undefined &&
        line.packagingCostCents !== null &&
        !Number.isInteger(line.packagingCostCents)
      ) {
        throw new PurchasingError(
          `${label}.packaging_cost_cents must be an integer`,
          400,
        );
      }

      // Sign check (type-specific). Use totals if present, else mills, else cents.
      const primaryCost = hasTotals
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

  async function createPurchaseOrderWithLines(
    input: CreatePurchaseOrderWithLinesInput,
    userId?: string,
  ): Promise<any> {
    validateCreateWithLinesInput(input);

    const vendor = await storage.getVendorById(input.vendorId);
    if (!vendor) throw new PurchasingError("Vendor not found", 404);

    // Resolve product + variant info up-front for PRODUCT lines. Non-product
    // lines don't reference a variant; they carry a user-entered description
    // and signed cost.
    //
    // Per-unit cost: mills is authoritative; cents is derived (rounded
    // half-up) for back-compat writes into unit_cost_cents. Non-product
    // lines can have negative cost (discount/rebate/adjustment); the
    // validator has already enforced per-type sign rules.
    const resolvedLines = await Promise.all(
      input.lines.map(async (line) => {
        const lineType: PoLineType = line.lineType ?? "product";
        let variant: any = null;
        let product: any = null;
        if (lineType === "product") {
          product = await storage.getProductById(line.productId as number);
          if (!product) {
            throw new PurchasingError(`Product ${line.productId} not found`, 404);
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
          }
        }

        // Spec F Phase 1: pass through totals if provided (new shape),
        // else fall back to mills/cents (old shape). calculateLineCosts
        // handles both; if both are sent, totals win.
        const costs = calculateLineCosts({
          orderQty: line.orderQty,
          unitCostCents: Number(line.unitCostCents) || 0,
          unitCostMills: typeof line.unitCostMills === "number" ? line.unitCostMills : null,
          totalProductCostCents:
            typeof line.totalProductCostCents === "number" ? line.totalProductCostCents : null,
          packagingCostCents:
            typeof line.packagingCostCents === "number" ? line.packagingCostCents : null,
        });
        return {
          line,
          lineType,
          variant,
          product,
          costs,
          unitCostMills: costs.unitCostMills,
          unitCostCents: costs.unitCostCents,
        };
      }),
    );

    const poNumber = await storage.generatePoNumber();

    const subtotalCents = resolvedLines.reduce(
      (sum, r) => sum + BigInt(r.costs.lineTotalCents),
      BigInt(0),
    );

    // Single transaction: header + lines + status history + po_events['created']
    const created = await db.transaction(async (tx: any) => {
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
          currency: vendor.currency || "USD",
          paymentTermsDays: vendor.paymentTermsDays,
          paymentTermsType: vendor.paymentTermsType,
          shipFromAddress: vendor.shipFromAddress,
          subtotalCents: Number(subtotalCents),
          totalCents: Number(subtotalCents), // no header discount/tax/shipping on inline create
          lineCount: resolvedLines.length,
          createdBy: userId ?? null,
          updatedBy: userId ?? null,
        })
        .returning();

      // Build line rows. Product lines cache product identity/SKU and carry
      // expected_receive_* as the physical receiving configuration. Both record
      // line_type (migration 0563) so downstream consumers can filter.
      const lineRows = resolvedLines.map((r, idx) => {
        const isProduct = r.lineType === "product";
        return {
          purchaseOrderId: header.id,
          lineNumber: idx + 1,
          productId: isProduct ? r.product.id : null,
          // Deprecated compatibility field. PO purchasing identity is product_id
          // + product SKU + piece quantity; expected_receive_* carries the
          // receiving configuration.
          productVariantId: isProduct ? (r.variant?.id ?? null) : null,
          expectedReceiveVariantId: isProduct ? (r.variant?.id ?? null) : null,
          vendorProductId: isProduct ? (r.line.vendorProductId ?? null) : null,
          sku: isProduct ? (r.product.sku ?? r.variant?.sku ?? null) : null,
          productName: isProduct ? r.product.name : null,
          description: r.line.description ?? null,
          unitOfMeasure: isProduct
            ? (r.variant?.name?.split(" ")[0]?.toLowerCase() ?? "each")
            : null,
          unitsPerUom: isProduct ? (r.variant?.unitsPerVariant || 1) : 1,
          expectedReceiveUnitsPerVariant: isProduct
            ? (r.line.expectedReceiveUnitsPerVariant || r.variant?.unitsPerVariant || 1)
            : 1,
          orderQty: r.line.orderQty,
          // Write BOTH mills/cents and totals on INSERT (Spec F Phase 1).
          // Mills/cents are computed-derived for back-compat; totals are source of truth.
          // Non-product lines always have 0 for totals fields.
          unitCostCents: r.costs.unitCostCents,
          unitCostMills: r.costs.unitCostMills,
          totalProductCostCents: isProduct ? r.costs.totalProductCostCents : 0,
          packagingCostCents: isProduct ? r.costs.packagingCostCents : 0,
          discountCents: r.costs.discountCents,
          taxCents: r.costs.taxCents,
          lineTotalCents: r.costs.lineTotalCents,
          lineType: r.lineType,
          // parent_line_id resolved in a second pass after insert.
          parentLineId: null as number | null,
          status: "open" as const,
        };
      });
      const insertedLines = await tx
        .insert(purchaseOrderLinesTable)
        .values(lineRows)
        .returning({
          id: purchaseOrderLinesTable.id,
          lineNumber: purchaseOrderLinesTable.lineNumber,
        });

      // Second pass: resolve parentClientId -> parent_line_id. Iterate in
      // insertion order so we can map line_number back to DB id.
      // Validator has already checked that every parentClientId points to a
      // valid PRODUCT line in this same request, so no extra guards here.
      const clientIdToLineId = new Map<string, number>();
      resolvedLines.forEach((r, idx) => {
        const cid = r.line.clientId;
        if (typeof cid === "string" && cid.length > 0) {
          const dbId = insertedLines[idx]?.id;
          if (typeof dbId === "number") clientIdToLineId.set(cid, dbId);
        }
      });
      for (let i = 0; i < resolvedLines.length; i++) {
        const r = resolvedLines[i];
        const parentClientId = r.line.parentClientId;
        if (!parentClientId) continue;
        const parentDbId = clientIdToLineId.get(parentClientId);
        if (!parentDbId) continue; // validator prevents this, defensive only
        const childDbId = insertedLines[i]?.id;
        if (typeof childDbId !== "number") continue;
        await tx
          .update(purchaseOrderLinesTable)
          .set({ parentLineId: parentDbId })
          .where(eq(purchaseOrderLinesTable.id, childDbId));
      }

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
        subtotal_cents: Number(subtotalCents),
      });

      return header;
    });

    return created;
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
    const po = await storage.getPurchaseOrderById(poId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    if (po.status !== "draft" && po.status !== "approved") {
      throw new PurchasingError(
        `Cannot send PO in '${po.status}' status (must be draft or approved)`,
        400,
      );
    }

    // Validate at least one active line.
    const lines = await storage.getPurchaseOrderLines(poId);
    const activeLines = lines.filter((l: any) => l.status !== "cancelled" && l.orderQty > 0);
    if (activeLines.length === 0) {
      throw new PurchasingError("PO must have at least one line with quantity > 0", 400);
    }

    // Refresh totals before the approval check.
    await recalculateTotals(poId, userId);
    const fresh = await storage.getPurchaseOrderById(poId);
    const totalCents = Number(fresh.totalCents || 0);

    const settings = await getProcurementSettings();

    // Approval gate. A matching tier + require_approval routes through
    // pending_approval and does NOT generate a PDF.
    if (settings.requireApproval && po.status === "draft") {
      const tier = await storage.getMatchingApprovalTier(totalCents);
      if (tier) {
        const updated = await db.transaction(async (tx: any) => {
          const [row] = await tx
            .update(purchaseOrdersTable)
            .set({
              status: "pending_approval",
              approvalTierId: tier.id,
              updatedBy: userId ?? null,
              updatedAt: new Date(),
            })
            .where(eq(purchaseOrdersTable.id, poId))
            .returning();
          await tx.insert(poStatusHistoryTable).values({
            purchaseOrderId: poId,
            fromStatus: po.status,
            toStatus: "pending_approval",
            changedBy: userId ?? null,
            notes: `Submitted for approval (tier: ${tier.tierName})`,
          });
          await emitPoEventTx(tx, poId, "submitted", userId, {
            tier_id: tier.id,
            tier_name: tier.tierName,
            total_cents: totalCents,
          });
          return row;
        });
        return {
          po: updated,
          status: "pending_approval",
          pdf: null,
          pendingApproval: true,
        };
      }
    }

    // Cascade draft → approved → sent atomically.
    const updated = await db.transaction(async (tx: any) => {
      let currentStatus = po.status;
      if (currentStatus === "draft") {
        await tx
          .update(purchaseOrdersTable)
          .set({
            status: "approved",
            approvedBy: userId ?? null,
            approvedAt: new Date(),
            approvalNotes: settings.requireApproval
              ? "Auto-approved (no matching tier)"
              : "Auto-approved (approval not required)",
            updatedBy: userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(purchaseOrdersTable.id, poId));
        await tx.insert(poStatusHistoryTable).values({
          purchaseOrderId: poId,
          fromStatus: currentStatus,
          toStatus: "approved",
          changedBy: userId ?? null,
          notes: settings.requireApproval
            ? "Auto-approved (no matching tier)"
            : "Auto-approved (approval not required)",
        });
        await emitPoEventTx(tx, poId, "approved", userId, {
          auto: true,
          require_approval: settings.requireApproval,
          total_cents: totalCents,
        });
        currentStatus = "approved";
      }

      const now = new Date();
      const sentChange = (() => {
        try {
          return buildPhysicalTransitionChange({
            po: { ...fresh, status: currentStatus },
            target: "sent",
            userId: userId ?? undefined,
            notes: "Sent to vendor (PDF placeholder)",
            now,
            extraPatch: { orderDate: fresh.orderDate ?? now },
            historyFromStatus: currentStatus,
          });
        } catch (error) {
          return toPurchasingError(error);
        }
      })();

      const [row] = await tx
        .update(purchaseOrdersTable)
        .set({
          ...sentChange.patch,
          updatedBy: userId ?? null,
          updatedAt: now,
        })
        .where(eq(purchaseOrdersTable.id, poId))
        .returning();
      await tx.insert(poStatusHistoryTable).values({
        purchaseOrderId: poId,
        ...sentChange.history,
        changedBy: userId ?? null,
      });
      await emitPoEventTx(tx, poId, "sent_to_vendor", userId, {
        method: "pdf_placeholder",
        pdf_placeholder: true,
      });
      return row;
    });

    // PDF STUB. Do not generate a real PDF. The real generator will land in a
    // later pass; callers should branch on `pdf.pdf_placeholder`.
    return {
      po: updated,
      status: "sent",
      pdf: {
        pdf_placeholder: true,
        reason: "PDF generation not yet implemented",
      },
      pendingApproval: false,
    };
  }

  // ── DUPLICATE (Spec A) ──────────────────────────────────────────────────
  //
  // Duplicate an existing PO's lines into a fresh draft. Per spec §11.4 the
  // default behavior is to refresh unit cost from the current vendor catalog
  // when one exists; otherwise we fall back to the source line's cost.

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

    // Refresh costs from the current vendor catalog when available.
    // Mills-aware: prefer catalog mills → source mills → derive from cents.
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

      // Start from source line's mills when present, else derive from cents.
      let unitCostMills: number =
        typeof src.unitCostMills === "number"
          ? src.unitCostMills
          : centsToMills(Number(src.unitCostCents || 0));
      let vendorProductId: number | null = null;

      // Vendor catalog refresh is only meaningful on product lines.
      if (srcLineType === "product") {
        try {
          const vp = await storage.getPreferredVendorProduct(
            src.productId,
            src.expectedReceiveVariantId ?? src.productVariantId,
          );
          if (vp && vp.vendorId === targetVendorId) {
            if (typeof vp.unitCostMills === "number" && vp.unitCostMills >= 0) {
              unitCostMills = vp.unitCostMills;
            } else if (typeof vp.unitCostCents === "number") {
              unitCostMills = centsToMills(vp.unitCostCents);
            }
            vendorProductId = vp.id ?? null;
          }
        } catch {
          // Non-fatal: fall back to source cost.
        }
      }

      const parentClientId =
        typeof src.parentLineId === "number"
          ? clientIdBySourceId.get(src.parentLineId) ?? null
          : null;

      dupLines.push({
        clientId: clientIdBySourceId.get(src.id),
        lineType: srcLineType,
        parentClientId,
        productVariantId: srcLineType === "product"
          ? (src.expectedReceiveVariantId ?? src.productVariantId ?? null)
          : null,
        expectedReceiveVariantId: srcLineType === "product"
          ? (src.expectedReceiveVariantId ?? src.productVariantId ?? null)
          : null,
        expectedReceiveUnitsPerVariant: srcLineType === "product"
          ? (src.expectedReceiveUnitsPerVariant ?? src.unitsPerUom ?? 1)
          : 1,
        orderQty: src.orderQty,
        unitCostMills,
        // Include cents (derived) so downstream validators that still look
        // at cents don't choke. They must agree per validator rule.
        // Signed conversion for discount/rebate/adjustment lines.
        unitCostCents: signedMillsToCents(unitCostMills),
        vendorProductId,
        description: src.description ?? null,
      });
    }

    if (dupLines.length === 0) {
      throw new PurchasingError("Source PO has no active lines to duplicate", 400);
    }

    const created = await createPurchaseOrderWithLines(
      {
        vendorId: targetVendorId,
        poType: source.poType ?? "standard",
        priority: source.priority ?? "normal",
        expectedDeliveryDate: overrides?.expectedDeliveryDate ?? null,
        incoterms: source.incoterms ?? null,
        vendorNotes: source.vendorNotes ?? null,
        internalNotes: source.internalNotes ?? null,
        lines: dupLines,
      },
      userId,
    );

    await emitPoEvent(created.id, "duplicated_from", userId, {
      source_po_id: source.id,
      source_po_number: source.poNumber,
      line_count: dupLines.length,
    });

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
    unitCostCents?: number;
    unitCostMills?: number;
    packSize?: number;
    moq?: number;
    leadTimeDays?: number;
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

  async function bulkUpsertVendorCatalog(
    vendorId: number,
    entries: BulkCatalogEntry[],
    userId: string | null | undefined,
  ): Promise<BulkCatalogResult> {
    if (!Number.isInteger(vendorId) || vendorId <= 0) {
      throw new PurchasingError("vendorId is required", 400);
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new PurchasingError("entries must be a non-empty array", 400);
    }

    // Boundary validation (Rule #4). Reject the whole request on any bad
    // entry so partial writes can't happen.
    for (const [idx, e] of entries.entries()) {
      if (!Number.isInteger(e.productId) || e.productId <= 0) {
        throw new PurchasingError(`entries[${idx}].productId must be a positive integer`, 400);
      }
      if (
        e.productVariantId !== undefined &&
        e.productVariantId !== null &&
        (!Number.isInteger(e.productVariantId) || e.productVariantId <= 0)
      ) {
        throw new PurchasingError(
          `entries[${idx}].productVariantId must be a positive integer or null`,
          400,
        );
      }
      const hasCents = e.unitCostCents !== undefined && e.unitCostCents !== null;
      const hasMills = e.unitCostMills !== undefined && e.unitCostMills !== null;
      if (!hasCents && !hasMills) {
        throw new PurchasingError(
          `entries[${idx}].unitCostCents or unitCostMills is required`,
          400,
        );
      }
      if (hasCents && (!Number.isInteger(e.unitCostCents) || (e.unitCostCents as number) < 0)) {
        // Rule #3: integer cents only.
        throw new PurchasingError(
          `entries[${idx}].unitCostCents must be a non-negative integer (cents)`,
          400,
        );
      }
      if (hasMills && (!Number.isInteger(e.unitCostMills) || (e.unitCostMills as number) < 0)) {
        throw new PurchasingError(
          `entries[${idx}].unitCostMills must be a non-negative integer (mills)`,
          400,
        );
      }
      if (hasCents && hasMills) {
        const expected = millsToCents(e.unitCostMills as number);
        if (expected !== (e.unitCostCents as number)) {
          throw new PurchasingError(
            `entries[${idx}]: unitCostMills (${e.unitCostMills}) and unitCostCents (${e.unitCostCents}) disagree; expected cents=${expected}`,
            400,
          );
        }
      }
      if (e.packSize !== undefined && (!Number.isInteger(e.packSize) || e.packSize <= 0)) {
        throw new PurchasingError(`entries[${idx}].packSize must be a positive integer`, 400);
      }
      if (e.moq !== undefined && (!Number.isInteger(e.moq) || e.moq <= 0)) {
        throw new PurchasingError(`entries[${idx}].moq must be a positive integer`, 400);
      }
      if (
        e.leadTimeDays !== undefined &&
        (!Number.isInteger(e.leadTimeDays) || e.leadTimeDays < 0)
      ) {
        throw new PurchasingError(
          `entries[${idx}].leadTimeDays must be a non-negative integer`,
          400,
        );
      }
    }

    const vendor = await storage.getVendorById(vendorId);
    if (!vendor) throw new PurchasingError("Vendor not found", 404);

    const { actorType, actorId } = resolveActor(userId);
    const timestamp = new Date().toISOString();

    const result: BulkCatalogResult = { created: [], updated: [], skipped: [] };
    const auditLogs: Array<Record<string, unknown>> = [];

    await db.transaction(async (tx: any) => {
      for (const entry of entries) {
        const variantId =
          entry.productVariantId === undefined || entry.productVariantId === null
            ? null
            : entry.productVariantId;

        // Look up existing row by (vendorId, productId, productVariantId).
        // The unique index vendor_products_vendor_product_variant_idx
        // guarantees at most one match.
        const matchConditions = [
          eq(vendorProductsTable.vendorId, vendorId),
          eq(vendorProductsTable.productId, entry.productId),
          variantId === null
            ? sql`${vendorProductsTable.productVariantId} IS NULL`
            : eq(vendorProductsTable.productVariantId, variantId),
        ];
        const existingRows = await tx
          .select()
          .from(vendorProductsTable)
          .where(and(...matchConditions))
          .limit(1);
        const existing = existingRows[0];

        // Normalize to both precisions. Mills is authoritative when
        // provided; cents is derived. If only cents is provided, derive
        // mills exactly (cents × 100).
        const entryHasMills =
          typeof entry.unitCostMills === "number" && entry.unitCostMills >= 0;
        const entryMills = entryHasMills
          ? (entry.unitCostMills as number)
          : centsToMills(Number(entry.unitCostCents) || 0);
        const entryCents = entryHasMills
          ? millsToCents(entryMills)
          : Number(entry.unitCostCents) || 0;

        if (existing) {
          // Don't overwrite non-null fields with null (per spec). Only
          // fields explicitly provided (not undefined) overwrite.
          const patch: Record<string, unknown> = {
            unitCostCents: entryCents,
            unitCostMills: entryMills,
            isActive: 1,
            updatedAt: new Date(),
          };
          if (entry.packSize !== undefined) patch.packSize = entry.packSize;
          if (entry.moq !== undefined) patch.moq = entry.moq;
          if (entry.leadTimeDays !== undefined) patch.leadTimeDays = entry.leadTimeDays;
          if (entry.vendorSku !== undefined && entry.vendorSku !== null) {
            patch.vendorSku = entry.vendorSku;
          }
          if (
            entry.vendorProductName !== undefined &&
            entry.vendorProductName !== null
          ) {
            patch.vendorProductName = entry.vendorProductName;
          }
          if (entry.isPreferred !== undefined) {
            patch.isPreferred = entry.isPreferred ? 1 : 0;
          }

          const updatedRows = await tx
            .update(vendorProductsTable)
            .set(patch)
            .where(eq(vendorProductsTable.id, existing.id))
            .returning();
          const row = updatedRows[0];
          result.updated.push({
            vendorProductId: row.id,
            productId: row.productId,
            productVariantId: row.productVariantId ?? null,
          });
          auditLogs.push({
            event: "vendor_catalog.updated",
            actorType,
            actorId,
            timestamp,
            vendorId,
            vendorProductId: row.id,
            productId: row.productId,
            productVariantId: row.productVariantId ?? null,
            before: {
              unitCostCents: existing.unitCostCents,
              packSize: existing.packSize,
              moq: existing.moq,
              leadTimeDays: existing.leadTimeDays,
              isPreferred: existing.isPreferred,
              vendorSku: existing.vendorSku,
            },
            after: {
              unitCostCents: row.unitCostCents,
              packSize: row.packSize,
              moq: row.moq,
              leadTimeDays: row.leadTimeDays,
              isPreferred: row.isPreferred,
              vendorSku: row.vendorSku,
            },
          });
        } else {
          const insertedRows = await tx
            .insert(vendorProductsTable)
            .values({
              vendorId,
              productId: entry.productId,
              productVariantId: variantId,
              vendorSku: entry.vendorSku ?? null,
              vendorProductName: entry.vendorProductName ?? null,
              unitCostCents: entryCents,
              unitCostMills: entryMills,
              packSize: entry.packSize ?? 1,
              moq: entry.moq ?? 1,
              leadTimeDays: entry.leadTimeDays ?? null,
              isPreferred: entry.isPreferred ? 1 : 0,
              isActive: 1,
            })
            .returning();
          const row = insertedRows[0];
          result.created.push({
            vendorProductId: row.id,
            productId: row.productId,
            productVariantId: row.productVariantId ?? null,
          });
          auditLogs.push({
            event: "vendor_catalog.created",
            actorType,
            actorId,
            timestamp,
            vendorId,
            vendorProductId: row.id,
            productId: row.productId,
            productVariantId: row.productVariantId ?? null,
            unitCostCents: row.unitCostCents,
            packSize: row.packSize,
            moq: row.moq,
            leadTimeDays: row.leadTimeDays,
            isPreferred: row.isPreferred,
          });
        }
      }
    });

    // Emit audit trail AFTER the tx commits. Rule #8: structured JSON.
    for (const line of auditLogs) {
      console.log(JSON.stringify(line));
    }

    return result;
  }

  // ── NEW-PO PRELOAD (Spec A §10.1) ───────────────────────────────────
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
    deletePO,
    getPurchaseOrders: (filters?: any) => storage.getPurchaseOrders(filters),
    getPurchaseOrdersCount: (filters?: any) => storage.getPurchaseOrdersCount(filters),
    getPurchaseOrderById: (id: number) => storage.getPurchaseOrderById(id),
    getPurchaseOrderByPoNumber: (poNumber: string) => storage.getPurchaseOrderByPoNumber(poNumber),

    // Lines
    addLine,
    updateIncotermsAndCharges,
    addBulkLines,
    updateLine,
    deleteLine,
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
    onReceivingOrderClosed,

    // Dual-track lifecycle (migration 0565)
    transitionPhysical,
    transitionFinancial,
    recomputeFinancialAggregates,
    findOpenPoLineByProduct,

    // Reorder → PO
    createPOFromReorder,

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
    createVendorProduct: (data: any) => (storage as any).createVendorProduct(data),
    updateVendorProduct: (id: number, updates: any) => (storage as any).updateVendorProduct(id, updates),
    deleteVendorProduct: (id: number) => (storage as any).deleteVendorProduct(id),
    bulkUpsertVendorCatalog,

    // Spec A: inline create, one-click send, duplicate, preload, settings.
    createPurchaseOrderWithLines,
    sendPurchaseOrder,
    duplicatePurchaseOrder,
    getNewPoPreload,
    getProcurementSettings,
    updateProcurementSetting,
    emitPoEvent,
  };
}
