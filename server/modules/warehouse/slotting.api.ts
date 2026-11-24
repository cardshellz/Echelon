/**
 * Single-Owner Slotting & Atomic Slot-Relocation Command Contract (`WH-2` / `CI-03`)
 *
 * Canonical entry point for:
 *   1. Assigning a SKU/variant's Primary Pick Bin (`1 Primary Pick Bin / SKU / Warehouse`)
 *   2. Relocating a Primary Pick Bin ("Move Slot & Stock Together") — atomically moving
 *      FIFO lots, reservations, `product_locations`, `location_replen_configs`, open
 *      `replen_tasks`, and pending unpicked `wms.order_items`.
 *
 * NOTE: Never re-export this file from `warehouse/index.ts` (`CI-03`).
 */
import type {
  BinAssignmentService,
  RelocatePickSlotRequest,
  RelocatePickSlotResult,
} from "./application/bin-assignment.service";
import type { BinAssignmentWriteRequest } from "./domain/bin-assignment-contracts";
import type { ProductLocation } from "@shared/schema";

export {
  createBinAssignmentService,
  type BinAssignmentService,
  type RelocatePickSlotRequest,
  type RelocatePickSlotResult,
} from "./application/bin-assignment.service";

export {
  BinAssignmentValidationError,
  PRIMARY_SLOT_FLAG,
  parseBinAssignmentWriteRequest,
  parseSlotPrimaryFlag,
  type BinAssignmentWriteRequest,
} from "./domain/bin-assignment-contracts";

export async function assignPrimaryPickSlot(
  owner: Pick<BinAssignmentService, "assignVariantToLocation">,
  params: BinAssignmentWriteRequest,
): Promise<ProductLocation> {
  return owner.assignVariantToLocation(params);
}

export async function relocatePickSlot(
  owner: Pick<BinAssignmentService, "relocatePickSlot">,
  params: RelocatePickSlotRequest,
): Promise<RelocatePickSlotResult> {
  return owner.relocatePickSlot(params);
}
