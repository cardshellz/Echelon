import { z } from "zod";

const shipmentEvidenceSchema = z.object({
  id: z.number().int().positive().safe(),
  order_id: z.number().int().positive().safe(),
  product_variant_id: z.number().int().positive().safe(),
  from_location_id: z.number().int().positive().safe(),
  variant_qty_delta: z.number().int().negative().safe(),
  variant_qty_before: z.number().int().nonnegative().safe(),
  variant_qty_after: z.number().int().nonnegative().safe(),
  source_state: z.enum(["picked", "on_hand"]),
  target_state: z.literal("shipped"),
  voided: z.literal(false),
});

export type ConfirmedPickShipmentPlan =
  | { kind: "ordinary_pick" }
  | { kind: "restore_picked_balance"; shipmentTransactionIds: number[]; shippedQuantity: number }
  | { kind: "review"; message: string };

/**
 * A legacy shipment can debit the shared picked pool before the omitted pick is
 * recorded. Completing that pick transfers on-hand -> picked, restoring that
 * pool and recording FIFO costs without another shipment or net stock debit.
 * A shipment that already used on-hand is different: replaying a normal pick
 * would spend on-hand again. Never infer its missing lot costs from current stock.
 */
export function planConfirmedPickShipment(input: {
  shipments: readonly unknown[];
  orderId: number;
  productVariantId: number | null;
  sourceLocationId: number | undefined;
  pickedQuantity: number;
  targetPickedQuantity: number;
  confirmedPreviouslyPicked: boolean;
}): ConfirmedPickShipmentPlan {
  const review = (message: string): ConfirmedPickShipmentPlan => ({ kind: "review", message });
  const parsed = z.array(shipmentEvidenceSchema).safeParse(input.shipments);
  if (!parsed.success) return review("Shipment inventory evidence is incomplete or voided. Inventory review is required; no stock was changed.");
  let shippedQuantity = 0;
  for (const row of parsed.data) {
    if (row.order_id !== input.orderId || row.product_variant_id !== input.productVariantId)
      return review("Shipment inventory belongs to a different order or SKU. Inventory review is required; no stock was changed.");
    const shipped = -row.variant_qty_delta;
    const onHandUsed = row.variant_qty_before - row.variant_qty_after;
    if (onHandUsed < 0 || onHandUsed > shipped
      || (row.source_state === "picked" && onHandUsed !== 0)
      || (row.source_state === "on_hand" && onHandUsed === 0))
      return review("Shipment inventory bucket evidence is inconsistent. Inventory review is required; no stock was changed.");
    shippedQuantity += shipped;
    if (!Number.isSafeInteger(shippedQuantity))
      return review("Shipment inventory quantity is invalid. Inventory review is required; no stock was changed.");
  }
  if (shippedQuantity <= input.pickedQuantity) return { kind: "ordinary_pick" };
  if (!input.confirmedPreviouslyPicked)
    return review("Shipping already deducted units without matching pick evidence. Inventory review is required; this correction did not deduct them again.");
  if (shippedQuantity > input.targetPickedQuantity)
    return review("Shipping recorded more units than this confirmation covers. Inventory review is required; no stock was changed.");
  if (parsed.data.some(row => row.source_state !== "picked"))
    return review("Shipping already deducted on-hand stock. Its original lot costs must be reconciled; this confirmation did not deduct stock again.");
  if (parsed.data.some(row => row.from_location_id !== input.sourceLocationId))
    return review("The shipped inventory came from a different bin. Inventory review is required; no stock was changed.");
  return { kind: "restore_picked_balance", shipmentTransactionIds: parsed.data.map(row => row.id), shippedQuantity };
}
