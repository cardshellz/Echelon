import { describe, it, expect, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for partial unique index 409 error handling.
//
// Verifies that each create function catches Postgres unique violation
// (error code 23505) and throws a domain error with status 409 instead of
// letting the 500 leak through.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../../../../platform/document-numbering/document-number.repository", () => ({
  allocateDocumentNumber: vi.fn(async () => "PAY-20260503-002"),
  readSuggestedInvoiceNumber: vi.fn(),
}));

// ── Shipment Tracking ────────────────────────────────────────────────────────

describe("createShipment atomic duplicate shipment number rejection", () => {
  async function fixture(error: unknown) {
    const { createShipmentTrackingService } = await import("../../shipment-tracking.service");
    const returning = vi.fn().mockRejectedValue(error);
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }), insert: vi.fn(() => ({ values: vi.fn(() => ({ returning })) })) };
    const database = { transaction: vi.fn(async (work: (executor: typeof tx) => Promise<unknown>) => work(tx)) };
    const storage = {} as Parameters<typeof createShipmentTrackingService>[1];
    return { service: createShipmentTrackingService(database, storage), database, tx };
  }

  it("preserves the 409 domain outcome for the active number constraint inside the transaction", async () => {
    const { service, database } = await fixture(new Error("insert failed", {
      cause: { code: "23505", constraint: "inbound_shipments_shipment_number_active_uidx" },
    }));
    await expect(service.createShipment({ shipmentNumber: "MANUAL" }, "operator")).rejects.toMatchObject({
      name: "ShipmentCreateError", code: "SHIPMENT_CREATE_NUMBER_CONFLICT", statusCode: 409,
    });
    expect(database.transaction).toHaveBeenCalledOnce();
  });

  it("rethrows unrelated persistence errors instead of calling them duplicate shipment numbers", async () => {
    const failure = new Error("connection refused");
    const { service } = await fixture(failure);
    await expect(service.createShipment({ shipmentNumber: "MANUAL" }, "operator")).rejects.toBe(failure);
  });
});

describe("recordPayment — 409 on duplicate payment number", () => {
  it("throws ApLedgerError with 409 on unique violation", async () => {
    vi.resetModules();

    // vi.mock factories are hoisted — all referenced values must be inline.
    vi.mock("../../../../db", () => {
      const makeSelectChain = () => {
        const chain: any = {};
        chain.from = vi.fn().mockReturnValue(chain);
        chain.where = vi.fn().mockReturnValue(chain);
        chain.orderBy = vi.fn().mockReturnValue(chain);
        chain.limit = vi.fn().mockResolvedValue([{ paymentNumber: "PAY-20260503-001" }]);
        chain.innerJoin = vi.fn().mockReturnValue(chain);
        chain.then = (resolve: any) => Promise.resolve([{ paymentNumber: "PAY-20260503-001" }]).then(resolve);
        return chain;
      };
      const insertChain = {
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockRejectedValue({ code: "23505", constraint: "ap_payments_payment_number_active_uidx" }),
      };
      return {
        db: {
          insert: vi.fn().mockReturnValue(insertChain),
          select: vi.fn().mockImplementation(() => makeSelectChain()),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
          transaction: vi.fn().mockImplementation(async (fn: any) => {
            const txInsertChain = {
              values: vi.fn().mockReturnThis(),
              returning: vi.fn().mockRejectedValue({ code: "23505", constraint: "ap_payments_payment_number_active_uidx" }),
            };
            return fn({
              execute: vi.fn().mockResolvedValue(undefined),
              insert: vi.fn().mockReturnValue(txInsertChain),
              select: vi.fn().mockImplementation(() => makeSelectChain()),
              update: vi.fn().mockReturnValue({
                set: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([]),
                }),
              }),
            });
          }),
        },
      };
    });

    vi.mock("@shared/schema", () => ({
      apPayments: { id: "id", paymentNumber: "paymentNumber" },
      apPaymentAllocations: { id: "id" },
      vendorInvoices: { id: "id" },
      vendorInvoiceLines: { id: "id" },
      purchaseOrders: { id: "id" },
      purchaseOrderLines: { id: "id" },
      vendors: { id: "id" },
      inboundFreightCosts: { id: "id" },
      inboundShipments: { id: "id" },
      vendorInvoicePoLinks: { id: "id" },
    }));

    vi.mock("@shared/schema/procurement.schema", () => ({}));

    const { recordPayment, ApLedgerError } = await import("../../ap-ledger.service");

    await expect(
      recordPayment({
        vendorId: 1,
        paymentDate: new Date(),
        paymentMethod: "ach",
        totalAmountCents: 10000,
        allocations: [],
      }),
    ).rejects.toMatchObject({
      name: "ApLedgerError",
      statusCode: 409,
    });
  });
});
