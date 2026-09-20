import { INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_MAX_VARIANTS } from "../../../../shared/types/inventory-channel-exposure";
import { InventoryPublicationTargetVariantHoldService } from "../../inventory-planning/application/inventory-publication-target-variant-hold.service";
import { InventoryAvailabilityMasterDataError } from "../../inventory-planning/domain/inventory-availability-master-data.contracts";
import { PostgresInventoryPublicationTargetVariantHoldStore } from "../../inventory-planning/infrastructure/inventory-publication-target-variant-hold.repository";
import type {
  DropshipListingVariantHoldGate,
  DropshipListingVariantHoldGateOutcome,
} from "../application/dropship-listing-tier-service";

/**
 * Dropship's view of the inventory-planning SKU-level publication hold.
 * Quantity is canonical and owned by inventory planning; Dropship never writes
 * a zero to a marketplace itself. It asks the command to keep the named SKUs
 * of a store connection's live targets publishing at zero, and the release
 * command to restore them, while the rest of the store keeps selling.
 *
 * A refusal the command itself classifies as retryable (a provider quantity
 * request in flight, a concurrent target change, uncertain cleanup) is
 * reported as not applied so the listing tier reconciler tries again on the
 * next tick. Anything else is a bug or a configuration fault and propagates.
 */
const DEFAULT_ACTOR_ID = "dropship-listing-tiers";
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([409, 503]);

export class InventoryPlanningDropshipListingVariantHoldGate implements DropshipListingVariantHoldGate {
  readonly maxVariantsPerCommand = INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_MAX_VARIANTS;

  constructor(
    private readonly deps: {
      holdService: Pick<InventoryPublicationTargetVariantHoldService, "holdVariants" | "releaseVariants">;
      actorId?: string;
    },
  ) {}

  holdVariants(input: {
    storeConnectionId: number;
    productVariantIds: readonly number[];
    reason: string;
    idempotencyKey: string;
  }): Promise<DropshipListingVariantHoldGateOutcome> {
    return this.apply("hold", input);
  }

  releaseVariants(input: {
    storeConnectionId: number;
    productVariantIds: readonly number[];
    reason: string;
    idempotencyKey: string;
  }): Promise<DropshipListingVariantHoldGateOutcome> {
    return this.apply("release", input);
  }

  private async apply(
    command: "hold" | "release",
    input: { storeConnectionId: number; productVariantIds: readonly number[]; reason: string; idempotencyKey: string },
  ): Promise<DropshipListingVariantHoldGateOutcome> {
    const request = {
      destination: { destinationKind: "dropship_store_connection" as const, connectionId: input.storeConnectionId },
      productVariantIds: [...input.productVariantIds],
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    };
    try {
      const result = command === "hold"
        ? await this.deps.holdService.holdVariants(request, this.deps.actorId ?? DEFAULT_ACTOR_ID)
        : await this.deps.holdService.releaseVariants(request, this.deps.actorId ?? DEFAULT_ACTOR_ID);
      const blocked = new Set<number>();
      const changed = new Set<number>();
      let publicationRows = 0;
      for (const target of result.targets) {
        publicationRows += target.publicationRows;
        for (const productId of target.blockedProductIds) blocked.add(productId);
        for (const productVariantId of target.changedProductVariantIds) changed.add(productVariantId);
      }
      return {
        applied: true,
        targetCount: result.targets.length,
        publicationRows,
        changedProductVariantIds: [...changed].sort((a, b) => a - b),
        blockedProductIds: [...blocked].sort((a, b) => a - b),
      };
    } catch (error) {
      if (error instanceof InventoryAvailabilityMasterDataError && RETRYABLE_STATUSES.has(error.status)) {
        return { applied: false, code: error.code, message: error.message };
      }
      throw error;
    }
  }
}

export function createDropshipListingVariantHoldGateFromEnv(): DropshipListingVariantHoldGate {
  return new InventoryPlanningDropshipListingVariantHoldGate({
    holdService: new InventoryPublicationTargetVariantHoldService(new PostgresInventoryPublicationTargetVariantHoldStore()),
  });
}
