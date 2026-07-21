import type { CarrierTrackingLogger, CarrierTrackingService } from "./carrier-tracking.service";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_INITIAL_DELAY_MS = 60 * 1_000;
const DEFAULT_BATCH_LIMIT = 100;

export interface CarrierTrackingSchedulerHandle {
  stop(): void;
}

export function startCarrierTrackingReconciliationScheduler(
  service: Pick<CarrierTrackingService, "reconcileUnresolved">,
  logger: CarrierTrackingLogger,
  options: {
    intervalMs?: number;
    initialDelayMs?: number;
    batchLimit?: number;
  } = {},
): CarrierTrackingSchedulerHandle {
  const intervalMs = positiveInteger(options.intervalMs ?? DEFAULT_INTERVAL_MS, "intervalMs");
  const initialDelayMs = nonNegativeInteger(
    options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    "initialDelayMs",
  );
  const batchLimit = boundedBatchLimit(options.batchLimit ?? DEFAULT_BATCH_LIMIT);
  let running = false;
  let stopped = false;

  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await service.reconcileUnresolved(batchLimit);
      if (result.hydrationsClaimed > 0
          || result.subscriptionsPrepared > 0
          || result.subscriptionLabelLinksPrepared > 0
          || result.subscriptionsClaimed > 0
          || result.labelsScanned > 0
          || result.scanned > 0
          || result.errors > 0) {
        logger.info({
          code: "CARRIER_TRACKING_RECONCILIATION_COMPLETED",
          message: "Carrier tracking reconciliation sweep completed.",
          context: {
            hydrationsClaimed: result.hydrationsClaimed,
            hydrationsCompleted: result.hydrationsCompleted,
            hydrationsRetryScheduled: result.hydrationsRetryScheduled,
            hydrationsReviewRequired: result.hydrationsReviewRequired,
            hydrationClientConfigured: result.hydrationClientConfigured,
            subscriptionsPrepared: result.subscriptionsPrepared,
            subscriptionLabelLinksPrepared: result.subscriptionLabelLinksPrepared,
            subscriptionsClaimed: result.subscriptionsClaimed,
            subscriptionsActivated: result.subscriptionsActivated,
            subscriptionsRetryScheduled: result.subscriptionsRetryScheduled,
            subscriptionsReviewRequired: result.subscriptionsReviewRequired,
            subscriptionClientConfigured: result.subscriptionClientConfigured,
            labelsScanned: result.labelsScanned,
            labelsLinked: result.labelsLinked,
            scanned: result.scanned,
            matched: result.matched,
            unresolved: result.unresolved,
            errors: result.errors,
          },
        });
      }
    } catch (error) {
      logger.error({
        code: "CARRIER_TRACKING_RECONCILIATION_SWEEP_FAILED",
        message: "Carrier tracking reconciliation sweep failed.",
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      running = false;
    }
  };

  const initialTimer = setTimeout(run, initialDelayMs);
  const intervalTimer = setInterval(run, intervalMs);
  initialTimer.unref?.();
  intervalTimer.unref?.();

  return {
    stop() {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function boundedBatchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 500) {
    throw new Error("batchLimit must be an integer between 1 and 500");
  }
  return value;
}
