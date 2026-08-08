import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";

import type {
  PersistListingRegistrationInput,
  PersistVerifiedListingInput,
} from "../../application/registration-ports";
import {
  buildListingRegistrationPlan,
  type ListingRegistrationPlan,
} from "../../domain/listing-registration-plan";
import type { ListingOwnerRef } from "../../domain/listing-replacement-plan";
import { PgMarketplaceListingRegistrationRepository } from "../../infrastructure/pg-listing-registration.repository";

describe("PgMarketplaceListingRegistrationRepository", () => {
  it("loads the current active publication and registration receipt for a Channel owner", async () => {
    const owner = persistenceInput().plan.owner;
    const poolQuery = vi.fn(async () => result([currentStatusRow(owner)]));
    const repository = new PgMarketplaceListingRegistrationRepository({
      query: poolQuery,
    } as unknown as Pool);

    await expect(repository.findCurrentRegistration(owner)).resolves.toEqual({
      status: "registered",
      productId: 33,
      registrationId: 40,
      scopeId: 10,
      providerAccountId: 20,
      publicationId: 31,
      providerPublicationKey: "ARM-ENV-SGL-V3",
      externalListingId: "listing-456",
      registeredVariantIds: [501, 502],
      registeredVariants: [{
        productVariantId: 501,
        sku: "ARM-ENV-SGL-C700",
        disposition: "included",
      }],
      registeredAt: new Date("2026-08-04T12:00:02.000Z"),
    });
    const [sql, params] = poolQuery.mock.calls[0] ?? [];
    expect(sql).toContain("marketplace.channel_listing_scopes");
    expect(sql).toContain("publication.status = 'active'");
    expect(sql).toContain("FROM marketplace.listing_publication_members AS member");
    expect(sql).toContain("marketplace.listing_verification_snapshots");
    expect(sql).toContain("snapshot.source_publication_id = publication.id");
    expect(sql).toContain("member.disposition = 'included'");
    expect(params).toEqual(["channel", "ebay", "EBAY_US", 7, [33]]);
  });

  it("uses the same provider-neutral status contract for a Dropship owner", async () => {
    const owner: ListingOwnerRef = {
      kind: "dropship",
      storeConnectionId: 19,
      productId: 33,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    };
    const poolQuery = vi.fn(async () => result([currentStatusRow(owner)]));
    const repository = new PgMarketplaceListingRegistrationRepository({
      query: poolQuery,
    } as unknown as Pool);

    await expect(
      repository.findCurrentRegistration(owner),
    ).resolves.toMatchObject({ status: "registered", publicationId: 31 });
    const [sql, params] = poolQuery.mock.calls[0] ?? [];
    expect(sql).toContain("marketplace.dropship_listing_scopes");
    expect(params).toEqual(["dropship", "ebay", "EBAY_US", 19, [33]]);
  });

  it("loads multiple product statuses with one owner-scoped query", async () => {
    const firstOwner = persistenceInput().plan.owner;
    const secondOwner = { ...firstOwner, productId: 44 };
    const poolQuery = vi.fn(async () =>
      result([
        currentStatusRow(secondOwner),
        currentStatusRow(firstOwner),
      ]),
    );
    const repository = new PgMarketplaceListingRegistrationRepository({
      query: poolQuery,
    } as unknown as Pool);

    await expect(
      repository.findCurrentRegistrations([firstOwner, secondOwner]),
    ).resolves.toEqual([
      expect.objectContaining({ productId: 44 }),
      expect.objectContaining({ productId: 33 }),
    ]);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0] ?? [];
    expect(sql).toContain("scope.product_id = ANY($5::INTEGER[])");
    expect(params).toEqual([
      "channel", "ebay", "EBAY_US", 7, [33, 44],
    ]);
  });

  it("returns null when the owner has no registration receipt", async () => {
    const owner = persistenceInput().plan.owner;
    const row = currentStatusRow(owner);
    const poolQuery = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ ...row, registration_id: null }]));
    const repository = new PgMarketplaceListingRegistrationRepository({
      query: poolQuery,
    } as unknown as Pool);

    await expect(repository.findCurrentRegistration(owner)).resolves.toBeNull();
    await expect(repository.findCurrentRegistration(owner)).resolves.toBeNull();
  });

  it("rejects multiple current registration rows as database contract drift", async () => {
    const owner = persistenceInput().plan.owner;
    const row = currentStatusRow(owner);
    const repository = new PgMarketplaceListingRegistrationRepository({
      query: vi.fn(async () => result([row, row])),
    } as unknown as Pool);

    await expect(repository.findCurrentRegistration(owner)).rejects.toMatchObject(
      {
        code: "MARKETPLACE_LISTING_REGISTRATION_DATABASE_CONTRACT_ERROR",
      },
    );
  });

  it("rejects a receipt whose current active publication or account link is incomplete", async () => {
    const owner = persistenceInput().plan.owner;
    const row = currentStatusRow(owner);
    const repository = new PgMarketplaceListingRegistrationRepository({
      query: vi.fn(async () =>
        result([
          {
            ...row,
            publication_id: null,
            publication_scope_id: null,
            publication_status: null,
          },
        ]),
      ),
    } as unknown as Pool);

    await expect(repository.findCurrentRegistration(owner)).rejects.toMatchObject(
      {
        code: "MARKETPLACE_LISTING_REGISTRATION_DATABASE_CONTRACT_ERROR",
      },
    );
  });

  it("persists a verified existing listing snapshot and all observed members atomically", async () => {
    const registrationInput = persistenceInput();
    const input: PersistVerifiedListingInput = {
      plan: registrationInput.plan,
      verifiedAt: new Date("2026-08-04T12:00:02.000Z"),
    };
    const queries: string[] = [];
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (
        sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SET LOCAL") ||
        sql.startsWith("SET CONSTRAINTS")
      ) return result([]);
      if (sql.includes("FROM catalog.product_variants")) {
        return result([
          { id: 11, sku: "ARM-ENV-SGL-C750", is_active: false },
          { id: 12, sku: "ARM-ENV-SGL-C700", is_active: false },
        ]);
      }
      if (sql.includes("FROM marketplace.listing_scopes AS scope")) {
        return result([{
          id: 10,
          owner_kind: "channel",
          provider: "ebay",
          marketplace_id: "EBAY_US",
          product_id: 33,
          channel_id: 7,
          store_connection_id: null,
        }]);
      }
      if (sql.includes("FROM marketplace.listing_verification_snapshots") && sql.includes("idempotency_key")) {
        return result([]);
      }
      if (sql.includes("FROM marketplace.listing_scope_provider_accounts AS binding")) {
        return result([{
          id: 20,
          owner_kind: "channel",
          channel_id: 7,
          store_connection_id: null,
          provider: "ebay",
          account_namespace: "production",
          external_account_id: "provider-user-123",
          identity_scheme: "provider_user_id",
        }]);
      }
      if (sql.includes("FROM marketplace.listing_publications") && sql.includes("status = 'active'")) {
        return result([{ id: 30, external_listing_id: "listing-old" }]);
      }
      if (sql.includes("INSERT INTO marketplace.listing_verification_snapshots")) {
        return result([{ id: 50 }]);
      }
      if (sql.includes("INSERT INTO marketplace.listing_verification_members")) {
        return result([], input.plan.members.length);
      }
      throw new Error(`Unexpected verification SQL: ${sql}`);
    });
    const repository = new PgMarketplaceListingRegistrationRepository({
      connect: vi.fn(async () => ({ query, release }) as unknown as PoolClient),
    } as unknown as Pool);

    await expect(repository.verifyExistingPublication(input)).resolves.toEqual({
      kind: "adopted_replacement",
      publicationId: 30,
      externalListingId: "listing-123",
      verifiedAt: input.verifiedAt,
    });
    expect(queryIndex(queries, "FROM catalog.product_variants")).toBeLessThan(
      queryIndex(queries, "INSERT INTO marketplace.listing_verification_snapshots"),
    );
    expect(queryIndex(queries, "INSERT INTO marketplace.listing_verification_snapshots")).toBeLessThan(
      queryIndex(queries, "INSERT INTO marketplace.listing_verification_members"),
    );
    expect(queries.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalledWith(false);
  });

  it("imports an observed listing in one transaction after owner and global identity locks", async () => {
    const input = persistenceInput();
    const queries: string[] = [];
    const client = scriptedClient(input, queries);
    const connect = vi.fn(async () => client);
    const repository = new PgMarketplaceListingRegistrationRepository({
      connect,
    } as unknown as Pool);

    const result = await repository.registerOrReplay(input);

    expect(result).toMatchObject({
      kind: "created",
      receipt: {
        registrationId: 40,
        scopeId: 10,
        providerAccountId: 20,
        publicationId: 30,
        requestHash: input.plan.requestHash,
      },
    });
    expect(queryIndex(queries, "FROM channels.channels")).toBeLessThan(
      queryIndex(queries, "pg_advisory_xact_lock"),
    );
    expect(queryIndex(queries, "pg_advisory_xact_lock")).toBeLessThan(
      queryIndex(queries, "INSERT INTO marketplace.listing_scopes"),
    );
    const advisoryLockCall = vi.mocked(client.query).mock.calls.find(
      ([sql]) => String(sql).includes("pg_advisory_xact_lock"),
    );
    expect(advisoryLockCall?.[1]).toEqual([
      JSON.stringify(["ebay", "production", "provider-user-123"]),
    ]);
    expect(String(advisoryLockCall?.[1]?.[0])).not.toContain("\u0000");
    expect(queryIndex(queries, "status = 'staged'")).toBeLessThan(
      queryIndex(queries, "INSERT INTO marketplace.provider_identity_claims"),
    );
    expect(
      queryIndex(queries, "INSERT INTO marketplace.provider_identity_claims"),
    ).toBeLessThan(queryIndex(queries, "status = 'active'"));
    expect(queryIndex(queries, "status = 'active'")).toBeLessThan(
      queryIndex(queries, "INSERT INTO marketplace.listing_registrations"),
    );
    expect(queries.at(-1)).toContain("COMMIT");
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it("rejects owner identity evidence re-verified after the account claim", async () => {
    const input = persistenceInput();
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql.startsWith("SET LOCAL")) return result([]);
      if (sql.includes("FROM channels.channels")) {
        return result([{ id: 7, provider: "ebay" }]);
      }
      if (sql.includes("FROM ebay.ebay_oauth_tokens")) {
        return result([
          {
            external_account_id: "provider-user-123",
            external_account_identity_scheme: "provider_user_id",
            external_account_verified_at: new Date(
              input.accountClaim.verifiedAt.getTime() + 1,
            ),
          },
        ]);
      }
      if (sql === "ROLLBACK") return result([]);
      throw new Error(`Unexpected query: ${sql}`);
    });
    const repository = new PgMarketplaceListingRegistrationRepository({
      connect: vi.fn(async () => ({ query, release }) as unknown as PoolClient),
    } as unknown as Pool);

    await expect(repository.registerOrReplay(input)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_OWNER_CHANGED",
    });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO marketplace.listing_scopes"),
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalledWith(false);
  });

  it("uses owner-scoped replay without opening a transaction", async () => {
    const input = persistenceInput();
    const receipt = receiptRow(input.plan);
    const poolQuery = vi.fn(async () => result([receipt]));
    const connect = vi.fn();
    const repository = new PgMarketplaceListingRegistrationRepository({
      query: poolQuery,
      connect,
    } as unknown as Pool);

    await expect(
      repository.findReplay({
        owner: input.plan.owner,
        idempotencyKey: input.plan.idempotencyKey,
        requestHash: input.plan.requestHash,
      }),
    ).resolves.toMatchObject({ registrationId: 40, publicationId: 30 });
    expect(poolQuery).toHaveBeenCalledWith(expect.any(String), [
      "channel",
      "ebay",
      "EBAY_US",
      7,
      33,
      input.plan.idempotencyKey,
    ]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a reused idempotency key with a different request hash", async () => {
    const input = persistenceInput();
    const poolQuery = vi.fn(async () => result([receiptRow(input.plan)]));
    const repository = new PgMarketplaceListingRegistrationRepository({
      query: poolQuery,
    } as unknown as Pool);

    await expect(
      repository.findReplay({
        owner: input.plan.owner,
        idempotencyKey: input.plan.idempotencyKey,
        requestHash: "f".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_IDEMPOTENCY_CONFLICT",
    });
  });

  it("rolls back and destroys the client when both persistence and rollback fail", async () => {
    const input = persistenceInput();
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql.startsWith("SET LOCAL")) return result([]);
      if (sql.includes("FROM channels.channels")) {
        return result([{ id: 7, provider: "ebay" }]);
      }
      if (sql.includes("FROM ebay.ebay_oauth_tokens")) {
        return result([
          {
            external_account_id: "provider-user-123",
            external_account_identity_scheme: "provider_user_id",
            external_account_verified_at: input.accountClaim.verifiedAt,
          },
        ]);
      }
      if (sql === "ROLLBACK") throw new Error("rollback connection lost");
      throw new Error("database write failed");
    });
    const client = { query, release } as unknown as PoolClient;
    const repository = new PgMarketplaceListingRegistrationRepository({
      connect: vi.fn(async () => client),
    } as unknown as Pool);

    await expect(repository.registerOrReplay(input)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_ROLLBACK_FAILED",
      context: {
        persistenceErrorCode: "MARKETPLACE_LISTING_REGISTRATION_DATABASE_ERROR",
      },
    });
    expect(release).toHaveBeenCalledWith(true);
  });
});

function scriptedClient(
  input: PersistListingRegistrationInput,
  queries: string[],
): PoolClient {
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    queries.push(sql);
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql.startsWith("SET LOCAL") ||
      sql.startsWith("SET CONSTRAINTS") ||
      sql.includes("pg_advisory_xact_lock") ||
      sql.includes("INSERT INTO marketplace.channel_listing_scopes") ||
      sql.includes("INSERT INTO marketplace.listing_scope_provider_accounts")
    ) {
      return result([]);
    }
    if (sql.includes("FROM channels.channels")) {
      return result([{ id: 7, provider: "ebay" }]);
    }
    if (sql.includes("FROM ebay.ebay_oauth_tokens")) {
      return result([
        {
          external_account_id: "provider-user-123",
          external_account_identity_scheme: "provider_user_id",
          external_account_verified_at: input.accountClaim.verifiedAt,
        },
      ]);
    }
    if (sql.includes("FROM catalog.product_variants")) {
      return result([
        { id: 11, sku: "ARM-ENV-SGL-C750", is_active: false },
        { id: 12, sku: "ARM-ENV-SGL-C700", is_active: false },
      ]);
    }
    if (sql.includes("FROM marketplace.listing_scopes AS scope")) {
      return result([]);
    }
    if (sql.includes("INSERT INTO marketplace.listing_scopes")) {
      return result([{ id: 10 }]);
    }
    if (
      sql.includes("FROM marketplace.listing_registrations") &&
      sql.includes("FOR UPDATE")
    ) {
      return result([]);
    }
    if (sql.includes("AS publication_count")) {
      return result([
        {
          publication_count: "0",
          operation_count: "0",
          registration_count: "0",
          account_binding_count: "0",
        },
      ]);
    }
    if (
      sql.includes("FROM marketplace.provider_accounts") &&
      sql.includes("FOR UPDATE")
    ) {
      return result([]);
    }
    if (sql.includes("INSERT INTO marketplace.provider_accounts")) {
      return result([{ id: 20 }]);
    }
    if (sql.includes("INSERT INTO marketplace.listing_publications")) {
      return result([{ id: 30 }]);
    }
    if (sql.includes("INSERT INTO marketplace.listing_publication_members")) {
      return result([
        { id: 31, product_variant_id: 11 },
        { id: 32, product_variant_id: 12 },
      ]);
    }
    if (
      sql.includes("UPDATE marketplace.listing_publications") &&
      sql.includes("status = 'staged'")
    ) {
      return result([], 1);
    }
    if (sql.includes("UPDATE marketplace.listing_publication_members")) {
      return result([], input.plan.members.length);
    }
    if (sql.includes("INSERT INTO marketplace.provider_identity_claims")) {
      return result([], input.plan.identityClaims.length);
    }
    if (
      sql.includes("UPDATE marketplace.listing_publications") &&
      sql.includes("status = 'active'")
    ) {
      return result([], 1);
    }
    if (sql.includes("INSERT INTO marketplace.listing_registrations")) {
      expect(values).toBeDefined();
      return result([receiptRow(input.plan)]);
    }
    throw new Error(`Unexpected SQL in registration repository test: ${sql}`);
  });
  return { query, release } as unknown as PoolClient;
}

function persistenceInput(): PersistListingRegistrationInput {
  const plan = buildListingRegistrationPlan({
    owner: {
      kind: "channel",
      channelId: 7,
      productId: 33,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    },
    locator: {
      providerPublicationKey: "ARM-ENV-SGL-V2",
      externalListingId: "listing-123",
    },
    requestedBy: { type: "user", id: "admin@example.test" },
    idempotencyKey: "register-arm-envelope-v2",
    correlationId: "correlation-1",
    snapshot: {
      owner: {
        kind: "channel",
        channelId: 7,
        productId: 33,
        provider: "ebay",
        marketplaceId: "EBAY_US",
      },
      memberCandidates: [
        {
          productVariantId: 11,
          sku: "ARM-ENV-SGL-C750",
          isActive: false,
          availableQuantity: 0,
        },
        {
          productVariantId: 12,
          sku: "ARM-ENV-SGL-C700",
          isActive: false,
          availableQuantity: 4,
        },
      ],
    },
    observation: {
      providerAccount: {
        provider: "ebay",
        accountNamespace: "production",
        externalAccountId: "provider-user-123",
        identityScheme: "provider_user_id",
        externalDisplayNameSnapshot: "Cardshellz",
        evidenceHash: "a".repeat(64),
      },
      marketplaceId: "EBAY_US",
      publicationKeyIdentity: {
        identityNamespace: "ebay.sell.inventory.inventory_item_group",
        externalId: "ARM-ENV-SGL-V2",
      },
      listingIdentity: {
        identityNamespace: "ebay.sell.inventory.listing",
        externalId: "listing-123",
      },
      externalUrl: "https://example.test/listing-123",
      isPublished: true,
      members: [
        {
          sku: "ARM-ENV-SGL-C750",
          variantIdentity: null,
          offerIdentity: {
            identityNamespace: "ebay.sell.inventory.offer",
            externalId: "offer-c750",
          },
          inventoryItemIdentity: {
            identityNamespace: "ebay.sell.inventory.inventory_item",
            externalId: "ARM-ENV-SGL-C750",
          },
        },
      ],
      evidence: { requestId: "request-1" },
      observedAt: new Date("2026-08-04T12:00:00.000Z"),
    },
  });
  return {
    plan,
    registeredAt: new Date("2026-08-04T12:00:02.000Z"),
    accountClaim: {
      kind: "claimed",
      owner: plan.owner,
      provider: "ebay",
      accountNamespace: "production",
      externalAccountId: "provider-user-123",
      identityScheme: "provider_user_id",
      verifiedAt: new Date("2026-08-04T12:00:01.000Z"),
    },
  };
}

function receiptRow(plan: ListingRegistrationPlan) {
  return {
    id: 40,
    scope_id: 10,
    provider_account_id: 20,
    publication_id: 30,
    idempotency_key: plan.idempotencyKey,
    request_hash: plan.requestHash,
    observation_hash: plan.observationHash,
    desired_state_hash: plan.desiredStateHash,
    observed_at: plan.observedAt,
    registered_at: new Date("2026-08-04T12:00:02.000Z"),
  };
}

function currentStatusRow(owner: ListingOwnerRef) {
  return {
    scope_id: 10,
    scope_owner_kind: owner.kind,
    scope_provider: owner.provider,
    scope_marketplace_id: owner.marketplaceId,
    scope_product_id: owner.productId,
    channel_id: owner.kind === "channel" ? owner.channelId : null,
    store_connection_id:
      owner.kind === "dropship" ? owner.storeConnectionId : null,
    registration_id: 40,
    registration_scope_id: 10,
    registration_provider_account_id: 20,
    registered_publication_id: 30,
    registered_at: new Date("2026-08-04T12:00:02.000Z"),
    publication_id: 31,
    publication_scope_id: 10,
    publication_status: "active",
    provider_publication_key: "ARM-ENV-SGL-V3",
    external_listing_id: "listing-456",
    registered_variants: [{
      productVariantId: 501,
      sku: "ARM-ENV-SGL-C700",
      disposition: "included",
    }],
    registered_variant_ids: [501, 502],
    scope_provider_account_id: 20,
    provider_account_id: 20,
    account_owner_kind: owner.kind,
    account_channel_id: owner.kind === "channel" ? owner.channelId : null,
    account_store_connection_id:
      owner.kind === "dropship" ? owner.storeConnectionId : null,
    account_provider: owner.provider,
    account_identity_scheme: "provider_user_id",
  };
}

function result<Row extends Record<string, unknown>>(
  rows: Row[],
  rowCount: number = rows.length,
): QueryResult<Row> {
  return {
    command: "TEST",
    rowCount,
    oid: 0,
    fields: [],
    rows,
  };
}

function queryIndex(queries: string[], fragment: string): number {
  const index = queries.findIndex((query) => query.includes(fragment));
  expect(index, `Missing SQL fragment: ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
}
