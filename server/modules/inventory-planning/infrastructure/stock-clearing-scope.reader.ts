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

// Both unfinished work and later completed requests must use the same matching
// rule. Null Catalog hints never mean every product on an account. Explicit
// hints remain conservative evidence when an old request predates a mapping.
// SQL contract: attempt alias a, member alias v(id), bindings CTE; parameters
// $1 destination kind, $2 connection ID text, $4 product ID.
export const stockClearingAttemptMatchesMemberSql = `(
  a.scope_key IN (SELECT b."scopeKey" FROM bindings b WHERE b."productVariantId"=v.id)
  OR a.affected_scope_keys && ARRAY(SELECT b."scopeKey" FROM bindings b WHERE b."productVariantId"=v.id)
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(a.affected_scopes || jsonb_build_array(a.scope)) s
    WHERE s->>'destinationKind'=$1 AND s->>'connectionId'=$2
      AND ((s->>'productVariantId')::integer=v.id
        OR (s->>'productVariantId' IS NULL AND (s->>'productId')::integer=$4)))
)`;
