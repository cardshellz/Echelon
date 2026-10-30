import { DropshipError } from "../domain/errors";
import { EbayListingSyncError } from "../../channels/ebay-listing-sync.domain";
import { providerReadDiagnosticFromError, providerReadShouldRetry } from "@shared/channel-provider-read";

/**
 * Shared eBay connector refusals that a retry cannot clear: a second attempt reads
 * the same eBay state and the same saved mapping and hits the same check. The
 * channel owner's syncFailure (ebay-listing-sync.domain.ts) leaves every one of
 * these out of its wait, retry and automatic-recovery sets.
 *
 * This is an allow-list of PERMANENT codes on purpose. Any other code, including
 * the transient identity-read failures (EBAY_REGISTRATION_READ_TIMEOUT,
 * EBAY_REGISTRATION_READ_FAILED, EBAY_PROVIDER_RATE_LIMITED) and any code the
 * connector adds later, stays retryable as it was before this translation unless
 * its validated provider-read diagnostic classifies the refusal more precisely.
 *
 * EBAY_AUTH_REQUIRED is deliberately NOT here: see
 * EBAY_CONNECTOR_ACCESS_TOKEN_REJECTED_CODE below.
 */
export const PERMANENT_EBAY_CONNECTOR_CODES: ReadonlySet<string> = new Set([
  "EBAY_SYNC_MAPPING_INVALID",
  "EBAY_SYNC_IDENTITY_CHANGED",
  "EBAY_SYNC_PROVIDER_IDENTITY_INVALID",
  "EBAY_PROVIDER_ACCESS_DENIED",
  "EBAY_LISTING_VALIDATION_FAILED",
  "EBAY_SYNC_PROVIDER_RESPONSE_INVALID",
]);

/**
 * The identity observer raises this code for exactly an HTTP 401 on one of its
 * eBay reads (ebay-existing-listing-identity.ts rethrowObservationFailure). A 401
 * rejects only the current access token, so it is transient: the provider records
 * the rejection (forcing a refresh on the next attempt, as throwListingHttpError
 * does for its own 401s) and the error stays retryable. A grant that is really
 * revoked then fails the refresh with invalid_grant, which the token owner files
 * as needs_reauth and does not retry.
 */
export const EBAY_CONNECTOR_ACCESS_TOKEN_REJECTED_CODE = "EBAY_AUTH_REQUIRED";
/** The HTTP status behind EBAY_CONNECTOR_ACCESS_TOKEN_REJECTED_CODE. */
export const EBAY_CONNECTOR_ACCESS_TOKEN_REJECTED_STATUS = 401;

/**
 * The listing-push worker keeps a DropshipError's code and its context.retryable,
 * but files any other Error as DROPSHIP_LISTING_PUSH_FAILED with retryable true
 * (dropship-listing-push-worker-service.ts classifyListingPushError). Without this
 * translation a real account or mapping mismatch is stored as temporary, requeued
 * by the quantity catch-up and shown to the vendor as "try again in a few minutes".
 * The shared code is kept verbatim: it is already namespaced and names the check.
 */
export function dropshipErrorFromEbayConnector(error: EbayListingSyncError): DropshipError {
  const providerRead = providerReadDiagnosticFromError(error);
  return new DropshipError(error.code, error.message, {
    // The worker owns its attempt budget. Keep the shared read classification
    // and diagnostics through translation; a rejected token uses its refresh owner.
    retryable: error.code === EBAY_CONNECTOR_ACCESS_TOKEN_REJECTED_CODE
      || (providerRead ? providerReadShouldRetry(providerRead, 0) : !PERMANENT_EBAY_CONNECTOR_CODES.has(error.code)),
    source: "ebay_listing_connector",
    ...(providerRead ? { providerRead } : {}),
  });
}

/** Translate only the shared connector's own error type; everything else passes
 * through unchanged so its existing classification is kept. */
export function translateEbayConnectorError(error: unknown): unknown {
  return error instanceof EbayListingSyncError ? dropshipErrorFromEbayConnector(error) : error;
}

/** True only for a translated connector error that reports a rejected access token. */
export function isEbayConnectorAccessTokenRejection(error: unknown): error is DropshipError {
  return error instanceof DropshipError
    && error.code === EBAY_CONNECTOR_ACCESS_TOKEN_REJECTED_CODE
    && error.context?.source === "ebay_listing_connector";
}
