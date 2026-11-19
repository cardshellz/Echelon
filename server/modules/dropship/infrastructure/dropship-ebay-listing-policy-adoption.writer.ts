import type { PoolClient } from "pg";
import type { PolicyField } from "../domain/marketplace-sync-decision";
import { marketplaceSyncError, MARKETPLACE_SYNC_CODES } from "../domain/marketplace-sync-errors";
import { MARKETPLACE_SYNC_ACTOR } from "../domain/marketplace-sync-keys";
import { POLICY_FEATURE_LOCK_SQL } from "./dropship-listing-setting-leftovers.repository";

/**
 * eBay sync-back's writer of one size's business policy row (plan v4 §4.2,
 * §6.5 step 6, owner rule 4): the shipping, return and payment policy the
 * vendor chose on a live eBay listing are kept as the size's own (migration
 * 217's dropship_ebay_listing_policy_override_revisions and _overrides, the
 * rows the listing preview already reads), so the next push sends them back
 * instead of the product's or the store's.
 *
 * - Runs on the caller's client inside the adoption transaction, after the
 *   caller's store, owner and listing locks; it takes the policy feature lock
 *   first, as the leftovers clean-up does after its store lock, so the two
 *   never wait on each other in opposite orders.
 * - Revisions are immutable and keyed (UNIQUE (vendor_id, idempotency_key)):
 *   a replayed key writes nothing; a key used for another change is a defect.
 * - Only the changed ids move; the others keep the size's current value (or none).
 * - One audit row per revision, actor system, with the before and after ids.
 *
 * Accepted consequence (plan v4 R4): the size row shadows a later product or
 * category policy change until that change's leftovers clean-up clears it, as
 * it does for every size row today.
 */
type Client = Pick<PoolClient, "query">;

export interface ListingPolicyIds {
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
}

export type ListingPolicyAdoption =
  | { kind: "saved"; revisionId: number; before: ListingPolicyIds | null; after: ListingPolicyIds }
  | { kind: "replayed"; revisionId: number };

/** A policy id as the columns allow it: 1 to 100 characters, no surrounding spaces, no line breaks. */
const POLICY_ID_PATTERN = /^\S(?:[^\r\n]{0,98}\S)?$/;
const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/;

export async function adoptListingPolicyRowWithClient(client: Client, input: {
  vendorId: number; storeConnectionId: number; productVariantId: number; changes: Partial<Record<PolicyField, string>>;
  idempotencyKey: string; requestHash: string; now: Date;
}): Promise<ListingPolicyAdoption> {
  const changes = Object.entries(input.changes);
  if (changes.length === 0 || changes.some(([field, value]) => !["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"].includes(field)
    || typeof value !== "string" || !POLICY_ID_PATTERN.test(value)) || !REQUEST_HASH_PATTERN.test(input.requestHash)) {
    throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "A sync-back policy adoption was called outside its contract.", "fatal",
      { storeConnectionId: input.storeConnectionId, productVariantId: input.productVariantId });
  }
  await client.query(POLICY_FEATURE_LOCK_SQL, [input.storeConnectionId]);
  const replay = await client.query<{ id: number; store_connection_id: number; product_variant_id: number; request_hash: string }>(`
    SELECT id, store_connection_id, product_variant_id, request_hash
    FROM dropship.dropship_ebay_listing_policy_override_revisions WHERE vendor_id = $1 AND idempotency_key = $2`,
  [input.vendorId, input.idempotencyKey]);
  const replayed = replay.rows[0];
  if (replayed) {
    if (replayed.store_connection_id !== input.storeConnectionId || replayed.product_variant_id !== input.productVariantId
      || replayed.request_hash !== input.requestHash) {
      throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "A sync-back policy key was used for another change.", "fatal",
        { storeConnectionId: input.storeConnectionId, productVariantId: input.productVariantId });
    }
    return { kind: "replayed", revisionId: replayed.id };
  }
  const current = await client.query<{ fulfillment_policy_id: string | null; return_policy_id: string | null; payment_policy_id: string | null }>(`
    SELECT fulfillment_policy_id, return_policy_id, payment_policy_id FROM dropship.dropship_ebay_listing_policy_overrides
    WHERE vendor_id = $1 AND store_connection_id = $2 AND product_variant_id = $3 FOR UPDATE`,
  [input.vendorId, input.storeConnectionId, input.productVariantId]);
  const row = current.rows[0];
  const before: ListingPolicyIds | null = row
    ? { fulfillmentPolicyId: row.fulfillment_policy_id, returnPolicyId: row.return_policy_id, paymentPolicyId: row.payment_policy_id }
    : null;
  const after: ListingPolicyIds = {
    fulfillmentPolicyId: input.changes.fulfillmentPolicyId ?? before?.fulfillmentPolicyId ?? null,
    returnPolicyId: input.changes.returnPolicyId ?? before?.returnPolicyId ?? null,
    paymentPolicyId: input.changes.paymentPolicyId ?? before?.paymentPolicyId ?? null,
  };
  const revision = await client.query<{ id: number }>(`INSERT INTO dropship.dropship_ebay_listing_policy_override_revisions
      (vendor_id, store_connection_id, product_variant_id, idempotency_key, request_hash,
       fulfillment_policy_id, return_policy_id, payment_policy_id, actor_type, actor_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
  [input.vendorId, input.storeConnectionId, input.productVariantId, input.idempotencyKey, input.requestHash,
    after.fulfillmentPolicyId, after.returnPolicyId, after.paymentPolicyId, MARKETPLACE_SYNC_ACTOR.actorType, MARKETPLACE_SYNC_ACTOR.actorId,
    input.now]);
  const revisionId = revision.rows[0]?.id;
  if (!revisionId) throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "Policy revision insert returned no identity.", "fatal");
  await client.query(`INSERT INTO dropship.dropship_ebay_listing_policy_overrides
      (vendor_id, store_connection_id, product_variant_id, revision_id, fulfillment_policy_id, return_policy_id, payment_policy_id,
       created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
    ON CONFLICT (store_connection_id, product_variant_id) DO UPDATE SET revision_id = EXCLUDED.revision_id,
      fulfillment_policy_id = EXCLUDED.fulfillment_policy_id, return_policy_id = EXCLUDED.return_policy_id,
      payment_policy_id = EXCLUDED.payment_policy_id, updated_at = EXCLUDED.updated_at`,
  [input.vendorId, input.storeConnectionId, input.productVariantId, revisionId,
    after.fulfillmentPolicyId, after.returnPolicyId, after.paymentPolicyId, input.now]);
  await client.query(`INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
    VALUES ($1, $2, 'dropship_ebay_listing_policy_override', $3, 'ebay_listing_policy_override_replaced', $4, $5, 'info', $6::jsonb, $7)`,
  [input.vendorId, input.storeConnectionId, String(input.productVariantId), MARKETPLACE_SYNC_ACTOR.actorType, MARKETPLACE_SYNC_ACTOR.actorId,
    JSON.stringify({ revisionId, before, after, requestKey: input.idempotencyKey, source: "ebay_sync_back" }), input.now]);
  return { kind: "saved", revisionId, before, after };
}
