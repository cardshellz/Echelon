let startedAt: Date | null = null;
let lastRunAt: Date | null = null;
let lastSuccessAt: Date | null = null;
let lastWindowStart: Date | null = null;
let lastWindowEnd: Date | null = null;
let lastDeepScanAt: Date | null = null;
let lastOrdersSeen = 0;
let lastOrdersIngested = 0;
let lastError: string | null = null;

export interface EbayOrderPollHeartbeat {
  startedAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastWindowStart: string | null;
  lastWindowEnd: string | null;
  lastDeepScanAt: string | null;
  lastOrdersSeen: number;
  lastOrdersIngested: number;
  lastError: string | null;
}

export function getEbayOrderPollHeartbeat(): EbayOrderPollHeartbeat {
  return {
    startedAt: startedAt?.toISOString() ?? null,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    lastWindowStart: lastWindowStart?.toISOString() ?? null,
    lastWindowEnd: lastWindowEnd?.toISOString() ?? null,
    lastDeepScanAt: lastDeepScanAt?.toISOString() ?? null,
    lastOrdersSeen,
    lastOrdersIngested,
    lastError,
  };
}

export function markEbayOrderPollStarted(): void {
  startedAt ??= new Date();
}

export function markEbayOrderPollRunStarted(): void {
  markEbayOrderPollStarted();
  lastRunAt = new Date();
}

export function markEbayOrderPollSucceeded(input: {
  windowStart: Date;
  windowEnd: Date;
  deepScan: boolean;
  ordersSeen: number;
  ordersIngested: number;
}): void {
  lastSuccessAt = new Date();
  lastWindowStart = input.windowStart;
  lastWindowEnd = input.windowEnd;
  if (input.deepScan) lastDeepScanAt = input.windowEnd;
  lastOrdersSeen = input.ordersSeen;
  lastOrdersIngested = input.ordersIngested;
  lastError = null;
}

export function markEbayOrderPollFailed(error: unknown): void {
  lastError = error instanceof Error ? error.message : String(error);
}

export function resetEbayOrderPollHeartbeatForTests(): void {
  startedAt = null;
  lastRunAt = null;
  lastSuccessAt = null;
  lastWindowStart = null;
  lastWindowEnd = null;
  lastDeepScanAt = null;
  lastOrdersSeen = 0;
  lastOrdersIngested = 0;
  lastError = null;
}
