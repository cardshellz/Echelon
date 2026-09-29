import type { PoolClient } from "pg";
import type { ListingRegistrationPlan } from "../domain/listing-registration-plan";
import { MarketplaceListingReplacementError } from "../domain/errors";
import type { ListingReplacementExecutionMember } from "../application/execution-ports";

export type ListingVerificationWrite = Pick<
  ListingRegistrationPlan,
  | "owner"
  | "idempotencyKey"
  | "requestHash"
  | "observationHash"
  | "desiredStateHash"
  | "providerPublicationKey"
  | "externalListingId"
  | "externalUrl"
  | "evidence"
  | "observedAt"
  | "requestedBy"
  | "correlationId"
> & {
  readonly members: readonly ListingReplacementExecutionMember[];
};

/** Caller owns the scope lock and transaction; neither historical publication nor
 * historical member rows may be rewritten when a provider listing changes. */
export async function appendListingVerification(
  client: PoolClient,
  scopeId: number,
  providerAccountId: number,
  sourcePublicationId: number,
  plan: ListingVerificationWrite,
  verifiedAt: Date,
): Promise<number> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO marketplace.listing_verification_snapshots (
       scope_id, product_id, source_publication_id, provider_account_id, idempotency_key,
       request_hash, observation_hash, desired_state_hash,
       provider_publication_key, external_listing_id, external_url, evidence,
       observed_at, verified_at, verified_by_type, verified_by_id,
       correlation_id, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
       $13, $14, $15, $16, $17, $14
     ) RETURNING id`,
    [
      scopeId,
      plan.owner.productId,
      sourcePublicationId,
      providerAccountId,
      plan.idempotencyKey,
      plan.requestHash,
      plan.observationHash,
      plan.desiredStateHash,
      plan.providerPublicationKey,
      plan.externalListingId,
      plan.externalUrl,
      JSON.stringify(plan.evidence),
      plan.observedAt,
      verifiedAt,
      plan.requestedBy.type,
      plan.requestedBy.id,
      plan.correlationId,
    ],
  );
  const verificationId = Number(result.rows[0]?.id);
  if (!Number.isSafeInteger(verificationId) || verificationId <= 0) {
    throw invalidWrite("Verification snapshot insert returned an invalid ID.");
  }
  const members = await client.query(
    `INSERT INTO marketplace.listing_verification_members (
       verification_id, product_id, product_variant_id, sku_snapshot, disposition,
       reason_code, external_variant_id, external_offer_id, external_inventory_item_id
     ) SELECT $1, $2, member.product_variant_id, member.sku_snapshot,
            member.disposition, member.reason_code, member.external_variant_id,
            member.external_offer_id, member.external_inventory_item_id
     FROM jsonb_to_recordset($3::jsonb) AS member(
       product_variant_id INTEGER, sku_snapshot TEXT, disposition TEXT, reason_code TEXT,
       external_variant_id TEXT, external_offer_id TEXT, external_inventory_item_id TEXT
     )`,
    [
      verificationId,
      plan.owner.productId,
      JSON.stringify(
        plan.members.map((member) => ({
          product_variant_id: member.productVariantId,
          sku_snapshot: member.skuSnapshot,
          disposition: member.disposition,
          reason_code: member.reasonCode,
          external_variant_id: member.externalVariantId,
          external_offer_id: member.externalOfferId,
          external_inventory_item_id: member.externalInventoryItemId,
        })),
      ),
    ],
  );
  if (members.rowCount !== plan.members.length) {
    throw invalidWrite("Verification member insert was incomplete.");
  }
  return verificationId;
}

function invalidWrite(message: string) {
  return new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_VERIFICATION_WRITE_INVALID",
    message,
  );
}
