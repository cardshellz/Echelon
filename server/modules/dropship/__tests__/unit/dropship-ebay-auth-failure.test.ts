import { describe, expect, it } from "vitest";
import {
  isEbayResourceAuthFailureStatus,
  isEbayTokenRefreshAuthFailureStatus,
} from "../../infrastructure/dropship-ebay-auth-failure";

describe("eBay auth failure classification", () => {
  it("treats only authorization failures as credential failures on resource APIs", () => {
    expect(isEbayResourceAuthFailureStatus(400)).toBe(false);
    expect(isEbayResourceAuthFailureStatus(401)).toBe(true);
    expect(isEbayResourceAuthFailureStatus(403)).toBe(true);
    expect(isEbayResourceAuthFailureStatus(429)).toBe(false);
    expect(isEbayResourceAuthFailureStatus(500)).toBe(false);
  });

  it("keeps an invalid-grant 400 credential-fatal on the token refresh endpoint", () => {
    expect(isEbayTokenRefreshAuthFailureStatus(400)).toBe(true);
    expect(isEbayTokenRefreshAuthFailureStatus(401)).toBe(true);
    expect(isEbayTokenRefreshAuthFailureStatus(403)).toBe(true);
    expect(isEbayTokenRefreshAuthFailureStatus(429)).toBe(false);
    expect(isEbayTokenRefreshAuthFailureStatus(500)).toBe(false);
  });
});
