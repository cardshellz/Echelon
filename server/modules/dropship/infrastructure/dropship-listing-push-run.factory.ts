import { performance } from "node:perf_hooks";
import { pool } from "../../../db";
import { logger } from "../../../platform/observability/logger";
import type { DropshipLogEvent, DropshipLogger } from "../application/dropship-ports";
import { DropshipListingPushRunService } from "../application/dropship-listing-push-run-service";
import { DropshipListingPushRunSweepService } from "../application/dropship-listing-push-run-sweep";
import { systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { createDropshipCostChangePolicyServiceFromEnv } from "./dropship-cost-change-policy.factory";
import { createDropshipListingPreviewServiceFromEnv } from "./dropship-listing-preview.factory";
import { PgDropshipListingPushRunRepository } from "./dropship-listing-push-run.repository";
import { PgDropshipListingPushRunSweepRepository } from "./dropship-listing-push-run-sweep.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";

/** The actor of the price check's read-only preview (a run's pre-filter, §4.3 step 2). */
const RUN_PRICE_CHECK_ACTOR = { actorType: "system", actorId: "dropship-listing-push-run" } as const;

/**
 * The run events through the platform JSON logger (CLAUDE.md §10: one
 * structured logger): one action, the event's code and words, its context
 * (run, vendor, store and job ids for correlation) under `context`.
 */
export function platformDropshipLogger(action: string): DropshipLogger {
  const entry = (event: DropshipLogEvent, outcome: string) => ({
    outcome, event_code: event.code, message: event.message, context: event.context ?? {},
  });
  return {
    info: (event) => logger.info(action, entry(event, "ok")),
    warn: (event) => logger.warn(action, entry(event, "recovered")),
    error: (event) => logger.error(action, { ...entry(event, "failed"), error_code: event.code }),
  };
}

/** The vendor portal's run routes: create, list, read and stop. */
export function createDropshipListingPushRunServiceFromEnv(): DropshipListingPushRunService {
  return new DropshipListingPushRunService({
    repository: new PgDropshipListingPushRunRepository(pool),
    pushAccess: createDropshipListingPreviewServiceFromEnv(),
    clock: systemDropshipListingPreviewClock,
    logger: platformDropshipLogger("dropship.listing_push_run"),
  });
}

/** The push sweep's run steps: reconcile, finish, expand (§4.3-§4.4). */
export function createDropshipListingPushRunSweepServiceFromEnv(): DropshipListingPushRunSweepService {
  const preview = createDropshipListingPreviewServiceFromEnv();
  const costChangePolicy = createDropshipCostChangePolicyServiceFromEnv();
  return new DropshipListingPushRunSweepService({
    repository: new PgDropshipListingPushRunSweepRepository(pool),
    createChunkJob: (input) => preview.createListingPushJob(input),
    priceCheck: async (input) => {
      const result = await preview.generatePreview({
        vendorId: input.vendorId, storeConnectionId: input.storeConnectionId,
        productVariantIds: [...input.productVariantIds], actor: RUN_PRICE_CHECK_ACTOR,
      });
      // The push-time review's own test of "rule priced" (dropship-listing-intent-refresh.ts).
      return result.rows.map((row) => ({
        productVariantId: row.productVariantId,
        rulePriced: typeof row.rulePriceEvidenceHash === "string" || row.followsStorePricing === true,
      }));
    },
    resolveCostChangePolicy: () => costChangePolicy.resolvePolicy(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipListingPreviewClock,
    timer: () => performance.now(),
    logger: platformDropshipLogger("dropship.listing_push_run.sweep"),
  });
}
