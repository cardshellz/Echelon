import { createHash, randomUUID } from "crypto";
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
  providerEnvironment: string | null;
  externalAccountIdentityScheme: string | null;
  externalAccountVerifiedAt: Date | null;
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
export interface DropshipObservedProviderAccountClaimResult {
  connection: DropshipStoreConnectionProfile;
  claimed: boolean;
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
  providerEnvironment: string;
  externalAccountIdentityScheme: string | null;
  providerAccountUsername?: string | null;
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
  targetStoreConnectionId?: number | null;
  targetConnectionFingerprint?: string | null;
  targetConnectionUpdatedAt?: string | null;
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
    providerEnvironment: string;
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
  isMarketplaceIdentityBound(storeConnectionId: number): Promise<boolean>;
  connectStore(input: {
    vendorId: number;
    platform: DropshipSupportedStorePlatform;
    externalAccountId: string | null;
    providerEnvironment: string;
    externalAccountIdentityScheme: string | null;
    externalAccountVerifiedAt: Date | null;
    externalDisplayName: string | null;
    shopDomain: string | null;
    accessTokenRef: string;
    refreshTokenRef: string | null;
    tokenExpiresAt: Date | null;
    tokenRecords: DropshipStoreConnectionTokenRecord[];
    config: Record<string, unknown>;
    oauthIntent: DropshipStoreOAuthIntent;
    targetStoreConnectionId: number | null;
    expectedTargetConnectionUpdatedAt: Date | null;
    connectedAt: Date;
  }): Promise<DropshipStoreConnectionProfile>;
  claimObservedProviderAccount(input: {
    storeConnectionId: number;
    platform: DropshipSupportedStorePlatform;
    providerEnvironment: string;
    externalAccountId: string;
    externalAccountIdentityScheme: "provider_user_id";
    observedAt: Date;
    idempotencyKey: string;
    observationHash: string;
    correlationId: string | null;
    actor: {
      actorType: "user" | "service" | "system";
      actorId: string;
    };
  }): Promise<DropshipObservedProviderAccountClaimResult>;
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
  disconnectStoreForAdmin(input: {
    storeConnectionId: number;
    reason: string;
    disconnectedAt: Date;
    graceEndsAt: Date;
    idempotencyKey: string;
    actor: {
      actorType: "admin" | "system";
      actorId?: string;
    };
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

  async claimObservedProviderAccount(input: {
    storeConnectionId: number;
    platform: DropshipSupportedStorePlatform;
    providerEnvironment: string;
    externalAccountId: string;
    externalAccountIdentityScheme: "provider_user_id";
    observedAt: Date;
    idempotencyKey: string;
    observationHash: string;
    correlationId: string | null;
    actor: {
      actorType: "user" | "service" | "system";
      actorId: string;
    };
  }): Promise<DropshipObservedProviderAccountClaimResult> {
    if (!Number.isSafeInteger(input.storeConnectionId) || input.storeConnectionId <= 0) {
      throw new DropshipError("DROPSHIP_STORE_IDENTITY_CLAIM_INVALID", "Store connection ID must be a positive integer.");
    }
    const platform = assertDropshipStorePlatform(input.platform);
    const providerEnvironment = requireIdentityText(input.providerEnvironment, "providerEnvironment", 30);
    const externalAccountId = requireIdentityText(input.externalAccountId, "externalAccountId", 255);
    const actorId = requireIdentityText(input.actor.actorId, "actor.id", 255);
    if (input.externalAccountIdentityScheme !== "provider_user_id" || Number.isNaN(input.observedAt.getTime())) {
      throw new DropshipError(
        "DROPSHIP_STORE_IDENTITY_CLAIM_INVALID",
        "Observed provider account identity is invalid.",
      );
    }
    const idempotencyKey = requireIdentityText(input.idempotencyKey, "idempotencyKey", 200);
    const observationHash = input.observationHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(observationHash)) {
      throw new DropshipError(
        "DROPSHIP_STORE_IDENTITY_CLAIM_INVALID",
        "observationHash must be a lowercase SHA-256 value.",
      );
    }
    const correlationId = input.correlationId === null
      ? null
      : requireIdentityText(input.correlationId, "correlationId", 100);
    return this.deps.repository.claimObservedProviderAccount({
      ...input,
      platform,
      providerEnvironment,
      externalAccountId,
      actor: { ...input.actor, actorId },
      idempotencyKey,
      observationHash,
      correlationId,
    });
  }

  async startOAuth(memberId: string, input: {
    platform: DropshipSupportedStorePlatform;
    intent?: DropshipStoreOAuthIntent;
    storeConnectionId?: number;
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
    const targetStoreConnectionId = requireOAuthTargetStoreConnectionId(intent, input.storeConnectionId);
    const targetConnection = targetStoreConnectionId === null
      ? null
      : await this.loadOAuthTargetConnection({
          vendorId: vendor.vendorId,
          platform,
          storeConnectionId: targetStoreConnectionId,
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
      targetStoreConnectionId: targetConnection?.storeConnectionId ?? null,
      targetConnectionFingerprint: targetConnection === null
        ? null
        : oauthTargetConnectionFingerprint(targetConnection),
      targetConnectionUpdatedAt: targetConnection?.updatedAt.toISOString() ?? null,
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
    const targetState = requireOAuthTargetState(intent, state);
    const targetConnection = targetState.storeConnectionId !== null
      ? await this.loadOAuthTargetConnection({
          vendorId: vendor.vendorId,
          platform,
          storeConnectionId: targetState.storeConnectionId,
        })
      : null;
    assertOAuthTargetStateMatchesConnection(targetState, targetConnection);

    let grant: DropshipStoreConnectionTokenGrant;
    try {
      grant = await this.deps.oauthProviders[platform].exchangeCode({
        code: input.code,
        shopDomain: state.shopDomain,
        query: input,
      });
    } catch (error) {
      this.deps.logger.error({
        code: error instanceof DropshipError
          ? error.code
          : "DROPSHIP_STORE_OAUTH_PROVIDER_FAILURE",
        message: "Dropship store OAuth provider exchange failed.",
        context: {
          platform,
          intent,
          vendorId: vendor.vendorId,
          storeConnectionId: targetConnection?.storeConnectionId ?? null,
          ...oauthProviderFailureDiagnostics(error),
        },
      });
      throw error;
    }
    this.deps.logger.info({
      code: "DROPSHIP_STORE_OAUTH_IDENTITY_OBSERVED",
      message: "Dropship store OAuth provider identity was read.",
      context: {
        platform,
        intent,
        vendorId: vendor.vendorId,
        storeConnectionId: targetConnection?.storeConnectionId ?? null,
        providerEnvironment: grant.providerEnvironment,
        identityScheme: grant.externalAccountIdentityScheme,
        hasStableAccountId: grant.externalAccountId !== null,
        hasProviderUsername: grant.providerAccountUsername !== null,
        hasDisplayName: grant.externalDisplayName !== null,
      },
    });
    try {
      assertOAuthGrantMatchesIntent({
        intent,
        platform,
        targetConnection,
        grant,
      });
    } catch (error) {
      this.deps.logger.error({
        code: error instanceof DropshipError
          ? error.code
          : "DROPSHIP_STORE_OAUTH_IDENTITY_VALIDATION_FAILED",
        message: "Dropship store OAuth identity validation failed.",
        context: {
          platform,
          intent,
          vendorId: vendor.vendorId,
          storeConnectionId: targetConnection?.storeConnectionId ?? null,
          ...(error instanceof DropshipError ? error.context : {}),
        },
      });
      throw error;
    }
    const persistedIdentity = resolveOAuthGrantIdentityForPersistence({
      intent,
      platform,
      targetConnection,
      grant,
      verifiedAt: now,
    });
    if (
      intent === "change_store"
      && targetConnection
      && hasProviderIdentityDrift({ platform, targetConnection, grant })
      && await this.deps.repository.isMarketplaceIdentityBound(targetConnection.storeConnectionId)
    ) {
      throw marketplaceIdentityBoundError(targetConnection, grant);
    }
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
      externalAccountId: persistedIdentity.externalAccountId,
      providerEnvironment: grant.providerEnvironment,
      externalAccountIdentityScheme: persistedIdentity.externalAccountIdentityScheme,
      externalAccountVerifiedAt: persistedIdentity.externalAccountVerifiedAt,
      externalDisplayName: persistedIdentity.externalDisplayName,
      shopDomain: state.shopDomain,
      accessTokenRef: tokenRecords[0].tokenRef,
      refreshTokenRef: tokenRecords.find((record) => record.tokenKind === "refresh")?.tokenRef ?? null,
      tokenExpiresAt: grant.accessTokenExpiresAt,
      tokenRecords,
      config: {
        tokenMetadata: grant.tokenMetadata ?? {},
        connectedByMemberId: vendor.memberId,
        identityCompatibilityMode: persistedIdentity.compatibilityMode,
        oauthIntent: intent,
      },
      oauthIntent: intent,
      targetStoreConnectionId: targetConnection?.storeConnectionId ?? null,
      expectedTargetConnectionUpdatedAt: targetState.updatedAt,
      connectedAt: now,
    });

    this.deps.logger.info({
      code: "DROPSHIP_STORE_CONNECTED",
      message: "Dropship store connection completed.",
      context: {
        vendorId: vendor.vendorId,
        storeConnectionId: connection.storeConnectionId,
        platform,
        identityCompatibilityMode: persistedIdentity.compatibilityMode,
      },
    });

    connection = await this.runPostConnectSetup({
      connection,
      vendorId: vendor.vendorId,
      storeConnectionId: connection.storeConnectionId,
      platform,
      providerEnvironment: grant.providerEnvironment,
      shopDomain: state.shopDomain,
      accessToken: grant.accessToken,
      connectedAt: now,
    });

    return {
      connection,
      returnTo: state.returnTo,
    };
  }

  resolveOAuthCallbackReturnTo(state: string): string | null {
    return this.deps.stateSigner.verify(state, this.deps.clock.now()).returnTo;
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

  async disconnectForAdmin(input: {
    storeConnectionId: number;
    reason: string;
    idempotencyKey: string;
    actor: {
      actorType: "admin" | "system";
      actorId?: string;
    };
  }): Promise<DropshipStoreConnectionProfile> {
    const disconnectedAt = this.deps.clock.now();
    const connection = await this.deps.repository.disconnectStoreForAdmin({
      storeConnectionId: input.storeConnectionId,
      reason: input.reason,
      disconnectedAt,
      graceEndsAt: calculateDisconnectGraceEndsAt(disconnectedAt, this.disconnectGraceHours),
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
    });

    this.deps.logger.info({
      code: "DROPSHIP_ADMIN_STORE_DISCONNECT_STARTED",
      message: "Admin moved dropship store connection into disconnect grace.",
      context: {
        vendorId: connection.vendorId,
        storeConnectionId: input.storeConnectionId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
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
    storeConnectionId: number;
  }): Promise<DropshipStoreConnectionProfile> {
    const connections = await this.deps.repository.listByVendorId(input.vendorId);
    const target = connections.find((connection) => connection.storeConnectionId === input.storeConnectionId);
    if (
      !target
      || target.platform !== input.platform
      || !isReconnectableOAuthTarget(target)
    ) {
      throw new DropshipError(
        "DROPSHIP_STORE_OAUTH_TARGET_MISMATCH",
        "The selected store connection is no longer available for this authorization.",
        {
          vendorId: input.vendorId,
          platform: input.platform,
          storeConnectionId: input.storeConnectionId,
        },
      );
    }
    return target;
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
        providerEnvironment: input.providerEnvironment,
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

interface OAuthTargetState {
  storeConnectionId: number | null;
  fingerprint: string | null;
  updatedAt: Date | null;
}

function requireOAuthTargetStoreConnectionId(
  intent: DropshipStoreOAuthIntent,
  storeConnectionId: number | undefined,
): number | null {
  if (intent === "connect") {
    if (storeConnectionId !== undefined) {
      throw new DropshipError(
        "DROPSHIP_STORE_OAUTH_TARGET_UNEXPECTED",
        "A new store authorization cannot target an existing store connection.",
        { storeConnectionId },
      );
    }
    return null;
  }
  if (!Number.isInteger(storeConnectionId) || (storeConnectionId ?? 0) <= 0) {
    throw new DropshipError(
      "DROPSHIP_STORE_OAUTH_TARGET_REQUIRED",
      "Choose the exact store connection to refresh or change before starting authorization.",
      { intent },
    );
  }
  return storeConnectionId as number;
}

function requireOAuthTargetState(
  intent: DropshipStoreOAuthIntent,
  state: DropshipOAuthStatePayload,
): OAuthTargetState {
  if (intent === "connect") {
    if (
      state.targetStoreConnectionId != null
      || state.targetConnectionFingerprint != null
      || state.targetConnectionUpdatedAt != null
    ) {
      throw new DropshipError(
        "DROPSHIP_STORE_OAUTH_TARGET_UNEXPECTED",
        "New store authorization state unexpectedly targeted an existing store connection.",
      );
    }
    return { storeConnectionId: null, fingerprint: null, updatedAt: null };
  }

  const storeConnectionId = state.targetStoreConnectionId;
  const fingerprint = state.targetConnectionFingerprint;
  const updatedAt = state.targetConnectionUpdatedAt === null || state.targetConnectionUpdatedAt === undefined
    ? null
    : new Date(state.targetConnectionUpdatedAt);
  if (
    !Number.isInteger(storeConnectionId)
    || (storeConnectionId ?? 0) <= 0
    || typeof fingerprint !== "string"
    || !/^[0-9a-f]{32}$/.test(fingerprint)
    || updatedAt === null
    || Number.isNaN(updatedAt.getTime())
  ) {
    throw new DropshipError(
      "DROPSHIP_STORE_OAUTH_TARGET_REQUIRED",
      "This store authorization did not identify the exact connection to update. Start the authorization again.",
      { intent },
    );
  }
  return { storeConnectionId: storeConnectionId as number, fingerprint, updatedAt };
}

function assertOAuthTargetStateMatchesConnection(
  targetState: OAuthTargetState,
  targetConnection: DropshipStoreConnectionProfile | null,
): void {
  if (targetState.storeConnectionId === null) {
    if (targetConnection !== null) {
      throw new DropshipError(
        "DROPSHIP_STORE_OAUTH_TARGET_MISMATCH",
        "Store authorization target did not match the selected connection.",
      );
    }
    return;
  }
  if (
    targetConnection === null
    || targetConnection.storeConnectionId !== targetState.storeConnectionId
    || oauthTargetConnectionFingerprint(targetConnection) !== targetState.fingerprint
    || targetConnection.updatedAt.getTime() !== targetState.updatedAt?.getTime()
  ) {
    throw new DropshipError(
      "DROPSHIP_STORE_OAUTH_TARGET_CHANGED",
      "The selected store connection changed after authorization started. Start again from the current store card.",
      { storeConnectionId: targetState.storeConnectionId },
    );
  }
}

function isReconnectableOAuthTarget(connection: DropshipStoreConnectionProfile): boolean {
  return ["connected", "needs_reauth", "refresh_failed", "grace_period", "disconnected"].includes(connection.status);
}

function oauthTargetConnectionFingerprint(connection: DropshipStoreConnectionProfile): string {
  return createHash("sha256")
    .update([
      connection.storeConnectionId,
      connection.platform,
      connection.providerEnvironment ?? "",
      connection.externalAccountIdentityScheme ?? "",
      connection.externalAccountId ?? "",
    ].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

function assertOAuthGrantMatchesIntent(input: {
  intent: DropshipStoreOAuthIntent;
  platform: DropshipSupportedStorePlatform;
  targetConnection: DropshipStoreConnectionProfile | null;
  grant: DropshipStoreConnectionTokenGrant;
}): void {
  if (input.intent !== "refresh_connection" || !input.targetConnection) {
    return;
  }

  if (input.targetConnection.platform !== input.platform) {
    throw new DropshipError(
      "DROPSHIP_STORE_OAUTH_PLATFORM_MISMATCH",
      "The authorized marketplace platform did not match the store connection being refreshed.",
      {
        expectedPlatform: input.targetConnection.platform,
        actualPlatform: input.platform,
      },
    );
  }
  if (
    input.targetConnection.providerEnvironment !== null
    && input.grant.providerEnvironment !== input.targetConnection.providerEnvironment
  ) {
    throw new DropshipError(
      "DROPSHIP_STORE_OAUTH_ENVIRONMENT_MISMATCH",
      "The authorized marketplace environment did not match the store connection being refreshed.",
      {
        platform: input.platform,
        expectedProviderEnvironment: input.targetConnection.providerEnvironment,
        actualProviderEnvironment: input.grant.providerEnvironment,
      },
    );
  }
  if (
    input.targetConnection.externalAccountId !== null
    && input.grant.externalAccountId !== input.targetConnection.externalAccountId
  ) {
    throw new DropshipError(
      "DROPSHIP_STORE_OAUTH_ACCOUNT_MISMATCH",
      "The authorized marketplace account did not match the store connection being refreshed.",
      {
        platform: input.platform,
        expectedAccountFingerprint: marketplaceAccountFingerprint({
          platform: input.platform,
          providerEnvironment: input.targetConnection.providerEnvironment,
          identityScheme: input.targetConnection.externalAccountIdentityScheme,
          externalAccountId: input.targetConnection.externalAccountId,
        }),
        actualAccountFingerprint: marketplaceAccountFingerprint({
          platform: input.platform,
          providerEnvironment: input.grant.providerEnvironment,
          identityScheme: input.grant.externalAccountIdentityScheme,
          externalAccountId: input.grant.externalAccountId,
        }),
      },
    );
  }
  if (
    input.targetConnection.externalAccountIdentityScheme !== null
    && input.targetConnection.externalAccountIdentityScheme !== "legacy_username"
    && input.grant.externalAccountIdentityScheme !== input.targetConnection.externalAccountIdentityScheme
  ) {
    throw new DropshipError(
      "DROPSHIP_STORE_OAUTH_IDENTITY_SCHEME_MISMATCH",
      "The authorized marketplace identity scheme did not match the store connection being refreshed.",
      {
        platform: input.platform,
        expectedIdentityScheme: input.targetConnection.externalAccountIdentityScheme,
        actualIdentityScheme: input.grant.externalAccountIdentityScheme,
      },
    );
  }
}

function marketplaceAccountFingerprint(input: {
  platform: DropshipSupportedStorePlatform;
  providerEnvironment: string | null;
  identityScheme: string | null;
  externalAccountId: string | null;
}): string | null {
  if (input.externalAccountId === null) return null;
  return createHash("sha256")
    .update([
      input.platform,
      input.providerEnvironment ?? "",
      input.identityScheme ?? "",
      input.externalAccountId,
    ].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

interface PersistedOAuthIdentity {
  externalAccountId: string | null;
  externalAccountIdentityScheme: "provider_user_id" | null;
  externalAccountVerifiedAt: Date | null;
  externalDisplayName: string | null;
  compatibilityMode: "stable_provider_identity" | "legacy_username_refresh";
}

function resolveOAuthGrantIdentityForPersistence(input: {
  intent: DropshipStoreOAuthIntent;
  platform: DropshipSupportedStorePlatform;
  targetConnection: DropshipStoreConnectionProfile | null;
  grant: DropshipStoreConnectionTokenGrant;
  verifiedAt: Date;
}): PersistedOAuthIdentity {
  if (
    input.grant.externalAccountIdentityScheme === "provider_user_id"
    && typeof input.grant.externalAccountId === "string"
    && input.grant.externalAccountId.trim() !== ""
  ) {
    return {
      externalAccountId: input.grant.externalAccountId,
      externalAccountIdentityScheme: "provider_user_id",
      externalAccountVerifiedAt: input.verifiedAt,
      externalDisplayName: input.grant.externalDisplayName,
      compatibilityMode: "stable_provider_identity",
    };
  }

  const isUsernameOnlyEbayGrant = input.platform === "ebay"
    && input.grant.externalAccountId === null
    && input.grant.externalAccountIdentityScheme === null
    && typeof input.grant.providerAccountUsername === "string"
    && input.grant.providerAccountUsername.trim() !== "";
  if (!isUsernameOnlyEbayGrant) {
    throw stableMarketplaceAccountIdRequired(input.platform);
  }

  const target = input.targetConnection;
  const isLegacyRefreshTarget = input.intent === "refresh_connection"
    && target !== null
    && target.platform === "ebay"
    && target.externalAccountId === null
    && (target.externalAccountIdentityScheme === null || target.externalAccountIdentityScheme === "legacy_username");
  if (!isLegacyRefreshTarget) {
    throw stableMarketplaceAccountIdRequired(input.platform);
  }

  const expectedUsername = target.externalDisplayName?.trim() ?? "";
  const observedAccountNames = [
    input.grant.providerAccountUsername,
    input.grant.externalDisplayName,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim());
  if (expectedUsername === "" || !observedAccountNames.includes(expectedUsername)) {
    throw new DropshipError(
      "DROPSHIP_STORE_OAUTH_LEGACY_ACCOUNT_MISMATCH",
      "The authorized eBay account did not match the legacy store connection being refreshed.",
      {
        storeConnectionId: target.storeConnectionId,
        hasExpectedUsername: expectedUsername !== "",
        accountNamesMatch: false,
        retryable: false,
      },
    );
  }

  return {
    // A username is not promoted to stable marketplace identity evidence. The
    // existing legacy connection can receive fresh credentials, while listing
    // registration continues to require a later provider_user_id observation.
    externalAccountId: null,
    externalAccountIdentityScheme: null,
    externalAccountVerifiedAt: null,
    externalDisplayName: target.externalDisplayName,
    compatibilityMode: "legacy_username_refresh",
  };
}

function stableMarketplaceAccountIdRequired(platform: DropshipSupportedStorePlatform): DropshipError {
  return new DropshipError(
    platform === "ebay"
      ? "DROPSHIP_EBAY_STABLE_ACCOUNT_ID_REQUIRED"
      : "DROPSHIP_STORE_STABLE_ACCOUNT_ID_REQUIRED",
    `${platform === "ebay" ? "eBay" : "The marketplace"} did not return the stable provider account ID required to identify this seller account.`,
    { platform, retryable: false },
  );
}

function oauthProviderFailureDiagnostics(error: unknown): Record<string, unknown> {
  if (!(error instanceof DropshipError)) {
    return {
      errorType: error instanceof Error ? error.name : typeof error,
    };
  }

  const context = error.context ?? {};
  return {
    providerHttpStatus: typeof context.status === "number" ? context.status : null,
    retryable: typeof context.retryable === "boolean" ? context.retryable : null,
    hasProviderUsername: typeof context.hasUsername === "boolean" ? context.hasUsername : null,
  };
}

function hasProviderIdentityDrift(input: {
  platform: DropshipSupportedStorePlatform;
  targetConnection: DropshipStoreConnectionProfile;
  grant: DropshipStoreConnectionTokenGrant;
}): boolean {
  return input.targetConnection.platform !== input.platform
    || input.targetConnection.providerEnvironment !== input.grant.providerEnvironment
    || input.targetConnection.externalAccountId !== input.grant.externalAccountId
    || input.targetConnection.externalAccountIdentityScheme !== input.grant.externalAccountIdentityScheme;
}

function marketplaceIdentityBoundError(
  connection: DropshipStoreConnectionProfile,
  grant: DropshipStoreConnectionTokenGrant,
): DropshipError {
  return new DropshipError(
    "DROPSHIP_STORE_MARKETPLACE_IDENTITY_BOUND",
    "This store connection is registered to marketplace listings and cannot be changed to a different seller account. Create a separate store connection after removing or migrating those registrations.",
    {
      storeConnectionId: connection.storeConnectionId,
      platform: connection.platform,
      currentProviderEnvironment: connection.providerEnvironment,
      requestedProviderEnvironment: grant.providerEnvironment,
      currentExternalAccountId: connection.externalAccountId,
      requestedExternalAccountId: grant.externalAccountId,
      currentIdentityScheme: connection.externalAccountIdentityScheme,
      requestedIdentityScheme: grant.externalAccountIdentityScheme,
      retryable: false,
    },
  );
}

function requireIdentityText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new DropshipError(
      "DROPSHIP_STORE_IDENTITY_CLAIM_INVALID",
      `${field} must contain between 1 and ${maxLength} characters.`,
      { field },
    );
  }
  return normalized;
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
