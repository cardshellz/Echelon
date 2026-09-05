import { describe, expect, it, vi } from "vitest";
import type { PurchaseWorkspace } from "../../../../../shared/procurement/purchase-workspace";
import {
  createPurchaseWorkspaceService,
  type PurchaseWorkspaceSnapshot,
} from "../../purchase-workspace.service";

type Shipment = PurchaseWorkspace["shipments"][number];
type Receipt = PurchaseWorkspace["receipts"][number];
type Invoice = PurchaseWorkspace["invoices"][number];

function shipment(id: number, overrides: Partial<Shipment> = {}): Shipment {
  return {
    id,
    shipmentNumber: `SHP-${id}`,
    status: "in_transit",
    mode: "ocean",
    containerNumber: null,
    eta: null,
    deliveredDate: null,
    estimatedTotalCostCents: null,
    actualTotalCostCents: null,
    amountScope: "whole_shipment",
    purchaseOrderIds: [1],
    unlinkedLineCount: 0,
    lines: [],
    ...overrides,
  };
}

function receipt(id: number, overrides: Partial<Receipt> = {}): Receipt {
  return {
    id,
    receiptNumber: `RCV-${id}`,
    status: "draft",
    purchaseOrderId: 1,
    inboundShipmentId: null,
    expectedDate: null,
    receivedDate: null,
    closedDate: null,
    ...overrides,
  };
}

function invoice(id: number, overrides: Partial<Invoice> = {}): Invoice {
  return {
    id,
    invoiceNumber: `INV-${id}`,
    status: "received",
    currency: "USD",
    invoiceDate: null,
    dueDate: null,
    inboundShipmentId: null,
    invoicedAmountCents: null,
    paidAmountCents: null,
    balanceCents: null,
    amountScope: "whole_invoice",
    allocatedToPurchaseCents: null,
    purchaseOrderIds: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<PurchaseWorkspaceSnapshot> = {}): PurchaseWorkspaceSnapshot {
  return {
    purchase: {
      id: 1,
      poNumber: "PO-1",
      status: "approved",
      physicalStatus: "draft",
      financialStatus: "unbilled",
      currency: "USD",
      vendorName: "Fixture supplier",
      totalCents: 100000,
      invoicedTotalCents: null,
      paidTotalCents: null,
      outstandingCents: null,
      expectedDeliveryDate: null,
      confirmedDeliveryDate: null,
      actualDeliveryDate: null,
      lines: [],
    },
    shipments: [],
    receipts: [],
    invoices: [],
    directShipmentIds: [],
    directReceiptIds: [],
    directInvoiceIds: [],
    shipmentInvoiceLinks: [],
    ...overrides,
  };
}

function setup(value: PurchaseWorkspaceSnapshot | null) {
  const read = vi.fn<(purchaseOrderId: number) => Promise<PurchaseWorkspaceSnapshot | null>>()
    .mockResolvedValue(value);
  return { read, service: createPurchaseWorkspaceService({ read }) };
}

describe("purchase workspace proven relationships", () => {
  it("retains an unposted draft receipt and cancelled receipt history as separate linked documents", async () => {
    const { service } = setup(snapshot({
      receipts: [receipt(21), receipt(22, { status: "cancelled" })],
      directReceiptIds: [21, 22],
    }));

    const result = await service.getPurchaseWorkspace(1);

    expect(result.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 21, status: "draft", receivedDate: null, closedDate: null }),
      expect.objectContaining({ id: 22, status: "cancelled" }),
    ]));
    expect(result.edges).toEqual(expect.arrayContaining([21, 22].map((id) => ({
      from: { kind: "purchase", id: 1 },
      to: { kind: "receipt", id },
      relationship: "purchase_receipt",
    }))));
  });

  it("retains a closed receipt without inventing posting quantities or lot records", async () => {
    const { service } = setup(snapshot({
      receipts: [receipt(23, { status: "closed", closedDate: "2026-09-01T12:00:00.000Z" })],
      directReceiptIds: [23],
    }));

    const result = await service.getPurchaseWorkspace(1);

    expect(result.receipts[0]).toMatchObject({ id: 23, status: "closed" });
    expect(result.receipts[0]).not.toHaveProperty("postedQuantity");
    expect(result).not.toHaveProperty("lots");
    expect(result.edges).toEqual([{
      from: { kind: "purchase", id: 1 }, to: { kind: "receipt", id: 23 }, relationship: "purchase_receipt",
    }]);
  });

  it("keeps shared and split shipments distinct and preserves whole-shipment costs", async () => {
    const shared = shipment(7, {
      purchaseOrderIds: [1, 2],
      estimatedTotalCostCents: 45000,
      actualTotalCostCents: 47000,
      lines: [
        { id: 71, purchaseOrderId: 1, purchaseOrderLineId: 11, purchaseOrderLinePurchaseOrderId: 1, sku: "SKU-A", qtyShipped: 400, allocatedCostCents: 17000 },
        { id: 72, purchaseOrderId: 2, purchaseOrderLineId: 12, purchaseOrderLinePurchaseOrderId: 2, sku: "SKU-A", qtyShipped: 600, allocatedCostCents: 30000 },
      ],
    });
    const split = shipment(8, {
      status: "delivered",
      lines: [{ id: 81, purchaseOrderId: 1, purchaseOrderLineId: 11, purchaseOrderLinePurchaseOrderId: 1, sku: "SKU-A", qtyShipped: 100, allocatedCostCents: null }],
    });
    const { service } = setup(snapshot({ shipments: [shared, split], directShipmentIds: [7, 8] }));

    const result = await service.getPurchaseWorkspace(1);

    expect(result.shipments).toEqual(expect.arrayContaining([shared, split]));
    expect(result.edges.filter((edge) => edge.relationship === "purchase_shipment")).toHaveLength(2);
    expect(result.shipments.find((row) => row.id === 7)).toMatchObject({
      amountScope: "whole_shipment", estimatedTotalCostCents: 45000, actualTotalCostCents: 47000,
    });
  });

  it("distinguishes whole invoice amounts, explicit PO allocation and shipment-only association", async () => {
    const linked = invoice(10, {
      purchaseOrderIds: [1, 2], invoicedAmountCents: 100000, paidAmountCents: 60000,
      balanceCents: 40000, allocatedToPurchaseCents: 40000,
    });
    const shipmentOnly = invoice(11, {
      inboundShipmentId: 7, purchaseOrderIds: [2], invoicedAmountCents: 99000,
      allocatedToPurchaseCents: null,
    });
    const { service } = setup(snapshot({
      shipments: [shipment(7)], directShipmentIds: [7],
      invoices: [linked, shipmentOnly], directInvoiceIds: [10],
      shipmentInvoiceLinks: [{ shipmentId: 7, invoiceId: 11 }],
    }));

    const result = await service.getPurchaseWorkspace(1);

    expect(result.invoices).toEqual(expect.arrayContaining([linked, shipmentOnly]));
    expect(result.edges).toContainEqual({
      from: { kind: "shipment", id: 7 }, to: { kind: "invoice", id: 11 }, relationship: "shipment_invoice",
    });
    expect(result.edges.filter((edge) => edge.relationship === "purchase_invoice")).toEqual([{
      from: { kind: "purchase", id: 1 }, to: { kind: "invoice", id: 10 }, relationship: "purchase_invoice",
    }]);
  });

  it("uses receipt IDs and recorded shipment IDs, never a shared SKU or display number, to connect records", async () => {
    const { service } = setup(snapshot({
      shipments: [shipment(7)], directShipmentIds: [7],
      receipts: [receipt(21, { inboundShipmentId: 7 }), receipt(22, { receiptNumber: "SHP-7" })],
      directReceiptIds: [21, 22],
    }));

    const result = await service.getPurchaseWorkspace(1);

    expect(result.edges.filter((edge) => edge.relationship === "shipment_receipt")).toEqual([{
      from: { kind: "shipment", id: 7 }, to: { kind: "receipt", id: 21 }, relationship: "shipment_receipt",
    }]);
  });

  it("does not emit a shipment edge when a receipt's referenced shipment is absent from the snapshot", async () => {
    const { service } = setup(snapshot({
      receipts: [receipt(21, { inboundShipmentId: 99 })], directReceiptIds: [21],
    }));

    const result = await service.getPurchaseWorkspace(1);

    expect(result.receipts[0].inboundShipmentId).toBe(99);
    expect(result.edges.some((edge) => edge.from.kind === "shipment" || edge.to.kind === "shipment")).toBe(false);
  });

  it("deduplicates repeated proof of an edge without changing the snapshot", async () => {
    const original = snapshot({
      shipments: [shipment(7)], directShipmentIds: [7, 7],
      invoices: [invoice(10)],
      shipmentInvoiceLinks: [{ shipmentId: 7, invoiceId: 10 }, { shipmentId: 7, invoiceId: 10 }],
    });
    const before = structuredClone(original);
    const { service } = setup(original);

    const result = await service.getPurchaseWorkspace(1);

    expect(result.edges).toHaveLength(2);
    expect(original).toEqual(before);
    expect(result).not.toHaveProperty("directShipmentIds");
    expect(result).not.toHaveProperty("shipmentInvoiceLinks");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid purchase ID %s before reading the repository",
    async (id) => {
      const { read, service } = setup(snapshot());
      await expect(service.getPurchaseWorkspace(id)).rejects.toMatchObject({ statusCode: 400 });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("reports a missing purchase without presenting an empty successful workspace", async () => {
    const { read, service } = setup(null);
    await expect(service.getPurchaseWorkspace(1)).rejects.toMatchObject({ statusCode: 404 });
    expect(read).toHaveBeenCalledWith(1);
  });

  it("rejects a repository response for another purchase", async () => {
    const value = snapshot();
    value.purchase.id = 2;
    const { service } = setup(value);

    await expect(service.getPurchaseWorkspace(1)).rejects.toMatchObject({
      code: "PURCHASE_WORKSPACE_ID_MISMATCH", statusCode: 500,
    });
  });

  it.each(["shipments", "receipts", "invoices"] as const)(
    "rejects duplicate %s identities rather than hiding conflicting records",
    async (kind) => {
      const value = snapshot();
      if (kind === "shipments") value.shipments = [shipment(7), shipment(7, { status: "cancelled" })];
      if (kind === "receipts") value.receipts = [receipt(21), receipt(21, { status: "cancelled" })];
      if (kind === "invoices") value.invoices = [invoice(10), invoice(10, { status: "voided" })];
      const { service } = setup(value);

      await expect(service.getPurchaseWorkspace(1)).rejects.toMatchObject({
        code: "PURCHASE_WORKSPACE_DUPLICATE_RECORD", statusCode: 500,
      });
    },
  );

  it("propagates a read failure instead of presenting missing relationships as an empty success", async () => {
    const failure = new Error("Fixture repository unavailable");
    const read = vi.fn<(purchaseOrderId: number) => Promise<PurchaseWorkspaceSnapshot | null>>()
      .mockRejectedValue(failure);
    const service = createPurchaseWorkspaceService({ read });

    await expect(service.getPurchaseWorkspace(1)).rejects.toBe(failure);
  });

  it("shows another purchase's receipt on a shared shipment without attaching it directly to this purchase", async () => {
    const { service } = setup(snapshot({
      shipments: [shipment(7, { purchaseOrderIds: [1, 2] })],
      directShipmentIds: [7],
      receipts: [
        receipt(21, { inboundShipmentId: 7 }),
        receipt(22, { purchaseOrderId: 2, inboundShipmentId: 7, status: "closed" }),
      ],
      directReceiptIds: [21],
    }));

    const result = await service.getPurchaseWorkspace(1);

    expect(result.receipts.find((row) => row.id === 22)).toMatchObject({ purchaseOrderId: 2 });
    expect(result.edges.filter((edge) => edge.relationship === "shipment_receipt")).toEqual(
      expect.arrayContaining([21, 22].map((id) => ({
        from: { kind: "shipment", id: 7 }, to: { kind: "receipt", id }, relationship: "shipment_receipt",
      }))),
    );
    expect(result.edges.filter((edge) => edge.relationship === "purchase_receipt")).toEqual([{
      from: { kind: "purchase", id: 1 }, to: { kind: "receipt", id: 21 }, relationship: "purchase_receipt",
    }]);
  });
});
