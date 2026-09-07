import type { PoolClient } from "pg";
import {
  inventoryCutoverEncumbranceSchema,
  type InventoryCutoverEncumbranceDto,
} from "@shared/types/inventory-cutover-encumbrance";

export type InventoryCutoverEncumbranceQueryClient = Pick<PoolClient, "query">;
// Hard response bounds apply independently to each evidence collection. Overflow
// rejects the capture; a partial inventory/owner census must never look complete.
const DEFAULT_MAX_ROWS = 25_000;
const MAX_ROWS = 50_000;

export class InventoryCutoverEncumbranceCaptureError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryCutoverEncumbranceCaptureError";
  }
}

/**
 * Inventory's published, read-only owner interface for cutover review.
 * The caller owns one REPEATABLE READ (or SERIALIZABLE), READ ONLY transaction
 * shared with the WMS demand capture. This function never begins/ends it, locks
 * operational rows, normalizes balances, or decides that activation is safe.
 *
 * Only current build/claim ownership is captured, not historical ledger totals.
 * Inventory-level counters are raw evidence: they cannot establish their owner.
 */
export async function captureInventoryCutoverEncumbranceInsideTransaction(
  client: InventoryCutoverEncumbranceQueryClient,
  options: { maxRows?: number } = {},
): Promise<InventoryCutoverEncumbranceDto> {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) {
    throw new InventoryCutoverEncumbranceCaptureError(
      "INVENTORY_CUTOVER_INVALID_CAPTURE_LIMIT",
      `maxRows must be an integer between 1 and ${MAX_ROWS}.`,
    );
  }
  const transaction = (await client.query<{
    read_only: string; isolation_level: string;
  }>(`SELECT current_setting('transaction_read_only') AS read_only,
             current_setting('transaction_isolation') AS isolation_level`)).rows[0];
  if (transaction?.read_only !== "on"
    || !["repeatable read", "serializable"].includes(transaction.isolation_level)) {
    throw new InventoryCutoverEncumbranceCaptureError(
      "INVENTORY_CUTOVER_READ_ONLY_SNAPSHOT_REQUIRED",
      "Cutover evidence requires a caller-owned repeatable-read read-only transaction.",
    );
  }

  const totals = (await client.query<Record<string, unknown>>(
    `SELECT count(*)::text AS "inventoryLevelCount",
            COALESCE(sum(variant_qty::numeric), 0)::text AS "variantQty",
            COALESCE(sum(reserved_qty::numeric), 0)::text AS "reservedQty",
            COALESCE(sum(picked_qty::numeric), 0)::text AS "pickedQty",
            COALESCE(sum(packed_qty::numeric), 0)::text AS "packedQty"
     FROM inventory.inventory_levels`,
  )).rows[0];
  const inventoryLevels = await boundedRows(client, "inventoryLevels", maxRows,
    `SELECT id AS "inventoryLevelId", warehouse_location_id AS "warehouseLocationId",
            product_variant_id AS "productVariantId", variant_qty::text AS "variantQty",
            reserved_qty::text AS "reservedQty", picked_qty::text AS "pickedQty",
            packed_qty::text AS "packedQty"
     FROM inventory.inventory_levels ORDER BY id LIMIT $1`);

  const installed = (await client.query<{
    claims: string | null; lines: string | null; resources: string | null; lot_allocations: string | null;
  }>(`SELECT to_regclass('inventory.availability_claims')::text AS claims,
             to_regclass('inventory.availability_claim_lines')::text AS lines,
             to_regclass('inventory.availability_claim_resources')::text AS resources,
             to_regclass('inventory.availability_claim_lot_allocations')::text AS lot_allocations`)).rows[0];
  const installation = installed
    ? [installed.claims, installed.lines, installed.resources, installed.lot_allocations]
    : [];
  if (installation.length !== 4 || installation.some((table) => table !== null && typeof table !== "string")) {
    throw new InventoryCutoverEncumbranceCaptureError(
      "INVENTORY_CUTOVER_INVALID_DATABASE_EVIDENCE", "Canonical installation evidence is missing or malformed.",
    );
  }
  const tableCount = installation.filter((table) => table !== null).length;
  if (tableCount !== 0 && tableCount !== 4) {
    throw new InventoryCutoverEncumbranceCaptureError(
      "INVENTORY_CUTOVER_CANONICAL_SCHEMA_INCOMPLETE",
      "Canonical claim ownership tables are only partially installed.",
    );
  }
  const claimLotColumns = tableCount === 4
    ? `claim_lot.claim_resource_id::text AS "claimLotResourceId",
       claim_lot.inventory_lot_id AS "claimLotInventoryLotId",
       (claim_lot.claimed_qty::numeric - claim_lot.released_qty::numeric
         - claim_lot.consumed_qty::numeric - claim_lot.picked_qty::numeric)::text AS "claimLotOpenQty"`
    : `NULL::text AS "claimLotResourceId", NULL::integer AS "claimLotInventoryLotId",
       NULL::text AS "claimLotOpenQty"`;
  const claimLotJoin = tableCount === 4
    ? `LEFT JOIN inventory.availability_claim_lot_allocations AS claim_lot
         ON claim_lot.id = reservation.availability_claim_lot_allocation_id
        AND claim_lot.claim_id = reservation.availability_claim_id`
    : "";

  // LEFT JOIN deliberately retains broken owner/lot references as null evidence.
  // A terminal build retaining an outstanding reservation is included for review.
  const buildReservations = await boundedRows(client, "buildReservations", maxRows,
    `SELECT reservation.id AS "reservationId",
            reservation.build_order_component_id AS "buildOrderComponentId",
            component.build_order_id AS "buildOrderId", build.status AS "buildOrderStatus",
            build.warehouse_id AS "warehouseId",
            component.component_variant_id AS "componentVariantId",
            component.source_location_id AS "sourceLocationId",
            reservation.inventory_lot_id AS "inventoryLotId",
            lot.product_variant_id AS "lotVariantId", lot.warehouse_location_id AS "lotLocationId",
            lot.qty_reserved::text AS "lotQtyReserved",
            reservation.reserved_qty::text AS "reservedQty",
            reservation.consumed_qty::text AS "consumedQty",
            reservation.released_qty::text AS "releasedQty",
            reservation.reservation_owner AS "reservationOwner",
            reservation.availability_claim_id::text AS "availabilityClaimId",
            reservation.availability_claim_lot_allocation_id::text AS "availabilityClaimLotAllocationId",
            ${claimLotColumns}
     FROM inventory.build_component_reservations AS reservation
     LEFT JOIN inventory.build_order_components AS component
       ON component.id = reservation.build_order_component_id
     LEFT JOIN inventory.build_orders AS build ON build.id = component.build_order_id
     LEFT JOIN inventory.inventory_lots AS lot ON lot.id = reservation.inventory_lot_id
     ${claimLotJoin}
     WHERE reservation.reserved_qty::numeric - reservation.consumed_qty::numeric
       - reservation.released_qty::numeric <> 0
     ORDER BY reservation.id LIMIT $1`);

  // Inactive claims with residual on-hand holds or picked custody remain visible.
  // Filtering only status='active' would conceal precisely the drift under review.
  const canonicalResources = tableCount === 0 ? [] : await boundedRows(
    client, "canonicalResources", maxRows,
    `SELECT resource.id::text AS "claimResourceId", resource.claim_id::text AS "claimId",
            claim.status AS "claimStatus", claim.order_id AS "orderId",
            resource.claim_line_id::text AS "claimLineId", line.order_item_id AS "orderItemId",
            line.target_variant_id AS "targetVariantId", resource.warehouse_id AS "warehouseId",
            resource.warehouse_location_id AS "warehouseLocationId",
            resource.inventory_level_id AS "inventoryLevelId", resource.source_variant_id AS "sourceVariantId",
            resource.claimed_qty::text AS "claimedQty", resource.released_qty::text AS "releasedQty",
            resource.consumed_qty::text AS "consumedQty", resource.picked_qty::text AS "pickedQty"
     FROM inventory.availability_claim_resources AS resource
     LEFT JOIN inventory.availability_claims AS claim ON claim.id = resource.claim_id
     LEFT JOIN inventory.availability_claim_lines AS line
       ON line.id = resource.claim_line_id AND line.claim_id = resource.claim_id
     WHERE claim.status = 'active'
        OR resource.claimed_qty::numeric - resource.released_qty::numeric
          - resource.consumed_qty::numeric - resource.picked_qty::numeric <> 0
        OR resource.picked_qty <> 0
     ORDER BY resource.id LIMIT $1`,
  );
  try {
    return inventoryCutoverEncumbranceSchema.parse({
      schemaVersion: "inventory_cutover_encumbrance_v1",
      inventoryLevels,
      buildReservations,
      canonicalResources,
      canonicalTablesStatus: tableCount === 4 ? "captured" : "not_installed",
      totals: { ...totals, quantitySemantics: "mixed_sku_units_not_atp" },
      attributionCaveats: [
        "legacy_order_reservation_attribution_not_captured",
        "picked_packed_custody_not_attributed",
        "build_claim_hold_overlap_requires_deduplication",
        "unexplained_reserved_balance_is_not_free_supply",
      ],
    });
  } catch (cause) {
    throw new InventoryCutoverEncumbranceCaptureError(
      "INVENTORY_CUTOVER_INVALID_DATABASE_EVIDENCE",
      "Inventory cutover evidence does not satisfy the strict owner contract.",
      {}, { cause },
    );
  }
}

async function boundedRows(
  client: InventoryCutoverEncumbranceQueryClient,
  collection: string,
  maxRows: number,
  query: string,
): Promise<Record<string, unknown>[]> {
  const result = await client.query<Record<string, unknown>>(query, [maxRows + 1]);
  if (result.rows.length > maxRows) {
    throw new InventoryCutoverEncumbranceCaptureError(
      "INVENTORY_CUTOVER_CAPTURE_LIMIT_EXCEEDED",
      "Inventory cutover evidence exceeds the bounded capture; no partial result is returned.",
      { collection, maxRows },
    );
  }
  return result.rows;
}
