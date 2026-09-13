import { z } from "zod";

/**
 * Live inventory runtime authority readout.
 *
 * Source of truth is the `inventory.availability_runtime_authority` singleton
 * (migrations/0638_inventory_availability_cutover.sql). The quantity publication
 * runtime branches on the persisted `authority` value
 * (server/modules/inventory-planning/infrastructure/quantity-publication-runtime.ts,
 * createQuantityPublicationCatchupService): `legacy` refreshes channel quantities
 * through the legacy channel adapters that are fed by Channel Allocation rules,
 * `canonical` plans quantities from Inventory Exposure, and any other value is
 * refused with PUBLICATION_AUTHORITY_MISSING. This contract refuses it too rather
 * than guessing which allocator is live.
 */

/** Positive Postgres BIGINT carried as text so no precision is lost in JSON. */
const positiveBigintString = z.string().regex(/^[1-9][0-9]{0,18}$/);

export const INVENTORY_RUNTIME_AUTHORITY_READOUT_PATH = "/api/inventory-planning/runtime-authority";
export const INVENTORY_RUNTIME_AUTHORITY_READOUT_CONTRACT_VERSION = "inventory_runtime_authority_readout_v1";

export const INVENTORY_RUNTIME_AUTHORITIES = ["legacy", "canonical"] as const;
export const inventoryRuntimeAuthoritySchema = z.enum(INVENTORY_RUNTIME_AUTHORITIES);
export type InventoryRuntimeAuthority = z.infer<typeof inventoryRuntimeAuthoritySchema>;

export const inventoryRuntimeAuthorityRevisionSchema = positiveBigintString;

/** The allocator whose output the publication runtime pushes to providers. */
export const INVENTORY_LIVE_ALLOCATORS = ["channel_allocation_rules", "inventory_exposure"] as const;
export const inventoryLiveAllocatorSchema = z.enum(INVENTORY_LIVE_ALLOCATORS);
export type InventoryLiveAllocator = z.infer<typeof inventoryLiveAllocatorSchema>;

/** Pure mapping from the persisted authority to the allocator that publishes quantities. */
export function liveAllocatorForAuthority(authority: InventoryRuntimeAuthority): InventoryLiveAllocator {
  return authority === "canonical" ? "inventory_exposure" : "channel_allocation_rules";
}

export const inventoryRuntimeAuthorityReadoutSchema = z.object({
  contractVersion: z.literal(INVENTORY_RUNTIME_AUTHORITY_READOUT_CONTRACT_VERSION),
  authority: inventoryRuntimeAuthoritySchema,
  liveAllocator: inventoryLiveAllocatorSchema,
  revision: inventoryRuntimeAuthorityRevisionSchema,
  activationRunId: positiveBigintString.nullable(),
  changedBy: z.string().trim().min(1).max(100),
  changeReason: z.string().trim().min(1).max(1000),
  changedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((readout, context) => {
  // Mirrors availability_runtime_authority_activation_chk: legacy has no
  // activation run and canonical always names the run that activated it.
  const lineageValid = readout.authority === "legacy"
    ? readout.activationRunId === null
    : readout.activationRunId !== null;
  if (!lineageValid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activationRunId"],
      message: "Activation run lineage does not match the persisted authority.",
    });
  }
  if (readout.liveAllocator !== liveAllocatorForAuthority(readout.authority)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["liveAllocator"],
      message: "Live allocator does not match the persisted authority.",
    });
  }
});
export type InventoryRuntimeAuthorityReadout = z.infer<typeof inventoryRuntimeAuthorityReadoutSchema>;
