import { describe, expect, it } from "vitest";
import type {
  DropshipListingPushOpsActionResult,
  DropshipListingPushOpsJobListResult,
  DropshipListingPushOpsRepository,
} from "../../application/dropship-listing-push-ops-service";
import { DropshipListingPushOpsService } from "../../application/dropship-listing-push-ops-service";

const now = new Date("2026-05-07T18:00:00.000Z");

describe("DropshipListingPushOpsService", () => {
  it("lists attention jobs by default", async () => {
    const repository = new FakeListingPushOpsRepository();
    const service = makeService(repository);

    const result = await service.listJobs({ page: 1, limit: 25 });

    expect(result.statuses).toEqual(["failed", "processing", "queued"]);
    expect(repository.inputs[0]).toMatchObject({
      statuses: ["failed", "processing", "queued"],
      page: 1,
      limit: 25,
    });
  });

  it("preserves explicit filters for ops search", async () => {
    const repository = new FakeListingPushOpsRepository();
    const service = makeService(repository);

    await service.listJobs({
      statuses: ["completed"],
      vendorId: 12,
      storeConnectionId: 34,
      platform: "ebay",
      search: "job-1",
      page: 2,
      limit: 10,
    });

    expect(repository.inputs[0]).toEqual({
      statuses: ["completed"],
      vendorId: 12,
      storeConnectionId: 34,
      platform: "ebay",
      search: "job-1",
      page: 2,
      limit: 10,
    });
  });

  it("rejects invalid statuses before the repository is called", async () => {
    const repository = new FakeListingPushOpsRepository();
    const service = makeService(repository);

    await expect(service.listJobs({ statuses: ["blocked"] })).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_PUSH_OPS_LIST_INVALID_INPUT",
    });
    expect(repository.inputs).toHaveLength(0);
  });

  it("requests failed job retry with actor, clock, idempotency, and audit log context", async () => {
    const repository = new FakeListingPushOpsRepository();
    const logs: any[] = [];
    const service = makeService(repository, logs);

    const result = await service.retryJob({
      jobId: 44,
      reason: "marketplace outage cleared",
      idempotencyKey: "retry-listing-job-44",
      actor: { actorType: "admin", actorId: "ops-user" },
    });

    expect(result).toMatchObject({
      jobId: 44,
      previousStatus: "failed",
      status: "queued",
      requeuedItemCount: 2,
    });
    expect(repository.retryInputs[0]).toMatchObject({
      jobId: 44,
      reason: "marketplace outage cleared",
      idempotencyKey: "retry-listing-job-44",
      actor: { actorType: "admin", actorId: "ops-user" },
      now,
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_LISTING_PUSH_OPS_RETRY_REQUESTED",
      context: {
        jobId: 44,
        previousStatus: "failed",
        status: "queued",
        requeuedItemCount: 2,
        idempotencyKey: "retry-listing-job-44",
      },
    });
  });
});

function makeService(
  repository: DropshipListingPushOpsRepository,
  logs: any[] = [],
): DropshipListingPushOpsService {
  return new DropshipListingPushOpsService({
    repository,
    logger: {
      info: (event) => logs.push(event),
      warn: (event) => logs.push(event),
      error: (event) => logs.push(event),
    },
    clock: { now: () => now },
  });
}

class FakeListingPushOpsRepository implements DropshipListingPushOpsRepository {
  inputs: Parameters<DropshipListingPushOpsRepository["listJobs"]>[0][] = [];
  retryInputs: Parameters<DropshipListingPushOpsRepository["retryJob"]>[0][] = [];

  async listJobs(input: Parameters<DropshipListingPushOpsRepository["listJobs"]>[0]): Promise<DropshipListingPushOpsJobListResult> {
    this.inputs.push(input);
    return {
      items: [],
      total: 0,
      page: input.page,
      limit: input.limit,
      statuses: input.statuses,
      summary: [],
    };
  }

  async retryJob(
    input: Parameters<DropshipListingPushOpsRepository["retryJob"]>[0],
  ): Promise<DropshipListingPushOpsActionResult> {
    this.retryInputs.push(input);
    return {
      jobId: input.jobId,
      previousStatus: "failed",
      status: "queued",
      requeuedItemCount: 2,
      idempotentReplay: false,
      updatedAt: input.now,
    };
  }
}
