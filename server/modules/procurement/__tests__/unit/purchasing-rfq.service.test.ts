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
  it("uses product, variant, and warehouse as the durable allocation identity", () => {
    expect(purchasingSkuAllocationKey({ productId: 20, productVariantId: 30, warehouseId: 90 })).toBe("20:30:90");
    expect(purchasingSkuAllocationKey({ productId: 20, productVariantId: null, warehouseId: null })).toBe("20:base:all");
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
    const [item] = buildPurchasingRfqQueue({ items: [], skippedItems: [recommendation()] });

    expect(item.demandSnapshot).toMatchObject({
      recommendationId: "20:30:90",
      availablePieces: 12,
      onOrderPieces: 0,
      effectiveSupplyPieces: 12,
      reorderPointPieces: 108,
      suggestedOrderPieces: 96,
      generatedForLookbackDays: 90,
    });
  });
});

// ---------------------------------------------------------------------------
// Read-only RFQ tracking list (GET /api/purchasing/rfqs)
// ---------------------------------------------------------------------------

function fakeChain(rows: any[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    limit: vi.fn().mockResolvedValue(rows),
    then: (resolve: (value: any[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

describe("RFQ tracking list", () => {
  it("clamps untrusted limit values to a bounded window", () => {
    expect(parseRfqListLimit(undefined)).toBe(RFQ_LIST_DEFAULT_LIMIT);
    expect(parseRfqListLimit("")).toBe(RFQ_LIST_DEFAULT_LIMIT);
    expect(parseRfqListLimit("abc")).toBe(RFQ_LIST_DEFAULT_LIMIT);
    expect(parseRfqListLimit(0)).toBe(RFQ_LIST_DEFAULT_LIMIT);
    expect(parseRfqListLimit(-5)).toBe(RFQ_LIST_DEFAULT_LIMIT);
    expect(parseRfqListLimit("10")).toBe(10);
    expect(parseRfqListLimit(5000)).toBe(RFQ_LIST_MAX_LIMIT);
  });

  it("returns an empty page without issuing line or vendor queries", async () => {
    const headerChain = fakeChain([]);
    const dbClient = { select: vi.fn().mockReturnValueOnce(headerChain) };

    const result = await listRequestForQuotes(dbClient, { limit: "abc" });

    expect(result).toEqual({ limit: RFQ_LIST_DEFAULT_LIMIT, count: 0, statusCounts: {}, rfqs: [] });
    expect(dbClient.select).toHaveBeenCalledTimes(1);
    expect(headerChain.limit).toHaveBeenCalledWith(RFQ_LIST_DEFAULT_LIMIT);
  });

  it("lists RFQs newest-first with joined lines, vendor names, and piece totals", async () => {
    const createdA = new Date("2026-07-21T10:00:00.000Z");
    const createdB = new Date("2026-07-18T09:00:00.000Z");
    const headerChain = fakeChain([
      {
        id: 42,
        rfqNumber: "RFQ-2026-0042",
        vendorId: 7,
        status: "draft",
        requestNote: "Quote delivered pricing",
        currency: "USD",
        responseDueDate: "2026-07-30",
        createdBy: "buyer-17",
        createdAt: createdA,
        updatedAt: createdA,
        sentAt: null,
        respondedAt: null,
        cancelledAt: null,
      },
      {
        id: 41,
        rfqNumber: "RFQ-2026-0041",
        vendorId: 9,
        status: "draft",
        requestNote: null,
        currency: "USD",
        responseDueDate: null,
        createdBy: null,
        createdAt: createdB,
        updatedAt: createdB,
        sentAt: null,
        respondedAt: null,
        cancelledAt: null,
      },
    ]);
    const lineChain = fakeChain([
      {
        id: 501,
        rfqId: 42,
        recommendationLineId: 11,
        recommendationRunId: 3,
        vendorProductId: 44,
        vendorSku: "SUP-302",
        sku: "SKU-RED",
        productName: "Red Card Shell",
        status: "draft",
        requestedPieces: 96,
        recommendedPieces: 96,
        purchaseUom: "case",
        piecesPerPurchaseUom: 12,
        quantityOverrideReason: null,
        allocationOverrideReason: null,
        allocationOverrideApprovedBy: null,
        allocationOverrideApprovedAt: null,
        allocationOverrideBaselinePieces: null,
        allocationOverrideExcessPieces: null,
        quotedPieces: null,
        quotedUnitCostMills: null,
        quoteReference: null,
        quoteValidUntil: null,
        quotedAt: null,
      },
      {
        id: 502,
        rfqId: 42,
        recommendationLineId: 12,
        recommendationRunId: 3,
        vendorProductId: 45,
        vendorSku: null,
        sku: "SKU-BLUE",
        productName: "Blue Card Shell",
        status: "draft",
        requestedPieces: 125,
        recommendedPieces: 100,
        purchaseUom: null,
        piecesPerPurchaseUom: null,
        quantityOverrideReason: "Build safety stock for launch",
        allocationOverrideReason: "Build safety stock for launch",
        allocationOverrideApprovedBy: "buyer-17",
        allocationOverrideApprovedAt: createdA,
        allocationOverrideBaselinePieces: 100,
        allocationOverrideExcessPieces: 25,
        quotedPieces: null,
        quotedUnitCostMills: null,
        quoteReference: null,
        quoteValidUntil: null,
        quotedAt: null,
      },
      {
        id: 503,
        rfqId: 41,
        recommendationLineId: 13,
        recommendationRunId: 2,
        vendorProductId: 46,
        vendorSku: "ALT-9",
        sku: "SKU-GREEN",
        productName: "Green Card Shell",
        status: "draft",
        requestedPieces: 50,
        recommendedPieces: 50,
        purchaseUom: null,
        piecesPerPurchaseUom: null,
        quantityOverrideReason: null,
        allocationOverrideReason: null,
        allocationOverrideApprovedBy: null,
        allocationOverrideApprovedAt: null,
        allocationOverrideBaselinePieces: null,
        allocationOverrideExcessPieces: null,
        quotedPieces: null,
        quotedUnitCostMills: null,
        quoteReference: null,
        quoteValidUntil: null,
        quotedAt: null,
      },
    ]);
    const vendorChain = fakeChain([
      { id: 7, name: "Supply Co" },
      { id: 9, name: "Shell Works" },
    ]);
    const dbClient = {
      select: vi.fn()
        .mockReturnValueOnce(headerChain)
        .mockReturnValueOnce(lineChain)
        .mockReturnValueOnce(vendorChain),
    };

    const result = await listRequestForQuotes(dbClient, { limit: 10 });

    expect(headerChain.limit).toHaveBeenCalledWith(10);
    expect(result.limit).toBe(10);
    expect(result.count).toBe(2);
    expect(result.statusCounts).toEqual({ draft: 2 });
    expect(result.rfqs.map((rfq) => rfq.rfqNumber)).toEqual(["RFQ-2026-0042", "RFQ-2026-0041"]);

    const [first, second] = result.rfqs;
    expect(first).toMatchObject({
      id: 42,
      status: "draft",
      vendorId: 7,
      vendorName: "Supply Co",
      responseDueDate: "2026-07-30",
      lineCount: 2,
      requestedPiecesTotal: 221,
    });
    expect(first.lines[0]).toMatchObject({
      sku: "SKU-RED",
      productName: "Red Card Shell",
      vendorSku: "SUP-302",
      requestedPieces: 96,
      recommendedPieces: 96,
      status: "draft",
      quantityOverrideReason: null,
    });
    // Override evidence passes through untouched for the workbench indicators.
    expect(first.lines[1]).toMatchObject({
      quantityOverrideReason: "Build safety stock for launch",
      allocationOverrideApprovedBy: "buyer-17",
      allocationOverrideBaselinePieces: 100,
      allocationOverrideExcessPieces: 25,
    });
    expect(second).toMatchObject({
      id: 41,
      vendorName: "Shell Works",
      lineCount: 1,
      requestedPiecesTotal: 50,
    });
  });

  it("keeps an RFQ visible with a null vendor name when the vendor row is missing", async () => {
    const createdAt = new Date("2026-07-21T10:00:00.000Z");
    const dbClient = {
      select: vi.fn()
        .mockReturnValueOnce(fakeChain([{
          id: 42,
          rfqNumber: "RFQ-2026-0042",
          vendorId: 7,
          status: "sent",
          requestNote: null,
          currency: "USD",
          responseDueDate: null,
          createdBy: null,
          createdAt,
          updatedAt: createdAt,
          sentAt: createdAt,
          respondedAt: null,
          cancelledAt: null,
        }]))
        .mockReturnValueOnce(fakeChain([]))
        .mockReturnValueOnce(fakeChain([])),
    };

    const result = await listRequestForQuotes(dbClient, {});

    // A non-draft status is passed through, not masked — the page renders
    // whatever the row actually says.
    expect(result.statusCounts).toEqual({ sent: 1 });
    expect(result.rfqs[0]).toMatchObject({
      vendorName: null,
      status: "sent",
      lineCount: 0,
      requestedPiecesTotal: 0,
      lines: [],
    });
  });
});
