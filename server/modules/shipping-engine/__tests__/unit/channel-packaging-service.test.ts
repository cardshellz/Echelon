import { describe, it, expect, vi } from "vitest";
import {
  ChannelPackagingService,
  type ChannelPackagingStore,
} from "../../application/channel-packaging.service";
import type {
  PackagingPolicyOverview,
  SaveChannelPackaging,
} from "@shared/shipping/packaging-policy";

const overview: PackagingPolicyOverview = {
  channels: [
    {
      id: 11,
      name: "Dropship OMS",
      provider: "manual",
      status: "active",
      legacyProfile: "dropship",
    },
    {
      id: 12,
      name: "Another dropship-tagged channel",
      provider: "shopify",
      status: "active",
      legacyProfile: "dropship",
    },
  ],
  policies: [],
  warehouses: [],
  boxes: [],
  suites: [],
  pricing: [],
  warehouseAssignments: [],
};
const command: SaveChannelPackaging = {
  channelId: 11,
  defaultSuiteId: 1,
  requirement: "unbranded",
  overrides: [],
  expectedRevision: 0,
  commandId: "e9329d01-6a48-42e3-8ee3-dcebf2c84c4b",
};
const now = new Date("2026-09-09T12:00:00Z");
function setup(binding: () => Promise<number | null> = async () => 11) {
  const store: ChannelPackagingStore = {
    overview: vi.fn(async () => overview),
    savePolicy: vi.fn(async (input) => ({
      channelId: input.channelId,
      revision: 1,
      defaultSuiteId: input.defaultSuiteId,
      requirement: input.requirement,
      overrides: input.overrides,
    })),
    saveBox: vi.fn(),
  };
  return {
    store,
    service: new ChannelPackagingService(store, () => now, binding),
  };
}
describe("Dropship packaging scope", () => {
  it("exposes only the channel actually resolved by order intake", async () => {
    expect(
      (await setup().service.dropshipOverview()).channels.map((c) => c.id),
    ).toEqual([11]);
  });
  it("does not authorize other channels based on a Dropship tag", async () => {
    const { service, store } = setup();
    await expect(
      service.saveDropshipPolicy({ ...command, channelId: 12 }, "admin"),
    ).rejects.toMatchObject({ code: "SHIPPING_CHANNEL_FORBIDDEN" });
    expect(store.savePolicy).not.toHaveBeenCalled();
  });
  it("uses the same save command, actor and injected clock", async () => {
    const { service, store } = setup();
    await service.saveDropshipPolicy(command, "admin");
    expect(store.savePolicy).toHaveBeenCalledWith(command, "admin", now);
  });
  it("shows no invented binding before setup, and never swallows ambiguous configuration", async () => {
    expect(
      (await setup(async () => null).service.dropshipOverview()).channels,
    ).toEqual([]);
    const problem = new Error("Ambiguous channel binding");
    await expect(
      setup(async () => {
        throw problem;
      }).service.dropshipOverview(),
    ).rejects.toBe(problem);
  });
});
