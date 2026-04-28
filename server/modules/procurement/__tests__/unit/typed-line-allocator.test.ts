import { describe, it, expect, vi } from "vitest";
import { createPurchasingService } from "../../purchasing.service";

// ─────────────────────────────────────────────────────────────────────────────
// Typed-line cost allocator (Option C, 2026-04-28).
//
// Verifies computeAllocatedLineCosts spreads non-product line totals
// (discount / fee / tax / rebate / adjustment) across product lines
// proportionally, with deterministic half-up rounding and a remainder rule
// that keeps totals exact.
// ─────────────────────────────────────────────────────────────────────────────

function makeSvc() {
  const storage: any = {
    getPurchaseOrderLines: vi.fn().mockResolvedValue([]),
  };
  const db: any = { transaction: vi.fn() };
  const svc = createPurchasingService(db, storage);
  return { svc, storage, db };
}

describe("computeAllocatedLineCosts", () => {
  it("returns identity allocation when no non-product lines exist", () => {
    const { svc } = makeSvc();
    const result = svc.computeAllocatedLineCosts([
      {
        id: 1,
        lineType: "product",
        status: "open",
        orderQty: 100,
        unitCostMills: 5000,
        unitCostCents: 50,
        lineTotalCents: 5000,
      },
    ]);
    expect(result.pooledCents).toBe(0);
    expect(result.productSubtotalCents).toBe(5000);
    expect(result.unallocatedCents).toBe(0);
    expect(result.perLine).toHaveLength(1);
    expect(result.perLine[0].allocatedCents).toBe(0);
    expect(result.perLine[0].landedLineTotalCents).toBe(5000);
    expect(result.perLine[0].landedUnitCostCents).toBe(50);
    expect(result.perLine[0].landedUnitCostMills).toBe(5000);
  });

  it("spreads a fee evenly across two equally-priced product lines", () => {
    const { svc } = makeSvc();
    const result = svc.computeAllocatedLineCosts([
      {
        id: 1,
        lineType: "product",
        status: "open",
        orderQty: 100,
        unitCostMills: 5000,
        unitCostCents: 50,
        lineTotalCents: 5000,
      },
      {
        id: 2,
        lineType: "product",
        status: "open",
        orderQty: 100,
        unitCostMills: 5000,
        unitCostCents: 50,
        lineTotalCents: 5000,
      },
      {
        id: 3,
        lineType: "fee",
        status: "open",
        orderQty: 1,
        lineTotalCents: 2000, // $20 freight
      },
    ]);
    expect(result.pooledCents).toBe(2000);
    expect(result.productSubtotalCents).toBe(10000);
    // $20 split evenly = $10 per line.
    const a = result.perLine.find((p) => p.purchaseOrderLineId === 1)!;
    const b = result.perLine.find((p) => p.purchaseOrderLineId === 2)!;
    expect(a.allocatedCents + b.allocatedCents).toBe(2000);
    expect(a.allocatedCents).toBe(1000);
    expect(b.allocatedCents).toBe(1000);
    expect(a.landedLineTotalCents).toBe(6000);
    expect(a.landedUnitCostCents).toBe(60);
    expect(a.landedUnitCostMills).toBe(6000);
  });

  it("spreads a discount proportional to product line totals", () => {
    const { svc } = makeSvc();
    // Line A = $300, Line B = $700, total $1000. Discount -$100.
    // Expected: A gets -$30, B gets -$70.
    const result = svc.computeAllocatedLineCosts([
      {
        id: 1,
        lineType: "product",
        status: "open",
        orderQty: 100,
        unitCostMills: 30000,
        unitCostCents: 300,
        lineTotalCents: 30000,
      },
      {
        id: 2,
        lineType: "product",
        status: "open",
        orderQty: 100,
        unitCostMills: 70000,
        unitCostCents: 700,
        lineTotalCents: 70000,
      },
      {
        id: 3,
        lineType: "discount",
        status: "open",
        orderQty: 1,
        lineTotalCents: -10000, // -$100
      },
    ]);
    const a = result.perLine.find((p) => p.purchaseOrderLineId === 1)!;
    const b = result.perLine.find((p) => p.purchaseOrderLineId === 2)!;
    expect(a.allocatedCents + b.allocatedCents).toBe(-10000);
    expect(a.allocatedCents).toBe(-3000);
    expect(b.allocatedCents).toBe(-7000);
  });

  it("absorbs rounding remainder into the largest-basis line", () => {
    const { svc } = makeSvc();
    // 3 product lines of $1, $1, $1. Fee of $1. Each gets $0.33 = 33¢ via
    // half-up. 33+33+33 = 99. Remainder 1¢ goes to the largest-basis line
    // (or the first if all equal).
    const result = svc.computeAllocatedLineCosts([
      {
        id: 1,
        lineType: "product",
        status: "open",
        orderQty: 1,
        unitCostMills: 10000,
        unitCostCents: 100,
        lineTotalCents: 100,
      },
      {
        id: 2,
        lineType: "product",
        status: "open",
        orderQty: 1,
        unitCostMills: 10000,
        unitCostCents: 100,
        lineTotalCents: 100,
      },
      {
        id: 3,
        lineType: "product",
        status: "open",
        orderQty: 1,
        unitCostMills: 10000,
        unitCostCents: 100,
        lineTotalCents: 100,
      },
      {
        id: 4,
        lineType: "fee",
        status: "open",
        orderQty: 1,
        lineTotalCents: 100, // $1.00
      },
    ]);
    const sum = result.perLine.reduce((s, p) => s + p.allocatedCents, 0);
    expect(sum).toBe(100); // total reconciles exactly
    // First line (largest basis index) gets 34, others 33.
    const sorted = [...result.perLine].sort(
      (a, b) => a.purchaseOrderLineId - b.purchaseOrderLineId,
    );
    // Only one line gets 34, the other two get 33 — remainder absorbed.
    const counts = sorted.map((p) => p.allocatedCents).sort();
    expect(counts).toEqual([33, 33, 34]);
  });

  it("handles a mixed-type PO matching Overlord's screenshot", () => {
    // Storage box: 1000 × $0.52 = $520
    // Discount: -$400, Fee: $1000, Tax: $500
    // Pool: -400 + 1000 + 500 = +1100
    // Single product line absorbs the entire pool.
    // Landed line total: 520 + 1100 = 1620
    // Per-unit: 1620 / 1000 = 1.62  (in mills: 162000 / 1000 = 162 — wait
    // that's wrong; recheck)
    // landed_line_total_cents = 162000 cents. Per unit cents = 162000/1000 = 162.
    // Per unit mills = 162000 * 100 / 1000 = 16200 mills.
    const { svc } = makeSvc();
    const result = svc.computeAllocatedLineCosts([
      {
        id: 1,
        lineType: "product",
        status: "open",
        orderQty: 1000,
        unitCostMills: 5200,
        unitCostCents: 52,
        lineTotalCents: 52000,
      },
      {
        id: 2,
        lineType: "discount",
        status: "open",
        orderQty: 1,
        lineTotalCents: -40000,
      },
      {
        id: 3,
        lineType: "fee",
        status: "open",
        orderQty: 1,
        lineTotalCents: 100000,
      },
      {
        id: 4,
        lineType: "tax",
        status: "open",
        orderQty: 1,
        lineTotalCents: 50000,
      },
    ]);
    expect(result.pooledCents).toBe(110000);
    expect(result.productSubtotalCents).toBe(52000);
    const product = result.perLine.find((p) => p.purchaseOrderLineId === 1)!;
    expect(product.allocatedCents).toBe(110000);
    expect(product.landedLineTotalCents).toBe(162000);
    expect(product.landedUnitCostCents).toBe(162);
    // per-unit mills = round_half_up(162000 * 100 / 1000) = 16200
    expect(product.landedUnitCostMills).toBe(16200);
  });

  it("surfaces unallocatedCents when there are no product lines", () => {
    const { svc } = makeSvc();
    const result = svc.computeAllocatedLineCosts([
      {
        id: 1,
        lineType: "fee",
        status: "open",
        orderQty: 1,
        lineTotalCents: 1000,
      },
    ]);
    expect(result.productSubtotalCents).toBe(0);
    expect(result.pooledCents).toBe(1000);
    expect(result.unallocatedCents).toBe(1000);
    expect(result.perLine).toHaveLength(0);
  });

  it("ignores cancelled lines on both sides", () => {
    const { svc } = makeSvc();
    const result = svc.computeAllocatedLineCosts([
      {
        id: 1,
        lineType: "product",
        status: "open",
        orderQty: 100,
        unitCostMills: 5000,
        unitCostCents: 50,
        lineTotalCents: 5000,
      },
      {
        id: 2,
        lineType: "product",
        status: "cancelled",
        orderQty: 100,
        unitCostMills: 5000,
        unitCostCents: 50,
        lineTotalCents: 5000,
      },
      {
        id: 3,
        lineType: "fee",
        status: "open",
        orderQty: 1,
        lineTotalCents: 1000,
      },
      {
        id: 4,
        lineType: "fee",
        status: "cancelled",
        orderQty: 1,
        lineTotalCents: 9999,
      },
    ]);
    // Pool ignores cancelled fee. Product subtotal ignores cancelled product.
    expect(result.pooledCents).toBe(1000);
    expect(result.productSubtotalCents).toBe(5000);
    // Cancelled product line is not in perLine.
    expect(result.perLine).toHaveLength(1);
    expect(result.perLine[0].allocatedCents).toBe(1000);
  });

  it("handles a net-discount PO (pool more negative than products)", () => {
    // Edge case: discount exceeds product subtotal. Math should still
    // work — landed line total goes negative, which is the user's signal
    // that something is structurally wrong, but the function shouldn't
    // crash or distort.
    const { svc } = makeSvc();
    const result = svc.computeAllocatedLineCosts([
      {
        id: 1,
        lineType: "product",
        status: "open",
        orderQty: 100,
        unitCostMills: 1000,
        unitCostCents: 10,
        lineTotalCents: 1000,
      },
      {
        id: 2,
        lineType: "discount",
        status: "open",
        orderQty: 1,
        lineTotalCents: -2000,
      },
    ]);
    expect(result.pooledCents).toBe(-2000);
    expect(result.perLine[0].allocatedCents).toBe(-2000);
    expect(result.perLine[0].landedLineTotalCents).toBe(-1000);
    // -1000 cents / 100 qty = -10 cents per unit; in mills = -1000.
    expect(result.perLine[0].landedUnitCostCents).toBe(-10);
    expect(result.perLine[0].landedUnitCostMills).toBe(-1000);
  });
});
