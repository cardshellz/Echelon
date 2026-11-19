import type { RfqWorkListDatabase, RfqWorkListExecutor } from "../../rfq-work-list.repository";
import { rfqListHeader, rfqListLine } from "../fixtures/rfq-work-list.fixture";
import { describe, expect, it, vi } from "vitest";
import {
  buildPurchasingRfqQueue,
  isPurchasingRfqCandidate,
  listRequestForQuotes,
  parseRfqListLimit,
  purchasingSkuAllocationKey,
  RFQ_LIST_DEFAULT_LIMIT,
  RFQ_LIST_MAX_LIMIT,
} from "../../purchasing-rfq.service";

function recommendation(overrides: Record<string, unknown> = {}) {
  return {
    recommendationId: "20:30:90",
    productId: 20,
    productVariantId: 30,
    sku: "SKU-RED",
    productName: "Red Card Shell",
    status: "order_now",
    skippedReason: "no_vendor",
    suggestedOrderPieces: 96,
    available: 12,
    onOrderPieces: 0,
    reorderPoint: 108,
    preferredVendorId: null,
    preferredVendorName: null,
    currentSupply: { effectiveSupplyPieces: 12 },
    demandBasis: { avgDailyUsagePieces: 2, periodUsagePieces: 180 },
    forecastProvenance: { demandWindowDays: 90 },
    supplierBasis: {
      vendorProductId: null,
      costSource: "missing",
      costQuality: "missing",
      estimatedCostMills: null,
      estimatedCostCents: null,
    },
    ...overrides,
  } as any;
}

describe("purchasing RFQ queue", () => {
  it("reserves the same product pieces across receiving choices while preserving warehouse scope", () => {
    for (const productVariantId of [30, 31, null, undefined]) {
      expect(purchasingSkuAllocationKey({ productId: 20, productVariantId, warehouseId: 90 })).toBe("20:90");
      expect(purchasingSkuAllocationKey({ productId: 20, productVariantId, warehouseId: null })).toBe("20:all");
    }
    expect(purchasingSkuAllocationKey({ productId: 20 })).toBe("20:all");
    expect(purchasingSkuAllocationKey({ productId: 20, warehouseId: 91 })).not.toBe("20:90");
    expect(purchasingSkuAllocationKey({ productId: 21, warehouseId: 90 })).not.toBe("20:90");
    expect(purchasingSkuAllocationKey({ productId: 20, warehouseId: null })).not.toBe("20:90");
  });

  it("surfaces the exact SKU and required pieces without a vendor or price", () => {
    const item = recommendation();

    expect(isPurchasingRfqCandidate(item)).toBe(true);
    expect(buildPurchasingRfqQueue({ items: [], skippedItems: [item] })).toEqual([
      expect.objectContaining({
        recommendationId: "20:30:90",
        sku: "SKU-RED",
        requestedPieces: 96,
        supplierAssignmentRequired: true,
        preferredVendorId: null,
        vendorProductId: null,
      }),
    ]);
  });

  it("keeps a price-free requirement visible when a preferred vendor is already assigned", () => {
    const item = recommendation({
      skippedReason: null,
      preferredVendorId: 7,
      preferredVendorName: "Supply Co",
      supplierBasis: {
        vendorProductId: 44,
        costSource: "missing",
        costQuality: "missing",
        estimatedCostMills: null,
        estimatedCostCents: null,
      },
    });

    expect(buildPurchasingRfqQueue({ items: [item], skippedItems: [] })[0]).toMatchObject({
      requestedPieces: 96,
      preferredVendorId: 7,
      preferredVendorName: "Supply Co",
      vendorProductId: 44,
      supplierAssignmentRequired: false,
    });
  });

  it.each(["excluded", "already_on_order", "not_actionable_status", "zero_suggested_quantity"])(
    "does not create an RFQ candidate when the recommendation is %s",
    (skippedReason) => {
      expect(isPurchasingRfqCandidate(recommendation({ skippedReason }))).toBe(false);
    },
  );

  it("requires a positive base-piece quantity", () => {
    expect(isPurchasingRfqCandidate(recommendation({ suggestedOrderPieces: 0 }))).toBe(false);
    expect(isPurchasingRfqCandidate(recommendation({ suggestedOrderPieces: 1.5 }))).toBe(false);
  });

  it("preserves the demand evidence used to justify the RFQ quantity", () => {
    const [item] = buildPurchasingRfqQueue({ items: [], skippedItems: [recommendation({ orderRounding: { incrementPieces: 24, source: "vendor_pack" } })] });

    expect(item.demandSnapshot).toMatchObject({
      recommendationId: "20:30:90",
      availablePieces: 12,
      onOrderPieces: 0,
      effectiveSupplyPieces: 12,
      reorderPointPieces: 108,
      suggestedOrderPieces: 96,
      orderRounding: { incrementPieces: 24, source: "vendor_pack" },
      generatedForLookbackDays: 90,
    });
  });
});

function listDatabase(headers: unknown[], lines: unknown[] = [], links: unknown[] = [], total = headers.length) {
  const execute = vi.fn<RfqWorkListExecutor["execute"]>()
    .mockResolvedValueOnce({ rows: [{ total: String(total) }] }).mockResolvedValueOnce({ rows: headers })
    .mockResolvedValueOnce({ rows: lines }).mockResolvedValueOnce({ rows: links });
  const database: RfqWorkListDatabase = { transaction: vi.fn(async work => work({ execute })) };
  return { database, execute };
}

describe("RFQ tracking list", () => {
  it("validates a bounded page and rejects malformed filters before database access", async () => {
    expect(parseRfqListLimit(undefined)).toBe(RFQ_LIST_DEFAULT_LIMIT);
    expect(parseRfqListLimit("10")).toBe(10);
    expect(parseRfqListLimit(RFQ_LIST_MAX_LIMIT)).toBe(100);
    const { database } = listDatabase([]);
    for (const limit of ["", "abc", 0, -5, 5000, "10suffix", "1.5", ["10"]]) {
      await expect(listRequestForQuotes(database, { limit })).rejects.toThrow();
    }
    await expect(listRequestForQuotes(database, { status: "unknown" })).rejects.toThrow();
    expect(database.transaction).not.toHaveBeenCalled();
  });
  it("returns an empty page and matching total without issuing line or link queries", async () => {
    const { database, execute } = listDatabase([]);
    expect(await listRequestForQuotes(database)).toEqual({ limit: 25, count: 0, statusCounts: {}, rfqs: [], page: { total: 0, limit: 25, offset: 0, nextOffset: null } });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(database.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "repeatable read", accessMode: "read only" });
  });
  it("preserves joined lines, supplier names, piece totals and original override evidence", async () => {
    const header = rfqListHeader();
    const second = rfqListHeader({ id: 41, rfqNumber: "RFQ-2026-0041", vendorName: "Shell Works" });
    const firstLine = rfqListLine();
    const overridden = rfqListLine({ id: 502, requestedPieces: 125, quantityOverrideReason: "Build safety stock for launch", allocationOverrideApprovedBy: "buyer-17", allocationOverrideBaselinePieces: 100, allocationOverrideExcessPieces: 25 });
    const { database } = listDatabase([header, second], [firstLine, overridden, rfqListLine({ id: 503, rfqId: 41, requestedPieces: 50 })]);
    const result = await listRequestForQuotes(database, { limit: 10 });
    expect(result.limit).toBe(10); expect(result.count).toBe(2); expect(result.statusCounts).toEqual({ draft: 2 });
    expect(result.rfqs.map(rfq => rfq.rfqNumber)).toEqual(["RFQ-2026-0042", "RFQ-2026-0041"]);
    expect(result.rfqs[0]).toMatchObject({ id: 42, vendorId: 7, vendorName: "Supply Co", responseDueDate: "2026-07-30", lineCount: 2, requestedPiecesTotal: 221 });
    expect(result.rfqs[0].lines).toEqual([firstLine, overridden]);
    expect(result.rfqs[1]).toMatchObject({ id: 41, vendorName: "Shell Works", lineCount: 1, requestedPiecesTotal: 50 });
  });
  it("keeps null supplier names and stored non-draft statuses visible", async () => {
    const { database } = listDatabase([rfqListHeader({ vendorName: null, status: "sent" })]);
    const result = await listRequestForQuotes(database);
    expect(result.statusCounts).toEqual({ sent: 1 });
    expect(result.rfqs[0]).toMatchObject({ vendorName: null, status: "sent", lineCount: 0, requestedPiecesTotal: 0 });
  });
  it("retains page-only status counts separately from all matching rows", async () => {
    const { database } = listDatabase([rfqListHeader({ status: "quoted" })], [], [], 4);
    const result = await listRequestForQuotes(database, { limit: 1, offset: 2 });
    expect(result).toMatchObject({ count: 1, statusCounts: { quoted: 1 }, page: { total: 4, limit: 1, offset: 2, nextOffset: 3 } });
  });
  it("normalizes stored timestamps and exact bigint money without rounding unsafe values", async () => {
    const first = listDatabase([{ ...rfqListHeader(), createdAt: new Date("2026-07-21T10:00:00.000Z"), updatedAt: "2026-07-21 06:00:00-04" }], [{ ...rfqListLine(), quotedUnitCostMills: "9007199254740991" }]);
    const result = await listRequestForQuotes(first.database);
    expect(result.rfqs[0].lines[0].quotedUnitCostMills).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.rfqs[0].updatedAt).toBe("2026-07-21T10:00:00.000Z");
    const bad = listDatabase([rfqListHeader()], [{ ...rfqListLine(), quotedUnitCostMills: "9007199254740993" }]);
    await expect(listRequestForQuotes(bad.database)).rejects.toThrow();
  });
});
