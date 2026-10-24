import { describe, expect, it } from "vitest";
import { ebayListingFailureDiagnostic } from "../../ebay-listing-failure-diagnostic";
import { syncFailure } from "../../ebay-listing-sync.domain";

describe("saved listing failure diagnostics", () => {
  it.each([
    { scope: "store" },
    { scope: "category", productTypeSlug: "toploaders" },
    { scope: "product", productId: 232 },
    { scope: "variant", productId: 232, variantId: 208 },
  ])("retains exact policy provenance for $scope without copying unrelated context", policySource => {
    const error = Object.assign(new Error("Unavailable saved policy"), { code: "EBAY_POLICY_UNAVAILABLE",
      context: { policySource, policyKind: "fulfillment", policyId: "", accountToken: "private", providerBody: { secret: true } } });
    expect(ebayListingFailureDiagnostic(error)).toEqual({ code: "EBAY_POLICY_UNAVAILABLE",
      context: { policySource, policyKind: "fulfillment", policyId: "" } });
    expect(syncFailure(error, 1, new Date("2026-10-15T12:00:00Z"))).toMatchObject({ state: "needs_attention", code: "EBAY_POLICY_UNAVAILABLE" });
  });
  it("does not accept incomplete or additional policy provenance fields", () => {
    const error = Object.assign(new Error("Unavailable saved policy"), { code: "EBAY_POLICY_UNAVAILABLE",
      context: { policySource: { scope: "variant", password: "private" }, policyKind: "fulfillment", policyId: "1" } });
    expect(ebayListingFailureDiagnostic(error)).toEqual({ code: "EBAY_POLICY_UNAVAILABLE", context: {} });
  });
  it("retains automatic retry for policy catalog outages without treating the catalog as empty", () => {
    const error = Object.assign(new Error("Catalog unavailable"), { code: "EBAY_POLICY_CATALOG_UNAVAILABLE" });
    expect(syncFailure(error, 99, new Date("2026-10-15T12:00:00Z"))).toMatchObject({ state: "recovering", code: "EBAY_POLICY_CATALOG_UNAVAILABLE" });
  });
  it("retains exact inventory scope while excluding provider, SQL and credential context", () => {
    const error = Object.assign(new Error("SQL password=private"), {
      code: "CANONICAL_PUBLICATION_MAPPING_MISSING",
      context: { productId: 4, productVariantId: 208, publicationTargetId: 3,
        blockerCodes: ["CANONICAL_PUBLICATION_MAPPING_MISSING"], requestBody: { token: "private" }, sql: "private" },
    });
    expect(ebayListingFailureDiagnostic(error)).toEqual({ code: error.code, context: {
      productId: 4, productVariantId: 208, publicationTargetId: 3, blockerCodes: [error.code],
    } });
    expect(syncFailure(error, 1, new Date("2026-10-15T12:00:00Z"))).toMatchObject({
      state: "needs_attention", code: error.code,
      message: "Inventory setup stopped this listing update before its pictures could be confirmed. Retry Sync to prepare this listing's inventory connection.",
    });
  });
  it.each([null, "secret", Object.assign(new Error("secret"), { code: "password=secret",
    context: { productId: 0, productVariantId: 1.5, publicationTargetId: "3", blockerCodes: ["private value"] } })])(
    "does not persist invalid diagnostic input", error => {
      const diagnostic = ebayListingFailureDiagnostic(error);
      expect(diagnostic.code).toBe("EBAY_LISTING_SYNC_FAILED");
      expect(Object.keys(diagnostic.context)).toEqual(error instanceof Error ? ["failure"] : []);
      expect(JSON.stringify(diagnostic)).not.toContain("secret");
    },
  );
  it("retains a safe fingerprint and exact cause classification for an uncoded pool timeout", () => {
    const cause = new Error("timeout exceeded when trying to connect");
    const error = new Error("SQL with password=private", { cause });
    const diagnostic = ebayListingFailureDiagnostic(error);
    expect(diagnostic).toMatchObject({ code: "DATABASE_POOL_ACQUIRE_TIMEOUT", context: { failure: {
      category: "pool_acquisition_timeout", errorType: "Error", codes: [], fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    } } });
    expect(JSON.stringify(diagnostic)).not.toMatch(/SQL|password|private/);
    expect(ebayListingFailureDiagnostic(error)).toEqual(diagnostic);
    expect(syncFailure(error, 1, new Date("2026-10-23T12:00:00Z"))).toMatchObject({ state: "recovering", code: "DATABASE_POOL_ACQUIRE_TIMEOUT" });
  });
});
