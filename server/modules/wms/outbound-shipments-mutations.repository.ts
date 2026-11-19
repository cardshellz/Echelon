import { sql, type SQL } from "drizzle-orm";
import type { PoolClient } from "pg";

type SqlExecutor = { execute: (...args: any[]) => any };

// ─── Reconciler & Startup Sweeps (server/index.ts) ──────────────────────────

export async function recordOutboundShipmentAlreadyShippedInEngineInWms(
  executor: SqlExecutor,
  shipmentId: number,
  options?: { stampReconciled?: boolean },
): Promise<void> {
  if (options?.stampReconciled) {
    await executor.execute(sql`
      UPDATE wms.outbound_shipments
      SET status = 'shipped', last_reconciled_at = NOW(), updated_at = NOW()
      WHERE id = ${shipmentId}
        AND status NOT IN ('shipped', 'returned', 'lost')
    `);
    return;
  }
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET status = 'shipped', updated_at = NOW()
    WHERE id = ${shipmentId}
      AND status NOT IN ('shipped', 'returned', 'lost')
  `);
}

export async function cancelOutboundShipmentAfterEngineCascadeInWms(
  executor: SqlExecutor,
  shipmentId: number,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
    WHERE id = ${shipmentId}
      AND status NOT IN ('shipped', 'returned', 'lost')
  `);
}

export async function cancelDuplicateOutboundShipmentInWms(
  executor: SqlExecutor,
  shipmentId: number,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
    WHERE id = ${shipmentId}
      AND status NOT IN ('shipped', 'returned', 'lost')
      AND shipped_at IS NULL
  `);
}

export async function touchOutboundShipmentLastReconciledInWms(
  executor: SqlExecutor,
  shipmentId: number,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET last_reconciled_at = NOW()
    WHERE id = ${shipmentId}
  `);
}

export async function flagOutboundShipmentReconcileReviewIfUnsetInWms(
  executor: SqlExecutor,
  shipmentId: number,
  reason: string,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = true,
        review_reason = CASE WHEN COALESCE(requires_review, false)
                             THEN review_reason ELSE ${reason} END,
        last_reconciled_at = NOW(),
        updated_at = NOW()
    WHERE id = ${shipmentId}
  `);
}

export async function flagOutboundShipmentPhysicalAuthorityRequiredInWms(
  executor: SqlExecutor,
  shipmentId: number,
  reason: string,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = true,
        review_reason = COALESCE(NULLIF(review_reason, ''), ${reason}),
        last_reconciled_at = NOW(),
        updated_at = NOW()
    WHERE id = ${shipmentId}
  `);
}

export async function flagOutboundShipmentReconcileErrorInWms(
  executor: SqlExecutor,
  shipmentId: number,
  errMsg: string,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET last_reconciled_at = NOW(),
        requires_review = true,
        review_reason = ${errMsg}
    WHERE id = ${shipmentId}
  `);
}

// ─── Shipment Rollup (orders/shipment-rollup.ts) ────────────────────────────

export async function markOutboundShipmentShippedRowInWms(
  executor: SqlExecutor,
  input: {
    shipmentId: number;
    carrier: string;
    serviceCode: string | null;
    trackingNumber: string;
    trackingUrl: string | null;
    shipDate: Date;
    hasCarrierCost: boolean;
    carrierCostCents: number | null;
    carrierCostSource: string | null;
    now: Date;
  },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments SET
      status = 'shipped',
      carrier = ${input.carrier},
      service_code = COALESCE(${input.serviceCode}, service_code),
      tracking_number = ${input.trackingNumber},
      tracking_url = ${input.trackingUrl},
      shipped_at = ${input.shipDate},
      carrier_cost_cents = CASE
        WHEN ${input.hasCarrierCost} THEN ${input.carrierCostCents}
        ELSE carrier_cost_cents
      END,
      carrier_cost_source = CASE
        WHEN ${input.hasCarrierCost} THEN ${input.carrierCostSource}
        ELSE carrier_cost_source
      END,
      carrier_cost_recorded_at = CASE
        WHEN ${input.hasCarrierCost} THEN ${input.now}
        ELSE carrier_cost_recorded_at
      END,
      updated_at = ${input.now}
    WHERE id = ${input.shipmentId}
      AND status NOT IN ('returned', 'lost')
  `);
}

export async function markOutboundShipmentCancelledRowInWms(
  executor: SqlExecutor,
  input: { shipmentId: number; now: Date; safeReason: string },
): Promise<any> {
  return executor.execute(sql`
    UPDATE wms.outbound_shipments SET
      status = 'cancelled',
      cancelled_at = ${input.now},
      voided_reason = ${input.safeReason},
      updated_at = ${input.now}
    WHERE id = ${input.shipmentId}
      AND status NOT IN ('cancelled', 'shipped', 'returned', 'lost')
      AND shipped_at IS NULL
    RETURNING id
  `);
}

export async function flagOutboundShipmentAddressChangedAfterLabelInWms(
  executor: SqlExecutor,
  input: { shipmentId: number; now: Date },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments SET
      requires_review = true,
      review_reason = 'address_changed_after_label',
      address_changed_after_label = true,
      updated_at = ${input.now}
    WHERE id = ${input.shipmentId}
  `);
}

export async function markOutboundShipmentVoidedRowInWms(
  executor: SqlExecutor,
  input: { shipmentId: number; now: Date; safeReason: string },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments SET
      status = 'voided',
      voided_at = ${input.now},
      voided_reason = ${input.safeReason},
      tracking_number = NULL,
      tracking_url = NULL,
      updated_at = ${input.now}
    WHERE id = ${input.shipmentId}
      AND status IN ('planned', 'queued', 'labeled', 'shipped')
  `);
}

export async function cancelStaleFullyCoveredOutboundShipmentsInWms(
  executor: SqlExecutor,
  wmsOrderId: number,
): Promise<any> {
  return executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET status = 'cancelled',
        cancelled_at = NOW(),
        updated_at = NOW()
    WHERE order_id = ${wmsOrderId}
      AND status IN ('planned', 'queued')
      AND shipped_at IS NULL
    RETURNING id
  `);
}

// ─── OMS Coordination & Writeback ───────────────────────────────────────────

export async function flagOutboundShipmentsExceedingLineAuthorityInWms(
  executor: SqlExecutor,
  affectedIdsSql: SQL,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = true,
        review_reason = COALESCE(
          NULLIF(BTRIM(review_reason), ''),
          'physical_shipment_exceeds_current_line_authority'
        ),
        updated_at = NOW()
    WHERE id IN (${affectedIdsSql})
  `);
}

export async function persistShopifyFulfillmentIdOnLegacyOutboundShipmentsInWms(
  executor: SqlExecutor,
  shipmentIdsBigintArraySql: SQL,
  fulfillmentId: string,
): Promise<any> {
  return executor.execute(sql`
    UPDATE wms.outbound_shipments
       SET shopify_fulfillment_id = ${fulfillmentId},
           updated_at = NOW()
     WHERE id = ANY(${shipmentIdsBigintArraySql})
       AND (shopify_fulfillment_id IS NULL OR shopify_fulfillment_id = '')
  `);
}

export async function clearDeadShopifyFulfillmentIdsOnOutboundShipmentInWms(
  executor: SqlExecutor,
  shipmentId: number,
  deadFulfillmentIdsTextArraySql: SQL,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET shopify_fulfillment_id = NULL, updated_at = NOW()
    WHERE id = ${shipmentId}
      AND shopify_fulfillment_id = ANY(${deadFulfillmentIdsTextArraySql})
  `);
}

export async function flagShippedOutboundShipmentOmsTerminalReviewInWms(
  executor: SqlExecutor,
  shipmentId: number,
  reason: string,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = true,
        review_reason = ${reason},
        updated_at = NOW()
    WHERE id = ${shipmentId}
      AND COALESCE(requires_review, false) = false
  `);
}

export async function consolidateOrderEditHeldOutboundShipmentsInWms(
  executor: SqlExecutor,
  input: { parentShipmentId: number; heldShipmentId: number; now: Date },
): Promise<void> {
  await executor.execute(sql`UPDATE wms.outbound_shipments parent SET held=true,
    held_at=CASE WHEN parent.held THEN parent.held_at ELSE child.held_at END,
    on_hold_reason=CASE WHEN parent.held THEN parent.on_hold_reason ELSE child.on_hold_reason END,updated_at=${input.now}
    FROM wms.outbound_shipments child WHERE parent.id=${input.parentShipmentId} AND child.id=${input.heldShipmentId}`);
  await executor.execute(sql`UPDATE wms.outbound_shipments SET status='cancelled',cancelled_at=${input.now},
    voided_reason='order_edit_held_partition_consolidated',updated_at=${input.now}
    WHERE id=${input.heldShipmentId}
      AND status NOT IN ('shipped', 'returned', 'lost')
      AND shipped_at IS NULL`);
}

export async function adoptProvenShipStationOrderOnOutboundShipmentInWms(
  executor: SqlExecutor,
  input: { shipmentId: number; providerOrderId: number; orderKey: string },
): Promise<any> {
  return executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET shipstation_order_id = ${input.providerOrderId},
        shipstation_order_key = ${input.orderKey},
        shipping_engine = 'shipstation',
        engine_order_ref = ${String(input.providerOrderId)},
        engine_shipment_ref = ${input.orderKey},
        status = CASE WHEN status = 'planned' THEN 'queued'::wms.shipment_status ELSE status END,
        requires_review = CASE
          WHEN review_reason = 'shipstation_push_retry_exhausted' THEN false
          ELSE requires_review
        END,
        review_reason = CASE
          WHEN review_reason = 'shipstation_push_retry_exhausted' THEN NULL
          ELSE review_reason
        END,
        updated_at = NOW()
    WHERE id = ${input.shipmentId}
      AND status IN ('planned', 'queued', 'labeled', 'on_hold')
      AND (
        shipstation_order_id IS NULL
        OR shipstation_order_id = ${input.providerOrderId}
      )
    RETURNING order_id
  `);
}

export async function setOutboundShipmentReviewFlagInWms(
  executor: SqlExecutor,
  shipmentId: number,
  reason: string,
  updatedAt?: Date,
): Promise<void> {
  if (updatedAt) {
    await executor.execute(sql`
      UPDATE wms.outbound_shipments
      SET requires_review = true,
          review_reason = ${reason},
          updated_at = ${updatedAt}
      WHERE id = ${shipmentId}
    `);
    return;
  }
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = true,
        review_reason = ${reason},
        updated_at = NOW()
    WHERE id = ${shipmentId}
  `);
}

export async function clearResolvedShipStationQueueReviewFlagsInWms(
  executor: SqlExecutor,
  activeIds: readonly number[],
): Promise<void> {
  const activePredicate = activeIds.length > 0
    ? sql`AND id NOT IN (${sql.join(activeIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = false,
        review_reason = NULL,
        updated_at = NOW()
    WHERE requires_review = true
      AND review_reason = 'shipstation_queue_review_required'
      ${activePredicate}
  `);
}

export async function clearResolvedShopifyWritebackDebtReviewFlagsInWms(
  executor: SqlExecutor,
  resolvedShipmentIdsArraySql: SQL,
  reviewReasonPrefix: string,
  resolvedAt: Date,
): Promise<any> {
  return executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = false,
        review_reason = NULL,
        updated_at = ${resolvedAt}
    WHERE id = ANY(${resolvedShipmentIdsArraySql})
      AND requires_review = true
      AND review_reason LIKE ${`${reviewReasonPrefix}%`}
    RETURNING id
  `);
}

export async function flagOutboundShipmentPushRetryFailureReviewInWms(
  executor: SqlExecutor,
  shipmentId: number,
  reason: string,
  excludeShipped: boolean,
): Promise<void> {
  if (excludeShipped) {
    await executor.execute(sql`
      UPDATE wms.outbound_shipments
      SET requires_review = true,
          review_reason = CASE
            WHEN review_reason IS NULL
              OR review_reason = 'inventory_deduction_missing_item_data'
            THEN ${reason}
            ELSE review_reason
          END,
          updated_at = NOW()
      WHERE id = ${shipmentId}
        AND status NOT IN ('shipped', 'cancelled', 'voided')
    `);
    return;
  }
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = true,
        review_reason = CASE
          WHEN review_reason IS NULL
            OR review_reason = 'inventory_deduction_missing_item_data'
          THEN ${reason}
          ELSE review_reason
        END,
        updated_at = NOW()
    WHERE id = ${shipmentId}
      AND status NOT IN ('cancelled', 'voided')
  `);
}

export async function cancelEmptiedByLineHoldOutboundShipmentInWms(
  executor: SqlExecutor,
  shipmentId: number,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET status = 'cancelled',
        cancelled_at = NOW(),
        voided_reason = 'emptied_by_line_item_hold',
        updated_at = NOW()
    WHERE id = ${shipmentId}
      AND status NOT IN ('shipped', 'returned', 'lost', 'voided', 'cancelled')
      AND shipped_at IS NULL
  `);
}

// ─── Historical ShipStation Split Repair (PoolClient) ───────────────────────

export async function retireHistoricalSplitDuplicateOutboundShipmentInWms(
  client: Pick<PoolClient, "query">,
  input: {
    retiredDuplicateShipmentId: number;
    retiredIdentity: string;
    expectedIdentity: string;
    occurredAt: Date;
  },
): Promise<{ rows: Array<Record<string, unknown>> }> {
  return client.query(
    `UPDATE wms.outbound_shipments
     SET external_fulfillment_id = $2,
         requires_review = false,
         review_reason = 'historical_provider_identity_duplicate_retired',
         updated_at = $4
     WHERE id = $1
       AND external_fulfillment_id = $3
       AND status IN ('voided', 'cancelled')
       AND NOT EXISTS (
         SELECT 1
         FROM wms.outbound_shipment_items AS item
         JOIN wms.effective_physical_shipment_items AS physical_item
           ON physical_item.legacy_wms_shipment_item_id = item.id
         WHERE item.shipment_id = wms.outbound_shipments.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM wms.outbound_shipment_items AS item
         JOIN oms.channel_fulfillment_receipt_items AS receipt_item
           ON receipt_item.legacy_wms_shipment_item_id = item.id
         WHERE item.shipment_id = wms.outbound_shipments.id
       )
     RETURNING id`,
    [
      input.retiredDuplicateShipmentId,
      input.retiredIdentity,
      input.expectedIdentity,
      input.occurredAt,
    ],
  );
}

export async function adoptHistoricalSplitTargetOutboundShipmentInWms(
  client: Pick<PoolClient, "query">,
  input: {
    shipmentId: number;
    identity: string;
    providerOrderId: number;
    providerShipmentId: number;
    providerOrderKey: string | null;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `UPDATE wms.outbound_shipments
     SET external_fulfillment_id = COALESCE(external_fulfillment_id, $2),
         shipping_engine = COALESCE(NULLIF(BTRIM(shipping_engine), ''), 'shipstation'),
         engine_order_ref = COALESCE(NULLIF(BTRIM(engine_order_ref), ''), $3),
         engine_shipment_ref = COALESCE(NULLIF(BTRIM(engine_shipment_ref), ''), $4),
         shipstation_order_id = COALESCE(shipstation_order_id, $5),
         shipstation_order_key = COALESCE(NULLIF(BTRIM(shipstation_order_key), ''), $6),
         requires_review = false, review_reason = NULL, updated_at = $7
     WHERE id = $1`,
    [
      input.shipmentId,
      input.identity,
      String(input.providerOrderId),
      String(input.providerShipmentId),
      input.providerOrderId,
      input.providerOrderKey,
      input.occurredAt,
    ],
  );
}

export async function insertHistoricalSplitTargetOutboundShipmentInWms(
  client: Pick<PoolClient, "query">,
  input: {
    orderId: number;
    channelId: number | null;
    identity: string;
    source: string;
    carrierCode: string | null;
    serviceCode: string | null;
    trackingNumber: string;
    shippedAt: Date | null;
    providerOrderId: number;
    providerShipmentId: number;
    providerOrderKey: string | null;
    occurredAt: Date;
  },
): Promise<{ rows: Array<Record<string, unknown>> }> {
  return client.query(
    `INSERT INTO wms.outbound_shipments (
       order_id, channel_id, external_fulfillment_id, source, status,
       carrier, service_code, tracking_number, shipped_at,
       shipping_engine, engine_order_ref, engine_shipment_ref,
       shipstation_order_id, shipstation_order_key,
       shipment_purpose, requires_review, review_reason, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'shipped', $5, $6, $7, $8,
       'shipstation', $9, $10, $11, $12,
       'customer_fulfillment', false, NULL, $13, $13
     ) RETURNING id`,
    [
      input.orderId,
      input.channelId,
      input.identity,
      input.source,
      input.carrierCode,
      input.serviceCode,
      input.trackingNumber,
      input.shippedAt,
      String(input.providerOrderId),
      String(input.providerShipmentId),
      input.providerOrderId,
      input.providerOrderKey,
      input.occurredAt,
    ],
  );
}

export async function activateRecoveredProviderTargetOutboundShipmentInWms(
  client: Pick<PoolClient, "query">,
  input: {
    shipmentId: number;
    orderId: number;
    identity: string;
    expectedStatus: string;
    expectedTrackingNumber: string | null;
    carrierCode: string | null;
    serviceCode: string | null;
    trackingNumber: string;
    shippedAt: Date | null;
    providerOrderId: number;
    providerShipmentId: number;
    providerOrderKey: string | null;
    occurredAt: Date;
  },
): Promise<{ rows: Array<Record<string, unknown>> }> {
  return client.query(
    `UPDATE wms.outbound_shipments AS shipment
     SET status = 'shipped',
         carrier = $2, service_code = $3, tracking_number = $4, shipped_at = $5,
         tracking_url = NULL,
         shipping_engine = 'shipstation', engine_order_ref = $6,
         engine_shipment_ref = $7, shipstation_order_id = $8,
         shipstation_order_key = $9, requires_review = false,
         review_reason = NULL, cancelled_at = NULL, voided_at = NULL,
         voided_reason = NULL, held = false, held_at = NULL,
         on_hold_reason = NULL, updated_at = $10
     WHERE shipment.id = $1
       AND shipment.order_id = $11
       AND shipment.external_fulfillment_id = $12
       AND shipment.status::text = $13
       AND shipment.tracking_number IS NOT DISTINCT FROM $14::varchar
       AND shipment.status IN ('queued', 'voided', 'cancelled')
       AND NOT EXISTS (
         SELECT 1
         FROM wms.outbound_shipment_items AS item
         JOIN wms.effective_physical_shipment_items AS physical_item
           ON physical_item.legacy_wms_shipment_item_id = item.id
         WHERE item.shipment_id = shipment.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM wms.outbound_shipment_items AS item
         JOIN oms.channel_fulfillment_receipt_items AS receipt_item
           ON receipt_item.legacy_wms_shipment_item_id = item.id
         WHERE item.shipment_id = shipment.id
       )
     RETURNING shipment.id`,
    [
      input.shipmentId,
      input.carrierCode,
      input.serviceCode,
      input.trackingNumber,
      input.shippedAt,
      String(input.providerOrderId),
      String(input.providerShipmentId),
      input.providerOrderId,
      input.providerOrderKey,
      input.occurredAt,
      input.orderId,
      input.identity,
      input.expectedStatus,
      input.expectedTrackingNumber,
    ],
  );
}

export async function insertHistoricalSplitDuplicateArchiveOutboundShipmentInWms(
  client: Pick<PoolClient, "query">,
  input: {
    orderId: number;
    channelId: number | null;
    archiveIdentity: string;
    source: string;
    reviewReason: string;
    occurredAt: Date;
  },
): Promise<{ rows: Array<Record<string, unknown>> }> {
  return client.query(
    `INSERT INTO wms.outbound_shipments (
       order_id, channel_id, external_fulfillment_id, source, status,
       shipping_engine, shipment_purpose, requires_review, review_reason,
       cancelled_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'cancelled',
       'shipstation', 'customer_fulfillment', false, $5,
       $6, $6, $6
     )
     RETURNING id`,
    [
      input.orderId,
      input.channelId,
      input.archiveIdentity,
      input.source,
      input.reviewReason,
      input.occurredAt,
    ],
  );
}

export async function cancelRepartitionedAggregateOutboundShipmentsInWms(
  client: Pick<PoolClient, "query">,
  input: {
    sourceShipmentIds: readonly number[];
    targetIds: readonly number[];
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `UPDATE wms.outbound_shipments AS shipment
     SET status = 'cancelled', requires_review = false,
         review_reason = 'historical_aggregate_repartitioned',
         cancelled_at = COALESCE(cancelled_at, $3), updated_at = $3
     WHERE shipment.id = ANY($1::int[])
       AND NOT (shipment.id = ANY($2::int[]))
       AND shipment.status = 'shipped'
       AND NOT EXISTS (
         SELECT 1 FROM wms.outbound_shipment_items AS item
         WHERE item.shipment_id = shipment.id
       )`,
    [input.sourceShipmentIds, input.targetIds, input.occurredAt],
  );
}

export async function clearHistoricalSplitUnmappedReviewFlagsInWms(
  client: Pick<PoolClient, "query">,
  input: {
    legacyWmsShipmentIds: readonly number[];
    occurredAt: Date;
    reasons: readonly string[];
  },
): Promise<void> {
  await client.query(
    `UPDATE wms.outbound_shipments
     SET requires_review = false, review_reason = NULL, updated_at = $2
     WHERE id = ANY($1::int[])
       AND review_reason = ANY($3::text[])`,
    [input.legacyWmsShipmentIds, input.occurredAt, input.reasons],
  );
}

// ─── ShipStation Unmapped Remediation ───────────────────────────────────────

export async function voidSupersededCandidateOutboundShipmentInWms(
  executor: SqlExecutor,
  input: {
    supersededCandidateShipmentId: number;
    supersededTrackingNumber: string | null;
    supersededVoidDate: Date;
  },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET status = 'voided',
        tracking_number = ${input.supersededTrackingNumber},
        voided_at = COALESCE(voided_at, ${input.supersededVoidDate}),
        requires_review = false,
        review_reason = 'shipstation_superseded_label_reconciled',
        updated_at = NOW()
    WHERE id = ${input.supersededCandidateShipmentId}
      AND status IN ('planned', 'queued', 'labeled', 'shipped')
  `);
}

export async function collapseHistoricalSplitGhostOutboundShipmentInWms(
  executor: SqlExecutor,
  historicalGhostShipmentId: number,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET external_fulfillment_id = NULL,
        requires_review = false,
        review_reason = 'shipstation_split_ghost_collapsed',
        updated_at = NOW()
    WHERE id = ${historicalGhostShipmentId}
  `);
}

export async function restoreOriginalShipStationOutboundShipmentIdentityInWms(
  executor: SqlExecutor,
  input: {
    wmsShipmentId: number;
    providerShipmentId: number;
    originalTrackingNumber: string | null;
    providerOrderId: number;
    providerOrderKey: string | null;
  },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET external_fulfillment_id = ${`shipstation_shipment:${input.providerShipmentId}`},
        tracking_number = ${input.originalTrackingNumber},
        shipstation_order_id = ${input.providerOrderId},
        shipstation_order_key = ${input.providerOrderKey},
        engine_order_ref = ${String(input.providerOrderId)},
        engine_shipment_ref = ${input.providerOrderKey},
        requires_review = false,
        review_reason = 'shipstation_original_identity_restored',
        updated_at = NOW()
    WHERE id = ${input.wmsShipmentId}
  `);
}

export async function markOriginalOutboundShipmentLostForReshipInWms(
  executor: SqlExecutor,
  originalShipmentId: number,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET status = 'lost',
        lost_at = COALESCE(lost_at, NOW()),
        lost_reason = COALESCE(lost_reason, 'operator_confirmed_lost_for_reship'),
        updated_at = NOW()
    WHERE id = ${originalShipmentId}
      AND status = 'shipped'
  `);
}

export async function insertClassifiedReplacementOutboundShipmentInWms(
  executor: SqlExecutor,
  input: {
    wmsOrderId: number;
    externalFulfillmentId: string;
    trackingNumber: string | null;
    carrierCode: string | null;
    serviceCode: string | null;
    providerOrderId: number;
    providerOrderKey: string | null;
    originalShipmentId: number;
    reason: string;
    authorizedAt: Date;
    operator: string;
  },
): Promise<any> {
  return executor.execute(sql`
    INSERT INTO wms.outbound_shipments (
      order_id, channel_id, external_fulfillment_id, source, status,
      tracking_number, carrier, service_code,
      shipstation_order_id, shipstation_order_key,
      shipping_engine, engine_order_ref, engine_shipment_ref,
      requires_review, review_reason,
      shipment_purpose, replaces_shipment_id, replacement_reason,
      replacement_authorized_at, replacement_authorized_by,
      created_at, updated_at
    )
    SELECT
      wms_order.id, wms_order.channel_id,
      ${input.externalFulfillmentId},
      'shipstation_reship_adopted',
      'queued', ${input.trackingNumber}, ${input.carrierCode}, ${input.serviceCode},
      ${input.providerOrderId}, ${input.providerOrderKey},
      'shipstation', ${String(input.providerOrderId)}, ${input.providerOrderKey},
      true, 'shipstation_reship_adoption_pending',
      'replacement', ${input.originalShipmentId}, ${input.reason},
      ${input.authorizedAt}, ${input.operator},
      NOW(), NOW()
    FROM wms.orders wms_order
    WHERE wms_order.id = ${input.wmsOrderId}
    RETURNING id, order_id, status, source, shipment_purpose
  `);
}

export async function reclassifyCandidateAsReplacementOutboundShipmentInWms(
  executor: SqlExecutor,
  input: {
    candidateShipmentId: number;
    originalShipmentId: number;
    reason: string;
    authorizedAt: Date;
    operator: string;
    resetQueuedTracking?: { trackingNumber: string | null };
  },
): Promise<void> {
  if (input.resetQueuedTracking) {
    await executor.execute(sql`
      UPDATE wms.outbound_shipments
      SET status = 'queued',
          tracking_number = ${input.resetQueuedTracking.trackingNumber},
          voided_at = NULL,
          source = 'shipstation_reship_adopted',
          shipment_purpose = 'replacement',
          replaces_shipment_id = ${input.originalShipmentId},
          replacement_reason = ${input.reason},
          replacement_authorized_at = ${input.authorizedAt},
          replacement_authorized_by = ${input.operator},
          requires_review = true,
          review_reason = 'shipstation_reship_adoption_pending',
          updated_at = NOW()
      WHERE id = ${input.candidateShipmentId}
        AND status IN ('planned', 'queued', 'voided')
        AND shipped_at IS NULL
    `);
    return;
  }
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET source = 'shipstation_reship_adopted',
        shipment_purpose = 'replacement',
        replaces_shipment_id = ${input.originalShipmentId},
        replacement_reason = ${input.reason},
        replacement_authorized_at = ${input.authorizedAt},
        replacement_authorized_by = ${input.operator},
        requires_review = true,
        review_reason = 'shipstation_reship_adoption_pending',
        updated_at = NOW()
    WHERE id = ${input.candidateShipmentId}
  `);
}

export async function finalizeAdoptedReshipOutboundShipmentReviewInWms(
  executor: SqlExecutor,
  candidateShipmentId: number,
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = CASE
          WHEN review_reason = 'historical_replacement_inventory_unproven' THEN true
          ELSE false
        END,
        review_reason = CASE
          WHEN review_reason = 'historical_replacement_inventory_unproven' THEN review_reason
          ELSE 'shipstation_reship_adopted'
        END,
        updated_at = NOW()
    WHERE id = ${candidateShipmentId}
  `);
}

export async function cancelProviderEchoCandidateOutboundShipmentInWms(
  executor: SqlExecutor,
  candidateShipmentId: number,
): Promise<any> {
  return executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET status = 'cancelled',
        cancelled_at = COALESCE(cancelled_at, NOW()),
        requires_review = false,
        review_reason = 'shipstation_provider_echo_reconciled',
        updated_at = NOW()
    WHERE id = ${candidateShipmentId}
      AND status = 'queued'
      AND requires_review = true
      AND review_reason = 'shipstation_reship_adoption_pending'
    RETURNING id
  `);
}

export async function voidAdditionalProviderLabelCandidateOutboundShipmentInWms(
  executor: SqlExecutor,
  input: { candidateShipmentId: number; voidDate: Date },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET status = 'voided',
        voided_at = COALESCE(voided_at, ${input.voidDate}),
        voided_reason = COALESCE(voided_reason, 'shipstation_provider_label_voided'),
        requires_review = false,
        review_reason = NULL,
        updated_at = NOW()
    WHERE id = ${input.candidateShipmentId}
      AND status IN ('planned', 'queued', 'labeled', 'shipped')
  `);
}

// ─── ShipStation Service (oms/shipstation.service.ts) ───────────────────────

export async function repairLegacyTrackingOutboundShipmentRefsInWms(
  executor: SqlExecutor,
  input: {
    shipmentId: number;
    externalFulfillmentId: string | null;
    validIncomingSsOrderId: number | null;
  },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET external_fulfillment_id = COALESCE(
          external_fulfillment_id,
          ${input.externalFulfillmentId}
        ),
        shipstation_order_id = COALESCE(
          ${input.validIncomingSsOrderId},
          shipstation_order_id
        ),
        engine_order_ref = COALESCE(
          ${input.validIncomingSsOrderId != null ? String(input.validIncomingSsOrderId) : null},
          engine_order_ref
        ),
        updated_at = NOW()
    WHERE id = ${input.shipmentId}
  `);
}

export async function adoptDriftedShipStationOrderMappingOnOutboundShipmentInWms(
  executor: SqlExecutor,
  input: {
    shipmentId: number;
    adoptedSsOrderId: number | null;
    orderKey: string | null;
    externalFulfillmentId: string | null;
    drifted: boolean;
  },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET shipstation_order_id = ${input.adoptedSsOrderId},
        engine_order_ref = ${input.adoptedSsOrderId != null ? String(input.adoptedSsOrderId) : null},
        shipstation_order_key = COALESCE(${input.orderKey}, shipstation_order_key),
        external_fulfillment_id = COALESCE(external_fulfillment_id, ${input.externalFulfillmentId}),
        requires_review = CASE WHEN ${input.drifted} THEN true ELSE requires_review END,
        review_reason = CASE WHEN ${input.drifted} THEN 'shipstation_duplicate_order_key_repaired' ELSE review_reason END,
        updated_at = NOW()
    WHERE id = ${input.shipmentId}
  `);
}

export async function insertShipStationChildOutboundShipmentInWms(
  executor: SqlExecutor,
  input: {
    orderId: number;
    channelId: number | null;
    externalFulfillmentId: string;
    source: string;
    shipstationOrderId: number;
    shipstationOrderKey: string | null;
  },
): Promise<any> {
  return executor.execute(sql`
    INSERT INTO wms.outbound_shipments
      (order_id, channel_id, external_fulfillment_id, source, status,
       shipstation_order_id, shipstation_order_key,
       shipping_engine, engine_order_ref, engine_shipment_ref,
       created_at, updated_at)
    VALUES
      (${input.orderId}, ${input.channelId}, ${input.externalFulfillmentId},
       ${input.source}, 'queued',
       ${input.shipstationOrderId}, ${input.shipstationOrderKey},
       'shipstation', ${String(input.shipstationOrderId)}, ${input.shipstationOrderKey},
       NOW(), NOW())
    RETURNING id, order_id, status, shipstation_order_id
  `);
}

export async function clearOutboundShipmentReviewFlagByReasonInWms(
  executor: SqlExecutor,
  input: {
    shipmentId: number;
    expectedReason?: "inventory_deduction_missing_item_data" | "address_changed_after_push";
    updatedAt?: Date;
  },
): Promise<void> {
  if (input.expectedReason === "address_changed_after_push") {
    await executor.execute(sql`
      UPDATE wms.outbound_shipments
      SET requires_review = false, review_reason = NULL, updated_at = ${input.updatedAt ?? new Date()}
      WHERE id = ${input.shipmentId}
        AND review_reason = 'address_changed_after_push'
    `);
    return;
  }
  if (input.expectedReason === "inventory_deduction_missing_item_data") {
    await executor.execute(sql`
      UPDATE wms.outbound_shipments
      SET requires_review = false,
          review_reason = NULL,
          updated_at = NOW()
      WHERE id = ${input.shipmentId}
        AND requires_review = true
        AND review_reason = 'inventory_deduction_missing_item_data'
    `);
    return;
  }
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET requires_review = false, review_reason = NULL, updated_at = ${input.updatedAt ?? new Date()}
    WHERE id = ${input.shipmentId} AND requires_review = true
  `);
}

export async function markOutboundShipmentQueuedAfterShipStationPushInWms(
  executor: SqlExecutor,
  input: {
    shipmentId: number;
    shipstationOrderId: number;
    orderKey: string;
    now: Date;
  },
): Promise<void> {
  await executor.execute(sql`
    UPDATE wms.outbound_shipments
    SET shipstation_order_id = ${input.shipstationOrderId},
        shipstation_order_key = ${input.orderKey},
        shipping_engine = 'shipstation',
        engine_order_ref = ${String(input.shipstationOrderId)},
        engine_shipment_ref = ${input.orderKey},
        status = 'queued',
        voided_at = NULL,
        voided_reason = NULL,
        updated_at = ${input.now}
    WHERE id = ${input.shipmentId}
      AND status IN ('planned', 'queued', 'voided')
      AND shipped_at IS NULL
  `);
}
