export const PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES = 200;

export const PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_RELATIONSHIP_TYPES = Object.freeze([
  "legacy_wms_shipment_link",
  "physical_shipment_link",
  "provider_order_id_match",
  "provider_order_key_match",
  "provider_physical_shipment_match",
  "provider_order_reference_match",
  "shipment_request_link",
  "shipping_engine_order_link",
] as const);

export type PackageAllocationAuthorityDiscoveryRelationshipType =
  typeof PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_RELATIONSHIP_TYPES[number];

/**
 * Application relations read by the package-allocation relationship discovery
 * query. PostgreSQL catalog relations used by the plan audit are intentionally
 * excluded because they are not application grant targets.
 */
export const PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_REQUIRED_RELATIONS:
readonly string[] = Object.freeze([
  "wms.outbound_shipment_items",
  "wms.physical_shipment_items",
  "wms.physical_shipments",
  "wms.shipment_request_items",
  "wms.shipment_requests",
  "wms.shipping_engine_order_provider_refs",
  "wms.shipping_engine_order_requests",
  "wms.shipping_engine_orders",
  "wms.shipping_provider_label_links",
  "wms.shipping_provider_labels",
]);

export interface PackageAllocationAuthorityDiscoveryIndexContract {
  readonly indexName: string;
  readonly relationName: string;
  readonly keyColumns: readonly string[];
  readonly predicateColumn: string;
}

export const PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS:
readonly PackageAllocationAuthorityDiscoveryIndexContract[] = Object.freeze([
  Object.freeze({
    indexName: "idx_physical_shipment_items_request_item_lookup",
    relationName: "physical_shipment_items",
    keyColumns: Object.freeze(["shipment_request_item_id", "physical_shipment_id"]),
    predicateColumn: "shipment_request_item_id",
  }),
  Object.freeze({
    indexName: "idx_physical_shipments_engine_order_lookup",
    relationName: "physical_shipments",
    keyColumns: Object.freeze(["shipping_engine_order_id", "id"]),
    predicateColumn: "shipping_engine_order_id",
  }),
  Object.freeze({
    indexName: "idx_shipping_provider_label_links_request_lookup",
    relationName: "shipping_provider_label_links",
    keyColumns: Object.freeze(["shipment_request_id", "shipping_provider_label_id"]),
    predicateColumn: "shipment_request_id",
  }),
  Object.freeze({
    indexName: "idx_shipping_provider_label_links_engine_order_lookup",
    relationName: "shipping_provider_label_links",
    keyColumns: Object.freeze(["shipping_engine_order_id", "shipping_provider_label_id"]),
    predicateColumn: "shipping_engine_order_id",
  }),
  Object.freeze({
    indexName: "idx_shipping_provider_label_links_physical_lookup",
    relationName: "shipping_provider_label_links",
    keyColumns: Object.freeze(["physical_shipment_id", "shipping_provider_label_id"]),
    predicateColumn: "physical_shipment_id",
  }),
  Object.freeze({
    indexName: "idx_shipping_provider_label_links_legacy_lookup",
    relationName: "shipping_provider_label_links",
    keyColumns: Object.freeze(["legacy_wms_shipment_id", "shipping_provider_label_id"]),
    predicateColumn: "legacy_wms_shipment_id",
  }),
  Object.freeze({
    indexName: "idx_shipping_provider_labels_provider_order_id_lookup",
    relationName: "shipping_provider_labels",
    keyColumns: Object.freeze(["provider", "provider_order_id", "id"]),
    predicateColumn: "provider_order_id",
  }),
  Object.freeze({
    indexName: "idx_shipping_provider_labels_provider_order_key_lookup",
    relationName: "shipping_provider_labels",
    keyColumns: Object.freeze(["provider", "provider_order_key", "id"]),
    predicateColumn: "provider_order_key",
  }),
]);

/**
 * Single source of truth for both normal relationship discovery and its
 * non-executing PostgreSQL EXPLAIN audit. Keep parameters positional so the
 * audit plans the exact production statement.
 */
export const PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL = `WITH selected_sources AS MATERIALIZED (
  SELECT shipment_item.id, shipment_item.shipment_id
  FROM wms.outbound_shipment_items AS shipment_item
  WHERE shipment_item.id = ANY($1::integer[])
),
source_stats AS MATERIALIZED (
  SELECT
    COUNT(*)::integer AS source_count,
    COALESCE(
      ARRAY_AGG(source.id ORDER BY source.id),
      ARRAY[]::integer[]
    ) AS found_source_ids
  FROM selected_sources AS source
),
source_physical_shipments AS MATERIALIZED (
  SELECT DISTINCT physical_item.physical_shipment_id AS id
  FROM wms.physical_shipment_items AS physical_item
  JOIN selected_sources AS source
    ON source.id = physical_item.legacy_wms_shipment_item_id
  UNION
  SELECT DISTINCT physical_item.physical_shipment_id
  FROM wms.physical_shipment_items AS physical_item
  JOIN wms.shipment_request_items AS request_item
    ON request_item.id = physical_item.shipment_request_item_id
  JOIN selected_sources AS source
    ON source.id = request_item.legacy_wms_shipment_item_id
),
anchor_requests AS MATERIALIZED (
  SELECT request_item.shipment_request_id AS id
  FROM wms.shipment_request_items AS request_item
  JOIN selected_sources AS source
    ON source.id = request_item.legacy_wms_shipment_item_id
  UNION
  SELECT request.id
  FROM wms.shipment_requests AS request
  JOIN selected_sources AS source
    ON source.shipment_id = request.legacy_wms_shipment_id
),
anchor_engine_orders AS MATERIALIZED (
  SELECT order_request.shipping_engine_order_id AS id
  FROM wms.shipping_engine_order_requests AS order_request
  JOIN anchor_requests AS request
    ON request.id = order_request.shipment_request_id
  UNION
  SELECT engine_order.id
  FROM wms.shipping_engine_orders AS engine_order
  JOIN anchor_requests AS request
    ON request.id = engine_order.shipment_request_id
  UNION
  SELECT physical.shipping_engine_order_id
  FROM wms.physical_shipments AS physical
  JOIN source_physical_shipments AS source_physical
    ON source_physical.id = physical.id
  WHERE physical.shipping_engine_order_id IS NOT NULL
  UNION
  SELECT physical.shipping_engine_order_id
  FROM wms.physical_shipments AS physical
  JOIN anchor_requests AS request
    ON request.id = physical.shipment_request_id
  WHERE physical.shipping_engine_order_id IS NOT NULL
),
scope_requests AS MATERIALIZED (
  SELECT request.id
  FROM anchor_requests AS request
  UNION
  SELECT order_request.shipment_request_id
  FROM wms.shipping_engine_order_requests AS order_request
  JOIN anchor_engine_orders AS engine_order
    ON engine_order.id = order_request.shipping_engine_order_id
  UNION
  SELECT engine_order.shipment_request_id
  FROM wms.shipping_engine_orders AS engine_order
  JOIN anchor_engine_orders AS anchor
    ON anchor.id = engine_order.id
  WHERE engine_order.shipment_request_id IS NOT NULL
  UNION
  SELECT physical.shipment_request_id
  FROM wms.physical_shipments AS physical
  JOIN source_physical_shipments AS source_physical
    ON source_physical.id = physical.id
  WHERE physical.shipment_request_id IS NOT NULL
),
scope_legacy_shipments AS MATERIALIZED (
  SELECT source.shipment_id AS id
  FROM selected_sources AS source
  WHERE source.shipment_id IS NOT NULL
  UNION
  SELECT request.legacy_wms_shipment_id
  FROM wms.shipment_requests AS request
  JOIN scope_requests AS scoped_request
    ON scoped_request.id = request.id
  WHERE request.legacy_wms_shipment_id IS NOT NULL
),
scope_physical_shipments AS MATERIALIZED (
  SELECT source_physical.id
  FROM source_physical_shipments AS source_physical
  UNION
  SELECT physical.id
  FROM wms.physical_shipments AS physical
  JOIN scope_requests AS request
    ON request.id = physical.shipment_request_id
  UNION
  SELECT physical.id
  FROM wms.physical_shipments AS physical
  JOIN anchor_engine_orders AS engine_order
    ON engine_order.id = physical.shipping_engine_order_id
),
candidate_label_relationships AS MATERIALIZED (
  SELECT
    link.shipping_provider_label_id AS id,
    'shipment_request_link'::text AS relationship_type
  FROM wms.shipping_provider_label_links AS link
  WHERE link.shipment_request_id IN (SELECT id FROM scope_requests)
  UNION ALL
  SELECT
    link.shipping_provider_label_id,
    'shipping_engine_order_link'::text
  FROM wms.shipping_provider_label_links AS link
  WHERE link.shipping_engine_order_id IN (
    SELECT id FROM anchor_engine_orders
  )
  UNION ALL
  SELECT
    link.shipping_provider_label_id,
    'physical_shipment_link'::text
  FROM wms.shipping_provider_label_links AS link
  WHERE link.physical_shipment_id IN (
    SELECT id FROM scope_physical_shipments
  )
  UNION ALL
  SELECT
    link.shipping_provider_label_id,
    'legacy_wms_shipment_link'::text
  FROM wms.shipping_provider_label_links AS link
  WHERE link.legacy_wms_shipment_id IN (
    SELECT id FROM scope_legacy_shipments
  )
  UNION ALL
  SELECT
    label.id,
    'provider_order_id_match'::text
  FROM wms.shipping_provider_labels AS label
  JOIN wms.shipping_engine_orders AS engine_order
    ON engine_order.id IN (SELECT id FROM anchor_engine_orders)
   AND engine_order.provider = label.provider
   AND engine_order.provider_order_id = label.provider_order_id
  WHERE engine_order.provider_order_id IS NOT NULL
  UNION ALL
  SELECT
    label.id,
    'provider_order_key_match'::text
  FROM wms.shipping_provider_labels AS label
  JOIN wms.shipping_engine_orders AS engine_order
    ON engine_order.id IN (SELECT id FROM anchor_engine_orders)
   AND engine_order.provider = label.provider
   AND engine_order.provider_order_key = label.provider_order_key
  WHERE engine_order.provider_order_key IS NOT NULL
  UNION ALL
  SELECT
    label.id,
    'provider_order_reference_match'::text
  FROM wms.shipping_provider_labels AS label
  JOIN wms.shipping_engine_order_provider_refs AS provider_ref
    ON provider_ref.shipping_engine_order_id IN (
      SELECT id FROM anchor_engine_orders
    )
   AND provider_ref.provider = label.provider
   AND provider_ref.provider_order_id = label.provider_order_id
  UNION ALL
  SELECT
    label.id,
    'provider_physical_shipment_match'::text
  FROM wms.shipping_provider_labels AS label
  JOIN wms.physical_shipments AS physical
    ON physical.id IN (SELECT id FROM scope_physical_shipments)
   AND physical.provider = label.provider
   AND physical.provider_physical_shipment_id = label.provider_label_id
),
candidate_labels AS MATERIALIZED (
  SELECT
    relationship.id,
    ARRAY_AGG(
      DISTINCT relationship.relationship_type
      ORDER BY relationship.relationship_type
    ) AS relationship_types
  FROM candidate_label_relationships AS relationship
  GROUP BY relationship.id
)
SELECT
  stats.source_count,
  stats.found_source_ids,
  candidate.shipping_provider_label_id,
  candidate.relationship_types
FROM source_stats AS stats
LEFT JOIN LATERAL (
  SELECT
    label.id::text AS shipping_provider_label_id,
    candidate_label.relationship_types,
    label.id AS sortable_label_id
  FROM candidate_labels AS candidate_label
  JOIN wms.shipping_provider_labels AS label
    ON label.id = candidate_label.id
  WHERE label.label_direction = 'outbound'
  ORDER BY label.id
  LIMIT $2
) AS candidate ON TRUE
ORDER BY candidate.sortable_label_id NULLS LAST`;
