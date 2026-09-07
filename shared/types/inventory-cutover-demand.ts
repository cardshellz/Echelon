import { z } from "zod";

const integer = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const id = integer.positive();
const bigintId = z.string().regex(/^[1-9][0-9]{0,18}$/).pipe(z.string()
  .refine((value) => BigInt(value) <= BigInt("9223372036854775807"), "Identifier exceeds PostgreSQL bigint"));
const text = z.string().nullable();

export const wmsCutoverDemandOrderSchema = z.object({
  id, warehouseId: id.nullable(), status: text, onHold: integer,
  channelId: id.nullable(), source: text, externalOrderId: text,
  omsFulfillmentOrderId: text, fulfillmentPartitionKey: text,
}).strict();
export const wmsCutoverDemandItemSchema = z.object({
  id, orderId: id, omsOrderLineId: bigintId.nullable(), sourceItemId: text,
  sku: z.string(), productId: id.nullable(), quantity: integer,
  pickedQuantity: integer, fulfilledQuantity: integer, status: text,
  onHold: z.boolean(), requiresShipping: integer, location: text, shortReason: text,
}).strict();
export const wmsCutoverSourceItemSchema = z.object({
  id, shipmentId: id, headerOrderId: id.nullable(), orderItemId: id.nullable(),
  replacementForOrderItemId: id.nullable(), correctionForShipmentItemId: id.nullable(),
  productVariantId: id.nullable(), quantity: integer, purpose: text,
  fromLocationId: id.nullable(), shipmentStatus: text, shipmentHeld: z.boolean().nullable(),
}).strict();
export const wmsCutoverPhysicalItemSchema = z.object({
  id: bigintId, physicalShipmentId: bigintId, orderItemId: id.nullable(),
  replacementForOrderItemId: id.nullable(), legacySourceShipmentItemId: id.nullable(),
  packageAllocationEntryId: bigintId.nullable(), productVariantId: id.nullable(), sku: z.string(),
  originalQuantity: integer, adjustmentQuantity: integer,
  effectiveQuantity: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
  purpose: text, packageStatus: text,
}).strict();

/** Observed WMS facts only. Progress counters and shipped units are NOT picked custody. */
export const wmsCutoverDemandCaptureSchema = z.object({
  schemaVersion: z.literal("wms_inventory_cutover_demand_v1"),
  scope: z.literal("nonterminal_wms_orders"),
  capturedAt: z.string().datetime(),
  excludedTerminalOrderCount: z.string().regex(/^(0|[1-9][0-9]*)$/),
  orders: z.array(wmsCutoverDemandOrderSchema).max(10_000),
  items: z.array(wmsCutoverDemandItemSchema).max(50_000),
  sourceItems: z.array(wmsCutoverSourceItemSchema).max(100_000),
  physicalItems: z.array(wmsCutoverPhysicalItemSchema).max(100_000),
}).strict();

export type WmsCutoverDemandCapture = z.infer<typeof wmsCutoverDemandCaptureSchema>;
export type WmsCutoverDemandOrder = z.infer<typeof wmsCutoverDemandOrderSchema>;
export type WmsCutoverDemandItem = z.infer<typeof wmsCutoverDemandItemSchema>;
export type WmsCutoverSourceItem = z.infer<typeof wmsCutoverSourceItemSchema>;
export type WmsCutoverPhysicalItem = z.infer<typeof wmsCutoverPhysicalItemSchema>;
