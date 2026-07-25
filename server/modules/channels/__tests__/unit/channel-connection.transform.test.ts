import { describe, expect, it } from "vitest";
import type { ChannelConnection } from "@shared/schema";
import {
  toPublicChannelConnection,
} from "../../channel-connection.transform";

function channelConnection(
  overrides: Partial<ChannelConnection> = {},
): ChannelConnection {
  return {
    id: 4,
    channelId: 36,
    shopDomain: "card-shellz.myshopify.com",
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    webhookSecret: "test-webhook-secret",
    apiVersion: "2026-07",
    scopes: "read_products,write_products",
    shopifyLocationId: "67892347039",
    expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    lastSyncAt: new Date("2026-07-25T12:00:00.000Z"),
    syncStatus: "connected",
    syncError: null,
    metadata: {
      fulfillmentPolicyId: "policy-1",
      nestedCredential: "must-not-be-returned",
    },
    createdAt: new Date("2026-02-14T03:46:00.391Z"),
    updatedAt: new Date("2026-07-25T12:00:00.000Z"),
    ...overrides,
  };
}

describe("toPublicChannelConnection", () => {
  it("returns null when a channel has no connection", () => {
    expect(toPublicChannelConnection(null)).toBeNull();
    expect(toPublicChannelConnection(undefined)).toBeNull();
  });

  it("returns only the reviewed public connection fields", () => {
    const result = toPublicChannelConnection(channelConnection());

    expect(result).toEqual({
      id: 4,
      channelId: 36,
      shopDomain: "card-shellz.myshopify.com",
      apiVersion: "2026-07",
      scopes: "read_products,write_products",
      shopifyLocationId: "67892347039",
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      lastSyncAt: new Date("2026-07-25T12:00:00.000Z"),
      syncStatus: "connected",
      syncError: null,
      createdAt: new Date("2026-02-14T03:46:00.391Z"),
      updatedAt: new Date("2026-07-25T12:00:00.000Z"),
      hasAccessToken: true,
      hasRefreshToken: true,
      hasWebhookSecret: true,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("webhookSecret");
    expect(serialized).not.toContain("metadata");
    expect(serialized).not.toContain("test-access-token");
    expect(serialized).not.toContain("test-refresh-token");
    expect(serialized).not.toContain("test-webhook-secret");
    expect(serialized).not.toContain("must-not-be-returned");
  });

  it("reports credential presence without returning credential values", () => {
    const result = toPublicChannelConnection(channelConnection({
      refreshToken: null,
      webhookSecret: null,
    }));

    expect(result).toMatchObject({
      hasAccessToken: true,
      hasRefreshToken: false,
      hasWebhookSecret: false,
    });
  });

  it("redacts stored credential values from sync errors", () => {
    const result = toPublicChannelConnection(channelConnection({
      syncError:
        "Authorization failed for test-access-token and test-refresh-token",
    }));

    expect(result?.syncError).toBe(
      "Authorization failed for [REDACTED] and [REDACTED]",
    );
  });
});
