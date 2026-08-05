import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type {
  DropshipReturnIntakeFetchResult,
  DropshipReturnIntakeProvider,
  DropshipReturnIntakeStoreConnection,
} from "./dropship-return-intake-provider";
import type {
  DropshipReturnIntakeRecordResult,
  DropshipReturnIntakeService,
} from "./dropship-return-intake-service";

/**
 * Channel return-intake poll service (design spec D2a; build spec "Channel
 * return intake adapters"). Channel-agnostic: eBay and Shopify providers both
 * feed this loop.
 *
 * Poll cadence + watermark follow the order-intake poll pattern, with the
 * deep-review 3.5 poison-pill lesson applied: EVERY per-return error is
 * caught and recorded, and the store watermark STILL ADVANCES as long as the
 * provider fetch itself succeeded. A single bad channel return must never
 * block the store's return polling (the order-intake loop rethrew
 * non-conflict per-order errors before watermark advancement — this loop
 * deliberately does not).
 *
 * Store-level failures (provider fetch throws, DB down) DO skip watermark
 * advancement so the window is retried next sweep.
 */

export interface DropshipReturnIntakePollRepository {
  listPollableStoreConnections(input: {
    platform: "ebay" | "shopify";
    limit: number;
  }): Promise<DropshipReturnIntakeStoreConnection[]>;

  markStoreReturnPollSucceeded(input: {
    storeConnectionId: number;
    syncedThrough: Date;
    now: Date;
  }): Promise<void>;
}

export interface DropshipReturnIntakeSweepResult {
  platform: "ebay" | "shopify";
  storesScanned: number;
  storesSucceeded: number;
  storesFailed: number;
  returnsCreated: number;
  returnsReplayed: number;
  returnsExcepted: number;
  returnsIgnored: number;
  returnsFailed: number;
}

export interface DropshipReturnIntakePollServiceDependencies {
  platform: "ebay" | "shopify";
  repository: DropshipReturnIntakePollRepository;
  provider: DropshipReturnIntakeProvider;
  intakeService: Pick<DropshipReturnIntakeService, "recordChannelReturn">;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export class DropshipReturnIntakePollService {
  constructor(private readonly deps: DropshipReturnIntakePollServiceDependencies) {}

  async pollConnectedStores(input: {
    limit: number;
    initialLookbackMinutes: number;
    overlapMinutes: number;
  }): Promise<DropshipReturnIntakeSweepResult> {
    const now = this.deps.clock.now();
    const connections = await this.deps.repository.listPollableStoreConnections({
      platform: this.deps.platform,
      limit: input.limit,
    });
    const result = emptySweepResult(this.deps.platform, connections.length);

    for (const connection of connections) {
      let fetched: DropshipReturnIntakeFetchResult;
      try {
        const since = resolveReturnPollSince({
          lastReturnSyncAt: connection.lastReturnSyncAt,
          now,
          initialLookbackMinutes: input.initialLookbackMinutes,
          overlapMinutes: input.overlapMinutes,
        });
        fetched = await this.deps.provider.fetchReturns({
          connection,
          since,
          until: now,
        });
      } catch (error) {
        // Store-level failure: do NOT advance the watermark — retry the whole
        // window next sweep.
        result.storesFailed += 1;
        this.deps.logger.warn({
          code: "DROPSHIP_RETURN_INTAKE_STORE_FAILED",
          message: "Dropship return intake failed for a store connection.",
          context: {
            platform: this.deps.platform,
            vendorId: connection.vendorId,
            storeConnectionId: connection.storeConnectionId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        continue;
      }

      result.returnsIgnored += fetched.ignored;
      for (const draft of fetched.drafts) {
        try {
          const recorded = await this.deps.intakeService.recordChannelReturn({
            connection,
            platform: this.deps.platform,
            draft,
          });
          applyRecordResult(result, recorded);
        } catch (error) {
          // Per-return isolation (deep review 3.5): record and CONTINUE. The
          // watermark below still advances. Infrastructure errors surface in
          // returnsFailed + logs, not by aborting the store.
          result.returnsFailed += 1;
          this.deps.logger.warn({
            code: "DROPSHIP_RETURN_INTAKE_RETURN_FAILED",
            message: "Dropship return intake failed for one channel return; continuing store poll.",
            context: {
              platform: this.deps.platform,
              vendorId: connection.vendorId,
              storeConnectionId: connection.storeConnectionId,
              channelReturnId: draft.channelReturnId,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }

      try {
        await this.deps.repository.markStoreReturnPollSucceeded({
          storeConnectionId: connection.storeConnectionId,
          syncedThrough: now,
          now: this.deps.clock.now(),
        });
        result.storesSucceeded += 1;
      } catch (error) {
        result.storesFailed += 1;
        this.deps.logger.warn({
          code: "DROPSHIP_RETURN_INTAKE_WATERMARK_FAILED",
          message: "Dropship return intake could not advance the store watermark.",
          context: {
            platform: this.deps.platform,
            vendorId: connection.vendorId,
            storeConnectionId: connection.storeConnectionId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    return result;
  }
}

export function resolveReturnPollSince(input: {
  lastReturnSyncAt: Date | null;
  now: Date;
  initialLookbackMinutes: number;
  overlapMinutes: number;
}): Date {
  const sourceDate = input.lastReturnSyncAt
    ?? new Date(input.now.getTime() - input.initialLookbackMinutes * 60_000);
  const overlapMs = input.lastReturnSyncAt ? input.overlapMinutes * 60_000 : 0;
  return new Date(Math.min(sourceDate.getTime() - overlapMs, input.now.getTime()));
}

function emptySweepResult(
  platform: "ebay" | "shopify",
  storesScanned: number,
): DropshipReturnIntakeSweepResult {
  return {
    platform,
    storesScanned,
    storesSucceeded: 0,
    storesFailed: 0,
    returnsCreated: 0,
    returnsReplayed: 0,
    returnsExcepted: 0,
    returnsIgnored: 0,
    returnsFailed: 0,
  };
}

function applyRecordResult(
  aggregate: DropshipReturnIntakeSweepResult,
  result: DropshipReturnIntakeRecordResult,
): void {
  if (result.outcome === "created") {
    aggregate.returnsCreated += 1;
  } else if (result.outcome === "replayed") {
    aggregate.returnsReplayed += 1;
  } else {
    aggregate.returnsExcepted += 1;
  }
}

export function makeDropshipReturnIntakePollLogger(): DropshipLogger {
  return {
    info: (event) => logReturnIntakePollEvent("info", event),
    warn: (event) => logReturnIntakePollEvent("warn", event),
    error: (event) => logReturnIntakePollEvent("error", event),
  };
}

export const systemDropshipReturnIntakePollClock: DropshipClock = {
  now: () => new Date(),
};

function logReturnIntakePollEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.info(payload);
  }
}
