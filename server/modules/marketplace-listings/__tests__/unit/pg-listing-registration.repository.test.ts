import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { PersistListingRegistrationInput } from "../../application/registration-ports";
import {
  buildListingRegistrationPlan,
  type ListingRegistrationPlan,
} from "../../domain/listing-registration-plan";
import { PgMarketplaceListingRegistrationRepository } from "../../infrastructure/pg-listing-registration.repository";

describe("PgMarketplaceListingRegistrationRepository", () => {
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
