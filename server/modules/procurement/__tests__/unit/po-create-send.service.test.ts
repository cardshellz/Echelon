import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPurchasingService, PurchasingError } from "../../purchasing.service";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for Spec A service methods.
//
// These cover boundary validation and status-gating — the logic that protects
// the system from bad input. The full transactional create/send flows are
// exercised by integration tests (a separate tier) against a real database.
// Here we verify:
//   1. createPurchaseOrderWithLines rejects invalid input before touching db.
//   2. sendPurchaseOrder rejects POs not in draft/approved state.
//   3. duplicatePurchaseOrder handles missing / line-less source POs.
//   4. updateProcurementSetting whitelists keys and enforces boolean type.
//   5. emitPoEvent resolves the actor correctly (user vs system:auto).
// ─────────────────────────────────────────────────────────────────────────────

function buildMockDb() {
  // Minimal db mock: every .insert/.update/.select returns a fluent chain that
  // resolves to an empty array. Only called from emitPoEvent + getSettings
  // fallback paths in our tests.
  const insertBuilder = {
    values: vi.fn().mockResolvedValue([]),
  };
  const selectBuilder: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
  return {
    insert: vi.fn().mockReturnValue(insertBuilder),
    select: vi.fn().mockReturnValue(selectBuilder),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    transaction: vi.fn(async (fn: any) => fn({ insert: vi.fn().mockReturnValue(insertBuilder), update: vi.fn(), select: vi.fn() })),
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
    getVendorById: vi.fn(),
    getProductVariantById: vi.fn(),
    getProductById: vi.fn(),
    createReceivingOrder: vi.fn(),
    generateReceiptNumber: vi.fn(),
    bulkCreateReceivingLines: vi.fn(),
    getSetting: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as any;
}

describe("Spec A — createPurchaseOrderWithLines validation", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;

  beforeEach(() => {
    storage = buildMockStorage();
    svc = createPurchasingService(buildMockDb(), storage);
  });

  it("rejects missing vendor_id", async () => {
    await expect(
      svc.createPurchaseOrderWithLines({
        vendorId: 0,
        lines: [{ productVariantId: 1, orderQty: 1, unitCostCents: 100 }],
      } as any),
    ).rejects.toThrow(/vendor_id is required/);
  });

  it("rejects empty lines array", async () => {
    await expect(
      svc.createPurchaseOrderWithLines({ vendorId: 1, lines: [] } as any),
    ).rejects.toThrow(/At least one line is required/);
  });

  it("rejects negative quantity", async () => {
    await expect(
      svc.createPurchaseOrderWithLines({
        vendorId: 1,
        lines: [{ productVariantId: 1, orderQty: -5, unitCostCents: 100 }],
      } as any),
    ).rejects.toThrow(/must be > 0/);
  });

  it("rejects non-integer unit cost (floating point guard)", async () => {
    await expect(
      svc.createPurchaseOrderWithLines({
        vendorId: 1,
        lines: [{ productVariantId: 1, orderQty: 1, unitCostCents: 10.5 }],
      } as any),
    ).rejects.toThrow(/must be an integer/);
  });

  it("404s when vendor does not exist", async () => {
    storage.getVendorById.mockResolvedValue(null);
    await expect(
      svc.createPurchaseOrderWithLines({
        vendorId: 999,
        lines: [{ productVariantId: 1, orderQty: 1, unitCostCents: 100 }],
      } as any),
    ).rejects.toThrow(/Vendor not found/);
  });
});

describe("Spec A — sendPurchaseOrder status gate", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;

  beforeEach(() => {
    storage = buildMockStorage();
    svc = createPurchasingService(buildMockDb(), storage);
  });

  it("404s when PO not found", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(null);
    await expect(svc.sendPurchaseOrder(1, "u1")).rejects.toThrow(/not found/);
  });

  it("rejects PO already sent", async () => {
    storage.getPurchaseOrderById.mockResolvedValue({ id: 1, status: "sent" });
    await expect(svc.sendPurchaseOrder(1, "u1")).rejects.toThrow(
      /Cannot send PO in 'sent' status/,
    );
  });

  it("rejects PO with no active lines", async () => {
    storage.getPurchaseOrderById.mockResolvedValue({ id: 1, status: "draft" });
    storage.getPurchaseOrderLines.mockResolvedValue([
      { orderQty: 0, status: "open" },
      { orderQty: 10, status: "cancelled" },
    ]);
    await expect(svc.sendPurchaseOrder(1, "u1")).rejects.toThrow(
      /at least one line with quantity > 0/,
    );
  });
});

describe("Spec A — duplicatePurchaseOrder", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let storage: ReturnType<typeof buildMockStorage>;

  beforeEach(() => {
    storage = buildMockStorage();
    svc = createPurchasingService(buildMockDb(), storage);
  });

  it("404s when source PO missing", async () => {
    storage.getPurchaseOrderById.mockResolvedValue(null);
    await expect(svc.duplicatePurchaseOrder(1, undefined, "u1")).rejects.toThrow(
      /Source purchase order not found/,
    );
  });

  it("rejects when source has no lines", async () => {
    storage.getPurchaseOrderById.mockResolvedValue({ id: 1, vendorId: 1, poNumber: "PO-X" });
    storage.getPurchaseOrderLines.mockResolvedValue([]);
    await expect(svc.duplicatePurchaseOrder(1, undefined, "u1")).rejects.toThrow(
      /no lines to duplicate/,
    );
  });

  it("rejects when source has only cancelled lines", async () => {
    storage.getPurchaseOrderById.mockResolvedValue({
      id: 1,
      vendorId: 1,
      poNumber: "PO-X",
      poType: "standard",
      priority: "normal",
    });
    storage.getPurchaseOrderLines.mockResolvedValue([
      { status: "cancelled", productVariantId: 1, productId: 1, orderQty: 5, unitCostCents: 100 },
    ]);
    await expect(svc.duplicatePurchaseOrder(1, undefined, "u1")).rejects.toThrow(
      /no active lines to duplicate/,
    );
  });
});

describe("Spec A — updateProcurementSetting", () => {
  let svc: ReturnType<typeof createPurchasingService>;

  beforeEach(() => {
    svc = createPurchasingService(buildMockDb(), buildMockStorage());
  });

  it("rejects unknown keys", async () => {
    await expect(
      svc.updateProcurementSetting("not_a_real_key", true as any, "u1"),
    ).rejects.toThrow(/Unknown procurement setting/);
  });

  it("rejects non-boolean values", async () => {
    await expect(
      svc.updateProcurementSetting("requireApproval", "yes" as any, "u1"),
    ).rejects.toThrow(/must be a boolean/);
  });

  it("accepts whitelisted key + boolean value", async () => {
    // Will hit the mock db.update chain and return empty array; the follow-up
    // getProcurementSettings() falls through to defaults. No throw = pass.
    await expect(
      svc.updateProcurementSetting("requireApproval", true, "u1"),
    ).resolves.toBeDefined();
  });
});

describe("Spec A — emitPoEvent actor resolution", () => {
  let svc: ReturnType<typeof createPurchasingService>;
  let db: ReturnType<typeof buildMockDb>;

  beforeEach(() => {
    db = buildMockDb();
    svc = createPurchasingService(db, buildMockStorage());
  });

  it("uses provided userId as 'user' actor", async () => {
    await svc.emitPoEvent(42, "created", "user-abc", { hello: "world" });
    const insertCall = (db.insert as any).mock.results[0].value.values.mock.calls[0][0];
    expect(insertCall.actorType).toBe("user");
    expect(insertCall.actorId).toBe("user-abc");
    expect(insertCall.eventType).toBe("created");
    expect(insertCall.poId).toBe(42);
    expect(insertCall.payloadJson).toEqual({ hello: "world" });
  });

  it("falls back to 'system:auto' when no userId", async () => {
    await svc.emitPoEvent(7, "sent_to_vendor", null);
    const insertCall = (db.insert as any).mock.results[0].value.values.mock.calls[0][0];
    expect(insertCall.actorType).toBe("system");
    expect(insertCall.actorId).toBe("system:auto");
  });
});

// Keep a guard that PurchasingError stays an Error subclass — callers switch
// on instanceof to map 4xx responses.
describe("Spec A — error envelope", () => {
  it("PurchasingError is still an Error subclass", () => {
    const err = new PurchasingError("boom", 418, { x: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(418);
    expect(err.details).toEqual({ x: 1 });
  });
});
