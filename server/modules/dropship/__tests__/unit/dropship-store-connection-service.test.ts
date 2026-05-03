import { beforeEach, describe, expect, it } from "vitest";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipStoreConnectionService,
  type CompleteOAuthQuery,
  type DropshipMarketplaceOAuthProvider,
  type DropshipOAuthStatePayload,
  type DropshipOAuthStateSigner,
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
import { normalizeDropshipOAuthReturnTo, normalizeShopifyShopDomain } from "../../domain/store-connection";
import { DropshipError } from "../../domain/errors";

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
});

describe("DropshipStoreConnectionService", () => {
  let repository: FakeStoreConnectionRepository;
  let vendorProvisioning: FakeVendorProvisioningService;
  let stateSigner: FakeStateSigner;
  let logs: DropshipLogEvent[];
  let service: DropshipStoreConnectionService;

  beforeEach(() => {
    repository = new FakeStoreConnectionRepository();
    vendorProvisioning = new FakeVendorProvisioningService();
    stateSigner = new FakeStateSigner();
    logs = [];
    service = new DropshipStoreConnectionService({
      vendorProvisioning: vendorProvisioning as unknown as DropshipVendorProvisioningService,
      repository,
      oauthProviders: {
        ebay: new FakeOAuthProvider("ebay"),
        shopify: new FakeOAuthProvider("shopify"),
      },
      stateSigner,
      tokenCipher: new FakeTokenCipher(),
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

  it("blocks new OAuth when the membership store limit is already used", async () => {
    repository.connections = [makeConnection({ status: "connected" })];

    await expect(service.startOAuth("member-1", { platform: "ebay" })).rejects.toMatchObject({
      code: "DROPSHIP_STORE_CONNECTION_LIMIT_REACHED",
    });
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

  async exchangeCode(_input: {
    code: string;
    shopDomain: string | null;
    query: CompleteOAuthQuery;
  }): Promise<DropshipStoreConnectionTokenGrant> {
    return {
      accessToken: "access-token",
      refreshToken: this.platform === "ebay" ? "refresh-token" : null,
      accessTokenExpiresAt: new Date(now.getTime() + 3600000),
      externalAccountId: `external-${this.platform}`,
      externalDisplayName: `External ${this.platform}`,
    };
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
  lastOrderProcessingConfigInput: Parameters<DropshipStoreConnectionRepository["updateOrderProcessingConfig"]>[0] | null = null;

  async listByVendorId(): Promise<DropshipStoreConnectionProfile[]> {
    return this.connections;
  }

  async countActiveByVendorId(): Promise<number> {
    return this.connections.filter((connection) => (
      ["connected", "needs_reauth", "refresh_failed", "grace_period", "paused"].includes(connection.status)
    )).length;
  }

  async connectStore(input: Parameters<DropshipStoreConnectionRepository["connectStore"]>[0]): Promise<DropshipStoreConnectionProfile> {
    this.lastConnectInput = input;
    const connection = makeConnection({
      vendorId: input.vendorId,
      platform: input.platform,
      externalAccountId: input.externalAccountId,
      externalDisplayName: input.externalDisplayName,
      shopDomain: input.shopDomain,
      status: "connected",
      tokenExpiresAt: input.tokenExpiresAt,
      hasAccessToken: true,
      hasRefreshToken: input.refreshTokenRef !== null,
    });
    this.connections = [connection];
    return connection;
  }

  async disconnectStore(input: Parameters<DropshipStoreConnectionRepository["disconnectStore"]>[0]): Promise<DropshipStoreConnectionProfile> {
    const connection = this.connections.find((item) => item.storeConnectionId === input.storeConnectionId);
    if (!connection) throw new Error("missing fake connection");
    const updated = {
      ...connection,
      status: "grace_period" as const,
      hasAccessToken: false,
      hasRefreshToken: false,
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
