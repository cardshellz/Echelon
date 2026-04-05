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

import { eq, and } from "drizzle-orm";
import { ebayOauthTokens } from "@shared/schema";
import type { EbayTokenResponse } from "./ebay-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
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

  constructor(
    private readonly db: DrizzleDb,
    private readonly config: EbayAuthConfig,
  ) {}

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
    const now = new Date();
    const expiresAt = new Date(token.accessTokenExpiresAt);
    if (expiresAt.getTime() - now.getTime() > TOKEN_REFRESH_BUFFER_MS) {
      return token.accessToken;
    }

    // Token expired or about to expire — refresh it
    // Use lock to prevent concurrent refresh storms
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken(channelId, token.refreshToken)
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

    const response = await fetch(tokenUrl, {
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
    await this.persistTokens(channelId, tokenData);

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

    const response = await fetch(tokenUrl, {
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
  ): Promise<void> {
    const now = new Date();
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
    };

    // Upsert: insert or update on conflict (channelId + environment)
    const existing = await this.getStoredToken(channelId);
    if (existing) {
      await this.db
        .update(ebayOauthTokens)
        .set(values)
        .where(
          and(
            eq(ebayOauthTokens.channelId, channelId),
            eq(ebayOauthTokens.environment, this.config.environment),
          ),
        );
    } else {
      await this.db.insert(ebayOauthTokens).values({
        ...values,
        createdAt: now,
      });
    }
  }

  private async getStoredToken(channelId: number): Promise<TokenRecord | null> {
    const [row] = await this.db
      .select()
      .from(ebayOauthTokens)
      .where(
        and(
          eq(ebayOauthTokens.channelId, channelId),
          eq(ebayOauthTokens.environment, this.config.environment),
        ),
      )
      .limit(1);

    if (!row) return null;

    return {
      accessToken: row.accessToken,
      accessTokenExpiresAt: row.accessTokenExpiresAt,
      refreshToken: row.refreshToken,
      refreshTokenExpiresAt: row.refreshTokenExpiresAt,
    };
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

  const environment = (process.env.EBAY_ENVIRONMENT || "production") as
    | "sandbox"
    | "production";

  return { clientId, clientSecret, ruName, environment };
}
