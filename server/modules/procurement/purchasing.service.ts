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
  PO_PHYSICAL_STATUSES,
  PO_FINANCIAL_STATUSES,
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
  getProductById(id: number): Promise<any>;

  // Receiving
  createReceivingOrder(data: any): Promise<any>;
  generateReceiptNumber(): Promise<string>;
  bulkCreateReceivingLines(lines: any[]): Promise<any[]>;
  getReceivingLineById(id: number): Promise<any>;
  getReceivingOrderById(id: number): Promise<any>;

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

// ── Valid state transitions ─────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending_approval", "approved", "cancelled"],
  pending_approval: ["draft", "approved", "cancelled"],
  approved: ["sent", "cancelled"],
  sent: ["acknowledged", "partially_received", "received", "cancelled"],
  acknowledged: ["partially_received", "received", "cancelled"],
  partially_received: ["received", "closed"],
  received: ["closed"],
};

// ── Dual-track transition tables (migration 0565) ──────────────────────────
//
// physicalStatus models goods movement; financialStatus models AP/payment.
// Both are independent state machines. The legacy `status` column is kept
// in sync by transitionPhysical for back-compat.

const VALID_PHYSICAL_TRANSITIONS: Record<PoPhysicalStatus, PoPhysicalStatus[]> = {
  draft:        ["sent", "cancelled"],
  sent:         ["acknowledged", "cancelled"],
  acknowledged: ["shipped", "cancelled"],
  shipped:      ["in_transit", "arrived", "cancelled"],
  in_transit:   ["arrived", "cancelled"],
  arrived:      ["receiving", "cancelled"],
  receiving:    ["received", "short_closed"],
  received:     [],
  short_closed: [],
  cancelled:    [],
};

const VALID_FINANCIAL_TRANSITIONS: Record<PoFinancialStatus, PoFinancialStatus[]> = {
  unbilled:      ["invoiced"],
  invoiced:      ["partially_paid", "paid", "disputed"],
  partially_paid: ["paid", "disputed"],
  paid:          [],
  disputed:      ["partially_paid", "paid"],
};

// Maps a physical status to the appropriate legacy (single-track) status for
// back-compat. Where there is no direct equivalent, use the nearest ancestor
// that callers already understand.
const PHYSICAL_TO_LEGACY_STATUS: Partial<Record<PoPhysicalStatus, string>> = {
  draft:        "approved",   // physical draft covers draft/pending_approval/approved
  sent:         "sent",
  acknowledged: "acknowledged",
  shipped:      "acknowledged", // no legacy equivalent; acknowledged is closest
  in_transit:   "acknowledged",
  arrived:      "acknowledged",
  receiving:    "partially_received",
  received:     "received",
  short_closed: "closed",
  cancelled:    "cancelled",
};

// Timestamp column to stamp on each physical transition.
const PHYSICAL_TIMESTAMP_COLUMN: Partial<Record<PoPhysicalStatus, string>> = {
  sent:         "sentToVendorAt",
  shipped:      "firstShippedAt",
  arrived:      "firstArrivedAt",
  received:     "actualDeliveryDate",
  cancelled:    "cancelledAt",
};

const EDITABLE_STATUSES = new Set(["draft"]);
// Broader set for amending existing lines (cost corrections, qty adjustments) — any non-terminal state
const LINE_AMENDABLE_STATUSES = new Set(["draft", "pending_approval", "approved", "sent", "acknowledged", "partially_received"]);
const CANCELLABLE_FROM = new Set(["draft", "pending_approval", "approved"]);
const VOIDABLE_FROM = new Set(["sent", "acknowledged"]);

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
      // Derive per-unit from total / qty (integer math, half-up).
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
          ? Number(
              signedRoundHalfUpDiv(
                BigInt(resolvedTotalProductCostCents),
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
    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw new PurchasingError(
        `Cannot transition from '${currentStatus}' to '${targetStatus}'`,
        400,
      );
    }
  }

  // ── Dual-track state machine functions (migration 0565) ──────────────────

  /**
   * Transition the physical (goods-movement) status of a PO.
   *
   * Validates against VALID_PHYSICAL_TRANSITIONS, stamps the appropriate
   * lifecycle timestamp, syncs the legacy `status` column for back-compat,
   * and writes a po_status_history row with old/new physical status.
   *
   * Rule #7: all updates go through storage.updatePurchaseOrderStatusWithHistory
   * which uses a DB transaction internally.
   */
  async function transitionPhysical(
    poId: number,
    target: PoPhysicalStatus,
    userId?: string,
    notes?: string,
  ): Promise<any> {
    const po = await storage.getPurchaseOrderById(poId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    const current = (po.physicalStatus ?? "draft") as PoPhysicalStatus;
    const allowed = VALID_PHYSICAL_TRANSITIONS[current] ?? [];
    if (!allowed.includes(target)) {
      throw new PurchasingError(
        `Cannot transition physical status from '${current}' to '${target}'`,
        400,
        { current, target, allowed },
      );
    }

    const now = new Date();
    const patch: Record<string, any> = {
      physicalStatus: target,
      updatedBy: userId,
    };

    // Stamp the appropriate lifecycle timestamp when entering key states.
    const tsCol = PHYSICAL_TIMESTAMP_COLUMN[target];
    if (tsCol && !po[tsCol]) {
      // Only stamp first occurrence (don't overwrite if already set).
      patch[tsCol] = now;
    }

    // Sync legacy `status` column for back-compat.
    const legacyStatus = PHYSICAL_TO_LEGACY_STATUS[target];
    if (legacyStatus) {
      patch.status = legacyStatus;
    }

    // Special-case: cancelled also stamps cancelledAt
    if (target === "cancelled" && !po.cancelledAt) {
      patch.cancelledAt = now;
      patch.cancelledBy = userId ?? null;
    }
    // short_closed stamps closedAt
    if (target === "short_closed" && !po.closedAt) {
      patch.closedAt = now;
      patch.closedBy = userId ?? null;
    }

    const result = await storage.updatePurchaseOrderStatusWithHistory(poId, patch, {
      fromStatus: po.status ?? current,
      toStatus: legacyStatus ?? po.status,
      changedBy: userId,
      notes: notes ?? `Physical status: ${current} → ${target}`,
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
   * Validates against VALID_FINANCIAL_TRANSITIONS, stamps lifecycle
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
  ): Promise<any> {
    const po = await storage.getPurchaseOrderById(poId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    const current = (po.financialStatus ?? "unbilled") as PoFinancialStatus;
    const allowed = VALID_FINANCIAL_TRANSITIONS[current] ?? [];
    if (!allowed.includes(target)) {
      throw new PurchasingError(
        `Cannot transition financial status from '${current}' to '${target}'`,
        400,
        { current, target, allowed },
      );
    }

    const now = new Date();
    const patch: Record<string, any> = {
      financialStatus: target,
      updatedBy: userId,
    };

    // Stamp first-invoice and first-payment timestamps.
    if (target === "invoiced" && !po.firstInvoicedAt) {
      patch.firstInvoicedAt = now;
    }
    if ((target === "partially_paid" || target === "paid") && !po.firstPaidAt) {
      patch.firstPaidAt = now;
    }
    if (target === "paid" && !po.fullyPaidAt) {
      patch.fullyPaidAt = now;
    }

    // Write the update. For financial-only changes the legacy status column
    // doesn't change, so we can pass the current legacy status as both from/to
    // to satisfy the po_status_history NOT NULL constraint.
    return await storage.updatePurchaseOrderStatusWithHistory(poId, patch, {
      fromStatus: po.status,
      toStatus: po.status,
      changedBy: userId,
      notes: notes ?? `Financial status: ${current} → ${target}`,
    });
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

    // Cache product info
    const variant = data.productVariantId ? await storage.getProductVariantById(data.productVariantId) : null;
    if (data.productVariantId && !variant) throw new PurchasingError("Product variant not found", 404);
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
      productVariantId: data.productVariantId || null,
      vendorProductId: data.vendorProductId,
      sku: variant?.sku || product.sku,
      productName: product.name,
      vendorSku: data.vendorSku,
      description: data.description,
      unitOfMeasure: data.unitOfMeasure || variant?.name?.split(" ")[0]?.toLowerCase() || product.baseUnit,
      unitsPerUom: data.unitsPerUom || variant?.unitsPerVariant || 1,
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
      const variant = line.productVariantId ? await storage.getProductVariantById(line.productVariantId) : null;
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
        productVariantId: line.productVariantId || null,
        vendorProductId: line.vendorProductId,
        sku: variant?.sku || product.sku,
        productName: product.name,
        vendorSku: line.vendorSku,
        description: line.description,
        unitOfMeasure: line.unitOfMeasure || "each",
        unitsPerUom: variant?.unitsPerVariant || 1,
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

    const updated = await storage.updatePurchaseOrderLine(lineId, updates);

    // Cascade variant/SKU changes to downstream records
    if (updates.productVariantId || updates.sku) {
      const newVariantId = updates.productVariantId ?? line.productVariantId;
      const newSku = updates.sku ?? line.sku;
      try {
        // Look up the new variant's units-per-case for carton recalc
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
        console.log(`[Purchasing] Cascaded variant change on PO line ${lineId}: variant=${newVariantId} sku=${newSku} upc=${newUpc}`);
      } catch (err: any) {
        console.warn(`[Purchasing] Failed to cascade variant change for PO line ${lineId}: ${err.message}`);
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
      return await storage.updatePurchaseOrder(id, {
        status: "pending_approval",
        approvalTierId: tier.id,
        updatedBy: userId,
      }, {
        fromStatus: po.status,
        toStatus: "pending_approval",
        changedBy: userId,
        notes: `Approval required: ${tier.tierName}`
      });
    } else {
      // Auto-approve (no tier matches)
      assertTransition(po.status, "approved");
      return await storage.updatePurchaseOrderStatusWithHistory(id, {
        status: "approved",
        approvedBy: userId,
        approvedAt: new Date(),
        approvalNotes: "Auto-approved (below approval threshold)",
        updatedBy: userId,
      }, {
        fromStatus: po.status,
        toStatus: "approved",
        changedBy: userId,
        notes: "Auto-approved (below threshold)"
      });
    }
  }

  async function returnToDraft(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "draft");

    return await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "draft",
      approvalTierId: null,
      approvedBy: null,
      approvedAt: null,
      approvalNotes: null,
      updatedBy: userId,
    }, {
        fromStatus: po.status,
        toStatus: "draft",
        changedBy: userId,
        notes: notes || "Returned to draft"
      });
  }

  async function approve(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "approved");

    return await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "approved",
      approvedBy: userId,
      approvedAt: new Date(),
      approvalNotes: notes,
      updatedBy: userId,
    }, {
        fromStatus: po.status,
        toStatus: "approved",
        changedBy: userId,
        notes: notes || "Approved"
      });
  }

  async function send(id: number, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "sent");

    const result = await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "sent",
      orderDate: new Date(),
      sentToVendorAt: new Date(),
      updatedBy: userId,
    }, {
        fromStatus: po.status,
        toStatus: "sent",
        changedBy: userId,
        notes: "Sent to vendor"
      });

    // Sync physical track: approved → sent
    const currentPhysical = (po.physicalStatus ?? "draft") as PoPhysicalStatus;
    if (currentPhysical === "draft") {
      await storage.updatePurchaseOrder(id, { physicalStatus: "sent" as PoPhysicalStatus });
    }

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
      await storage.updatePurchaseOrderStatusWithHistory(id, {
        status: "approved",
        approvedBy: userId,
        approvedAt: new Date(),
        approvalNotes: "Auto-approved (solo mode — no approval tiers)",
        updatedBy: userId,
      }, {
        fromStatus: "draft",
        toStatus: "approved",
        changedBy: userId,
        notes: "Auto-approved (solo mode)"
      });
    }

    // Now send
    return await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "sent",
      orderDate: new Date(),
      sentToVendorAt: new Date(),
      updatedBy: userId,
    }, {
        fromStatus: "approved",
        toStatus: "sent",
        changedBy: userId,
        notes: "Sent to vendor (solo mode)"
      });
  }

  async function acknowledge(id: number, data: { vendorRefNumber?: string; confirmedDeliveryDate?: Date }, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "acknowledged");

    const result = await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "acknowledged",
      vendorAckDate: new Date(),
      vendorRefNumber: data.vendorRefNumber,
      confirmedDeliveryDate: data.confirmedDeliveryDate,
      updatedBy: userId,
    }, {
        fromStatus: po.status,
        toStatus: "acknowledged",
        changedBy: userId,
        notes: "Vendor acknowledged"
      });

    // Sync physical track: sent → acknowledged
    const currentPhysical = (po.physicalStatus ?? "draft") as PoPhysicalStatus;
    if (currentPhysical === "sent") {
      await storage.updatePurchaseOrder(id, { physicalStatus: "acknowledged" as PoPhysicalStatus });
    }

    return result;
  }

  async function cancel(id: number, reason: string, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    if (!reason) throw new PurchasingError("Cancel reason is required", 400);

    if (!CANCELLABLE_FROM.has(po.status) && !VOIDABLE_FROM.has(po.status)) {
      throw new PurchasingError(`Cannot cancel/void PO in '${po.status}' status`, 400);
    }

    // Cancel all open lines
    const lines = await storage.getPurchaseOrderLines(id);
    for (const line of lines) {
      if (line.status === "open") {
        await storage.updatePurchaseOrderLine(line.id, { status: "cancelled", cancelledQty: line.orderQty });
      }
    }

    const result = await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "cancelled",
      cancelledAt: new Date(),
      cancelledBy: userId,
      cancelReason: reason,
      updatedBy: userId,
      physicalStatus: "cancelled" as PoPhysicalStatus,
    }, {
        fromStatus: po.status,
        toStatus: "cancelled",
        changedBy: userId,
        notes: reason
      });
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

    assertTransition(po.status, "closed");

    return await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "closed",
      closedAt: new Date(),
      closedBy: userId,
      updatedBy: userId,
    }, {
        fromStatus: po.status,
        toStatus: "closed",
        changedBy: userId,
        notes: notes || "PO closed"
      });
  }

  async function closeShort(id: number, reason: string, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    if (po.status !== "partially_received") {
      throw new PurchasingError("Can only close-short a partially received PO", 400);
    }
    if (!reason) throw new PurchasingError("Close-short reason is required", 400);

    // Close all remaining open lines
    const lines = await storage.getPurchaseOrderLines(id);
    for (const line of lines) {
      if (line.status === "open" || line.status === "partially_received") {
        await storage.updatePurchaseOrderLine(line.id, {
          status: "closed",
          closeShortReason: reason,
        });
      }
    }

    return await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "closed",
      closedAt: new Date(),
      closedBy: userId,
      updatedBy: userId,
      physicalStatus: "short_closed" as PoPhysicalStatus,
    }, {
        fromStatus: po.status,
        toStatus: "closed",
        changedBy: userId,
        notes: `Closed short: ${reason}`
      });
  }

  // ── RECEIVING INTEGRATION ───────────────────────────────────────

  async function createReceiptFromPO(purchaseOrderId: number, userId?: string) {
    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    const openStatuses = ["sent", "acknowledged", "partially_received"];
    if (!openStatuses.includes(po.status)) {
      throw new PurchasingError(`Cannot create receipt for PO in '${po.status}' status`, 400);
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
      const autoLocationId = productLocationMap.get(poLine.productVariantId) || null;
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
        productVariantId: poLine.productVariantId,
        productId: poLine.productId,
        sku: poLine.sku,
        productName: poLine.productName,
        expectedQty: Math.ceil(
          (poLine.orderQty - (poLine.receivedQty || 0) - (poLine.cancelledQty || 0)) /
          (poLine.unitsPerUom || 1)
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
    const lines = await storage.getPurchaseOrderLines(poId);
    const candidates = lines.filter((l: any) => {
      if ((l.lineType ?? "product") !== "product") return false;
      if (l.productId !== productId) return false;
      if (l.status === "cancelled" || l.status === "received" || l.status === "closed") return false;
      const remaining = (Number(l.orderQty) || 0)
        - (Number(l.receivedQty) || 0)
        - (Number(l.cancelledQty) || 0);
      return remaining > 0;
    });
    if (candidates.length === 1) return candidates[0];
    // Zero or ambiguous (multiple open lines for the same product) — cannot auto-link.
    return null;
  }

  async function onReceivingOrderClosed(receivingOrderId: number, receivingLines: Array<{
    receivingLineId: number;
    purchaseOrderLineId?: number;
    receivedQty: number;
    damagedQty?: number;
    unitCost?: number;
  }>) {
    // Resolve the PO ID. Prefer explicit PO line linkage; fall back to the
    // receiving order's own purchaseOrderId for unlinked-line receipts.
    const poLineIds = receivingLines
      .map(l => l.purchaseOrderLineId)
      .filter(Boolean) as number[];

    let poId: number | null = null;

    if (poLineIds.length > 0) {
      const firstPoLine = await storage.getPurchaseOrderLineById(poLineIds[0]);
      if (firstPoLine) poId = firstPoLine.purchaseOrderId;
    }

    // If no linked lines, check the receiving order itself
    if (!poId) {
      const receivingOrder = await storage.getReceivingOrderById(receivingOrderId);
      if (receivingOrder?.purchaseOrderId) {
        poId = receivingOrder.purchaseOrderId;
      }
    }

    if (!poId) return; // Not a PO-linked receipt

    const po = await storage.getPurchaseOrderById(poId);
    if (!po) return;

    // ── Auto-match unlinked receiving lines to PO lines by product_id ────────
    //
    // Phase 1: when a receiving line has no purchaseOrderLineId, attempt to
    // match it by looking for a single open product PO line with the same
    // product_id. If exactly one match exists, auto-link. If zero or multiple,
    // leave unlinked and log a warning (Phase 2 UI will surface these).
    for (const rl of receivingLines) {
      if (rl.purchaseOrderLineId) continue; // Already linked
      const rlRecord = await storage.getReceivingLineById(rl.receivingLineId);
      if (!rlRecord) continue;

      // Resolve product_id: first from the receiving line record, then via
      // product variant lookup if only productVariantId is present.
      let productId: number | null = rlRecord.productId ?? null;
      if (!productId && rlRecord.productVariantId) {
        const variant = await storage.getProductVariantById(rlRecord.productVariantId);
        productId = variant?.productId ?? null;
      }

      if (!productId) {
        console.warn(
          `[Receiving] Auto-match skipped for receiving line ${rl.receivingLineId}: no product_id resolvable`,
        );
        continue;
      }

      const matchedLine = await findOpenPoLineByProduct(poId, productId);
      if (matchedLine) {
        // Mutate the in-memory rl so the reconciliation loop below picks it up.
        rl.purchaseOrderLineId = matchedLine.id;
        console.info(
          `[Receiving] Auto-matched receiving line ${rl.receivingLineId} → PO line ${matchedLine.id} (product_id=${productId})`,
        );
      } else {
        console.warn(
          `[Receiving] Auto-match failed for receiving line ${rl.receivingLineId}: ` +
          `zero or multiple open PO lines for product_id=${productId} on PO ${poId}. Leaving unlinked.`,
        );
      }
    }

    // Update each PO line's received/damaged quantities
    for (const rl of receivingLines) {
      if (!rl.purchaseOrderLineId) continue;
      const poLine = await storage.getPurchaseOrderLineById(rl.purchaseOrderLineId);
      if (!poLine) continue;
      // Skip non-product PO lines. Discount/fee/tax/rebate/adjustment lines
      // are accounting entries and cannot be physically received. A receiving
      // line pointing at one is either a data bug or a vendor sent something
      // we weren't expecting; let receiving surface the anomaly on its own UI.
      // Rows without lineType (pre-migration-0563) default to product.
      if ((poLine.lineType ?? "product") !== "product") continue;

      // Variant-Agnostic Reconciliation: Convert received variant quantity to base units, 
      // then convert those base units into the PO line's ordered variant units.
      const receivingLine = await storage.getReceivingLineById(rl.receivingLineId);
      if (!receivingLine) continue;

      const poVariant = await storage.getProductVariantById(poLine.productVariantId as number);
      const rlVariant = await storage.getProductVariantById(receivingLine.productVariantId as number);

      const poUnitsPerVariant = poVariant?.unitsPerVariant || poLine.unitsPerUom || 1;
      const rlUnitsPerVariant = rlVariant?.unitsPerVariant || 1;

      const baseUnitsReceived = rl.receivedQty * rlUnitsPerVariant;
      const damagedBaseUnits = (rl.damagedQty || 0) * rlUnitsPerVariant;

      const poLineUnitsReceived = Math.floor(baseUnitsReceived / poUnitsPerVariant);
      const poLineDamagedReceived = Math.floor(damagedBaseUnits / poUnitsPerVariant);

      const newReceivedQty = (poLine.receivedQty || 0) + poLineUnitsReceived;
      const newDamagedQty = (poLine.damagedQty || 0) + poLineDamagedReceived;
      const remaining = poLine.orderQty - newReceivedQty - (poLine.cancelledQty || 0);

      const lineUpdates: any = {
        receivedQty: newReceivedQty,
        damagedQty: newDamagedQty,
        lastReceivedAt: new Date(),
      };

      if (!poLine.receivedDate) {
        lineUpdates.receivedDate = new Date();
      }

      if (remaining <= 0) {
        lineUpdates.status = "received";
        lineUpdates.fullyReceivedDate = new Date();
      } else if (newReceivedQty > 0) {
        lineUpdates.status = "partially_received";
      }

      await storage.updatePurchaseOrderLine(poLine.id, lineUpdates);

      // Create PO receipt record
      await storage.createPoReceipt({
        purchaseOrderId: poId,
        purchaseOrderLineId: poLine.id,
        receivingOrderId: receivingOrderId,
        receivingLineId: rl.receivingLineId,
        qtyReceived: poLineUnitsReceived,
        poUnitCostCents: poLine.unitCostCents,
        actualUnitCostCents: rl.unitCost || poLine.unitCostCents,
        varianceCents: (rl.unitCost || poLine.unitCostCents) - poLine.unitCostCents,
      });
    }

    // Recalculate totals
    await recalculateTotals(poId);

    // Auto-transition PO status. Only product lines gate this — non-product
    // lines (discount/fee/tax/rebate/adjustment) have no physical qty to
    // receive, so they shouldn't block closure. Rows without lineType
    // (pre-migration-0563) default to product.
    const allLines = await storage.getPurchaseOrderLines(poId);
    const activeLines = allLines.filter(
      (l: any) =>
        l.status !== "cancelled" && ((l.lineType ?? "product") === "product"),
    );
    const allReceived = activeLines.every((l: any) => l.status === "received");
    const someReceived = activeLines.some((l: any) =>
      l.status === "received" || l.status === "partially_received"
    );

    if (allReceived) {
      await storage.updatePurchaseOrderStatusWithHistory(poId, {
        status: "received",
        actualDeliveryDate: new Date(),
      }, {
        fromStatus: po.status,
        toStatus: "received",
        changedBy: undefined,
        notes: "All lines fully received"
      });
    } else if (someReceived && po.status !== "partially_received") {
      await storage.updatePurchaseOrderStatusWithHistory(poId, { status: "partially_received" }, {
        fromStatus: po.status,
        toStatus: "partially_received",
        changedBy: undefined,
        notes: "Partial receipt"
      });
    }
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

      // Required on non-product lines; ignored on product lines (which
      // cache product_name/sku from the variant lookup).
      description?: string | null;

      // Required on product lines only. Must be null/absent on other types.
      productId?: number | null;
      productVariantId?: number | null;

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
  //   product     requires productVariantId; cost >= 0; qty > 0.
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
          if (line.productVariantId) {
            variant = await storage.getProductVariantById(line.productVariantId);
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

      // Build line rows. Product lines pull cached product info from the
      // variant lookup; non-product lines carry only the description. Both
      // record line_type (migration 0563) so downstream consumers can filter.
      const lineRows = resolvedLines.map((r, idx) => {
        const isProduct = r.lineType === "product";
        return {
          purchaseOrderId: header.id,
          lineNumber: idx + 1,
          productId: isProduct ? r.product.id : null,
          productVariantId: isProduct ? (r.variant?.id ?? null) : null,
          vendorProductId: isProduct ? (r.line.vendorProductId ?? null) : null,
          sku: isProduct ? (r.variant?.sku ?? null) : null,
          productName: isProduct ? r.product.name : null,
          description: r.line.description ?? null,
          unitOfMeasure: isProduct
            ? (r.variant?.name?.split(" ")[0]?.toLowerCase() ?? "each")
            : null,
          unitsPerUom: isProduct ? (r.variant?.unitsPerVariant || 1) : 1,
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

      const [row] = await tx
        .update(purchaseOrdersTable)
        .set({
          status: "sent",
          orderDate: new Date(),
          sentToVendorAt: new Date(),
          updatedBy: userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(purchaseOrdersTable.id, poId))
        .returning();
      await tx.insert(poStatusHistoryTable).values({
        purchaseOrderId: poId,
        fromStatus: currentStatus,
        toStatus: "sent",
        changedBy: userId ?? null,
        notes: "Sent to vendor (PDF placeholder)",
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
            src.productVariantId,
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
        productVariantId: srcLineType === "product" ? src.productVariantId : null,
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
    productVariantId: number;
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
          const vp = await storage.getPreferredVendorProduct(src.productId, src.productVariantId);
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
          productVariantId: src.productVariantId,
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
          productVariantId: variant.id,
          productName: product.name ?? "",
          sku: variant.sku ?? null,
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
