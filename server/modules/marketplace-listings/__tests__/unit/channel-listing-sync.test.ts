import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ChannelListingSyncService } from "../../application/channel-listing-sync.service";
import { decideChannelListingSync } from "../../domain/channel-listing-sync";

const included = { active: true, included: true, includedVariantCount: 2, hasPublishedIdentity: false };
describe("shared channel create/update owner", () => {
  it.each([["missing", false, "create_or_adopt"], ["existing", true, "update"]] as const)(
    "%s listings select one durable execution path", async (_name, hasPublishedIdentity, operation) => {
      const adapter = { receipt: vi.fn(async () => null), state: vi.fn(async () => ({ ...included, hasPublishedIdentity })),
        admit: vi.fn(async () => "receipt"), block: vi.fn(async () => "blocked") };
      const owner = new ChannelListingSyncService(adapter);
      expect(await owner.request({ channelId: 4, productId: 21, commandKey: randomUUID(), actor: "operator" })).toBe("receipt");
      expect(adapter.admit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channelId: 4, productId: 21 }), operation);
      expect(adapter.block).not.toHaveBeenCalled();
    });
  it.each([
    [{ ...included, active: false }, "CHANNEL_SYNC_PRODUCT_INACTIVE"],
    [{ ...included, included: false }, "CHANNEL_SYNC_PRODUCT_EXCLUDED"],
    [{ ...included, includedVariantCount: 0 }, "CHANNEL_SYNC_VARIANTS_REQUIRED"],
  ] as const)("returns an actionable blocker without provider admission", async (state, code) => {
    const adapter = { receipt: vi.fn(async () => null), state: vi.fn(async () => state),
      admit: vi.fn(async () => "sent"), block: vi.fn(async () => "blocked") };
    expect(await new ChannelListingSyncService(adapter).request({ channelId: 4, productId: 21, commandKey: randomUUID(), actor: "operator" })).toBe("blocked");
    expect(adapter.block).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code }));
    expect(adapter.admit).not.toHaveBeenCalled();
  });
  it("replays the accepted command before changed inclusion or mappings", async () => {
    const adapter = { receipt: vi.fn(async () => "existing"), state: vi.fn(async () => included),
      admit: vi.fn(async () => "new"), block: vi.fn(async () => "blocked") };
    expect(await new ChannelListingSyncService(adapter).request({ channelId: 4, productId: 21, commandKey: randomUUID(), actor: "operator" })).toBe("existing");
    expect(adapter.state).not.toHaveBeenCalled(); expect(adapter.admit).not.toHaveBeenCalled();
  });
  it("does not turn unavailable state into a missing listing or permanent rejection", async () => {
    const adapter = { receipt: vi.fn(async () => null), state: vi.fn(async () => { throw new Error("database read failed"); }),
      admit: vi.fn(async () => "sent"), block: vi.fn(async () => "blocked") };
    await expect(new ChannelListingSyncService(adapter).request({ channelId: 4, productId: 21, commandKey: randomUUID(), actor: "operator" })).rejects.toThrow("database read failed");
    expect(adapter.admit).not.toHaveBeenCalled(); expect(adapter.block).not.toHaveBeenCalled();
  });
  it("rejects invalid normalized evidence", () => {
    expect(() => decideChannelListingSync({ ...included, includedVariantCount: -1 })).toThrow();
  });
});
