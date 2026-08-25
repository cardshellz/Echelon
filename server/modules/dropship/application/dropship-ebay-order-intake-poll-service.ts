import type { RecordDropshipOrderIntakeInput } from "./dropship-order-intake-service";
import type {
  DropshipOrderIntakeRepositoryResult,
  DropshipOrderIntakeService,
} from "./dropship-order-intake-service";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type { DropshipOrderIntakeHealthService } from "./dropship-order-intake-health-service";
import { DropshipError } from "../domain/errors";

export const IMMUTABLE_ORDER_INTAKE_CONFLICT_CODE = "DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE";

export interface DropshipEbayOrderIntakeStoreConnection {
  vendorId: number;
  storeConnectionId: number;
  platform: "ebay";
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

export interface DropshipEbayOrderIntakeImmutableConflictInput {
  vendorId: number;
  storeConnectionId: number;
  intakeId: number;
  externalOrderId: string;
  failureCode: typeof IMMUTABLE_ORDER_INTAKE_CONFLICT_CODE;
  message: string;
  now: Date;
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


  recordImmutableOrderConflict(
    input: DropshipEbayOrderIntakeImmutableConflictInput,
  ): Promise<{ created: boolean }>;
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
  ordersConflicted: number;
}

export interface DropshipEbayOrderIntakePollServiceDependencies {
  repository: DropshipEbayOrderIntakeRepository;
  healthService: Pick<
    DropshipOrderIntakeHealthService,
    "recordPollSucceeded" | "recordPollFailed"
  >;
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
          try {
            const intake = await this.deps.orderIntakeService.recordMarketplaceOrder(order.input);
            applyIntakeResult(result, intake);
          } catch (error) {
            const conflict = parseImmutableOrderConflict({ error, order, connection });
            if (!conflict) throw error;

            const audit = await this.deps.repository.recordImmutableOrderConflict({
              vendorId: connection.vendorId,
              storeConnectionId: connection.storeConnectionId,
              intakeId: conflict.intakeId,
              externalOrderId: order.externalOrderId,
              failureCode: IMMUTABLE_ORDER_INTAKE_CONFLICT_CODE,
              message: conflict.message,
              now: this.deps.clock.now(),
            });
            result.ordersConflicted += 1;
            if (audit.created) {
              this.deps.logger.warn({
                code: "DROPSHIP_EBAY_ORDER_INTAKE_IMMUTABLE_CONFLICT",
                message: "Dropship eBay order intake skipped an immutable payload conflict.",
                context: {
                  vendorId: connection.vendorId,
                  storeConnectionId: connection.storeConnectionId,
                  intakeId: conflict.intakeId,
                  externalOrderId: order.externalOrderId,
                },
              });
            }
          }
        }
        await this.deps.healthService.recordPollSucceeded({
          vendorId: connection.vendorId,
          storeConnectionId: connection.storeConnectionId,
          platform: connection.platform,
          syncedThrough: now,
        });
        result.storesSucceeded += 1;
      } catch (error) {
        result.storesFailed += 1;
        await this.recordPollFailureSafely(connection, error);
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

  private async recordPollFailureSafely(
    connection: DropshipEbayOrderIntakeStoreConnection,
    error: unknown,
  ): Promise<void> {
    try {
      await this.deps.healthService.recordPollFailed({
        vendorId: connection.vendorId,
        storeConnectionId: connection.storeConnectionId,
        platform: connection.platform,
        failureCode: error instanceof DropshipError
          ? error.code
          : "DROPSHIP_EBAY_ORDER_INTAKE_STORE_FAILED",
        failureMessage: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      });
    } catch (healthError) {
      this.deps.logger.error({
        code: "DROPSHIP_ORDER_INTAKE_HEALTH_RECORDING_FAILED",
        message: "Dropship order-intake failure could not be persisted to the health ledger.",
        context: { vendorId: connection.vendorId, storeConnectionId: connection.storeConnectionId,
          error: healthError instanceof Error ? healthError.message : String(healthError) },
      });
    }
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
    ordersConflicted: 0,
  };
}

function parseImmutableOrderConflict(input: {
  error: unknown;
  order: DropshipEbayOrderIntakeOrder;
  connection: DropshipEbayOrderIntakeStoreConnection;
}): { intakeId: number; message: string } | null {
  if (!(input.error instanceof DropshipError) || input.error.code !== IMMUTABLE_ORDER_INTAKE_CONFLICT_CODE) {
    return null;
  }

  const intakeId = input.error.context?.intakeId;
  const externalOrderId = input.error.context?.externalOrderId;
  const storeConnectionId = input.error.context?.storeConnectionId;
  if (
    !Number.isInteger(intakeId)
    || (intakeId as number) <= 0
    || externalOrderId !== input.order.externalOrderId
    || storeConnectionId !== input.connection.storeConnectionId
  ) {
    return null;
  }

  return { intakeId: intakeId as number, message: input.error.message };
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
