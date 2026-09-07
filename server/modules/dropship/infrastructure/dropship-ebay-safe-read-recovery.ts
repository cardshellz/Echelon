import { DropshipError } from "../domain/errors";
import type { DropshipMarketplaceStoreCredentials } from "./dropship-marketplace-credentials";
import type { DropshipEbayRegistrationCredentialProvider } from "./dropship-ebay-registration-credentials";

const MAX_ERROR_RESPONSE_LENGTH = 100_000;
const MAX_PROVIDER_ERROR_IDS = 10;
const PROVIDER_ERROR_ID_PATTERN = /^\d{1,12}$/;

/** Only wrap read-only work: a rejected cached token may be repaired once. */
export async function withEbaySafeReadRecovery<T>(input: {
  credentials: DropshipEbayRegistrationCredentialProvider;
  vendorId: number;
  storeConnectionId: number;
  operation: string;
  reauthorizationCode: string;
  read: (credential: DropshipMarketplaceStoreCredentials) => Promise<T>;
}): Promise<T> {
  try {
    const identity = {
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      operation: input.operation,
    };
    const credential = await input.credentials.loadFreshForStoreConnection(identity);
    try {
      return await input.read(credential);
    } catch (error) {
      if (!isEbayResourceAccessDenied(error)) throw error;
      const repaired = await input.credentials.loadFreshForStoreConnection({
        ...identity,
        rejectedAccessTokenRef: credential.accessTokenRef,
      });
      // Deliberately outside the first read's catch: no retry loop on denial.
      return await input.read(repaired);
    }
  } catch (error) {
    if (!requiresEbayReauthorization(error)) throw error;
    throw new DropshipError(
      input.reauthorizationCode,
      "The eBay authorization has expired or been revoked. Reauthorize the connected store to continue.",
      { storeConnectionId: input.storeConnectionId, resource: "authorization", retryable: false },
    );
  }
}

export function isEbayResourceAccessDenied(error: unknown): error is DropshipError {
  return error instanceof DropshipError
    && error.code.endsWith("_ACCESS_DENIED")
    && (error.context?.status === 401 || error.context?.status === 403);
}

/** Keep numeric eBay error identifiers only, never provider messages or tokens. */
export function ebayResourceErrorIdentifiers(text: string): { providerErrorIds: string[] } {
  if (text.length > MAX_ERROR_RESPONSE_LENGTH) return { providerErrorIds: [] };
  try {
    const body: unknown = JSON.parse(text);
    if (!isRecord(body) || !Array.isArray(body.errors)) return { providerErrorIds: [] };
    const ids = body.errors.slice(0, MAX_PROVIDER_ERROR_IDS).flatMap((entry): string[] => {
      if (!isRecord(entry)) return [];
      const value = entry.errorId;
      const id = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? String(value)
        : typeof value === "string" ? value : "";
      return PROVIDER_ERROR_ID_PATTERN.test(id) ? [id] : [];
    });
    return { providerErrorIds: [...new Set(ids)] };
  } catch {
    return { providerErrorIds: [] };
  }
}

function requiresEbayReauthorization(error: unknown): boolean {
  if (!(error instanceof DropshipError)) return false;
  return [
    "DROPSHIP_STORE_ACCESS_TOKEN_REQUIRED",
    "DROPSHIP_STORE_REFRESH_TOKEN_REQUIRED",
    "DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED",
  ].includes(error.code)
    || error.context?.authFailureStatus === "needs_reauth"
    || (error.code === "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED"
      && error.context?.status === "needs_reauth");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
