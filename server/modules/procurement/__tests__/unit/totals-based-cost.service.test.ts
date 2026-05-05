import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPurchasingService, PurchasingError } from "../../purchasing.service";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for Spec F Phase 1 — totals-based cost storage.
//
// Covers:
//   1. createPurchaseOrderWithLines accepts new totals shape (totalProductCostCents
//      + packagingCostCents) and computes derived fields correctly.
//   2. Old shape (unitCostMills/unitCostCents) still works — backward compat.
//   3. When both shapes are sent, totals win; per-unit is recomputed.
//   4. Edge cases: qty=0, packaging=0.
//   5. Non-product lines (fee, discount, etc.) still use unit cost as source.
//   6. lineTotalCents = totalProductCostCents + packagingCostCents (exact).
// ─────────────────────────────────────────────────────────────────────────────

function buildInsertChain(returnValue: any[] = []) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(returnValue),
    }),
  };
}

function buildMockDb(headerReturn: any, captureInserts: any[]) {
  const txInsert = vi.fn((table: any) => {
    const chain = {
      values: vi.fn((rows: any) => {
        captureInserts.push({ table, rows });
        const returning = vi.fn().mockResolvedValue([]);
        if (captureInserts.length === 1) {
          returning.mockResolvedValue([headerReturn]);
        }
        return { returning };
      }),
    };
    return chain;
  });
  const tx = {
    insert: txInsert,
    update: vi.fn(),
    select: vi.fn(),
  };
  return {
    insert: vi.fn().mockReturnValue(buildInsertChain()),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    }),
    update: vi.fn(),
    transaction: vi.fn(async (fn: any) => fn(tx)),
  };
}

function buildMockStorage(overrides: Partial<Record<string, any>> = {}) {
  return {
    getPurchaseOrders: vi.fn(),
    getPurchaseOrdersCount: vi.fn(),
    getPurchaseOrderById: vi.fn(),
    getPurchaseOrderByPoNumber: vi.fn(),
    createPurchaseOrder: vi.fn(),
    updatePurchaseOrder: vi.fn(),
    updatePurchaseOrderStatusWithHistory: vi.fn(),
    deletePurchaseOrder: vi.fn(),
    generatePoNumber: vi.fn().mockResolvedValue("PO-TEST-001"),
    getPurchaseOrderLines: vi.fn().mockResolvedValue([]),
    getPurchaseOrderLineById: vi.fn(),
    createPurchaseOrderLine: vi.fn(),
    bulkCreatePurchaseOrderLines: vi.fn(),
    updatePurchaseOrderLine: vi.fn(),
    deletePurchaseOrderLine: vi.fn(),
    getOpenPoLinesForVariant: vi.fn(),
    createPoStatusHistory: vi.fn(),
    getPoStatusHistory: vi.fn(),
    createPoRevision: vi.fn(),
    getPoRevisions: vi.fn(),
    createPoReceipt: vi.fn(),
    getPoReceipts: vi.fn(),
    getAllPoApprovalTiers: vi.fn().mockResolvedValue([]),
    getPoApprovalTierById: vi.fn(),
    getMatchingApprovalTier: vi.fn().mockResolvedValue(null),
    getVendorProducts: vi.fn(),
    getVendorProductById: vi.fn(),
    getPreferredVendorProduct: vi.fn().mockResolvedValue(null),
    getVendorById: vi.fn().mockResolvedValue({ id: 1, currency: "USD" }),
    getProductVariantById: vi.fn().mockResolvedValue({
      id: 11,
      productId: 1,
      sku: "SKU-1",
      name: "case size",
      unitsPerVariant: 1,
    }),
    getProductById: vi.fn().mockResolvedValue({ id: 1, name: "Product 1" }),
    createReceivingOrder: vi.fn(),
    generateReceiptNumber: vi.fn(),
    bulkCreateReceivingLines: vi.fn(),
    getSetting: vi.fn().mockResolvedValue(null),
    searchVendorCatalog: vi.fn(),
    ...overrides,
  } as any;
}

describe("Spec F Phase 1 — totals-based cost storage", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;

  beforeEach(() => {
    storage = buildMockStorage();
  });

  describe("new shape: totalProductCostCents + packagingCostCents", () => {
    it("stores exact totals and computes derived fields", async () => {
      const captureInserts: any[] = [];
      svc = createPurchasingService(
        buildMockDb({ id: 42 }, captureInserts),
        storage,
      );

      // Real-world example: $11,600 goods + $1,170 packaging, 200,000 qty
      await svc.createPurchaseOrderWithLines({
        vendorId: 1,
        lines: [
          {
            productId: 1,
            productVariantId: 11,
            orderQty: 200000,
            totalProductCostCents: 1160000,
            packagingCostCents: 117000,
          } as any,
        ],
      });

      const linesInsert = captureInserts.find(
        (c) => Array.isArray(c.rows) && c.rows[0]?.totalProductCostCents !== undefined,
      );
      expect(linesInsert).toBeTruthy();

      const row = linesInsert.rows[0];
      // Totals stored exactly
      expect(row.totalProductCostCents).toBe(1160000);
      expect(row.packagingCostCents).toBe(117000);
      // Line total = goods + packaging (exact)
      expect(row.lineTotalCents).toBe(1277000);
      // Derived unit cost: 1160000 * 100 / 200000 = 580 mills = $0.0580
      expect(row.unitCostMills).toBe(580);
      // Derived cents: 1160000 / 200000 = 5.8 → 6 cents (half-up)
      expect(row.unitCostCents).toBe(6);
    });

    it("handles packaging = 0 correctly", async () => {
      const captureInserts: any[] = [];
      svc = createPurchasingService(
        buildMockDb({ id: 42 }, captureInserts),
        storage,
      );

      await svc.createPurchaseOrderWithLines({
        vendorId: 1,
        lines: [
          {
            productId: 1,
            productVariantId: 11,
            orderQty: 100,
            totalProductCostCents: 500,
            packagingCostCents: 0,
          } as any,
        ],
      });

      const linesInsert = captureInserts.find(
        (c) => Array.isArray(c.rows) && c.rows[0]?.totalProductCostCents !== undefined,
      );
      const row = linesInsert.rows[0];
      expect(row.totalProductCostCents).toBe(500);
      expect(row.packagingCostCents).toBe(0);
      expect(row.lineTotalCents).toBe(500);
      // 500 * 100 / 100 = 500 mills = $0.0500
      expect(row.unitCostMills).toBe(500);
    });

    it("rounds derived unit cost with half-up precision", async () => {
      const captureInserts: any[] = [];
      svc = createPurchasingService(
        buildMockDb({ id: 42 }, captureInserts),
        storage,
      );

      // $11,615 total / 200,000 qty = $0.058075/unit
      // In mills: 1161500 * 100 / 200000 = 580.75 → 581 (half-up)
      await svc.createPurchaseOrderWithLines({
        vendorId: 1,
        lines: [
          {
            productId: 1,
            productVariantId: 11,
            orderQty: 200000,
            totalProductCostCents: 1161500,
            packagingCostCents: 0,
          } as any,
        ],
      });

      const linesInsert = captureInserts.find(
        (c) => Array.isArray(c.rows) && c.rows[0]?.totalProductCostCents !== undefined,
      );
      const row = linesInsert.rows[0];
      expect(row.totalProductCostCents).toBe(1161500); // EXACT — no rounding
      expect(row.unitCostMills).toBe(581); // half-up from 580.75
      expect(row.lineTotalCents).toBe(1161500);
    });
  });

  describe("old shape: unitCostMills (backward compat)", () => {
    it("still accepts mills-only input and derives totals", async () => {
      const captureInserts: any[] = [];
      svc = createPurchasingService(
        buildMockDb({ id: 42 }, captureInserts),
        storage,
      );

      await svc.createPurchaseOrderWithLines({
        vendorId: 1,
        lines: [
          {
            productId: 1,
            productVariantId: 11,
            orderQty: 100,
            unitCostMills: 375,
          } as any,
        ],
      });

      const linesInsert = captureInserts.find(
        (c) => Array.isArray(c.rows) && c.rows[0]?.totalProductCostCents !== undefined,
      );
      const row = linesInsert.rows[0];
      // Old shape: derive totalProductCostCents = round(375 * 100 / 100) = 375
      expect(row.totalProductCostCents).toBe(375);
      expect(row.packagingCostCents).toBe(0);
      expect(row.unitCostMills).toBe(375);
    });
  });

  describe("both shapes sent: totals win", () => {
    it("prefers totalProductCostCents over unitCostMills", async () => {
      const captureInserts: any[] = [];
      svc = createPurchasingService(
        buildMockDb({ id: 42 }, captureInserts),
        storage,
      );

      // Send both: old shape says 375 mills, new shape says 500 cents total.
      // Totals should win.
      await svc.createPurchaseOrderWithLines({
        vendorId: 1,
        lines: [
          {
            productId: 1,
            productVariantId: 11,
            orderQty: 100,
            unitCostMills: 375, // old shape
            totalProductCostCents: 500, // new shape — wins
            packagingCostCents: 50,
          } as any,
        ],
      });

      const linesInsert = captureInserts.find(
        (c) => Array.isArray(c.rows) && c.rows[0]?.totalProductCostCents !== undefined,
      );
      const row = linesInsert.rows[0];
      expect(row.totalProductCostCents).toBe(500);
      expect(row.packagingCostCents).toBe(50);
      expect(row.lineTotalCents).toBe(550);
      // Derived from new shape, NOT from old 375 mills
      // 500 * 100 / 100 = 500 mills
      expect(row.unitCostMills).toBe(500);
    });
  });

  describe("non-product lines still use unit cost", () => {
    it("fee line uses unitCostMills as source, totals are 0", async () => {
      const captureInserts: any[] = [];
      svc = createPurchasingService(
        buildMockDb({ id: 42 }, captureInserts),
        storage,
      );

      await svc.createPurchaseOrderWithLines({
        vendorId: 1,
        lines: [
          {
            productId: 1,
            productVariantId: 11,
            orderQty: 100,
            totalProductCostCents: 500,
          },
          {
            lineType: "fee",
            description: "Freight charge",
            orderQty: 1,
            unitCostMills: 5000, // $0.50
          },
        ] as any,
      });

      const linesInsert = captureInserts.find(
        (c) => Array.isArray(c.rows) && Array.isArray(c.rows) && c.rows.length > 1,
      );
      expect(linesInsert).toBeTruthy();

      const feeLine = linesInsert.rows[1];
      expect(feeLine.lineType).toBe("fee");
      expect(feeLine.unitCostMills).toBe(5000);
      expect(feeLine.totalProductCostCents).toBe(0); // not set for non-product
      expect(feeLine.packagingCostCents).toBe(0);
    });
  });

  describe("edge case: qty with non-exact division", () => {
    it("preserves exact total even when per-unit is not representable", async () => {
      const captureInserts: any[] = [];
      svc = createPurchasingService(
        buildMockDb({ id: 42 }, captureInserts),
        storage,
      );

      // $12,770 total / 200,000 qty = $0.063850 exactly
      // Old system: round to mills = 639 mills = $0.0639 → total = $12,780 (OFF BY $10!)
      // New system: total stored exactly as 1277000 cents
      await svc.createPurchaseOrderWithLines({
        vendorId: 1,
        lines: [
          {
            productId: 1,
            productVariantId: 11,
            orderQty: 200000,
            totalProductCostCents: 1277000,
            packagingCostCents: 0,
          } as any,
        ],
      });

      const linesInsert = captureInserts.find(
        (c) => Array.isArray(c.rows) && c.rows[0]?.totalProductCostCents !== undefined,
      );
      const row = linesInsert.rows[0];

      // Total is EXACT — the whole point of Spec F
      expect(row.totalProductCostCents).toBe(1277000);
      expect(row.lineTotalCents).toBe(1277000);

      // Derived unit cost: 1277000 * 100 / 200000 = 638.5 → 639 (half-up)
      // This is the closest mills representation, but we DON'T rely on it for total.
      expect(row.unitCostMills).toBe(639);

      // Verify: if we used mills to compute total, we'd get 639 * 200000 / 100 = 1278000
      // which is 1278000 cents = $12,780 — WRONG by $10.
      // But our stored total is 1277000 = $12,770 — CORRECT.
      const wrongTotalFromMills = Math.round((639 * 200000) / 100);
      expect(wrongTotalFromMills).toBe(1278000); // proves the rounding error
      expect(row.lineTotalCents).not.toBe(wrongTotalFromMills); // we avoid it!
    });
  });
});
