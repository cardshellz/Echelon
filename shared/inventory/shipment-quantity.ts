import { z } from "zod";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
const positiveBigintText = z.string().max(19).regex(/^[1-9][0-9]*$/)
  .pipe(z.string().refine((value) => BigInt(value) <= POSTGRES_BIGINT_MAX));

/** Shipment units and the inventory ledger's on-hand delta are different facts. */
export const inventoryShipmentQuantityEvidenceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_shipment") }).strict(),
  z.object({
    status: z.literal("verified"),
    quantity: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
    source: z.enum(["canonical_dispatch_receipt", "legacy_on_hand_delta"]),
    receiptId: positiveBigintText.nullable(),
  }).strict(),
  z.object({
    status: z.literal("invalid"),
    code: z.literal("SHIPMENT_QUANTITY_EVIDENCE_INVALID"),
    reason: z.string().min(1).max(300),
  }).strict(),
]).refine((value) => value.status !== "verified"
  || (value.source === "canonical_dispatch_receipt") === (value.receiptId !== null),
"Canonical quantities require a receipt; legacy quantities must not claim one");

export type InventoryShipmentQuantityEvidence = z.infer<typeof inventoryShipmentQuantityEvidenceSchema>;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function integer(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string" || value.length > 17 || !/^-?(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function positiveId(value: unknown): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed > 0 && parsed <= POSTGRES_INTEGER_MAX ? parsed : null;
}

function invalid(reason: string): InventoryShipmentQuantityEvidence {
  return { status: "invalid", code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID", reason };
}

/**
 * Interpret one read-only ledger/receipt projection. This establishes recorded
 * shipment units, not permission to reverse a claim or evidence of carrier receipt.
 * A voided historical row can still describe its original units; callers retain
 * the separate void state and must filter it for active-demand calculations.
 */
export function interpretInventoryShipmentQuantity(raw: unknown): InventoryShipmentQuantityEvidence {
  const row = object(raw);
  if (!row || typeof row.transactionType !== "string") return invalid("Missing inventory transaction evidence.");
  const canonicalMarker = row.referenceType === "availability_claim_dispatch";
  const hasReceipt = row.receipt !== null && row.receipt !== undefined;
  if (row.transactionType !== "ship") {
    return canonicalMarker || hasReceipt
      ? invalid("Dispatch evidence is attached to a non-shipment transaction.")
      : { status: "not_shipment" };
  }
  if (positiveId(row.transactionId) === null) return invalid("Invalid inventory transaction identity.");
  const delta = integer(row.variantQtyDelta);
  if (!canonicalMarker && !hasReceipt) {
    if (delta === null || delta >= 0 || delta < -POSTGRES_INTEGER_MAX) {
      return invalid("Shipment has neither a valid legacy debit nor a canonical dispatch receipt.");
    }
    return { status: "verified", quantity: -delta, source: "legacy_on_hand_delta", receiptId: null };
  }
  const receipt = object(row.receipt);
  if (!canonicalMarker || !receipt) return invalid("Canonical dispatch marker and receipt must both be present.");
  const receiptId = positiveBigintText.safeParse(receipt.id);
  const quantity = positiveId(receipt.quantity);
  if (!receiptId.success || quantity === null) return invalid("Invalid canonical dispatch receipt identity or quantity.");
  if (delta !== 0 || integer(row.reservedQtyDelta) !== 0
    || row.sourceState !== "picked" || row.targetState !== "shipped") {
    return invalid("Canonical shipment must consume picked custody without another on-hand or reservation debit.");
  }
  const identityFields = ["orderId", "orderItemId", "shipmentId", "shipmentItemId", "productVariantId", "fromLocationId"] as const;
  for (const field of identityFields) {
    const identity = positiveId(row[field]);
    if (identity === null || identity !== positiveId(receipt[field])) {
      return invalid(`Canonical receipt does not match the shipment's ${field}.`);
    }
  }
  if (positiveId(receipt.warehouseId) === null) return invalid("Canonical receipt has no valid warehouse identity.");
  const physicalId = receipt.physicalShipmentId;
  const physicalItemId = receipt.physicalShipmentItemId;
  if ((physicalId !== null || physicalItemId !== null)
    && (!positiveBigintText.safeParse(physicalId).success || !positiveBigintText.safeParse(physicalItemId).success)) {
    return invalid("Canonical receipt has an incomplete or invalid physical-shipment identity pair.");
  }
  if (integer(receipt.movementQuantity) !== quantity || integer(receipt.invalidMovementCount) !== 0) {
    return invalid("Canonical receipt does not reconcile to its exact original-pick movement journal.");
  }
  return { status: "verified", quantity, source: "canonical_dispatch_receipt", receiptId: receiptId.data };
}
