import { describe, expect, it, vi } from "vitest";
import { readEbayConnectionHealth } from "../../ebay-connection-health";
import { ChannelFulfillmentProviderError } from "../../channel-fulfillment-provider.error";
const account = { externalAccountId: "account-1",externalAccountDisplayName: "seller",externalAccountIdentityScheme: "provider_user_id" as const,
  externalAccountVerifiedAt: new Date("2026-10-09T12:00:00Z") };
function fixture() { return { getAccessToken: vi.fn(async () => "private-token"),observeProviderAccount: vi.fn(async () => account),getVerifiedProviderAccount: vi.fn(async () => account) }; }
describe("eBay connection health", () => {
  it.each([
    ["EBAY_FULFILLMENT_AUTHORIZATION_FAILED", "transient", "EBAY_AUTH_UNAVAILABLE", "retry_sync"],
    ["EBAY_FULFILLMENT_AUTHORIZATION_REJECTED", "transient", "EBAY_AUTH_UNAVAILABLE", "retry_sync"],
    ["EBAY_FULFILLMENT_AUTHORIZATION_REJECTED", "permanent", "EBAY_AUTH_REQUIRED", "reconnect"],
  ] as const)("maps %s (%s) to an actionable connection result", async (code, failureClass, expectedCode, actionKind) => {
    const auth = fixture();
    auth.observeProviderAccount.mockRejectedValueOnce(new ChannelFulfillmentProviderError(code, "Sanitized authorization failure", failureClass));
    expect(await readEbayConnectionHealth(auth, 67)).toMatchObject({
      connectionHealth: "needs_attention", connectionIssue: { code: expectedCode, action: { kind: actionKind }, retryable: failureClass === "transient" },
    });
    expect(auth.getVerifiedProviderAccount).not.toHaveBeenCalled();
  });
  it("reports verified only after a live account matches its stored identity", async () => {
    const auth = fixture(); expect(await readEbayConnectionHealth(auth,67)).toEqual({ connectionHealth: "verified",connectionIssue: null,ebayUsername: "seller" });
    expect(auth.observeProviderAccount).toHaveBeenCalledExactlyOnceWith("private-token");
  });
  it("does not report a wrong seller account as connected", async () => {
    const auth = fixture(); auth.observeProviderAccount.mockResolvedValueOnce({ ...account,externalAccountId: "wrong-account" });
    expect(await readEbayConnectionHealth(auth,67)).toMatchObject({ connectionHealth: "needs_attention",connectionIssue: { code: "EBAY_PROVIDER_ACCOUNT_IDENTITY_CONFLICT",action: { kind: "reconnect" } } });
  });
  it("makes failed verification visible without exposing credentials or claiming credential deletion", async () => {
    const auth = fixture(); auth.observeProviderAccount.mockRejectedValueOnce(new Error("Bearer private-token"));
    const result = await readEbayConnectionHealth(auth,67);
    expect(result).toMatchObject({ connectionHealth: "needs_attention",connectionIssue: { code: "EBAY_AUTH_UNAVAILABLE", title: "Connection could not be verified", action: { label: "Check connection again" } } });
    expect(result.connectionIssue?.nextStep).not.toContain("product");
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(auth.getVerifiedProviderAccount).not.toHaveBeenCalled();
  });
});
