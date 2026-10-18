import { z } from "zod";

const quantity = z.number().int().nonnegative().safe();
export const linkedRfqPurchaseSchema = z.object({
  rfqLineId: z.number().int().positive(),
  purchaseOrderId: z.number().int().positive(),
  status: z.enum(["draft", "pending_approval", "approved", "sent", "acknowledged", "partially_received", "received", "closed", "cancelled"]),
  lineStatus: z.enum(["open", "partially_received", "received", "closed", "cancelled"]),
  orderQty: quantity,
  receivedQty: quantity,
  cancelledQty: quantity,
  updatedAt: z.date(),
}).strict();
export type LinkedRfqPurchase = z.infer<typeof linkedRfqPurchaseSchema>;

export class RfqSourcingSnapshotError extends Error {
  readonly code = "RFQ_SUPPLY_SNAPSHOT_STALE";
  readonly statusCode = 409;
  constructor() {
    super("Purchase supply changed after this recommendation run. Generate fresh recommendations before creating another RFQ.");
    this.name = "RfqSourcingSnapshotError";
  }
}

export function isActiveRfqReservation(rfqStatus: string, lineStatus: string): boolean {
  return ["draft", "sent", "partially_quoted", "quoted"].includes(rfqStatus) && ["draft", "sent", "quoted", "accepted", "ordered"].includes(lineStatus);
}

export const pendingPurchaseSourcingSchema = linkedRfqPurchaseSchema.omit({ rfqLineId: true });
export function pendingPurchaseSourcingPieces(purchase: unknown): number {
  const source = pendingPurchaseSourcingSchema.parse(purchase);
  if (!["draft", "pending_approval"].includes(source.status) || !["open", "partially_received"].includes(source.lineStatus)) return 0;
  return Math.max(source.orderQty - source.receivedQty - source.cancelledQty, 0);
}

export function rfqPendingSourcingPieces(requestedPieces: number, purchase: LinkedRfqPurchase | null, activeRequest = true): number {
  quantity.parse(requestedPieces);
  if (purchase === null) return activeRequest ? requestedPieces : 0; // Unknown legacy links retain their existing allocation.
  const source = linkedRfqPurchaseSchema.parse(purchase);
  // Drafts are not part of the planning engine's committed PO supply. After
  // approval, the PO/receipt supply owns the quantity; retaining an RFQ reserve
  // would subtract the same purchase twice and eventually suppress future buys.
  const { rfqLineId: _rfqLineId, ...purchaseSource } = source;
  return pendingPurchaseSourcingPieces(purchaseSource);
}

export function assertRfqSupplySnapshotCurrent(purchases: LinkedRfqPurchase[], asOf: Date): void {
  z.date().parse(asOf);
  for (const purchase of purchases) {
    const source = linkedRfqPurchaseSchema.parse(purchase);
    if (!["draft", "pending_approval"].includes(source.status) && source.updatedAt.getTime() > asOf.getTime()) throw new RfqSourcingSnapshotError();
  }
}

/** Unassigned warehouse demand intersects every warehouse; explicit distinct
 * warehouses remain independent. Receive variants never partition base demand. */
export function sourcingScopesOverlap(left: { productId: number; warehouseId?: number | null }, right: { productId: number; warehouseId?: number | null }): boolean {
  return left.productId === right.productId && (left.warehouseId == null || right.warehouseId == null || left.warehouseId === right.warehouseId);
}

export class PendingPurchaseSourcingReviewError extends Error {
  readonly code = "RFQ_PENDING_PURCHASE_REVIEW_REQUIRED";
  readonly statusCode = 409;
  readonly context: { purchaseOrderIds: number[] };
  constructor(purchaseOrderIds: readonly number[]) {
    const ids = [...new Set(purchaseOrderIds)].sort((a, b) => a - b);
    super(`Draft purchase orders ${ids.map((id) => `#${id}`).join(", ")} already reserve this demand. Review or cancel those draft obligations before creating another quote request.`);
    this.name = "PendingPurchaseSourcingReviewError";
    this.context = { purchaseOrderIds: ids };
  }
}
