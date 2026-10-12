import { inspectionQueries as queries } from "./customer-return-local-inspection.queries";

/** Only module-owned SQL expressions may be bound here. Runtime facts always
 * remain positional PostgreSQL parameters; this helper is deliberately private. */
function bindFixedQuery(query: string, bindings: readonly string[]): string {
  return query.replace(/\$(\d+)\b/g, (_token, number: string) => {
    const replacement = bindings[Number(number) - 1];
    if (replacement === undefined)
      throw new Error("Incomplete inspection snapshot SQL binding.");
    return replacement;
  });
}

const itemIds = `ARRAY(SELECT DISTINCT "wmsOrderItemId" FROM snapshot_wms_items)`;
const wmsOrderIds = `ARRAY(SELECT DISTINCT "wmsOrderId" FROM snapshot_wms_items)`;
const lineIds = `ARRAY(SELECT "omsOrderLineId" FROM snapshot_lines)`;
const bindingItemIds = `ARRAY(SELECT DISTINCT "physicalShipmentItemId" FROM snapshot_bindings WHERE "physicalShipmentItemId" IS NOT NULL)`;
const bindingShipmentIds = `ARRAY(SELECT DISTINCT "physicalShipmentId" FROM snapshot_bindings WHERE "physicalShipmentId" IS NOT NULL)`;
const packageIds = `ARRAY(SELECT DISTINCT "physicalShipmentId" FROM snapshot_package_items)`;
const labelIds = `ARRAY(SELECT DISTINCT "labelId" FROM snapshot_labels)`;

const collections = [
  {
    name: "lines",
    cte: "snapshot_lines",
    orderBy: 'evidence."omsOrderLineId"',
    query: bindFixedQuery(queries.lines, ["$1", "$5"]),
  },
  {
    name: "wmsItems",
    cte: "snapshot_wms_items",
    orderBy: 'evidence."wmsOrderId", evidence."wmsOrderItemId"',
    query: bindFixedQuery(queries.wmsItems, ["$1", "$2", "$6"]),
  },
  {
    name: "rootClaims",
    cte: "snapshot_root_claims",
    orderBy: 'evidence."claimId"',
    query: bindFixedQuery(queries.rootClaims, ["$1", itemIds, "$7"]),
  },
  {
    name: "legacyClaims",
    cte: "snapshot_legacy_claims",
    orderBy: 'evidence."returnItemId"',
    query: bindFixedQuery(queries.legacyClaims, [
      "$1",
      "$2",
      itemIds,
      wmsOrderIds,
      "$7",
    ]),
  },
  {
    name: "unallocatedReturns",
    cte: "snapshot_unallocated_returns",
    orderBy: 'evidence."returnId"',
    query: bindFixedQuery(queries.unallocatedReturns, [
      "$2",
      wmsOrderIds,
      "$7",
    ]),
  },
  {
    name: "inventoryReturnEvidence",
    cte: "snapshot_inventory_returns",
    orderBy: 'evidence."transactionId"',
    query: bindFixedQuery(queries.inventoryReturns, [
      wmsOrderIds,
      itemIds,
      "$2",
      "$7",
    ]),
  },
  {
    name: "fulfillmentBindings",
    cte: "snapshot_bindings",
    orderBy: 'evidence.kind, evidence."bindingId"',
    query: bindFixedQuery(queries.bindings, ["$1", "$3", "$4", "$8"]),
  },
  {
    name: "packageItems",
    cte: "snapshot_package_items",
    orderBy: 'evidence."physicalShipmentItemId"',
    query: bindFixedQuery(queries.packageItems, [
      itemIds,
      lineIds,
      bindingItemIds,
      bindingShipmentIds,
      "$9",
    ]),
  },
  {
    name: "packageLabels",
    cte: "snapshot_labels",
    orderBy: 'evidence."linkId"',
    query: bindFixedQuery(queries.labels, [packageIds, "$10"]),
  },
  {
    name: "carrierEvents",
    cte: "snapshot_events",
    orderBy: 'evidence."eventId", evidence."matchId"',
    query: bindFixedQuery(queries.events, [labelIds, "$11"]),
  },
] as const;

// Materialize each bounded relation once. Separate aggregates cannot multiply
// claims through joins, and dependent identities come from the same transaction.
// JSON numbers are serialized as strings before node-postgres parses them, so a
// bigint can never be rounded before the existing safe-integer validation.
export const CUSTOMER_RETURN_INSPECTION_SNAPSHOT_QUERY = `WITH
${collections.map((collection) => `${collection.cte} AS MATERIALIZED (${collection.query})`).join(",\n")}
SELECT ${collections
  .map(
    (collection) => `(SELECT COALESCE(jsonb_agg(
  (SELECT jsonb_object_agg(field.key, CASE WHEN jsonb_typeof(field.value) = 'number'
    THEN to_jsonb(field.value #>> '{}') ELSE field.value END)
    FROM jsonb_each(to_jsonb(evidence)) AS field)
  ORDER BY ${collection.orderBy}), '[]'::jsonb)
  FROM ${collection.cte} AS evidence) AS "${collection.name}"`,
  )
  .join(",\n")}`;
