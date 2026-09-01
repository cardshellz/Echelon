import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipEbayListingPolicyOverride,
  DropshipEbayListingPolicyOverrideContext,
  DropshipEbayListingPolicyOverrideRepository,
  ReplaceDropshipEbayListingPolicyOverrideRepositoryInput,
  ReplaceDropshipEbayListingPolicyOverrideRepositoryResult,
} from "../application/dropship-ebay-listing-policy-override-service";
import { DropshipError } from "../domain/errors";

interface StoreContextRow {
  vendor_id: number;
  store_connection_id: number;
  platform: string;
  status: string;
}

interface AssignmentRow {
  product_variant_id: number;
  revision_id: number;
  fulfillment_policy_id: string | null;
  return_policy_id: string | null;
  payment_policy_id: string | null;
  updated_at: Date;
}

interface RevisionRow {
  id: number;
  request_hash: string;
  product_variant_id: number;
  fulfillment_policy_id: string | null;
  return_policy_id: string | null;
  payment_policy_id: string | null;
  created_at: Date;
}

export class PgDropshipEbayListingPolicyOverrideRepository
implements DropshipEbayListingPolicyOverrideRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async loadStoreContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipEbayListingPolicyOverrideContext | null> {
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
  }): Promise<DropshipEbayListingPolicyOverride[]> {
    if (input.productVariantIds && input.productVariantIds.length === 0) return [];
    const client = await this.dbPool.connect();
    try {
      return await listAssignmentsWithClient(client, input);
    } finally {
      client.release();
    }
  }

  async replaceAssignment(
    input: ReplaceDropshipEbayListingPolicyOverrideRepositoryInput,
  ): Promise<ReplaceDropshipEbayListingPolicyOverrideRepositoryResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('dropship_ebay_listing_policy_override'), $1::integer)",
        [input.storeConnectionId],
      );
      await this.assertWritableStore(client, input);

      const existingRevision = await client.query<RevisionRow>(
        `SELECT id, request_hash, product_variant_id, fulfillment_policy_id,
                return_policy_id, payment_policy_id, created_at
         FROM dropship.dropship_ebay_listing_policy_override_revisions
         WHERE vendor_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [input.vendorId, input.idempotencyKey],
      );
      if (existingRevision.rows[0]) {
        const revision = existingRevision.rows[0];
        if (revision.request_hash !== input.requestHash) {
          throw new DropshipError(
            "DROPSHIP_IDEMPOTENCY_CONFLICT",
            "eBay listing policy override idempotency key was reused with a different request.",
            { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId },
          );
        }
        await client.query("COMMIT");
        return {
          revisionId: revision.id,
          idempotentReplay: true,
          assignment: assignmentFromValues({
            productVariantId: revision.product_variant_id,
            revisionId: revision.id,
            fulfillmentPolicyId: revision.fulfillment_policy_id,
            returnPolicyId: revision.return_policy_id,
            paymentPolicyId: revision.payment_policy_id,
            updatedAt: revision.created_at,
          }),
        };
      }

      const variant = await client.query<{ id: number }>(
        "SELECT id FROM catalog.product_variants WHERE id = $1 LIMIT 1",
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
      const actualRevisionId = before?.revisionId ?? null;
      if (actualRevisionId !== input.expectedRevisionId) {
        throw new DropshipError(
          "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_VERSION_CONFLICT",
          "The listing policy override changed after it was loaded. Refresh and try again.",
          {
            vendorId: input.vendorId,
            storeConnectionId: input.storeConnectionId,
            productVariantId: input.productVariantId,
            expectedRevisionId: input.expectedRevisionId,
            actualRevisionId,
            retryable: false,
          },
        );
      }
      const revisionResult = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_ebay_listing_policy_override_revisions
          (vendor_id, store_connection_id, product_variant_id, idempotency_key,
           request_hash, fulfillment_policy_id, return_policy_id, payment_policy_id,
           actor_type, actor_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          input.vendorId,
          input.storeConnectionId,
          input.productVariantId,
          input.idempotencyKey,
          input.requestHash,
          input.fulfillmentPolicyId,
          input.returnPolicyId,
          input.paymentPolicyId,
          input.actor.actorType,
          input.actor.actorId,
          input.now,
        ],
      );
      const revisionId = revisionResult.rows[0]?.id;
      if (!revisionId) {
        throw new Error("eBay listing policy override revision insert did not return an id.");
      }

      const assignment = await persistAssignment(client, input, revisionId);
      await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type,
           actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, $2, 'dropship_ebay_listing_policy_override', $3,
                 'ebay_listing_policy_override_replaced', $4, $5, 'info', $6::jsonb, $7)`,
        [
          input.vendorId,
          input.storeConnectionId,
          String(input.productVariantId),
          input.actor.actorType,
          input.actor.actorId,
          JSON.stringify({
            revisionId,
            before: policySnapshot(before),
            after: policySnapshot(assignment),
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

  private async assertWritableStore(
    client: PoolClient,
    input: ReplaceDropshipEbayListingPolicyOverrideRepositoryInput,
  ): Promise<void> {
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
        "eBay listing policy overrides are available only for an eBay connection.",
        { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, platform: store.platform },
      );
    }
    if (store.status !== "connected") {
      throw new DropshipError(
        "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED",
        "Reconnect the eBay store before changing listing policy overrides.",
        { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, status: store.status },
      );
    }
  }
}

async function persistAssignment(
  client: PoolClient,
  input: ReplaceDropshipEbayListingPolicyOverrideRepositoryInput,
  revisionId: number,
): Promise<DropshipEbayListingPolicyOverride | null> {
  const next = assignmentFromValues({
    productVariantId: input.productVariantId,
    revisionId,
    fulfillmentPolicyId: input.fulfillmentPolicyId,
    returnPolicyId: input.returnPolicyId,
    paymentPolicyId: input.paymentPolicyId,
    updatedAt: input.now,
  });
  if (!next) {
    await client.query(
      `DELETE FROM dropship.dropship_ebay_listing_policy_overrides
       WHERE vendor_id = $1 AND store_connection_id = $2 AND product_variant_id = $3`,
      [input.vendorId, input.storeConnectionId, input.productVariantId],
    );
    return null;
  }
  const result = await client.query<AssignmentRow>(
    `INSERT INTO dropship.dropship_ebay_listing_policy_overrides
      (vendor_id, store_connection_id, product_variant_id, revision_id,
       fulfillment_policy_id, return_policy_id, payment_policy_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (store_connection_id, product_variant_id)
     DO UPDATE SET
       vendor_id = EXCLUDED.vendor_id,
       revision_id = EXCLUDED.revision_id,
       fulfillment_policy_id = EXCLUDED.fulfillment_policy_id,
       return_policy_id = EXCLUDED.return_policy_id,
       payment_policy_id = EXCLUDED.payment_policy_id,
       updated_at = EXCLUDED.updated_at
     RETURNING product_variant_id, revision_id, fulfillment_policy_id, return_policy_id,
               payment_policy_id, updated_at`,
    [
      input.vendorId,
      input.storeConnectionId,
      input.productVariantId,
      revisionId,
      input.fulfillmentPolicyId,
      input.returnPolicyId,
      input.paymentPolicyId,
      input.now,
    ],
  );
  if (!result.rows[0]) throw new Error("eBay listing policy override upsert did not return a row.");
  return mapAssignment(result.rows[0]);
}

async function listAssignmentsWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    productVariantIds?: readonly number[];
  },
): Promise<DropshipEbayListingPolicyOverride[]> {
  const params: unknown[] = [input.vendorId, input.storeConnectionId];
  const variantFilter = input.productVariantIds
    ? " AND product_variant_id = ANY($3::int[])"
    : "";
  if (input.productVariantIds) params.push(input.productVariantIds);
  const result = await client.query<AssignmentRow>(
    `SELECT product_variant_id, revision_id, fulfillment_policy_id, return_policy_id,
            payment_policy_id, updated_at
     FROM dropship.dropship_ebay_listing_policy_overrides
     WHERE vendor_id = $1 AND store_connection_id = $2${variantFilter}
     ORDER BY product_variant_id ASC`,
    params,
  );
  return result.rows.map(mapAssignment);
}

async function loadAssignmentForUpdate(
  client: PoolClient,
  input: { vendorId: number; storeConnectionId: number; productVariantId: number },
): Promise<DropshipEbayListingPolicyOverride | null> {
  const result = await client.query<AssignmentRow>(
    `SELECT product_variant_id, revision_id, fulfillment_policy_id, return_policy_id,
            payment_policy_id, updated_at
     FROM dropship.dropship_ebay_listing_policy_overrides
     WHERE vendor_id = $1 AND store_connection_id = $2 AND product_variant_id = $3
     FOR UPDATE`,
    [input.vendorId, input.storeConnectionId, input.productVariantId],
  );
  return result.rows[0] ? mapAssignment(result.rows[0]) : null;
}

function mapStoreContext(row: StoreContextRow): DropshipEbayListingPolicyOverrideContext {
  return {
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    status: row.status,
  };
}

function mapAssignment(row: AssignmentRow): DropshipEbayListingPolicyOverride {
  return {
    productVariantId: row.product_variant_id,
    revisionId: row.revision_id,
    fulfillmentPolicyId: row.fulfillment_policy_id,
    returnPolicyId: row.return_policy_id,
    paymentPolicyId: row.payment_policy_id,
    updatedAt: row.updated_at,
  };
}

function assignmentFromValues(input: DropshipEbayListingPolicyOverride): DropshipEbayListingPolicyOverride | null {
  return input.fulfillmentPolicyId === null
    && input.returnPolicyId === null
    && input.paymentPolicyId === null
    ? null
    : input;
}

function policySnapshot(input: DropshipEbayListingPolicyOverride | null): Record<string, string | null> | null {
  if (!input) return null;
  return {
    fulfillmentPolicyId: input.fulfillmentPolicyId,
    returnPolicyId: input.returnPolicyId,
    paymentPolicyId: input.paymentPolicyId,
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}
