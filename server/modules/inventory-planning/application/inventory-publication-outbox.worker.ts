import type {
  InventoryPublicationBatchResult,
  InventoryPublicationOutboxService,
} from "./inventory-publication-outbox.service";

import { observeRuntimeWork } from "../../../platform/observability/runtime-memory";

const DEFAULT_INTERVAL_MS = 15_000;
const LOG_PREFIX = "[Inventory Publication Worker]";

type Processor = Pick<InventoryPublicationOutboxService, "processDue">;
type SelectionProcessor = { processDue(): Promise<{ planned: number; blocked: number; skipped: number }> };

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export async function runInventoryPublicationWorkerTick(
  processor: Processor,
  selection?: SelectionProcessor,
): Promise<InventoryPublicationBatchResult | null> {
  if (inFlight) return null;
  inFlight = true;
  try {
    if (selection) {
      const replanned = await observeRuntimeWork("inventory.publication_selection", () => selection.processDue());
      if (replanned.planned || replanned.blocked) console.info(`${LOG_PREFIX} Selection changes replanned`, replanned);
    }
    const result = await observeRuntimeWork("inventory.publication", () => processor.processDue());
    if (result.claimed > 0) console.info(`${LOG_PREFIX} Batch complete`, result);
    return result;
  } catch (error) {
    console.error(`${LOG_PREFIX} Worker tick failed`, error);
    return null;
  } finally {
    inFlight = false;
  }
}

export function startInventoryPublicationOutboxWorker(processor: Processor, selection?: SelectionProcessor): void {
  if (timer) {
    console.warn(`${LOG_PREFIX} Worker already started; ignoring duplicate start`);
    return;
  }
  const intervalMs = positiveIntegerEnv("INVENTORY_PUBLICATION_WORKER_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  const run = () => void runInventoryPublicationWorkerTick(processor, selection);
  setTimeout(run, Math.min(intervalMs, 5_000));
  timer = setInterval(run, intervalMs);
  console.info(`${LOG_PREFIX} Started durable worker`, { intervalMs });
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.warn(`${LOG_PREFIX} Ignoring invalid ${name}; using ${fallback}`);
    return fallback;
  }
  return parsed;
}
