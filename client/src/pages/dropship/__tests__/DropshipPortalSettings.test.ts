import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

  it("binds the email verification code to one explicit store action", async () => {
    vi.stubGlobal("React", React);
    const {
      SensitiveActionVerificationPanel,
      storeVerificationActionContent,
    } = await import("../DropshipPortalSettings");
    const connection = makeConnection("grace_period");

    expect(storeVerificationActionContent({
      connection,
      emailChallengeAction: "connect_store",
      intent: "change_store",
    })).toEqual({
      actionLabel: "Connect a different Ebay store: marz_cards",
      confirmLabel: "Verify and connect a different Ebay store",
    });

    const markup = renderToStaticMarkup(React.createElement(SensitiveActionVerificationPanel, {
      connection,
      emailChallengeAction: "connect_store",
      intent: "change_store",
      onCancel: () => undefined,
      onConfirm: () => undefined,
      onVerificationCodeChange: () => undefined,
      pendingStoreAction: null,
      verificationCode: "813606",
    }));

    expect(markup).toContain("verification code sent to your email");
    expect(markup).toContain("Selected action:");
    expect(markup).toContain("Connect a different Ebay store: marz_cards");
    expect(markup).toContain("Verify and connect a different Ebay store");
    expect(markup).not.toContain("Verify and reconnect");
  });

  it("locks every ordinary store action while one verification challenge is active", async () => {
    vi.stubGlobal("React", React);
    const { storeActionButtonsLocked } = await import("../DropshipPortalSettings");

    expect(storeActionButtonsLocked("connect_store", null)).toBe(true);
    expect(storeActionButtonsLocked("disconnect_store", null)).toBe(true);
    expect(storeActionButtonsLocked(null, "reauth-send-code")).toBe(true);
    expect(storeActionButtonsLocked(null, null)).toBe(false);
  });

  it("uses action-specific confirmation copy for reconnect and disconnect", async () => {
    vi.stubGlobal("React", React);
    const { storeVerificationActionContent } = await import("../DropshipPortalSettings");
    const connection = makeConnection("grace_period");

    expect(storeVerificationActionContent({
      connection,
      emailChallengeAction: "connect_store",
      intent: "refresh_connection",
    })).toEqual({
      actionLabel: "Reconnect Ebay store: marz_cards",
      confirmLabel: "Verify and reconnect the Ebay store",
    });
    expect(storeVerificationActionContent({
      connection,
      emailChallengeAction: "disconnect_store",
      intent: "refresh_connection",
    })).toEqual({
      actionLabel: "Disconnect marz_cards",
      confirmLabel: "Verify and disconnect marz_cards",
    });
  });
});
