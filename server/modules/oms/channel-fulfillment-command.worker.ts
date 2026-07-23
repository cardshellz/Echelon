import type {
  ChannelFulfillmentAuthorityService,
  ChannelFulfillmentBatchResult,
} from "./channel-fulfillment-authority.service";

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 25;

let timer: ReturnType<typeof setInterval> | null = null;
let runInFlight = false;
let lastRunAt: Date | null = null;
let lastSuccessAt: Date | null = null;
let lastError: string | null = null;

export interface ChannelFulfillmentCommandWorkerHeartbeat {
  readonly running: boolean;
  readonly inFlight: boolean;
  readonly lastRunAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
}

export function getChannelFulfillmentCommandWorkerHeartbeat(): ChannelFulfillmentCommandWorkerHeartbeat {
  return Object.freeze({
    running: timer !== null,
    inFlight: runInFlight,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    lastError,
  });
}

export async function runChannelFulfillmentCommandWorkerOnce(
  service: ChannelFulfillmentAuthorityService,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<ChannelFulfillmentBatchResult | null> {
  if (runInFlight) return null;
  runInFlight = true;
  lastRunAt = new Date();
  try {
    const result = await service.runDueBatch({ limit: batchSize });
    lastSuccessAt = new Date();
    lastError = null;
    if (result.claimed > 0) {
      console.log(JSON.stringify({
        code: "CHANNEL_FULFILLMENT_WORKER_BATCH_COMPLETED",
        ...result,
      }));
    }
    return result;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      code: "CHANNEL_FULFILLMENT_WORKER_BATCH_FAILED",
      error: lastError,
    }));
    throw error;
  } finally {
    runInFlight = false;
  }
}

export function startChannelFulfillmentCommandWorker(
  service: ChannelFulfillmentAuthorityService,
  options: { intervalMs?: number; batchSize?: number } = {},
): () => void {
  if (timer !== null) return () => undefined;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("Channel fulfillment command worker interval must be a positive integer");
  }
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("Channel fulfillment command worker batch size must be a positive integer");
  }

  const tick = () => {
    void runChannelFulfillmentCommandWorkerOnce(service, batchSize).catch(() => undefined);
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  return () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
}

export function resetChannelFulfillmentCommandWorkerForTest(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  runInFlight = false;
  lastRunAt = null;
  lastSuccessAt = null;
  lastError = null;
}
