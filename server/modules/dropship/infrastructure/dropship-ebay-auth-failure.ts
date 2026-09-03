import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";

const MAX_PROVIDER_ERROR_CODE_LENGTH = 100;
const MAX_PROVIDER_ERROR_DESCRIPTION_LENGTH = 500;
const MAX_PROVIDER_RESPONSE_BODY_LENGTH = 1_000;

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
  const grantIsInvalid = providerErrorCode === "invalid_grant";

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
    body: input.responseBody.slice(0, MAX_PROVIDER_RESPONSE_BODY_LENGTH),
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
    return {
      code: normalizedProviderText(parsed.error, MAX_PROVIDER_ERROR_CODE_LENGTH),
      description: normalizedProviderText(
        parsed.error_description,
        MAX_PROVIDER_ERROR_DESCRIPTION_LENGTH,
      ),
    };
  } catch {
    return { code: null, description: null };
  }
}

function normalizedProviderText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
