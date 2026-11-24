import type { VariantAvailabilityBatchResult } from "./variant-availability-sync.service";
import { observeRuntimeWork } from "../../../platform/observability/runtime-memory";
import { logger } from "../../../platform/observability/logger";

const DEFAULT_INTERVAL_MS = 15_000;
const LOG_PREFIX = "[Variant Availability Worker]";

interface VariantAvailabilityProcessor {
  processDue(): Promise<VariantAvailabilityBatchResult>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let startedAt: Date | null = null;
let lastRunAt: Date | null = null;
let lastSuccessAt: Date | null = null;
let lastError: string | null = null;

export interface VariantAvailabilityWorkerHeartbeat {
  startedAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  inFlight: boolean;
}

export function getVariantAvailabilityWorkerHeartbeat(): VariantAvailabilityWorkerHeartbeat {
  return {
    startedAt: startedAt?.toISOString() ?? null,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    lastError,
    inFlight,
  };
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    logger.warn("channels.variant_availability_sync_worker", { message: `${LOG_PREFIX} Ignoring invalid ${name}; using ${fallback}` });
    return fallback;
  }
  return parsed;
}

export async function runVariantAvailabilityWorkerTick(
  processor: VariantAvailabilityProcessor,
): Promise<"success" | "error" | "skipped"> {
  if (inFlight) return "skipped";
  inFlight = true;
  lastRunAt = new Date();
  try {
    const result = await observeRuntimeWork("inventory.variant_availability", () => processor.processDue());
    lastSuccessAt = new Date();
    lastError = null;
    if (result.claimed > 0) {
      logger.info("channels.variant_availability_sync_worker", { message: `${LOG_PREFIX} Batch complete`, detail: result });
    }
    return "success";
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    logger.error("channels.variant_availability_sync_worker", { message: `${LOG_PREFIX} Worker tick failed`, error: error });
    return "error";
  } finally {
    inFlight = false;
  }
}

export function startVariantAvailabilitySyncWorker(
  processor: VariantAvailabilityProcessor,
): void {
  if (timer) {
    logger.warn("channels.variant_availability_sync_worker", { message: `${LOG_PREFIX} Worker already started; ignoring duplicate start` });
    return;
  }
  startedAt = new Date();
  const intervalMs = positiveIntegerEnv(
    "VARIANT_AVAILABILITY_SYNC_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
  );
  const run = () => void runVariantAvailabilityWorkerTick(processor);
  setTimeout(run, Math.min(intervalMs, 5_000));
  timer = setInterval(run, intervalMs);
  logger.info("channels.variant_availability_sync_worker", { message: `${LOG_PREFIX} Started durable worker`, intervalMs });
}
