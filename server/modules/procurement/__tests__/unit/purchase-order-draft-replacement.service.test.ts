import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  poEvents,
  products,
  productVariants,
  purchaseOrderLines,
  purchaseOrders,
  purchasingRecommendationPoHandoffs,
  vendorProducts,
  vendors,
} from "@shared/schema";
import {
  createPurchasingService,
  type UpdateDraftPurchaseOrderWithLinesInput,
} from "../../purchasing.service";

const FIXED_NOW = new Date("2026-07-11T01:00:00.000Z");
const CURRENT_VERSION = new Date("2026-07-11T00:30:00.000Z");

function draftPo(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    poNumber: "PO-20260711-001",
    vendorId: 1,
    warehouseId: 2,
    status: "draft",
    physicalStatus: "draft",
    financialStatus: "unbilled",
    poType: "standard",
    priority: "normal",
    expectedDeliveryDate: null,
    incoterms: null,
    vendorNotes: null,
    internalNotes: null,
    currency: "USD",
    paymentTermsDays: 30,
    paymentTermsType: "net",
    shipFromAddress: "Old address",
    subtotalCents: 2_000,
    discountCents: 100,
    taxCents: 50,
    shippingCostCents: 25,
    totalCents: 1_975,
    lineCount: 2,
    receivedLineCount: 0,
    invoicedTotalCents: 0,
    paidTotalCents: 0,
    updatedAt: CURRENT_VERSION,
    ...overrides,
  };
}

function existingLine(id: number, lineNumber: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    purchaseOrderId: 42,
    lineNumber,
    productId: 7,
    productVariantId: 70,
    expectedReceiveVariantId: 70,
    expectedReceiveUnitsPerVariant: 100,
    vendorProductId: null,
    sku: "SKU-7",
    productName: "Product 7",
    description: null,
    unitOfMeasure: "pack",
    unitsPerUom: 100,
    orderQty: 10,
    receivedQty: 0,
    damagedQty: 0,
    returnedQty: 0,
    cancelledQty: 0,
    unitCostCents: 100,
    unitCostMills: 10_000,
    totalProductCostCents: 1_000,
    packagingCostCents: 0,
    discountCents: 0,
    taxCents: 0,
    lineTotalCents: 1_000,
    lineType: "product",
    parentLineId: null,
    status: "open",
    ...overrides,
  };
}

function updateInput(
  overrides: Partial<UpdateDraftPurchaseOrderWithLinesInput> = {},
): UpdateDraftPurchaseOrderWithLinesInput {
  return {
    vendorId: 1,
    warehouseId: 2,
    poType: "standard",
    priority: "high",
    expectedDeliveryDate: new Date("2026-08-01T00:00:00.000Z"),
    incoterms: "FOB",
    vendorNotes: "Vendor note",
    internalNotes: "Internal note",
    expectedUpdatedAt: CURRENT_VERSION,
    lines: [
      {
        lineId: 10,
        clientId: "product-10",
        lineType: "product",
        productId: 7,
        productVariantId: 70,
        expectedReceiveVariantId: 70,
        expectedReceiveUnitsPerVariant: 100,
        orderQty: 10,
        totalProductCostCents: 1_000,
        packagingCostCents: 100,
      },
      {
        clientId: "fee-new",
        lineType: "fee",
        description: "Tooling",
        orderQty: 1,
        unitCostMills: 250_000,
      },
      {
        clientId: "discount-new",
        parentClientId: "product-10",
        lineType: "discount",
        description: "Product allowance",
        orderQty: 1,
        unitCostMills: -5_000,
      },
    ],
    ...overrides,
  };
}

function buildStorage() {
  return {
    getVendorById: vi.fn().mockResolvedValue({
      id: 1,
      currency: "USD",
      paymentTermsDays: 45,
      paymentTermsType: "net",
      shipFromAddress: "New address",
    }),
    getProductById: vi.fn().mockResolvedValue({
      id: 7,
      sku: "SKU-7",
      name: "Product 7",
    }),
    getProductVariantById: vi.fn().mockResolvedValue({
      id: 70,
      productId: 7,
      sku: "SKU-7-P100",
      name: "Pack of 100",
      unitsPerVariant: 100,
    }),
    getVendorProductById: vi.fn(),
  } as any;
}

type HarnessOptions = {
  currentPo?: Record<string, unknown> | null;
  existingLines?: Record<string, unknown>[];
  vendorProductRows?: Record<string, unknown>[];
  eventError?: Error;
  downstreamRows?: Array<{ line_id: number; blocker: string }>;
};

function buildDb(options: HarnessOptions = {}) {
  const currentPo = options.currentPo === undefined ? draftPo() : options.currentPo;
  const currentLines = options.existingLines ?? [existingLine(10, 1), existingLine(11, 2)];
  const updates: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
  const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  let nextLineId = 99;

  const rowsFor = (table: unknown) => {
    if (table === purchaseOrders) return currentPo ? [currentPo] : [];
    if (table === purchasingRecommendationPoHandoffs) return [];
    if (table === purchaseOrderLines) return currentLines;
    if (table === vendors) {
      return [{
        id: 1,
        active: 1,
        currency: "USD",
        paymentTermsDays: 45,
        paymentTermsType: "net",
        shipFromAddress: "New address",
      }];
    }
    if (table === products) {
      return [{ id: 7, sku: "SKU-7", name: "Product 7", isActive: true }];
    }
    if (table === productVariants) {
      return [{
        id: 70,
        productId: 7,
        sku: "SKU-7-P100",
        name: "Pack of 100",
        unitsPerVariant: 100,
        isActive: true,
      }];
    }
    if (table === vendorProducts) return options.vendorProductRows ?? [];
    return [];
  };

  const tx: any = {
    execute: vi.fn().mockResolvedValue({ rows: options.downstreamRows ?? [] }),
    select: vi.fn(() => {
      let table: unknown;
      const builder: any = {
        from: vi.fn((nextTable: unknown) => {
          table = nextTable;
          return builder;
        }),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        for: vi.fn(async () => rowsFor(table)),
        then: (
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(rowsFor(table)).then(resolve, reject),
      };
      return builder;
    }),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        updates.push({ table, patch });
        const builder: any = {
          where: vi.fn(() => builder),
          returning: vi.fn(async () => {
            if (table === purchaseOrders) {
              return currentPo ? [{ ...currentPo, ...patch }] : [];
            }
            if (table === purchaseOrderLines) {
              if (patch.status === "cancelled") {
                return [{ ...currentLines[1], ...patch }];
              }
              const lineNumber = Number(patch.lineNumber);
              const current = currentLines.find(
                (line) => Number(line.lineNumber) === lineNumber,
              );
              return current ? [{ ...current, ...patch }] : [];
            }
            return [];
          }),
        };
        return builder;
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        inserts.push({ table, value });
        if (table === poEvents) {
          if (options.eventError) return Promise.reject(options.eventError);
          return Promise.resolve([]);
        }
        const builder = {
          returning: vi.fn(async () => {
            const id = nextLineId++;
            return [{ id, ...value }];
          }),
        };
        return builder;
      }),
    })),
  };

  const db = {
    transaction: vi.fn(async (work: (transaction: any) => Promise<unknown>) => work(tx)),
  } as any;

  return { db, tx, updates, inserts };
}

describe("draft PO full replacement", () => {
  let storage: ReturnType<typeof buildStorage>;

  beforeEach(() => {
    storage = buildStorage();
  });

  it("preserves retained line identity, cancels removals, inserts additions, and reconciles totals", async () => {
    const harness = buildDb();
    const service = createPurchasingService(harness.db, storage, {
      now: () => new Date(FIXED_NOW.getTime()),
    });

    const result = await service.updateDraftPurchaseOrderWithLines(
      42,
      updateInput(),
      "user-9",
    );

    const linePatches = harness.updates
      .filter((entry) => entry.table === purchaseOrderLines)
      .map((entry) => entry.patch);
    expect(linePatches).toContainEqual(
      expect.objectContaining({
        status: "cancelled",
        cancelledQty: 10,
        parentLineId: null,
        updatedAt: FIXED_NOW,
      }),
    );
    expect(linePatches).toContainEqual(
      expect.objectContaining({
        lineNumber: 1,
        orderQty: 10,
        lineTotalCents: 1_100,
        status: "open",
      }),
    );
    expect(linePatches).toContainEqual(
      expect.objectContaining({
        parentLineId: 10,
        updatedAt: FIXED_NOW,
      }),
    );

    const headerPatch = harness.updates.find(
      (entry) => entry.table === purchaseOrders,
    )?.patch;
    expect(headerPatch).toMatchObject({
      subtotalCents: 3_550,
      totalCents: 3_525,
      lineCount: 3,
      receivedLineCount: 0,
      updatedBy: "user-9",
      updatedAt: FIXED_NOW,
    });
    expect(result.po).toMatchObject({ id: 42, subtotalCents: 3_550, totalCents: 3_525 });
    expect(result.lines.map((line) => line.id)).toEqual([10, 99, 100]);
    expect(result.lines.map((line) => line.clientId)).toEqual([
      "product-10",
      "fee-new",
      "discount-new",
    ]);

    const event = harness.inserts.find((entry) => entry.table === poEvents)?.value as any;
    expect(event).toMatchObject({
      poId: 42,
      eventType: "edited",
      actorType: "user",
      actorId: "user-9",
      payloadJson: {
        source: "inline_editor",
        added_line_ids: [99, 100],
        cancelled_line_ids: [11],
      },
    });
    expect(event.payloadJson.before.lines).toHaveLength(2);
    expect(event.payloadJson.after.lines).toHaveLength(3);
  });

  it("rejects a stale version before changing any rows", async () => {
    const harness = buildDb();
    const service = createPurchasingService(harness.db, storage);

    await expect(
      service.updateDraftPurchaseOrderWithLines(
        42,
        updateInput({ expectedUpdatedAt: new Date("2026-07-10T00:00:00.000Z") }),
        "user-9",
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "PO_DRAFT_EDIT_STALE" },
    });
    expect(harness.updates).toEqual([]);
    expect(harness.inserts).toEqual([]);
  });

  it("rejects a PO whose physical lifecycle is no longer draft", async () => {
    const harness = buildDb({
      currentPo: draftPo({ status: "sent", physicalStatus: "sent" }),
    });
    const service = createPurchasingService(harness.db, storage);

    await expect(
      service.updateDraftPurchaseOrderWithLines(42, updateInput(), "user-9"),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: {
        code: "PO_NOT_EDITABLE",
        status: "sent",
        physicalStatus: "sent",
      },
    });
    expect(harness.updates).toEqual([]);
  });

  it("rejects a nominal draft after financial activity exists", async () => {
    const harness = buildDb({
      currentPo: draftPo({ invoicedTotalCents: 500 }),
    });
    const service = createPurchasingService(harness.db, storage);

    await expect(
      service.updateDraftPurchaseOrderWithLines(42, updateInput(), "user-9"),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "PO_DRAFT_HAS_FINANCIAL_ACTIVITY" },
    });
    expect(harness.updates).toEqual([]);
  });

  it("rejects a line id that does not belong to the active PO", async () => {
    const harness = buildDb();
    const service = createPurchasingService(harness.db, storage);
    const input = updateInput({
      lines: [
        {
          lineId: 999,
          clientId: "foreign-line",
          lineType: "product",
          productId: 7,
          productVariantId: 70,
          orderQty: 1,
          totalProductCostCents: 100,
        },
      ],
    });

    await expect(
      service.updateDraftPurchaseOrderWithLines(42, input, "user-9"),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "PO_DRAFT_LINE_OWNERSHIP", line_id: 999 },
    });
    expect(harness.updates).toEqual([]);
    expect(harness.inserts).toEqual([]);
  });

  it("rejects line replacement after receiving activity", async () => {
    const harness = buildDb({
      existingLines: [existingLine(10, 1, { receivedQty: 1 })],
    });
    const service = createPurchasingService(harness.db, storage);

    await expect(
      service.updateDraftPurchaseOrderWithLines(42, updateInput(), "user-9"),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "PO_DRAFT_LINE_HAS_ACTIVITY", line_id: 10 },
    });
    expect(harness.updates).toEqual([]);
  });

  it("rejects line replacement when downstream records exist despite clean counters", async () => {
    const harness = buildDb({
      downstreamRows: [{ line_id: 10, blocker: "vendor_invoice_lines" }],
    });
    const service = createPurchasingService(harness.db, storage);

    await expect(
      service.updateDraftPurchaseOrderWithLines(42, updateInput(), "user-9"),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: {
        code: "PO_DRAFT_LINE_DOWNSTREAM_LINKS",
        blockers: [{ lineId: 10, blocker: "vendor_invoice_lines" }],
      },
    });
    expect(harness.updates).toEqual([]);
    expect(harness.inserts).toEqual([]);
  });

  it("rejects client-forged recommendation provenance before DB access", async () => {
    const harness = buildDb();
    const service = createPurchasingService(harness.db, storage);
    const input = updateInput({
      lines: [{
        lineId: 10,
        lineType: "product",
        productId: 7,
        productVariantId: 70,
        expectedReceiveVariantId: 70,
        expectedReceiveUnitsPerVariant: 100,
        orderQty: 10,
        pricing: {
          basis: "per_piece",
          quantityPieces: 10,
          unitCostMills: 10_000,
        },
        pricingSource: "recommendation",
      }],
    });

    await expect(
      service.updateDraftPurchaseOrderWithLines(42, input, "user-9"),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { code: "PO_LINE_PRICING_SOURCE_FORBIDDEN" },
    });
    expect(harness.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects a materially future-dated manual quote before DB access", async () => {
    const harness = buildDb();
    const service = createPurchasingService(harness.db, storage, {
      now: () => new Date(FIXED_NOW.getTime()),
    });

    await expect(
      service.updateDraftPurchaseOrderWithLines(42, updateInput({
        lines: [{
          lineId: 10,
          lineType: "product",
          productId: 7,
          productVariantId: 70,
          expectedReceiveVariantId: 70,
          expectedReceiveUnitsPerVariant: 100,
          orderQty: 10,
          pricing: {
            basis: "per_piece",
            quantityPieces: 10,
            unitCostMills: 10_000,
          },
          pricingSource: "manual",
          quotedAt: new Date("2026-07-12T00:00:00.000Z"),
        }],
      }), "user-9"),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: { code: "PO_LINE_QUOTED_AT_IN_FUTURE", lineIndex: 0 },
    });
    expect(harness.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects an expired or stale catalog quote again under the transaction lock", async () => {
    const catalogRow = {
      id: 501,
      vendorId: 1,
      productId: 7,
      productVariantId: 70,
      isActive: 1,
      pricingBasis: "per_piece",
      quotedUnitCostMills: 10_000,
      unitCostMills: 10_000,
      unitCostCents: 100,
      quoteReference: "Q-OLD",
      quotedAt: new Date("2024-01-01T00:00:00.000Z"),
      quoteValidUntil: null,
    };
    storage.getVendorProductById.mockResolvedValue(catalogRow);
    const harness = buildDb({ vendorProductRows: [catalogRow] });
    const service = createPurchasingService(harness.db, storage, {
      now: () => new Date(FIXED_NOW.getTime()),
    });

    await expect(
      service.updateDraftPurchaseOrderWithLines(
        42,
        updateInput({
          lines: [{
            lineId: 10,
            clientId: "product-10",
            lineType: "product",
            productId: 7,
            productVariantId: 70,
            expectedReceiveVariantId: 70,
            expectedReceiveUnitsPerVariant: 100,
            vendorProductId: 501,
            orderQty: 10,
            pricingSource: "vendor_catalog",
            pricing: {
              basis: "per_piece",
              quantityPieces: 10,
              unitCostMills: 10_000,
            },
          }],
        }),
        "user-9",
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "PO_LINE_VENDOR_CATALOG_QUOTE_STALE", vendorProductId: 501 },
    });
    expect(harness.updates).toEqual([]);
    expect(harness.inserts).toEqual([]);
  });

  it("advances the draft version even when the injected clock has not moved", async () => {
    const harness = buildDb({ existingLines: [] });
    const service = createPurchasingService(harness.db, storage, {
      now: () => new Date(CURRENT_VERSION.getTime()),
    });
    const input = updateInput({
      lines: [{
        clientId: "fee-new",
        lineType: "fee",
        description: "Tooling",
        orderQty: 1,
        unitCostMills: 250_000,
      }],
    });

    const result = await service.updateDraftPurchaseOrderWithLines(42, input, "user-9");
    expect(new Date(result.po.updatedAt).getTime()).toBe(CURRENT_VERSION.getTime() + 1);
  });

  it("fails the transaction when the immutable audit event cannot be written", async () => {
    const harness = buildDb({ eventError: new Error("audit insert failed") });
    const service = createPurchasingService(harness.db, storage, {
      now: () => new Date(FIXED_NOW.getTime()),
    });

    await expect(
      service.updateDraftPurchaseOrderWithLines(42, updateInput(), "user-9"),
    ).rejects.toThrow("audit insert failed");
    expect(harness.db.transaction).toHaveBeenCalledTimes(1);
  });
});
