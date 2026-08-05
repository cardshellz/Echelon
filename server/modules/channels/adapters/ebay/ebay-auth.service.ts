/**
 * eBay OAuth2 Token Management Service
 *
 * Handles the OAuth2 authorization code grant flow for eBay:
 * - Token refresh (access tokens expire every 2 hours)
 * - Refresh token rotation (new refresh token on every use)
 * - Thread-safe token refresh (prevents concurrent refresh storms)
 * - Persistent storage in ebay_oauth_tokens table
 *
 * IMPORTANT: eBay refresh tokens CHANGE on every refresh call.
 * We must persist the new refresh token immediately or lose access.
 */

import { eq, and, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { ebayOauthTokens } from "@shared/schema";
import { persistAuditEvent } from "../../../../infrastructure/auditLogger";
import type { EbayTokenResponse } from "./ebay-types";

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
}

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
  private refreshPromise: Promise<string> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(
    private readonly db: DrizzleDb,
    private readonly config: EbayAuthConfig,
    dependencies: EbayAuthDependencies = {},
  ) {
    this.fetchFn = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * Get a valid access token for the given channel.
   * Automatically refreshes if expired or about to expire.
   * Thread-safe — concurrent callers share a single refresh request.
   */
  async getAccessToken(channelId: number): Promise<string> {
    const token = await this.getStoredToken(channelId);
    if (!token) {
      throw new Error(
        `No eBay OAuth tokens found for channel ${channelId}. ` +
        `Complete the OAuth consent flow first. Use getConsentUrl() to generate the consent URL.`
      );
    }

    // Check if access token is still valid (with buffer)
    const now = this.now();
    const expiresAt = new Date(token.accessTokenExpiresAt);
    if (expiresAt.getTime() - now.getTime() > TOKEN_REFRESH_BUFFER_MS) {
      return token.accessToken;
    }

    // Token expired or about to expire — refresh it
    // Use lock to prevent concurrent refresh storms
    if (!this.refreshPromise) {
      const refreshTask = this.refreshAccessToken(channelId, token.refreshToken);
      const timeoutTask = new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error("eBay token refresh timed out after 30s")), 30000);
      });

      this.refreshPromise = Promise.race([refreshTask, timeoutTask])
        .finally(() => {
          this.refreshPromise = null;
        });
    }

    return this.refreshPromise;
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
    const tokenUrl = TOKEN_URLS[this.config.environment];
    const credentials = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString("base64");

    const response = await this.fetchFn(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: this.config.ruName,
      }).toString(),
    });

    if (!response.ok) {
      const rawBody = await response.text();
      const isHtml = rawBody.trimStart().startsWith("<");
      const errorBody = isHtml
        ? `HTTP ${response.status} (server returned HTML error page)`
        : rawBody.substring(0, 300);
      throw new Error(
        `eBay token exchange failed (${response.status}): ${errorBody}`,
      );
    }

    const tokenData: EbayTokenResponse = await response.json();
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
    const tokenUrl = TOKEN_URLS[this.config.environment];
    const credentials = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString("base64");

    console.log(`[EbayAuth] Refreshing access token for channel ${channelId}`);

    const response = await this.fetchFn(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: DEFAULT_SCOPES,
      }).toString(),
    });

    if (!response.ok) {
      const rawBody = await response.text();
      // Strip HTML and truncate to avoid dumping full error pages into error messages
      const isHtml = rawBody.trimStart().startsWith("<");
      const errorBody = isHtml
        ? `HTTP ${response.status} (server returned HTML error page)`
        : rawBody.substring(0, 300);
      // If refresh token is invalid/expired, we need human intervention
      if (response.status === 400 || response.status === 401) {
        throw new Error(
          `eBay refresh token expired or invalid for channel ${channelId}. ` +
          `Re-authorize via OAuth consent flow. Error: ${errorBody}`,
        );
      }
      throw new Error(
        `eBay token refresh failed (${response.status}): ${errorBody}`,
      );
    }

    const tokenData: EbayTokenResponse = await response.json();
    await this.persistTokens(channelId, tokenData, refreshToken);

    console.log(
      `[EbayAuth] Access token refreshed for channel ${channelId}, ` +
      `expires in ${tokenData.expires_in}s`,
    );

    return tokenData.access_token;
  }

  private async persistTokens(
    channelId: number,
    tokenData: EbayTokenResponse,
    previousRefreshToken?: string,
    observedAccount?: EbayObservedProviderAccount,
  ): Promise<void> {
    const now = this.now();
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
      : null;

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
    const existing = await this.getStoredToken(channelId);
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
          );
      const result = observedAccount
        ? await update.where(where).returning({
            externalAccountId: ebayOauthTokens.externalAccountId,
          })
        : await update.where(where);
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
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) {
      const rawBody = await response.text();
      throw new Error(
        `eBay identity observation failed (${response.status}): ` +
          rawBody.substring(0, 300),
      );
    }

    const parsed = ebayIdentityResponseSchema.safeParse(await response.json());
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
