import type { DropshipClock, DropshipLogger } from "../application/dropship-ports";
import { makeDropshipStoreConnectionLogger } from "../application/dropship-store-connection-service";
import { DropshipError } from "../domain/errors";
import { ebayTokenRefreshErrorContext, recordEbayTokenRefreshFailure } from "./dropship-ebay-auth-failure";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
  ExpectedDropshipCredential,
} from "./dropship-marketplace-credentials";

const REFRESH_BUFFER_MS = 5 * 60 * 1_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1_024;
const TOKEN_URLS = {
  sandbox: "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
  production: "https://api.ebay.com/identity/v1/oauth2/token",
} as const;

interface FreshCredentialInput {
  vendorId: number;
  storeConnectionId: number;
  operation: string;
  rejectedAccessTokenRef?: string;
}

interface TokenOwnerOptions {
  credentials: DropshipMarketplaceCredentialRepository;
  oauthClient?: { clientId: string | null; clientSecret: string | null };
  fetchFn?: typeof fetch;
  clock?: DropshipClock;
  logger?: DropshipLogger;
}

/**
 * The only dropship eBay refresh authority. PostgreSQL coordinates all workers;
 * vault-reference CAS additionally fences consent/disconnect requests that do
 * not acquire the refresh lock. No marketplace writes are retried here.
 */
export class DropshipEbayTokenOwner {
  private readonly credentials: DropshipMarketplaceCredentialRepository;
  private readonly fetchFn: typeof fetch;
  private readonly clock: DropshipClock;
  private readonly logger: DropshipLogger;
  private readonly oauthClient: { clientId: string | null; clientSecret: string | null };

  constructor(options: TokenOwnerOptions) {
    this.credentials = options.credentials;
    this.fetchFn = options.fetchFn ?? fetch;
    this.clock = options.clock ?? { now: () => new Date() };
    this.logger = options.logger ?? makeDropshipStoreConnectionLogger();
    this.oauthClient = options.oauthClient ?? {
      clientId: normalizedSecret(process.env.DROPSHIP_EBAY_CLIENT_ID) ?? normalizedSecret(process.env.EBAY_CLIENT_ID),
      clientSecret: normalizedSecret(process.env.DROPSHIP_EBAY_CLIENT_SECRET) ?? normalizedSecret(process.env.EBAY_CLIENT_SECRET),
    };
  }

  async loadFreshForStoreConnection(input: FreshCredentialInput): Promise<DropshipMarketplaceStoreCredentials> {
    assertInput(input);
    const current = await this.loadCurrent(input);
    if (this.canReuse(current, input)) return current;

    // An in-process mutex cannot protect multiple web/worker processes. Missing
    // repository coordination is an integration error, never a silent fallback.
    if (!this.credentials.withEbayTokenRefreshLock) {
      throw new DropshipError("DROPSHIP_EBAY_REFRESH_COORDINATION_REQUIRED",
        "eBay token refresh coordination is not configured.", { retryable: false });
    }
    return this.credentials.withEbayTokenRefreshLock({
      vendorId: input.vendorId, storeConnectionId: input.storeConnectionId,
    }, async (scopedCredentials) => {
      const credential = await this.loadCurrent(input, scopedCredentials);
      if (this.canReuse(credential, input)) return credential;
      try {
        return await this.refresh(credential, input.operation, scopedCredentials);
      } catch (error) {
        if (error instanceof DropshipError && error.code === "DROPSHIP_CREDENTIAL_CHANGED") {
          // A concurrent consent flow won. Never apply an old success/failure
          // to its new grant, and never recursively refresh an unknown winner.
          const winner = await this.loadCurrent(input, scopedCredentials);
          if (winner.accessTokenRef !== credential.accessTokenRef && this.isFresh(winner)) {
            this.log("DROPSHIP_EBAY_REFRESH_SUPERSEDED", input, "Newer credentials superseded an in-flight refresh.");
            return winner;
          }
        }
        this.logger.warn({
          code: "DROPSHIP_EBAY_REFRESH_UNAVAILABLE",
          message: "eBay credentials could not be refreshed.",
          context: {
            vendorId: input.vendorId, storeConnectionId: input.storeConnectionId,
            operation: input.operation,
            failureCode: error instanceof DropshipError ? error.code : "UNCLASSIFIED",
          },
        });
        throw error;
      }
    });
  }

  private async loadCurrent(
    input: FreshCredentialInput,
    credentials: DropshipMarketplaceCredentialRepository = this.credentials,
  ): Promise<DropshipMarketplaceStoreCredentials> {
    const credential = await credentials.loadForStoreConnection({
      vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, platform: "ebay",
    });
    if (credential.vendorId !== input.vendorId || credential.storeConnectionId !== input.storeConnectionId
      || credential.platform !== "ebay") {
      throw new DropshipError("DROPSHIP_EBAY_CREDENTIAL_OWNER_MISMATCH",
        "The returned credential does not belong to this eBay store.", { retryable: false });
    }
    if (credential.status !== "connected" && credential.status !== "refresh_failed") {
      throw new DropshipError("DROPSHIP_STORE_CONNECTION_NOT_CONNECTED",
        "The eBay store is not available for credential refresh.", { retryable: false, status: credential.status });
    }
    resolveDropshipEbayProviderEnvironment(credential);
    return credential;
  }

  private canReuse(credential: DropshipMarketplaceStoreCredentials, input: FreshCredentialInput): boolean {
    return (!input.rejectedAccessTokenRef || credential.accessTokenRef !== input.rejectedAccessTokenRef)
      && this.isFresh(credential);
  }

  private isFresh(credential: DropshipMarketplaceStoreCredentials): boolean {
    const expiresAt = credential.accessTokenExpiresAt;
    return Boolean(normalizedSecret(credential.accessToken) && expiresAt instanceof Date
      && expiresAt.getTime() - this.now().getTime() > REFRESH_BUFFER_MS);
  }

  private async refresh(
    credential: DropshipMarketplaceStoreCredentials,
    operation: string,
    credentials: DropshipMarketplaceCredentialRepository,
  ): Promise<DropshipMarketplaceStoreCredentials> {
    const now = this.now();
    if (!normalizedSecret(credential.refreshToken) || (credential.refreshTokenExpiresAt
      && credential.refreshTokenExpiresAt.getTime() <= now.getTime())) {
      await credentials.recordAuthFailure?.({
        vendorId: credential.vendorId, storeConnectionId: credential.storeConnectionId, platform: "ebay",
        expectedCredential: expectedCredential(credential),
        status: "needs_reauth", failureCode: "DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED",
        message: "The eBay refresh grant is missing or expired.", retryable: false, now,
      });
      throw new DropshipError("DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED",
        "The eBay refresh grant is missing or expired.", { retryable: false, authFailureStatus: "needs_reauth" });
    }
    const clientId = normalizedSecret(this.oauthClient.clientId);
    const clientSecret = normalizedSecret(this.oauthClient.clientSecret);
    if (!clientId || !clientSecret) {
      throw new DropshipError("DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED",
        "eBay OAuth client credentials are missing.", { retryable: false });
    }

    let response: Response;
    let responseBody: string;
    try {
      response = await this.fetchFn(TOKEN_URLS[resolveDropshipEbayProviderEnvironment(credential)], {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        // eBay defaults omitted scope to the original consent grant. Requesting
        // a worker-specific subset here narrows the token shared by every API.
        // https://developer.ebay.com/develop/guides/sell/authorization
        body: new URLSearchParams({
          grant_type: "refresh_token", refresh_token: credential.refreshToken!,
        }).toString(),
      });
      responseBody = await readBoundedTokenResponse(response);
    } catch (error) {
      if (error instanceof DropshipError) throw error;
      // Never attach the transport error: it may contain headers or credentials.
      throw new DropshipError("DROPSHIP_EBAY_TOKEN_REFRESH_FAILED",
        "eBay token refresh could not complete. The refresh grant has been retained.", { retryable: true });
    }
    if (!response.ok) {
      const message = `eBay token refresh failed with HTTP ${response.status}.`;
      const classification = await recordEbayTokenRefreshFailure({
        credentials, credential, status: response.status, responseBody,
        failureCode: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", message, now: this.now(),
      });
      throw new DropshipError("DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", message,
        ebayTokenRefreshErrorContext({ status: response.status, responseBody, classification }));
    }
    const token = parseTokenResponse(responseBody);
    const receivedAt = this.now();
    const expiresAt = new Date(receivedAt.getTime() + token.expiresInSeconds * 1_000);
    if (!Number.isFinite(expiresAt.getTime())) throw invalidTokenResponse();
    const updated = await credentials.replaceTokens({
      vendorId: credential.vendorId, storeConnectionId: credential.storeConnectionId, platform: "ebay",
      expectedCredential: expectedCredential(credential),
      accessToken: token.accessToken, refreshToken: token.refreshToken,
      accessTokenExpiresAt: expiresAt, now: receivedAt,
    });
    this.log("DROPSHIP_EBAY_TOKEN_REFRESHED", {
      vendorId: credential.vendorId, storeConnectionId: credential.storeConnectionId, operation,
    },
      "Refreshed the eBay access token using the original consent grant.");
    return updated;
  }

  private now(): Date {
    const now = this.clock.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new DropshipError("DROPSHIP_MARKETPLACE_REGISTRATION_CLOCK_INVALID",
        "The eBay credential clock returned an invalid timestamp.");
    }
    return now;
  }

  private log(code: string, input: Pick<FreshCredentialInput, "vendorId" | "storeConnectionId" | "operation">, message: string): void {
    this.logger.info({ code, message, context: {
      vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, operation: input.operation,
    } });
  }
}

export function resolveDropshipEbayProviderEnvironment(
  credential: DropshipMarketplaceStoreCredentials,
): "sandbox" | "production" {
  const metadata = isRecord(credential.config.tokenMetadata) ? credential.config.tokenMetadata : {};
  const environment = (normalizedSecret(credential.providerEnvironment)
    ?? normalizedSecret(metadata.environment))?.toLowerCase();
  if (environment === "sandbox" || environment === "production") return environment;
  throw new DropshipError("DROPSHIP_MARKETPLACE_REGISTRATION_ENVIRONMENT_REQUIRED",
    "The eBay provider environment is missing or invalid on the store connection.",
    { storeConnectionId: credential.storeConnectionId, retryable: false });
}

function expectedCredential(credential: DropshipMarketplaceStoreCredentials): ExpectedDropshipCredential {
  return { accessTokenRef: credential.accessTokenRef, refreshTokenRef: credential.refreshTokenRef };
}

async function readBoundedTokenResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TOKEN_RESPONSE_BYTES) {
        await reader.cancel();
        throw invalidTokenResponse();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseTokenResponse(text: string): { accessToken: string; refreshToken: string | null; expiresInSeconds: number } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw invalidTokenResponse(); }
  if (!isRecord(raw)) throw invalidTokenResponse();
  const accessToken = normalizedSecret(raw.access_token);
  const expiresInSeconds = raw.expires_in;
  if (!accessToken || typeof expiresInSeconds !== "number" || !Number.isSafeInteger(expiresInSeconds)
    || expiresInSeconds <= 0 || (raw.refresh_token !== undefined && !normalizedSecret(raw.refresh_token))) {
    throw invalidTokenResponse();
  }
  return { accessToken, refreshToken: normalizedSecret(raw.refresh_token), expiresInSeconds };
}

function invalidTokenResponse(): DropshipError {
  return new DropshipError("DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE",
    "eBay token refresh returned an invalid response. The existing refresh grant has been retained.", { retryable: true });
}

function normalizedSecret(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertInput(input: FreshCredentialInput): void {
  if (!Number.isSafeInteger(input.vendorId) || input.vendorId <= 0
    || !Number.isSafeInteger(input.storeConnectionId) || input.storeConnectionId <= 0
    || typeof input.operation !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(input.operation)
    || (input.rejectedAccessTokenRef !== undefined && !normalizedSecret(input.rejectedAccessTokenRef))) {
    throw new DropshipError("DROPSHIP_EBAY_CREDENTIAL_REQUEST_INVALID",
      "A valid vendor, store, and operation are required for eBay credential maintenance.", { retryable: false });
  }
}
