import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import type { ContentRepository, ContentTransaction } from "../application/dropship-listing-content-service";
import { DropshipError } from "../domain/errors";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import { readContentProfile, readListingContentSettings } from "./dropship-listing-content.reader";

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
      const loadProfile = () => readContentProfile(client, vendorId, input.storeConnectionId);
      const loadSaved = async (id: number) => (await readListingContentSettings(client, vendorId, input.storeConnectionId, [id])).get(id) ?? null;
      const assertWrite = (key: string) => {
        if (!input.idempotencyKey || input.idempotencyKey !== key) throw new Error("Content write requires its transaction's original request key.");
      };
      const audit = async (kind: string, entityId: number, before: unknown, after: unknown, now: Date) => {
        await client.query(`INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
          VALUES ($1,$2,$3,$4,'listing_content_saved','vendor',$5,'info',$6::jsonb,$7)`,
        [vendorId, input.storeConnectionId, kind, String(entityId), input.memberId, JSON.stringify({ before, after }), now]);
      };
      const result = await operation({
        vendorId, catalog: PgDropshipListingPreviewRepository.readerForTransaction(client), loadProfile, loadSaved,
        listProductLines: async (ids) => (await client.query<{ id: number; name: string }>(
          "SELECT id, name FROM catalog.product_lines WHERE id = ANY($1::int[]) ORDER BY name, id", [ids])).rows,
        listVariantIds: async (afterId, limit) => (await client.query<{ id: number }>(
          `SELECT id FROM catalog.product_variants WHERE id > $1 AND requires_shipping = true
           AND COALESCE(track_inventory, true) = true AND sales_eligibility = 'sellable' ORDER BY id LIMIT $2`, [afterId, limit])).rows.map((row) => row.id),
        findReplay: async (kind, key, hash) => {
          // Table names are a closed application-owned enum, never request text.
          const table = kind === "profile" ? "dropship_content_profile_revisions" : "dropship_listing_content_revisions";
          const replay = await client.query<{ request_hash: string; store_connection_id: number }>(
            `SELECT request_hash, store_connection_id FROM dropship.${table} WHERE vendor_id = $1 AND idempotency_key = $2`, [vendorId, key]);
          if (!replay.rows[0]) return false;
          if (replay.rows[0].request_hash !== hash || replay.rows[0].store_connection_id !== input.storeConnectionId) {
            throw new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT", "This save key was already used for a different content change.");
          }
          return true;
        },
        saveProfile: async (save, hash, now) => {
          assertWrite(save.idempotencyKey);
          const before = await loadProfile();
          const revision = await client.query<{ id: number }>(`INSERT INTO dropship.dropship_content_profile_revisions
            (vendor_id, store_connection_id, previous_revision_id, profile, idempotency_key, request_hash, actor_id, created_at)
            VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING id`,
          [vendorId, input.storeConnectionId, save.expectedRevisionId, JSON.stringify(save.profile), save.idempotencyKey, hash, input.memberId, now]);
          const id = revision.rows[0]?.id;
          if (!id) throw new Error("Content template revision insert returned no identity.");
          await client.query(`INSERT INTO dropship.dropship_content_profiles (vendor_id, store_connection_id, revision_id)
            VALUES ($1,$2,$3) ON CONFLICT (store_connection_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`, [vendorId, input.storeConnectionId, id]);
          await audit("dropship_content_profile", input.storeConnectionId, before, await loadProfile(), now);
        },
        saveListing: async (variantId, save, hash, now) => {
          assertWrite(save.idempotencyKey);
          if (variantId !== input.productVariantId) throw new Error("Content write target differs from its locked listing.");
          const before = await loadSaved(variantId);
          const revision = await client.query<{ id: number }>(`INSERT INTO dropship.dropship_listing_content_revisions
            (vendor_id, store_connection_id, product_variant_id, previous_revision_id, custom_text, catalog_hash,
             profile_revision_id, idempotency_key, request_hash, actor_id, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [vendorId, input.storeConnectionId, variantId, save.expectedRevisionId, save.customText, save.expectedCatalogHash,
            save.expectedProfileRevisionId, save.idempotencyKey, hash, input.memberId, now]);
          const id = revision.rows[0]?.id;
          if (!id) throw new Error("Listing content revision insert returned no identity.");
          await client.query(`INSERT INTO dropship.dropship_listing_content_settings (vendor_id, store_connection_id, product_variant_id, revision_id)
            VALUES ($1,$2,$3,$4) ON CONFLICT (store_connection_id, product_variant_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`,
          [vendorId, input.storeConnectionId, variantId, id]);
          await audit("dropship_listing_content_setting", variantId, before, await loadSaved(variantId), now);
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
