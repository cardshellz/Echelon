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
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
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
  launchReady: boolean;
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

export type DropshipStoreOAuthIntent = "connect" | "refresh_connection" | "change_store";

export interface DropshipMarketplaceOAuthProvider {
  platform: DropshipSupportedStorePlatform;
  createAuthorizationUrl(input: {
    state: string;
    shopDomain: string | null;
    intent: DropshipStoreOAuthIntent;
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
  intent?: DropshipStoreOAuthIntent;
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
  [key: string]: string | undefined;
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
  hasReconnectableConnection(input: {
    vendorId: number;
    platform: DropshipSupportedStorePlatform;
  }): Promise<boolean>;
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
  recordPostConnectSetupSucceeded(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipSupportedStorePlatform;
    completedAt: Date;
  }): Promise<DropshipStoreConnectionProfile>;
  recordPostConnectSetupFailed(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipSupportedStorePlatform;
    errorCode: string;
    message: string;
    retryable: boolean;
    failedAt: Date;
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
    intent?: DropshipStoreOAuthIntent;
    shopDomain?: string;
    returnTo?: string;
  }): Promise<DropshipStoreConnectionOAuthStart> {
    const platform = assertDropshipStorePlatform(input.platform);
    const intent = normalizeStoreOAuthIntent(input.intent);
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    const shopDomain = platform === "shopify"
      ? normalizeShopifyShopDomain(input.shopDomain ?? "")
      : null;
    await this.assertCanStartOAuth({
      vendor,
      platform,
      intent,
    });

    const now = this.deps.clock.now();
    const expiresAt = new Date(now.getTime() + DROPSHIP_OAUTH_STATE_TTL_MINUTES * 60 * 1000);
    const state = this.deps.stateSigner.sign({
      version: 1,
      vendorId: vendor.vendorId,
      memberId: vendor.memberId,
      platform,
      shopDomain,
      intent,
      nonce: randomUUID(),
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      returnTo: normalizeDropshipOAuthReturnTo(input.returnTo),
    });

    return this.deps.oauthProviders[platform].createAuthorizationUrl({
      state,
      shopDomain,
      intent,
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
    const intent = normalizeStoreOAuthIntent(state.intent);
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

    await this.assertCanStartOAuth({
      vendor,
      platform,
      intent,
    });
    const refreshTargetConnection = intent === "refresh_connection"
      ? await this.loadOAuthTargetConnection({
          vendorId: vendor.vendorId,
          platform,
        })
      : null;

    const grant = await this.deps.oauthProviders[platform].exchangeCode({
      code: input.code,
      shopDomain: state.shopDomain,
      query: input,
    });
    assertOAuthGrantMatchesIntent({
      intent,
      platform,
      targetConnection: refreshTargetConnection,
      grant,
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

    let connection = await this.deps.repository.connectStore({
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
        oauthIntent: intent,
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

    connection = await this.runPostConnectSetup({
      connection,
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

  private async assertCanStartOAuth(input: {
    vendor: DropshipProvisionedVendorProfile;
    platform: DropshipSupportedStorePlatform;
    intent: DropshipStoreOAuthIntent;
  }): Promise<void> {
    const activeConnectionCount = await this.deps.repository.countActiveByVendorId(input.vendor.vendorId);
    try {
      assertVendorCanConnectStore({
        vendorStatus: input.vendor.status,
        activeConnectionCount,
        includedConnectionLimit: input.vendor.includedStoreConnections,
      });
    } catch (error) {
      if (
        !(error instanceof DropshipError)
        || error.code !== "DROPSHIP_STORE_CONNECTION_LIMIT_REACHED"
      ) {
        throw error;
      }

      if (input.intent === "connect") {
        throw error;
      }

      if (activeConnectionCount > input.vendor.includedStoreConnections) {
        throw error;
      }

      const canReconnectExistingConnection = await this.deps.repository.hasReconnectableConnection({
        vendorId: input.vendor.vendorId,
        platform: input.platform,
      });
      if (!canReconnectExistingConnection) {
        throw error;
      }
      return;
    }

    if (input.intent !== "connect") {
      const canReconnectExistingConnection = await this.deps.repository.hasReconnectableConnection({
        vendorId: input.vendor.vendorId,
        platform: input.platform,
      });
      if (!canReconnectExistingConnection) {
        throw new DropshipError(
          "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
          "A store connection is required before it can be refreshed or changed.",
          {
            vendorId: input.vendor.vendorId,
            platform: input.platform,
            intent: input.intent,
          },
        );
      }
    }
  }

  private async loadOAuthTargetConnection(input: {
    vendorId: number;
    platform: DropshipSupportedStorePlatform;
  }): Promise<DropshipStoreConnectionProfile | null> {
    const connections = await this.deps.repository.listByVendorId(input.vendorId);
    return selectOAuthTargetConnection(connections, input.platform);
  }

  private async runPostConnectSetup(
    input: Parameters<DropshipStoreConnectionPostConnectProvider["afterStoreConnected"]>[0] & {
      connection: DropshipStoreConnectionProfile;
    },
  ): Promise<DropshipStoreConnectionProfile> {
    if (!this.deps.postConnectProvider) {
      return this.recordPostConnectSetupSucceededSafely(input);
    }

    try {
      await this.deps.postConnectProvider.afterStoreConnected({
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        platform: input.platform,
        shopDomain: input.shopDomain,
        accessToken: input.accessToken,
        connectedAt: input.connectedAt,
      });
      const connection = await this.recordPostConnectSetupSucceededSafely(input);
      this.deps.logger.info({
        code: "DROPSHIP_STORE_POST_CONNECT_SETUP_COMPLETED",
        message: "Dropship store post-connect setup completed.",
        context: {
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          platform: input.platform,
        },
      });
      return connection;
    } catch (error) {
      const connection = await this.recordPostConnectSetupFailedSafely(input, error);
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
      return connection;
    }
  }

  private async recordPostConnectSetupSucceededSafely(input: {
    connection: DropshipStoreConnectionProfile;
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipSupportedStorePlatform;
  }): Promise<DropshipStoreConnectionProfile> {
    try {
      return await this.deps.repository.recordPostConnectSetupSucceeded({
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        platform: input.platform,
        completedAt: this.deps.clock.now(),
      });
    } catch (error) {
      this.deps.logger.error({
        code: "DROPSHIP_STORE_POST_CONNECT_SETUP_STATUS_UPDATE_FAILED",
        message: "Dropship store post-connect setup completed but readiness status could not be persisted.",
        context: {
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          platform: input.platform,
          cause: formatDropshipStoreConnectionSetupError(error),
        },
      });
      return input.connection;
    }
  }

  private async recordPostConnectSetupFailedSafely(
    input: {
      connection: DropshipStoreConnectionProfile;
      vendorId: number;
      storeConnectionId: number;
      platform: DropshipSupportedStorePlatform;
    },
    error: unknown,
  ): Promise<DropshipStoreConnectionProfile> {
    try {
      return await this.deps.repository.recordPostConnectSetupFailed({
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        platform: input.platform,
        errorCode: resolveDropshipStoreConnectionSetupErrorCode(error),
        message: resolveDropshipStoreConnectionSetupErrorMessage(error),
        retryable: resolveDropshipStoreConnectionSetupRetryable(error),
        failedAt: this.deps.clock.now(),
      });
    } catch (recordError) {
      this.deps.logger.error({
        code: "DROPSHIP_STORE_POST_CONNECT_SETUP_FAILURE_STATUS_UPDATE_FAILED",
        message: "Dropship store post-connect setup failed and the failure status could not be persisted.",
        context: {
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          platform: input.platform,
          setupFailure: formatDropshipStoreConnectionSetupError(error),
          persistenceFailure: formatDropshipStoreConnectionSetupError(recordError),
        },
      });
      return input.connection;
    }
  }

  private async notifyStoreDisconnectStarted(input: {
    connection: DropshipStoreConnectionProfile;
    reason: string;
    idempotencyKey: string;
  }): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: input.connection.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.STORE_DISCONNECTED,
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

function resolveDropshipStoreConnectionSetupErrorCode(error: unknown): string {
  if (error instanceof DropshipError) {
    return error.code;
  }
  return "DROPSHIP_STORE_POST_CONNECT_SETUP_ERROR";
}

function resolveDropshipStoreConnectionSetupErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function resolveDropshipStoreConnectionSetupRetryable(error: unknown): boolean {
  return error instanceof DropshipError && error.context?.retryable === true;
}

function isFreshDisconnect(connection: DropshipStoreConnectionProfile, disconnectedAt: Date): boolean {
  return connection.status === "grace_period"
    && connection.disconnectedAt?.getTime() === disconnectedAt.getTime();
}

function normalizeStoreOAuthIntent(intent: DropshipStoreOAuthIntent | undefined): DropshipStoreOAuthIntent {
  if (intent === "refresh_connection" || intent === "change_store") {
    return intent;
  }
  return "connect";
}

function selectOAuthTargetConnection(
  connections: DropshipStoreConnectionProfile[],
  platform: DropshipSupportedStorePlatform,
): DropshipStoreConnectionProfile | null {
  return connections
    .filter((connection) => (
      connection.platform === platform
      && ["connected", "needs_reauth", "refresh_failed", "disconnected"].includes(connection.status)
    ))
    .sort((left, right) => {
      const statusOrder = (status: DropshipStoreConnectionProfile["status"]) => {
        if (status === "needs_reauth") return 0;
        if (status === "refresh_failed") return 1;
        if (status === "connected") return 2;
        return 3;
      };
      return statusOrder(left.status) - statusOrder(right.status)
        || right.updatedAt.getTime() - left.updatedAt.getTime()
        || right.storeConnectionId - left.storeConnectionId;
    })[0] ?? null;
}

function assertOAuthGrantMatchesIntent(input: {
  intent: DropshipStoreOAuthIntent;
  platform: DropshipSupportedStorePlatform;
  targetConnection: DropshipStoreConnectionProfile | null;
  grant: DropshipStoreConnectionTokenGrant;
}): void {
  if (input.intent !== "refresh_connection" || !input.targetConnection?.externalAccountId) {
    return;
  }

  if (input.grant.externalAccountId !== input.targetConnection.externalAccountId) {
    throw new DropshipError(
      "DROPSHIP_STORE_OAUTH_ACCOUNT_MISMATCH",
      "The authorized marketplace account did not match the store connection being refreshed.",
      {
        platform: input.platform,
        expectedExternalAccountId: input.targetConnection.externalAccountId,
        actualExternalAccountId: input.grant.externalAccountId,
      },
    );
  }
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
