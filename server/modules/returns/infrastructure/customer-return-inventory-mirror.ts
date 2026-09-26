/** Fixed SQL predicate for the inventory transaction alias `it`.
 * A ledger row is a mirror only when the immutable treatment, disposition,
 * operational item and portal claim all prove the same physical receipt.
 * Reference text alone is deliberately insufficient.
 */
export const portalInventoryReturnMirrorSql = `EXISTS (
  SELECT 1 FROM returns.return_case_inventory_treatment_items treatment_item
  JOIN returns.return_case_inventory_treatments treatment ON treatment.id=treatment_item.inventory_treatment_id
  JOIN returns.return_case_disposition_items disposition_item ON disposition_item.id=treatment_item.disposition_item_id
  JOIN returns.return_case_dispositions disposition ON disposition.id=disposition_item.disposition_id
  JOIN returns.return_case_items case_item ON case_item.id=treatment_item.return_case_item_id
  JOIN returns.customer_return_case_links case_link ON case_link.case_id=case_item.return_case_id
  JOIN returns.customer_return_allocation_case_items allocation_link ON allocation_link.case_item_id=case_item.id
    AND allocation_link.authorization_id=case_link.authorization_id
    AND allocation_link.wms_return_item_id=case_item.wms_return_item_id
  JOIN returns.customer_return_authorization_allocations allocation ON allocation.id=allocation_link.authorization_allocation_id
    AND allocation.authorization_id=case_link.authorization_id AND allocation.wms_order_item_id=case_item.wms_order_item_id
  JOIN returns.customer_return_authorization_lines line ON line.id=allocation.authorization_line_id
    AND line.oms_order_line_id=case_item.oms_order_line_id
  JOIN oms.oms_order_lines oms_line ON oms_line.id=line.oms_order_line_id
  WHERE treatment_item.inventory_transaction_id=it.id
    AND treatment.return_case_id=case_item.return_case_id AND disposition.return_case_id=case_item.return_case_id
    AND disposition_item.return_case_item_id=case_item.id
    AND treatment_item.treatment='restock_sellable' AND disposition_item.treatment='restock_sellable'
    AND treatment_item.quantity=disposition_item.quantity AND treatment_item.quantity=it.variant_qty_delta
    AND it.reference_type='return_inventory_treatment' AND it.reference_id=disposition_item.id::text
    AND it.order_item_id=case_item.wms_order_item_id AND it.order_id=case_link.wms_order_id
    AND it.product_variant_id=oms_line.product_variant_id
    AND it.to_location_id=treatment_item.warehouse_location_id
    AND it.inventory_lot_id=treatment_item.inventory_lot_id AND it.voided_at IS NULL
    AND it.source_state='customer_return' AND it.target_state='on_hand'
)`;
