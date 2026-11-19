import { sql, type SQL } from "drizzle-orm";

/** Historical push/receipt rows are immutable audit facts, not proof that a
 * package still fulfills the order after its label or fulfillment is retired. */
export function currentChannelPackageEvidenceSql(input: {
  readonly physicalShipmentId: SQL;
  readonly omsOrderId: SQL;
}): SQL {
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM wms.physical_shipments coverage_package
      JOIN wms.shipping_provider_labels coverage_label
        ON coverage_label.provider = coverage_package.provider
        AND coverage_label.provider_label_id = coverage_package.provider_physical_shipment_id
      WHERE coverage_package.id = ${input.physicalShipmentId}
        AND coverage_label.label_status IN ('voided', 'superseded')
    )
    AND NOT EXISTS (
      SELECT 1 FROM oms.shopify_label_void_work coverage_void
      WHERE coverage_void.physical_shipment_id = ${input.physicalShipmentId}
        AND coverage_void.oms_order_id = ${input.omsOrderId}
    )
  )`;
}

/** Source item identity survives legacy split-header moves and relabels. Use
 * that lineage instead of an order status or an old fulfillment handle. */
export function shipmentHasRetiredPackageSql(input: {
  readonly shipmentId: SQL;
  readonly omsOrderId: SQL;
}): SQL {
  return sql`EXISTS (
    SELECT 1 FROM wms.physical_shipment_items retired_item
    LEFT JOIN wms.package_allocation_entries retired_entry
      ON retired_entry.id = retired_item.package_allocation_entry_id
    LEFT JOIN wms.package_allocation_source_lines retired_source
      ON retired_source.id = retired_entry.package_allocation_source_line_id
    JOIN wms.outbound_shipment_items retired_legacy_item
      ON retired_legacy_item.id = COALESCE(retired_item.legacy_wms_shipment_item_id,
        retired_item.label_replacement_source_item_id, retired_source.source_wms_shipment_item_id)
    WHERE retired_legacy_item.shipment_id = ${input.shipmentId}
      AND NOT ${currentChannelPackageEvidenceSql({
        physicalShipmentId: sql`retired_item.physical_shipment_id`,
        omsOrderId: input.omsOrderId,
      })}
  )`;
}

/** A source line can be split across several physical packages. Count each
 * current physical item once, even if its provider command was replayed. */
export function currentPushedShipmentItemQuantitySql(input: {
  readonly shipmentItemId: SQL;
  readonly omsOrderId: SQL;
  readonly provider: SQL;
}): SQL {
  return sql`COALESCE((
    SELECT SUM(covered_item.quantity)::int FROM (
      SELECT physical_item.id, MAX(push_item.quantity_pushed)::int AS quantity
      FROM wms.effective_physical_shipment_items physical_item
      LEFT JOIN wms.package_allocation_entries allocation_entry
        ON allocation_entry.id = physical_item.package_allocation_entry_id
      LEFT JOIN wms.package_allocation_source_lines allocation_source
        ON allocation_source.id = allocation_entry.package_allocation_source_line_id
      JOIN oms.channel_fulfillment_push_items push_item
        ON push_item.physical_shipment_item_id = physical_item.id
      JOIN oms.channel_fulfillment_pushes push ON push.id = push_item.channel_fulfillment_push_id
      WHERE COALESCE(physical_item.legacy_wms_shipment_item_id,
        physical_item.label_replacement_source_item_id,
        allocation_source.source_wms_shipment_item_id) = ${input.shipmentItemId}
        AND push.oms_order_id = ${input.omsOrderId}
        AND push.channel_provider = ${input.provider}
        AND push.push_status IN ('success', 'ignored')
        AND ${currentChannelPackageEvidenceSql({ physicalShipmentId: sql`push.physical_shipment_id`, omsOrderId: input.omsOrderId })}
        AND push_item.quantity_pushed = physical_item.quantity_shipped
      GROUP BY physical_item.id
    ) covered_item
  ), 0)`;
}
