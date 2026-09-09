import { z } from "zod";
import { AppError, ValidationError } from "@shared/errors";

const counter = z.number().int().min(0).max(2_147_483_647);
const identity = counter.positive();

/** The aggregate inventory owner chooses buckets; the lot owner must not rechoose them. */
export const shipmentLotDepletionRequestSchema = z.object({
  productVariantId: identity,
  warehouseLocationId: identity,
  qty: counter.positive(),
  fromPicked: counter,
  fromOnHand: counter,
  reservedToRelease: counter,
}).strict().refine((request) => request.fromPicked + request.fromOnHand === request.qty
  && request.reservedToRelease <= request.fromOnHand, "Shipment bucket quantities must reconcile");

export type ShipmentLotDepletionRequest = z.infer<typeof shipmentLotDepletionRequestSchema>;

const lotSchema = z.object({
  id: identity,
  qtyOnHand: counter,
  qtyReserved: counter,
  qtyPicked: counter,
  receivedAt: z.date(),
  status: z.string().min(1),
}).strict().refine((lot) => lot.qtyReserved <= lot.qtyOnHand, "Lot reservations exceed on-hand");

export type ShipmentLotBalance = z.infer<typeof lotSchema>;
export interface ShipmentLotDepletion {
  lotId: number;
  fromPicked: number;
  fromOnHand: number;
  reservedToRelease: number;
  expectedOnHand: number;
  expectedReserved: number;
  expectedPicked: number;
  expectedStatus: string;
}

export class ShipmentLotConflictError extends AppError {
  constructor(code: "LOT_SHIPMENT_SHORTFALL" | "LOT_SHIPMENT_CONFLICT" | "LOT_SHIPMENT_CENSUS_LIMIT",
    message: string, context: Record<string, unknown>) {
    super(message, code, 409, context);
  }
}

/**
 * Pure, complete plan before any write. Release exactly the owner's authorized
 * reservation amount, then consume only unreserved on-hand. A newer reserved
 * lot may therefore precede an older free lot for the reserved portion; FIFO
 * (receivedAt, id) applies independently within each authorized bucket.
 * Picked stock is already outside on-hand and is never deducted twice.
 */
export function planShipmentLotDepletion(
  input: ShipmentLotDepletionRequest,
  inputLots: readonly ShipmentLotBalance[],
): ShipmentLotDepletion[] {
  const request = shipmentLotDepletionRequestSchema.safeParse(input);
  const parsedLots = z.array(lotSchema).safeParse(inputLots);
  if (!request.success || !parsedLots.success) {
    throw new ValidationError("Invalid shipment bucket or lot evidence.");
  }
  const lots = parsedLots.data.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id - b.id);
  if (new Set(lots.map((lot) => lot.id)).size !== lots.length) {
    throw new ValidationError("Shipment lot evidence contains duplicate identities.");
  }
  const plan = new Map<number, ShipmentLotDepletion>();
  const allocation = (lot: ShipmentLotBalance): ShipmentLotDepletion => {
    let row = plan.get(lot.id);
    if (!row) {
      row = { lotId: lot.id, fromPicked: 0, fromOnHand: 0, reservedToRelease: 0,
        expectedOnHand: lot.qtyOnHand, expectedReserved: lot.qtyReserved,
        expectedPicked: lot.qtyPicked, expectedStatus: lot.status };
      plan.set(lot.id, row);
    }
    return row;
  };
  let pickedRemaining = request.data.fromPicked;
  let reservedRemaining = request.data.reservedToRelease;
  let unreservedRemaining = request.data.fromOnHand - request.data.reservedToRelease;
  for (const lot of lots) {
    const take = Math.min(lot.qtyPicked, pickedRemaining);
    if (take > 0) allocation(lot).fromPicked += take;
    pickedRemaining -= take;
  }
  for (const lot of lots) {
    if (lot.status !== "active") continue;
    const take = Math.min(lot.qtyReserved, reservedRemaining);
    if (take > 0) {
      allocation(lot).fromOnHand += take;
      allocation(lot).reservedToRelease += take;
    }
    reservedRemaining -= take;
  }
  for (const lot of lots) {
    if (lot.status !== "active") continue;
    const take = Math.min(lot.qtyOnHand - lot.qtyReserved, unreservedRemaining);
    if (take > 0) allocation(lot).fromOnHand += take;
    unreservedRemaining -= take;
  }
  if (pickedRemaining !== 0 || reservedRemaining !== 0 || unreservedRemaining !== 0) {
    throw new ShipmentLotConflictError("LOT_SHIPMENT_SHORTFALL",
      "Lot inventory cannot satisfy the exact shipment buckets; no partial shipment may commit.", {
        productVariantId: request.data.productVariantId,
        warehouseLocationId: request.data.warehouseLocationId,
        missingPicked: pickedRemaining, missingReserved: reservedRemaining,
        missingUnreservedOnHand: unreservedRemaining,
      });
  }
  return [...plan.values()].sort((a, b) => a.lotId - b.lotId);
}
