import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { buildDropshipEbayProviderAccountEvidenceHash, DropshipMarketplaceRegistrationAccountClaimer } from "../../application/dropship-marketplace-registration-account-claimer";
import {
  DropshipMarketplaceRegistrationOwnerReader,
  type DropshipMarketplaceRegistrationOwnerRepository,
} from "../../application/dropship-marketplace-registration-owner-reader";
import type { DropshipStoreConnectionProfile } from "../../application/dropship-store-connection-service";
import { DropshipError } from "../../domain/errors";
import {
  FetchEbayRegistrationReadTransport,
} from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";
import {
  DropshipEbayRegistrationCredentialAdapter,
} from "../../infrastructure/dropship-ebay-registration-credential-adapter";
import {
  RefreshingDropshipEbayRegistrationCredentialProvider,
  type DropshipEbayRegistrationCredentialProvider,
} from "../../infrastructure/dropship-ebay-registration-credentials";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "../../infrastructure/dropship-marketplace-credentials";
import { PgDropshipMarketplaceRegistrationOwnerRepository } from "../../infrastructure/dropship-marketplace-registration-owner.repository";
import { PgDropshipStoreConnectionRepository } from "../../infrastructure/dropship-store-connection.repository";
import type { ListingOwnerRef } from "../../../marketplace-listings/domain/listing-replacement-plan";

const observedAt = new Date("2026-08-04T14:00:00.000Z");
const owner: Extract<ListingOwnerRef, { kind: "dropship" }> = {
  kind: "dropship",
  storeConnectionId: 21,
  productId: 70,
  provider: "ebay",
  marketplaceId: "EBAY_US",
};

describe("DropshipMarketplaceRegistrationOwnerReader", () => {
  it("returns every product variant, including inactive and zero-quantity members", async () => {
    const repository: DropshipMarketplaceRegistrationOwnerRepository = {
      loadStoreConnection: vi.fn(async () => ({
        id: 21,
        vendorId: 10,
        platform: "ebay",
        status: "connected",
        marketplaceIds: ["EBAY_US"],
      })),
      loadProductAccess: vi.fn(async () => ({
        vendorId: 10,
        productId: 70,
        canList: true,
      })),
      loadAllProductVariants: vi.fn(async () => [
        {
          id: 702,
          productId: 70,
          sku: "ARM-ENV-SGL-C700",
          isActive: false,
          availableQuantity: 0,
        },
        {
          id: 701,
          productId: 70,
          sku: "ARM-ENV-SGL-C750",
          isActive: true,
          availableQuantity: 505,
        },
      ]),
    };

    const snapshot = await new DropshipMarketplaceRegistrationOwnerReader(
      repository,
    ).loadRegistrationSnapshot(owner);

    expect(snapshot).toEqual({
      owner,
      memberCandidates: [
        {
          productVariantId: 701,
          sku: "ARM-ENV-SGL-C750",
          isActive: true,
          availableQuantity: 505,
        },
        {
          productVariantId: 702,
          sku: "ARM-ENV-SGL-C700",
          isActive: false,
          availableQuantity: 0,
        },
      ],
    });
    expect(repository.loadAllProductVariants).toHaveBeenCalledWith({
      storeConnectionId: 21,
      productId: 70,
    });
  });

  it("rejects a product that is not listable by the connection vendor", async () => {
    const repository: DropshipMarketplaceRegistrationOwnerRepository = {
      loadStoreConnection: async () => ({
        id: 21,
        vendorId: 10,
        platform: "ebay",
        status: "connected",
        marketplaceIds: ["EBAY_US"],
      }),
      loadProductAccess: async () => ({
        vendorId: 10,
        productId: 70,
        canList: false,
      }),
      loadAllProductVariants: async () => [{
        id: 701,
        productId: 70,
        sku: "ARM-ENV-SGL-C750",
        isActive: true,
        availableQuantity: 505,
      }],
    };

    await expect(
      new DropshipMarketplaceRegistrationOwnerReader(repository)
        .loadRegistrationSnapshot(owner),
    ).rejects.toMatchObject({
      code: "DROPSHIP_MARKETPLACE_REGISTRATION_PRODUCT_ACCESS_DENIED",
    });
  });
});

describe("PgDropshipMarketplaceRegistrationOwnerRepository", () => {
  it("authorizes an existing owner association and derives ATP for every active or archived variant", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const release = vi.fn();
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized.includes("FROM dropship.dropship_store_connections sc")) {
        return { rows: [{
          id: 21,
          vendor_id: 10,
          platform: "ebay",
          status: "connected",
          connection_config: { marketplaceId: "EBAY_US" },
          marketplace_config: { marketplaceIds: ["EBAY_CA", "EBAY_US"] },
        }] };
      }
      if (normalized.includes("AS can_list")) {
        return { rows: [{ product_id: 70, can_list: true }] };
      }
      if (normalized.includes("FROM catalog.product_variants pv")) {
        return { rows: [
          {
            id: 701,
            product_id: 70,
            sku: "ARM-ENV-SGL-C750",
            is_active: true,
            units_per_variant: 750,
          },
          {
            id: 702,
            product_id: 70,
            sku: "ARM-ENV-SGL-C700",
            is_active: false,
            units_per_variant: 700,
          },
          {
            id: 703,
            product_id: 70,
            sku: "ARM-ENV-SGL-P50",
            is_active: true,
            units_per_variant: 50,
          },
        ] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    });
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;
    const atp = {
      getBaseAtpByProductIds: vi.fn(async () => new Map([[70, 500]])),
    };
    const repository = new PgDropshipMarketplaceRegistrationOwnerRepository(
      atp,
      pool,
    );

    const connection = await repository.loadStoreConnection(21);
    const access = await repository.loadProductAccess({
      vendorId: 10,
      storeConnectionId: 21,
      productId: 70,
    });
    const variants = await repository.loadAllProductVariants({
      storeConnectionId: 21,
      productId: 70,
    });

    expect(connection).toMatchObject({
      id: 21,
      vendorId: 10,
      platform: "ebay",
      status: "connected",
      marketplaceIds: ["EBAY_CA", "EBAY_US"],
    });
    expect(access).toEqual({ vendorId: 10, productId: 70, canList: true });
    expect(variants).toEqual([
      { id: 701, productId: 70, sku: "ARM-ENV-SGL-C750", isActive: true, availableQuantity: 0 },
      { id: 702, productId: 70, sku: "ARM-ENV-SGL-C700", isActive: false, availableQuantity: 0 },
      { id: 703, productId: 70, sku: "ARM-ENV-SGL-P50", isActive: true, availableQuantity: 10 },
    ]);
    expect(atp.getBaseAtpByProductIds).toHaveBeenCalledWith([70]);
    const accessQuery = queries.find((entry) => entry.sql.includes("AS can_list"));
    expect(accessQuery?.params).toEqual([10, 21, 70]);
    expect(accessQuery?.sql).not.toContain("dvl.status");
    const variantsQuery = queries.find((entry) => entry.sql.includes("FROM catalog.product_variants pv"));
    expect(variantsQuery?.sql).not.toContain("pv.is_active = true");
    expect(release).toHaveBeenCalledTimes(3);
  });
});

describe("FetchEbayRegistrationReadTransport", () => {
  it("issues GET-only eBay API reads with scoped headers and rejects off-domain paths", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      userId: "seller-account-123",
    }), { status: 200 }));
    const transport = new FetchEbayRegistrationReadTransport(
      fetchFn as unknown as typeof fetch,
    );

    const result = await transport.get({
      environment: "sandbox",
      path: "/commerce/identity/v1/user/",
      accessToken: "access-token",
      marketplaceId: "EBAY_US",
    });

    expect(result).toEqual({
      status: 200,
      body: { userId: "seller-account-123" },
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://apiz.sandbox.ebay.com/commerce/identity/v1/user/",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
        headers: {
          Authorization: "Bearer access-token",
          Accept: "application/json",
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
      }),
    );

    await expect(transport.get({
      environment: "sandbox",
      path: "//attacker.example/steal-token",
      accessToken: "access-token",
      marketplaceId: null,
    })).rejects.toMatchObject({
      code: "EBAY_REGISTRATION_READ_PATH_INVALID",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("RefreshingDropshipEbayRegistrationCredentialProvider", () => {
  it("refreshes an expired access token before registration reads and persists only credential maintenance", async () => {
    const expired = makeCredentials({
      accessToken: "expired-access-token",
      accessTokenExpiresAt: new Date("2026-08-04T13:00:00.000Z"),
    });
    const refreshed = makeCredentials({
      accessToken: "fresh-access-token",
      accessTokenExpiresAt: new Date("2026-08-04T15:00:00.000Z"),
    });
    const replaceTokens = vi.fn(async () => refreshed);
    const repository: DropshipMarketplaceCredentialRepository = {
      loadForStoreConnection: vi.fn(async () => expired),
      replaceTokens,
    };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      access_token: "fresh-access-token",
      expires_in: 3600,
    }), { status: 200 }));
    const provider = new RefreshingDropshipEbayRegistrationCredentialProvider(
      repository,
      { clientId: "client-id", clientSecret: "client-secret" },
      fetchFn as unknown as typeof fetch,
      { now: () => observedAt },
    );

    const result = await provider.loadFreshForStoreConnection({
      vendorId: 10,
      storeConnectionId: 21,
    });

    expect(result.accessToken).toBe("fresh-access-token");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(replaceTokens).toHaveBeenCalledWith({
      vendorId: 10,
      storeConnectionId: 21,
      platform: "ebay",
      accessToken: "fresh-access-token",
      refreshToken: null,
      accessTokenExpiresAt: new Date("2026-08-04T15:00:00.000Z"),
      now: observedAt,
    });
  });
});

describe("DropshipEbayRegistrationCredentialAdapter", () => {
  it("loads a fresh credential only after revalidating the Dropship owner boundary", async () => {
    const loadFreshForStoreConnection = vi.fn(async () => makeCredentials());
    const adapter = new DropshipEbayRegistrationCredentialAdapter(
      {
        loadStoreConnection: vi.fn(async () => ({
          id: 21,
          vendorId: 10,
          platform: "ebay",
          status: "connected",
          marketplaceIds: ["EBAY_US"],
        })),
      },
      { loadFreshForStoreConnection },
    );

    await expect(adapter.loadFreshCredential(owner)).resolves.toEqual({
      accessToken: "access-token",
      environment: "sandbox",
    });
    expect(loadFreshForStoreConnection).toHaveBeenCalledWith({
      vendorId: 10,
      storeConnectionId: 21,
    });
  });

  it("does not load secrets for an unconfigured marketplace", async () => {
    const loadFreshForStoreConnection = vi.fn(async () => makeCredentials());
    const adapter = new DropshipEbayRegistrationCredentialAdapter(
      {
        loadStoreConnection: vi.fn(async () => ({
          id: 21,
          vendorId: 10,
          platform: "ebay",
          status: "connected",
          marketplaceIds: ["EBAY_CA"],
        })),
      },
      { loadFreshForStoreConnection },
    );

    await expect(adapter.loadFreshCredential(owner)).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_REGISTRATION_MARKETPLACE_MISMATCH",
    });
    expect(loadFreshForStoreConnection).not.toHaveBeenCalled();
  });
});

describe("DropshipMarketplaceRegistrationAccountClaimer", () => {
  it("maps the account namespace into an idempotent owner identity claim", async () => {
    const claimObservedProviderAccount = vi.fn(async () => ({
      claimed: true,
      connection: makeConnection({
        externalAccountId: "seller-account-123",
        providerEnvironment: "sandbox",
        externalAccountIdentityScheme: "provider_user_id",
        externalAccountVerifiedAt: observedAt,
      }),
    }));
    const claimer = new DropshipMarketplaceRegistrationAccountClaimer({
      claimObservedProviderAccount,
    });

    const result = await claimer.claimStableProviderAccount({
      owner,
      providerAccount: {
        provider: "ebay",
        accountNamespace: "sandbox",
        externalAccountId: "seller-account-123",
        identityScheme: "provider_user_id",
        externalDisplayNameSnapshot: "seller-login",
        evidenceHash: buildDropshipEbayProviderAccountEvidenceHash({
          providerEnvironment: "sandbox", externalAccountId: "seller-account-123",
        }),
      },
      idempotencyKey: "registration:21:70",
      observationHash: "a".repeat(64),
      observedAt,
      requestedBy: { type: "user", id: "member-1" },
      correlationId: "correlation-1",
    });

    expect(claimObservedProviderAccount).toHaveBeenCalledWith({
      storeConnectionId: 21,
      platform: "ebay",
      providerEnvironment: "sandbox",
      externalAccountId: "seller-account-123",
      externalAccountIdentityScheme: "provider_user_id",
      observedAt,
      idempotencyKey: "registration:21:70",
      observationHash: "a".repeat(64),
      correlationId: "correlation-1",
      actor: { actorType: "user", actorId: "member-1" },
    });
    expect(result).toMatchObject({
      kind: "claimed",
      owner,
      provider: "ebay",
      accountNamespace: "sandbox",
      externalAccountId: "seller-account-123",
      identityScheme: "provider_user_id",
      verifiedAt: observedAt,
    });
  });
});

describe("PgDropshipStoreConnectionRepository provider identity claim", () => {
  it("upgrades an unbound legacy username inside one transaction and records a durable owner claim audit", async () => {
    const existing = makeStoreConnectionRow({
      external_account_id: "legacy-seller-login",
      provider_environment: null,
      external_account_identity_scheme: "legacy_username",
      external_account_verified_at: null,
    });
    const updated = makeStoreConnectionRow({
      external_account_id: "seller-account-123",
      provider_environment: "sandbox",
      external_account_identity_scheme: "provider_user_id",
      external_account_verified_at: observedAt,
      updated_at: observedAt,
    });
    const { repository, queries, release } = makeClaimRepository({
      existing,
      marketplaceIdentityBound: false,
      updated,
    });

    const result = await repository.claimObservedProviderAccount(
      makeRepositoryClaimInput(),
    );

    expect(result).toMatchObject({
      claimed: true,
      connection: {
        storeConnectionId: 21,
        externalAccountId: "seller-account-123",
        providerEnvironment: "sandbox",
        externalAccountIdentityScheme: "provider_user_id",
        externalAccountVerifiedAt: observedAt,
      },
    });
    const statements = queries.map((query) => query.sql);
    expect(statements[0]).toBe("BEGIN");
    expect(statements.some((sql) => sql.includes("FOR UPDATE"))).toBe(true);
    expect(statements.some((sql) => sql.includes("marketplace.dropship_listing_scopes"))).toBe(true);
    expect(statements.some((sql) => sql.includes("UPDATE dropship.dropship_store_connections"))).toBe(true);
    const audit = queries.find((query) => query.sql.includes("dropship.dropship_audit_events"));
    expect(audit).toBeDefined();
    expect(JSON.parse(String(audit?.params[7]))).toMatchObject({
      classification: "durable_owner_identity_claim",
      idempotencyKey: "registration:21:70",
      observationHash: "a".repeat(64),
      previousIdentityScheme: "legacy_username",
      identityScheme: "provider_user_id",
    });
    expect(statements.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("refreshes and audits an older verification timestamp for the same stable account", async () => {
    const previousVerification = new Date("2026-08-01T12:00:00.000Z");
    const existing = makeStoreConnectionRow({
      external_account_id: "seller-account-123",
      provider_environment: "sandbox",
      external_account_identity_scheme: "provider_user_id",
      external_account_verified_at: previousVerification,
    });
    const updated = makeStoreConnectionRow({
      external_account_id: "seller-account-123",
      provider_environment: "sandbox",
      external_account_identity_scheme: "provider_user_id",
      external_account_verified_at: observedAt,
      updated_at: observedAt,
    });
    const { repository, queries } = makeClaimRepository({
      existing,
      marketplaceIdentityBound: true,
      updated,
    });

    const result = await repository.claimObservedProviderAccount(
      makeRepositoryClaimInput(),
    );

    expect(result).toMatchObject({
      claimed: true,
      connection: { externalAccountVerifiedAt: observedAt },
    });
    const update = queries.find((query) => query.sql.includes("UPDATE dropship.dropship_store_connections"));
    expect(update?.sql).toContain("external_account_verified_at = $5");
    const audit = queries.find((query) => query.sql.includes("dropship.dropship_audit_events"));
    expect(audit?.params[3]).toBe("store_connection_provider_account_verified");
    expect(JSON.parse(String(audit?.params[7]))).toMatchObject({
      classification: "durable_owner_identity_verification_refresh",
      previousExternalAccountId: "seller-account-123",
      externalAccountId: "seller-account-123",
    });
    expect(queries.at(-1)?.sql).toBe("COMMIT");
  });

  it("does not write when an exact stable account claim is replayed", async () => {
    const existing = makeStoreConnectionRow({
      external_account_id: "seller-account-123",
      provider_environment: "sandbox",
      external_account_identity_scheme: "provider_user_id",
      external_account_verified_at: observedAt,
    });
    const { repository, queries } = makeClaimRepository({
      existing,
      marketplaceIdentityBound: true,
      updated: existing,
    });

    const result = await repository.claimObservedProviderAccount(
      makeRepositoryClaimInput(),
    );

    expect(result.claimed).toBe(false);
    expect(queries.some((query) => query.sql.includes("UPDATE dropship.dropship_store_connections"))).toBe(false);
    expect(queries.some((query) => query.sql.includes("dropship_store_connection_audit"))).toBe(false);
    expect(queries.at(-1)?.sql).toBe("COMMIT");
  });

  it("rolls back a different stable account claim after the same-transaction binding check", async () => {
    const existing = makeStoreConnectionRow({
      external_account_id: "seller-account-original",
      provider_environment: "sandbox",
      external_account_identity_scheme: "provider_user_id",
      external_account_verified_at: observedAt,
    });
    const { repository, queries } = makeClaimRepository({
      existing,
      marketplaceIdentityBound: true,
      updated: existing,
    });

    await expect(repository.claimObservedProviderAccount(
      makeRepositoryClaimInput(),
    )).rejects.toMatchObject({
      code: "DROPSHIP_STORE_MARKETPLACE_IDENTITY_BOUND",
    } satisfies Partial<DropshipError>);

    expect(queries.some((query) => query.sql.includes("FOR UPDATE"))).toBe(true);
    expect(queries.some((query) => query.sql.includes("marketplace.dropship_listing_scopes"))).toBe(true);
    expect(queries.some((query) => query.sql.includes("UPDATE dropship.dropship_store_connections"))).toBe(false);
    expect(queries.at(-1)?.sql).toBe("ROLLBACK");
  });
});

function makeCredentials(
  overrides: Partial<DropshipMarketplaceStoreCredentials> = {},
): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 10,
    storeConnectionId: 21,
    platform: "ebay",
    status: "connected",
    shopDomain: null,
    externalAccountId: "legacy-seller-login",
    providerEnvironment: "sandbox",
    externalAccountIdentityScheme: "legacy_username",
    externalAccountVerifiedAt: null,
    externalDisplayName: "Legacy Seller",
    config: {},
    accessToken: "access-token",
    accessTokenRef: "access-ref",
    accessTokenExpiresAt: null,
    refreshToken: "refresh-token",
    refreshTokenRef: "refresh-ref",
    refreshTokenExpiresAt: null,
    ...overrides,
  };
}

function makeConnection(
  overrides: Partial<DropshipStoreConnectionProfile> = {},
): DropshipStoreConnectionProfile {
  return {
    storeConnectionId: 21,
    vendorId: 10,
    platform: "ebay",
    externalAccountId: "seller-account-123",
    providerEnvironment: "sandbox",
    externalAccountIdentityScheme: "provider_user_id",
    externalAccountVerifiedAt: observedAt,
    externalDisplayName: "Seller",
    shopDomain: null,
    status: "connected",
    setupStatus: "ready",
    disconnectReason: null,
    disconnectedAt: null,
    graceEndsAt: null,
    tokenExpiresAt: null,
    hasAccessToken: true,
    hasRefreshToken: true,
    launchReady: true,
    lastSyncAt: null,
    lastOrderSyncAt: null,
    lastInventorySyncAt: null,
    orderProcessingConfig: { defaultWarehouseId: null },
    createdAt: observedAt,
    updatedAt: observedAt,
    ...overrides,
  };
}

function makeStoreConnectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 21,
    vendor_id: 10,
    platform: "ebay",
    external_account_id: "seller-account-123",
    provider_environment: "sandbox",
    external_account_identity_scheme: "provider_user_id",
    external_account_verified_at: observedAt,
    external_display_name: "Seller",
    shop_domain: null,
    access_token_ref: "access-ref",
    refresh_token_ref: "refresh-ref",
    token_expires_at: null,
    status: "connected",
    setup_status: "ready",
    disconnect_reason: null,
    disconnected_at: null,
    grace_ends_at: null,
    last_sync_at: null,
    last_order_sync_at: null,
    last_inventory_sync_at: null,
    config: {},
    created_at: observedAt,
    updated_at: observedAt,
    ...overrides,
  };
}

function makeRepositoryClaimInput() {
  return {
    storeConnectionId: 21,
    platform: "ebay" as const,
    providerEnvironment: "sandbox",
    externalAccountId: "seller-account-123",
    externalAccountIdentityScheme: "provider_user_id" as const,
    observedAt,
    idempotencyKey: "registration:21:70",
    observationHash: "a".repeat(64),
    correlationId: "correlation-1",
    actor: { actorType: "user" as const, actorId: "member-1" },
  };
}

function makeClaimRepository(input: {
  existing: ReturnType<typeof makeStoreConnectionRow>;
  marketplaceIdentityBound: boolean;
  updated: ReturnType<typeof makeStoreConnectionRow>;
}) {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    queries.push({ sql: normalized, params });
    if (normalized.includes("FROM dropship.dropship_store_connections") && normalized.includes("FOR UPDATE")) {
      return { rows: [input.existing] };
    }
    if (normalized.includes("marketplace.dropship_listing_scopes")) {
      return { rows: [{ value: input.marketplaceIdentityBound }] };
    }
    if (normalized.startsWith("UPDATE dropship.dropship_store_connections")) {
      return { rows: [input.updated] };
    }
    return { rows: [] };
  });
  const connect = vi.fn(async () => ({ query, release }));
  const repository = new PgDropshipStoreConnectionRepository({
    connect,
  } as unknown as Pool);
  return { repository, queries, release };
}
