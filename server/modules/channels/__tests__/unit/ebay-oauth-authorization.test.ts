import { describe, expect, it, vi } from "vitest";
import { createEbayOAuthAuthorization, verifyEbayOAuthAuthorization, resolveEbayOAuthChannel } from "../../ebay-oauth-authorization";

const now = Date.parse("2026-10-10T00:00:00Z");
const challenge = createEbayOAuthAuthorization({ nonce: "a".repeat(64), actorId: "user-1", channelId: 67, environment: "production", now });
const valid = { ...challenge, actorId: "user-1", environment: "production" as const, now: now + 1 };

describe("eBay OAuth authorization challenge", () => {
  it("binds a random challenge to the initiating actor, exact channel and environment", () => {
    expect(verifyEbayOAuthAuthorization(valid)).toMatchObject({ actorId: "user-1", channelId: 67, environment: "production" });
    expect(challenge.authorization.digest).not.toContain(challenge.state);
  });
  it.each([
    { state: "67" }, { state: "echelon-ebay-setup" }, { state: `echelon-${"b".repeat(64)}` },
    { actorId: "user-2" }, { environment: "sandbox" }, { now: now + 10 * 60 * 1000 },
    { authorization: undefined }, { state: [challenge.state] },
  ])("rejects mismatched, expired or missing challenge context: %j", (override) => {
    expect(() => verifyEbayOAuthAuthorization({ ...valid, ...override } as typeof valid)).toThrow(/authorization|connection/i);
  });
  it("does not pick arbitrarily when more than one eBay channel exists", async () => {
    const storage = { getAllChannels: vi.fn().mockResolvedValue([{ id: 67, provider: "ebay" }, { id: 68, provider: "ebay" }]), getChannelById: vi.fn() };
    await expect(resolveEbayOAuthChannel(storage)).rejects.toThrow("intended eBay channel");
  });
  it("rejects a selected channel owned by another provider", async () => {
    const storage = { getAllChannels: vi.fn(), getChannelById: vi.fn().mockResolvedValue({ id: 67, provider: "shopify" }) };
    await expect(resolveEbayOAuthChannel(storage, 67)).rejects.toThrow("not an eBay channel");
  });
});
