import { describe, expect, it } from "vitest";
import {
  EBAY_CONNECTOR_ACCESS_TOKEN_REJECTED_CODE,
  EBAY_CONNECTOR_ACCESS_TOKEN_REJECTED_STATUS,
  PERMANENT_EBAY_CONNECTOR_CODES,
  dropshipErrorFromEbayConnector,
  isEbayConnectorAccessTokenRejection,
  translateEbayConnectorError,
} from "../../infrastructure/dropship-ebay-connector-errors";
import { DropshipError } from "../../domain/errors";
import { EbayListingSyncError } from "../../../channels/ebay-listing-sync.domain";
import { QuantityProviderRequestTimeoutError } from "../../../channels/provider-request-limits";
import { ChannelProviderReadError, type ChannelProviderReadDiagnostic } from "@shared/channel-provider-read";

/** Codes the shared connector and identity observer can raise on the Dropship push. */
const PERMANENT = [
  "EBAY_SYNC_MAPPING_INVALID",
  "EBAY_SYNC_IDENTITY_CHANGED",
  "EBAY_SYNC_PROVIDER_IDENTITY_INVALID",
  "EBAY_PROVIDER_ACCESS_DENIED",
  "EBAY_LISTING_VALIDATION_FAILED",
  "EBAY_SYNC_PROVIDER_RESPONSE_INVALID",
] as const;
/** The identity read's transient failures. EBAY_AUTH_REQUIRED is a 401 on the borrowed
 * access token: the provider records it so the next attempt refreshes, and retries. */
const TRANSIENT = [
  "EBAY_REGISTRATION_READ_TIMEOUT",
  "EBAY_REGISTRATION_READ_FAILED",
  "EBAY_PROVIDER_RATE_LIMITED",
  "EBAY_AUTH_REQUIRED",
] as const;

describe("Dropship translation of shared eBay connector refusals", () => {
  it.each([["unavailable", 503, true], ["invalid_response", 200, true], ["refused", 403, false], ["refused", 401, true]] as const)(
    "retains safe native %s read diagnostics with HTTP %s", (kind, httpStatus, retryable) => {
      const providerRead: ChannelProviderReadDiagnostic = { provider: "ebay", resource: "listing_package", method: "POST", kind, httpStatus };
      const code = httpStatus === 401 ? "EBAY_AUTH_REQUIRED" : "EBAY_PACKAGE_READ_INVALID";
      const translated = dropshipErrorFromEbayConnector(new EbayListingSyncError(code, "Package check failed.",
        { cause: new ChannelProviderReadError(providerRead, { cause: new Error("private response body") }) }));
      expect(translated).toMatchObject({ code, context: { retryable, providerRead, source: "ebay_listing_connector" } });
      expect(JSON.stringify(translated)).not.toContain("private response body");
      expect(isEbayConnectorAccessTokenRejection(translated)).toBe(httpStatus === 401);
    });
  it("lists exactly the reviewed permanent codes", () => {
    expect([...PERMANENT_EBAY_CONNECTOR_CODES].sort()).toEqual([...PERMANENT].sort());
  });

  it.each(PERMANENT)("files %s as a permanent DropshipError with the shared code and message", (code) => {
    const translated = dropshipErrorFromEbayConnector(new EbayListingSyncError(code, `refused: ${code}`));
    expect(translated).toBeInstanceOf(DropshipError);
    expect(translated).toMatchObject({
      code,
      message: `refused: ${code}`,
      context: { retryable: false, source: "ebay_listing_connector" },
    });
  });

  it.each(TRANSIENT)("keeps %s retryable", (code) => {
    expect(dropshipErrorFromEbayConnector(new EbayListingSyncError(code, "temporary"))).toMatchObject({
      code,
      context: { retryable: true, source: "ebay_listing_connector" },
    });
  });

  it("keeps an unknown or future connector code retryable, as before the translation", () => {
    expect(dropshipErrorFromEbayConnector(new EbayListingSyncError("EBAY_SOME_FUTURE_CODE", "new"))).toMatchObject({
      code: "EBAY_SOME_FUTURE_CODE",
      context: { retryable: true },
    });
  });

  it("passes every other error through as the same object", () => {
    const dropship = new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "http", { retryable: true });
    const timeout = new QuantityProviderRequestTimeoutError();
    const network = new TypeError("fetch failed");
    // A coded non-connector error must not be classified by its code alone.
    const coded = Object.assign(new Error("coded"), { code: "EBAY_SYNC_MAPPING_INVALID" });
    for (const error of [dropship, timeout, network, coded, "not an error", null]) {
      expect(translateEbayConnectorError(error)).toBe(error);
    }
  });

  it("names only a translated connector 401 as an access-token rejection", () => {
    expect(EBAY_CONNECTOR_ACCESS_TOKEN_REJECTED_CODE).toBe("EBAY_AUTH_REQUIRED");
    expect(EBAY_CONNECTOR_ACCESS_TOKEN_REJECTED_STATUS).toBe(401);
    const rejected = translateEbayConnectorError(new EbayListingSyncError("EBAY_AUTH_REQUIRED", "rejected"));
    expect(isEbayConnectorAccessTokenRejection(rejected)).toBe(true);
    // The raw connector error, other codes, and a same-coded error from another source are not.
    expect(isEbayConnectorAccessTokenRejection(new EbayListingSyncError("EBAY_AUTH_REQUIRED", "raw"))).toBe(false);
    expect(isEbayConnectorAccessTokenRejection(
      translateEbayConnectorError(new EbayListingSyncError("EBAY_PROVIDER_ACCESS_DENIED", "403")))).toBe(false);
    expect(isEbayConnectorAccessTokenRejection(
      new DropshipError("EBAY_AUTH_REQUIRED", "elsewhere", { retryable: true }))).toBe(false);
    expect(isEbayConnectorAccessTokenRejection(null)).toBe(false);
  });

  it("translates a connector error through the pass-through entry point", () => {
    expect(translateEbayConnectorError(new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "changed")))
      .toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED", context: { retryable: false } });
  });
});
