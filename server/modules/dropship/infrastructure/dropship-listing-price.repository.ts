import type { Pool, PoolClient } from "pg";
import type { ListingPriceTarget, ListingPricingMode, SaveListingPriceInput, SavedListingPriceRevision } from "../../../../shared/dropship/listing-price";
import type { ListingPriceRepository, ListingPriceTransaction } from "../application/dropship-listing-price-service";
import { DropshipError } from "../domain/errors";
import { pool as defaultPool } from "../../../db";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import { loadListingRulePrices } from "./dropship-rule-price.loader";
import { PgShellzClubProductCostAdapter } from "./shellz-club-product-cost.adapter";

interface PriceRow {
  product_variant_id: number; revision_id: number; override_price_cents: number | null; updated_at: Date;
  pricing_mode?: ListingPricingMode | null;
}
interface RevisionRow extends PriceRow { request_hash: string; store_connection_id: number }
type Client = Pick<PoolClient, "query">;

export class PgDropshipListingPriceRepository implements ListingPriceRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async execute<T>(input: ListingPriceTarget & { memberId: string; idempotencyKey?: string },
    operation: (transaction: ListingPriceTransaction) => Promise<T>): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      if (input.idempotencyKey) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_price_request'), hashtext($1))",
          [`${input.memberId}:${input.idempotencyKey}`]);
      }
      // Shared with queue creation, so a save cannot slip between its revision
      // check and immutable job snapshot. Store scope also serializes first saves.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)", [input.storeConnectionId]);
      const owner = await client.query<{ vendor_id: number }>(
        `SELECT v.id AS vendor_id FROM dropship.dropship_vendors v
         JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
         WHERE v.member_id::text = $1 AND sc.id = $2 FOR SHARE OF v, sc`,
        [input.memberId, input.storeConnectionId]);
      const vendorId = owner.rows[0]?.vendor_id;
      if (!vendorId) throw new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.");
      if (input.idempotencyKey) {
        // Keep selection/exposure stable while authorizing and saving. These
        // short SHARE locks block admin rule replacement and insertion phantoms,
        // not concurrent catalog reads. The repository performs no remote work.
        await client.query(`LOCK TABLE dropship.dropship_catalog_rules,
          dropship.dropship_vendor_selection_rules, dropship.dropship_vendor_variant_overrides,
          catalog.product_line_products IN SHARE MODE`);
        await client.query(`SELECT pv.id FROM catalog.product_variants pv
          JOIN catalog.products p ON p.id = pv.product_id WHERE pv.id = $1 FOR SHARE OF pv, p`, [input.productVariantId]);
      }
      const result = await operation(listingPriceTransactionForClient(client, { ...input, vendorId }));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original transaction failure. */ }
      throw error;
    } finally { client.release(); }
  }
}

/**
 * The price transaction for one size on a client that already holds this file's
 * locks (request key when keyed, store, owner rows, selection SHARE locks and the
 * size FOR SHARE; see execute). It takes no lock itself. Its key guards accept only
 * `target.idempotencyKey`, so a caller that shares its client (PR 8's listing-settings
 * transaction, plan D29) controls which key may write.
 */
export function listingPriceTransactionForClient(client: Client,
  target: ListingPriceTarget & { vendorId: number; memberId: string; idempotencyKey?: string }): ListingPriceTransaction {
  return {
    vendorId: target.vendorId, catalog: PgDropshipListingPreviewRepository.readerForTransaction(client),
    loadSaved: () => loadSaved(client, target),
    loadRulePrice: async (candidate) => (await loadListingRulePrices(client, {
      vendorId: target.vendorId, storeConnectionId: target.storeConnectionId, candidates: [candidate],
    })).get(candidate.productVariantId) ?? null,
    loadProductCost: (candidate) => loadProductCost(client, target.vendorId, candidate.productVariantId),
    loadReplay: (replayInput) => {
      if (!target.idempotencyKey || replayInput.idempotencyKey !== target.idempotencyKey) {
        throw new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT", "Price writes require the transaction's original save key.");
      }
      return findReplay(client, target, replayInput);
    },
    save: (saveInput) => {
      if (!target.idempotencyKey || saveInput.idempotencyKey !== target.idempotencyKey) {
        throw new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT", "Price writes require the transaction's original save key.");
      }
      return saveWithClient(client, target, saveInput);
    },
  };
}

async function loadSaved(client: Client, input: ListingPriceTarget & { vendorId: number }): Promise<SavedListingPriceRevision | null> {
  const result = await client.query<PriceRow>(`SELECT product_variant_id, revision_id, override_price_cents, pricing_mode, updated_at
    FROM dropship.dropship_listing_price_settings
    WHERE vendor_id = $1 AND store_connection_id = $2 AND product_variant_id = $3 FOR UPDATE`,
    [input.vendorId, input.storeConnectionId, input.productVariantId]);
  return result.rows[0] ? mapSaved(result.rows[0]) : null;
}

async function loadProductCost(client: Client, vendorId: number, productVariantId: number) {
  const costs = await PgShellzClubProductCostAdapter.forTransaction(client).loadProductCosts({ vendorId, productVariantIds: [productVariantId] });
  return costs.get(productVariantId) ?? null;
}

/** The revision an earlier save with this key wrote; a key reused for another change is a conflict. */
async function findReplay(client: Client, target: ListingPriceTarget & { vendorId: number },
  input: { idempotencyKey: string; requestHash: string }): Promise<SavedListingPriceRevision | null> {
  const replay = await client.query<RevisionRow>(`SELECT id AS revision_id, product_variant_id,
    store_connection_id, override_price_cents, pricing_mode, created_at AS updated_at, request_hash
    FROM dropship.dropship_listing_price_revisions WHERE vendor_id = $1 AND idempotency_key = $2`,
    [target.vendorId, input.idempotencyKey]);
  const revision = replay.rows[0];
  if (!revision) return null;
  if (revision.request_hash !== input.requestHash || revision.store_connection_id !== target.storeConnectionId
    || revision.product_variant_id !== target.productVariantId) {
    throw new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT", "This save key was already used for a different price change.");
  }
  return mapSaved(revision);
}

async function saveWithClient(client: Client,
  target: ListingPriceTarget & { vendorId: number; memberId: string },
  input: SaveListingPriceInput & { requestHash: string; now: Date }): Promise<{ saved: SavedListingPriceRevision; idempotentReplay: boolean }> {
  // Replay the operation's saved revision, never overwrite a later edit.
  const replay = await findReplay(client, target, input);
  if (replay) return { saved: replay, idempotentReplay: true };
  const before = await loadSaved(client, target);
  if ((before?.revisionId ?? null) !== input.expectedRevisionId) {
    throw new DropshipError("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", "This listing price changed after you opened it. Reload the price before saving again.", {
      expectedRevisionId: input.expectedRevisionId, actualRevisionId: before?.revisionId ?? null,
    });
  }
  const revision = await client.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_price_revisions
    (vendor_id, store_connection_id, product_variant_id, previous_revision_id, override_price_cents,
     idempotency_key, request_hash, actor_id, created_at, pricing_mode)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [target.vendorId, target.storeConnectionId, target.productVariantId, before?.revisionId ?? null,
      input.priceCents, input.idempotencyKey, input.requestHash, target.memberId, input.now,
      input.pricingMode ?? (input.priceCents === null ? "catalog_default" : "fixed")]);
  const revisionId = revision.rows[0]?.id;
  if (!revisionId) throw new Error("Listing price revision insert returned no identity.");
  await client.query(`INSERT INTO dropship.dropship_listing_price_settings
    (vendor_id, store_connection_id, product_variant_id, revision_id, override_price_cents, updated_at, pricing_mode)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (store_connection_id, product_variant_id) DO UPDATE SET
      revision_id = EXCLUDED.revision_id, override_price_cents = EXCLUDED.override_price_cents, updated_at = EXCLUDED.updated_at,
      pricing_mode = EXCLUDED.pricing_mode`,
    [target.vendorId, target.storeConnectionId, target.productVariantId, revisionId, input.priceCents, input.now,
      input.pricingMode ?? (input.priceCents === null ? "catalog_default" : "fixed")]);
  const saved: SavedListingPriceRevision = { productVariantId: target.productVariantId, revisionId, overridePriceCents: input.priceCents,
    pricingMode: input.pricingMode ?? (input.priceCents === null ? "catalog_default" : "fixed"), updatedAt: input.now.toISOString() };
  await client.query(`INSERT INTO dropship.dropship_audit_events
    (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
    VALUES ($1,$2,'dropship_listing_price_setting',$3,'listing_price_saved','vendor',$4,'info',$5::jsonb,$6)`,
    [target.vendorId, target.storeConnectionId, String(target.productVariantId), target.memberId,
      JSON.stringify({ before, after: saved }), input.now]);
  return { saved, idempotentReplay: false };
}
function mapSaved(row: PriceRow): SavedListingPriceRevision {
  return { productVariantId: row.product_variant_id, revisionId: row.revision_id,
    overridePriceCents: row.override_price_cents, updatedAt: row.updated_at.toISOString(),
    ...(row.pricing_mode ? { pricingMode: row.pricing_mode } : {}) };
}
