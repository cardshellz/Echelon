import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  DropshipEbayStoreCategoryAssignment,
  DropshipEbayStoreCategoryContext,
  DropshipEbayStoreCategoryRepository,
  ReplaceDropshipEbayStoreCategoryAssignmentRepositoryInput,
  ReplaceDropshipEbayStoreCategoryAssignmentRepositoryResult,
} from "../application/dropship-ebay-store-category-service";

interface StoreContextRow {
  vendor_id: number;
  store_connection_id: number;
  platform: string;
  status: string;
}

interface AssignmentRow {
  product_variant_id: number;
  store_category_ids: unknown;
  store_category_names: unknown;
  updated_at: Date;
}

interface RevisionRow {
  id: number;
  request_hash: string;
  store_category_ids: unknown;
  store_category_names: unknown;
  created_at: Date;
}

export class PgDropshipEbayStoreCategoryRepository implements DropshipEbayStoreCategoryRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async loadStoreContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipEbayStoreCategoryContext | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<StoreContextRow>(
        `SELECT vendor_id, id AS store_connection_id, platform, status
         FROM dropship.dropship_store_connections
         WHERE vendor_id = $1 AND id = $2
         LIMIT 1`,
        [input.vendorId, input.storeConnectionId],
      );
      return result.rows[0] ? mapStoreContext(result.rows[0]) : null;
    } finally {
      client.release();
    }
  }

  async listAssignments(input: {
    vendorId: number;
    storeConnectionId: number;
    productVariantIds?: readonly number[];
  }): Promise<DropshipEbayStoreCategoryAssignment[]> {
    if (input.productVariantIds && input.productVariantIds.length === 0) {
      return [];
    }
    const client = await this.dbPool.connect();
    try {
      return await listAssignmentsWithClient(client, input);
    } finally {
      client.release();
    }
  }

  async replaceAssignment(
    input: ReplaceDropshipEbayStoreCategoryAssignmentRepositoryInput,
  ): Promise<ReplaceDropshipEbayStoreCategoryAssignmentRepositoryResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('dropship_ebay_store_category_assignment'), $1::integer)",
        [input.storeConnectionId],
      );

      const lockedStore = await client.query<Pick<StoreContextRow, "platform" | "status">>(
        `SELECT platform, status
         FROM dropship.dropship_store_connections
         WHERE vendor_id = $1 AND id = $2
         FOR SHARE`,
        [input.vendorId, input.storeConnectionId],
      );
      const store = lockedStore.rows[0];
      if (!store) {
        throw new DropshipError(
          "DROPSHIP_STORE_CONNECTION_REQUIRED",
          "Dropship store connection was not found.",
          { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId },
        );
      }
      if (store.platform !== "ebay") {
        throw new DropshipError(
          "DROPSHIP_EBAY_STORE_REQUIRED",
          "eBay Store categories are available only for an eBay connection.",
          { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, platform: store.platform },
        );
      }
      if (store.status !== "connected") {
        throw new DropshipError(
          "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED",
          "Reconnect the eBay store before loading or changing Store categories.",
          { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, status: store.status },
        );
      }

      const existingRevision = await client.query<RevisionRow>(
        `SELECT id, request_hash, store_category_ids, store_category_names, created_at
         FROM dropship.dropship_ebay_store_category_assignment_revisions
         WHERE vendor_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [input.vendorId, input.idempotencyKey],
      );
      if (existingRevision.rows[0]) {
        const revision = existingRevision.rows[0];
        if (revision.request_hash !== input.requestHash) {
          throw new DropshipError(
            "DROPSHIP_IDEMPOTENCY_CONFLICT",
            "eBay Store category idempotency key was reused with a different request.",
            { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId },
          );
        }
        await client.query("COMMIT");
        const storeCategoryIds = parseStringArray(revision.store_category_ids, "store_category_ids");
        const storeCategoryNames = parseStringArray(revision.store_category_names, "store_category_names");
        return {
          revisionId: revision.id,
          idempotentReplay: true,
          assignment: storeCategoryIds.length === 0 ? null : {
            productVariantId: input.productVariantId,
            storeCategoryIds,
            storeCategoryNames,
            updatedAt: revision.created_at,
          },
        };
      }

      const variant = await client.query<{ id: number }>(
        `SELECT id FROM catalog.product_variants WHERE id = $1 LIMIT 1`,
        [input.productVariantId],
      );
      if (!variant.rows[0]) {
        throw new DropshipError(
          "DROPSHIP_CATALOG_VARIANT_NOT_FOUND",
          "Catalog product variant was not found.",
          { productVariantId: input.productVariantId },
        );
      }

      const before = await loadAssignmentForUpdate(client, input);
      const revisionResult = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_ebay_store_category_assignment_revisions
          (vendor_id, store_connection_id, product_variant_id, idempotency_key,
           request_hash, store_category_ids, store_category_names, actor_type, actor_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
         RETURNING id`,
        [
          input.vendorId,
          input.storeConnectionId,
          input.productVariantId,
          input.idempotencyKey,
          input.requestHash,
          JSON.stringify(input.storeCategoryIds),
          JSON.stringify(input.storeCategoryNames),
          input.actor.actorType,
          input.actor.actorId,
          input.now,
        ],
      );
      const revisionId = revisionResult.rows[0]?.id;
      if (!revisionId) {
        throw new Error("eBay Store category assignment revision insert did not return an id.");
      }

      let assignment: DropshipEbayStoreCategoryAssignment | null;
      if (input.storeCategoryIds.length === 0) {
        await client.query(
          `DELETE FROM dropship.dropship_ebay_store_category_assignments
           WHERE vendor_id = $1 AND store_connection_id = $2 AND product_variant_id = $3`,
          [input.vendorId, input.storeConnectionId, input.productVariantId],
        );
        assignment = null;
      } else {
        const result = await client.query<AssignmentRow>(
          `INSERT INTO dropship.dropship_ebay_store_category_assignments
            (vendor_id, store_connection_id, product_variant_id, revision_id,
             store_category_ids, store_category_names, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $7)
           ON CONFLICT (store_connection_id, product_variant_id)
           DO UPDATE SET
             vendor_id = EXCLUDED.vendor_id,
             revision_id = EXCLUDED.revision_id,
             store_category_ids = EXCLUDED.store_category_ids,
             store_category_names = EXCLUDED.store_category_names,
             updated_at = EXCLUDED.updated_at
           RETURNING product_variant_id, store_category_ids, store_category_names, updated_at`,
          [
            input.vendorId,
            input.storeConnectionId,
            input.productVariantId,
            revisionId,
            JSON.stringify(input.storeCategoryIds),
            JSON.stringify(input.storeCategoryNames),
            input.now,
          ],
        );
        if (!result.rows[0]) {
          throw new Error("eBay Store category assignment upsert did not return a row.");
        }
        assignment = mapAssignment(result.rows[0]);
      }

      await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type,
           actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, $2, 'dropship_ebay_store_category_assignment', $3,
                 'ebay_store_category_assignment_replaced', $4, $5, 'info', $6::jsonb, $7)`,
        [
          input.vendorId,
          input.storeConnectionId,
          String(input.productVariantId),
          input.actor.actorType,
          input.actor.actorId,
          JSON.stringify({
            revisionId,
            before: before ? {
              storeCategoryIds: before.storeCategoryIds,
              storeCategoryNames: before.storeCategoryNames,
            } : null,
            after: assignment ? {
              storeCategoryIds: assignment.storeCategoryIds,
              storeCategoryNames: assignment.storeCategoryNames,
            } : null,
          }),
          input.now,
        ],
      );
      await client.query("COMMIT");
      return { assignment, revisionId, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function listAssignmentsWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    productVariantIds?: readonly number[];
  },
): Promise<DropshipEbayStoreCategoryAssignment[]> {
  const params: unknown[] = [input.vendorId, input.storeConnectionId];
  const variantFilter = input.productVariantIds
    ? " AND product_variant_id = ANY($3::int[])"
    : "";
  if (input.productVariantIds) params.push(input.productVariantIds);
  const result = await client.query<AssignmentRow>(
    `SELECT product_variant_id, store_category_ids, store_category_names, updated_at
     FROM dropship.dropship_ebay_store_category_assignments
     WHERE vendor_id = $1 AND store_connection_id = $2${variantFilter}
     ORDER BY product_variant_id ASC`,
    params,
  );
  return result.rows.map(mapAssignment);
}

async function loadAssignmentForUpdate(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    productVariantId: number;
  },
): Promise<DropshipEbayStoreCategoryAssignment | null> {
  const result = await client.query<AssignmentRow>(
    `SELECT product_variant_id, store_category_ids, store_category_names, updated_at
     FROM dropship.dropship_ebay_store_category_assignments
     WHERE vendor_id = $1 AND store_connection_id = $2 AND product_variant_id = $3
     FOR UPDATE`,
    [input.vendorId, input.storeConnectionId, input.productVariantId],
  );
  return result.rows[0] ? mapAssignment(result.rows[0]) : null;
}

function mapStoreContext(row: StoreContextRow): DropshipEbayStoreCategoryContext {
  return {
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    status: row.status,
  };
}

function mapAssignment(row: AssignmentRow): DropshipEbayStoreCategoryAssignment {
  const storeCategoryIds = parseStringArray(row.store_category_ids, "store_category_ids");
  const storeCategoryNames = parseStringArray(row.store_category_names, "store_category_names");
  if (storeCategoryIds.length !== storeCategoryNames.length) {
    throw new Error("Persisted eBay Store category ids and names are inconsistent.");
  }
  return {
    productVariantId: row.product_variant_id,
    storeCategoryIds,
    storeCategoryNames,
    updatedAt: row.updated_at,
  };
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 2) {
    throw new Error(`Persisted ${field} must be an array of at most two values.`);
  }
  const values = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Persisted ${field} must contain non-empty strings.`);
    }
    return item.trim();
  });
  if (new Set(values).size !== values.length) {
    throw new Error(`Persisted ${field} must contain unique values.`);
  }
  return values;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}
