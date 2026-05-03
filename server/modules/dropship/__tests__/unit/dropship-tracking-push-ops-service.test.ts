import { describe, expect, it } from "vitest";
import type {
  DropshipTrackingPushOpsListResult,
  DropshipTrackingPushOpsRepository,
} from "../../application/dropship-tracking-push-ops-service";
import { DropshipTrackingPushOpsService } from "../../application/dropship-tracking-push-ops-service";

describe("DropshipTrackingPushOpsService", () => {
  it("lists attention pushes by default", async () => {
    const repository = new FakeTrackingPushOpsRepository();
    const service = makeService(repository);

    const result = await service.listPushes({ page: 1, limit: 25 });

    expect(result.statuses).toEqual(["failed", "processing", "queued"]);
    expect(repository.inputs[0]).toMatchObject({
      statuses: ["failed", "processing", "queued"],
      page: 1,
      limit: 25,
    });
  });

  it("preserves explicit filters for ops search", async () => {
    const repository = new FakeTrackingPushOpsRepository();
    const service = makeService(repository);

    await service.listPushes({
      statuses: ["succeeded"],
      vendorId: 12,
      storeConnectionId: 34,
      platform: "shopify",
      search: "9400",
      page: 2,
      limit: 10,
    });

    expect(repository.inputs[0]).toEqual({
      statuses: ["succeeded"],
      vendorId: 12,
      storeConnectionId: 34,
      platform: "shopify",
      search: "9400",
      page: 2,
      limit: 10,
    });
  });

  it("rejects invalid statuses before the repository is called", async () => {
    const repository = new FakeTrackingPushOpsRepository();
    const service = makeService(repository);

    await expect(service.listPushes({ statuses: ["completed"] })).rejects.toMatchObject({
      code: "DROPSHIP_TRACKING_PUSH_OPS_LIST_INVALID_INPUT",
    });
    expect(repository.inputs).toHaveLength(0);
  });
});

function makeService(repository: DropshipTrackingPushOpsRepository): DropshipTrackingPushOpsService {
  return new DropshipTrackingPushOpsService({
    repository,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
}

class FakeTrackingPushOpsRepository implements DropshipTrackingPushOpsRepository {
  inputs: Parameters<DropshipTrackingPushOpsRepository["listPushes"]>[0][] = [];

  async listPushes(
    input: Parameters<DropshipTrackingPushOpsRepository["listPushes"]>[0],
  ): Promise<DropshipTrackingPushOpsListResult> {
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
