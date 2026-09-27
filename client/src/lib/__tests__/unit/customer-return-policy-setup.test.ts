import { describe, expect, it } from "vitest";
import {
  createPortalPolicyDraft,
  resolvePortalPolicySetupChannel,
} from "../../customer-return-policy-setup";
import { matchesCustomerReturnPortalPolicy } from "@shared/returns/customer-return-portal-policy";

const channel = {
  id: 36,
  name: "Shopify",
  type: "internal",
  provider: "shopify",
  status: "active",
};

describe("customer return policy setup", () => {
  it("leaves ordinary policy administration unchanged without the setup query", () => {
    expect(resolvePortalPolicySetupChannel("", [channel], 103)).toBeNull();
  });

  it("selects only the explicit known channel and never mutates catalog input", () => {
    const frozen = Object.freeze({ ...channel });
    expect(
      resolvePortalPolicySetupChannel(
        "?portalChannelId=36",
        Object.freeze([frozen]),
        103,
      ),
    ).toBe(frozen);
  });

  it.each([
    "",
    "0",
    "-1",
    "1.5",
    "036",
    "3e1",
    "9007199254740992",
    "unknown",
    "37",
    "36&portalChannelId=36",
  ])("rejects invalid or ambiguous channel query %s", (value) => {
    expect(() =>
      resolvePortalPolicySetupChannel(
        `?portalChannelId=${value}`,
        [channel],
        103,
      ),
    ).toThrow("active Shopify sales channel");
  });

  it.each([
    { status: "inactive" },
    { provider: "manual" },
    { type: "partner" },
  ])("rejects an unsupported channel: %j", (patch) => {
    expect(() =>
      resolvePortalPolicySetupChannel(
        "?portalChannelId=36",
        [{ ...channel, ...patch }],
        103,
      ),
    ).toThrow();
  });

  it("rejects canonical dropship and ambiguous channel records", () => {
    expect(() =>
      resolvePortalPolicySetupChannel("?portalChannelId=36", [channel], 36),
    ).toThrow();
    expect(() =>
      resolvePortalPolicySetupChannel(
        "?portalChannelId=36",
        [channel, channel],
        103,
      ),
    ).toThrow();
  });

  it("prepares a channel-scoped policy accepted by the existing portal requirements", () => {
    const draft = createPortalPolicyDraft(channel);
    expect(draft).toMatchObject({
      name: "Shopify customer returns",
      appliesTo: "channel",
      channelId: 36,
      vendorId: null,
      storeConnectionId: null,
      inspectionRequirement: "required",
      returnlessRefundAllowed: false,
    });
    expect(
      matchesCustomerReturnPortalPolicy(
        { ...draft, status: "active", businessContext: "retail" },
        36,
      ),
    ).toBe(true);
    expect(
      matchesCustomerReturnPortalPolicy(
        { ...draft, status: "active", businessContext: "retail" },
        37,
      ),
    ).toBe(false);
    expect(draft).not.toHaveProperty("enabled");
  });

  it("bounds generated policy names to the existing API limit", () => {
    expect(
      createPortalPolicyDraft({ ...channel, name: "S".repeat(200) }).name,
    ).toHaveLength(160);
  });
});
