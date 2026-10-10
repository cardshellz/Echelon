/**
 * eBay OAuth2 Token Management Service
 *
 * Handles the OAuth2 authorization code grant flow for eBay:
 * - Token refresh (access tokens expire every 2 hours)
 * - Retains refresh credentials when the token endpoint returns only an access token
 * - Coalesces concurrent refreshes for the same channel within this service
 * - Persistent storage in ebay_oauth_tokens table
 *
 * The provider's expires_in values determine expiry; successful refresh does not
 * imply that the existing refresh token's lifetime restarted.
 */

import { eq, and, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { ebayOauthTokens } from "@shared/schema";
import { persistAuditEvent } from "../../../../infrastructure/auditLogger";
import { ChannelFulfillmentProviderError } from "../../channel-fulfillment-provider.error";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DrizzleExecutor = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

type DrizzleDb = DrizzleExecutor & {
  transaction?: <T>(callback: (tx: DrizzleExecutor) => Promise<T>) => Promise<T>;
};

export interface EbayAuthConfig {
  clientId: string;
  clientSecret: string;
  ruName: string;
  environment: "sandbox" | "production";
}

interface TokenRecord {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date | null;
  externalAccountId: string | null;
  externalAccountDisplayName: string | null;
  externalAccountIdentityScheme: string | null;
  externalAccountVerifiedAt: Date | null;
}

export interface EbayObservedProviderAccount {
  readonly externalAccountId: string;
  readonly externalAccountDisplayName: string | null;
  readonly externalAccountIdentityScheme: "provider_user_id";
  readonly externalAccountVerifiedAt: Date;
}

export interface EbayProviderAccountClaimOutcome {
  readonly kind: "claimed" | "replay";
  readonly account: EbayObservedProviderAccount;
}

export interface EbayProviderAccountClaimAuditContext {
  readonly idempotencyKey: string;
  readonly observationHash: string;
  readonly requestedBy: {
    readonly type: "user" | "service" | "system";
    readonly id: string;
  };
  readonly correlationId: string | null;
}

export interface EbayAuthDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly requestTimeoutMs?: number;
}

export class EbayAuthError extends Error {
  constructor(readonly code: "EBAY_AUTH_REQUIRED" | "EBAY_AUTH_EXPIRED" | "EBAY_AUTH_UNAVAILABLE" | "EBAY_AUTH_RESPONSE_INVALID" | "EBAY_AUTH_CONFIGURATION_INVALID" | "EBAY_AUTH_REFRESH_SUPERSEDED" | "EBAY_OAUTH_SCOPE_MISSING", message: string) {
    super(message); this.name = "EbayAuthError";
  }
}

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const tokenLifetime = z.number().int().positive().max(2_147_483_647);
const ebayTokenResponseSchema = z.object({
  access_token: z.string().min(1), expires_in: tokenLifetime,
  refresh_token: z.string().min(1).optional(), refresh_token_expires_in: tokenLifetime.optional(),
});
type ValidatedEbayTokenResponse = z.infer<typeof ebayTokenResponseSchema>;

export class EbayProviderAccountIdentityConflictError extends Error {
  readonly code = "EBAY_PROVIDER_ACCOUNT_IDENTITY_CONFLICT";

  constructor(
    readonly context: {
      channelId: number;
      environment: "sandbox" | "production";
      persistedExternalAccountId: string;
      observedExternalAccountId: string;
    },
  ) {
    super(
      `eBay channel ${context.channelId} is already bound to provider account ` +
        `${context.persistedExternalAccountId}; observed ${context.observedExternalAccountId}`,
    );
    this.name = "EbayProviderAccountIdentityConflictError";
  }
}

export class EbayProviderAccountIdentityNotPersistedError extends Error {
  readonly code = "EBAY_PROVIDER_ACCOUNT_IDENTITY_NOT_PERSISTED";

  constructor(
    readonly context: {
      channelId: number;
      environment: "sandbox" | "production";
    },
  ) {
    super(
      `No eBay OAuth token row exists for channel ${context.channelId} in ` +
        `${context.environment}; provider account identity cannot be claimed`,
    );
    this.name = "EbayProviderAccountIdentityNotPersistedError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_URLS = {
  sandbox: "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
  production: "https://api.ebay.com/identity/v1/oauth2/token",
} as const;

const CONSENT_URLS = {
  sandbox: "https://auth.sandbox.ebay.com/oauth2/authorize",
  production: "https://auth.ebay.com/oauth2/authorize",
} as const;

const IDENTITY_API_URLS = {
  sandbox: "https://apiz.sandbox.ebay.com",
  production: "https://apiz.ebay.com",
} as const;

const EBAY_PROVIDER_ACCOUNT_IDENTITY_SCHEME = "provider_user_id" as const;

const ebayIdentityResponseSchema = z.object({
  userId: z.string().trim().min(1),
  username: z.string().trim().min(1).nullable().optional(),
}).passthrough();

const ebayProviderAccountClaimAuditContextSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  observationHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestedBy: z.object({
    type: z.enum(["user", "service", "system"]),
    id: z.string().trim().min(1).max(255),
  }).strict(),
  correlationId: z.string().trim().min(1).max(100).nullable(),
}).strict();

/** Refresh access token 5 minutes before actual expiry */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Default scopes required for sell operations */
const DEFAULT_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/commerce.notification.subscription",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
].join(" ");

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EbayAuthService {
  private readonly refreshPromises = new Map<number, Promise<string>>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly db: DrizzleDb,
    private readonly config: EbayAuthConfig,
    dependencies: EbayAuthDependencies = {},
  ) {
    this.fetchFn = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0 || this.requestTimeoutMs > TOKEN_REQUEST_TIMEOUT_MS) {
      throw new Error("eBay authorization request timeout must be a positive integer no greater than the default deadline.");
    }
  }

  /**
   * Get a valid access token for the given channel.
   * Automatically refreshes if expired or about to expire.
   * Thread-safe — concurrent callers share a single refresh request.
   */
  async getAccessToken(channelId: number): Promise<string> {
    if (!Number.isSafeInteger(channelId) || channelId < 1) throw new EbayAuthError("EBAY_AUTH_REQUIRED", "Select a valid eBay channel before requesting authorization.");
    const token = await this.getStoredToken(channelId);
    if (!token) {
      throw new EbayAuthError("EBAY_AUTH_REQUIRED",
        `No eBay authorization exists for channel ${channelId}. Open eBay Connection settings and connect the intended account.`
      );
    }

    // Check if access token is still valid (with buffer)
    const now = this.now();
    const expiresAt = new Date(token.accessTokenExpiresAt);
    if (expiresAt.getTime() - now.getTime() > TOKEN_REFRESH_BUFFER_MS) {
      return token.accessToken;
    }

    if (token.refreshTokenExpiresAt && new Date(token.refreshTokenExpiresAt).getTime() <= now.getTime()) {
      throw new EbayAuthError("EBAY_AUTH_EXPIRED", "The eBay account authorization expired. Open eBay Connection settings and reconnect the account.");
    }
    let refresh = this.refreshPromises.get(channelId);
    if (!refresh) {
      refresh = this.refreshAccessToken(channelId, token.refreshToken).finally(() => { this.refreshPromises.delete(channelId); });
      this.refreshPromises.set(channelId, refresh);
    }
    return refresh;
  }

  /**
   * Return the persisted, provider-verified account represented by this
   * environment's OAuth token. Canonical publication uses this to prove that
   * an immutable target account and the credential account are identical.
   */
  async getVerifiedProviderAccount(
    channelId: number,
  ): Promise<EbayObservedProviderAccount | null> {
    const token = await this.getStoredToken(channelId);
    const externalAccountId = token?.externalAccountId?.trim();
    if (!token
      || !externalAccountId
      || token.externalAccountIdentityScheme !== EBAY_PROVIDER_ACCOUNT_IDENTITY_SCHEME
      || !(token.externalAccountVerifiedAt instanceof Date)
      || Number.isNaN(token.externalAccountVerifiedAt.getTime())) {
      return null;
    }
    return {
      externalAccountId,
      externalAccountDisplayName: token.externalAccountDisplayName,
      externalAccountIdentityScheme: EBAY_PROVIDER_ACCOUNT_IDENTITY_SCHEME,
      externalAccountVerifiedAt: token.externalAccountVerifiedAt,
    };
  }

  /**
   * Generate the eBay OAuth consent URL for initial authorization.
   * The seller must visit this URL and grant permissions.
   */
  getConsentUrl(state?: string): string {
    const baseUrl = CONSENT_URLS[this.config.environment];
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: "code",
      redirect_uri: this.config.ruName,
      scope: DEFAULT_SCOPES,
    });
    if (state) params.set("state", state);
    return `${baseUrl}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for initial access + refresh tokens.
   * Called once after the seller completes the OAuth consent flow.
   */
  async exchangeAuthorizationCode(
    channelId: number,
    authorizationCode: string,
  ): Promise<void> {
    const tokenData = await this.requestToken(new URLSearchParams({
      grant_type: "authorization_code", code: authorizationCode, redirect_uri: this.config.ruName,
    }));
    const observedAccount = await this.observeProviderAccount(
      tokenData.access_token,
    );
    await this.persistTokens(channelId, tokenData, undefined, observedAccount);

    console.log(
      `[EbayAuth] Successfully exchanged authorization code for channel ${channelId}`,
    );
  }

  /**
   * Store an initial refresh token directly (for manual setup).
   * Use when the refresh token is obtained outside the normal flow.
   */
  async storeInitialRefreshToken(
    channelId: number,
    refreshToken: string,
  ): Promise<void> {
    // First, refresh it to get a valid access token
    await this.refreshAccessToken(channelId, refreshToken);
    console.log(
      `[EbayAuth] Stored initial refresh token for channel ${channelId}`,
    );
  }

  // -------------------------------------------------------------------------
  // Private methods
  // -------------------------------------------------------------------------

  private async refreshAccessToken(
    channelId: number,
    refreshToken: string,
  ): Promise<string> {
    const tokenData = await this.requestToken(new URLSearchParams({
      grant_type: "refresh_token", refresh_token: refreshToken, scope: DEFAULT_SCOPES,
    }));
    await this.persistTokens(channelId, tokenData, refreshToken);

    console.log(
      `[EbayAuth] Access token refreshed for channel ${channelId}, ` +
      `expires in ${tokenData.expires_in}s`,
    );

    return tokenData.access_token;
  }

  /** Timeout cancels local I/O; no detached refresh may persist after its caller failed. */
  private async requestToken(body: URLSearchParams): Promise<ValidatedEbayTokenResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchFn(TOKEN_URLS[this.config.environment], {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}` },
        body: body.toString(),
      });
      if (!response.ok) {
        // Never expose token endpoint bodies: they can echo credentials or contain HTML.
        const failure = z.object({ error: z.string().regex(/^[a-z_]{1,80}$/) }).safeParse(await response.json().catch(() => null));
        const errorCode = failure.success ? failure.data.error : null;
        if (errorCode === "invalid_grant") throw new EbayAuthError("EBAY_AUTH_EXPIRED", "eBay rejected the account authorization (invalid_grant). Open Connection settings and reconnect the intended account.");
        if (["invalid_client", "invalid_scope", "unauthorized_client", "unsupported_grant_type"].includes(errorCode ?? "")) throw new EbayAuthError("EBAY_AUTH_CONFIGURATION_INVALID", `eBay rejected the application's authorization configuration (${errorCode}). An administrator must review the application credentials and requested scopes before reconnecting.`);
        if (response.status === 400 || response.status === 401) throw new EbayAuthError("EBAY_AUTH_RESPONSE_INVALID", `eBay rejected the authorization request (HTTP ${response.status}${errorCode ? `, ${errorCode}` : ""}). An administrator must review the connection before it can be retried.`);
        throw new EbayAuthError("EBAY_AUTH_UNAVAILABLE", `eBay authorization is temporarily unavailable (HTTP ${response.status}). Retry after eBay responds normally.`);
      }
      const parsed = ebayTokenResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new EbayAuthError("EBAY_AUTH_RESPONSE_INVALID", "eBay returned an invalid authorization response. No credentials were saved. Reconnect or ask an administrator to review the response contract.");
      if (controller.signal.aborted) throw new EbayAuthError("EBAY_AUTH_UNAVAILABLE", "eBay authorization timed out. Retry the connection from eBay Connection settings.");
      return parsed.data;
    } catch (error) {
      if (error instanceof EbayAuthError || error instanceof ChannelFulfillmentProviderError) throw error;
      throw new EbayAuthError("EBAY_AUTH_UNAVAILABLE", "The eBay authorization request could not finish. Retry from Connection settings when the connection is available.");
    } finally { clearTimeout(timeout); }
  }
  private async persistTokens(
    channelId: number,
    tokenData: ValidatedEbayTokenResponse,
    previousRefreshToken?: string,
    observedAccount?: EbayObservedProviderAccount,
  ): Promise<void> {
    const now = this.now();
    const existing = await this.getStoredToken(channelId);
    const accessTokenExpiresAt = new Date(
      now.getTime() + tokenData.expires_in * 1000,
    );

    // Refresh token: use new one if provided, otherwise keep the previous one
    const newRefreshToken = tokenData.refresh_token || previousRefreshToken;
    if (!newRefreshToken) {
      throw new Error("No refresh token available — cannot persist tokens");
    }

    const refreshTokenExpiresAt = tokenData.refresh_token_expires_in
      ? new Date(now.getTime() + tokenData.refresh_token_expires_in * 1000)
      : newRefreshToken === existing?.refreshToken ? existing.refreshTokenExpiresAt : null;

    const identityValues = observedAccount
      ? {
          externalAccountId: observedAccount.externalAccountId,
          externalAccountDisplayName: observedAccount.externalAccountDisplayName,
          externalAccountIdentityScheme: observedAccount.externalAccountIdentityScheme,
          externalAccountVerifiedAt: observedAccount.externalAccountVerifiedAt,
        }
      : {};
    const values = {
      channelId,
      environment: this.config.environment,
      accessToken: tokenData.access_token,
      accessTokenExpiresAt,
      refreshToken: newRefreshToken,
      refreshTokenExpiresAt,
      scopes: DEFAULT_SCOPES,
      lastRefreshedAt: now,
      updatedAt: now,
      ...identityValues,
    };

    // Upsert: insert or update on conflict (channelId + environment)
    if (existing) {
      if (
        observedAccount &&
        existing.externalAccountId &&
        existing.externalAccountId !== observedAccount.externalAccountId
      ) {
        throw new EbayProviderAccountIdentityConflictError({
          channelId,
          environment: this.config.environment,
          persistedExternalAccountId: existing.externalAccountId,
          observedExternalAccountId: observedAccount.externalAccountId,
        });
      }

      const update = this.db
        .update(ebayOauthTokens)
        .set(values);
      const where = observedAccount
        ? and(
            eq(ebayOauthTokens.channelId, channelId),
            eq(ebayOauthTokens.environment, this.config.environment),
            or(
              isNull(ebayOauthTokens.externalAccountId),
              eq(
                ebayOauthTokens.externalAccountId,
                observedAccount.externalAccountId,
              ),
            ),
          )
        : and(
            eq(ebayOauthTokens.channelId, channelId),
            eq(ebayOauthTokens.environment, this.config.environment),
            previousRefreshToken === undefined ? undefined : eq(ebayOauthTokens.refreshToken, previousRefreshToken),
          );
      const result = await update.where(where).returning({ externalAccountId: ebayOauthTokens.externalAccountId });
      if (!observedAccount && !result[0]) throw new EbayAuthError("EBAY_AUTH_REFRESH_SUPERSEDED", "The eBay connection changed while authorization was refreshing. Retry using the current saved connection.");
      if (observedAccount && !result[0]) {
        const current = await this.getStoredToken(channelId);
        if (current?.externalAccountId) {
          throw new EbayProviderAccountIdentityConflictError({
            channelId,
            environment: this.config.environment,
            persistedExternalAccountId: current.externalAccountId,
            observedExternalAccountId: observedAccount.externalAccountId,
          });
        }
        throw new EbayProviderAccountIdentityNotPersistedError({
          channelId,
          environment: this.config.environment,
        });
      }
    } else {
      await this.db.insert(ebayOauthTokens).values({
        ...values,
        createdAt: now,
      });
    }
  }

  private async getStoredToken(
    channelId: number,
    executor: DrizzleExecutor = this.db,
    lockForUpdate = false,
  ): Promise<TokenRecord | null> {
    const query = executor
      .select()
      .from(ebayOauthTokens)
      .where(
        and(
          eq(ebayOauthTokens.channelId, channelId),
          eq(ebayOauthTokens.environment, this.config.environment),
        ),
      )
      .limit(1);
    const [row] = lockForUpdate ? await query.for("update") : await query;

    if (!row) return null;

    return {
      accessToken: row.accessToken,
      accessTokenExpiresAt: row.accessTokenExpiresAt,
      refreshToken: row.refreshToken,
      refreshTokenExpiresAt: row.refreshTokenExpiresAt,
      externalAccountId: row.externalAccountId ?? null,
      externalAccountDisplayName: row.externalAccountDisplayName ?? null,
      externalAccountIdentityScheme: row.externalAccountIdentityScheme ?? null,
      externalAccountVerifiedAt: row.externalAccountVerifiedAt ?? null,
    };
  }
  getEnvironment(): "sandbox" | "production" {
    return this.config.environment;
  }

  /**
   * Read the immutable eBay account identity represented by an access token.
   * This method never persists the observation.
   */
  async observeProviderAccount(
    accessToken: string,
  ): Promise<EbayObservedProviderAccount> {
    if (!accessToken.trim()) {
      throw new Error("eBay provider account observation requires an access token");
    }

    const response = await this.fetchFn(
      `${IDENTITY_API_URLS[this.config.environment]}/commerce/identity/v1/user/`,
      {
        method: "GET",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
    ).catch((error: unknown) => {
      // The fulfillment transport has already classified and sanitized its failures.
      // Preserve permanent denial versus transient transport failure for that caller.
      if (error instanceof ChannelFulfillmentProviderError) throw error;
      throw new EbayAuthError("EBAY_AUTH_UNAVAILABLE", "The eBay account identity request could not finish. Retry the connection when eBay responds normally.");
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new EbayAuthError("EBAY_OAUTH_SCOPE_MISSING", "eBay did not authorize account identity verification. Reconnect the intended account and approve the requested permissions.");
      if (response.status === 429 || response.status >= 500) throw new EbayAuthError("EBAY_AUTH_UNAVAILABLE", `eBay account verification is temporarily unavailable (HTTP ${response.status}). Retry the connection after eBay responds normally.`);
      throw new EbayAuthError("EBAY_AUTH_RESPONSE_INVALID", `eBay account identity could not be verified (HTTP ${response.status}). Reconnect with the intended account and approve its requested permissions.`);
    }

    const parsed = ebayIdentityResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new Error(
        `eBay identity response did not contain a valid immutable userId: ` +
          parsed.error.issues.map((issue) => issue.message).join("; "),
      );
    }

    return {
      externalAccountId: parsed.data.userId,
      externalAccountDisplayName: parsed.data.username ?? null,
      externalAccountIdentityScheme: EBAY_PROVIDER_ACCOUNT_IDENTITY_SCHEME,
      externalAccountVerifiedAt: this.now(),
    };
  }

  /**
   * Durably claim a provider account observed during registration confirmation.
   * The conditional update makes first claim and same-account refresh idempotent
   * while rejecting concurrent or later attempts to bind a different account.
   */
  async claimObservedProviderAccount(
    channelId: number,
    observedAccount: EbayObservedProviderAccount,
    auditContext: EbayProviderAccountClaimAuditContext,
  ): Promise<EbayProviderAccountClaimOutcome> {
    const parsed = ebayIdentityResponseSchema.safeParse({
      userId: observedAccount.externalAccountId,
      username: observedAccount.externalAccountDisplayName,
    });
    if (!parsed.success) {
      throw new Error("Cannot claim an eBay provider account without a valid userId");
    }
    if (
      observedAccount.externalAccountIdentityScheme !==
      EBAY_PROVIDER_ACCOUNT_IDENTITY_SCHEME
    ) {
      throw new Error(
        `Unsupported eBay provider account identity scheme: ` +
          observedAccount.externalAccountIdentityScheme,
      );
    }
    const observedVerifiedAt = new Date(
      observedAccount.externalAccountVerifiedAt.getTime(),
    );
    if (Number.isNaN(observedVerifiedAt.getTime())) {
      throw new Error(
        "Cannot claim an eBay provider account with an invalid verification timestamp",
      );
    }
    const parsedAudit = ebayProviderAccountClaimAuditContextSchema.parse(auditContext);
    if (!this.db.transaction) {
      throw new Error(
        "eBay provider account claims require transaction-capable persistence",
      );
    }

    const outcome = await this.db.transaction(async (tx) => {
      const existing = await this.getStoredToken(channelId, tx, true);
      if (!existing) {
        throw new EbayProviderAccountIdentityNotPersistedError({
          channelId,
          environment: this.config.environment,
        });
      }
      if (
        existing.externalAccountId &&
        existing.externalAccountId !== parsed.data.userId
      ) {
        throw new EbayProviderAccountIdentityConflictError({
          channelId,
          environment: this.config.environment,
          persistedExternalAccountId: existing.externalAccountId,
          observedExternalAccountId: parsed.data.userId,
        });
      }

      const kind = existing.externalAccountId === null ? "claimed" : "replay";
      const verifiedAt = existing.externalAccountVerifiedAt
        && existing.externalAccountVerifiedAt > observedVerifiedAt
        ? existing.externalAccountVerifiedAt
        : observedVerifiedAt;
      const updatedAt = this.now();
      if (!(updatedAt instanceof Date) || Number.isNaN(updatedAt.getTime())) {
        throw new Error("eBay auth clock returned an invalid timestamp");
      }
      const updated = await tx
        .update(ebayOauthTokens)
        .set({
          externalAccountId: parsed.data.userId,
          externalAccountDisplayName: parsed.data.username ?? null,
          externalAccountIdentityScheme: EBAY_PROVIDER_ACCOUNT_IDENTITY_SCHEME,
          externalAccountVerifiedAt: verifiedAt,
          updatedAt,
        })
        .where(
          and(
            eq(ebayOauthTokens.channelId, channelId),
            eq(ebayOauthTokens.environment, this.config.environment),
            or(
              isNull(ebayOauthTokens.externalAccountId),
              eq(ebayOauthTokens.externalAccountId, parsed.data.userId),
            ),
          ),
        )
        .returning({
          externalAccountId: ebayOauthTokens.externalAccountId,
          externalAccountDisplayName: ebayOauthTokens.externalAccountDisplayName,
          externalAccountVerifiedAt: ebayOauthTokens.externalAccountVerifiedAt,
        });

      if (!updated[0]) {
        const current = await this.getStoredToken(channelId, tx);
        if (current?.externalAccountId) {
          throw new EbayProviderAccountIdentityConflictError({
            channelId,
            environment: this.config.environment,
            persistedExternalAccountId: current.externalAccountId,
            observedExternalAccountId: parsed.data.userId,
          });
        }
        throw new EbayProviderAccountIdentityNotPersistedError({
          channelId,
          environment: this.config.environment,
        });
      }

      await persistAuditEvent(tx, {
        actor: `${parsedAudit.requestedBy.type}:${parsedAudit.requestedBy.id}`,
        action: "channels.ebay.provider_account_identity_claimed",
        target: `channel:${channelId}`,
        changes: {
          before: {
            externalAccountId: existing.externalAccountId,
            externalAccountDisplayName: existing.externalAccountDisplayName,
            externalAccountIdentityScheme: existing.externalAccountIdentityScheme,
            externalAccountVerifiedAt:
              existing.externalAccountVerifiedAt?.toISOString() ?? null,
          },
          after: {
            externalAccountId: updated[0].externalAccountId,
            externalAccountDisplayName:
              updated[0].externalAccountDisplayName ?? null,
            externalAccountIdentityScheme:
              EBAY_PROVIDER_ACCOUNT_IDENTITY_SCHEME,
            externalAccountVerifiedAt:
              updated[0].externalAccountVerifiedAt?.toISOString() ?? null,
          },
        },
        context: {
          classification: "durable_provider_account_observation",
          kind,
          environment: this.config.environment,
          idempotencyKey: parsedAudit.idempotencyKey,
          observationHash: parsedAudit.observationHash,
          correlationId: parsedAudit.correlationId,
        },
      }, {
        timestamp: verifiedAt,
        emitStructuredLog: false,
      });

      return {
        kind,
        account: {
          externalAccountId: updated[0].externalAccountId,
          externalAccountDisplayName:
            updated[0].externalAccountDisplayName ?? null,
          externalAccountIdentityScheme:
            EBAY_PROVIDER_ACCOUNT_IDENTITY_SCHEME,
          externalAccountVerifiedAt:
            updated[0].externalAccountVerifiedAt ?? verifiedAt,
        },
      } satisfies EbayProviderAccountClaimOutcome;
    });

    console.info(JSON.stringify({
      event: "ebay_provider_account_identity_claimed",
      classification: "durable_provider_account_observation",
      kind: outcome.kind,
      channelId,
      environment: this.config.environment,
      externalAccountId: outcome.account.externalAccountId,
      verifiedAt: outcome.account.externalAccountVerifiedAt.toISOString(),
      idempotencyKey: parsedAudit.idempotencyKey,
      correlationId: parsedAudit.correlationId,
    }));
    return outcome;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEbayAuthConfig(): EbayAuthConfig {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const ruName = process.env.EBAY_RUNAME;

  if (!clientId || !clientSecret || !ruName) {
    throw new Error(
      "Missing eBay OAuth config. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_RUNAME environment variables.",
    );
  }

  const configuredEnvironment = (
    process.env.EBAY_ENVIRONMENT?.trim() || "production"
  ).toLowerCase();
  if (
    configuredEnvironment !== "sandbox"
    && configuredEnvironment !== "production"
  ) {
    throw new Error("EBAY_ENVIRONMENT must be sandbox or production.");
  }

  return { clientId, clientSecret, ruName, environment: configuredEnvironment };
}
