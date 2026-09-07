import {
  inventoryShipmentQuantityEvidenceSchema,
  type InventoryShipmentQuantityEvidence,
} from "@shared/inventory/shipment-quantity";

export interface InventoryTransactionQuantityInput {
  transactionType: string;
  variantQtyDelta: number;
  shipmentQuantityEvidence?: unknown;
}

/** The browser displays server evidence only; the on-hand delta is never a
 * fallback shipment quantity, including while old API responses are cached. */
export function readHistoryShipmentQuantity(input: InventoryTransactionQuantityInput): InventoryShipmentQuantityEvidence {
  if (input.transactionType !== "ship" && input.shipmentQuantityEvidence === undefined) {
    return { status: "not_shipment" };
  }
  const parsed = inventoryShipmentQuantityEvidenceSchema.safeParse(input.shipmentQuantityEvidence);
  if (!parsed.success || (parsed.data.status === "not_shipment" && input.transactionType === "ship")
    || (parsed.data.status === "verified" && input.transactionType !== "ship")) {
    return { status: "invalid", code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID",
      reason: "Shipment quantity evidence is missing or malformed. Refresh or request an inventory review." };
  }
  return parsed.data;
}

export function signedInventoryQuantity(quantity: number): string {
  return `${quantity > 0 ? "+" : ""}${quantity}`;
}

export function shipmentQuantityCsvFields(input: InventoryTransactionQuantityInput) {
  const evidence = readHistoryShipmentQuantity(input);
  return {
    shipped_quantity: evidence.status === "verified" ? evidence.quantity : "",
    shipment_quantity_status: evidence.status,
    shipment_quantity_source: evidence.status === "verified" ? evidence.source : "",
    shipment_quantity_receipt_id: evidence.status === "verified" ? evidence.receiptId ?? "" : "",
    shipment_quantity_issue: evidence.status === "invalid" ? evidence.reason : "",
  };
}

/** Cycle-count stale warnings report bin deltas, not shipment quantities. */
export function describeStaleInventoryTransaction(transaction: { type: string; qty: number }): string {
  return `${transaction.type} — on-hand Δ ${signedInventoryQuantity(transaction.qty)}`;
}
