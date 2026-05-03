import { describe, expect, it } from "vitest";
import {
  DropshipOmsChannelConfigService,
  hashDropshipOmsChannelConfigCommand,
  type DropshipOmsChannelConfigMutationResult,
  type DropshipOmsChannelConfigOverview,
  type DropshipOmsChannelConfigRepository,
} from "../../application/dropship-oms-channel-config-service";

const now = new Date("2026-05-03T18:00:00.000Z");

describe("DropshipOmsChannelConfigService", () => {
  it("validates input and passes idempotency context to the repository", async () => {
    const repository = new FakeOmsChannelConfigRepository();
    const service = new DropshipOmsChannelConfigService({
      repository,
      clock: { now: () => now },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    const result = await service.configure({
      channelId: 7,
      idempotencyKey: "oms-channel-001",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.selectedChannel.channelId).toBe(7);
    expect(repository.lastConfigureInput).toMatchObject({
      channelId: 7,
      idempotencyKey: "oms-channel-001",
      requestHash: expect.any(String),
      now,
      actor: { actorType: "admin", actorId: "admin-1" },
    });
  });

  it("hashes semantically equivalent command payloads deterministically", () => {
    const first = hashDropshipOmsChannelConfigCommand("dropship_oms_channel_configured", {
      channelId: 7,
      metadata: { b: 2, a: 1 },
    });
    const second = hashDropshipOmsChannelConfigCommand("dropship_oms_channel_configured", {
      metadata: { a: 1, b: 2 },
      channelId: 7,
    });

    expect(first).toBe(second);
  });

  it("rejects invalid channel ids before repository writes", async () => {
    const repository = new FakeOmsChannelConfigRepository();
    const service = new DropshipOmsChannelConfigService({
      repository,
      clock: { now: () => now },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await expect(service.configure({
      channelId: 0,
      idempotencyKey: "oms-channel-002",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toThrow();
    expect(repository.lastConfigureInput).toBeNull();
  });
});

class FakeOmsChannelConfigRepository implements DropshipOmsChannelConfigRepository {
  lastConfigureInput: Parameters<DropshipOmsChannelConfigRepository["configure"]>[0] | null = null;

  async getOverview(input: Parameters<DropshipOmsChannelConfigRepository["getOverview"]>[0]): Promise<DropshipOmsChannelConfigOverview> {
    return makeOverview(input.generatedAt);
  }

  async configure(
    input: Parameters<DropshipOmsChannelConfigRepository["configure"]>[0],
  ): Promise<DropshipOmsChannelConfigMutationResult> {
    this.lastConfigureInput = input;
    return {
      config: makeOverview(input.now),
      selectedChannel: {
        channelId: input.channelId,
        name: "Dropship OMS",
        type: "internal",
        provider: "manual",
        status: "active",
        isDropshipOmsChannel: true,
        markerSources: ["channel.shipping_config.dropship.omsChannel"],
        updatedAt: input.now,
      },
      idempotentReplay: false,
    };
  }
}

function makeOverview(generatedAt: Date): DropshipOmsChannelConfigOverview {
  return {
    currentChannelId: 7,
    currentChannelCount: 1,
    generatedAt,
    channels: [{
      channelId: 7,
      name: "Dropship OMS",
      type: "internal",
      provider: "manual",
      status: "active",
      isDropshipOmsChannel: true,
      markerSources: ["channel.shipping_config.dropship.omsChannel"],
      updatedAt: generatedAt,
    }],
  };
}
