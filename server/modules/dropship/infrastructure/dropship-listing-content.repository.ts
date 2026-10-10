import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type { SaveContentProfileInput, SaveListingContentInput } from "../../../../shared/dropship/listing-content";
import { contentConflict, type ContentRepository, type ContentTransaction } from "../application/dropship-listing-content-service";
import { DropshipError } from "../domain/errors";
import { selectedCatalogReaderForTransaction } from "./dropship-selected-catalog.reader";
import { readContentProfile, readListingContentSettings } from "./dropship-listing-content.reader";

type Client = Pick<PoolClient, "query">;
/** Whose content is written, and who writes it (audited as a vendor). */
export interface ContentWriteTarget { vendorId: number; storeConnectionId: number; actorId: string }

export class PgDropshipListingContentRepository implements ContentRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}
  async execute<T>(input: Parameters<ContentRepository["execute"]>[0], operation: (tx: ContentTransaction) => Promise<T>): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      if (input.idempotencyKey) await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_content_request'), hashtext($1))", [`${input.memberId}:${input.idempotencyKey}`]);
      // Same lock as queue creation and price saves: content cannot change between
      // the queue's evidence check and immutable payload insertion.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)", [input.storeConnectionId]);
      const owner = await client.query<{ vendor_id: number }>(`SELECT v.id AS vendor_id FROM dropship.dropship_vendors v
        JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
        WHERE v.member_id::text = $1 AND sc.id = $2 FOR SHARE OF v, sc`, [input.memberId, input.storeConnectionId]);
      const vendorId = owner.rows[0]?.vendor_id;
      if (!vendorId) throw new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.");
      if (input.productVariantId) {
        await client.query(`LOCK TABLE dropship.dropship_catalog_rules, dropship.dropship_vendor_selection_rules,
          dropship.dropship_vendor_variant_overrides, catalog.product_line_products IN SHARE MODE`);
        await client.query(`SELECT pv.id FROM catalog.product_variants pv JOIN catalog.products p ON p.id = pv.product_id
          WHERE pv.id = $1 FOR SHARE OF pv, p`, [input.productVariantId]);
      }
      const target: ContentWriteTarget = { vendorId, storeConnectionId: input.storeConnectionId, actorId: input.memberId };
      const loadProfile = () => readContentProfile(client, vendorId, input.storeConnectionId);
      const loadSaved = (id: number) => loadSavedContent(client, target, id);
      const assertWrite = (key: string) => {
        if (!input.idempotencyKey || input.idempotencyKey !== key) throw new Error("Content write requires its transaction's original request key.");
      };
      const result = await operation({
        vendorId, ...selectedCatalogReaderForTransaction(client), loadProfile, loadSaved,
        findReplay: (kind, key, hash) => findContentReplayWithClient(client, target, kind, key, hash),
        saveProfile: async (save, hash, now) => {
          assertWrite(save.idempotencyKey);
          await saveContentProfileWithClient(client, target, save, hash, now);
        },
        saveListing: async (variantId, save, hash, now) => {
          assertWrite(save.idempotencyKey);
          if (variantId !== input.productVariantId) throw new Error("Content write target differs from its locked listing.");
          await saveListingContentWithClient(client, target, variantId, save, hash, now);
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally { client.release(); }
  }
}

/** True when this key already saved this exact request; throws when the key saved another one or another store's. */
export async function findContentReplayWithClient(client: Client, target: Pick<ContentWriteTarget, "vendorId" | "storeConnectionId">,
  kind: "profile" | "listing", key: string, hash: string): Promise<boolean> {
  // Table names are a closed application-owned enum, never request text.
  const table = kind === "profile" ? "dropship_content_profile_revisions" : "dropship_listing_content_revisions";
  const replay = await client.query<{ request_hash: string; store_connection_id: number }>(
    `SELECT request_hash, store_connection_id FROM dropship.${table} WHERE vendor_id = $1 AND idempotency_key = $2`, [target.vendorId, key]);
  if (!replay.rows[0]) return false;
  if (replay.rows[0].request_hash !== hash || replay.rows[0].store_connection_id !== target.storeConnectionId) {
    throw new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT", "This save key was already used for a different content change.");
  }
  return true;
}

/**
 * Writes the store's description templates and their audit row. The caller holds
 * the store lock and the owner rows (see execute) and checks the request key; this
 * takes no lock. A stale expected revision is DROPSHIP_CONTENT_VERSION_CONFLICT
 * before any write, so a reused caller gets the 409 rather than the trigger's 23514.
 */
export async function saveContentProfileWithClient(client: Client, target: ContentWriteTarget,
  save: SaveContentProfileInput, hash: string, now: Date): Promise<void> {
  const before = await readContentProfile(client, target.vendorId, target.storeConnectionId);
  if (before.revisionId !== save.expectedRevisionId) throw contentConflict();
  const revision = await client.query<{ id: number }>(`INSERT INTO dropship.dropship_content_profile_revisions
    (vendor_id, store_connection_id, previous_revision_id, profile, idempotency_key, request_hash, actor_id, created_at)
    VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING id`,
  [target.vendorId, target.storeConnectionId, save.expectedRevisionId, JSON.stringify(save.profile), save.idempotencyKey, hash, target.actorId, now]);
  const id = revision.rows[0]?.id;
  if (!id) throw new Error("Content template revision insert returned no identity.");
  await client.query(`INSERT INTO dropship.dropship_content_profiles (vendor_id, store_connection_id, revision_id)
    VALUES ($1,$2,$3) ON CONFLICT (store_connection_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`, [target.vendorId, target.storeConnectionId, id]);
  await insertContentAudit(client, target, "dropship_content_profile", target.storeConnectionId, before,
    await readContentProfile(client, target.vendorId, target.storeConnectionId), now);
}

/**
 * Writes one size's description and its audit row. The caller holds the store lock,
 * the owner rows and the size's catalog lock (see execute) and checks the request
 * key and target; this takes no lock. A stale expected revision is
 * DROPSHIP_CONTENT_VERSION_CONFLICT before any write.
 */
export async function saveListingContentWithClient(client: Client, target: ContentWriteTarget, variantId: number,
  save: SaveListingContentInput, hash: string, now: Date): Promise<void> {
  const before = await loadSavedContent(client, target, variantId);
  if ((before?.revisionId ?? null) !== save.expectedRevisionId) throw contentConflict();
  const revision = await client.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_content_revisions
    (vendor_id, store_connection_id, product_variant_id, previous_revision_id, custom_text, catalog_hash,
     profile_revision_id, idempotency_key, request_hash, actor_id, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
  [target.vendorId, target.storeConnectionId, variantId, save.expectedRevisionId, save.customText, save.expectedCatalogHash,
    save.expectedProfileRevisionId, save.idempotencyKey, hash, target.actorId, now]);
  const id = revision.rows[0]?.id;
  if (!id) throw new Error("Listing content revision insert returned no identity.");
  await client.query(`INSERT INTO dropship.dropship_listing_content_settings (vendor_id, store_connection_id, product_variant_id, revision_id)
    VALUES ($1,$2,$3,$4) ON CONFLICT (store_connection_id, product_variant_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`,
  [target.vendorId, target.storeConnectionId, variantId, id]);
  await insertContentAudit(client, target, "dropship_listing_content_setting", variantId, before,
    await loadSavedContent(client, target, variantId), now);
}

async function loadSavedContent(client: Client, target: Pick<ContentWriteTarget, "vendorId" | "storeConnectionId">, variantId: number) {
  return (await readListingContentSettings(client, target.vendorId, target.storeConnectionId, [variantId])).get(variantId) ?? null;
}

async function insertContentAudit(client: Client, target: ContentWriteTarget, kind: string, entityId: number,
  before: unknown, after: unknown, now: Date): Promise<void> {
  await client.query(`INSERT INTO dropship.dropship_audit_events
    (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
    VALUES ($1,$2,$3,$4,'listing_content_saved','vendor',$5,'info',$6::jsonb,$7)`,
  [target.vendorId, target.storeConnectionId, kind, String(entityId), target.actorId, JSON.stringify({ before, after }), now]);
}
