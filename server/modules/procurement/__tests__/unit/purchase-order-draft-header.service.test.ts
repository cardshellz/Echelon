import { describe, expect, it, vi } from "vitest";

vi.mock("../../po-exceptions.service", () => ({
  detectQtyVariance: vi.fn(),
  detectPastDue: vi.fn(),
  detectMatchMismatch: vi.fn(),
}));

import { createPurchasingService, PurchasingError } from "../../purchasing.service";

const FIXED_NOW = new Date("2026-07-11T00:30:00.000Z");

function buildDb(
  currentPo: Record<string, unknown> | null,
  options: {
    updateResult?: Record<string, unknown>[];
    eventError?: Error;
    recommendationHandoff?: Record<string, unknown> | null;
  } = {},
) {
  const updates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const lock = vi.fn().mockResolvedValue(currentPo ? [currentPo] : []);
  let selectIndex = 0;
  const select = vi.fn(() => {
    const index = selectIndex++;
    const rows = index === 0
      ? (currentPo ? [currentPo] : [])
      : (options.recommendationHandoff ? [options.recommendationHandoff] : []);
    const selectBuilder: any = {
      from: vi.fn(() => selectBuilder),
      where: vi.fn(() => selectBuilder),
      limit: vi.fn(() => selectBuilder),
      for: index === 0 ? lock : vi.fn().mockResolvedValue(rows),
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
    };
    return selectBuilder;
  });

  const tx: any = {
    select,
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        updates.push(patch);
        return {
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue(
              options.updateResult ?? [{ ...currentPo, ...patch }],
            ),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (row: Record<string, unknown>) => {
        if (options.eventError) throw options.eventError;
        events.push(row);
        return [];
      }),
    })),
  };

  const db: any = {
    transaction: vi.fn(async (work: (transaction: any) => Promise<unknown>) => work(tx)),
  };

  return { db, tx, lock, updates, events };
}

function draftPo(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    status: "draft",
    physicalStatus: "draft",
    financialStatus: "unbilled",
    priority: "normal",
    internalNotes: null,
    totalCents: 125_000,
    approvedBy: null,
    updatedBy: "previous-user",
    ...overrides,
  };
}

describe("draft purchase order header updates", () => {
  it("locks the draft and writes the edit plus immutable before/after audit in one transaction", async () => {
    const current = draftPo();
    const harness = buildDb(current);
    const service = createPurchasingService(harness.db, {} as any, {
      now: () => new Date(FIXED_NOW.getTime()),
    });

    const updated = await service.updatePO(
      42,
      { priority: "high", internalNotes: "Expedite after confirmation" },
      "user-9",
    );

    expect(harness.db.transaction).toHaveBeenCalledTimes(1);
    expect(harness.lock).toHaveBeenCalledWith("update");
    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0]).toMatchObject({
      priority: "high",
      internalNotes: "Expedite after confirmation",
      updatedBy: "user-9",
    });
    expect(harness.updates[0].updatedAt).toBeDefined();
    expect(harness.updates[0].updatedAt).not.toBeInstanceOf(Date);
    expect(harness.updates[0]).not.toHaveProperty("status");
    expect(harness.updates[0]).not.toHaveProperty("totalCents");
    expect(harness.events).toEqual([
      expect.objectContaining({
        poId: 42,
        eventType: "edited",
        actorType: "user",
        actorId: "user-9",
        payloadJson: {
          changed_fields: ["priority", "internal_notes"],
          before: { priority: "normal", internal_notes: null },
          after: { priority: "high", internal_notes: "Expedite after confirmation" },
        },
      }),
    ]);
    expect(updated).toMatchObject({ id: 42, priority: "high" });
  });

  it("is idempotent when the requested values already match", async () => {
    const current = draftPo({ priority: "high", internalNotes: "Already set" });
    const harness = buildDb(current);
    const service = createPurchasingService(harness.db, {} as any);

    const result = await service.updatePO(
      42,
      { priority: "high", internalNotes: "Already set" },
      "user-9",
    );

    expect(result).toBe(current);
    expect(harness.updates).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("rejects a non-draft PO after acquiring the row lock", async () => {
    const harness = buildDb(draftPo({ status: "sent", physicalStatus: "sent" }));
    const service = createPurchasingService(harness.db, {} as any);

    await expect(service.updatePO(42, { priority: "rush" }, "user-9")).rejects.toMatchObject({
      statusCode: 400,
      details: { code: "PO_NOT_EDITABLE", status: "sent", physicalStatus: "sent" },
    } satisfies Partial<PurchasingError>);
    expect(harness.updates).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("rejects a legacy-draft PO whose physical lifecycle has already advanced", async () => {
    const harness = buildDb(draftPo({ status: "draft", physicalStatus: "sent" }));
    const service = createPurchasingService(harness.db, {} as any);

    await expect(service.updatePO(42, { priority: "rush" }, "user-9")).rejects.toMatchObject({
      statusCode: 400,
      details: { code: "PO_NOT_EDITABLE", status: "draft", physicalStatus: "sent" },
    } satisfies Partial<PurchasingError>);
    expect(harness.updates).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("rejects header edits on a recommendation-owned draft", async () => {
    const harness = buildDb(draftPo(), {
      recommendationHandoff: { id: 501 },
    });
    const service = createPurchasingService(harness.db, {} as any);

    await expect(service.updatePO(42, { priority: "rush" }, "user-9")).rejects.toMatchObject({
      statusCode: 409,
      details: {
        code: "RECOMMENDATION_PO_HEADER_AMEND_BLOCKED",
        handoffId: 501,
      },
    } satisfies Partial<PurchasingError>);
    expect(harness.updates).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("rejects draft header edits after financial activity exists", async () => {
    const harness = buildDb(draftPo({ invoicedTotalCents: 100 }));
    const service = createPurchasingService(harness.db, {} as any);

    await expect(service.updatePO(42, { priority: "rush" }, "user-9")).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "PO_DRAFT_HAS_FINANCIAL_ACTIVITY" },
    } satisfies Partial<PurchasingError>);
    expect(harness.updates).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("returns not found without writing when the locked row does not exist", async () => {
    const harness = buildDb(null);
    const service = createPurchasingService(harness.db, {} as any);

    await expect(service.updatePO(404, { priority: "rush" }, "user-9")).rejects.toMatchObject({
      statusCode: 404,
    } satisfies Partial<PurchasingError>);
    expect(harness.updates).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("rejects protected properties from an untyped internal caller", async () => {
    const harness = buildDb(draftPo());
    const service = createPurchasingService(harness.db, {} as any, {
      now: () => new Date(FIXED_NOW.getTime()),
    });

    await expect(service.updatePO(42, {
      priority: "high",
      status: "received",
      totalCents: 1,
      approvedBy: "user-evil",
    } as any, "user-9")).rejects.toMatchObject({
      statusCode: 400,
      details: { code: "INVALID_PO_DRAFT_HEADER_PATCH" },
    } satisfies Partial<PurchasingError>);

    expect(harness.db.transaction).not.toHaveBeenCalled();
    expect(harness.updates).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("fails the transaction when the audit event cannot be written", async () => {
    const harness = buildDb(draftPo(), { eventError: new Error("audit insert failed") });
    const service = createPurchasingService(harness.db, {} as any, {
      now: () => new Date(FIXED_NOW.getTime()),
    });

    await expect(service.updatePO(42, { priority: "high" }, "user-9"))
      .rejects.toThrow("audit insert failed");
    expect(harness.db.transaction).toHaveBeenCalledTimes(1);
  });

  it("reports a conflict if the guarded draft update affects no row", async () => {
    const harness = buildDb(draftPo(), { updateResult: [] });
    const service = createPurchasingService(harness.db, {} as any, {
      now: () => new Date(FIXED_NOW.getTime()),
    });

    await expect(service.updatePO(42, { priority: "high" }, "user-9")).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "PO_DRAFT_EDIT_CONFLICT" },
    } satisfies Partial<PurchasingError>);
    expect(harness.events).toEqual([]);
  });
});
