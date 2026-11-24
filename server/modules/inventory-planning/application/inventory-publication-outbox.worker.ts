import type {
  InventoryPublicationBatchResult,
  InventoryPublicationOutboxService,
} from "./inventory-publication-outbox.service";

import { observeRuntimeWork } from "../../../platform/observability/runtime-memory";
import { logger } from "../../../platform/observability/logger";

/** Backstop only: committed work normally wakes the worker at once (see requestInventoryPublicationWorkerRun). */
const DEFAULT_INTERVAL_MS = 15_000;
/**
 * A wake-up waits this long before running so one burst (an order claiming five
 * products commits five marks) becomes one batch instead of five.
 */
const WAKE_DEBOUNCE_MS = 250;
const LOG_PREFIX = "[Inventory Publication Worker]";

type Processor = Pick<InventoryPublicationOutboxService, "processDue">;
type SelectionProcessor = { processDue(): Promise<{ planned: number; blocked: number; skipped: number }> };

let timer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let runTick: (() => void) | null = null;
let inFlight = false;
/** Work was committed while a batch was running; that batch may have read before it. */
let wakeDuringTick = false;

export async function runInventoryPublicationWorkerTick(
  processor: Processor,
  selection?: SelectionProcessor,
): Promise<InventoryPublicationBatchResult | null> {
  if (inFlight) return null;
  inFlight = true;
  try {
    if (selection) {
      const replanned = await observeRuntimeWork("inventory.publication_selection", () => selection.processDue());
      if (replanned.planned || replanned.blocked) logger.info("inventory-planning.inventory_publication_outbox_worker", { message: `${LOG_PREFIX} Selection changes replanned`, detail: replanned });
    }
    const result = await observeRuntimeWork("inventory.publication", () => processor.processDue());
    if (result.claimed > 0) logger.info("inventory-planning.inventory_publication_outbox_worker", { message: `${LOG_PREFIX} Batch complete`, detail: result });
    return result;
  } catch (error) {
    logger.error("inventory-planning.inventory_publication_outbox_worker", { message: `${LOG_PREFIX} Worker tick failed`, error: error });
    return null;
  } finally {
    inFlight = false;
    if (wakeDuringTick) {
      wakeDuringTick = false;
      requestInventoryPublicationWorkerRun();
    }
  }
}

/**
 * Run a batch now instead of waiting for the timer. Safe to call at any rate:
 * calls inside the debounce window share one run, and a call during a running
 * batch schedules exactly one follow-up. Does nothing when the worker is not
 * started (disabled by env, or a process that does not own publication).
 */
export function requestInventoryPublicationWorkerRun(): void {
  if (!runTick) return;
  if (inFlight) { wakeDuringTick = true; return; }
  if (wakeTimer) return;
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    if (inFlight) { wakeDuringTick = true; return; }
    runTick?.();
  }, WAKE_DEBOUNCE_MS);
}

export function startInventoryPublicationOutboxWorker(processor: Processor, selection?: SelectionProcessor): void {
  if (timer) {
    logger.warn("inventory-planning.inventory_publication_outbox_worker", { message: `${LOG_PREFIX} Worker already started; ignoring duplicate start` });
    return;
  }
  const intervalMs = positiveIntegerEnv("INVENTORY_PUBLICATION_WORKER_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  const run = () => void runInventoryPublicationWorkerTick(processor, selection);
  runTick = run;
  startupTimer = setTimeout(run, Math.min(intervalMs, 5_000));
  timer = setInterval(run, intervalMs);
  logger.info("inventory-planning.inventory_publication_outbox_worker", { message: `${LOG_PREFIX} Started durable worker`, intervalMs });
}

/** Stops scheduling new batches. A running batch finishes on its own. */
export function stopInventoryPublicationOutboxWorker(): void {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  if (wakeTimer) clearTimeout(wakeTimer);
  timer = null;
  startupTimer = null;
  wakeTimer = null;
  runTick = null;
  wakeDuringTick = false;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    logger.warn("inventory-planning.inventory_publication_outbox_worker", { message: `${LOG_PREFIX} Ignoring invalid ${name}; using ${fallback}` });
    return fallback;
  }
  return parsed;
}
