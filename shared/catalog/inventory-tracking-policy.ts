import { z } from "zod";

export const inventoryTrackingPolicySchema = z.object({
  inventoryTrackingDefault: z.boolean(),
  inventoryTrackingOverride: z.boolean().nullable(),
  requiresShipping: z.boolean(),
});

export type InventoryTrackingPolicy = z.infer<typeof inventoryTrackingPolicySchema>;

/** Shipping eligibility is independent: a digital item never owns warehouse stock. */
export function resolveInventoryTrackingPolicy(input: InventoryTrackingPolicy): boolean {
  const policy = inventoryTrackingPolicySchema.parse(input);
  return policy.requiresShipping
    && (policy.inventoryTrackingOverride ?? policy.inventoryTrackingDefault);
}

/** The old API's explicit boolean remains an explicit override, in either direction. */
export function parseInventoryTrackingWrite(input: unknown): {
  inventoryTrackingOverride?: boolean | null;
} {
  const source = z.object({
    inventoryTrackingOverride: z.boolean().nullable().optional(),
    trackInventory: z.boolean().optional(),
  }).parse(input);
  if (source.inventoryTrackingOverride !== undefined && source.trackInventory !== undefined) {
    throw new Error("Supply inventoryTrackingOverride or trackInventory, not both");
  }
  const override = source.inventoryTrackingOverride !== undefined
    ? source.inventoryTrackingOverride : source.trackInventory;
  return override === undefined ? {} : { inventoryTrackingOverride: override };
}
