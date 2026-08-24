import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import type { DropshipStoreConnectionProfileResponse } from "@/lib/dropship-ops-surface";

function makeConnection(
  status: DropshipStoreConnectionProfileResponse["status"],
): DropshipStoreConnectionProfileResponse {
  return {
    storeConnectionId: 1,
    vendorId: 10,
    platform: "ebay",
    externalAccountId: "provider-account-1",
    externalDisplayName: "marz_cards",
    shopDomain: null,
    status,
    setupStatus: "attention_required",
    disconnectReason: "Vendor portal disconnect request for marz_cards.",
    disconnectedAt: "2026-08-24T23:21:00.000Z",
    graceEndsAt: "2026-08-27T23:21:00.000Z",
    tokenExpiresAt: null,
    hasAccessToken: false,
    hasRefreshToken: false,
    launchReady: false,
    lastSyncAt: null,
    lastOrderSyncAt: null,
    lastInventorySyncAt: null,
    orderProcessingConfig: { defaultWarehouseId: 1 },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-24T23:21:00.000Z",
  };
}

describe("DropshipPortalSettings store lifecycle actions", () => {
  it("offers both same-store reconnect and different-store authorization during the disconnect grace period", async () => {
    vi.stubGlobal("React", React);
    const {
      canChangeStoreConnection,
      canRefreshStoreConnection,
      storeOAuthActionTitle,
    } = await import("../DropshipPortalSettings");
    const connection = makeConnection("grace_period");

    expect(canRefreshStoreConnection(connection)).toBe(true);
    expect(canChangeStoreConnection(connection)).toBe(true);
    expect(storeOAuthActionTitle("refresh_connection", "ebay", connection.status)).toBe("Reconnect Ebay store");
    expect(storeOAuthActionTitle("change_store", "ebay", connection.status)).toBe("Connect a different Ebay store");
  });
});
