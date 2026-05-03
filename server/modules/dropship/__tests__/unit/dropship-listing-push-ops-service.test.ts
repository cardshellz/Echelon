import { describe, expect, it } from "vitest";
import type {
  DropshipListingPushOpsJobListResult,
  DropshipListingPushOpsRepository,
} from "../../application/dropship-listing-push-ops-service";
import { DropshipListingPushOpsService } from "../../application/dropship-listing-push-ops-service";

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
});

function makeService(repository: DropshipListingPushOpsRepository): DropshipListingPushOpsService {
  return new DropshipListingPushOpsService({
    repository,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
}

class FakeListingPushOpsRepository implements DropshipListingPushOpsRepository {
  inputs: Parameters<DropshipListingPushOpsRepository["listJobs"]>[0][] = [];

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
}
