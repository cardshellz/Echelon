import { Decimal } from "decimal.js";
import { readIntegerCents, readIntegerMills } from "@shared/money-read";
import type { PoLineType } from "@shared/schema/procurement.schema";
import { centsToMills } from "@shared/utils/money";
import {
  signedCentsToMills,
  signedMillsToCents,
  signedRoundHalfUpDiv,
  type AllocatedLineCost,
  type AllocationResult,
  type PoTotalsBreakdown,
  type PurchasingBaseContext,
} from "./purchasing.types";

export type CalculatedLineCosts = {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  lineTotalCents: number;
  totalProductCostCents: number;
  packagingCostCents: number;
  unitCostMills: number;
  unitCostCents: number;
};

export function createPurchasingCosting(ctx: Pick<PurchasingBaseContext, "storage">) {
  const { storage } = ctx;

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
      resolvedPackagingCostCents = readIntegerCents(line.packagingCostCents ?? 0, "packaging cost", true);
      subtotalCents = resolvedTotalProductCostCents + resolvedPackagingCostCents;
      // Normalize the product quote only. Packaging remains its own exact-cent
      // layer and must never be folded into the vendor's per-piece quote.
      resolvedUnitCostMills =
        qty > 0
          ? readIntegerMills(signedRoundHalfUpDiv(
                BigInt(resolvedTotalProductCostCents) * BigInt(100),
                BigInt(qty),
              ), "resolved unit cost", true)
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
        ? readIntegerCents(signedRoundHalfUpDiv(
              BigInt(line.unitCostMills as number) * BigInt(qty),
              BigInt(100),
            ), "subtotal", true)
        : qty * readIntegerCents(line.unitCostCents ?? 0, "unit cost", true);

      resolvedTotalProductCostCents = subtotalCents;
      resolvedPackagingCostCents = 0;
      resolvedUnitCostMills = millsAuthoritative
        ? (line.unitCostMills as number)
        : signedCentsToMills(readIntegerCents(line.unitCostCents ?? 0, "unit cost", true));
      resolvedUnitCostCents = millsAuthoritative
        ? signedMillsToCents(line.unitCostMills as number)
        : readIntegerCents(line.unitCostCents ?? 0, "unit cost", true);
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

  function computePoTotalsFromLines(lines: any[]): PoTotalsBreakdown {
    let productSubtotal = BigInt(0);
    let discountTotal = BigInt(0);
    let feeTotal = BigInt(0);
    let taxTotal = BigInt(0);
    let adjustmentTotal = BigInt(0);
    for (const line of lines) {
      if (line.status === "cancelled") continue;
      const lineTotal = BigInt(readIntegerCents(line.lineTotalCents, "line total", true));
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
      productSubtotalCents: readIntegerCents(productSubtotal, "product subtotal", true),
      discountTotalCents: readIntegerCents(discountTotal, "discount total", true),
      feeTotalCents: readIntegerCents(feeTotal, "fee total", true),
      taxTotalCents: readIntegerCents(taxTotal, "tax total", true),
      adjustmentTotalCents: readIntegerCents(adjustmentTotal, "adjustment total", true),
      totalCents: readIntegerCents(total, "purchase order total", true),
    };
  }

  function computeAllocatedLineCosts(lines: any[]): AllocationResult {
    // Partition lines by type. Cancelled lines never participate.
    const productLines: any[] = [];
    let pooledCents = 0;
    for (const line of lines) {
      if (line.status === "cancelled") continue;
      const type: PoLineType = (line.lineType as PoLineType) ?? "product";
      const lineTotal = readIntegerCents(line.lineTotalCents, "line total", true);
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
      (sum, l) => sum + (readIntegerCents(l.lineTotalCents, "product subtotal", true)),
      0,
    );

    // Edge: no product lines or zero/negative product subtotal. Nothing to
    // allocate against — surface the pool as "unallocated" so the caller can
    // decide what to do (most likely: error or warn the user).
    if (productLines.length === 0 || productSubtotalCents <= 0) {
      return {
        perLine: productLines.map((l) => ({
          purchaseOrderLineId: Number(l.id),
          lineTotalCents: readIntegerCents(l.lineTotalCents, "line total", true),
          allocatedCents: 0,
          landedLineTotalCents: readIntegerCents(l.lineTotalCents, "landed line total", true),
          landedUnitCostMills:
            typeof l.unitCostMills === "number"
              ? l.unitCostMills
              : centsToMills(readIntegerCents(l.unitCostCents, "landed unit cost", true)),
          landedUnitCostCents: readIntegerCents(l.unitCostCents, "landed unit cost", true),
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
      const lineTotalCents = readIntegerCents(line.lineTotalCents, "line total", true);
      const qty = Number(line.orderQty) || 0;
      const basis = lineTotalCents > 0 ? lineTotalCents : 0;

      // share = basis / productSubtotalCents.
      // allocatedCents = round_half_up_away_from_zero(pool * basis / productSubtotal).
      // BigInt + signed half-up helper for deterministic rounding (Rule #2)
      // and overflow safety.
      let allocatedCents = 0;
      if (basis > 0) {
        allocatedCents = readIntegerCents(signedRoundHalfUpDiv(
            BigInt(pooledCents) * BigInt(basis),
            BigInt(productSubtotalCents),
          ), "allocated", true);
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
          ? readIntegerMills(signedRoundHalfUpDiv(
                BigInt(landedLineTotalCents) * BigInt(100),
                BigInt(qty),
              ), "landed unit cost", true)
          : 0;
      const landedUnitCostCents =
        qty > 0
          ? readIntegerCents(signedRoundHalfUpDiv(BigInt(landedLineTotalCents), BigInt(qty)), "landed unit cost", true)
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
        target.landedUnitCostMills = readIntegerMills(signedRoundHalfUpDiv(
            BigInt(target.landedLineTotalCents) * BigInt(100),
            BigInt(qty),
          ), "landed unit cost", true);
        target.landedUnitCostCents = readIntegerCents(signedRoundHalfUpDiv(BigInt(target.landedLineTotalCents), BigInt(qty)), "landed unit cost", true);
      }
    }

    return {
      perLine,
      pooledCents,
      productSubtotalCents,
      unallocatedCents: 0,
    };
  }

  async function recalculateTotals(purchaseOrderId: number, userId?: string, executor?: any): Promise<any> {
    const lines = await storage.getPurchaseOrderLines(purchaseOrderId, executor);
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
        }, executor);
      }
    }

    const po = await storage.getPurchaseOrderById(purchaseOrderId, executor);
    const headerDiscount = BigInt(po?.discountCents || 0);
    const headerTax = BigInt(po?.taxCents || 0);
    const headerShipping = BigInt(po?.shippingCostCents || 0);

    const totalCents = subtotalCents - headerDiscount + headerTax + headerShipping;

    // recalculateTotals does NOT change PO status; it only refreshes totals.
    // Use the plain update helper so we don't write a spurious po_status_history
    // row (which would violate the to_status NOT NULL constraint when called
    // with no historyData). Regression of commit 4c0a3cc.
    return await storage.updatePurchaseOrder(purchaseOrderId, {
      subtotalCents: readIntegerCents(subtotalCents, "subtotalCents", true),
      totalCents: readIntegerCents(totalCents, "totalCents", true),
      lineCount,
      receivedLineCount,
      updatedBy: userId,
    }, executor);
  }

  return {
    calculateLineCosts,
    computePoTotalsFromLines,
    computeAllocatedLineCosts,
    recalculateTotals,
  };
}

export type PurchasingCosting = ReturnType<typeof createPurchasingCosting>;
