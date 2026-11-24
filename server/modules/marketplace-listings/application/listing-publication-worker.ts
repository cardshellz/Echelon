import type { ListingPublicationService } from "./listing-publication.service";
import { getSchedulerDisableReason } from "../../../infrastructure/scheduler-config";
import { logger } from "../../../platform/observability/logger";

const WORKER_INTERVAL_MS = 30_000;
/** Database leases coordinate instances; this guard avoids overlapping local ticks. */
export function startListingPublicationWorker(
  service: Pick<ListingPublicationService, "processDue">,
  operation = "listing_publication_worker",
): (() => void) | undefined {
  const disabled = getSchedulerDisableReason("LISTING_PUBLICATION_DISABLED");
  if (disabled) {
    logger.info("marketplace-listings.listing_publication_worker", { operation: `${operation}_disabled`, reason: disabled });
    return;
  }
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await service.processDue();
    } catch {
      logger.error("LISTING_WORKER_FAILED", { operation, code: "LISTING_WORKER_FAILED" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, WORKER_INTERVAL_MS);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
