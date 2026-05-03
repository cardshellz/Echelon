import { describe, expect, it } from "vitest";
import type {
  DropshipNotificationOpsListResult,
  DropshipNotificationOpsRepository,
} from "../../application/dropship-notification-ops-service";
import { DropshipNotificationOpsService } from "../../application/dropship-notification-ops-service";

describe("DropshipNotificationOpsService", () => {
  it("lists failed and pending notification events by default", async () => {
    const repository = new FakeNotificationOpsRepository();
    const service = makeService(repository);

    const result = await service.listEvents({ page: 1, limit: 25 });

    expect(result.statuses).toEqual(["failed", "pending"]);
    expect(repository.inputs[0]).toMatchObject({
      statuses: ["failed", "pending"],
      page: 1,
      limit: 25,
    });
  });

  it("preserves explicit filters for ops search", async () => {
    const repository = new FakeNotificationOpsRepository();
    const service = makeService(repository);

    await service.listEvents({
      statuses: ["delivered"],
      channels: ["email"],
      vendorId: 12,
      critical: true,
      search: "payment hold",
      page: 2,
      limit: 10,
    });

    expect(repository.inputs[0]).toEqual({
      statuses: ["delivered"],
      channels: ["email"],
      vendorId: 12,
      critical: true,
      search: "payment hold",
      page: 2,
      limit: 10,
    });
  });

  it("rejects invalid status filters before the repository is called", async () => {
    const repository = new FakeNotificationOpsRepository();
    const service = makeService(repository);

    await expect(service.listEvents({ statuses: ["retrying"] })).rejects.toMatchObject({
      code: "DROPSHIP_NOTIFICATION_OPS_LIST_INVALID_INPUT",
    });
    expect(repository.inputs).toHaveLength(0);
  });
});

function makeService(repository: DropshipNotificationOpsRepository): DropshipNotificationOpsService {
  return new DropshipNotificationOpsService({
    repository,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
}

class FakeNotificationOpsRepository implements DropshipNotificationOpsRepository {
  inputs: Parameters<DropshipNotificationOpsRepository["listEvents"]>[0][] = [];

  async listEvents(
    input: Parameters<DropshipNotificationOpsRepository["listEvents"]>[0],
  ): Promise<DropshipNotificationOpsListResult> {
    this.inputs.push(input);
    return {
      items: [],
      total: 0,
      page: input.page,
      limit: input.limit,
      statuses: input.statuses,
      channels: input.channels ?? null,
      summary: [],
      channelSummary: [],
    };
  }
}
