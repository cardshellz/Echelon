import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type {
  DropshipLogEvent,
  DropshipNotificationSenderInput,
} from "../../application/dropship-ports";
import {
  DropshipStoreConnectionService,
  type CompleteOAuthQuery,
  type DropshipMarketplaceOAuthProvider,
  type DropshipOAuthStatePayload,
  type DropshipOAuthStateSigner,
  type DropshipStoreConnectionPostConnectProvider,
  type DropshipStoreConnectionOAuthStart,
  type DropshipStoreConnectionProfile,
  type DropshipStoreConnectionRepository,
  type DropshipStoreConnectionSetupCheck,
  type DropshipStoreConnectionTokenGrant,
  type DropshipStoreConnectionTokenRecord,
  type DropshipStoreTokenCipher,
} from "../../application/dropship-store-connection-service";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "../../application/dropship-vendor-provisioning-service";
import {
  isDropshipStoreConnectionLaunchReady,
  normalizeDropshipOAuthReturnTo,
  normalizeShopifyShopDomain,
} from "../../domain/store-connection";
import { DropshipError } from "../../domain/errors";
import { PgDropshipStoreConnectionRepository } from "../../infrastructure/dropship-store-connection.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const now = new Date("2026-05-01T15:00:00.000Z");

describe("dropship store connection domain", () => {
  it("normalizes Shopify shop domains safely", () => {
    expect(normalizeShopifyShopDomain("CardShellz-Test")).toBe("cardshellz-test.myshopify.com");
    expect(normalizeShopifyShopDomain("https://cardshellz-test.myshopify.com/")).toBe("cardshellz-test.myshopify.com");
    expect(() => normalizeShopifyShopDomain("cardshellz.com")).toThrow(DropshipError);
  });

  it("keeps OAuth return targets inside the portal path space", () => {
    expect(normalizeDropshipOAuthReturnTo(" /onboarding ")).toBe("/onboarding");
    expect(normalizeDropshipOAuthReturnTo(undefined)).toBeNull();
    expect(() => normalizeDropshipOAuthReturnTo("https://attacker.example")).toThrow(DropshipError);
    expect(() => normalizeDropshipOAuthReturnTo("//attacker.example")).toThrow(DropshipError);
    expect(() => normalizeDropshipOAuthReturnTo("/\\attacker")).toThrow(DropshipError);
  });

  it("requires supported platforms, setup readiness, and platform-specific tokens for launch readiness", () => {
    expect(isDropshipStoreConnectionLaunchReady({
      platform: "shopify",
      status: "connected",
      setupStatus: "ready",
      hasAccessToken: true,
      hasRefreshToken: false,
    })).toBe(true);
    expect(isDropshipStoreConnectionLaunchReady({
      platform: "ebay",
      status: "connected",
      setupStatus: "ready",
      hasAccessToken: true,
      hasRefreshToken: false,
    })).toBe(false);
    expect(isDropshipStoreConnectionLaunchReady({
      platform: "unsupported",
      status: "connected",
      setupStatus: "ready",
      hasAccessToken: true,
      hasRefreshToken: true,
    })).toBe(false);
    expect(isDropshipStoreConnectionLaunchReady({
      platform: "shopify",
      status: "connected",
      setupStatus: "pending",
      hasAccessToken: true,
      hasRefreshToken: false,
    })).toBe(false);
  });
});

describe("PgDropshipStoreConnectionRepository", () => {
  it("counts unhealthy launch-blocking connections as active store slots", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const release = () => undefined;
    const query = async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [{ count: "2" }] };
    };
    const connect = async () => ({ query, release });
    const repository = new PgDropshipStoreConnectionRepository({ connect } as unknown as Pool);

    const count = await repository.countActiveByVendorId(10);

    expect(count).toBe(2);
    expect(queries[0]?.sql).toContain("status = ANY($2::text[])");
    expect(queries[0]?.params).toEqual([
      10,
      ["connected", "needs_reauth", "refresh_failed", "grace_period", "paused"],
    ]);
  });

  it("preserves admin order-processing config when reconnecting an unhealthy store", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const release = () => undefined;
    const existingConfig = {
      orderProcessing: { defaultWarehouseId: 3 },
      previousMetadata: { scope: "old" },
    };
    const nextConfig = {
      ...existingConfig,
      tokenMetadata: { scope: "new" },
      connectedByMemberId: "member-1",
    };
    const query = async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const sqlText = String(sql);

      if (sqlText.includes("FROM dropship.dropship_store_connections") && sqlText.includes("FOR UPDATE")) {
        return {
          rows: [makeStoreConnectionRow({
            id: 21,
            status: "needs_reauth",
            setup_status: "attention_required",
            config: existingConfig,
          })],
        };
      }
      if (sqlText.includes("SELECT COUNT(*) AS count")) {
        return { rows: [{ count: "1" }] };
      }
      if (sqlText.includes("UPDATE dropship.dropship_store_connections")) {
        return {
          rows: [makeStoreConnectionRow({
            id: 21,
            status: "connected",
            setup_status: "pending",
            access_token_ref: "new-access-ref",
            refresh_token_ref: "new-refresh-ref",
            config: nextConfig,
          })],
        };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_store_listing_configs")) {
        return {
          rows: [{
            id: 31,
            store_connection_id: 21,
            platform: "ebay",
            listing_mode: "draft_first",
            inventory_mode: "managed_quantity_sync",
            price_mode: "vendor_defined",
            marketplace_config: {},
            required_config_keys: [],
            required_product_fields: [],
            is_active: true,
            created_at: now,
            updated_at: now,
          }],
        };
      }
      return { rows: [] };
    };
    const connect = async () => ({ query, release });
    const repository = new PgDropshipStoreConnectionRepository({ connect } as unknown as Pool);

    const result = await repository.connectStore({
      vendorId: 10,
      platform: "ebay",
      externalAccountId: "external-ebay",
      externalDisplayName: "External ebay",
      shopDomain: null,
      accessTokenRef: "new-access-ref",
      refreshTokenRef: "new-refresh-ref",
      tokenExpiresAt: new Date(now.getTime() + 3600000),
      tokenRecords: [],
      config: {
        tokenMetadata: { scope: "new" },
        connectedByMemberId: "member-1",
      },
      connectedAt: now,
    });

    const updateCall = queries.find((entry) => entry.sql.includes("UPDATE dropship.dropship_store_connections"));
    expect(updateCall?.sql).toContain("config = COALESCE(config, '{}'::jsonb) || $9::jsonb");
    expect(updateCall?.params[8]).toBe(JSON.stringify({
      tokenMetadata: { scope: "new" },
      connectedByMemberId: "member-1",
    }));
    expect(result.storeConnectionId).toBe(21);
    expect(result.orderProcessingConfig.defaultWarehouseId).toBe(3);
  });

  it("maps launch readiness from stored platform credentials and setup status", async () => {
    const release = () => undefined;
    const query = async () => ({
      rows: [
        makeStoreConnectionRow({
          id: 20,
          platform: "ebay",
          setup_status: "ready",
          access_token_ref: "access-ref",
          refresh_token_ref: null,
        }),
        makeStoreConnectionRow({
          id: 21,
          platform: "shopify",
          setup_status: "ready",
          access_token_ref: "access-ref",
          refresh_token_ref: null,
        }),
        makeStoreConnectionRow({
          id: 22,
          platform: "ebay",
          setup_status: "pending",
          access_token_ref: "access-ref",
          refresh_token_ref: "refresh-ref",
        }),
      ],
    });
    const connect = async () => ({ query, release });
    const repository = new PgDropshipStoreConnectionRepository({ connect } as unknown as Pool);

    const result = await repository.listByVendorId(10);

    expect(result.map((connection) => ({
      storeConnectionId: connection.storeConnectionId,
      platform: connection.platform,
      hasAccessToken: connection.hasAccessToken,
      hasRefreshToken: connection.hasRefreshToken,
      setupStatus: connection.setupStatus,
      launchReady: connection.launchReady,
    }))).toEqual([
      {
        storeConnectionId: 20,
        platform: "ebay",
        hasAccessToken: true,
        hasRefreshToken: false,
        setupStatus: "ready",
        launchReady: false,
      },
      {
        storeConnectionId: 21,
        platform: "shopify",
        hasAccessToken: true,
        hasRefreshToken: false,
        setupStatus: "ready",
        launchReady: true,
      },
      {
        storeConnectionId: 22,
        platform: "ebay",
        hasAccessToken: true,
        hasRefreshToken: true,
        setupStatus: "pending",
        launchReady: false,
      },
    ]);
  });
});

describe("DropshipStoreConnectionService", () => {
  let repository: FakeStoreConnectionRepository;
  let vendorProvisioning: FakeVendorProvisioningService;
  let stateSigner: FakeStateSigner;
  let postConnectProvider: FakePostConnectProvider;
  let notificationSender: FakeNotificationSender;
  let ebayOAuthProvider: FakeOAuthProvider;
  let shopifyOAuthProvider: FakeOAuthProvider;
  let logs: DropshipLogEvent[];
  let service: DropshipStoreConnectionService;

  beforeEach(() => {
    repository = new FakeStoreConnectionRepository();
    vendorProvisioning = new FakeVendorProvisioningService();
    stateSigner = new FakeStateSigner();
    postConnectProvider = new FakePostConnectProvider();
    notificationSender = new FakeNotificationSender();
    ebayOAuthProvider = new FakeOAuthProvider("ebay");
    shopifyOAuthProvider = new FakeOAuthProvider("shopify");
    logs = [];
    service = new DropshipStoreConnectionService({
      vendorProvisioning: vendorProvisioning as unknown as DropshipVendorProvisioningService,
      repository,
      oauthProviders: {
        ebay: ebayOAuthProvider,
        shopify: shopifyOAuthProvider,
      },
      stateSigner,
      tokenCipher: new FakeTokenCipher(),
      postConnectProvider,
      notificationSender,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
      disconnectGraceHours: 72,
    });
  });

  it("starts OAuth with signed vendor state and normalized shop domain", async () => {
    const result = await service.startOAuth("member-1", {
      platform: "shopify",
      shopDomain: "Vendor-Test",
      returnTo: "/dropship/settings",
    });

    expect(result.platform).toBe("shopify");
    expect(result.shopDomain).toBe("vendor-test.myshopify.com");
    expect(result.authorizationUrl).toContain("state=fake-state");
    expect(stateSigner.lastPayload).toMatchObject({
      vendorId: 10,
      memberId: "member-1",
      platform: "shopify",
      shopDomain: "vendor-test.myshopify.com",
      returnTo: "/dropship/settings",
    });
  });

  it("blocks new OAuth for a different platform when the membership store limit is already used", async () => {
    repository.connections = [makeConnection({ platform: "ebay", status: "connected" })];

    await expect(service.startOAuth("member-1", {
      platform: "shopify",
      shopDomain: "Vendor-Test",
    })).rejects.toMatchObject({
      code: "DROPSHIP_STORE_CONNECTION_LIMIT_REACHED",
    });
  });

  it("allows OAuth to reconnect an occupied same-platform store slot", async () => {
    repository.connections = [makeConnection({ storeConnectionId: 21, platform: "ebay", status: "connected" })];

    const start = await service.startOAuth("member-1", { platform: "ebay" });

    expect(start.platform).toBe("ebay");
    expect(stateSigner.lastPayload).toMatchObject({
      vendorId: 10,
      memberId: "member-1",
      platform: "ebay",
    });
  });

  it("allows OAuth to repair an unhealthy existing store connection", async () => {
    repository.connections = [makeConnection({ storeConnectionId: 21, status: "needs_reauth" })];

    const start = await service.startOAuth("member-1", { platform: "ebay" });

    expect(start.platform).toBe("ebay");
    expect(stateSigner.lastPayload).toMatchObject({
      vendorId: 10,
      memberId: "member-1",
      platform: "ebay",
    });
  });

  it("blocks a different platform when an unhealthy connection owns the launch store slot", async () => {
    repository.connections = [makeConnection({ storeConnectionId: 21, platform: "ebay", status: "needs_reauth" })];

    await expect(service.startOAuth("member-1", {
      platform: "shopify",
      shopDomain: "Vendor-Test",
    })).rejects.toMatchObject({
      code: "DROPSHIP_STORE_CONNECTION_LIMIT_REACHED",
    });

    expect(stateSigner.lastPayload).toBeNull();
  });

  it("rejects external OAuth return targets before signing state", async () => {
    await expect(service.startOAuth("member-1", {
      platform: "ebay",
      returnTo: "https://attacker.example/callback",
    })).rejects.toMatchObject({
      code: "DROPSHIP_INVALID_OAUTH_RETURN_TO",
    });

    expect(stateSigner.lastPayload).toBeNull();
  });

  it("completes OAuth by connecting the store with sealed token refs", async () => {
    stateSigner.payload = {
      version: 1,
      vendorId: 10,
      memberId: "member-1",
      platform: "ebay",
      shopDomain: null,
      nonce: "nonce",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60000).toISOString(),
      returnTo: "/dropship/settings",
    };

    const result = await service.completeOAuthCallback({
      state: "signed",
      code: "auth-code",
      platform: "ebay",
    });

    expect(result.connection).toMatchObject({
      vendorId: 10,
      platform: "ebay",
      externalAccountId: "external-ebay",
      status: "connected",
      hasAccessToken: true,
      hasRefreshToken: true,
    });
    expect(repository.lastConnectInput?.tokenRecords.map((record) => record.tokenKind)).toEqual(["access", "refresh"]);
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_STORE_CONNECTED" });
  });

  it("completes OAuth by reconnecting the existing unhealthy store slot", async () => {
    repository.connections = [makeConnection({ storeConnectionId: 21, status: "needs_reauth" })];
    stateSigner.payload = {
      version: 1,
      vendorId: 10,
      memberId: "member-1",
      platform: "ebay",
      shopDomain: null,
      nonce: "nonce",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60000).toISOString(),
      returnTo: "/dropship/settings",
    };

    const result = await service.completeOAuthCallback({
      state: "signed",
      code: "auth-code",
      platform: "ebay",
    });

    expect(result.connection).toMatchObject({
      storeConnectionId: 21,
      status: "connected",
      hasAccessToken: true,
      hasRefreshToken: true,
    });
  });

  it("completes OAuth by replacing the existing same-platform store authorization", async () => {
    repository.connections = [makeConnection({ storeConnectionId: 21, platform: "ebay", status: "connected" })];
    stateSigner.payload = {
      version: 1,
      vendorId: 10,
      memberId: "member-1",
      platform: "ebay",
      shopDomain: null,
      nonce: "nonce",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60000).toISOString(),
      returnTo: "/dropship/settings",
    };

    const result = await service.completeOAuthCallback({
      state: "signed",
      code: "auth-code",
      platform: "ebay",
    });

    expect(result.connection).toMatchObject({
      storeConnectionId: 21,
      status: "connected",
      externalAccountId: "external-ebay",
      hasAccessToken: true,
      hasRefreshToken: true,
    });
  });

  it("rejects OAuth completion for a different platform when an unhealthy connection owns the launch store slot", async () => {
    repository.connections = [makeConnection({ storeConnectionId: 21, platform: "ebay", status: "needs_reauth" })];
    stateSigner.payload = {
      version: 1,
      vendorId: 10,
      memberId: "member-1",
      platform: "shopify",
      shopDomain: "vendor-test.myshopify.com",
      nonce: "nonce",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60000).toISOString(),
      returnTo: "/dropship/settings",
    };

    await expect(service.completeOAuthCallback({
      state: "signed",
      code: "auth-code",
      platform: "shopify",
      shop: "vendor-test.myshopify.com",
    })).rejects.toMatchObject({
      code: "DROPSHIP_STORE_CONNECTION_LIMIT_REACHED",
    });

    expect(shopifyOAuthProvider.exchangeCalls).toHaveLength(0);
    expect(repository.lastConnectInput).toBeNull();
  });

  it("runs post-connect setup with the live access token after the store is persisted", async () => {
    stateSigner.payload = {
      version: 1,
      vendorId: 10,
      memberId: "member-1",
      platform: "shopify",
      shopDomain: "vendor-test.myshopify.com",
      nonce: "nonce",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60000).toISOString(),
      returnTo: "/dropship/settings",
    };

    const result = await service.completeOAuthCallback({
      state: "signed",
      code: "auth-code",
      platform: "shopify",
      shop: "vendor-test.myshopify.com",
    });

    expect(result.connection.storeConnectionId).toBe(20);
    expect(result.connection.setupStatus).toBe("ready");
    expect(result.connection.launchReady).toBe(true);
    expect(postConnectProvider.calls).toEqual([{
      vendorId: 10,
      storeConnectionId: 20,
      platform: "shopify",
      shopDomain: "vendor-test.myshopify.com",
      accessToken: "access-token",
      connectedAt: now,
    }]);
  });

  it("does not fail OAuth completion when post-connect setup fails after persistence", async () => {
    postConnectProvider.error = new DropshipError(
      "DROPSHIP_SHOPIFY_WEBHOOK_SUBSCRIPTION_HTTP_ERROR",
      "Shopify webhook subscription setup failed.",
      { retryable: true },
    );
    stateSigner.payload = {
      version: 1,
      vendorId: 10,
      memberId: "member-1",
      platform: "shopify",
      shopDomain: "vendor-test.myshopify.com",
      nonce: "nonce",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60000).toISOString(),
      returnTo: "/dropship/settings",
    };

    const result = await service.completeOAuthCallback({
      state: "signed",
      code: "auth-code",
      platform: "shopify",
      shop: "vendor-test.myshopify.com",
    });

    expect(result.connection.status).toBe("connected");
    expect(result.connection.setupStatus).toBe("attention_required");
    expect(result.connection.launchReady).toBe(false);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DROPSHIP_STORE_CONNECTED" }),
      expect.objectContaining({
        code: "DROPSHIP_STORE_POST_CONNECT_SETUP_FAILED",
        context: expect.objectContaining({
          vendorId: 10,
          storeConnectionId: 20,
          platform: "shopify",
        }),
      }),
    ]));
  });

  it("disconnects into grace and clears token presence", async () => {
    repository.connections = [makeConnection({ storeConnectionId: 21, status: "connected" })];

    const result = await service.disconnect("member-1", 21, {
      reason: "Vendor requested disconnect",
      idempotencyKey: "disconnect-1",
    });

    expect(result.status).toBe("grace_period");
    expect(result.hasAccessToken).toBe(false);
    expect(result.graceEndsAt?.toISOString()).toBe("2026-05-04T15:00:00.000Z");
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_STORE_DISCONNECT_STARTED" });
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_store_disconnected",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship store disconnected",
      idempotencyKey: "store-disconnect:21:disconnect-1",
      payload: {
        vendorId: 10,
        storeConnectionId: 21,
        platform: "ebay",
        status: "grace_period",
        reason: "Vendor requested disconnect",
        disconnectedAt: "2026-05-01T15:00:00.000Z",
        graceEndsAt: "2026-05-04T15:00:00.000Z",
      },
    });
  });

  it("does not fail disconnect when the disconnect notification fails", async () => {
    repository.connections = [makeConnection({ storeConnectionId: 21, status: "connected" })];
    notificationSender.error = new Error("email unavailable");

    const result = await service.disconnect("member-1", 21, {
      reason: "Vendor requested disconnect",
      idempotencyKey: "disconnect-1",
    });

    expect(result.status).toBe("grace_period");
    expect(notificationSender.sent).toHaveLength(1);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_STORE_DISCONNECT_NOTIFICATION_FAILED",
        context: expect.objectContaining({
          vendorId: 10,
          storeConnectionId: 21,
          platform: "ebay",
          error: "email unavailable",
        }),
      }),
    ]));
  });

  it("updates admin order processing warehouse config", async () => {
    repository.connections = [makeConnection({ storeConnectionId: 21 })];

    const result = await service.updateOrderProcessingConfig({
      storeConnectionId: 21,
      defaultWarehouseId: 3,
      idempotencyKey: "warehouse-config-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.orderProcessingConfig.defaultWarehouseId).toBe(3);
    expect(repository.lastOrderProcessingConfigInput).toMatchObject({
      storeConnectionId: 21,
      defaultWarehouseId: 3,
      idempotencyKey: "warehouse-config-1",
      actor: { actorType: "admin", actorId: "admin-1" },
      updatedAt: now,
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_STORE_ORDER_PROCESSING_CONFIG_UPDATED",
    });
  });

  it("lists store connections for admin review with parsed filters", async () => {
    repository.connections = [makeConnection({ storeConnectionId: 21, status: "needs_reauth" })];

    const result = await service.listForAdmin({
      statuses: ["needs_reauth"],
      platform: "ebay",
      vendorId: 10,
      search: "External",
      page: 1,
      limit: 25,
    });

    expect(result.items[0]).toMatchObject({
      storeConnectionId: 21,
      status: "needs_reauth",
      vendor: { vendorId: 10 },
    });
    expect(repository.lastListForAdminInput).toMatchObject({
      statuses: ["needs_reauth"],
      platform: "ebay",
      vendorId: 10,
      search: "External",
      page: 1,
      limit: 25,
    });
  });

  it("rejects invalid admin store connection list filters before repository calls", async () => {
    await expect(service.listForAdmin({
      statuses: ["invalid"],
      page: 1,
      limit: 50,
    })).rejects.toMatchObject({
      code: "DROPSHIP_STORE_CONNECTION_LIST_INVALID_INPUT",
    });
    expect(repository.lastListForAdminInput).toBeNull();
  });
});

class FakeVendorProvisioningService {
  vendor = makeVendor();

  async provisionForMember(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    return {
      vendor: { ...this.vendor, memberId },
      created: false,
      changedFields: [],
    };
  }
}

class FakeStateSigner implements DropshipOAuthStateSigner {
  payload: DropshipOAuthStatePayload | null = null;
  lastPayload: DropshipOAuthStatePayload | null = null;

  sign(payload: DropshipOAuthStatePayload): string {
    this.lastPayload = payload;
    this.payload = payload;
    return "fake-state";
  }

  verify(): DropshipOAuthStatePayload {
    if (!this.payload) {
      throw new Error("missing fake state");
    }
    return this.payload;
  }
}

class FakeOAuthProvider implements DropshipMarketplaceOAuthProvider {
  exchangeCalls: Array<{
    code: string;
    shopDomain: string | null;
    query: CompleteOAuthQuery;
  }> = [];

  constructor(readonly platform: "ebay" | "shopify") {}

  createAuthorizationUrl(input: { state: string; shopDomain: string | null }): DropshipStoreConnectionOAuthStart {
    return {
      authorizationUrl: `https://${this.platform}.example.test/oauth?state=${input.state}`,
      platform: this.platform,
      shopDomain: input.shopDomain,
      expiresAt: new Date(now.getTime() + 60000),
      scopes: ["scope"],
      environment: "test",
    };
  }

  async exchangeCode(input: {
    code: string;
    shopDomain: string | null;
    query: CompleteOAuthQuery;
  }): Promise<DropshipStoreConnectionTokenGrant> {
    this.exchangeCalls.push(input);
    return {
      accessToken: "access-token",
      refreshToken: this.platform === "ebay" ? "refresh-token" : null,
      accessTokenExpiresAt: new Date(now.getTime() + 3600000),
      externalAccountId: `external-${this.platform}`,
      externalDisplayName: `External ${this.platform}`,
    };
  }
}

class FakePostConnectProvider implements DropshipStoreConnectionPostConnectProvider {
  calls: Array<Parameters<DropshipStoreConnectionPostConnectProvider["afterStoreConnected"]>[0]> = [];
  error: Error | null = null;

  async afterStoreConnected(
    input: Parameters<DropshipStoreConnectionPostConnectProvider["afterStoreConnected"]>[0],
  ): Promise<void> {
    this.calls.push(input);
    if (this.error) {
      throw this.error;
    }
  }
}

class FakeNotificationSender {
  sent: DropshipNotificationSenderInput[] = [];
  error: Error | null = null;

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    this.sent.push(input);
    if (this.error) {
      throw this.error;
    }
  }
}

class FakeTokenCipher implements DropshipStoreTokenCipher {
  seal(input: {
    tokenKind: "access" | "refresh";
    token: string;
    vendorId: number;
    platform: "ebay" | "shopify";
    expiresAt: Date | null;
  }): DropshipStoreConnectionTokenRecord {
    return {
      tokenKind: input.tokenKind,
      tokenRef: `${input.platform}-${input.tokenKind}-ref`,
      keyId: "test-key",
      ciphertext: "ciphertext",
      iv: "iv",
      authTag: "tag",
      expiresAt: input.expiresAt,
    };
  }
}

class FakeStoreConnectionRepository implements DropshipStoreConnectionRepository {
  connections: DropshipStoreConnectionProfile[] = [];
  lastConnectInput: Parameters<DropshipStoreConnectionRepository["connectStore"]>[0] | null = null;
  lastListForAdminInput: Parameters<DropshipStoreConnectionRepository["listForAdmin"]>[0] | null = null;
  lastOrderProcessingConfigInput: Parameters<DropshipStoreConnectionRepository["updateOrderProcessingConfig"]>[0] | null = null;

  async listByVendorId(): Promise<DropshipStoreConnectionProfile[]> {
    return this.connections;
  }

  async listForAdmin(
    input: Parameters<DropshipStoreConnectionRepository["listForAdmin"]>[0],
  ): ReturnType<DropshipStoreConnectionRepository["listForAdmin"]> {
    this.lastListForAdminInput = input;
    return {
      items: this.connections.map((connection) => ({
        ...connection,
        vendor: {
          vendorId: connection.vendorId,
          memberId: "member-1",
          businessName: "Vendor",
          email: "vendor@cardshellz.test",
          status: "active",
          entitlementStatus: "active",
        },
        setupCheckSummary: {
          openCount: 1,
          errorCount: connection.status === "needs_reauth" ? 1 : 0,
          warningCount: 0,
        },
      })),
      total: this.connections.length,
      page: input.page,
      limit: input.limit,
    };
  }

  async countActiveByVendorId(): Promise<number> {
    return this.connections.filter((connection) => (
      ["connected", "needs_reauth", "refresh_failed", "grace_period", "paused"].includes(connection.status)
    )).length;
  }

  async hasReconnectableConnection(
    input: Parameters<DropshipStoreConnectionRepository["hasReconnectableConnection"]>[0],
  ): Promise<boolean> {
    return this.connections.some((connection) => (
      connection.vendorId === input.vendorId
      && connection.platform === input.platform
      && ["connected", "needs_reauth", "refresh_failed"].includes(connection.status)
    ));
  }

  async connectStore(input: Parameters<DropshipStoreConnectionRepository["connectStore"]>[0]): Promise<DropshipStoreConnectionProfile> {
    this.lastConnectInput = input;
    const existing = this.connections.find((connection) => (
      connection.vendorId === input.vendorId
      && connection.platform === input.platform
      && ["connected", "needs_reauth", "refresh_failed", "disconnected"].includes(connection.status)
    ));
    const connection = makeConnection({
      storeConnectionId: existing?.storeConnectionId ?? 20,
      vendorId: input.vendorId,
      platform: input.platform,
      externalAccountId: input.externalAccountId,
      externalDisplayName: input.externalDisplayName,
      shopDomain: input.shopDomain,
      status: "connected",
      tokenExpiresAt: input.tokenExpiresAt,
      hasAccessToken: true,
      hasRefreshToken: input.refreshTokenRef !== null,
      launchReady: false,
    });
    this.connections = [connection];
    return connection;
  }

  async recordPostConnectSetupSucceeded(
    input: Parameters<DropshipStoreConnectionRepository["recordPostConnectSetupSucceeded"]>[0],
  ): Promise<DropshipStoreConnectionProfile> {
    return this.updateSetupStatus(input.storeConnectionId, "ready", input.completedAt);
  }

  async recordPostConnectSetupFailed(
    input: Parameters<DropshipStoreConnectionRepository["recordPostConnectSetupFailed"]>[0],
  ): Promise<DropshipStoreConnectionProfile> {
    return this.updateSetupStatus(input.storeConnectionId, "attention_required", input.failedAt);
  }

  async disconnectStore(input: Parameters<DropshipStoreConnectionRepository["disconnectStore"]>[0]): Promise<DropshipStoreConnectionProfile> {
    const connection = this.connections.find((item) => item.storeConnectionId === input.storeConnectionId);
    if (!connection) throw new Error("missing fake connection");
    const updated = {
      ...connection,
      status: "grace_period" as const,
      hasAccessToken: false,
      hasRefreshToken: false,
      launchReady: false,
      disconnectReason: input.reason,
      disconnectedAt: input.disconnectedAt,
      graceEndsAt: input.graceEndsAt,
    };
    this.connections = [updated];
    return updated;
  }

  async updateOrderProcessingConfig(
    input: Parameters<DropshipStoreConnectionRepository["updateOrderProcessingConfig"]>[0],
  ): Promise<DropshipStoreConnectionProfile> {
    this.lastOrderProcessingConfigInput = input;
    const connection = this.connections.find((item) => item.storeConnectionId === input.storeConnectionId);
    if (!connection) throw new Error("missing fake connection");
    const updated = {
      ...connection,
      orderProcessingConfig: {
        defaultWarehouseId: input.defaultWarehouseId,
      },
      updatedAt: input.updatedAt,
    };
    this.connections = [updated];
    return updated;
  }

  async listSetupChecks(): Promise<Record<number, DropshipStoreConnectionSetupCheck[]>> {
    return {};
  }

  private updateSetupStatus(
    storeConnectionId: number,
    setupStatus: DropshipStoreConnectionProfile["setupStatus"],
    updatedAt: Date,
  ): DropshipStoreConnectionProfile {
    const connection = this.connections.find((item) => item.storeConnectionId === storeConnectionId);
    if (!connection) throw new Error("missing fake connection");
    const updated = {
      ...connection,
      setupStatus,
      updatedAt,
    };
    const launchReady = isDropshipStoreConnectionLaunchReady({
      platform: updated.platform,
      status: updated.status,
      setupStatus: updated.setupStatus,
      hasAccessToken: updated.hasAccessToken,
      hasRefreshToken: updated.hasRefreshToken,
    });
    const withLaunchReady = {
      ...updated,
      launchReady,
    };
    this.connections = [withLaunchReady];
    return withLaunchReady;
  }
}

function makeVendor(overrides: Partial<DropshipProvisionedVendorProfile> = {}): DropshipProvisionedVendorProfile {
  return {
    vendorId: 10,
    memberId: "member-1",
    currentSubscriptionId: "sub-1",
    currentPlanId: "ops-plan",
    businessName: null,
    contactName: null,
    email: "vendor@cardshellz.test",
    phone: null,
    status: "active",
    entitlementStatus: "active",
    entitlementCheckedAt: now,
    membershipGraceEndsAt: null,
    includedStoreConnections: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeStoreConnectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    vendor_id: 10,
    platform: "ebay",
    external_account_id: "external-ebay",
    external_display_name: "External ebay",
    shop_domain: null,
    access_token_ref: "access-ref",
    refresh_token_ref: "refresh-ref",
    token_expires_at: new Date(now.getTime() + 3600000),
    status: "connected",
    setup_status: "ready",
    disconnect_reason: null,
    disconnected_at: null,
    grace_ends_at: null,
    last_sync_at: null,
    last_order_sync_at: null,
    last_inventory_sync_at: null,
    config: {},
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeConnection(overrides: Partial<DropshipStoreConnectionProfile> = {}): DropshipStoreConnectionProfile {
  return {
    storeConnectionId: 20,
    vendorId: 10,
    platform: "ebay",
    externalAccountId: "external-ebay",
    externalDisplayName: "External ebay",
    shopDomain: null,
    status: "connected",
    setupStatus: "pending",
    disconnectReason: null,
    disconnectedAt: null,
    graceEndsAt: null,
    tokenExpiresAt: new Date(now.getTime() + 3600000),
    hasAccessToken: true,
    hasRefreshToken: true,
    launchReady: false,
    lastSyncAt: null,
    lastOrderSyncAt: null,
    lastInventorySyncAt: null,
    orderProcessingConfig: {
      defaultWarehouseId: null,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
