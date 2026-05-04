import type { RecordDropshipOrderIntakeInput } from "./dropship-order-intake-service";
import type {
  DropshipOrderIntakeRepositoryResult,
  DropshipOrderIntakeService,
} from "./dropship-order-intake-service";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";

export interface DropshipEbayOrderIntakeStoreConnection {
  vendorId: number;
  storeConnectionId: number;
  lastOrderSyncAt: Date | null;
}

export interface DropshipEbayOrderIntakeOrder {
  externalOrderId: string;
  input: RecordDropshipOrderIntakeInput;
}

export interface DropshipEbayOrderIntakeFetchResult {
  orders: DropshipEbayOrderIntakeOrder[];
  ignored: number;
}

export interface DropshipEbayOrderIntakeProvider {
  fetchOrders(input: {
    connection: DropshipEbayOrderIntakeStoreConnection;
    since: Date;
    until: Date;
  }): Promise<DropshipEbayOrderIntakeFetchResult>;
}

export interface DropshipEbayOrderIntakeRepository {
  listPollableStoreConnections(input: {
    limit: number;
  }): Promise<DropshipEbayOrderIntakeStoreConnection[]>;

  markStorePollSucceeded(input: {
    storeConnectionId: number;
    syncedThrough: Date;
    now: Date;
  }): Promise<void>;
}

export interface DropshipEbayOrderIntakeSweepResult {
  storesScanned: number;
  storesSucceeded: number;
  storesFailed: number;
  ordersCreated: number;
  ordersUpdated: number;
  ordersReplayed: number;
  ordersRejected: number;
  ordersIgnored: number;
}

export interface DropshipEbayOrderIntakePollServiceDependencies {
  repository: DropshipEbayOrderIntakeRepository;
  provider: DropshipEbayOrderIntakeProvider;
  orderIntakeService: Pick<DropshipOrderIntakeService, "recordMarketplaceOrder">;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export class DropshipEbayOrderIntakePollService {
  constructor(private readonly deps: DropshipEbayOrderIntakePollServiceDependencies) {}

  async pollConnectedStores(input: {
    limit: number;
    initialLookbackMinutes: number;
    overlapMinutes: number;
  }): Promise<DropshipEbayOrderIntakeSweepResult> {
    const now = this.deps.clock.now();
    const connections = await this.deps.repository.listPollableStoreConnections({
      limit: input.limit,
    });
    const result = emptySweepResult(connections.length);

    for (const connection of connections) {
      try {
        const since = resolvePollSince({
          lastOrderSyncAt: connection.lastOrderSyncAt,
          now,
          initialLookbackMinutes: input.initialLookbackMinutes,
          overlapMinutes: input.overlapMinutes,
        });
        const fetched = await this.deps.provider.fetchOrders({
          connection,
          since,
          until: now,
        });
        result.ordersIgnored += fetched.ignored;
        for (const order of fetched.orders) {
          const intake = await this.deps.orderIntakeService.recordMarketplaceOrder(order.input);
          applyIntakeResult(result, intake);
        }
        await this.deps.repository.markStorePollSucceeded({
          storeConnectionId: connection.storeConnectionId,
          syncedThrough: now,
          now: this.deps.clock.now(),
        });
        result.storesSucceeded += 1;
      } catch (error) {
        result.storesFailed += 1;
        this.deps.logger.warn({
          code: "DROPSHIP_EBAY_ORDER_INTAKE_STORE_FAILED",
          message: "Dropship eBay order intake failed for a store connection.",
          context: {
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

export function resolvePollSince(input: {
  lastOrderSyncAt: Date | null;
  now: Date;
  initialLookbackMinutes: number;
  overlapMinutes: number;
}): Date {
  const sourceDate = input.lastOrderSyncAt ?? new Date(input.now.getTime() - input.initialLookbackMinutes * 60_000);
  const overlapMs = input.lastOrderSyncAt ? input.overlapMinutes * 60_000 : 0;
  return new Date(Math.min(sourceDate.getTime() - overlapMs, input.now.getTime()));
}

export function makeDropshipEbayOrderIntakeLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipEbayOrderIntakeEvent("info", event),
    warn: (event) => logDropshipEbayOrderIntakeEvent("warn", event),
    error: (event) => logDropshipEbayOrderIntakeEvent("error", event),
  };
}

export const systemDropshipEbayOrderIntakeClock: DropshipClock = {
  now: () => new Date(),
};

function emptySweepResult(storesScanned: number): DropshipEbayOrderIntakeSweepResult {
  return {
    storesScanned,
    storesSucceeded: 0,
    storesFailed: 0,
    ordersCreated: 0,
    ordersUpdated: 0,
    ordersReplayed: 0,
    ordersRejected: 0,
    ordersIgnored: 0,
  };
}

function applyIntakeResult(
  aggregate: DropshipEbayOrderIntakeSweepResult,
  result: DropshipOrderIntakeRepositoryResult,
): void {
  if (result.intake.status === "rejected") {
    aggregate.ordersRejected += 1;
    return;
  }
  if (result.action === "created") {
    aggregate.ordersCreated += 1;
  } else if (result.action === "updated") {
    aggregate.ordersUpdated += 1;
  } else {
    aggregate.ordersReplayed += 1;
  }
}

function logDropshipEbayOrderIntakeEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
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
