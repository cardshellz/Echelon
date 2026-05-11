import { describe, expect, it } from "vitest";
import type {
  DropshipWorkerOpsRepository,
  DropshipWorkerSweepMetrics,
  DropshipWorkerSweepName,
  DropshipWorkerSweepRunner,
} from "../../application/dropship-worker-ops-service";
import { DropshipWorkerOpsService } from "../../application/dropship-worker-ops-service";

const now = new Date("2026-05-11T15:00:00.000Z");

describe("DropshipWorkerOpsService", () => {
  it("runs a configured worker sweep and records an audit event", async () => {
    const repository = new FakeDropshipWorkerOpsRepository();
    const logs: any[] = [];
    const runner = new FakeDropshipWorkerSweepRunner({ processed: 3, failed: 0 });
    const service = makeService({
      repository,
      logs,
      runners: {
        listing_push: runner,
      },
    });

    const result = await service.runSweep({
      worker: "listing_push",
      batchSize: 25,
      reason: "dogfood catch-up",
      idempotencyKey: "worker-sweep-listing-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result).toMatchObject({
      worker: "listing_push",
      workerId: "dropship-admin-listing_push:admin-1",
      batchSize: 25,
      metrics: { processed: 3, failed: 0 },
      status: "completed",
      requestedAt: now,
    });
    expect(runner.inputs[0]).toEqual({
      workerId: "dropship-admin-listing_push:admin-1",
      batchSize: 25,
    });
    expect(repository.records[0]).toMatchObject({
      worker: "listing_push",
      workerId: "dropship-admin-listing_push:admin-1",
      status: "completed",
      idempotencyKey: "worker-sweep-listing-1",
      metrics: { processed: 3, failed: 0 },
      now,
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_WORKER_SWEEP_COMPLETED",
      context: {
        worker: "listing_push",
        batchSize: 25,
        idempotencyKey: "worker-sweep-listing-1",
      },
    });
  });

  it("records failed audit context when the runner fails", async () => {
    const repository = new FakeDropshipWorkerOpsRepository();
    const logs: any[] = [];
    const runner = new FakeDropshipWorkerSweepRunner({ processed: 0 }, new Error("marketplace unavailable"));
    const service = makeService({
      repository,
      logs,
      runners: {
        ebay_order_intake: runner,
      },
    });

    await expect(service.runSweep({
      worker: "ebay_order_intake",
      batchSize: 10,
      idempotencyKey: "worker-sweep-ebay-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toMatchObject({
      code: "DROPSHIP_WORKER_SWEEP_FAILED",
      context: {
        worker: "ebay_order_intake",
        error: "marketplace unavailable",
      },
    });

    expect(repository.records[0]).toMatchObject({
      worker: "ebay_order_intake",
      status: "failed",
      metrics: null,
      errorMessage: "marketplace unavailable",
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_WORKER_SWEEP_FAILED",
      context: {
        worker: "ebay_order_intake",
        error: "marketplace unavailable",
      },
    });
  });

  it("rejects invalid inputs before running a worker", async () => {
    const repository = new FakeDropshipWorkerOpsRepository();
    const runner = new FakeDropshipWorkerSweepRunner({ processed: 0 });
    const service = makeService({
      repository,
      runners: {
        order_processing: runner,
      },
    });

    await expect(service.runSweep({
      worker: "order_processing",
      batchSize: 101,
      idempotencyKey: "worker-sweep-order-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toMatchObject({
      code: "DROPSHIP_WORKER_SWEEP_INVALID_INPUT",
    });
    expect(runner.inputs).toHaveLength(0);
    expect(repository.records).toHaveLength(0);
  });

  it("rejects non-finite worker metrics", async () => {
    const repository = new FakeDropshipWorkerOpsRepository();
    const runner = new FakeDropshipWorkerSweepRunner({ processed: Number.NaN });
    const service = makeService({
      repository,
      runners: {
        listing_push: runner,
      },
    });

    await expect(service.runSweep({
      worker: "listing_push",
      idempotencyKey: "worker-sweep-listing-2",
      actor: { actorType: "admin" },
    })).rejects.toMatchObject({
      code: "DROPSHIP_WORKER_SWEEP_FAILED",
      context: {
        worker: "listing_push",
      },
    });
    expect(repository.records[0]).toMatchObject({
      worker: "listing_push",
      status: "failed",
      metrics: null,
    });
  });
});

function makeService(input: {
  repository: DropshipWorkerOpsRepository;
  runners: Partial<Record<DropshipWorkerSweepName, DropshipWorkerSweepRunner>>;
  logs?: any[];
}): DropshipWorkerOpsService {
  return new DropshipWorkerOpsService({
    repository: input.repository,
    runners: {
      listing_push: input.runners.listing_push ?? missingRunner(),
      order_processing: input.runners.order_processing ?? missingRunner(),
      ebay_order_intake: input.runners.ebay_order_intake ?? missingRunner(),
    },
    clock: { now: () => now },
    logger: {
      info: (event) => input.logs?.push(event),
      warn: (event) => input.logs?.push(event),
      error: (event) => input.logs?.push(event),
    },
  });
}

function missingRunner(): DropshipWorkerSweepRunner {
  return {
    run: async () => {
      throw new Error("unexpected runner call");
    },
  };
}

class FakeDropshipWorkerSweepRunner implements DropshipWorkerSweepRunner {
  inputs: Parameters<DropshipWorkerSweepRunner["run"]>[0][] = [];

  constructor(
    private readonly metrics: DropshipWorkerSweepMetrics,
    private readonly error: Error | null = null,
  ) {}

  async run(input: Parameters<DropshipWorkerSweepRunner["run"]>[0]): Promise<DropshipWorkerSweepMetrics> {
    this.inputs.push(input);
    if (this.error) throw this.error;
    return this.metrics;
  }
}

class FakeDropshipWorkerOpsRepository implements DropshipWorkerOpsRepository {
  records: Parameters<DropshipWorkerOpsRepository["recordWorkerSweep"]>[0][] = [];

  async recordWorkerSweep(input: Parameters<DropshipWorkerOpsRepository["recordWorkerSweep"]>[0]): Promise<void> {
    this.records.push(input);
  }
}
