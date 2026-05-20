import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoiceRows, mockTxUpdate, mockDetectionHooks } = vi.hoisted(() => ({
  mockInvoiceRows: { rows: [] as any[] },
  mockTxUpdate: vi.fn(),
  mockDetectionHooks: {
    detectMatchMismatch: vi.fn(),
    detectOverpaid: vi.fn(),
    detectPastDue: vi.fn(),
  },
}));

vi.mock("../../../../db", () => ({
  db: {
    transaction: vi.fn(async (fn: any) => {
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(async () => mockInvoiceRows.rows),
          })),
        })),
        update: mockTxUpdate,
        insert: vi.fn(),
      };
      return fn(tx);
    }),
  },
}));

vi.mock("@shared/schema", () => ({
  vendorInvoices: {
    id: "vendorInvoices.id",
    status: "vendorInvoices.status",
  },
  vendorInvoicePoLinks: {
    purchaseOrderId: "vendorInvoicePoLinks.purchaseOrderId",
    vendorInvoiceId: "vendorInvoicePoLinks.vendorInvoiceId",
  },
  vendorInvoiceLines: {},
  vendorInvoiceAttachments: {},
  apPayments: {},
  apPaymentAllocations: {},
  purchaseOrders: {},
  purchaseOrderLines: {},
  vendors: {},
  inboundFreightCosts: {},
  inboundShipments: {},
  auditEvents: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((left: any, right: any) => ({ left, right })),
  and: vi.fn(),
  inArray: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  lt: vi.fn(),
  lte: vi.fn(),
  gte: vi.fn(),
  ne: vi.fn(),
  asc: vi.fn(),
  like: vi.fn(),
}));

vi.mock("../../po-exceptions.service", () => mockDetectionHooks);

import { approveInvoice } from "../../ap-ledger.service";

describe("approveInvoice", () => {
  beforeEach(() => {
    mockInvoiceRows.rows = [];
    mockTxUpdate.mockReset();
    mockDetectionHooks.detectMatchMismatch.mockReset();
    mockDetectionHooks.detectOverpaid.mockReset();
    mockDetectionHooks.detectPastDue.mockReset();
  });

  it.each(["approved", "partially_paid", "paid"])(
    "is idempotent when invoice is already %s",
    async (status) => {
      const invoice = { id: 143, status };
      mockInvoiceRows.rows = [invoice];

      await expect(approveInvoice(143, "user-1")).resolves.toBe(invoice);
      expect(mockTxUpdate).not.toHaveBeenCalled();
      expect(mockDetectionHooks.detectMatchMismatch).not.toHaveBeenCalled();
      expect(mockDetectionHooks.detectOverpaid).not.toHaveBeenCalled();
      expect(mockDetectionHooks.detectPastDue).not.toHaveBeenCalled();
    },
  );
});
