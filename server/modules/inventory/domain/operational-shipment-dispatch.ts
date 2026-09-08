import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.number().int().nonnegative().max(2_147_483_647);
const mills = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= BigInt("9223372036854775807"));
export const operationalShipmentRequestSchema = z.object({
  orderId: id, outboundShipmentId: id, sourceShipmentItemId: id,
  productVariantId: id, quantity: id, actor: z.string().trim().min(1).max(100),
}).strict();
export type OperationalShipmentRequest = z.infer<typeof operationalShipmentRequestSchema>;
export interface OperationalShipmentSource {
  readonly warehouseId: number;
  readonly purpose: "replacement" | "concession";
  readonly replacementForOrderItemId: number | null;
  readonly physicalShipmentItemId: string | null;
}
export interface OperationalShipmentResult {
  readonly warehouseLocationId: number;
  readonly alreadyRecorded: boolean;
  readonly preserveSourceLocation: true;
}
export class OperationalShipmentError extends Error {
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message); this.name = "OperationalShipmentError";
  }
}
const levelSchema = z.object({ id, locationId: id, onHand: quantity, reserved: quantity }).strict();
const lotSchema = z.object({ id, onHand: quantity, reserved: quantity,
  unitCostMills: mills, receivedAt: z.date() }).strict();
export type OperationalShipmentLevel = z.infer<typeof levelSchema>;
export type OperationalShipmentLot = z.infer<typeof lotSchema>;
export interface OperationalShipmentPlan {
  readonly level: OperationalShipmentLevel;
  readonly quantity: number;
  readonly totalCostMills: string;
  readonly lots: readonly { lotId: number; quantity: number; unitCostMills: string; totalCostMills: string }[];
}

/** Exact available stock only. On-hand already excludes picked custody. */
export function planOperationalShipmentConsumption(
  requestedQuantity: number, rawLevel: OperationalShipmentLevel, rawLots: readonly OperationalShipmentLot[],
): OperationalShipmentPlan | null {
  const requested = id.parse(requestedQuantity);
  const level = levelSchema.parse(rawLevel);
  if (level.reserved > level.onHand) throw new OperationalShipmentError("OPERATIONAL_SHIPMENT_BALANCE_INVALID", "Reserved stock exceeds on-hand.");
  if (level.onHand - level.reserved < requested) return null;
  if (rawLots.length > 10_000) throw new OperationalShipmentError("OPERATIONAL_SHIPMENT_EVIDENCE_LIMIT", "FIFO source exceeds the supported complete-snapshot bound.");
  const lots = rawLots.map((lot) => lotSchema.parse(lot))
    .sort((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime() || left.id - right.id);
  if (new Set(lots.map((lot) => lot.id)).size !== lots.length) {
    throw new OperationalShipmentError("OPERATIONAL_SHIPMENT_LOT_IDENTITY_INVALID", "FIFO source includes duplicate lots.");
  }
  let remaining = requested;
  let total = BigInt(0);
  const allocations: OperationalShipmentPlan["lots"][number][] = [];
  for (const lot of lots) {
    if (lot.reserved > lot.onHand) throw new OperationalShipmentError("OPERATIONAL_SHIPMENT_BALANCE_INVALID", "Reserved lot stock exceeds on-hand.");
    const take = Math.min(lot.onHand - lot.reserved, remaining);
    if (take === 0) continue;
    const cost = BigInt(take) * BigInt(lot.unitCostMills);
    total += cost;
    if (total > BigInt("9223372036854775807")) {
      throw new OperationalShipmentError("OPERATIONAL_SHIPMENT_COST_OVERFLOW", "Exact shipment cost exceeds the PostgreSQL bigint boundary.");
    }
    allocations.push({ lotId: lot.id, quantity: take, unitCostMills: lot.unitCostMills, totalCostMills: String(cost) });
    remaining -= take;
    if (remaining === 0) break;
  }
  if (remaining !== 0) return null;
  return Object.freeze({ level, quantity: requested, totalCostMills: String(total), lots: Object.freeze(allocations) });
}
