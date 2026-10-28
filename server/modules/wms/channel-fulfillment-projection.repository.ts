import { sql } from "drizzle-orm";
import { sqlIntegerArray } from "../../infrastructure/postgres-array";
import { deriveWmsShippingProgress, type WmsShippingProgressLine } from "@shared/wms-shipping-progress";
import type { WmsWarehouseStatus } from "@shared/enums/order-status";
import { shippingProgressLine, wmsShippingProgressQuery, type WmsShippingProgressRow } from "./shipping-progress.query";
import { observeMissingPick } from "./pick-correction.repository";

export class WmsFulfillmentProjectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WmsFulfillmentProjectionError";
  }
}

/**
 * Project one immutable physical package into WMS-owned mutable read models.
 *
 * The caller supplies the transaction so the WMS and OMS projections can
 * commit atomically without either module writing the other module's tables.
 */
export async function projectPhysicalShipmentToWms(
  transaction: any,
  physicalShipmentId: number,
  clock: () => Date = () => new Date(),
): Promise<void> {
  if (!Number.isInteger(physicalShipmentId) || physicalShipmentId <= 0) {
    throw new WmsFulfillmentProjectionError(
      "INVALID_INPUT",
      "physicalShipmentId must be a positive integer",
      { physicalShipmentId },
    );
  }
  if (typeof transaction?.execute !== "function") {
    throw new WmsFulfillmentProjectionError(
      "INVALID_INPUT",
      "WMS fulfillment projection requires a database transaction",
      { physicalShipmentId },
    );
  }

  const packageResult = await transaction.execute(sql`
    SELECT id
    FROM wms.physical_shipments
    WHERE id = ${physicalShipmentId}
    FOR UPDATE
  `);
  if (!Array.isArray(packageResult?.rows) || packageResult.rows.length !== 1) {
    throw new WmsFulfillmentProjectionError(
      "PHYSICAL_SHIPMENT_NOT_FOUND",
      `Physical shipment ${physicalShipmentId} was not found for canonical projection`,
      { physicalShipmentId },
    );
  }

  // Acquire each affected order before reading quantity coverage. A lock taken
  // in the coverage SELECT itself can wait on another projector while retaining
  // its pre-wait snapshot, then overwrite that projector's completed status.
  const affected = await transaction.execute(sql`
    SELECT orders.id AS order_id
    FROM wms.orders orders
    WHERE orders.id IN (
      SELECT order_item.order_id
      FROM wms.physical_shipment_items physical_item
      JOIN wms.order_items order_item ON order_item.id = physical_item.wms_order_item_id
      WHERE physical_item.physical_shipment_id = ${physicalShipmentId}
        AND physical_item.shipment_item_purpose = 'customer_fulfillment'
    )
    ORDER BY orders.id
    FOR UPDATE OF orders
  `);
  const orderIds = affected.rows.map((row: { order_id: number }) => Number(row.order_id));

  const projectedItems = await transaction.execute(sql`
    WITH affected AS (
      SELECT DISTINCT item.wms_order_item_id
      FROM wms.physical_shipment_items item
      WHERE item.physical_shipment_id = ${physicalShipmentId}
        AND item.shipment_item_purpose = 'customer_fulfillment'
        AND item.wms_order_item_id IS NOT NULL
    ), shipped_quantities AS (
      SELECT item.wms_order_item_id,
             SUM(item.quantity_shipped)::int AS shipped_quantity
      FROM wms.effective_physical_shipment_items item
      JOIN wms.physical_shipments package ON package.id = item.physical_shipment_id
      JOIN wms.shipment_request_items request_item ON request_item.id = item.shipment_request_item_id
      LEFT JOIN wms.outbound_shipment_items legacy_item
        ON legacy_item.id = COALESCE(item.legacy_wms_shipment_item_id, request_item.legacy_wms_shipment_item_id)
      LEFT JOIN wms.outbound_shipments legacy_shipment ON legacy_shipment.id = legacy_item.shipment_id
      WHERE item.wms_order_item_id IN (SELECT wms_order_item_id FROM affected)
        AND item.shipment_item_purpose = 'customer_fulfillment'
        AND package.status IN ('shipped', 'returned')
        AND COALESCE(legacy_shipment.source, '') NOT LIKE '%_fulfillment_receipt'
      GROUP BY item.wms_order_item_id
    ), shipped AS (
      SELECT affected.wms_order_item_id, COALESCE(shipped_quantities.shipped_quantity, 0) AS shipped_quantity
      FROM affected
      LEFT JOIN shipped_quantities USING (wms_order_item_id)
    )
    UPDATE wms.order_items order_item
    SET fulfilled_quantity = LEAST(order_item.quantity, shipped.shipped_quantity),
        status = CASE
          WHEN COALESCE(order_item.picked_quantity, 0) >= order_item.quantity THEN 'completed'
          WHEN COALESCE(order_item.picked_quantity, 0) > 0 THEN 'in_progress'
          ELSE order_item.status
        END
    FROM shipped
    WHERE order_item.id = shipped.wms_order_item_id
      AND order_item.requires_shipping = 1
      AND order_item.status <> 'cancelled'
    RETURNING order_item.id, order_item.fulfilled_quantity, order_item.picked_quantity
  `);

  // A provider declaration owns box contents, not bin/lot pick evidence.
  // Retain the missing movement as work instead of manufacturing a picked counter.
  for (const row of projectedItems.rows) {
    await observeMissingPick(transaction, { orderItemId: Number(row.id), physicalShipmentId,
      declaredQuantity: Number(row.fulfilled_quantity), pickedQuantity: Number(row.picked_quantity), occurredAt: clock() });
  }

  if (orderIds.length === 0) return;
  const result = await transaction.execute(wmsShippingProgressQuery(orderIds));
  const orders = new Map<number, { status: WmsWarehouseStatus; lines: WmsShippingProgressLine[] }>();
  for (const row of result.rows as WmsShippingProgressRow[]) {
    const orderId = Number(row.order_id);
    const order: { status: WmsWarehouseStatus; lines: WmsShippingProgressLine[] } =
      orders.get(orderId) ?? { status: row.warehouse_status as WmsWarehouseStatus, lines: [] };
    order.lines.push(shippingProgressLine(row));
    orders.set(orderId, order);
  }
  for (const [orderId, order] of orders) {
    const status = deriveWmsShippingProgress(order.status, order.lines);
    const pickedCount = order.lines.filter(line => line.requiresShipping)
      .reduce((sum, line) => sum + line.pickedQuantity, 0);
    await transaction.execute(sql`
      UPDATE wms.orders
      SET picked_count = ${pickedCount}, warehouse_status = ${status}, updated_at = NOW()
      WHERE id = ${orderId}
    `);
  }
  await projectReconciledLegacyHeaders(transaction, physicalShipmentId, clock());
}

/** Compatibility headers are mutable projections. Original item quantities and
 * provider observations remain unchanged. A multi-parcel header has no single
 * physical tracking identity; each canonical package retains its own number. */
async function projectReconciledLegacyHeaders(transaction: any, physicalShipmentId: number, now: Date): Promise<void> {
  const receipt = await transaction.execute(sql`SELECT command.plan,command.result FROM wms.ebay_label_replacement_work work
    JOIN oms.package_reconciliation_commands command ON command.id=work.package_reconciliation_command_id
    WHERE work.physical_shipment_id=${physicalShipmentId} AND work.state='applied' AND command.state IN ('applied','complete')`);
  if (receipt.rows.length===0) return;
  if (receipt.rows.length!==1) throw new WmsFulfillmentProjectionError('RECONCILIATION_RECEIPT_CONFLICT','A physical package has conflicting reconciliation provenance');
  const quantities = new Map<number,{sourceQuantity:number;finalQuantity:number}>(receipt.rows[0].plan.sourceQuantities
    .map((item:{sourceItemId:number;sourceQuantity:number;finalQuantity:number})=>[item.sourceItemId,item]));
  const ids=[...quantities.keys()];
  const sourceRows = await transaction.execute(sql`SELECT item.id,item.shipment_id,item.shipment_item_purpose
    FROM wms.outbound_shipment_items item WHERE item.shipment_id IN (
      SELECT source.shipment_id FROM wms.outbound_shipment_items source WHERE source.id=ANY(${sqlIntegerArray(ids)})) ORDER BY item.shipment_id,item.id`);
  const headers=new Map<number,{id:number;shipment_item_purpose:string}[]>();
  for(const row of sourceRows.rows){const items=headers.get(row.shipment_id)??[];items.push(row);headers.set(row.shipment_id,items);}
  for(const [headerId,items] of headers){
    if(items.some(item=>item.shipment_item_purpose!=='customer_fulfillment'||!quantities.has(item.id)
      ||quantities.get(item.id)!.finalQuantity!==quantities.get(item.id)!.sourceQuantity))continue;
    const packages=await transaction.execute(sql`SELECT DISTINCT package.id,package.provider,package.provider_physical_shipment_id,
      package.tracking_number,package.carrier,package.ship_date,
      (SELECT COUNT(DISTINCT original.shipment_id)=1 AND COUNT(original.id)=COUNT(*)
       FROM wms.effective_physical_shipment_items member
       LEFT JOIN wms.package_allocation_entries allocation ON allocation.id=member.package_allocation_entry_id
       LEFT JOIN wms.package_allocation_source_lines allocation_source ON allocation_source.id=allocation.package_allocation_source_line_id
       LEFT JOIN wms.outbound_shipment_items original ON original.id=COALESCE(member.legacy_wms_shipment_item_id,
         member.label_replacement_source_item_id,allocation_source.source_wms_shipment_item_id)
       WHERE member.physical_shipment_id=package.id) AS exclusive_header
      FROM wms.effective_physical_shipment_items item
      JOIN wms.physical_shipments package ON package.id=item.physical_shipment_id
      LEFT JOIN wms.package_allocation_entries entry ON entry.id=item.package_allocation_entry_id
      LEFT JOIN wms.package_allocation_source_lines source ON source.id=entry.package_allocation_source_line_id
      WHERE COALESCE(item.legacy_wms_shipment_item_id,item.label_replacement_source_item_id,source.source_wms_shipment_item_id)
        =ANY(${sqlIntegerArray(items.map(item=>item.id))}) ORDER BY package.ship_date,package.id`);
    if(packages.rows.length===0)throw new WmsFulfillmentProjectionError('RECONCILIATION_COVERAGE_MISSING','A fully reconciled source has no current physical package',{headerId});
    const first=packages.rows[0];const single=packages.rows.length===1;
    const carriers=new Set(packages.rows.map((item:{carrier:string})=>item.carrier));
    await transaction.execute(sql`UPDATE wms.outbound_shipments SET status='shipped',
      tracking_number=${single?first.tracking_number:null},carrier=${carriers.size===1?first.carrier:null},
      -- This field is unique across legacy headers. A shared combined parcel
      -- belongs to canonical storage and cannot be claimed by either header.
      external_fulfillment_id=${single&&first.exclusive_header?`provider_physical:v1:${first.provider}:${first.provider_physical_shipment_id}`:null},
      shipped_at=${first.ship_date},updated_at=${now} WHERE id=${headerId}`);
  }
}
