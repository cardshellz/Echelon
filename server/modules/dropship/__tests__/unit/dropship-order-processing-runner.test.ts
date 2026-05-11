import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

import {
  PgDropshipOrderProcessingQueueRepository,
  runDropshipOrderProcessingSweep,
  type DropshipOrderProcessingQueueRepository,
} from "../../infrastructure/dropship-order-processing-runner";
import type { DropshipOrderProcessingResult } from "../../application";

const now = new Date("2026-05-07T16:30:00.000Z");

describe("runDropshipOrderProcessingSweep", () => {
  it("recovers stale processing claims before listing processable intakes", async () => {
    const calls: string[] = [];
    const repository = new FakeOrderProcessingQueueRepository(calls, [91], [91, 92]);
    const service = new FakeOrderProcessingService(calls);

    const result = await runDropshipOrderProcessingSweep({
      repository,
      paymentHoldExpirationService: new FakePaymentHoldExpirationService(calls),
      orderCancellationService: new FakeOrderCancellationService(calls),
      orderProcessingService: service,
      batchSize: 25,
      staleProcessingMinutes: 45,
      workerId: "worker-1",
      now,
    });

    expect(result).toMatchObject({
      processed: 2,
      failed: 0,
      skipped: 0,
      expired: 0,
      expiringNotified: 0,
      cancellationSucceeded: 0,
      cancellationRetrying: 0,
      cancellationFailed: 0,
      staleProcessingRecovered: 1,
    });
    expect(repository.recoverInput).toEqual({
      limit: 25,
      now,
      staleAfterMinutes: 45,
      workerId: "worker-1",
    });
    expect(calls).toEqual([
      "expire-holds",
      "notify-expiring-holds",
      "process-cancellations",
      "recover-stale",
      "list-processable",
      "process-91",
      "process-92",
    ]);
    expect(service.inputs).toEqual([
      { intakeId: 91, workerId: "worker-1", idempotencyKey: "dropship-order-processing:intake:91" },
      { intakeId: 92, workerId: "worker-1", idempotencyKey: "dropship-order-processing:intake:92" },
    ]);
  });
});

describe("PgDropshipOrderProcessingQueueRepository", () => {
  it("requeues stale processing intakes and writes audit events in one transaction", async () => {
    const client = makeClient([{
      id: 91,
      vendor_id: 10,
      store_connection_id: 22,
      external_order_id: "ORDER-91",
      stale_updated_at: new Date("2026-05-07T15:40:00.000Z"),
    }]);
    const repository = new PgDropshipOrderProcessingQueueRepository(makePool(client));

    const result = await repository.recoverStaleProcessingIntakes({
      limit: 50,
      now,
      staleAfterMinutes: 30,
      workerId: "worker-1",
    });

    expect(result).toEqual([91]);
    const recoveryQuery = client.query.mock.calls.find((call) => String(call[0]).includes("WITH candidates"));
    expect(String(recoveryQuery?.[0])).toContain("WHERE status = 'processing'");
    expect(String(recoveryQuery?.[0])).toContain("SELECT id, updated_at AS stale_updated_at");
    expect(String(recoveryQuery?.[0])).toContain("updated_at <= $1::timestamptz - ($2::text)::interval");
    expect(String(recoveryQuery?.[0])).toContain("FOR UPDATE SKIP LOCKED");
    expect(String(recoveryQuery?.[0])).toContain("SET status = 'retrying'");
    expect(recoveryQuery?.[1]).toEqual([now, "30 minutes", 50]);

    const auditQuery = client.query.mock.calls.find((call) =>
      String(call[0]).includes("order_processing_stale_recovered"),
    );
    expect(auditQuery?.[1]).toEqual([
      10,
      22,
      "91",
      "worker-1",
      JSON.stringify({
        previousStatus: "processing",
        status: "retrying",
        externalOrderId: "ORDER-91",
        staleProcessingUpdatedAt: "2026-05-07T15:40:00.000Z",
        staleAfterMinutes: 30,
        reason: "processing claim exceeded stale threshold before completion.",
      }),
      now,
    ]);
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

class FakeOrderProcessingQueueRepository implements DropshipOrderProcessingQueueRepository {
  recoverInput: Parameters<DropshipOrderProcessingQueueRepository["recoverStaleProcessingIntakes"]>[0] | null = null;

  constructor(
    private readonly calls: string[],
    private readonly recoveredIds: number[],
    private readonly processableIds: number[],
  ) {}

  async recoverStaleProcessingIntakes(
    input: Parameters<DropshipOrderProcessingQueueRepository["recoverStaleProcessingIntakes"]>[0],
  ): Promise<number[]> {
    this.recoverInput = input;
    this.calls.push("recover-stale");
    return this.recoveredIds;
  }

  async listProcessableIntakeIds(): Promise<number[]> {
    this.calls.push("list-processable");
    return this.processableIds;
  }
}

class FakePaymentHoldExpirationService {
  constructor(private readonly calls: string[]) {}

  async expireExpiredPaymentHolds(): Promise<{
    expiredCount: number;
    expired: [];
  }> {
    this.calls.push("expire-holds");
    return { expiredCount: 0, expired: [] };
  }

  async notifyExpiringPaymentHolds(): Promise<{
    notifiedCount: number;
    notified: [];
  }> {
    this.calls.push("notify-expiring-holds");
    return { notifiedCount: 0, notified: [] };
  }
}

class FakeOrderCancellationService {
  constructor(private readonly calls: string[]) {}

  async processPendingCancellations(): Promise<{
    claimed: number;
    attempted: number;
    succeeded: number;
    retrying: number;
    failed: number;
  }> {
    this.calls.push("process-cancellations");
    return {
      claimed: 0,
      attempted: 0,
      succeeded: 0,
      retrying: 0,
      failed: 0,
    };
  }
}

class FakeOrderProcessingService {
  inputs: Array<{ intakeId: number; workerId: string; idempotencyKey: string }> = [];

  constructor(private readonly calls: string[]) {}

  async processIntake(input: {
    intakeId: number;
    workerId: string;
    idempotencyKey: string;
  }): Promise<DropshipOrderProcessingResult> {
    this.calls.push(`process-${input.intakeId}`);
    this.inputs.push(input);
    return {
      outcome: "accepted",
      intakeId: input.intakeId,
      vendorId: 10,
      storeConnectionId: 22,
      shippingQuoteSnapshotId: 33,
      omsOrderId: 1001,
      walletLedgerEntryId: 2001,
      economicsSnapshotId: 3001,
      failureCode: null,
      failureMessage: null,
      retryable: false,
    };
  }
}

function makePool(client: PoolClient): Pool {
  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

function makeClient(rows: Record<string, unknown>[]): PoolClient & {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(async (query: string) => {
      if (String(query).includes("WITH candidates")) {
        return { rows };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  } as unknown as PoolClient & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}
