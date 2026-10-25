import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import {
  quantityPublicationScopeSchema,
  type QuantityPublicationScope,
} from "../domain/quantity-publication-admission";
import { quantityPublicationScopeLockKey } from "./quantity-publication-admission.repository";

interface ScopeBinding {
  productVariantId: number;
  scopeKey: string;
}
interface IdentityRow {
  product_variant_id: number;
  provider_key: string;
  provider_scope_type: string;
  external_scope_id: string;
  external_inventory_item_id: string;
  external_sku: string | null;
}
const MAX_RETAINED_IDENTITIES = 10_000;

/** Use the quantity owner's exact publication scope key, which deliberately excludes
 * optional Catalog hints. Retain old mappings/outbox identities so remapping
 * cannot make an outstanding request disappear. This reads evidence only. */
export async function readStockClearingScopeBindings(
  client: StockSelectionQueryClient,
  input: {
    destinationKind: QuantityPublicationScope["destinationKind"];
    connectionId: number;
    providerKey: QuantityPublicationScope["providerKey"];
    productVariantIds: readonly number[];
  },
): Promise<ScopeBinding[]> {
  const rows = (
    await client.query<IdentityRow>(
      `SELECT DISTINCT m.product_variant_id,$4::text provider_key,t.provider_scope_type,t.external_scope_id,
       m.external_inventory_item_id,m.external_sku
     FROM inventory.publication_variant_mapping_versions m
     JOIN inventory.inventory_publication_targets t ON t.id=m.publication_target_id
     WHERE t.destination_kind=$1 AND COALESCE(t.channel_connection_id,t.dropship_store_connection_id)=$2
       AND m.product_variant_id=ANY($3::int[]) AND m.lifecycle_status IN ('sealed','retired')
     UNION SELECT DISTINCT o.product_variant_id,o.provider_key_snapshot,o.provider_scope_type_snapshot,
       o.external_scope_id_snapshot,o.external_inventory_item_id_snapshot,o.external_sku_snapshot
     FROM inventory.inventory_publication_outbox o
     WHERE o.destination_kind_snapshot=$1 AND COALESCE(o.channel_connection_id_snapshot,o.dropship_store_connection_id_snapshot)=$2
       AND o.product_variant_id=ANY($3::int[]) AND o.provider_key_snapshot IS NOT NULL
       AND o.provider_scope_type_snapshot IS NOT NULL AND o.external_inventory_item_id_snapshot IS NOT NULL
     LIMIT $5`,
      [
        input.destinationKind,
        input.connectionId,
        input.productVariantIds,
        input.providerKey,
        MAX_RETAINED_IDENTITIES + 1,
      ],
    )
  ).rows;
  if (rows.length > MAX_RETAINED_IDENTITIES)
    throw new Error(
      "Stock clearing identity history exceeds the supported evidence bound.",
    );
  const bindings = new Map<string, ScopeBinding>();
  for (const row of rows)
    for (const item of new Set([
      row.external_inventory_item_id,
      row.external_sku,
    ])) {
      if (item === null) continue;
      const scope = quantityPublicationScopeSchema.parse({
        destinationKind: input.destinationKind,
        connectionId: input.connectionId,
        providerKey: row.provider_key,
        providerScopeType: row.provider_scope_type,
        externalScopeId: row.external_scope_id,
        externalInventoryItemId: item,
        productId: null,
        productVariantId: row.product_variant_id,
      });
      const scopeKey = quantityPublicationScopeLockKey(scope);
      bindings.set(row.product_variant_id + ":" + scopeKey, {
        productVariantId: row.product_variant_id,
        scopeKey,
      });
    }
  return [...bindings.values()];
}

// Resolve the requested members once per query. Correlating this match
// inside every variant/readback query multiplies the entire request history by
// the member count and exceeds the lifecycle owner's timeout for larger listings.
// Both pending work and later completed requests consume this same relation.
// Null Catalog hints never mean every product on an account. Explicit hints
// retain conservative evidence when an old request predates a mapping.
// SQL contract: bindings and attempt_source CTEs; $1 destination kind, $2 connection ID text,
// $3 member IDs, $4 product ID.
export const stockClearingAttemptMembersSql = `
  WITH hinted AS MATERIALIZED (
    SELECT a.id,a.state,a.completed_at,(s->>'productVariantId')::int product_variant_id
    FROM attempt_source a
    CROSS JOIN LATERAL jsonb_array_elements(a.affected_scopes || jsonb_build_array(a.scope)) s
    WHERE s->>'destinationKind'=$1 AND s->>'connectionId'=$2
      AND ((s->>'productVariantId')::int=ANY($3::int[])
        OR (s->>'productVariantId' IS NULL AND (s->>'productId')::int=$4))
  )
  SELECT b."productVariantId" product_variant_id,a.id,a.state,a.completed_at
  FROM attempt_source a
  CROSS JOIN LATERAL unnest(a.affected_scope_keys || ARRAY[a.scope_key]) k(scope_key)
  JOIN bindings b ON b."scopeKey"=k.scope_key
  UNION
  SELECT v.id,h.id,h.state,h.completed_at FROM hinted h CROSS JOIN unnest($3::int[]) v(id)
  WHERE h.product_variant_id IS NULL OR h.product_variant_id=v.id
`;

export const stockClearingCatchupMembersSql = `
  WITH hinted AS MATERIALIZED (
    SELECT c.id,(c.scope->>'productVariantId')::int product_variant_id
    FROM inventory.quantity_publication_catchup c
    WHERE c.completed_revision<c.revision AND c.scope->>'destinationKind'=$1 AND c.scope->>'connectionId'=$2
      AND ((c.scope->>'productVariantId')::int=ANY($3::int[])
        OR (c.scope->>'productVariantId' IS NULL AND (c.scope->>'productId')::int=$4))
  )
  SELECT b."productVariantId" product_variant_id,c.id
  FROM inventory.quantity_publication_catchup c JOIN bindings b ON b."scopeKey"=c.scope_key
  WHERE c.completed_revision<c.revision
  UNION
  SELECT v.id,h.id FROM hinted h CROSS JOIN unnest($3::int[]) v(id)
  WHERE h.product_variant_id IS NULL OR h.product_variant_id=v.id
`;
