import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";

type SqlExecutor = { execute: (...args: any[]) => any };

export async function backfillPlannedShipmentItemPickLocationInWms(
  executor: SqlExecutor,
  params: { orderItemId: number; productVariantId: number; locationId: number },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipment_items osi
    SET from_location_id = ${params.locationId}
    FROM wms.outbound_shipments os
    WHERE osi.shipment_id = os.id
      AND osi.order_item_id = ${params.orderItemId}
      AND osi.product_variant_id = ${params.productVariantId}
      AND osi.from_location_id IS NULL
      AND os.status IN ('planned', 'queued')
  `);
}

export async function consolidateOrderEditHeldShipmentItemsInWms(
  executor: SqlExecutor,
  input: { targetShipmentId: number; heldShipmentId: number },
): Promise<void> {
  await executor.execute(sql`UPDATE wms.outbound_shipment_items SET shipment_id=${input.targetShipmentId}
    WHERE shipment_id=${input.heldShipmentId}`);
}

export async function updateShipmentItemCommercialRequestedQtyInWms(
  executor: SqlExecutor,
  input: { shipmentItemId: number; shipmentId: number; nextQuantity: number },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipment_items
    SET commercial_requested_qty = ${input.nextQuantity}
    WHERE id = ${input.shipmentItemId}
      AND shipment_id = ${input.shipmentId}
  `);
}

export async function insertHistoricalSplitCopiedShipmentItemInWms(
  client: Pick<PoolClient, "query">,
  input: {
    sourceItemId: number;
    targetShipmentId: number;
    quantity: number;
    providerShipmentId: number;
  },
): Promise<{ rows: Array<Record<string, unknown>> }> {
  return client.query(
    `INSERT INTO wms.outbound_shipment_items (
       shipment_id, order_item_id, replacement_for_order_item_id,
       shipment_item_purpose, product_variant_id, qty,
       from_location_id, box_id, weight_oz, tracking_id,
       provider_membership_state, created_at
     )
     SELECT $2, order_item_id, replacement_for_order_item_id,
       shipment_item_purpose, product_variant_id, $3,
       from_location_id, box_id, weight_oz, $4, 'authoritative', NOW()
     FROM wms.outbound_shipment_items WHERE id = $1
     RETURNING id`,
    [
      input.sourceItemId,
      input.targetShipmentId,
      input.quantity,
      String(input.providerShipmentId),
    ],
  );
}

export async function updateHistoricalSplitResidentShipmentItemInWms(
  client: Pick<PoolClient, "query">,
  input: { sourceItemId: number; quantity: number; providerShipmentId: number },
): Promise<void> {
  await client.query(
    `UPDATE wms.outbound_shipment_items
     SET qty = $2, tracking_id = $3, provider_membership_state = 'authoritative'
     WHERE id = $1`,
    [input.sourceItemId, input.quantity, String(input.providerShipmentId)],
  );
}

export async function reduceHistoricalSplitSourceShipmentItemQtyInWms(
  client: Pick<PoolClient, "query">,
  input: { sourceItemId: number; subtractQty: number; expectedQty: number },
): Promise<{ rows: Array<Record<string, unknown>> }> {
  return client.query(
    `UPDATE wms.outbound_shipment_items SET qty = qty - $2
     WHERE id = $1 AND qty = $3 AND qty > $2 RETURNING id`,
    [input.sourceItemId, input.subtractQty, input.expectedQty],
  );
}

export async function moveHistoricalSplitSourceShipmentItemInWms(
  client: Pick<PoolClient, "query">,
  input: {
    sourceItemId: number;
    targetShipmentId: number;
    quantity: number;
    providerShipmentId: number;
    expectedShipmentId: number;
    expectedQty: number;
  },
): Promise<{ rows: Array<Record<string, unknown>> }> {
  return client.query(
    `UPDATE wms.outbound_shipment_items
     SET shipment_id = $2, qty = $3, tracking_id = $4,
         provider_membership_state = 'authoritative'
     WHERE id = $1 AND shipment_id = $5 AND qty = $6 RETURNING id`,
    [
      input.sourceItemId,
      input.targetShipmentId,
      input.quantity,
      String(input.providerShipmentId),
      input.expectedShipmentId,
      input.expectedQty,
    ],
  );
}

export async function displaceExactTargetCopyShipmentItemToArchiveInWms(
  client: Pick<PoolClient, "query">,
  input: {
    copiedItemId: number;
    archiveShipmentId: number;
    expectedShipmentId: number;
  },
): Promise<{ rows: Array<Record<string, unknown>> }> {
  return client.query(
    `UPDATE wms.outbound_shipment_items
     SET shipment_id = $2
     WHERE id = $1 AND shipment_id = $3
     RETURNING id`,
    [input.copiedItemId, input.archiveShipmentId, input.expectedShipmentId],
  );
}

export async function archiveDuplicateSourceShipmentItemInWms(
  client: Pick<PoolClient, "query">,
  input: {
    sourceItemId: number;
    archiveShipmentId: number;
    expectedShipmentId: number;
    expectedQty: number;
  },
): Promise<{ rows: Array<Record<string, unknown>> }> {
  return client.query(
    `UPDATE wms.outbound_shipment_items
     SET shipment_id = $2
     WHERE id = $1 AND shipment_id = $3 AND qty = $4
     RETURNING id`,
    [
      input.sourceItemId,
      input.archiveShipmentId,
      input.expectedShipmentId,
      input.expectedQty,
    ],
  );
}

export async function setHistoricalSplitSourceRemainingQtyInWms(
  client: Pick<PoolClient, "query">,
  input: {
    sourceItemId: number;
    remainingQuantity: number;
    expectedShipmentId: number;
    expectedQty: number;
  },
): Promise<{ rows: Array<Record<string, unknown>> }> {
  return client.query(
    `UPDATE wms.outbound_shipment_items
     SET qty = $2
     WHERE id = $1 AND shipment_id = $3 AND qty = $4 AND $2 > 0
     RETURNING id`,
    [
      input.sourceItemId,
      input.remainingQuantity,
      input.expectedShipmentId,
      input.expectedQty,
    ],
  );
}

export async function insertUnmappedRemediationShipmentItemInWms(
  executor: SqlExecutor,
  input: {
    shipmentId: number;
    replacementForOrderItemId: number | null;
    correctionForShipmentItemId: number | null;
    shipmentItemPurpose: string;
    productVariantId: number;
    quantity: number;
    fromLocationId: number | null;
    trackingId: string;
  },
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO wms.outbound_shipment_items (
      shipment_id, order_item_id, replacement_for_order_item_id,
      correction_for_shipment_item_id,
      shipment_item_purpose, product_variant_id, qty,
      from_location_id, tracking_id, created_at
    )
    VALUES (
      ${input.shipmentId}, NULL,
      ${input.replacementForOrderItemId},
      ${input.correctionForShipmentItemId},
      ${input.shipmentItemPurpose}, ${input.productVariantId},
      ${input.quantity}, ${input.fromLocationId}, ${input.trackingId}, NOW()
    )
  `);
}

export async function moveWholeShipmentItemToPhysicalSplitInWms(
  executor: SqlExecutor,
  input: {
    sourceShipmentItemId: number;
    parentShipmentId: number;
    splitShipmentId: number;
    qty: number;
    trackingId: string;
  },
): Promise<any> {
  return executor.execute(sql`
    UPDATE wms.outbound_shipment_items
    SET shipment_id = ${input.splitShipmentId},
        tracking_id = ${input.trackingId},
        split_root_shipment_item_id = COALESCE(
          split_root_shipment_item_id,
          id
        )
    WHERE id = ${input.sourceShipmentItemId}
      AND shipment_id = ${input.parentShipmentId}
      AND qty = ${input.qty}
    RETURNING id
  `);
}

export async function copyPartialShipmentItemToPhysicalSplitInWms(
  executor: SqlExecutor,
  input: {
    sourceShipmentItemId: number;
    parentShipmentId: number;
    splitShipmentId: number;
    rootSourceShipmentItemId: number;
    qty: number;
    childCommercialQty: number | null;
    trackingId: string;
  },
): Promise<any> {
  return executor.execute(sql`
    INSERT INTO wms.outbound_shipment_items
      (shipment_id, order_item_id, replacement_for_order_item_id,
       correction_for_shipment_item_id, split_root_shipment_item_id,
       shipment_item_purpose, product_variant_id, qty,
       commercial_requested_qty,
       from_location_id, box_id, weight_oz, tracking_id, created_at)
    SELECT
      ${input.splitShipmentId}, order_item_id, replacement_for_order_item_id,
      correction_for_shipment_item_id, ${input.rootSourceShipmentItemId},
      shipment_item_purpose, product_variant_id, ${input.qty},
      ${input.childCommercialQty},
      from_location_id, box_id, weight_oz,
      ${input.trackingId}, NOW()
    FROM wms.outbound_shipment_items
    WHERE id = ${input.sourceShipmentItemId}
      AND shipment_id = ${input.parentShipmentId}
    RETURNING id
  `);
}

export async function reduceParentShipmentItemAfterPhysicalSplitInWms(
  executor: SqlExecutor,
  input: {
    sourceShipmentItemId: number;
    parentShipmentId: number;
    splitQty: number;
    retainedCommercialQty: number | null;
  },
): Promise<any> {
  return executor.execute(sql`
    UPDATE wms.outbound_shipment_items
    SET qty = qty - ${input.splitQty},
        commercial_requested_qty = ${input.retainedCommercialQty}
    WHERE id = ${input.sourceShipmentItemId}
      AND shipment_id = ${input.parentShipmentId}
      AND qty > ${input.splitQty}
    RETURNING id
  `);
}

export async function syncOriginalShipmentItemFromShipStationInWms(
  executor: SqlExecutor,
  input: {
    shipmentItemId: number;
    qty: number;
    fromLocationId: number | null;
    trackingId: string;
  },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipment_items
    SET qty = ${input.qty},
        commercial_requested_qty = CASE
          WHEN commercial_requested_qty IS NULL THEN NULL
          ELSE LEAST(commercial_requested_qty, ${input.qty})
        END,
        from_location_id = COALESCE(from_location_id, ${input.fromLocationId}),
        tracking_id = ${input.trackingId},
        provider_membership_state = 'authoritative'
    WHERE id = ${input.shipmentItemId}
  `);
}

export async function updateExistingSplitChildShipmentItemFromShipStationInWms(
  executor: SqlExecutor,
  input: {
    childItemId: number;
    productVariantId: number | null;
    qty: number;
    fromLocationId: number | null;
    boxId: number | null;
    weightOz: unknown;
    trackingId: string;
    splitRootShipmentItemId: number | null;
  },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipment_items
    SET product_variant_id = ${input.productVariantId},
        qty = ${input.qty},
        commercial_requested_qty = CASE
          WHEN commercial_requested_qty IS NULL THEN NULL
          ELSE LEAST(commercial_requested_qty, ${input.qty})
        END,
        from_location_id = ${input.fromLocationId},
        box_id = ${input.boxId},
        weight_oz = ${input.weightOz},
        tracking_id = ${input.trackingId},
        split_root_shipment_item_id = COALESCE(
          split_root_shipment_item_id,
          ${input.splitRootShipmentItemId}
        ),
        provider_membership_state = 'authoritative'
    WHERE id = ${input.childItemId}
  `);
}

export async function insertLegacySplitChildShipmentItemFromShipStationInWms(
  executor: SqlExecutor,
  input: {
    targetShipmentId: number;
    orderItemId: number | null;
    replacementForOrderItemId: number | null;
    correctionForShipmentItemId: number | null;
    splitRootShipmentItemId: number | null;
    shipmentItemPurpose: string;
    productVariantId: number | null;
    qty: number;
    fromLocationId: number | null;
    boxId: number | null;
    weightOz: unknown;
    trackingId: string;
  },
): Promise<any> {
  return executor.execute(sql`
    INSERT INTO wms.outbound_shipment_items
      (shipment_id, order_item_id, replacement_for_order_item_id,
       correction_for_shipment_item_id, split_root_shipment_item_id,
       shipment_item_purpose, product_variant_id, qty,
       from_location_id, box_id, weight_oz, tracking_id)
    VALUES
      (${input.targetShipmentId}, ${input.orderItemId},
       ${input.replacementForOrderItemId},
       ${input.correctionForShipmentItemId},
       ${input.splitRootShipmentItemId},
       ${input.shipmentItemPurpose},
       ${input.productVariantId},
       ${input.qty}, ${input.fromLocationId}, ${input.boxId},
       ${input.weightOz}, ${input.trackingId})
    RETURNING id
  `);
}

export async function updateReplacementShipmentItemLocationInWms(
  executor: SqlExecutor,
  input: { shipmentItemId: number; warehouseLocationId: number | null },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipment_items
    SET from_location_id = ${input.warehouseLocationId}
    WHERE id = ${input.shipmentItemId}
      AND from_location_id IS DISTINCT FROM ${input.warehouseLocationId}
  `);
}

export async function markAppendedShipmentItemsAuthoritativeInWms(
  executor: SqlExecutor,
  input: { shipmentId: number; normalizedItemIds: readonly number[] },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipment_items
    SET provider_membership_state = 'authoritative'
    WHERE shipment_id = ${input.shipmentId}
      AND id = ANY(ARRAY[${sql.join(input.normalizedItemIds.map((id) => sql`${id}`), sql`, `)}]::int[])
  `);
}

export async function commitAmendedShipmentItemQuantityInWms(
  executor: SqlExecutor,
  input: { shipmentItemId: number; targetQuantity: number; currentQuantity: number },
): Promise<any> {
  return executor.execute(sql`
    UPDATE wms.outbound_shipment_items
    SET qty = ${input.targetQuantity}
    WHERE id = ${input.shipmentItemId}
      AND qty = ${input.currentQuantity}
    RETURNING id
  `);
}
