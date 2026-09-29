import type { PoolClient } from "pg";
import type {
  ClaimedListingReplacementStep,
  ListingReplacementExecutionContext,
  ListingReplacementExecutionMember,
  ListingReplacementStepSuccess,
} from "../application/execution-ports";
import { sha256Canonical } from "../domain/canonical-hash";
import { MarketplaceListingReplacementError } from "../domain/errors";
import { appendListingVerification } from "./pg-listing-verification-writer";

interface VerificationRow {
  id: string;
  source_publication_id: string;
  desired_state_hash: string;
  provider_publication_key: string | null;
  external_listing_id: string;
  verified_at: Date;
}

async function latestVerification(client: PoolClient, scopeId: number) {
  const result = await client.query<VerificationRow>(
    `SELECT id, source_publication_id, desired_state_hash, provider_publication_key,
       external_listing_id, verified_at FROM marketplace.listing_verification_snapshots
     WHERE scope_id = $1 ORDER BY verified_at DESC, id DESC LIMIT 1`,
    [scopeId],
  );
  return result.rows[0] ?? null;
}

/** Used only for compensation, never to rewrite a sealed forward execution plan. */
export async function withVerifiedRecoverySource(
  client: PoolClient,
  scopeId: number,
  operationCreatedAt: Date | string,
  context: ListingReplacementExecutionContext,
): Promise<ListingReplacementExecutionContext> {
  const verified = await latestVerification(client, scopeId);
  if (!verified) return { ...context, sourceVerification: null };
  if (
    Number(verified.source_publication_id) !==
    context.sourcePublication.publicationId
  ) {
    throw recoveryConflict(
      "The active source changed after replacement planning.",
    );
  }
  if (
    verified.provider_publication_key !==
    context.sourcePublication.providerPublicationKey
  ) {
    throw recoveryConflict(
      "Source group changed; the abandoned target cannot be inferred from a different group.",
    );
  }
  const createdAt = new Date(operationCreatedAt).getTime();
  const verifiedAt = new Date(verified.verified_at).getTime();
  if (!Number.isFinite(createdAt) || !Number.isFinite(verifiedAt)) {
    throw recoveryConflict("Recovery provenance timestamps are invalid.");
  }
  const members = await client.query<ListingReplacementExecutionMember>(
    `SELECT product_variant_id AS "productVariantId", sku_snapshot AS "skuSnapshot",
       disposition, reason_code AS "reasonCode", external_variant_id AS "externalVariantId",
       external_offer_id AS "externalOfferId", external_inventory_item_id AS "externalInventoryItemId"
     FROM marketplace.listing_verification_members WHERE verification_id = $1
     ORDER BY product_variant_id`,
    [verified.id],
  );
  if (!members.rows.some((member) => member.disposition === "included")) {
    throw recoveryConflict("Verified recovery source has no included members.");
  }
  return {
    ...context,
    sourceVerification: {
      id: safeId(verified.id),
      readOnlyRecovery: verifiedAt > createdAt,
    },
    sourcePublication: {
      ...context.sourcePublication,
      desiredStateHash: verified.desired_state_hash,
      providerPublicationKey: verified.provider_publication_key,
      externalListingId: verified.external_listing_id,
    },
    sourceMembers: members.rows,
  };
}

/** The scope and operation remain locked by the caller until both verification
 * and terminal audit events commit. A concurrent correction invalidates this claim. */
export async function appendRecoveredSourceVerification(
  client: PoolClient,
  scopeId: number,
  claim: ClaimedListingReplacementStep,
  result: ListingReplacementStepSuccess,
  at: Date,
): Promise<number> {
  const context = claim.operation;
  const latest = await latestVerification(client, scopeId);
  if (
    (latest ? safeId(latest.id) : null) !==
    (context.sourceVerification?.id ?? null)
  ) {
    throw recoveryConflict(
      "Source verification changed during recovery. Read it again before retrying.",
    );
  }
  const binding = await client.query<{ provider_account_id: string }>(
    `SELECT binding.provider_account_id FROM marketplace.listing_scope_provider_accounts binding
     JOIN marketplace.listing_publications publication ON publication.scope_id = binding.scope_id
     WHERE binding.scope_id = $1 AND publication.id = $2 AND publication.status = 'active'`,
    [scopeId, context.sourcePublication.publicationId],
  );
  if (binding.rows.length !== 1)
    throw recoveryConflict(
      "Recovery source must have one active account-bound publication.",
    );
  const listingId = result.externalListingId?.trim();
  const identities = result.memberIdentities ?? [];
  const included = context.sourceMembers.filter(
    (member) => member.disposition === "included",
  );
  if (
    !listingId ||
    included.length === 0 ||
    included.length !== identities.length ||
    new Set(identities.map((identity) => identity.productVariantId)).size !==
      identities.length ||
    included.some(
      (member) =>
        !identities.some(
          (identity) =>
            identity.productVariantId === member.productVariantId &&
            identity.externalOfferId?.trim() &&
            identity.externalInventoryItemId === member.skuSnapshot,
        ),
    )
  ) {
    throw recoveryConflict(
      "Provider recovery returned incomplete source identities.",
    );
  }
  if (
    result.providerPublicationKey !==
    context.sourcePublication.providerPublicationKey
  ) {
    throw recoveryConflict(
      "Provider recovery returned a different source group.",
    );
  }
  if (
    context.sourceVerification?.readOnlyRecovery &&
    (listingId !== context.sourcePublication.externalListingId ||
      result.evidence.recoveryMode !== "verified_source_read_only" ||
      result.evidence.sourceVerificationId !== context.sourceVerification.id ||
      result.evidence.targetGroupAbsent !== true ||
      included.some(
        (member) =>
          !identities.some(
            (identity) =>
              identity.productVariantId === member.productVariantId &&
              identity.externalOfferId === member.externalOfferId,
          ),
      ))
  ) {
    throw recoveryConflict(
      "Read-only recovery did not prove the verified listing and absent target.",
    );
  }
  const members = context.sourceMembers.map((member) => {
    const identity = identities.find(
      (entry) => entry.productVariantId === member.productVariantId,
    );
    return {
      ...member,
      externalVariantId: identity?.externalVariantId ?? null,
      externalOfferId: identity?.externalOfferId ?? null,
      externalInventoryItemId: identity?.externalInventoryItemId ?? null,
    };
  });
  return appendListingVerification(
    client,
    scopeId,
    safeId(binding.rows[0].provider_account_id),
    context.sourcePublication.publicationId,
    {
      owner: context.owner,
      idempotencyKey: `replacement-recovery:${context.operationId}`,
      requestHash: claim.requestHash,
      observationHash: sha256Canonical({
        listingId,
        members,
        evidence: result.evidence,
      }),
      desiredStateHash: context.sourcePublication.desiredStateHash,
      providerPublicationKey: result.providerPublicationKey,
      externalListingId: listingId,
      externalUrl: result.externalUrl ?? null,
      evidence: {
        ...result.evidence,
        operationId: context.operationId,
        previousVerificationId: context.sourceVerification?.id ?? null,
      },
      observedAt: at,
      requestedBy: claim.executor,
      correlationId: context.correlationId,
      members,
    },
    at,
  );
}

function safeId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw recoveryConflict("Recovery provenance ID is invalid.");
  return id;
}

function recoveryConflict(message: string) {
  return new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_REPLACEMENT_RECOVERY_VERIFICATION_CONFLICT",
    message,
  );
}
