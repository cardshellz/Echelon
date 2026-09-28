import { makeDropshipCostChangePolicyLogger, systemDropshipCostChangePolicyClock } from "../application/dropship-cost-change-policy-service";
import {
  COST_CHANGE_HOLD_ACTOR_ID,
  DropshipCostChangeListingActionService,
  type CostChangeRepriceOutcome,
  type DropshipCostChangeRepricePort,
} from "../application/dropship-cost-change-listing-action-service";
import type { DropshipListingPreviewService } from "../application/dropship-listing-preview-service";
import { DropshipError } from "../domain/errors";
import { createDropshipCostChangePolicyServiceFromEnv } from "./dropship-cost-change-policy.factory";
import { PgDropshipCostChangeListingActionRepository } from "./dropship-cost-change-listing-action.repository";
import { createDropshipListingPreviewServiceFromEnv } from "./dropship-listing-preview.factory";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import { createDropshipCostChangeHoldGateFromEnv } from "./dropship-listing-variant-hold.gate";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";

/**
 * A reprice is an ordinary one-step listing push queued by the system: the
 * preview service builds the current preview (price from the vendor's pricing
 * rules at the live cost) and queues it under the pass's deterministic key. A
 * store that cannot take a push now (account, membership or store state; the
 * access rule names the step that lifts it) is reported as refused rather
 * than failing the vendor's whole pass; anything else propagates.
 */
export function createDropshipCostChangeRepricePort(
  previews: Pick<DropshipListingPreviewService, "createListingPushJob">,
): DropshipCostChangeRepricePort {
  return {
    async queueReprice(input): Promise<CostChangeRepriceOutcome> {
      try {
        const result = await previews.createListingPushJob({
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          productVariantIds: [...input.productVariantIds],
          reviewMode: "current_preview",
          idempotencyKey: input.idempotencyKey,
          requestedBy: { actorType: "system", actorId: input.actorId },
        });
        return {
          queued: true,
          jobId: result.job.jobId,
          jobStatus: result.job.status,
          idempotentReplay: result.idempotentReplay,
          items: result.items.map((item) => ({ productVariantId: item.productVariantId, status: item.status, errorCode: item.errorCode })),
        };
      } catch (error) {
        if (error instanceof DropshipError && typeof error.context?.resolution === "string") {
          return { queued: false, code: error.code, message: error.message };
        }
        throw error;
      }
    },
  };
}

export function createDropshipCostChangeListingActionServiceFromEnv(): DropshipCostChangeListingActionService {
  return new DropshipCostChangeListingActionService({
    repository: new PgDropshipCostChangeListingActionRepository(undefined, new PgDropshipListingPreviewRepository()),
    policy: createDropshipCostChangePolicyServiceFromEnv(),
    reprice: createDropshipCostChangeRepricePort(createDropshipListingPreviewServiceFromEnv()),
    holdGate: createDropshipCostChangeHoldGateFromEnv(COST_CHANGE_HOLD_ACTOR_ID),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipCostChangePolicyClock,
    logger: makeDropshipCostChangePolicyLogger(),
  });
}
