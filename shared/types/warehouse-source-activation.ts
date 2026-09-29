import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);

/** Exact source identity reviewed for activation; no stock/provider ownership is changed. */
export const warehouseSourceActivationEvidenceSchema = z.object({
  nodeId: id,
  warehouseId: id,
  nodeType: z.enum(["internal_warehouse", "third_party_logistics", "virtual"]),
  inventoryAuthority: z.enum(["echelon", "external_provider", "manual"]),
  fulfillmentAuthority: z.enum(["echelon", "external_provider", "none"]),
  providerAccountId: id.nullable(),
  providerLocationId: id.nullable(),
  lifecycleStatus: z.enum(["draft", "active", "retired"]),
  warehouseActive: z.union([z.literal(0), z.literal(1)]),
}).strict().refine(value => (value.providerAccountId === null) === (value.providerLocationId === null),
  "Provider identity must be absent or complete.");

export type WarehouseSourceActivationEvidence = z.infer<typeof warehouseSourceActivationEvidenceSchema>;
