import type { Pool } from "pg";
import type { ChannelPublicationStatusRequest } from "@shared/types/inventory-channel-publication-status";
import type { ChannelPublicationStatusReader } from "../application/inventory-channel-publication-status.service";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import { loadManagedSellableVariantIds } from "./inventory-channel-exposure-runtime.repository";

/** A read-only snapshot. No provider dependency, activation, or mutable claim access. */
export class PostgresChannelPublicationStatusReader implements ChannelPublicationStatusReader {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async read(request: ChannelPublicationStatusRequest): Promise<unknown> {
    const client = await this.pool.connect();
    let discardConnection = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '8s'");
      const context = (await client.query<{ revision: string; authority: string; captured_at: Date }>(`
        SELECT target.revision::text, authority.authority, transaction_timestamp() AS captured_at
        FROM inventory.inventory_publication_targets target
        CROSS JOIN inventory.availability_runtime_authority authority
        WHERE target.id=$1 AND authority.singleton_key=true`, [request.publicationTargetId])).rows[0];
      if (!context) throw new InventoryAvailabilityMasterDataError(
        404, "PUBLICATION_STATUS_CONTEXT_NOT_FOUND", "The destination or inventory authority is unavailable.",
      );
      const product = await client.query("SELECT id FROM catalog.products WHERE id=$1", [request.productId]);
      if (!product.rowCount) throw new InventoryAvailabilityMasterDataError(
        404, "PUBLICATION_STATUS_PRODUCT_NOT_FOUND", "The product no longer exists.",
      );
      const variantIds = await loadManagedSellableVariantIds(client, request.productId);
      // Bound one operator response; do not silently truncate a product's evidence.
      if (variantIds.length > 1_000) throw new InventoryAvailabilityMasterDataError(
        422, "PUBLICATION_STATUS_PRODUCT_TOO_LARGE", "This product has too many SKUs for a single status view.",
      );
      const result = await client.query<{ row: unknown }>(`
        SELECT jsonb_build_object(
          'productVariantId', variant.id,
          'activeInventoryItemId', mapping.external_inventory_item_id,
          'desired', CASE WHEN desired.id IS NULL THEN NULL ELSE jsonb_build_object(
            'outboxId',desired.id::text,'revision',desired.desired_revision::text,
            'quantity',desired.desired_quantity::text,'state',desired.state,
            'targetRevision',desired.publication_target_revision_snapshot::text,
            'createdAt',desired.created_at) END,
          'acknowledged', CASE WHEN acknowledged.id IS NULL THEN NULL ELSE jsonb_build_object(
            'outboxId',acknowledged.id::text,'quantity',acknowledged.desired_quantity::text,
            'acknowledgedAt',acknowledged.acknowledged_at) END,
          'observed', CASE WHEN observed.id IS NULL THEN NULL ELSE jsonb_build_object(
            'quantity',observed.observed_quantity::text,'observedAt',observed.observed_at,
            'outboxId',observed.outbox_id::text,'matchesDesired',observed.matches_desired,
            'targetRevision',observed.publication_target_revision_snapshot::text) END
        ) AS row
        FROM unnest($2::integer[]) AS variant(id)
        JOIN inventory.inventory_publication_targets target ON target.id=$1
        LEFT JOIN inventory.publication_variant_mapping_heads head
          ON head.publication_target_id=target.id AND head.product_variant_id=variant.id
        LEFT JOIN inventory.publication_variant_mapping_versions mapping
          ON mapping.id=head.active_mapping_id AND mapping.lifecycle_status='sealed'
        LEFT JOIN LATERAL (
          SELECT outbox.* FROM inventory.inventory_publication_outbox outbox
          WHERE ${outboxIdentity}
          ORDER BY outbox.desired_revision DESC LIMIT 1
        ) desired ON true
        LEFT JOIN LATERAL (
          SELECT outbox.* FROM inventory.inventory_publication_outbox outbox
          WHERE ${outboxIdentity} AND outbox.acknowledged_at IS NOT NULL
          ORDER BY outbox.acknowledged_at DESC, outbox.id DESC LIMIT 1
        ) acknowledged ON true
        LEFT JOIN LATERAL (
          SELECT readback.* FROM inventory.inventory_publication_readbacks readback
          WHERE readback.publication_target_id=target.id AND readback.product_variant_id=variant.id
            AND readback.external_inventory_item_id_snapshot=mapping.external_inventory_item_id
            AND readback.destination_kind_snapshot=target.destination_kind
            AND readback.channel_connection_id_snapshot IS NOT DISTINCT FROM target.channel_connection_id
            AND readback.dropship_store_connection_id_snapshot IS NOT DISTINCT FROM target.dropship_store_connection_id
            AND readback.provider_scope_type_snapshot=target.provider_scope_type
            AND readback.external_scope_id_snapshot=target.external_scope_id
          ORDER BY readback.observed_at DESC, readback.id DESC LIMIT 1
        ) observed ON true
        ORDER BY variant.id`, [request.publicationTargetId, variantIds]);
      await client.query("COMMIT");
      return {
        ...request,
        capturedAt: context.captured_at.toISOString(),
        runtimeAuthority: context.authority,
        targetRevision: context.revision,
        rows: result.rows.map(entry => entry.row),
      };
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) {
        // A failed rollback cannot return an unknown transaction to the pool.
        discardConnection = true;
        throw new AggregateError([error, rollbackError], "Publication status read and rollback failed.");
      }
      throw error;
    } finally { client.release(discardConnection); }
  }
}

// Exact active identity only. Draft remaps and another account/location's old
// observations must not masquerade as delivery evidence for this destination.
const outboxIdentity = `outbox.publication_target_id=target.id AND outbox.product_variant_id=variant.id
  AND outbox.external_inventory_item_id_snapshot=mapping.external_inventory_item_id
  AND outbox.external_sku_snapshot IS NOT DISTINCT FROM mapping.external_sku
  AND outbox.destination_kind_snapshot=target.destination_kind
  AND outbox.channel_connection_id_snapshot IS NOT DISTINCT FROM target.channel_connection_id
  AND outbox.dropship_store_connection_id_snapshot IS NOT DISTINCT FROM target.dropship_store_connection_id
  AND outbox.provider_scope_type_snapshot=target.provider_scope_type
  AND outbox.external_scope_id_snapshot=target.external_scope_id`;
