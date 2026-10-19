import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import type { StockSelectionDestination } from "./inventory-publication-selection.reader";
import { QuantityPublicationAdmissionError, quantityPublicationScopeSchema, type QuantityPublicationScope } from "../domain/quantity-publication-admission";

export interface CanonicalQuantityPublicationMember extends StockSelectionDestination {
  product_id: number;
  product_variant_id: number;
  target_id: number;
  target_revision: string;
  mapping_id: string;
  mapping_revision: string;
}

/** Shared exact binding for canonical planning and catch-up settlement. Resolve
 * external identity before local hints, so hints cannot hide an ambiguous item.
 * The caller owns the transaction and publication gate; rows remain pinned. */
export async function readCanonicalQuantityPublicationMember(client: StockSelectionQueryClient,
  raw: QuantityPublicationScope): Promise<CanonicalQuantityPublicationMember> {
  const scope = quantityPublicationScopeSchema.parse(raw);
  const channelDestination = scope.destinationKind === "channel_connection";
  const providerOwner = channelDestination
    ? "JOIN channels.channels provider_owner ON provider_owner.id=t.channel_id JOIN channels.channel_connections connection ON connection.id=t.channel_connection_id AND connection.channel_id=t.channel_id"
    : "JOIN dropship.dropship_store_connections provider_owner ON provider_owner.id=t.dropship_store_connection_id";
  const connectionLock = channelDestination ? ",connection" : "";
  const providerColumn = channelDestination ? "provider_owner.provider" : "provider_owner.platform";
  const mappings = (await client.query<CanonicalQuantityPublicationMember>(
    `SELECT v.product_id,m.product_variant_id,t.id AS target_id,
       t.revision::text AS target_revision,h.revision::text AS mapping_revision,m.id::text AS mapping_id,
       t.destination_kind AS "destinationKind",t.channel_id AS "channelId",
       t.channel_connection_id AS "channelConnectionId",t.dropship_store_connection_id AS "dropshipStoreConnectionId"
     FROM inventory.inventory_publication_targets t
     ${providerOwner}
     JOIN inventory.publication_variant_mapping_heads h ON h.publication_target_id=t.id
     JOIN inventory.publication_variant_mapping_versions m ON m.id=h.active_mapping_id
       AND m.publication_target_id=h.publication_target_id AND m.product_variant_id=h.product_variant_id
     JOIN catalog.product_variants v ON v.id=m.product_variant_id
     JOIN catalog.products p ON p.id=v.product_id
     WHERE t.state='live' AND t.publication_authority='echelon' AND m.lifecycle_status='sealed'
     AND t.destination_kind=$1 AND COALESCE(t.channel_connection_id,t.dropship_store_connection_id)=$2
     AND t.provider_scope_type=$3 AND t.external_scope_id=$4 AND m.external_inventory_item_id=$5
     AND lower(${providerColumn})=$6
     ORDER BY t.id,m.product_variant_id LIMIT 2 FOR SHARE OF t,h,m,v,p,provider_owner${connectionLock}`,
    [scope.destinationKind,scope.connectionId,scope.providerScopeType,scope.externalScopeId,scope.externalInventoryItemId,
      scope.providerKey],
  )).rows;
  if (mappings.length !== 1) throw new QuantityPublicationAdmissionError("PUBLICATION_LISTING_TARGET_UNMAPPED",
    "Listing quantity requires one exact active canonical target/mapping; configure it before publishing.", { scope });
  const mapping = mappings[0];
  // Local hints constrain the sole externally resolved identity. They must not
  // hide a second mapping for the same provider item on another target.
  if ((scope.productId !== null && scope.productId !== mapping.product_id)
    || (scope.productVariantId !== null && scope.productVariantId !== mapping.product_variant_id)) {
    throw new QuantityPublicationAdmissionError("PUBLICATION_LISTING_TARGET_UNMAPPED",
      "The exact provider item no longer maps to the requested product and variant.", { scope });
  }
  return mapping;
}
