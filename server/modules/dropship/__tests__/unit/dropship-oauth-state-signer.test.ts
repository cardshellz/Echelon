import { describe, expect, it } from "vitest";
import type { DropshipOAuthStatePayload } from "../../application/dropship-store-connection-service";
import { HmacDropshipOAuthStateSigner } from "../../infrastructure/dropship-oauth-state-signer";

const now = new Date("2026-09-04T12:00:00.000Z");
const signer = new HmacDropshipOAuthStateSigner("test-secret-that-is-at-least-thirty-two-characters-long");

describe("HmacDropshipOAuthStateSigner", () => {
  it("round-trips an exact store reauthorization target", () => {
    const payload: DropshipOAuthStatePayload = {
      version: 1,
      vendorId: 10,
      memberId: "member-1",
      platform: "ebay",
      shopDomain: null,
      intent: "refresh_connection",
      nonce: "nonce",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      returnTo: "/dropship/onboarding",
      targetStoreConnectionId: 44,
      targetConnectionFingerprint: "a".repeat(32),
      targetConnectionUpdatedAt: now.toISOString(),
    };

    expect(signer.verify(signer.sign(payload), now)).toEqual(payload);
  });

  it("rejects malformed target fields even when the payload signature is valid", () => {
    const malformed = {
      version: 1,
      vendorId: 10,
      memberId: "member-1",
      platform: "ebay",
      shopDomain: null,
      intent: "refresh_connection",
      nonce: "nonce",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      returnTo: "/dropship/onboarding",
      targetStoreConnectionId: "44",
      targetConnectionFingerprint: "not-a-fingerprint",
      targetConnectionUpdatedAt: "not-a-date",
    } as unknown as DropshipOAuthStatePayload;

    expect(() => signer.verify(signer.sign(malformed), now)).toThrowError(
      expect.objectContaining({ code: "DROPSHIP_INVALID_OAUTH_STATE" }),
    );
  });
});
