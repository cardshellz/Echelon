import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { pool as defaultPool } from "../../../db";
import { pricingImpactRowSchema, reviewPricingRulesInputSchema, type ApplyPricingRulesInput } from "../../../../shared/dropship/pricing-rules";
import type { PricingRulesRepository, PricingRulesTransaction, StoredPricingReview } from "../application/dropship-pricing-rules-service";
import { pricingHash } from "../application/dropship-rule-price";
import { DropshipError } from "../domain/errors";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import { readPricingProfile } from "./dropship-pricing-profile.reader";
import { PgShellzClubProductCostAdapter } from "./shellz-club-product-cost.adapter";

export class PgDropshipPricingRulesRepository implements PricingRulesRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async execute<T>(memberId: string, storeConnectionId: number, operation: (tx: PricingRulesTransaction) => Promise<T>): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      // One source snapshot includes selection, existing settings and membership
      // cost reads. Concurrent write conflicts fail explicitly, never half apply.
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)", [storeConnectionId]);
      const owner = await client.query<{ vendor_id: number }>(
        `SELECT v.id AS vendor_id FROM dropship.dropship_vendors v
         JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
         WHERE v.member_id::text = $1 AND sc.id = $2 FOR SHARE OF v, sc`, [memberId, storeConnectionId]);
      const vendorId = owner.rows[0]?.vendor_id;
      if (!vendorId) throw new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.");
      const target = { vendorId, storeConnectionId, memberId };
      const result = await operation({ vendorId,
        catalog: PgDropshipListingPreviewRepository.readerForTransaction(client),
        costs: PgShellzClubProductCostAdapter.forTransaction(client),
        listProductLines: async (ids) => (await client.query<{ id: number; name: string }>(
          `SELECT id, name FROM catalog.product_lines WHERE id = ANY($1::int[]) ORDER BY name, id`, [ids])).rows,
        listVariantIds: async (afterId, limit) => (await client.query<{ id: number }>(
          `SELECT id FROM catalog.product_variants WHERE id > $1 AND requires_shipping = true
           AND COALESCE(track_inventory, true) = true AND sales_eligibility = 'sellable'
           ORDER BY id LIMIT $2`, [afterId, limit])).rows.map((row) => row.id),
        loadProfile: () => readPricingProfile(client, storeConnectionId, vendorId),
        storeReview: async (review) => {
          await client.query(`INSERT INTO dropship.dropship_pricing_reviews
            (id, vendor_id, store_connection_id, input, rows, review_hash, actor_id, created_at)
            VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`,
            [review.id, vendorId, storeConnectionId, JSON.stringify(review.input), JSON.stringify(review.rows), review.hash, memberId, review.createdAt]);
        },
        loadReview: async (id) => {
          const result = await client.query<{ id: string; input: unknown; rows: unknown; review_hash: string; created_at: Date }>(
            `SELECT id, input, rows, review_hash, created_at FROM dropship.dropship_pricing_reviews
             WHERE id = $1 AND vendor_id = $2 AND store_connection_id = $3`, [id, vendorId, storeConnectionId]);
          const row = result.rows[0];
          if (!row) return null;
          const input = reviewPricingRulesInputSchema.safeParse(row.input);
          const rows = z.array(pricingImpactRowSchema).max(10_000).safeParse(row.rows);
          if (!input.success || !rows.success) throw new Error("Persisted pricing review failed its contract.");
          return { id: row.id, input: input.data, rows: rows.data, hash: row.review_hash, createdAt: row.created_at };
        },
        findApplication: (input) => findApplication(client, target, input),
        applyReview: (review, input, now) => applyReview(client, target, review, input, now),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Keep the original failure. */ }
      if (error && typeof error === "object" && "code" in error && ["40001", "40P01"].includes(String(error.code))) {
        throw new DropshipError("DROPSHIP_PRICING_REVIEW_STALE", "A concurrent pricing or catalog change occurred. Retry the review before applying.");
      }
      throw error;
    } finally { client.release(); }
  }
}
interface Target { vendorId: number; storeConnectionId: number; memberId: string }
async function findApplication(client: PoolClient, target: Target, input: ApplyPricingRulesInput): Promise<{ revisionId: number } | null> {
  const result = await client.query<{ revision_id: number; request_hash: string; store_connection_id: number }>(
    `SELECT revision_id, request_hash, store_connection_id FROM dropship.dropship_pricing_applications
     WHERE vendor_id = $1 AND (idempotency_key = $2 OR review_id = $3)`, [target.vendorId, input.idempotencyKey, input.reviewId]);
  if (!result.rows.length) return null;
  if (result.rows.length !== 1 || result.rows[0].request_hash !== pricingHash(input)
    || result.rows[0].store_connection_id !== target.storeConnectionId) {
    throw new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT", "This review or apply key was already used. Reload the current store rules.");
  }
  return { revisionId: result.rows[0].revision_id };
}
async function applyReview(client: PoolClient, target: Target, review: StoredPricingReview, input: ApplyPricingRulesInput, now: Date): Promise<number> {
  const result = await client.query<{ id: number }>(`INSERT INTO dropship.dropship_pricing_profile_revisions
    (vendor_id, store_connection_id, previous_revision_id, profile, actor_id, created_at)
    VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING id`,
    [target.vendorId, target.storeConnectionId, review.input.expectedRevisionId, JSON.stringify(review.input.profile), target.memberId, now]);
  const revisionId = result.rows[0]?.id;
  if (!revisionId) throw new Error("Pricing profile revision insert returned no identity.");
  await client.query(`INSERT INTO dropship.dropship_pricing_profiles (vendor_id, store_connection_id, revision_id)
    VALUES ($1,$2,$3) ON CONFLICT (store_connection_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`,
    [target.vendorId, target.storeConnectionId, revisionId]);
  const adoption = review.rows.filter((row) => !row.preserved).map((row) => ({
    variant_id: row.productVariantId, previous_id: row.settingRevisionId,
    request_key: `pricing-rule:${review.id}:${row.productVariantId}`,
    request_hash: pricingHash({ reviewHash: review.hash, productVariantId: row.productVariantId }),
  }));
  if (adoption.length) {
    // Set-based writes: adopting 1,000 listings does not make 1,000 HTTP calls
    // or issue thousands of individual revision/setting INSERTs.
    const revisions = await client.query<{ id: number; product_variant_id: number }>(
      `INSERT INTO dropship.dropship_listing_price_revisions
        (vendor_id, store_connection_id, product_variant_id, previous_revision_id, override_price_cents,
         pricing_mode, idempotency_key, request_hash, actor_id, created_at)
       SELECT $1,$2,x.variant_id,x.previous_id,NULL,'rules',x.request_key,x.request_hash,$3,$4
       FROM jsonb_to_recordset($5::jsonb) AS x(variant_id integer, previous_id integer, request_key text, request_hash text)
       RETURNING id, product_variant_id`, [target.vendorId, target.storeConnectionId, target.memberId, now, JSON.stringify(adoption)]);
    await client.query(`INSERT INTO dropship.dropship_listing_price_settings
      (vendor_id, store_connection_id, product_variant_id, revision_id, override_price_cents, pricing_mode, updated_at)
      SELECT $1,$2,x.product_variant_id,x.id,NULL,'rules',$3
      FROM jsonb_to_recordset($4::jsonb) AS x(id integer, product_variant_id integer)
      ON CONFLICT (store_connection_id, product_variant_id) DO UPDATE SET revision_id = EXCLUDED.revision_id,
        override_price_cents = NULL, pricing_mode = 'rules', updated_at = EXCLUDED.updated_at`,
      [target.vendorId, target.storeConnectionId, now, JSON.stringify(revisions.rows)]);
  }
  await client.query(`INSERT INTO dropship.dropship_pricing_applications
    (review_id, vendor_id, store_connection_id, revision_id, idempotency_key, request_hash, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [review.id, target.vendorId, target.storeConnectionId, revisionId, input.idempotencyKey, pricingHash(input), now]);
  await client.query(`INSERT INTO dropship.dropship_audit_events
    (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
    VALUES ($1,$2,'dropship_pricing_profile',$3,'pricing_rules_applied','vendor',$4,'info',$5::jsonb,$6)`,
    [target.vendorId, target.storeConnectionId, String(revisionId), target.memberId,
      JSON.stringify({ beforeRevisionId: review.input.expectedRevisionId, revisionId, reviewId: review.id, reviewHash: review.hash,
        adoptedCount: adoption.length, preservedCount: review.rows.length - adoption.length, marketplaceWrite: false }), now]);
  return revisionId;
}
