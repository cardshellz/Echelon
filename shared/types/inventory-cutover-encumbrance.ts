import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const bigintId = z.string().regex(/^[1-9][0-9]*$/).max(19);
// Preserve negative database evidence for review; never hide corruption by clamping.
const quantity = z.string().regex(/^(?:0|-?[1-9][0-9]*)$/).max(80);
const text = z.string().min(1).max(100);

export const inventoryCutoverLevelSchema = z.object({
  inventoryLevelId: id,
  warehouseLocationId: id,
  productVariantId: id,
  variantQty: quantity,
  reservedQty: quantity,
  pickedQty: quantity,
  packedQty: quantity,
}).strict();

export const inventoryCutoverBuildReservationSchema = z.object({
  reservationId: id,
  buildOrderComponentId: id,
  buildOrderId: id.nullable(),
  buildOrderStatus: text.nullable(),
  warehouseId: id.nullable(),
  componentVariantId: id.nullable(),
  sourceLocationId: id.nullable(),
  inventoryLotId: id,
  lotVariantId: id.nullable(),
  lotLocationId: id.nullable(),
  lotQtyReserved: quantity.nullable(),
  reservedQty: quantity,
  consumedQty: quantity,
  releasedQty: quantity,
  reservationOwner: text,
  availabilityClaimId: bigintId.nullable(),
  availabilityClaimLotAllocationId: bigintId.nullable(),
  claimLotResourceId: bigintId.nullable(),
  claimLotInventoryLotId: id.nullable(),
  claimLotOpenQty: quantity.nullable(),
}).strict();

export const inventoryCutoverCanonicalResourceSchema = z.object({
  claimResourceId: bigintId,
  claimId: bigintId,
  claimStatus: text.nullable(),
  orderId: id.nullable(),
  claimLineId: bigintId,
  orderItemId: id.nullable(),
  targetVariantId: id.nullable(),
  warehouseId: id,
  warehouseLocationId: id,
  inventoryLevelId: id,
  sourceVariantId: id,
  claimedQty: quantity,
  releasedQty: quantity,
  consumedQty: quantity,
  pickedQty: quantity,
}).strict();

export const inventoryCutoverEncumbranceSchema = z.object({
  schemaVersion: z.literal("inventory_cutover_encumbrance_v1"),
  inventoryLevels: z.array(inventoryCutoverLevelSchema).max(50_000),
  buildReservations: z.array(inventoryCutoverBuildReservationSchema).max(50_000),
  canonicalResources: z.array(inventoryCutoverCanonicalResourceSchema).max(50_000),
  canonicalTablesStatus: z.enum(["captured", "not_installed"]),
  totals: z.object({
    quantitySemantics: z.literal("mixed_sku_units_not_atp"),
    inventoryLevelCount: z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(30),
    variantQty: quantity,
    reservedQty: quantity,
    pickedQty: quantity,
    packedQty: quantity,
  }).strict(),
  attributionCaveats: z.tuple([
    z.literal("legacy_order_reservation_attribution_not_captured"),
    z.literal("picked_packed_custody_not_attributed"),
    z.literal("build_claim_hold_overlap_requires_deduplication"),
    z.literal("unexplained_reserved_balance_is_not_free_supply"),
  ]),
}).strict();

export type InventoryCutoverEncumbranceDto = z.infer<typeof inventoryCutoverEncumbranceSchema>;
export type InventoryCutoverLevelDto = z.infer<typeof inventoryCutoverLevelSchema>;
export type InventoryCutoverBuildReservationDto = z.infer<typeof inventoryCutoverBuildReservationSchema>;
export type InventoryCutoverCanonicalResourceDto = z.infer<typeof inventoryCutoverCanonicalResourceSchema>;
