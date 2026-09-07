import { sql, type SQL } from "drizzle-orm";

/**
 * Add to the caller's existing SELECT: history, repair preview and activity see
 * the ledger and its immutable receipt in the same statement snapshot. The caller
 * supplies a SQL table/alias, never a user-provided identifier. No quantity policy
 * lives in this query; interpretation belongs to the shared domain contract.
 */
export function shipmentQuantityEvidenceProjection(transaction: SQL): SQL {
  return sql`jsonb_build_object(
    'transactionId', ${transaction}.id,
    'transactionType', ${transaction}.transaction_type,
    'variantQtyDelta', ${transaction}.variant_qty_delta,
    'reservedQtyDelta', ${transaction}.reserved_qty_delta,
    'referenceType', ${transaction}.reference_type,
    'sourceState', ${transaction}.source_state,
    'targetState', ${transaction}.target_state,
    'orderId', ${transaction}.order_id,
    'orderItemId', ${transaction}.order_item_id,
    'shipmentId', ${transaction}.shipment_id,
    'shipmentItemId', ${transaction}.shipment_item_id,
    'productVariantId', ${transaction}.product_variant_id,
    'fromLocationId', ${transaction}.from_location_id,
    'receipt', (
      SELECT jsonb_build_object(
        'id', receipt.id::text,
        'quantity', receipt.quantity::text,
        'orderId', receipt.order_id,
        'orderItemId', receipt.order_item_id,
        'shipmentId', receipt.outbound_shipment_id,
        'shipmentItemId', receipt.source_shipment_item_id,
        'productVariantId', receipt.product_variant_id,
        'fromLocationId', receipt.warehouse_location_id,
        'warehouseId', receipt.warehouse_id,
        'physicalShipmentId', receipt.physical_shipment_id::text,
        'physicalShipmentItemId', receipt.physical_shipment_item_id::text,
        'movementQuantity', journal.quantity::text,
        'invalidMovementCount', journal.invalid_count::text
      )
      FROM inventory.availability_claim_dispatch_receipts AS receipt
      LEFT JOIN LATERAL (
        SELECT SUM(movement.quantity) AS quantity,
          COUNT(*) FILTER (WHERE pick.id IS NULL OR pick.movement_type <> 'pick'
            OR movement.quantity <= 0 OR movement.quantity > pick.quantity
            OR movement.claim_id <> receipt.claim_id OR movement.claim_line_id <> receipt.claim_line_id
            OR pick.claim_id <> receipt.claim_id OR pick.claim_line_id <> receipt.claim_line_id) AS invalid_count
        FROM inventory.availability_claim_dispatch_movements AS movement
        LEFT JOIN inventory.availability_claim_pick_movements AS pick ON pick.id = movement.pick_movement_id
        WHERE movement.receipt_id = receipt.id
      ) AS journal ON true
      WHERE receipt.inventory_transaction_id = ${transaction}.id
    )
  )`;
}
