import { InventoryPublicationTargetHoldService } from "../../inventory-planning/application/inventory-publication-target-hold.service";
import { InventoryAvailabilityMasterDataError } from "../../inventory-planning/domain/inventory-availability-master-data.contracts";
import { PostgresInventoryPublicationTargetHoldStore } from "../../inventory-planning/infrastructure/inventory-publication-target-hold.repository";
import type {
  DropshipListingHoldGate,
  DropshipListingHoldGateOutcome,
} from "../application/dropship-vendor-standing-service";

/**
 * Dropship's view of the inventory-planning publication hold. Quantity is
 * canonical and owned by inventory planning; Dropship never writes a zero to
 * a marketplace itself. It asks the hold command to keep a store connection's
 * live targets publishing at zero, and the release command to restore them.
 *
 * A refusal the command itself classifies as retryable (a provider quantity
 * request in flight, a concurrent target change, uncertain cleanup) is
 * reported as not applied so the standing reconciler tries again on the next
 * tick. Anything else is a bug or a configuration fault and propagates.
 */
const DEFAULT_ACTOR_ID = "dropship-vendor-standing";
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([409, 503]);

export class InventoryPlanningDropshipListingHoldGate implements DropshipListingHoldGate {
  constructor(
    private readonly deps: {
      holdService: Pick<InventoryPublicationTargetHoldService, "hold" | "release">;
      actorId?: string;
    },
  ) {}

  hold(input: { storeConnectionId: number; reason: string; idempotencyKey: string }): Promise<DropshipListingHoldGateOutcome> {
    return this.apply("hold", input);
  }

  release(input: { storeConnectionId: number; reason: string; idempotencyKey: string }): Promise<DropshipListingHoldGateOutcome> {
    return this.apply("release", input);
  }

  private async apply(
    command: "hold" | "release",
    input: { storeConnectionId: number; reason: string; idempotencyKey: string },
  ): Promise<DropshipListingHoldGateOutcome> {
    const request = {
      destination: { destinationKind: "dropship_store_connection" as const, connectionId: input.storeConnectionId },
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    };
    try {
      const result = command === "hold"
        ? await this.deps.holdService.hold(request, this.deps.actorId ?? DEFAULT_ACTOR_ID)
        : await this.deps.holdService.release(request, this.deps.actorId ?? DEFAULT_ACTOR_ID);
      const blocked = new Set<number>();
      let publicationRows = 0;
      for (const target of result.targets) {
        publicationRows += target.publicationRows;
        for (const productId of target.blockedProductIds) blocked.add(productId);
      }
      return {
        applied: true,
        targetCount: result.targets.length,
        publicationRows,
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

export function createDropshipListingHoldGateFromEnv(): DropshipListingHoldGate {
  return new InventoryPlanningDropshipListingHoldGate({
    holdService: new InventoryPublicationTargetHoldService(new PostgresInventoryPublicationTargetHoldStore()),
  });
}
