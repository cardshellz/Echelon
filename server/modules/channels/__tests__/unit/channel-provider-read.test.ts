import { describe, expect, it, vi } from "vitest";
import { channelProviderReadDiagnosticSchema, providerReadDiagnosticFromError, providerReadShouldRetry, providerReadDetails } from "@shared/channel-provider-read";
import { resolveEbayListingIssue, resolveEbayListingJobIssue } from "@shared/ebay-listing-issue";
import { ebayListingSyncJobSchema } from "@shared/types/ebay-listing-sync";
import { ebayListingFailureDiagnostic } from "../../ebay-listing-failure-diagnostic";
import { syncFailure } from "../../ebay-listing-sync.domain";
import { ebayReadDiagnostic, ebayReadFailureKind } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-read-diagnostic";
import { EbayMarketplaceRegistrationObserver } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import { EbayApiRequestError } from "../../adapters/ebay/ebay-api-error";

const now = new Date("2026-10-21T12:00:00Z");
const read = channelProviderReadDiagnosticSchema.parse({ provider: "ebay", resource: "offers", method: "GET", kind: "invalid_response",
  httpStatus: 200, requestId: "request-123", issues: [{ path: "offers.0.offerId", code: "invalid_type" }] });
const failure = (providerRead = read) => Object.assign(new Error("private provider body"), {
  code: "EBAY_REGISTRATION_PROVIDER_RESPONSE_INVALID", context: { providerRead, body: "private", headers: { authorization: "private" } },
});
describe("shared provider read failure policy and diagnostics", () => {
  it("preserves HTTP read failures at their transport source without classifying writes as reads", () => {
    const error = new EbayApiRequestError(500, "private provider body", "private provider body", "listing_resource");
    expect(providerReadDiagnosticFromError(error)).toEqual({ provider: "ebay", resource: "listing_resource", method: "GET", kind: "unavailable", httpStatus: 500 });
    expect(syncFailure(error, 1, now).state).toBe("recovering");
    expect(JSON.stringify(ebayListingFailureDiagnostic(error))).not.toContain("private provider body");
    expect(providerReadDiagnosticFromError(new EbayApiRequestError(500, "write failure", "private provider body"))).toBeUndefined();
  });
  it("retains the actual method of a read-only POST without admitting mutation methods", () => {
    const diagnostic = channelProviderReadDiagnosticSchema.parse({ ...read, resource: "listing_package", method: "POST" });
    expect(providerReadDetails(diagnostic)[0]).toEqual({ label: "Provider read", value: "ebay / listing_package (POST)" });
    expect(syncFailure(failure(diagnostic), 1, now)).toMatchObject({ state: "recovering" });
    expect(channelProviderReadDiagnosticSchema.safeParse({ ...read, method: "PUT" }).success).toBe(false);
  });
  it("preserves only bounded safe evidence through a wrapped cause", () => {
    const wrapped = Object.assign(new Error("outer", { cause: failure() }), { code: "EBAY_SYNC_PREPARE_FAILED" });
    expect(ebayListingFailureDiagnostic(wrapped)).toEqual({ code: wrapped.code, context: { providerRead: read } });
    expect(syncFailure(wrapped, 1, now)).toMatchObject({ state: "recovering" });
    expect(syncFailure(wrapped, 1, now).message).not.toContain("private");
  });
  it("bounds cycles and rejects arbitrary context and response bodies", () => {
    const cycle = new Error("cycle"); cycle.cause = cycle;
    expect(providerReadDiagnosticFromError(cycle)).toBeUndefined();
    expect(providerReadDiagnosticFromError(failure({ ...read, body: "private" } as typeof read))).toBeUndefined();
    expect(channelProviderReadDiagnosticSchema.safeParse({ ...read, resource: "https://private?token=x" }).success).toBe(false);
  });
  it.each(["ebay", "shopify", "walmart"])("uses the same bounded invalid-read policy for %s", provider => {
    expect(providerReadShouldRetry({ ...read, provider }, 4)).toBe(true);
    expect(providerReadShouldRetry({ ...read, provider }, 5)).toBe(false);
    expect(providerReadShouldRetry({ ...read, provider, kind: "unavailable" }, 500)).toBe(true);
    expect(providerReadShouldRetry({ ...read, provider, kind: "refused" }, 1)).toBe(false);
  });
  it.each([-1, 1.5, NaN, Infinity])("rejects an invalid attempt count %s", attempts => {
    expect(() => providerReadShouldRetry(read, attempts)).toThrow();
  });
  it.each([[408,"unavailable"],[429,"unavailable"],[500,"unavailable"],[503,"unavailable"],[401,"refused"],[403,"refused"],[400,"refused"],[NaN,"invalid_response"]] as const)(
    "classifies HTTP %s before deciding whether to retry", (status, kind) => {
      expect(ebayReadFailureKind(status)).toBe(kind);
      const diagnostic = ebayReadDiagnostic("offers", kind, { status });
      expect(syncFailure(failure(diagnostic), 1, now).state).toBe(kind === "refused" ? "needs_attention" : "recovering");
    });
  it("truncates validation evidence and drops an unsafe provider request ID", () => {
    const diagnostic = ebayReadDiagnostic("offers", "invalid_response", { status: 200, requestId: "Bearer private" },
      Array.from({ length: 30 }, (_, i) => ({ path: ["offers", i, "offerId"], code: "invalid_type" })));
    expect(diagnostic.issues).toHaveLength(25); expect(diagnostic.issuesTruncated).toBe(true);
    expect(diagnostic.requestId).toBeUndefined();
    expect(resolveEbayListingIssue({ code: failure().code, productId: 20, providerRead: diagnostic }).details?.length).toBeLessThanOrEqual(25);
  });
  it("replaces a cached cryptic card with retry and recovery actions without declaring success", () => {
    const job = ebayListingSyncJobSchema.parse({ id: "655ca747-20b9-4940-9c61-019baf1c11c1", productId: 20, state: "needs_attention",
      code: failure().code, message: "old invalid registration observation", nextAttemptAt: now.toISOString(), updatedAt: now.toISOString(),
      providerRead: read, issue: resolveEbayListingIssue({ code: "UNKNOWN_ERROR", message: "old card" }) });
    expect(resolveEbayListingJobIssue(job)).toMatchObject({ title: "The listing check could not finish", action: { kind: "retry_sync" },
      diagnosticAction: { kind: "check_recovery" }, details: expect.arrayContaining([{ label: "Rejected field", value: "offers.0.offerId: invalid_type" }]) });
    expect(resolveEbayListingJobIssue({ ...job, state: "recovering" })).toMatchObject({ retryable: false, action: { kind: "check_status" } });
    expect(resolveEbayListingIssue({ code: "PUBLICATION_RECOVERY_REVIEW_REQUIRED" }).action.kind).toBe("check_recovery");
    expect(resolveEbayListingIssue({ providerRead: { ...read, kind: "refused", httpStatus: 401 } }).action.kind).toBe("reconnect");
  });
  it("retains exact validation fields from the real registration parser without copying the response", async () => {
    const get = vi.fn(async () => ({ status: 200, requestId: "read-123", body: { userId: 77, secret: "private" } }));
    const observer = new EbayMarketplaceRegistrationObserver({ loadFreshCredential: async () => ({ accessToken: "private", environment: "production" as const }) }, { get });
    const error: unknown = await observer.observeExistingPublication({
      owner: { kind: "channel", channelId: 1, productId: 20, provider: "ebay", marketplaceId: "EBAY_US" },
      locator: { providerPublicationKey: "PACK", externalListingId: "listing-20" },
      memberCandidates: [{ productVariantId: 101, sku: "P5", isActive: true, availableQuantity: 1 }],
    }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(ebayListingFailureDiagnostic(error)).toMatchObject({ code: failure().code, context: { providerRead: {
      provider: "ebay", resource: "identity", kind: "invalid_response", httpStatus: 200, requestId: "read-123",
      issues: [{ path: "userId", code: "invalid_type" }],
    } } });
    expect(JSON.stringify(ebayListingFailureDiagnostic(error))).not.toContain("private");
    expect(get).toHaveBeenCalledOnce();
  });
});
