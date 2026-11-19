import { afterEach, describe, expect, it, vi } from "vitest";
import { listingFailure, listingFailureStatus } from "../../ebay-listing-errors";

vi.mock("../../../../db", () => ({ pool: {} }));
afterEach(() => vi.restoreAllMocks());

describe("safe listing read diagnostics at the HTTP boundary", () => {
  it("includes the normalized endpoint, failed field and provider reference without copying response data", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const providerRead = { provider: "ebay", resource: "offers", method: "GET", kind: "invalid_response",
      httpStatus: 200, requestId: "provider-read-123", issues: [{ path: "offers.0.offerId", code: "invalid_type" }] };
    const error = Object.assign(new Error("private provider body"), { code: "EBAY_REGISTRATION_PROVIDER_RESPONSE_INVALID",
      context: { providerRead, body: { secret: "private" } } });
    const result = listingFailure(error, 20);
    expect(result.issue).toMatchObject({ action: { kind: "retry_sync" }, diagnosticAction: { kind: "check_recovery" },
      details: expect.arrayContaining([{ label: "Rejected field", value: "offers.0.offerId: invalid_type" }]) });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ code: error.code, providerRead });
    expect(log.mock.calls[0][0]).not.toContain("private");
    expect(listingFailureStatus(error)).toBe(500);
  });
  it("does not turn an unrelated database failure into provider diagnostics or expose SQL", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = Object.assign(new Error("private SQL password"), { code: "23505", context: { body: "private" } });
    const result = listingFailure(error, 20);
    expect(result.code).toBe("EBAY_LISTING_SYNC_FAILED");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(log.mock.calls[0][0]).not.toContain("private");
  });
});
