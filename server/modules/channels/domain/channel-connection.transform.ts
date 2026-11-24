import type { ChannelConnection } from "@shared/schema";

export type PublicChannelConnectionDto = {
  id: number;
  channelId: number;
  shopDomain: string | null;
  apiVersion: string | null;
  scopes: string | null;
  shopifyLocationId: string | null;
  expiresAt: Date | null;
  lastSyncAt: Date | null;
  syncStatus: string | null;
  syncError: string | null;
  createdAt: Date;
  updatedAt: Date;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  hasWebhookSecret: boolean;
};

function redactKnownSecrets(
  value: string | null,
  secrets: Array<string | null>,
): string | null {
  if (value === null) return null;

  let redacted = value;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

/**
 * Converts the credential-bearing database row into the public API contract.
 *
 * This is intentionally an allowlist. New channel connection columns remain
 * server-only until they are explicitly reviewed for client exposure.
 */
export function toPublicChannelConnection(
  connection: ChannelConnection | null | undefined,
): PublicChannelConnectionDto | null {
  if (!connection) return null;

  const secrets = [
    connection.accessToken,
    connection.refreshToken,
    connection.webhookSecret,
  ];

  return {
    id: connection.id,
    channelId: connection.channelId,
    shopDomain: connection.shopDomain,
    apiVersion: connection.apiVersion,
    scopes: connection.scopes,
    shopifyLocationId: connection.shopifyLocationId,
    expiresAt: connection.expiresAt,
    lastSyncAt: connection.lastSyncAt,
    syncStatus: connection.syncStatus,
    syncError: redactKnownSecrets(connection.syncError, secrets),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    hasAccessToken: Boolean(connection.accessToken),
    hasRefreshToken: Boolean(connection.refreshToken),
    hasWebhookSecret: Boolean(connection.webhookSecret),
  };
}
