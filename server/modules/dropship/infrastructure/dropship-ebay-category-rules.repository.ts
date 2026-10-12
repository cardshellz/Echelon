import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  versionConflict,
  type EbayCategoryRulesRepository,
  type EbayCategoryRulesTransaction,
  type SaveEbayCategoryRulesProfileInput,
} from "../application/dropship-ebay-category-rules-service";
import { DropshipError } from "../domain/errors";
import { readEbayCategoryRules } from "./dropship-ebay-category-rules.reader";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import { selectedCatalogReaderForTransaction } from "./dropship-selected-catalog.reader";

export class PgDropshipEbayCategoryRulesRepository implements EbayCategoryRulesRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async execute<T>(
    input: Parameters<EbayCategoryRulesRepository["execute"]>[0],
    operation: (tx: EbayCategoryRulesTransaction) => Promise<T>,
  ): Promise<T> {
    const writing = input.mode === "write";
    if (writing && !input.idempotencyKey) throw new Error("An eBay category rules write requires its request key.");
    const client = await this.dbPool.connect();
    try {
      if (writing) {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_ebay_category_rules_request'), hashtext($1))",
          [`${input.memberId}:${input.idempotencyKey}`]);
        // Same store lock as queue creation and price and description saves: rules
        // cannot change between a queue's evidence re-check and its immutable insert.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)", [input.storeConnectionId]);
      } else {
        // Reads take no store lock: a long review scan must not block listing queues.
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      }
      // Row locks are refused in a read-only transaction, so only writes pin the owner rows.
      const owner = await client.query<{ vendor_id: number }>(`SELECT v.id AS vendor_id FROM dropship.dropship_vendors v
        JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
        WHERE v.member_id::text = $1 AND sc.id = $2${writing ? " FOR SHARE OF v, sc" : ""}`, [input.memberId, input.storeConnectionId]);
      const vendorId = owner.rows[0]?.vendor_id;
      if (!vendorId) {
        throw new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.",
          { storeConnectionId: input.storeConnectionId });
      }
      const loadState = () => readEbayCategoryRules(client, vendorId, input.storeConnectionId);
      const result = await operation({
        vendorId,
        ...selectedCatalogReaderForTransaction(client),
        loadState,
        loadStoreListingConfig: () => PgDropshipListingPreviewRepository.readerForTransaction(client)
          .getStoreListingConfig(input.storeConnectionId),
        findReplay: (idempotencyKey, requestHash) => findEbayCategoryRulesReplayWithClient(client,
          { vendorId, storeConnectionId: input.storeConnectionId }, idempotencyKey, requestHash),
        saveProfile: async (save) => {
          if (!writing || save.idempotencyKey !== input.idempotencyKey) {
            throw new Error("eBay category rules can only be written by the write transaction of their own request key.");
          }
          await saveEbayCategoryRulesProfileWithClient(client,
            { vendorId, storeConnectionId: input.storeConnectionId, actorId: input.memberId }, save);
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

/** True when this key already saved this exact request; throws when the key saved another one or another store's. */
export async function findEbayCategoryRulesReplayWithClient(client: Pick<PoolClient, "query">,
  target: { vendorId: number; storeConnectionId: number }, idempotencyKey: string, requestHash: string): Promise<boolean> {
  const replay = await client.query<{ request_hash: string; store_connection_id: number }>(
    `SELECT request_hash, store_connection_id FROM dropship.dropship_ebay_category_rule_revisions
     WHERE vendor_id = $1 AND idempotency_key = $2`, [target.vendorId, idempotencyKey]);
  const row = replay.rows[0];
  if (!row) return false;
  if (row.request_hash !== requestHash || row.store_connection_id !== target.storeConnectionId) {
    throw new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT",
      "This save key was already used for a different eBay category change.", { storeConnectionId: target.storeConnectionId });
  }
  return true;
}

/**
 * Writes a new rules revision, points the store at it and audits before and after.
 * The caller holds the push-job store lock and the owner rows (see execute) and
 * checks the request key; this takes no lock. A stale expected revision is
 * DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT before any write.
 */
export async function saveEbayCategoryRulesProfileWithClient(client: Pick<PoolClient, "query">,
  target: { vendorId: number; storeConnectionId: number; actorId: string },
  save: SaveEbayCategoryRulesProfileInput): Promise<{ revisionId: number }> {
  const before = await readEbayCategoryRules(client, target.vendorId, target.storeConnectionId);
  if (before.revisionId !== save.expectedRevisionId) throw versionConflict(target.storeConnectionId);
  const revision = await client.query<{ id: number }>(`INSERT INTO dropship.dropship_ebay_category_rule_revisions
    (vendor_id, store_connection_id, previous_revision_id, profile, idempotency_key, request_hash, actor_id, created_at)
    VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING id`,
  [target.vendorId, target.storeConnectionId, save.expectedRevisionId, JSON.stringify(save.profile), save.idempotencyKey,
    save.requestHash, target.actorId, save.now]);
  const revisionId = revision.rows[0]?.id;
  if (!revisionId) throw new Error("eBay category rules revision insert returned no identity.");
  await client.query(`INSERT INTO dropship.dropship_ebay_category_rule_profiles (vendor_id, store_connection_id, revision_id)
    VALUES ($1,$2,$3) ON CONFLICT (store_connection_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`,
  [target.vendorId, target.storeConnectionId, revisionId]);
  await client.query(`INSERT INTO dropship.dropship_audit_events
    (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
    VALUES ($1,$2,'dropship_ebay_category_rules',$3,'ebay_category_rules_saved','vendor',$4,'info',$5::jsonb,$6)`,
  [target.vendorId, target.storeConnectionId, String(target.storeConnectionId), target.actorId, JSON.stringify({
    revisionId, previousRevisionId: before.revisionId, before: before.profile, after: save.profile,
  }), save.now]);
  return { revisionId };
}
