import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const text = (max: number) => z.string().trim().min(1).max(max);
export const warehouseInventoryAuthoritySchema = z.enum(["echelon", "external_provider", "manual"]);
export const warehouseFulfillmentAuthoritySchema = z.enum(["echelon", "external_provider", "none"]);
export const warehouseInventorySourceWarehouseSchema = z.object({
  id,
  code: text(60).regex(/^[A-Z0-9][A-Z0-9_-]{0,59}$/),
  name: text(200),
  warehouseType: z.enum(["operations", "bulk_storage", "3pl"]),
  inventorySourceType: text(20),
  isActive: z.union([z.literal(0), z.literal(1)]),
}).strict();
export const warehouseInventorySourceSummarySchema = z.object({
  id,
  lifecycleStatus: z.enum(["draft", "active"]),
  inventoryAuthority: warehouseInventoryAuthoritySchema,
  fulfillmentAuthority: warehouseFulfillmentAuthoritySchema,
}).strict();
export const warehouseInventorySourceViewSchema = z.object({
  warehouses: z.array(warehouseInventorySourceWarehouseSchema.extend({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    source: warehouseInventorySourceSummarySchema.nullable(),
  }).strict()),
}).strict();
export const prepareWarehouseInventorySourceRequestSchema = z.object({
  warehouseId: id,
  expectedWarehouseFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  inventoryAuthority: warehouseInventoryAuthoritySchema,
  fulfillmentAuthority: warehouseFulfillmentAuthoritySchema,
  changeReason: text(1000),
  idempotencyKey: text(120),
}).strict();
export const prepareWarehouseInventorySourceResultSchema = z.object({
  fulfillmentNodeId: id,
  warehouseId: id,
  lifecycleStatus: z.literal("draft"),
  alreadyApplied: z.boolean(),
  runtimeAuthorityChanged: z.literal(false),
  providerWriteAttempted: z.literal(false),
  outboxEnqueued: z.literal(false),
}).strict();

export type WarehouseInventorySourceWarehouse = z.infer<typeof warehouseInventorySourceWarehouseSchema>;
export type WarehouseInventorySourceSummary = z.infer<typeof warehouseInventorySourceSummarySchema>;
export type WarehouseInventorySourceView = z.infer<typeof warehouseInventorySourceViewSchema>;
export type PrepareWarehouseInventorySourceRequest = z.infer<typeof prepareWarehouseInventorySourceRequestSchema>;
export type PrepareWarehouseInventorySourceResult = z.infer<typeof prepareWarehouseInventorySourceResultSchema>;
