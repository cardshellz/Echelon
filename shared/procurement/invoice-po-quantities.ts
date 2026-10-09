import { z } from "zod";

const recordId = z.number().int().positive().safe();
const pieceCount = z.number().int().nonnegative().safe();

export const invoicePoQuantitiesSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("current"),
    purchaseOrderId: recordId,
    purchaseOrderLineId: recordId,
    orderedQty: pieceCount,
    receivedQty: pieceCount,
  }).strict(),
  z.object({ status: z.literal("unlinked") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);

export type InvoicePoQuantities = z.infer<typeof invoicePoQuantitiesSchema>;

type PurchaseOrderQuantitySource = {
  id: number;
  purchaseOrderId: number;
  orderQty: number;
  receivedQty: number | null;
};

/** Keep live PO comparison facts separate from the vendor's billed quantity. */
export function buildInvoicePoQuantities(
  purchaseOrderLineId: number | null,
  source: PurchaseOrderQuantitySource | null,
): InvoicePoQuantities {
  if (purchaseOrderLineId === null) return { status: "unlinked" };
  recordId.parse(purchaseOrderLineId);
  if (source === null || source.id !== purchaseOrderLineId) return { status: "unavailable" };
  return invoicePoQuantitiesSchema.parse({
    status: "current",
    purchaseOrderId: source.purchaseOrderId,
    purchaseOrderLineId: source.id,
    orderedQty: source.orderQty,
    // Match evaluation also treats a null received count as no pieces received.
    receivedQty: source.receivedQty ?? 0,
  });
}
