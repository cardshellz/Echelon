import { z } from "zod";

/** Exact package units, not base-piece equivalents. Reserved overlaps onHand. */
export const MAX_INVENTORY_QUANTITY = 2_147_483_647;
const id = z.number().int().positive().max(MAX_INVENTORY_QUANTITY);
const quantity = z.number().int().nonnegative().max(MAX_INVENTORY_QUANTITY);
const delta = z.number().int().min(-MAX_INVENTORY_QUANTITY).max(MAX_INVENTORY_QUANTITY);
const text = (max: number) => z.string().trim().min(1).max(max);

export const quantityBalanceSchema = z.object({
  onHand: quantity, reserved: quantity, picked: quantity, packed: quantity,
}).strict().refine(balance => balance.reserved <= balance.onHand, {
  message: "Reserved units are a hold on on-hand units, not additional physical stock",
});
export type QuantityBalance = z.infer<typeof quantityBalanceSchema>;

export const quantityIdentitySchema = z.object({
  inventoryLotId: id, inventoryLevelId: id, productVariantId: id,
  warehouseLocationId: id, warehouseId: id,
}).strict();
export type QuantityIdentity = z.infer<typeof quantityIdentitySchema>;

export const quantityMovementSchema = quantityIdentitySchema.extend({
  delta: z.object({ onHand: delta, reserved: delta, picked: delta, packed: delta }).strict(),
}).strict();
export type QuantityMovement = z.infer<typeof quantityMovementSchema>;

export const quantityCommandSchema = z.object({
  contractVersion: z.literal("inventory_quantity_v1"),
  idempotencyKey: text(200),
  kind: z.enum(["opening", "receive", "receipt_reversal", "reserve", "release", "pick",
    "unpick", "pack", "unpack", "ship", "transfer", "transform", "return", "adjust"]),
  actor: text(100), reason: text(1000), occurredAt: z.string().datetime(),
  reference: z.object({ type: text(100), id: text(200) }).strict(),
  // Reversal is another posting, never mutation/deletion of a prior event.
  reversesCommandId: z.string().regex(/^[1-9][0-9]{0,18}$/)
    .refine(value => BigInt(value) <= BigInt("9223372036854775807")).nullable(),
  movements: z.array(quantityMovementSchema).max(50_000),
}).strict();
export type QuantityCommand = z.infer<typeof quantityCommandSchema>;

export class InventoryQuantityError extends Error {
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "InventoryQuantityError";
  }
}

/** Validate semantic intent before any persistence; never mutate a caller's plan. */
export function normalizeQuantityCommand(input: unknown): QuantityCommand {
  const parsed = quantityCommandSchema.safeParse(input);
  if (!parsed.success) throw new InventoryQuantityError("QUANTITY_COMMAND_INVALID", "Invalid inventory posting contract", {
    issues: parsed.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })),
  });
  const command = parsed.data;
  if (command.movements.length === 0 && command.kind !== "opening") {
    throw new InventoryQuantityError("QUANTITY_MOVEMENT_REQUIRED", "An operational posting requires a quantity movement");
  }
  const lots = new Set<number>();
  const levels = new Map<number, string>();
  const cells = new Map<string, number>();
  for (const movement of command.movements) {
    const { inventoryLotId, inventoryLevelId, warehouseId, warehouseLocationId, productVariantId, delta: d } = movement;
    const cell = `${warehouseId}:${warehouseLocationId}:${productVariantId}`;
    if (lots.has(inventoryLotId) || (levels.has(inventoryLevelId) && levels.get(inventoryLevelId) !== cell)
      || (cells.has(cell) && cells.get(cell) !== inventoryLevelId)) {
      throw new InventoryQuantityError("QUANTITY_IDENTITY_CONFLICT", "Each lot and SKU/location must have one exact identity", { inventoryLotId, inventoryLevelId });
    }
    lots.add(inventoryLotId); levels.set(inventoryLevelId, cell); cells.set(cell, inventoryLevelId);
    const zero = d.onHand === 0 && d.reserved === 0 && d.picked === 0 && d.packed === 0;
    const onlyOnHand = d.reserved === 0 && d.picked === 0 && d.packed === 0;
    let valid: boolean;
    switch (command.kind) {
      case "opening": valid = Object.values(d).every(value => value >= 0) && d.reserved <= d.onHand; break;
      case "receive": case "return": valid = onlyOnHand && d.onHand > 0; break;
      case "receipt_reversal": valid = onlyOnHand && d.onHand < 0; break;
      case "reserve": valid = d.onHand === 0 && d.reserved > 0 && d.picked === 0 && d.packed === 0; break;
      case "release": valid = d.onHand === 0 && d.reserved < 0 && d.picked === 0 && d.packed === 0; break;
      case "pick": valid = d.onHand < 0 && d.picked === -d.onHand && d.packed === 0
        && d.reserved <= 0 && d.reserved >= d.onHand; break;
      case "unpick": valid = d.onHand > 0 && d.picked === -d.onHand && d.packed === 0
        && d.reserved >= 0 && d.reserved <= d.onHand; break;
      case "pack": valid = d.onHand === 0 && d.reserved === 0 && d.picked < 0 && d.packed === -d.picked; break;
      case "unpack": valid = d.onHand === 0 && d.reserved === 0 && d.packed < 0 && d.picked === -d.packed; break;
      case "ship": valid = d.onHand <= 0 && d.reserved <= 0 && d.reserved >= d.onHand
        && d.picked <= 0 && d.packed <= 0; break;
      // The caller's reviewed physical observation or transformation plan owns
      // these changes. Base-piece/build conservation cannot be inferred from SKU IDs.
      case "adjust": case "transform": case "transfer": valid = true; break;
    }
    if (!valid || (zero && command.kind !== "opening")) {
      throw new InventoryQuantityError("QUANTITY_MOVEMENT_INVALID", "Quantity buckets do not represent the declared operation", { kind: command.kind, inventoryLotId });
    }
  }
  if (command.kind === "transfer") {
    const totals = new Map<number, bigint[]>();
    for (const movement of command.movements) {
      const sum = totals.get(movement.productVariantId) ?? [BigInt(0), BigInt(0), BigInt(0), BigInt(0)];
      const d = movement.delta;
      [d.onHand, d.reserved, d.picked, d.packed].forEach((value, index) => { sum[index] += BigInt(value); });
      totals.set(movement.productVariantId, sum);
    }
    if ([...totals.values()].some(sum => sum.some(value => value !== BigInt(0)))) {
      throw new InventoryQuantityError("QUANTITY_TRANSFER_NOT_BALANCED", "A transfer must conserve every custody bucket per exact SKU");
    }
  }
  return { ...command, movements: [...command.movements].sort((a,b) =>
    a.inventoryLevelId - b.inventoryLevelId || a.inventoryLotId - b.inventoryLotId) };
}

export function applyQuantityDelta(balance: QuantityBalance, movement: QuantityMovement): QuantityBalance {
  quantityBalanceSchema.parse(balance);
  const next = Object.fromEntries((Object.keys(balance) as (keyof QuantityBalance)[]).map(bucket => {
    const value = BigInt(balance[bucket]) + BigInt(movement.delta[bucket]);
    if (value < BigInt(0) || value > BigInt(MAX_INVENTORY_QUANTITY)) {
      throw new InventoryQuantityError("QUANTITY_BALANCE_OUT_OF_RANGE", "The posting would produce invalid physical custody", {
        inventoryLotId: movement.inventoryLotId, bucket, before: balance[bucket], delta: movement.delta[bucket],
      });
    }
    return [bucket, Number(value)];
  })) as QuantityBalance;
  if (next.reserved > next.onHand) throw new InventoryQuantityError("QUANTITY_RESERVED_EXCEEDS_ON_HAND",
    "The posting would consume stock still held by another owner", { inventoryLotId: movement.inventoryLotId });
  return next;
}

export const emptyQuantityBalance = (): QuantityBalance => ({ onHand: 0, reserved: 0, picked: 0, packed: 0 });

/** A replay is a pure fold of the immutable journal, including custody, not only on-hand. */
export function replayQuantityMovements(movements: readonly QuantityMovement[]): ReadonlyMap<number, QuantityBalance> {
  const result = new Map<number, QuantityBalance>();
  const identities = new Map<number, string>();
  for (const raw of movements) {
    const movement = quantityMovementSchema.parse(raw);
    const identity = JSON.stringify(quantityIdentitySchema.parse({ inventoryLotId: movement.inventoryLotId,
      inventoryLevelId: movement.inventoryLevelId, productVariantId: movement.productVariantId,
      warehouseLocationId: movement.warehouseLocationId, warehouseId: movement.warehouseId }));
    if (identities.has(movement.inventoryLotId) && identities.get(movement.inventoryLotId) !== identity) {
      throw new InventoryQuantityError("QUANTITY_IDENTITY_CONFLICT", "A lot cannot change identity across journal postings");
    }
    identities.set(movement.inventoryLotId, identity);
    result.set(movement.inventoryLotId, applyQuantityDelta(result.get(movement.inventoryLotId) ?? emptyQuantityBalance(), movement));
  }
  return result;
}
