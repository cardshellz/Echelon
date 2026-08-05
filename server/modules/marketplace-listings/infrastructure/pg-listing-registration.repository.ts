import type { Pool, PoolClient, QueryResultRow } from "pg";

import { pool as defaultPool } from "../../../db";
import {
  listingRegistrationReceiptSchema,
  listingRegistrationResultSchema,
  listingRegistrationStatusSchema,
  type ListingRegistrationReceipt,
  type ListingRegistrationResult,
  type ListingRegistrationStatus,
} from "../application/registration-dtos";
import type {
  ListingRegistrationReplayLookup,
  MarketplaceListingRegistrationRepository,
  PersistListingRegistrationInput,
} from "../application/registration-ports";
import type {
  ListingRegistrationPlan,
  PlannedListingRegistrationMember,
} from "../domain/listing-registration-plan";
import { MarketplaceListingRegistrationError } from "../domain/registration-errors";
import type { ListingOwnerRef } from "../domain/listing-replacement-plan";

interface RegistrationRow extends QueryResultRow {
  id: string | number;
  scope_id: string | number;
  provider_account_id: string | number;
  publication_id: string | number;
  idempotency_key: string;
  request_hash: string;
  observation_hash: string;
  desired_state_hash: string;
  observed_at: Date | string;
  registered_at: Date | string;
}

interface CurrentRegistrationStatusRow extends QueryResultRow {
  scope_id: string | number;
  scope_owner_kind: string;
  scope_provider: string;
  scope_marketplace_id: string;
  scope_product_id: number;
  channel_id: number | null;
  store_connection_id: number | null;
  registration_id: string | number | null;
  registration_scope_id: string | number | null;
  registration_provider_account_id: string | number | null;
  registered_publication_id: string | number | null;
  registered_at: Date | string | null;
  publication_id: string | number | null;
  publication_scope_id: string | number | null;
  publication_status: string | null;
  provider_publication_key: string | null;
  external_listing_id: string | null;
  scope_provider_account_id: string | number | null;
  provider_account_id: string | number | null;
  account_owner_kind: string | null;
  account_channel_id: number | null;
  account_store_connection_id: number | null;
  account_provider: string | null;
  account_identity_scheme: string | null;
}

interface ChannelRow extends QueryResultRow {
  id: number;
  provider: string;
}

interface EbayTokenRow extends QueryResultRow {
  external_account_id: string | null;
  external_account_identity_scheme: string | null;
  external_account_verified_at: Date | string | null;
}

interface DropshipConnectionRow extends QueryResultRow {
  id: number;
  platform: string;
  provider_environment: string | null;
  external_account_id: string | null;
  external_account_identity_scheme: string | null;
  external_account_verified_at: Date | string | null;
}

interface ScopeRow extends QueryResultRow {
  id: string | number;
  owner_kind: string;
  provider: string;
  marketplace_id: string;
  product_id: number;
  channel_id: number | null;
  store_connection_id: number | null;
}

interface ProviderAccountRow extends QueryResultRow {
  id: string | number;
  owner_kind: string;
  channel_id: number | null;
  store_connection_id: number | null;
  provider: string;
  account_namespace: string;
  external_account_id: string;
  identity_scheme: string;
}

interface CatalogVariantRow extends QueryResultRow {
  id: number;
  sku: string | null;
  is_active: boolean;
}

interface MemberRow extends QueryResultRow {
  id: string | number;
  product_variant_id: number;
}

interface IdRow extends QueryResultRow {
  id: string | number;
}

interface CountRow extends QueryResultRow {
  publication_count: string | number;
  operation_count: string | number;
  registration_count: string | number;
  account_binding_count: string | number;
}

interface PostgresErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

type RollbackResult =
  Readonly<{ ok: true }> | Readonly<{ ok: false; error: unknown }>;

export class PgMarketplaceListingRegistrationRepository implements MarketplaceListingRegistrationRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async findCurrentRegistration(
    owner: ListingOwnerRef,
  ): Promise<ListingRegistrationStatus | null> {
    const statuses = await this.findCurrentRegistrations([owner]);
    return statuses[0] ?? null;
  }

  async findCurrentRegistrations(
    owners: readonly ListingOwnerRef[],
  ): Promise<readonly ListingRegistrationStatus[]> {
    if (owners.length === 0) return [];
    const ownerByProductId = validateRepositoryOwnerBatch(owners);
    const firstOwner = owners[0];
    try {
      const result = await this.dbPool.query<CurrentRegistrationStatusRow>(
        currentRegistrationStatusesSql(firstOwner),
        currentRegistrationStatusesParams(firstOwner, [
          ...ownerByProductId.keys(),
        ]),
      );
      const seenProductIds = new Set<number>();
      const statuses: ListingRegistrationStatus[] = [];
      for (const row of result.rows) {
        const productId = toSafeInteger(
          row.scope_product_id,
          "registration_status.scope_product_id",
        );
        const owner = ownerByProductId.get(productId);
        if (!owner || seenProductIds.has(productId)) {
          throw databaseContractError(
            "Owner-scoped current registration lookup returned an unexpected or duplicate product row.",
          );
        }
        seenProductIds.add(productId);
        assertScopeMatchesOwner(mapStatusScope(row), owner);
        if (row.registration_id !== null) {
          statuses.push(mapCurrentRegistrationStatus(row, owner));
        }
      }
      return statuses;
    } catch (error) {
      throw classifyStatusLookupError(error, firstOwner);
    }
  }

  async findReplay(
    lookup: ListingRegistrationReplayLookup,
  ): Promise<ListingRegistrationReceipt | null> {
    try {
      const result = await this.dbPool.query<RegistrationRow>(
        registrationReplayLookupSql(lookup.owner),
        registrationReplayLookupParams(lookup),
      );
      if (result.rows.length > 1) {
        throw databaseContractError(
          "Owner-scoped registration replay returned more than one receipt.",
        );
      }
      const row = result.rows[0];
      if (!row) return null;
      assertMatchingRequestHash(row, lookup.requestHash, {
        ownerKind: lookup.owner.kind,
        productId: lookup.owner.productId,
      });
      return mapReceipt(row);
    } catch (error) {
      throw classifyReplayError(error, lookup);
    }
  }

  async registerOrReplay(
    input: PersistListingRegistrationInput,
  ): Promise<ListingRegistrationResult> {
    let client: PoolClient;
    try {
      client = await this.dbPool.connect();
    } catch (error) {
      throw classifyPersistenceError(error, input.plan);
    }

    let destroyClient = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await lockAndValidateOwner(client, input);
      await lockProviderAccountIdentity(client, input.plan);
      await lockAndValidateCatalogVariants(client, input.plan);

      const scope = await lockOrCreateScope(client, input.plan);
      const replay = await loadRegistrationForIdempotencyKey(
        client,
        scope.id,
        input.plan.idempotencyKey,
      );
      if (replay) {
        assertMatchingRequestHash(replay, input.plan.requestHash, {
          scopeId: scope.id,
        });
        const result = listingRegistrationResultSchema.parse({
          kind: "replay",
          receipt: mapReceipt(replay),
        });
        await client.query("COMMIT");
        return result;
      }

      await assertScopeEmpty(client, scope.id);
      const providerAccountId = await findOrCreateProviderAccount(
        client,
        input,
      );
      await bindScopeToProviderAccount(
        client,
        scope.id,
        providerAccountId,
        input.plan,
      );
      const publicationId = await insertPlannedPublication(
        client,
        scope.id,
        input,
      );
      const memberIds = await insertPlannedMembers(
        client,
        scope.id,
        publicationId,
        input.plan,
      );
      await stagePublication(client, publicationId, input);
      await attachMemberIdentities(
        client,
        publicationId,
        input.plan,
        memberIds,
      );
      await insertIdentityClaims(
        client,
        scope.id,
        providerAccountId,
        publicationId,
        input.plan,
        memberIds,
      );
      await activatePublication(client, publicationId, input.registeredAt);
      const receipt = await insertRegistrationReceipt(
        client,
        scope.id,
        providerAccountId,
        publicationId,
        input,
      );
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      const result = listingRegistrationResultSchema.parse({
        kind: "created",
        receipt: mapReceipt(receipt),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      const persistenceError = classifyPersistenceError(error, input.plan);
      const rollback = await rollbackTransaction(client);
      if (!rollback.ok) {
        destroyClient = true;
        throw rollbackFailureError(
          persistenceError,
          rollback.error,
          input.plan,
        );
      }
      throw persistenceError;
    } finally {
      client.release(destroyClient);
    }
  }
}

async function lockAndValidateOwner(
  client: PoolClient,
  input: PersistListingRegistrationInput,
): Promise<void> {
  const { owner, providerAccount } = input.plan;
  if (owner.kind === "channel") {
    const channelResult = await client.query<ChannelRow>(
      `SELECT id, lower(provider) AS provider
       FROM channels.channels
       WHERE id = $1
       FOR UPDATE`,
      [owner.channelId],
    );
    const channel = channelResult.rows[0];
    if (!channel || channel.provider !== owner.provider) {
      throw ownerChanged(owner, "Channel provider no longer matches the plan.");
    }
    if (owner.provider !== "ebay") {
      throw new MarketplaceListingRegistrationError(
        "MARKETPLACE_LISTING_REGISTRATION_CHANNEL_IDENTITY_UNSUPPORTED",
        "This registration stage has no stable account identity store for the Channel provider.",
        { provider: owner.provider },
      );
    }
    const tokenResult = await client.query<EbayTokenRow>(
      `SELECT
         external_account_id,
         external_account_identity_scheme,
         external_account_verified_at
       FROM ebay.ebay_oauth_tokens
       WHERE channel_id = $1 AND environment = $2
       FOR UPDATE`,
      [owner.channelId, providerAccount.accountNamespace],
    );
    const token = tokenResult.rows[0];
    assertStableOwnerIdentity(
      token,
      providerAccount.externalAccountId,
      input.accountClaim.verifiedAt,
      owner,
    );
    return;
  }

  const connectionResult = await client.query<DropshipConnectionRow>(
    `SELECT
       id,
       lower(platform) AS platform,
       provider_environment,
       external_account_id,
       external_account_identity_scheme,
       external_account_verified_at
     FROM dropship.dropship_store_connections
     WHERE id = $1
     FOR UPDATE`,
    [owner.storeConnectionId],
  );
  const connection = connectionResult.rows[0];
  if (
    !connection ||
    connection.platform !== owner.provider ||
    connection.provider_environment !== providerAccount.accountNamespace
  ) {
    throw ownerChanged(
      owner,
      "Dropship provider account no longer matches the plan.",
    );
  }
  assertStableOwnerIdentity(
    connection,
    providerAccount.externalAccountId,
    input.accountClaim.verifiedAt,
    owner,
  );
}

function assertStableOwnerIdentity(
  row: EbayTokenRow | DropshipConnectionRow | undefined,
  externalAccountId: string,
  expectedVerifiedAt: Date,
  owner: ListingOwnerRef,
): void {
  const databaseVerifiedAt = row?.external_account_verified_at;
  if (
    !row ||
    row.external_account_id !== externalAccountId ||
    row.external_account_identity_scheme !== "provider_user_id" ||
    databaseVerifiedAt === null ||
    databaseVerifiedAt === undefined
  ) {
    throw ownerChanged(
      owner,
      "Owner stable provider_user_id evidence is missing or changed.",
    );
  }
  const parsedVerifiedAt = toDate(
    databaseVerifiedAt,
    "owner.external_account_verified_at",
  );
  if (parsedVerifiedAt.getTime() !== expectedVerifiedAt.getTime()) {
    throw ownerChanged(
      owner,
      "Owner stable provider_user_id evidence was re-verified after the account claim.",
    );
  }
}

async function lockProviderAccountIdentity(
  client: PoolClient,
  plan: ListingRegistrationPlan,
): Promise<void> {
  const account = plan.providerAccount;
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended($1, 0)
     )`,
    [
      JSON.stringify([
        account.provider,
        account.accountNamespace,
        account.externalAccountId,
      ]),
    ],
  );
}

async function lockAndValidateCatalogVariants(
  client: PoolClient,
  plan: ListingRegistrationPlan,
): Promise<void> {
  const result = await client.query<CatalogVariantRow>(
    `SELECT id, sku, is_active
     FROM catalog.product_variants
     WHERE product_id = $1
     ORDER BY id
     FOR SHARE`,
    [plan.owner.productId],
  );
  if (result.rows.length !== plan.members.length) {
    throw staleOwnerSnapshot(plan, "The product variant set changed.");
  }
  const plannedById = new Map(
    plan.members.map((member) => [member.productVariantId, member] as const),
  );
  for (const row of result.rows) {
    const member = plannedById.get(row.id);
    if (
      !member ||
      row.sku?.trim() !== member.skuSnapshot ||
      row.is_active !== member.isActiveSnapshot
    ) {
      throw staleOwnerSnapshot(
        plan,
        "A product variant identity or active state changed.",
      );
    }
  }
}

async function lockOrCreateScope(
  client: PoolClient,
  plan: ListingRegistrationPlan,
): Promise<{ readonly id: number }> {
  const existingResult = await client.query<ScopeRow>(
    scopeLookupSql(plan.owner),
    scopeLookupParams(plan.owner),
  );
  if (existingResult.rows.length > 1) {
    throw databaseContractError(
      "Owner lookup returned multiple listing scopes.",
    );
  }
  const existing = existingResult.rows[0];
  if (existing) {
    assertScopeMatchesOwner(existing, plan.owner);
    return { id: toSafeInteger(existing.id, "scope.id") };
  }

  const inserted = await client.query<IdRow>(
    `INSERT INTO marketplace.listing_scopes (
       owner_kind,
       provider,
       marketplace_id,
       product_id,
       created_by_type,
       created_by_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      plan.owner.kind,
      plan.owner.provider,
      plan.owner.marketplaceId,
      plan.owner.productId,
      plan.requestedBy.type,
      plan.requestedBy.id,
    ],
  );
  const scopeId = toSafeInteger(
    requiredRow(inserted.rows[0], "Scope insert returned no row.").id,
    "scope.id",
  );
  if (plan.owner.kind === "channel") {
    await client.query(
      `INSERT INTO marketplace.channel_listing_scopes (
         scope_id, channel_id, product_id, marketplace_id
       ) VALUES ($1, $2, $3, $4)`,
      [
        scopeId,
        plan.owner.channelId,
        plan.owner.productId,
        plan.owner.marketplaceId,
      ],
    );
  } else {
    await client.query(
      `INSERT INTO marketplace.dropship_listing_scopes (
         scope_id, store_connection_id, product_id, marketplace_id
       ) VALUES ($1, $2, $3, $4)`,
      [
        scopeId,
        plan.owner.storeConnectionId,
        plan.owner.productId,
        plan.owner.marketplaceId,
      ],
    );
  }
  return { id: scopeId };
}

async function loadRegistrationForIdempotencyKey(
  client: PoolClient,
  scopeId: number,
  idempotencyKey: string,
): Promise<RegistrationRow | null> {
  const result = await client.query<RegistrationRow>(
    `${registrationSelectSql()}
     WHERE scope_id = $1 AND idempotency_key = $2
     FOR UPDATE`,
    [scopeId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function assertScopeEmpty(
  client: PoolClient,
  scopeId: number,
): Promise<void> {
  const result = await client.query<CountRow>(
    `SELECT
       (SELECT count(*) FROM marketplace.listing_publications WHERE scope_id = $1)
         AS publication_count,
       (SELECT count(*) FROM marketplace.listing_replacement_operations WHERE scope_id = $1)
         AS operation_count,
       (SELECT count(*) FROM marketplace.listing_registrations WHERE scope_id = $1)
         AS registration_count,
       (SELECT count(*) FROM marketplace.listing_scope_provider_accounts WHERE scope_id = $1)
         AS account_binding_count`,
    [scopeId],
  );
  const row = requiredRow(
    result.rows[0],
    "Scope history count returned no row.",
  );
  const counts = [
    row.publication_count,
    row.operation_count,
    row.registration_count,
    row.account_binding_count,
  ].map((value, index) => toNonNegativeInteger(value, `scope.count.${index}`));
  if (counts.some((count) => count !== 0)) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_SCOPE_NOT_EMPTY",
      "Existing live listing registration is allowed only for a new or empty scope.",
      { scopeId },
    );
  }
}

async function findOrCreateProviderAccount(
  client: PoolClient,
  input: PersistListingRegistrationInput,
): Promise<number> {
  const account = input.plan.providerAccount;
  const existingResult = await client.query<ProviderAccountRow>(
    `SELECT
       id,
       owner_kind,
       channel_id,
       store_connection_id,
       provider,
       account_namespace,
       external_account_id,
       identity_scheme
     FROM marketplace.provider_accounts
     WHERE provider = $1
       AND account_namespace = $2
       AND external_account_id = $3
     FOR UPDATE`,
    [account.provider, account.accountNamespace, account.externalAccountId],
  );
  const existing = existingResult.rows[0];
  if (existing) {
    assertProviderAccountMatchesOwner(existing, input.plan.owner);
    return toSafeInteger(existing.id, "provider_account.id");
  }

  const ownerIds =
    input.plan.owner.kind === "channel"
      ? [input.plan.owner.channelId, null]
      : [null, input.plan.owner.storeConnectionId];
  const result = await client.query<IdRow>(
    `INSERT INTO marketplace.provider_accounts (
       owner_kind,
       channel_id,
       store_connection_id,
       provider,
       account_namespace,
       external_account_id,
       identity_scheme,
       external_display_name_snapshot,
       evidence_hash,
       verified_at,
       verified_by_type,
       verified_by_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      input.plan.owner.kind,
      ownerIds[0],
      ownerIds[1],
      account.provider,
      account.accountNamespace,
      account.externalAccountId,
      account.identityScheme,
      account.externalDisplayNameSnapshot,
      account.evidenceHash,
      input.accountClaim.verifiedAt,
      input.plan.requestedBy.type,
      input.plan.requestedBy.id,
    ],
  );
  return toSafeInteger(
    requiredRow(result.rows[0], "Provider account insert returned no row.").id,
    "provider_account.id",
  );
}

async function bindScopeToProviderAccount(
  client: PoolClient,
  scopeId: number,
  providerAccountId: number,
  plan: ListingRegistrationPlan,
): Promise<void> {
  await client.query(
    `INSERT INTO marketplace.listing_scope_provider_accounts (
       scope_id,
       provider_account_id,
       bound_by_type,
       bound_by_id
     ) VALUES ($1, $2, $3, $4)`,
    [scopeId, providerAccountId, plan.requestedBy.type, plan.requestedBy.id],
  );
}

async function insertPlannedPublication(
  client: PoolClient,
  scopeId: number,
  input: PersistListingRegistrationInput,
): Promise<number> {
  const plan = input.plan;
  const result = await client.query<IdRow>(
    `INSERT INTO marketplace.listing_publications (
       scope_id,
       product_id,
       generation,
       status,
       desired_state_hash,
       metadata,
       created_by_type,
       created_by_id,
       created_at,
       updated_at
     ) VALUES ($1, $2, 1, 'planned', $3, $4::jsonb, $5, $6, $7, $7)
     RETURNING id`,
    [
      scopeId,
      plan.owner.productId,
      plan.desiredStateHash,
      JSON.stringify({
        registrationVersion: plan.registrationVersion,
        observationHash: plan.observationHash,
      }),
      plan.requestedBy.type,
      plan.requestedBy.id,
      input.registeredAt,
    ],
  );
  return toSafeInteger(
    requiredRow(result.rows[0], "Publication insert returned no row.").id,
    "publication.id",
  );
}

async function insertPlannedMembers(
  client: PoolClient,
  scopeId: number,
  publicationId: number,
  plan: ListingRegistrationPlan,
): Promise<ReadonlyMap<number, number>> {
  const result = await client.query<MemberRow>(
    `INSERT INTO marketplace.listing_publication_members (
       publication_id,
       scope_id,
       product_id,
       product_variant_id,
       sku_snapshot,
       disposition,
       reason_code,
       metadata
     )
     SELECT
       $1,
       $2,
       $3,
       member.product_variant_id,
       member.sku_snapshot,
       member.disposition,
       member.reason_code,
       jsonb_build_object(
         'isActiveSnapshot', member.is_active_snapshot,
         'availableQuantitySnapshot', member.available_quantity_snapshot
       )
     FROM jsonb_to_recordset($4::jsonb) AS member(
       product_variant_id INTEGER,
       sku_snapshot VARCHAR(100),
       is_active_snapshot BOOLEAN,
       available_quantity_snapshot BIGINT,
       disposition VARCHAR(20),
       reason_code VARCHAR(100)
     )
     RETURNING id, product_variant_id`,
    [
      publicationId,
      scopeId,
      plan.owner.productId,
      JSON.stringify(
        plan.members.map((member) => ({
          product_variant_id: member.productVariantId,
          sku_snapshot: member.skuSnapshot,
          is_active_snapshot: member.isActiveSnapshot,
          available_quantity_snapshot: member.availableQuantitySnapshot,
          disposition: member.disposition,
          reason_code: member.reasonCode,
        })),
      ),
    ],
  );
  if (result.rowCount !== plan.members.length) {
    throw databaseContractError("Registration member insert was incomplete.");
  }
  const memberIds = new Map<number, number>();
  for (const row of result.rows) {
    if (memberIds.has(row.product_variant_id)) {
      throw databaseContractError(
        "Registration member insert returned a duplicate variant.",
      );
    }
    memberIds.set(
      row.product_variant_id,
      toSafeInteger(row.id, "publication_member.id"),
    );
  }
  return memberIds;
}

async function stagePublication(
  client: PoolClient,
  publicationId: number,
  input: PersistListingRegistrationInput,
): Promise<void> {
  const plan = input.plan;
  const result = await client.query(
    `UPDATE marketplace.listing_publications
     SET
       status = 'staged',
       provider_publication_key = $2,
       external_listing_id = $3,
       external_url = $4,
       metadata = $5::jsonb,
       published_at = $6,
       updated_at = $6
     WHERE id = $1 AND status = 'planned'`,
    [
      publicationId,
      plan.providerPublicationKey,
      plan.externalListingId,
      plan.externalUrl,
      JSON.stringify({
        registrationVersion: plan.registrationVersion,
        observationHash: plan.observationHash,
        evidence: plan.evidence,
      }),
      input.registeredAt,
    ],
  );
  if (result.rowCount !== 1) {
    throw databaseContractError("Publication staging update affected no row.");
  }
}

async function attachMemberIdentities(
  client: PoolClient,
  publicationId: number,
  plan: ListingRegistrationPlan,
  memberIds: ReadonlyMap<number, number>,
): Promise<void> {
  const result = await client.query(
    `UPDATE marketplace.listing_publication_members AS persisted
     SET
       external_variant_id = identity.external_variant_id,
       external_offer_id = identity.external_offer_id,
       external_inventory_item_id = identity.external_inventory_item_id,
       updated_at = transaction_timestamp()
     FROM jsonb_to_recordset($2::jsonb) AS identity(
       member_id BIGINT,
       external_variant_id VARCHAR(255),
       external_offer_id VARCHAR(255),
       external_inventory_item_id VARCHAR(255)
     )
     WHERE persisted.id = identity.member_id
       AND persisted.publication_id = $1`,
    [
      publicationId,
      JSON.stringify(
        plan.members.map((member) => ({
          member_id: requiredMemberId(member, memberIds),
          external_variant_id: member.externalVariantId,
          external_offer_id: member.externalOfferId,
          external_inventory_item_id: member.externalInventoryItemId,
        })),
      ),
    ],
  );
  if (result.rowCount !== plan.members.length) {
    throw databaseContractError(
      "Registration member identity update was incomplete.",
    );
  }
}

async function insertIdentityClaims(
  client: PoolClient,
  scopeId: number,
  providerAccountId: number,
  publicationId: number,
  plan: ListingRegistrationPlan,
  memberIds: ReadonlyMap<number, number>,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO marketplace.provider_identity_claims (
       provider_account_id,
       scope_id,
       publication_id,
       member_id,
       identity_role,
       identity_namespace,
       external_id,
       created_by_type,
       created_by_id
     )
     SELECT
       $1,
       $2,
       $3,
       claim.member_id,
       claim.identity_role,
       claim.identity_namespace,
       claim.external_id,
       $4,
       $5
     FROM jsonb_to_recordset($6::jsonb) AS claim(
       member_id BIGINT,
       identity_role VARCHAR(30),
       identity_namespace VARCHAR(160),
       external_id VARCHAR(255)
     )`,
    [
      providerAccountId,
      scopeId,
      publicationId,
      plan.requestedBy.type,
      plan.requestedBy.id,
      JSON.stringify(
        plan.identityClaims.map((claim) => ({
          member_id:
            claim.productVariantId === null
              ? null
              : requiredMemberIdByVariantId(claim.productVariantId, memberIds),
          identity_role: claim.role,
          identity_namespace: claim.identityNamespace,
          external_id: claim.externalId,
        })),
      ),
    ],
  );
  if (result.rowCount !== plan.identityClaims.length) {
    throw databaseContractError(
      "Provider identity claim insert was incomplete.",
    );
  }
}

async function activatePublication(
  client: PoolClient,
  publicationId: number,
  registeredAt: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE marketplace.listing_publications
     SET status = 'active', verified_at = $2, updated_at = $2
     WHERE id = $1 AND status = 'staged'`,
    [publicationId, registeredAt],
  );
  if (result.rowCount !== 1) {
    throw databaseContractError(
      "Publication activation update affected no row.",
    );
  }
}

async function insertRegistrationReceipt(
  client: PoolClient,
  scopeId: number,
  providerAccountId: number,
  publicationId: number,
  input: PersistListingRegistrationInput,
): Promise<RegistrationRow> {
  const plan = input.plan;
  const result = await client.query<RegistrationRow>(
    `INSERT INTO marketplace.listing_registrations (
       scope_id,
       provider_account_id,
       publication_id,
       idempotency_key,
       request_hash,
       observation_hash,
       desired_state_hash,
       evidence,
       observed_at,
       registered_at,
       registered_by_type,
       registered_by_id,
       correlation_id,
       created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $10
     )
     RETURNING
       id,
       scope_id,
       provider_account_id,
       publication_id,
       idempotency_key,
       request_hash,
       observation_hash,
       desired_state_hash,
       observed_at,
       registered_at`,
    [
      scopeId,
      providerAccountId,
      publicationId,
      plan.idempotencyKey,
      plan.requestHash,
      plan.observationHash,
      plan.desiredStateHash,
      JSON.stringify(plan.evidence),
      plan.observedAt,
      input.registeredAt,
      plan.requestedBy.type,
      plan.requestedBy.id,
      plan.correlationId,
    ],
  );
  return requiredRow(
    result.rows[0],
    "Registration receipt insert returned no row.",
  );
}

function requiredMemberId(
  member: PlannedListingRegistrationMember,
  memberIds: ReadonlyMap<number, number>,
): number {
  return requiredMemberIdByVariantId(member.productVariantId, memberIds);
}

function requiredMemberIdByVariantId(
  productVariantId: number,
  memberIds: ReadonlyMap<number, number>,
): number {
  const memberId = memberIds.get(productVariantId);
  if (memberId === undefined) {
    throw databaseContractError(
      "Persisted member identity is missing for a planned variant.",
    );
  }
  return memberId;
}

function currentRegistrationStatusesSql(owner: ListingOwnerRef): string {
  const binding =
    owner.kind === "channel"
      ? `JOIN marketplace.channel_listing_scopes AS owner_binding
           ON owner_binding.scope_id = scope.id
          AND owner_binding.product_id = scope.product_id
          AND owner_binding.marketplace_id = scope.marketplace_id`
      : `JOIN marketplace.dropship_listing_scopes AS owner_binding
           ON owner_binding.scope_id = scope.id
          AND owner_binding.product_id = scope.product_id
          AND owner_binding.marketplace_id = scope.marketplace_id`;
  const ownerPredicate =
    owner.kind === "channel"
      ? "owner_binding.channel_id = $4"
      : "owner_binding.store_connection_id = $4";
  const ownerColumns =
    owner.kind === "channel"
      ? "owner_binding.channel_id AS channel_id, NULL::INTEGER AS store_connection_id"
      : "NULL::INTEGER AS channel_id, owner_binding.store_connection_id AS store_connection_id";
  return `SELECT
      scope.id AS scope_id,
      scope.owner_kind AS scope_owner_kind,
      scope.provider AS scope_provider,
      scope.marketplace_id AS scope_marketplace_id,
      scope.product_id AS scope_product_id,
      ${ownerColumns},
      registration.id AS registration_id,
      registration.scope_id AS registration_scope_id,
      registration.provider_account_id AS registration_provider_account_id,
      registration.publication_id AS registered_publication_id,
      registration.registered_at,
      publication.id AS publication_id,
      publication.scope_id AS publication_scope_id,
      publication.status AS publication_status,
      publication.provider_publication_key,
      publication.external_listing_id,
      scope_account.provider_account_id AS scope_provider_account_id,
      account.id AS provider_account_id,
      account.owner_kind AS account_owner_kind,
      account.channel_id AS account_channel_id,
      account.store_connection_id AS account_store_connection_id,
      account.provider AS account_provider,
      account.identity_scheme AS account_identity_scheme
    FROM marketplace.listing_scopes AS scope
    ${binding}
    LEFT JOIN marketplace.listing_registrations AS registration
      ON registration.scope_id = scope.id
    LEFT JOIN marketplace.listing_publications AS publication
      ON publication.scope_id = scope.id
     AND publication.status = 'active'
    LEFT JOIN marketplace.listing_scope_provider_accounts AS scope_account
      ON scope_account.scope_id = scope.id
    LEFT JOIN marketplace.provider_accounts AS account
      ON account.id = scope_account.provider_account_id
    WHERE scope.owner_kind = $1
      AND scope.provider = $2
      AND scope.marketplace_id = $3
      AND ${ownerPredicate}
      AND scope.product_id = ANY($5::INTEGER[])
    ORDER BY scope.id, registration.id, publication.id, account.id`;
}

function currentRegistrationStatusesParams(
  owner: ListingOwnerRef,
  productIds: readonly number[],
): unknown[] {
  return [
    owner.kind,
    owner.provider,
    owner.marketplaceId,
    ownerId(owner),
    productIds,
  ];
}

function validateRepositoryOwnerBatch(
  owners: readonly ListingOwnerRef[],
): ReadonlyMap<number, ListingOwnerRef> {
  const firstOwner = owners[0];
  const firstOwnerId = ownerId(firstOwner);
  const ownerByProductId = new Map<number, ListingOwnerRef>();
  for (const owner of owners) {
    if (
      owner.kind !== firstOwner.kind ||
      ownerId(owner) !== firstOwnerId ||
      owner.provider !== firstOwner.provider ||
      owner.marketplaceId !== firstOwner.marketplaceId ||
      ownerByProductId.has(owner.productId)
    ) {
      throw databaseContractError(
        "Registration status batch must contain distinct products for one marketplace owner.",
      );
    }
    ownerByProductId.set(owner.productId, owner);
  }
  return ownerByProductId;
}

function mapStatusScope(row: CurrentRegistrationStatusRow): ScopeRow {
  return {
    id: row.scope_id,
    owner_kind: row.scope_owner_kind,
    provider: row.scope_provider,
    marketplace_id: row.scope_marketplace_id,
    product_id: row.scope_product_id,
    channel_id: row.channel_id,
    store_connection_id: row.store_connection_id,
  };
}

function mapCurrentRegistrationStatus(
  row: CurrentRegistrationStatusRow,
  owner: ListingOwnerRef,
): ListingRegistrationStatus {
  const scopeId = toSafeInteger(row.scope_id, "registration_status.scope_id");
  const registrationId = toRequiredStatusId(
    row.registration_id,
    "registration_status.registration_id",
  );
  const registrationScopeId = toRequiredStatusId(
    row.registration_scope_id,
    "registration_status.registration_scope_id",
  );
  const registrationAccountId = toRequiredStatusId(
    row.registration_provider_account_id,
    "registration_status.registration_provider_account_id",
  );
  toRequiredStatusId(
    row.registered_publication_id,
    "registration_status.registered_publication_id",
  );
  const publicationId = toRequiredStatusId(
    row.publication_id,
    "registration_status.publication_id",
  );
  const publicationScopeId = toRequiredStatusId(
    row.publication_scope_id,
    "registration_status.publication_scope_id",
  );
  const scopeAccountId = toRequiredStatusId(
    row.scope_provider_account_id,
    "registration_status.scope_provider_account_id",
  );
  const providerAccountId = toRequiredStatusId(
    row.provider_account_id,
    "registration_status.provider_account_id",
  );
  if (
    registrationScopeId !== scopeId ||
    publicationScopeId !== scopeId ||
    registrationAccountId !== scopeAccountId ||
    scopeAccountId !== providerAccountId ||
    row.publication_status !== "active"
  ) {
    throw databaseContractError(
      "Current registration scope, publication, receipt, and account links disagree.",
    );
  }
  assertStatusAccountMatchesOwner(row, owner);
  return listingRegistrationStatusSchema.parse({
    status: "registered",
    productId: owner.productId,
    registrationId,
    scopeId,
    providerAccountId,
    publicationId,
    providerPublicationKey: row.provider_publication_key,
    externalListingId: row.external_listing_id,
    registeredAt: toRequiredStatusDate(
      row.registered_at,
      "registration_status.registered_at",
    ),
  });
}

function registrationSelectSql(): string {
  return `SELECT
    id,
    scope_id,
    provider_account_id,
    publication_id,
    idempotency_key,
    request_hash,
    observation_hash,
    desired_state_hash,
    observed_at,
    registered_at
  FROM marketplace.listing_registrations`;
}

function registrationReplayLookupSql(owner: ListingOwnerRef): string {
  const binding =
    owner.kind === "channel"
      ? `JOIN marketplace.channel_listing_scopes AS binding
           ON binding.scope_id = scope.id
          AND binding.product_id = scope.product_id
          AND binding.marketplace_id = scope.marketplace_id`
      : `JOIN marketplace.dropship_listing_scopes AS binding
           ON binding.scope_id = scope.id
          AND binding.product_id = scope.product_id
          AND binding.marketplace_id = scope.marketplace_id`;
  const ownerPredicate =
    owner.kind === "channel"
      ? "binding.channel_id = $4"
      : "binding.store_connection_id = $4";
  return `${registrationSelectSql()}
    WHERE scope_id = (
      SELECT scope.id
      FROM marketplace.listing_scopes AS scope
      ${binding}
      WHERE scope.owner_kind = $1
        AND scope.provider = $2
        AND scope.marketplace_id = $3
        AND scope.product_id = $5
        AND ${ownerPredicate}
    )
      AND idempotency_key = $6`;
}

function registrationReplayLookupParams(
  lookup: ListingRegistrationReplayLookup,
): unknown[] {
  return [
    lookup.owner.kind,
    lookup.owner.provider,
    lookup.owner.marketplaceId,
    ownerId(lookup.owner),
    lookup.owner.productId,
    lookup.idempotencyKey,
  ];
}

function scopeLookupSql(owner: ListingOwnerRef): string {
  const binding =
    owner.kind === "channel"
      ? `JOIN marketplace.channel_listing_scopes AS binding
           ON binding.scope_id = scope.id`
      : `JOIN marketplace.dropship_listing_scopes AS binding
           ON binding.scope_id = scope.id`;
  const ownerPredicate =
    owner.kind === "channel"
      ? "binding.channel_id = $5"
      : "binding.store_connection_id = $5";
  const ownerColumn =
    owner.kind === "channel"
      ? "binding.channel_id AS channel_id, NULL::INTEGER AS store_connection_id"
      : "NULL::INTEGER AS channel_id, binding.store_connection_id AS store_connection_id";
  return `SELECT
      scope.id,
      scope.owner_kind,
      scope.provider,
      scope.marketplace_id,
      scope.product_id,
      ${ownerColumn}
    FROM marketplace.listing_scopes AS scope
    ${binding}
    WHERE scope.owner_kind = $1
      AND scope.provider = $2
      AND scope.marketplace_id = $3
      AND scope.product_id = $4
      AND ${ownerPredicate}
    FOR UPDATE OF scope`;
}

function scopeLookupParams(owner: ListingOwnerRef): unknown[] {
  return [
    owner.kind,
    owner.provider,
    owner.marketplaceId,
    owner.productId,
    ownerId(owner),
  ];
}

function ownerId(owner: ListingOwnerRef): number {
  return owner.kind === "channel" ? owner.channelId : owner.storeConnectionId;
}

function assertScopeMatchesOwner(
  scope: ScopeRow,
  owner: ListingOwnerRef,
): void {
  const commonMismatch =
    scope.owner_kind !== owner.kind ||
    scope.provider !== owner.provider ||
    scope.marketplace_id !== owner.marketplaceId ||
    scope.product_id !== owner.productId;
  const ownerMismatch =
    owner.kind === "channel"
      ? scope.channel_id !== owner.channelId ||
        scope.store_connection_id !== null
      : scope.store_connection_id !== owner.storeConnectionId ||
        scope.channel_id !== null;
  if (commonMismatch || ownerMismatch) {
    throw ownerChanged(owner, "Listing scope no longer matches the owner.");
  }
}

function assertStatusAccountMatchesOwner(
  row: CurrentRegistrationStatusRow,
  owner: ListingOwnerRef,
): void {
  const mismatch =
    row.account_owner_kind !== owner.kind ||
    row.account_provider !== owner.provider ||
    row.account_identity_scheme !== "provider_user_id" ||
    (owner.kind === "channel"
      ? row.account_channel_id !== owner.channelId ||
        row.account_store_connection_id !== null
      : row.account_store_connection_id !== owner.storeConnectionId ||
        row.account_channel_id !== null);
  if (mismatch) {
    throw databaseContractError(
      "Current registration provider account no longer matches its owner.",
    );
  }
}

function toRequiredStatusId(
  value: string | number | null,
  field: string,
): number {
  if (value === null || value === undefined) {
    throw databaseContractError(
      "A registered scope is missing a required publication, receipt, or account link.",
    );
  }
  return toSafeInteger(value, field);
}

function assertProviderAccountMatchesOwner(
  account: ProviderAccountRow,
  owner: ListingOwnerRef,
): void {
  const mismatch =
    account.owner_kind !== owner.kind ||
    account.provider !== owner.provider ||
    account.identity_scheme !== "provider_user_id" ||
    (owner.kind === "channel"
      ? account.channel_id !== owner.channelId ||
        account.store_connection_id !== null
      : account.store_connection_id !== owner.storeConnectionId ||
        account.channel_id !== null);
  if (mismatch) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_PROVIDER_ACCOUNT_ALREADY_OWNED",
      "The stable provider account identity is already claimed by another owner.",
      { ownerKind: owner.kind, productId: owner.productId },
    );
  }
}

function assertMatchingRequestHash(
  existing: RegistrationRow,
  requestHash: string,
  context: Readonly<Record<string, unknown>>,
): void {
  if (existing.request_hash !== requestHash) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_IDEMPOTENCY_CONFLICT",
      "Registration idempotency key was already used for a different request.",
      context,
    );
  }
}

function mapReceipt(row: RegistrationRow): ListingRegistrationReceipt {
  return listingRegistrationReceiptSchema.parse({
    registrationId: toSafeInteger(row.id, "registration.id"),
    scopeId: toSafeInteger(row.scope_id, "registration.scope_id"),
    providerAccountId: toSafeInteger(
      row.provider_account_id,
      "registration.provider_account_id",
    ),
    publicationId: toSafeInteger(
      row.publication_id,
      "registration.publication_id",
    ),
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    observationHash: row.observation_hash,
    desiredStateHash: row.desired_state_hash,
    observedAt: toDate(row.observed_at, "registration.observed_at"),
    registeredAt: toDate(row.registered_at, "registration.registered_at"),
  });
}

function ownerChanged(
  owner: ListingOwnerRef,
  message: string,
): MarketplaceListingRegistrationError {
  return new MarketplaceListingRegistrationError(
    "MARKETPLACE_LISTING_REGISTRATION_OWNER_CHANGED",
    message,
    { ownerKind: owner.kind, productId: owner.productId },
  );
}

function staleOwnerSnapshot(
  plan: ListingRegistrationPlan,
  message: string,
): MarketplaceListingRegistrationError {
  return new MarketplaceListingRegistrationError(
    "MARKETPLACE_LISTING_REGISTRATION_OWNER_SNAPSHOT_STALE",
    message,
    { ownerKind: plan.owner.kind, productId: plan.owner.productId },
  );
}

function databaseContractError(
  message: string,
): MarketplaceListingRegistrationError {
  return new MarketplaceListingRegistrationError(
    "MARKETPLACE_LISTING_REGISTRATION_DATABASE_CONTRACT_ERROR",
    message,
  );
}

function classifyReplayError(
  error: unknown,
  lookup: ListingRegistrationReplayLookup,
): MarketplaceListingRegistrationError {
  if (error instanceof MarketplaceListingRegistrationError) return error;
  const metadata = postgresMetadata(error);
  return new MarketplaceListingRegistrationError(
    "MARKETPLACE_LISTING_REGISTRATION_DATABASE_ERROR",
    "Registration replay lookup failed.",
    {
      ownerKind: lookup.owner.kind,
      productId: lookup.owner.productId,
      postgresCode: metadata.code,
      constraint: metadata.constraint,
    },
    { cause: error },
  );
}

function classifyStatusLookupError(
  error: unknown,
  owner: ListingOwnerRef,
): MarketplaceListingRegistrationError {
  if (error instanceof MarketplaceListingRegistrationError) return error;
  const metadata = postgresMetadata(error);
  return new MarketplaceListingRegistrationError(
    "MARKETPLACE_LISTING_REGISTRATION_DATABASE_ERROR",
    "Current registration status lookup failed.",
    {
      ownerKind: owner.kind,
      productId: owner.productId,
      postgresCode: metadata.code,
      constraint: metadata.constraint,
    },
    { cause: error },
  );
}

function classifyPersistenceError(
  error: unknown,
  plan: ListingRegistrationPlan,
): MarketplaceListingRegistrationError {
  if (error instanceof MarketplaceListingRegistrationError) return error;
  const metadata = postgresMetadata(error);
  if (metadata.code === "55P03") {
    return new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_CONCURRENT_UPDATE",
      "The owner, provider account, or listing scope is being registered concurrently.",
      { ownerKind: plan.owner.kind, productId: plan.owner.productId },
      { cause: error },
    );
  }
  if (
    metadata.code === "23505" &&
    metadata.constraint === "provider_accounts_global_identity_uq"
  ) {
    return new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_PROVIDER_ACCOUNT_ALREADY_OWNED",
      "The stable provider account identity was claimed concurrently.",
      { ownerKind: plan.owner.kind, productId: plan.owner.productId },
      { cause: error },
    );
  }
  if (
    metadata.code === "23505" &&
    metadata.constraint === "provider_identity_claims_account_identity_uq"
  ) {
    return new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_PROVIDER_IDENTITY_ALREADY_CLAIMED",
      "A provider listing identity is already claimed by another publication.",
      { ownerKind: plan.owner.kind, productId: plan.owner.productId },
      { cause: error },
    );
  }
  return new MarketplaceListingRegistrationError(
    "MARKETPLACE_LISTING_REGISTRATION_DATABASE_ERROR",
    "Marketplace listing registration could not be persisted.",
    {
      ownerKind: plan.owner.kind,
      productId: plan.owner.productId,
      postgresCode: metadata.code,
      constraint: metadata.constraint,
    },
    { cause: error },
  );
}

function postgresMetadata(error: unknown): {
  readonly code: string | null;
  readonly constraint: string | null;
} {
  if (typeof error !== "object" || error === null) {
    return { code: null, constraint: null };
  }
  const value = error as PostgresErrorShape;
  return {
    code: typeof value.code === "string" ? value.code : null,
    constraint: typeof value.constraint === "string" ? value.constraint : null,
  };
}

function rollbackFailureError(
  persistenceError: MarketplaceListingRegistrationError,
  rollbackError: unknown,
  plan: ListingRegistrationPlan,
): MarketplaceListingRegistrationError {
  const metadata = postgresMetadata(rollbackError);
  return new MarketplaceListingRegistrationError(
    "MARKETPLACE_LISTING_REGISTRATION_ROLLBACK_FAILED",
    "Listing registration failed and its marketplace transaction could not be rolled back safely.",
    {
      ownerKind: plan.owner.kind,
      productId: plan.owner.productId,
      persistenceErrorCode: persistenceError.code,
      rollbackPostgresCode: metadata.code,
      rollbackConstraint: metadata.constraint,
    },
    {
      cause: new AggregateError(
        [persistenceError, rollbackError],
        "Listing registration persistence and rollback both failed.",
      ),
    },
  );
}

async function rollbackTransaction(
  client: PoolClient,
): Promise<RollbackResult> {
  try {
    await client.query("ROLLBACK");
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function requiredRow<Row>(row: Row | undefined, message: string): Row {
  if (row !== undefined) return row;
  throw databaseContractError(message);
}

function toSafeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_DATABASE_VALUE_INVALID",
      "Database returned an invalid positive identifier.",
      { field },
    );
  }
  return parsed;
}

function toNonNegativeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_DATABASE_VALUE_INVALID",
      "Database returned an invalid count.",
      { field },
    );
  }
  return parsed;
}

function toDate(value: Date | string, field: string): Date {
  const parsed =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_DATABASE_VALUE_INVALID",
      "Database returned an invalid timestamp.",
      { field },
    );
  }
  return parsed;
}

function toRequiredStatusDate(
  value: Date | string | null,
  field: string,
): Date {
  if (value === null || value === undefined) {
    throw databaseContractError(
      "A registered scope is missing its registration timestamp.",
    );
  }
  return toDate(value, field);
}
