import { describe, expect, it } from "vitest";
import {
  classifyEbayTokenRefreshFailure,
  isEbayResourceAuthFailureStatus,
} from "../../infrastructure/dropship-ebay-auth-failure";

describe("eBay auth failure classification", () => {
  it("treats only authorization failures as credential failures on resource APIs", () => {
    expect(isEbayResourceAuthFailureStatus(400)).toBe(false);
    expect(isEbayResourceAuthFailureStatus(401)).toBe(true);
    expect(isEbayResourceAuthFailureStatus(403)).toBe(false);
    expect(isEbayResourceAuthFailureStatus(429)).toBe(false);
    expect(isEbayResourceAuthFailureStatus(500)).toBe(false);
  });

  it("requires reauthorization only when eBay explicitly rejects the refresh grant", () => {
    expect(classifyEbayTokenRefreshFailure({
      status: 400,
      responseBody: JSON.stringify({
        error: "invalid_grant",
        error_description: "the refresh token is invalid or revoked",
      }),
    })).toEqual({
      connectionStatus: "needs_reauth",
      providerErrorCode: "invalid_grant",
      providerErrorDescription: "the refresh token is invalid or revoked",
      retryable: false,
    });
  });

  it.each([
    [400, JSON.stringify({ error: "invalid_scope", error_description: "scope is not granted" }), false],
    [401, JSON.stringify({ error: "invalid_client" }), false],
    [400, "not-json", false],
    [429, JSON.stringify({ error: "temporarily_unavailable" }), true],
    [503, "upstream unavailable", true],
  ])("preserves the refresh grant for a non-definitive HTTP %i failure", (status, responseBody, retryable) => {
    expect(classifyEbayTokenRefreshFailure({ status, responseBody })).toMatchObject({
      connectionStatus: "refresh_failed",
      retryable,
    });
  });
});
