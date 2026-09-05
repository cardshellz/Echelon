import {
  purchaseWorkspaceSchema,
  type PurchaseWorkspace,
  type PurchaseWorkspaceEdge,
} from "@shared/procurement/purchase-workspace";
import { resolveCurrentPhysicalStatus } from "./purchase-order-lifecycle.service";

export interface PurchaseWorkspaceSnapshot extends Omit<PurchaseWorkspace, "edges" | "limitations"> {
  directShipmentIds: number[];
  directReceiptIds: number[];
  directInvoiceIds: number[];
  shipmentInvoiceLinks: Array<{ shipmentId: number; invoiceId: number }>;
}

export interface PurchaseWorkspaceRepository {
  read(purchaseOrderId: number): Promise<PurchaseWorkspaceSnapshot | null>;
}

export class PurchaseWorkspaceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "PurchaseWorkspaceError";
  }
}

export function createPurchaseWorkspaceService(repository: PurchaseWorkspaceRepository) {
  return {
    async getPurchaseWorkspace(purchaseOrderId: number): Promise<PurchaseWorkspace> {
      if (!Number.isSafeInteger(purchaseOrderId) || purchaseOrderId <= 0) {
        throw new PurchaseWorkspaceError("PURCHASE_WORKSPACE_ID_INVALID", "Purchase ID must be a positive safe integer.", 400);
      }
      const snapshot = await repository.read(purchaseOrderId);
      if (!snapshot) {
        throw new PurchaseWorkspaceError("PURCHASE_WORKSPACE_NOT_FOUND", "Purchase order not found.", 404);
      }
      if (snapshot.purchase.id !== purchaseOrderId) {
        throw new PurchaseWorkspaceError("PURCHASE_WORKSPACE_ID_MISMATCH", "Purchase workspace identity did not match its request.", 500);
      }
      const shipmentIds = new Set(snapshot.shipments.map((record) => record.id));
      const receiptIds = new Set(snapshot.receipts.map((record) => record.id));
      const invoiceIds = new Set(snapshot.invoices.map((record) => record.id));
      if (
        shipmentIds.size !== snapshot.shipments.length ||
        receiptIds.size !== snapshot.receipts.length ||
        invoiceIds.size !== snapshot.invoices.length
      ) {
        throw new PurchaseWorkspaceError("PURCHASE_WORKSPACE_DUPLICATE_RECORD", "Purchase workspace contains duplicate records.", 500);
      }

      const edges: PurchaseWorkspaceEdge[] = [];
      const seen = new Set<string>();
      const addEdge = (edge: PurchaseWorkspaceEdge) => {
        const key = `${edge.relationship}:${edge.from.id}:${edge.to.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push(edge);
        }
      };
      const purchase = { kind: "purchase" as const, id: purchaseOrderId };
      for (const id of snapshot.directShipmentIds) {
        if (shipmentIds.has(id)) addEdge({ from: purchase, to: { kind: "shipment", id }, relationship: "purchase_shipment" });
      }
      for (const id of snapshot.directReceiptIds) {
        if (receiptIds.has(id)) addEdge({ from: purchase, to: { kind: "receipt", id }, relationship: "purchase_receipt" });
      }
      for (const id of snapshot.directInvoiceIds) {
        if (invoiceIds.has(id)) addEdge({ from: purchase, to: { kind: "invoice", id }, relationship: "purchase_invoice" });
      }
      for (const receipt of snapshot.receipts) {
        if (receipt.inboundShipmentId !== null && shipmentIds.has(receipt.inboundShipmentId)) {
          addEdge({
            from: { kind: "shipment", id: receipt.inboundShipmentId },
            to: { kind: "receipt", id: receipt.id },
            relationship: "shipment_receipt",
          });
        }
      }
      for (const link of snapshot.shipmentInvoiceLinks) {
        if (shipmentIds.has(link.shipmentId) && invoiceIds.has(link.invoiceId)) {
          addEdge({
            from: { kind: "shipment", id: link.shipmentId },
            to: { kind: "invoice", id: link.invoiceId },
            relationship: "shipment_invoice",
          });
        }
      }

      return purchaseWorkspaceSchema.parse({
        purchase: { ...snapshot.purchase, physicalStatus: resolveCurrentPhysicalStatus(snapshot.purchase) },
        shipments: snapshot.shipments,
        receipts: snapshot.receipts,
        invoices: snapshot.invoices,
        edges,
        limitations: [
          "Shipment and invoice amounts describe whole documents, which may cover other purchases.",
          "Recorded PO invoice, payment and outstanding totals include whole linked invoices; they are not purchase-specific allocations.",
          "Shipment header cost totals do not identify a reliable currency basis in this view.",
          "An invoice allocation that is not recorded is unknown; whole-invoice payments are not a payment allocation to this purchase.",
          "Receipt records include drafts and cancelled history. A receipt status alone does not establish inventory availability.",
          "RFQ origin and inventory lot history are not linked in this view.",
        ],
      });
    },
  };
}
