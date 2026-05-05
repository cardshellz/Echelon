import { randomUUID } from "crypto";
import { DropshipError } from "../domain/errors";
import {
  DROPSHIP_OAUTH_STATE_TTL_MINUTES,
  DROPSHIP_STORE_DISCONNECT_GRACE_HOURS,
  assertDropshipStorePlatform,
  assertVendorCanConnectStore,
  calculateDisconnectGraceEndsAt,
  normalizeDropshipOAuthReturnTo,
  normalizeShopifyShopDomain,
  type DropshipStoreConnectionLifecycleStatus,
  type DropshipSupportedStorePlatform,
} from "../domain/store-connection";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import type {
  DropshipListingInventoryMode,
  DropshipListingMode,
  DropshipListingPriceMode,
} from "./dropship-marketplace-listing-provider";
import type {
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "./dropship-vendor-provisioning-service";
import {
  listDropshipAdminStoreConnectionsInputSchema,
  type ListDropshipAdminStoreConnectionsInput,
} from "./dropship-store-connection-dtos";

export interface DropshipStoreConnectionProfile {
  storeConnectionId: number;
  vendorId: number;
  platform: DropshipSupportedStorePlatform;
  externalAccountId: string | null;
  externalDisplayName: string | null;
  shopDomain: string | null;
  status: DropshipStoreConnectionLifecycleStatus;
  setupStatus: string;
  disconnectReason: string | null;
  disconnectedAt: Date | null;
  graceEndsAt: Date | null;
  tokenExpiresAt: Date | null;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  lastSyncAt: Date | null;
  lastOrderSyncAt: Date | null;
  lastInventorySyncAt: Date | null;
  orderProcessingConfig: DropshipStoreConnectionOrderProcessingConfig;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipStoreConnectionOrderProcessingConfig {
  defaultWarehouseId: number | null;
}

export interface DropshipStoreConnectionSetupCheck {
  checkKey: string;
  status: string;
  severity: string;
  message: string | null;
  lastCheckedAt: Date | null;
  resolvedAt: Date | null;
}

export interface DropshipAdminStoreConnectionListItem extends DropshipStoreConnectionProfile {
  vendor: {
    vendorId: number;
    memberId: string;
    businessName: string | null;
    email: string | null;
    status: string;
    entitlementStatus: string;
  };
  listingConfig: DropshipAdminStoreListingConfigSummary;
  setupCheckSummary: {
    openCount: number;
    errorCount: number;
    warningCount: number;
  };
}

export interface DropshipAdminStoreListingConfigSummary {
  isConfigured: boolean;
  isActive: boolean;
  listingMode: DropshipListingMode | null;
  inventoryMode: DropshipListingInventoryMode | null;
  priceMode: DropshipListingPriceMode | null;
  requiredConfigKeys: string[];
  requiredProductFields: string[];
  updatedAt: Date | null;
}

export interface DropshipAdminStoreConnectionListResult {
  items: DropshipAdminStoreConnectionListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface DropshipStoreConnectionTokenRecord {
  tokenKind: "access" | "refresh";
  tokenRef: string;
  keyId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  expiresAt: Date | null;
}

export interface DropshipStoreConnectionTokenGrant {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  externalAccountId: string | null;
  externalDisplayName: string | null;
  tokenMetadata?: Record<string, unknown>;
}

export interface DropshipMarketplaceOAuthProvider {
  platform: DropshipSupportedStorePlatform;
  createAuthorizationUrl(input: {
    state: string;
    shopDomain: string | null;
  }): DropshipStoreConnectionOAuthStart;
  exchangeCode(input: {
    code: string;
    shopDomain: string | null;
    query: CompleteOAuthQuery;
  }): Promise<DropshipStoreConnectionTokenGrant>;
}

export interface DropshipStoreConnectionOAuthStart {
  authorizationUrl: string;
  platform: DropshipSupportedStorePlatform;
  shopDomain: string | null;
  expiresAt: Date;
  scopes: string[];
  environment: string;
}

export interface DropshipOAuthStatePayload {
  version: 1;
  vendorId: number;
  memberId: string;
  platform: DropshipSupportedStorePlatform;
  shopDomain: string | null;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  returnTo: string | null;
}

export interface DropshipOAuthStateSigner {
  sign(payload: DropshipOAuthStatePayload): string;
  verify(state: string, now: Date): DropshipOAuthStatePayload;
}

export interface DropshipStoreTokenCipher {
  seal(input: {
    tokenKind: "access" | "refresh";
    token: string;
    vendorId: number;
    platform: DropshipSupportedStorePlatform;
    expiresAt: Date | null;
  }): DropshipStoreConnectionTokenRecord;
}

export interface DropshipStoreConnectionPostConnectProvider {
  afterStoreConnected(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipSupportedStorePlatform;
    shopDomain: string | null;
    accessToken: string;
    connectedAt: Date;
  }): Promise<void>;
}

export interface CompleteOAuthQuery {
  platform?: DropshipSupportedStorePlatform;
  code?: string;
  state: string;
  error?: string;
  shop?: string;
  hmac?: string;
}

export interface DropshipStoreConnectionRepository {
  listByVendorId(vendorId: number): Promise<DropshipStoreConnectionProfile[]>;
  listForAdmin(input: ListDropshipAdminStoreConnectionsInput): Promise<DropshipAdminStoreConnectionListResult>;
  countActiveByVendorId(vendorId: number): Promise<number>;
  connectStore(input: {
    vendorId: number;
    platform: DropshipSupportedStorePlatform;
    externalAccountId: string | null;
    externalDisplayName: string | null;
    shopDomain: string | null;
    accessTokenRef: string;
    refreshTokenRef: string | null;
    tokenExpiresAt: Date | null;
    tokenRecords: DropshipStoreConnectionTokenRecord[];
    config: Record<string, unknown>;
    connectedAt: Date;
  }): Promise<DropshipStoreConnectionProfile>;
  disconnectStore(input: {
    vendorId: number;
    storeConnectionId: number;
    reason: string;
    disconnectedAt: Date;
    graceEndsAt: Date;
    idempotencyKey: string;
  }): Promise<DropshipStoreConnectionProfile>;
  updateOrderProcessingConfig(input: {
    storeConnectionId: number;
    defaultWarehouseId: number | null;
    actor: {
      actorType: "admin" | "system";
      actorId?: string;
    };
    idempotencyKey: string;
    updatedAt: Date;
  }): Promise<DropshipStoreConnectionProfile>;
  listSetupChecks(vendorId: number): Promise<Record<number, DropshipStoreConnectionSetupCheck[]>>;
}

export interface DropshipStoreConnectionServiceDependencies {
  vendorProvisioning: DropshipVendorProvisioningService;
  repository: DropshipStoreConnectionRepository;
  oauthProviders: Record<DropshipSupportedStorePlatform, DropshipMarketplaceOAuthProvider>;
  stateSigner: DropshipOAuthStateSigner;
  tokenCipher: DropshipStoreTokenCipher;
  postConnectProvider?: DropshipStoreConnectionPostConnectProvider;
  notificationSender?: DropshipNotificationSender;
  clock: DropshipClock;
  logger: DropshipLogger;
  disconnectGraceHours?: number;
}

export class DropshipStoreConnectionService {
  private readonly disconnectGraceHours: number;

  constructor(private readonly deps: DropshipStoreConnectionServiceDependencies) {
    this.disconnectGraceHours = deps.disconnectGraceHours ?? DROPSHIP_STORE_DISCONNECT_GRACE_HOURS;
  }

  async listForMember(memberId: string): Promise<{
    vendor: DropshipProvisionedVendorProfile;
    connections: DropshipStoreConnectionProfile[];
    setupChecksByConnectionId: Record<number, DropshipStoreConnectionSetupCheck[]>;
  }> {
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    const [connections, setupChecksByConnectionId] = await Promise.all([
      this.deps.repository.listByVendorId(vendor.vendorId),
      this.deps.repository.listSetupChecks(vendor.vendorId),
    ]);

    return { vendor, connections, setupChecksByConnectionId };
  }

  async listForAdmin(input: unknown = {}): Promise<DropshipAdminStoreConnectionListResult> {
    const parsed = parseListForAdminInput(input);
    return this.deps.repository.listForAdmin(parsed);
  }

  async startOAuth(memberId: string, input: {
    platform: DropshipSupportedStorePlatform;
    shopDomain?: string;
    returnTo?: string;
  }): Promise<DropshipStoreConnectionOAuthStart> {
    const platform = assertDropshipStorePlatform(input.platform);
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    const activeConnectionCount = await this.deps.repository.countActiveByVendorId(vendor.vendorId);
    assertVendorCanConnectStore({
      vendorStatus: vendor.status,
      activeConnectionCount,
      includedConnectionLimit: vendor.includedStoreConnections,
    });

    const shopDomain = platform === "shopify"
      ? normalizeShopifyShopDomain(input.shopDomain ?? "")
      : null;
    const now = this.deps.clock.now();
    const expiresAt = new Date(now.getTime() + DROPSHIP_OAUTH_STATE_TTL_MINUTES * 60 * 1000);
    const state = this.deps.stateSigner.sign({
      version: 1,
      vendorId: vendor.vendorId,
      memberId: vendor.memberId,
      platform,
      shopDomain,
      nonce: randomUUID(),
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      returnTo: normalizeDropshipOAuthReturnTo(input.returnTo),
    });

    return this.deps.oauthProviders[platform].createAuthorizationUrl({
      state,
      shopDomain,
    });
  }

  async completeOAuthCallback(input: CompleteOAuthQuery): Promise<{
    connection: DropshipStoreConnectionProfile;
    returnTo: string | null;
  }> {
    if (input.error) {
      throw new DropshipError("DROPSHIP_STORE_OAUTH_DECLINED", "Store authorization was not completed.", {
        providerError: input.error,
      });
    }
    if (!input.code) {
      throw new DropshipError("DROPSHIP_STORE_OAUTH_CODE_REQUIRED", "Store authorization code is required.");
    }

    const now = this.deps.clock.now();
    const state = this.deps.stateSigner.verify(input.state, now);
    const platform = assertDropshipStorePlatform(input.platform ?? state.platform);
    if (platform !== state.platform) {
      throw new DropshipError("DROPSHIP_STORE_OAUTH_STATE_MISMATCH", "Store authorization state does not match platform.", {
        statePlatform: state.platform,
        requestPlatform: platform,
      });
    }

    const vendor = (await this.deps.vendorProvisioning.provisionForMember(state.memberId)).vendor;
    if (vendor.vendorId !== state.vendorId) {
      throw new DropshipError("DROPSHIP_STORE_OAUTH_VENDOR_MISMATCH", "Store authorization state does not match vendor.");
    }

    const activeConnectionCount = await this.deps.repository.countActiveByVendorId(vendor.vendorId);
    assertVendorCanConnectStore({
      vendorStatus: vendor.status,
      activeConnectionCount,
      includedConnectionLimit: vendor.includedStoreConnections,
    });

    const grant = await this.deps.oauthProviders[platform].exchangeCode({
      code: input.code,
      shopDomain: state.shopDomain,
      query: input,
    });
    const tokenRecords = [
      this.deps.tokenCipher.seal({
        tokenKind: "access",
        token: grant.accessToken,
        vendorId: vendor.vendorId,
        platform,
        expiresAt: grant.accessTokenExpiresAt,
      }),
      ...(grant.refreshToken
        ? [this.deps.tokenCipher.seal({
            tokenKind: "refresh" as const,
            token: grant.refreshToken,
            vendorId: vendor.vendorId,
            platform,
            expiresAt: null,
          })]
        : []),
    ];

    const connection = await this.deps.repository.connectStore({
      vendorId: vendor.vendorId,
      platform,
      externalAccountId: grant.externalAccountId,
      externalDisplayName: grant.externalDisplayName,
      shopDomain: state.shopDomain,
      accessTokenRef: tokenRecords[0].tokenRef,
      refreshTokenRef: tokenRecords.find((record) => record.tokenKind === "refresh")?.tokenRef ?? null,
      tokenExpiresAt: grant.accessTokenExpiresAt,
      tokenRecords,
      config: {
        tokenMetadata: grant.tokenMetadata ?? {},
        connectedByMemberId: vendor.memberId,
      },
      connectedAt: now,
    });

    this.deps.logger.info({
      code: "DROPSHIP_STORE_CONNECTED",
      message: "Dropship store connection completed.",
      context: {
        vendorId: vendor.vendorId,
        storeConnectionId: connection.storeConnectionId,
        platform,
      },
    });

    await this.runPostConnectSetup({
      vendorId: vendor.vendorId,
      storeConnectionId: connection.storeConnectionId,
      platform,
      shopDomain: state.shopDomain,
      accessToken: grant.accessToken,
      connectedAt: now,
    });

    return {
      connection,
      returnTo: state.returnTo,
    };
  }

  async disconnect(memberId: string, storeConnectionId: number, input: {
    reason: string;
    idempotencyKey: string;
  }): Promise<DropshipStoreConnectionProfile> {
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    const disconnectedAt = this.deps.clock.now();
    const connection = await this.deps.repository.disconnectStore({
      vendorId: vendor.vendorId,
      storeConnectionId,
      reason: input.reason,
      disconnectedAt,
      graceEndsAt: calculateDisconnectGraceEndsAt(disconnectedAt, this.disconnectGraceHours),
      idempotencyKey: input.idempotencyKey,
    });

    this.deps.logger.info({
      code: "DROPSHIP_STORE_DISCONNECT_STARTED",
      message: "Dropship store connection moved into disconnect grace.",
      context: {
        vendorId: vendor.vendorId,
        storeConnectionId,
        idempotencyKey: input.idempotencyKey,
      },
    });

    if (isFreshDisconnect(connection, disconnectedAt)) {
      await this.notifyStoreDisconnectStarted({
        connection,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
    }

    return connection;
  }

  async updateOrderProcessingConfig(input: {
    storeConnectionId: number;
    defaultWarehouseId: number | null;
    idempotencyKey: string;
    actor: {
      actorType: "admin" | "system";
      actorId?: string;
    };
  }): Promise<DropshipStoreConnectionProfile> {
    const connection = await this.deps.repository.updateOrderProcessingConfig({
      storeConnectionId: input.storeConnectionId,
      defaultWarehouseId: normalizeDefaultWarehouseId(input.defaultWarehouseId),
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      updatedAt: this.deps.clock.now(),
    });

    this.deps.logger.info({
      code: "DROPSHIP_STORE_ORDER_PROCESSING_CONFIG_UPDATED",
      message: "Dropship store order processing config was updated.",
      context: {
        storeConnectionId: connection.storeConnectionId,
        vendorId: connection.vendorId,
        defaultWarehouseId: connection.orderProcessingConfig.defaultWarehouseId,
        idempotencyKey: input.idempotencyKey,
      },
    });

    return connection;
  }

  private async runPostConnectSetup(input: Parameters<DropshipStoreConnectionPostConnectProvider["afterStoreConnected"]>[0]): Promise<void> {
    if (!this.deps.postConnectProvider) {
      return;
    }

    try {
      await this.deps.postConnectProvider.afterStoreConnected(input);
      this.deps.logger.info({
        code: "DROPSHIP_STORE_POST_CONNECT_SETUP_COMPLETED",
        message: "Dropship store post-connect setup completed.",
        context: {
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          platform: input.platform,
        },
      });
    } catch (error) {
      this.deps.logger.warn({
        code: "DROPSHIP_STORE_POST_CONNECT_SETUP_FAILED",
        message: "Dropship store post-connect setup failed after the connection was persisted.",
        context: {
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          platform: input.platform,
          cause: formatDropshipStoreConnectionSetupError(error),
        },
      });
    }
  }

  private async notifyStoreDisconnectStarted(input: {
    connection: DropshipStoreConnectionProfile;
    reason: string;
    idempotencyKey: string;
  }): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: input.connection.vendorId,
      eventType: "dropship_store_disconnected",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship store disconnected",
      message: `Your ${input.connection.platform} dropship store was disconnected. Order intake and listing pushes are paused during the disconnect grace period.`,
      payload: {
        vendorId: input.connection.vendorId,
        storeConnectionId: input.connection.storeConnectionId,
        platform: input.connection.platform,
        externalAccountId: input.connection.externalAccountId,
        externalDisplayName: input.connection.externalDisplayName,
        shopDomain: input.connection.shopDomain,
        status: input.connection.status,
        setupStatus: input.connection.setupStatus,
        reason: input.reason,
        disconnectedAt: input.connection.disconnectedAt?.toISOString() ?? null,
        graceEndsAt: input.connection.graceEndsAt?.toISOString() ?? null,
      },
      idempotencyKey: `store-disconnect:${input.connection.storeConnectionId}:${input.idempotencyKey}`,
    }, {
      code: "DROPSHIP_STORE_DISCONNECT_NOTIFICATION_FAILED",
      message: "Dropship store disconnect notification failed after the store was disconnected.",
      context: {
        vendorId: input.connection.vendorId,
        storeConnectionId: input.connection.storeConnectionId,
        platform: input.connection.platform,
      },
    });
  }
}

export function makeDropshipStoreConnectionLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipStoreConnectionEvent("info", event),
    warn: (event) => logDropshipStoreConnectionEvent("warn", event),
    error: (event) => logDropshipStoreConnectionEvent("error", event),
  };
}

export const systemDropshipStoreConnectionClock: DropshipClock = {
  now: () => new Date(),
};

function normalizeDefaultWarehouseId(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new DropshipError(
      "DROPSHIP_STORE_ORDER_PROCESSING_WAREHOUSE_INVALID",
      "Order processing default warehouse id must be a positive integer or null.",
      { defaultWarehouseId: value },
    );
  }
  return value;
}

function formatDropshipStoreConnectionSetupError(error: unknown): Record<string, unknown> {
  if (error instanceof DropshipError) {
    return {
      code: error.code,
      message: error.message,
      context: error.context ?? {},
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message,
    };
  }
  return {
    message: String(error),
  };
}

function isFreshDisconnect(connection: DropshipStoreConnectionProfile, disconnectedAt: Date): boolean {
  return connection.status === "grace_period"
    && connection.disconnectedAt?.getTime() === disconnectedAt.getTime();
}

function parseListForAdminInput(input: unknown): ListDropshipAdminStoreConnectionsInput {
  const result = listDropshipAdminStoreConnectionsInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_STORE_CONNECTION_LIST_INVALID_INPUT",
      "Dropship store connection list input failed validation.",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

function logDropshipStoreConnectionEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}
