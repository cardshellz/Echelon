import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";

// Provider prose may echo tokens, URLs, or credentials. Persist only known OAuth
// codes; neither audit logs nor customer-facing errors need a raw response body.
const OAUTH_ERROR_CODES = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
  "unsupported_grant_type", "invalid_scope", "access_denied",
  "temporarily_unavailable", "server_error",
]);

export interface EbayTokenRefreshFailureClassification {
  connectionStatus: "needs_reauth" | "refresh_failed";
  providerErrorCode: string | null;
  providerErrorDescription: string | null;
  retryable: boolean;
}

export function isEbayResourceAuthFailureStatus(status: number): boolean {
  // A 403 proves that this access token lacks permission for the resource, not
  // that the refresh grant is invalid. A 401 rejects only the current access
  // token, so callers force a refresh while preserving the refresh grant.
  return status === 401;
}

export function classifyEbayTokenRefreshFailure(input: {
  status: number;
  responseBody: string;
}): EbayTokenRefreshFailureClassification {
  const providerError = parseOAuthError(input.responseBody);
  const providerErrorCode = providerError.code?.toLowerCase() ?? null;
  const grantIsInvalid = input.status === 400 && providerErrorCode === "invalid_grant";

  return {
    connectionStatus: grantIsInvalid ? "needs_reauth" : "refresh_failed",
    providerErrorCode,
    providerErrorDescription: providerError.description,
    retryable: !grantIsInvalid && isRetryableHttpStatus(input.status),
  };
}

export async function recordEbayTokenRefreshFailure(input: {
  credentials: DropshipMarketplaceCredentialRepository;
  credential: DropshipMarketplaceStoreCredentials;
  status: number;
  responseBody: string;
  failureCode: string;
  message: string;
  now: Date;
}): Promise<EbayTokenRefreshFailureClassification> {
  const classification = classifyEbayTokenRefreshFailure({
    status: input.status,
    responseBody: input.responseBody,
  });
  const providerMessage = classification.providerErrorCode
    ? `${input.message} Provider error: ${classification.providerErrorCode}.`
    : input.message;

  await input.credentials.recordAuthFailure?.({
    vendorId: input.credential.vendorId,
    storeConnectionId: input.credential.storeConnectionId,
    platform: "ebay",
    expectedCredential: {
      accessTokenRef: input.credential.accessTokenRef,
      refreshTokenRef: input.credential.refreshTokenRef,
    },
    status: classification.connectionStatus,
    failureCode: input.failureCode,
    message: providerMessage,
    retryable: classification.retryable,
    statusCode: input.status,
    providerErrorCode: classification.providerErrorCode,
    providerErrorDescription: classification.providerErrorDescription,
    now: input.now,
  });

  return classification;
}

export async function recordEbayAccessTokenRejection(input: {
  credentials: DropshipMarketplaceCredentialRepository;
  credential: DropshipMarketplaceStoreCredentials;
  status: number;
  failureCode: string;
  message: string;
  now: Date;
}): Promise<void> {
  await input.credentials.recordAuthFailure?.({
    vendorId: input.credential.vendorId,
    storeConnectionId: input.credential.storeConnectionId,
    platform: "ebay",
    expectedCredential: {
      accessTokenRef: input.credential.accessTokenRef,
      refreshTokenRef: input.credential.refreshTokenRef,
    },
    status: "refresh_failed",
    failureCode: input.failureCode,
    message: input.message,
    retryable: true,
    statusCode: input.status,
    invalidateAccessToken: true,
    now: input.now,
  });
}

export function ebayTokenRefreshErrorContext(input: {
  status: number;
  responseBody: string;
  classification: EbayTokenRefreshFailureClassification;
}): Record<string, unknown> {
  return {
    retryable: input.classification.retryable,
    status: input.status,
    authFailureStatus: input.classification.connectionStatus,
    providerErrorCode: input.classification.providerErrorCode,
    providerErrorDescription: input.classification.providerErrorDescription,
  };
}

function parseOAuthError(responseBody: string): {
  code: string | null;
  description: string | null;
} {
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    if (!isRecord(parsed)) {
      return { code: null, description: null };
    }
    const code = typeof parsed.error === "string" ? parsed.error.trim().toLowerCase() : "";
    return { code: OAUTH_ERROR_CODES.has(code) ? code : null, description: null };
  } catch {
    return { code: null, description: null };
  }
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
