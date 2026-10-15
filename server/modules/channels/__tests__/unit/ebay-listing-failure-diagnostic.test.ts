import { describe, expect, it } from "vitest";
import { ebayListingFailureDiagnostic } from "../../ebay-listing-failure-diagnostic";
import { syncFailure } from "../../ebay-listing-sync.domain";

describe("saved listing failure diagnostics", () => {
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
      expect(ebayListingFailureDiagnostic(error)).toEqual({ code: "EBAY_LISTING_SYNC_FAILED", context: {} });
    },
  );
});
