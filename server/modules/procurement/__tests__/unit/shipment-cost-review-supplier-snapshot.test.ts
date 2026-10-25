import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PurchaseCostStatus } from "@shared/procurement/purchase-cost-status";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";
import { createPurchaseCostStatusSnapshotReader } from "../../purchase-cost-status-snapshot.repository";
import { readShipmentCostReviewInTransaction } from "../../shipment-cost-review.repository";
import { readShipmentCostPostingEvidence } from "../../shipment-cost-posting-read.repository";

vi.mock("../../purchase-cost-status.repository", async importOriginal => ({
  ...await importOriginal<typeof import("../../purchase-cost-status.repository")>(),
  readPurchaseCostStatus: vi.fn(),
}));
vi.mock("../../shipment-cost-posting-read.repository", () => ({ readShipmentCostPostingEvidence: vi.fn() }));

function supplier(): PurchaseCostStatus {
  return { lines: [{ purchaseOrderId: 10, purchaseOrderLineId: 101, sku: "SUPPLIER",
    components: [
      { component: "product", status: "pending", sourceEvidence: "estimated", sourceCurrent: false, sourceRevisionId: null, applicationId: null, issues: [] },
      { component: "packaging", status: "pending", sourceEvidence: "estimated", sourceCurrent: false, sourceRevisionId: null, applicationId: null, issues: [] },
    ], invoices: [], receipts: [], lots: [],
  }] };
}
function shipmentLine(id: number): Record<string, unknown> {
  return { id, sku: `SHIPMENT-${id}`, purchase_order_line_id: 101, contract: null, application_id: null, result: null };
}

beforeEach(() => {
  vi.mocked(readPurchaseCostStatus).mockReset().mockResolvedValue(supplier());
  vi.mocked(readShipmentCostPostingEvidence).mockReset().mockResolvedValue({ exceptions: new Map(), sourceIssues: new Map() });
});

describe("shipment review preserves per-shipment owners while sharing exact supplier evidence", () => {
  it("still reads each shipment and its posting/freshness evidence while reading shared supplier evidence once", async () => {
    const tx = { execute: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValueOnce({ rows: [shipmentLine(11)] })
      .mockResolvedValueOnce({ rows: [{ id: 2 }] }).mockResolvedValueOnce({ rows: [shipmentLine(21)] }) };
    const reader = createPurchaseCostStatusSnapshotReader(tx);
    const first = await readShipmentCostReviewInTransaction(tx, 1, reader);
    const second = await readShipmentCostReviewInTransaction(tx, 2, reader);
    expect(tx.execute).toHaveBeenCalledTimes(4);
    expect(readShipmentCostPostingEvidence).toHaveBeenNthCalledWith(1, tx, [{ lineId: 11, shipmentId: 1, contract: null }]);
    expect(readShipmentCostPostingEvidence).toHaveBeenNthCalledWith(2, tx, [{ lineId: 21, shipmentId: 2, contract: null }]);
    expect(readPurchaseCostStatus).toHaveBeenCalledExactlyOnceWith(tx, [101]);
    expect(first).toMatchObject({ shipmentId: 1, lines: [{ lineId: 11 }], supplierCosts: supplier() });
    expect(second).toMatchObject({ shipmentId: 2, lines: [{ lineId: 21 }], supplierCosts: supplier() });
    first!.supplierCosts!.lines[0].sku = "CALLER_CHANGE";
    expect(second!.supplierCosts).toEqual(supplier());
  });

  it("keeps the direct supplier owner for callers that do not provide a snapshot reader", async () => {
    const tx = { execute: vi.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValueOnce({ rows: [shipmentLine(11)] }) };
    expect(await readShipmentCostReviewInTransaction(tx, 1)).toMatchObject({ supplierCosts: supplier() });
    expect(readPurchaseCostStatus).toHaveBeenCalledExactlyOnceWith(tx, [101]);
  });

  it("does not read supplier or posting evidence for a missing shipment", async () => {
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await readShipmentCostReviewInTransaction(tx, 1, createPurchaseCostStatusSnapshotReader(tx))).toBeNull();
    expect(readPurchaseCostStatus).not.toHaveBeenCalled();
    expect(readShipmentCostPostingEvidence).not.toHaveBeenCalled();
  });

  it("propagates a later shipment's freshness failure even after supplier evidence was retained", async () => {
    const tx = { execute: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }).mockResolvedValueOnce({ rows: [shipmentLine(11)] })
      .mockResolvedValueOnce({ rows: [{ id: 2 }] }).mockResolvedValueOnce({ rows: [shipmentLine(21)] }) };
    const reader = createPurchaseCostStatusSnapshotReader(tx);
    await readShipmentCostReviewInTransaction(tx, 1, reader);
    vi.mocked(readShipmentCostPostingEvidence).mockRejectedValueOnce(new Error("Current landed source could not be read"));
    await expect(readShipmentCostReviewInTransaction(tx, 2, reader)).rejects.toThrow("Current landed source could not be read");
    expect(readShipmentCostPostingEvidence).toHaveBeenCalledTimes(2);
    expect(readPurchaseCostStatus).toHaveBeenCalledTimes(1);
  });
});