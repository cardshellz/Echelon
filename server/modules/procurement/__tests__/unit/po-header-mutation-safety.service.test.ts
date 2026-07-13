import { describe, expect, it, vi } from "vitest";

vi.mock("../../po-exceptions.service", () => ({
  detectQtyVariance: vi.fn(),
  detectPastDue: vi.fn(),
  detectMatchMismatch: vi.fn(),
}));

import { createPurchasingService, PurchasingError } from "../../purchasing.service";

function buildDb(
  selectResults: any[][],
  options: {
    updateResult?: any[];
    insertError?: Error;
  } = {},
) {
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  const lockModes: string[] = [];
  let selectIndex = 0;
  const tx: any = {
    select: vi.fn(() => {
      const rows = selectResults[selectIndex++] ?? [];
      const chain: any = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        for: vi.fn(async (mode: string) => {
          lockModes.push(mode);
          return rows;
        }),
        then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    }),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        updates.push(patch);
        return {
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue(
              options.updateResult ?? [{ ...selectResults[0]?.[0], ...patch }],
            ),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (row: Record<string, unknown>) => {
        if (options.insertError) throw options.insertError;
        inserts.push(row);
        return [];
      }),
    })),
  };
  const db: any = {
    transaction: vi.fn(async (work: (transaction: any) => Promise<unknown>) => work(tx)),
  };
  return { db, tx, updates, inserts, lockModes };
}

function cleanDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: 70,
    status: "draft",
    physicalStatus: "draft",
    financialStatus: "unbilled",
    invoicedTotalCents: 0,
    paidTotalCents: 0,
    incoterms: "FOB",
    discountCents: 100,
    taxCents: 50,
    shippingCostCents: 25,
    overReceiptTolerancePct: "0",
    subtotalCents: 1,
    totalCents: 1,
    updatedAt: new Date("2026-07-13T12:00:00.000Z"),
    ...overrides,
  };
}

describe("PO header mutation safety", () => {
  it("locks a clean draft and recomputes charge totals with an atomic audit event", async () => {
    const po = cleanDraft();
    const lines = [
      { id: 701, status: "open", lineTotalCents: 12_345 },
      { id: 702, status: "received", lineTotalCents: 655 },
    ];
    const harness = buildDb([[po], [], lines]);
    const service = createPurchasingService(harness.db, {} as any);

    const result = await service.updateIncotermsAndCharges(70, {
      incoterms: "DDP",
      discountCents: 200,
      taxCents: 100,
      shippingCostCents: 300,
      overReceiptTolerancePct: 5.5,
    }, "buyer-1");

    expect(harness.db.transaction).toHaveBeenCalledTimes(1);
    expect(harness.lockModes).toEqual(["update", "update"]);
    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0]).toMatchObject({
      incoterms: "DDP",
      discountCents: 200,
      taxCents: 100,
      shippingCostCents: 300,
      overReceiptTolerancePct: "5.5",
      subtotalCents: 13_000,
      totalCents: 13_200,
      lineCount: 2,
      receivedLineCount: 1,
      updatedBy: "buyer-1",
    });
    expect(harness.inserts).toEqual([
      expect.objectContaining({
        poId: 70,
        eventType: "incoterms_charges_updated",
        actorType: "user",
        actorId: "buyer-1",
        payloadJson: expect.objectContaining({
          changed_fields: [
            "incoterms",
            "discount_cents",
            "tax_cents",
            "shipping_cost_cents",
            "over_receipt_tolerance_pct",
          ],
          before: expect.objectContaining({ subtotal_cents: 1, total_cents: 1 }),
          after: expect.objectContaining({ subtotal_cents: 13_000, total_cents: 13_200 }),
        }),
      }),
    ]);
    expect(result).toMatchObject({ id: 70, totalCents: 13_200 });
  });

  it("blocks every economic header edit after the draft lifecycle", async () => {
    const po = cleanDraft({ status: "approved" });
    const harness = buildDb([[po]]);
    const service = createPurchasingService(harness.db, {} as any);

    await expect(service.updateIncotermsAndCharges(70, {
      shippingCostCents: 500,
    }, "buyer-1")).rejects.toMatchObject({
      statusCode: 400,
      details: expect.objectContaining({ code: "PO_NOT_EDITABLE", status: "approved" }),
    } satisfies Partial<PurchasingError>);
    expect(harness.updates).toEqual([]);
    expect(harness.inserts).toEqual([]);
  });

  it("blocks economic header edits on a recommendation-owned PO", async () => {
    const harness = buildDb([[cleanDraft()], [{ id: 901 }]]);
    const service = createPurchasingService(harness.db, {} as any);

    await expect(service.updateIncotermsAndCharges(70, {
      taxCents: 75,
    }, "buyer-1")).rejects.toMatchObject({
      statusCode: 409,
      details: {
        code: "RECOMMENDATION_PO_HEADER_AMEND_BLOCKED",
        handoffId: 901,
      },
    } satisfies Partial<PurchasingError>);
    expect(harness.updates).toEqual([]);
    expect(harness.inserts).toEqual([]);
  });

  it("does not write an audit event when the guarded charge update loses its CAS", async () => {
    const harness = buildDb([
      [cleanDraft()],
      [],
      [{ id: 701, status: "open", lineTotalCents: 10_000 }],
    ], { updateResult: [] });
    const service = createPurchasingService(harness.db, {} as any);

    await expect(service.updateIncotermsAndCharges(70, {
      taxCents: 75,
    }, "buyer-1")).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "PO_DRAFT_EDIT_CONFLICT" },
    } satisfies Partial<PurchasingError>);
    expect(harness.inserts).toEqual([]);
  });

  it("validates charge precision before opening a transaction", async () => {
    const harness = buildDb([]);
    const service = createPurchasingService(harness.db, {} as any);

    await expect(service.updateIncotermsAndCharges(70, {
      shippingCostCents: -1,
    }, "buyer-1")).rejects.toMatchObject({
      statusCode: 400,
      details: expect.objectContaining({
        code: "INVALID_PO_HEADER_CHARGES_PATCH",
        field: "shippingCostCents",
      }),
    } satisfies Partial<PurchasingError>);
    expect(harness.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects a header discount that would make the locked PO total negative", async () => {
    const harness = buildDb([
      [cleanDraft({ taxCents: 0, shippingCostCents: 0 })],
      [],
      [{ id: 701, status: "open", lineTotalCents: 100 }],
    ]);
    const service = createPurchasingService(harness.db, {} as any);

    await expect(service.updateIncotermsAndCharges(70, {
      discountCents: 101,
    }, "buyer-1")).rejects.toMatchObject({
      statusCode: 400,
      details: {
        code: "PO_TOTAL_NEGATIVE",
        subtotalCents: 100,
        discountCents: 101,
        taxCents: 0,
        shippingCostCents: 0,
      },
    } satisfies Partial<PurchasingError>);
    expect(harness.updates).toEqual([]);
    expect(harness.inserts).toEqual([]);
  });

  it("keeps operational delivery scheduling available and locked after send", async () => {
    const po = cleanDraft({
      status: "sent",
      physicalStatus: "sent",
      sentToVendorAt: new Date("2026-07-01T12:00:00.000Z"),
      orderDate: new Date("2026-07-01T12:00:00.000Z"),
      expectedDeliveryDate: null,
      confirmedDeliveryDate: null,
    });
    const harness = buildDb([[po]]);
    const service = createPurchasingService(harness.db, {} as any);
    const confirmedDeliveryDate = new Date("2026-07-20T00:00:00.000Z");

    await service.updateDeliverySchedule(70, {
      confirmedDeliveryDate,
      notes: "Vendor confirmed",
    }, "buyer-1");

    expect(harness.lockModes).toEqual(["update"]);
    expect(harness.updates[0]).toMatchObject({ confirmedDeliveryDate, updatedBy: "buyer-1" });
    expect(harness.inserts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        purchaseOrderId: 70,
        fromStatus: "sent",
        toStatus: "sent",
      }),
      expect.objectContaining({
        poId: 70,
        eventType: "delivery_schedule_updated",
      }),
    ]));
  });

  it("does not audit a delivery schedule update that loses its CAS", async () => {
    const po = cleanDraft({
      status: "sent",
      physicalStatus: "sent",
      sentToVendorAt: new Date("2026-07-01T12:00:00.000Z"),
      orderDate: new Date("2026-07-01T12:00:00.000Z"),
      expectedDeliveryDate: null,
      confirmedDeliveryDate: null,
    });
    const harness = buildDb([[po]], { updateResult: [] });
    const service = createPurchasingService(harness.db, {} as any);

    await expect(service.updateDeliverySchedule(70, {
      expectedDeliveryDate: new Date("2026-07-20T00:00:00.000Z"),
    }, "buyer-1")).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "PO_DELIVERY_SCHEDULE_CONFLICT" },
    } satisfies Partial<PurchasingError>);
    expect(harness.inserts).toEqual([]);
  });

  it("propagates an audit insert failure so the enclosing transaction rolls back", async () => {
    const harness = buildDb([
      [cleanDraft()],
      [],
      [{ id: 701, status: "open", lineTotalCents: 10_000 }],
    ], { insertError: new Error("audit unavailable") });
    const service = createPurchasingService(harness.db, {} as any);

    await expect(service.updateIncotermsAndCharges(70, {
      taxCents: 75,
    }, "buyer-1")).rejects.toThrow("audit unavailable");
    expect(harness.db.transaction).toHaveBeenCalledTimes(1);
  });
});
