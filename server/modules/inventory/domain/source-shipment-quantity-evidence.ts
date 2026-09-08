import { interpretInventoryShipmentQuantity } from "@shared/inventory/shipment-quantity";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_SOURCE_SHIPMENT_POSTINGS = 1_000;

export interface SourceShipmentQuantityIdentity {
  readonly orderId: number;
  readonly orderItemId: number;
  readonly shipmentId: number;
  readonly shipmentItemId: number;
  readonly productVariantId: number;
}

export class SourceShipmentQuantityEvidenceError extends Error {
  constructor(message: string, readonly context: Readonly<SourceShipmentQuantityIdentity>,
    readonly code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID" | "CANONICAL_OMISSION_CORRECTION_UNAVAILABLE" = "SHIPMENT_QUANTITY_EVIDENCE_INVALID") {
    super(message);
    this.name = "SourceShipmentQuantityEvidenceError";
  }
}

export interface SourceShipmentPostedQuantity {
  readonly quantity: number;
  readonly source: "canonical_dispatch_receipt" | "operational_dispatch_receipt" | "legacy_on_hand_delta" | null;
}

/** Quantifies existing postings only. It does not authorize a stock adjustment. */
export function readSourceShipmentPostedQuantity(raw: unknown, expected: SourceShipmentQuantityIdentity): SourceShipmentPostedQuantity {
  const fail = (reason: string): never => {
    throw new SourceShipmentQuantityEvidenceError(reason, Object.freeze({ ...expected }));
  };
  const identityKeys = ["orderId", "orderItemId", "shipmentId", "shipmentItemId", "productVariantId"] as const;
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)
    || identityKeys.some((key) => !Number.isInteger(expected[key]) || expected[key] <= 0 || expected[key] > POSTGRES_INTEGER_MAX)) {
    fail("Source shipment quantity requires exact PostgreSQL identities.");
  }
  if (!Array.isArray(raw) || raw.length > MAX_SOURCE_SHIPMENT_POSTINGS) {
    fail("Source shipment quantity evidence is missing, malformed or exceeds the review bound.");
  }
  const rows = raw as unknown[];
  const seen = new Set<string>();
  let quantity = 0;
  let source: SourceShipmentPostedQuantity["source"] = null;
  for (const entry of rows) {
    const evidence = interpretInventoryShipmentQuantity(entry);
    if (evidence.status !== "verified") {
      return fail(evidence.status === "invalid" ? evidence.reason : "Source posting is not a shipment.");
    }
    const row = entry as Record<string, unknown>;
    const transactionId = String(row.transactionId);
    if (seen.has(transactionId)) fail("Source shipment includes duplicate inventory postings.");
    seen.add(transactionId);
    if (String(row.shipmentId) !== String(expected.shipmentId)
      || String(row.orderItemId) !== String(expected.orderItemId)
      || String(row.productVariantId) !== String(expected.productVariantId)
      || (row.orderId != null && String(row.orderId) !== String(expected.orderId))
      || (row.shipmentItemId != null && String(row.shipmentItemId) !== String(expected.shipmentItemId))) {
      fail("Inventory shipment posting belongs to another source identity.");
    }
    // A canonical source has exactly one full-source receipt. Combining it with
    // a legacy debit (or another receipt) would conceal double posting.
    if (evidence.source !== "legacy_on_hand_delta" && rows.length !== 1) {
      fail("Canonical source shipment cannot be combined with other inventory postings.");
    }
    quantity += evidence.quantity;
    source = evidence.source;
    if (!Number.isSafeInteger(quantity) || quantity > POSTGRES_INTEGER_MAX) {
      fail("Source shipment quantity exceeds the PostgreSQL integer boundary.");
    }
  }
  return Object.freeze({ quantity, source });
}
