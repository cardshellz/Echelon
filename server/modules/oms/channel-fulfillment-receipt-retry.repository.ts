import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import {
  ChannelFulfillmentReceiptRetryError,
  previewChannelFulfillmentReceiptRetry,
  receiptRetryExecutionSchema,
  receiptRetryIdempotencyKey,
  receiptRetryScopeSchema,
  receiptRetrySnapshotSchema,
  type ChannelFulfillmentReceiptRetryExecution,
  type ChannelFulfillmentReceiptRetryPreview,
  type ChannelFulfillmentReceiptRetryResult,
  type ChannelFulfillmentReceiptRetryScope,
} from "./channel-fulfillment-receipt-retry.domain";

type Database = typeof db;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type QueryExecutor = Pick<Database, "execute"> | Pick<Transaction, "execute">;

export interface ChannelFulfillmentReceiptRetryRepository {
  preview(input: ChannelFulfillmentReceiptRetryScope): Promise<ChannelFulfillmentReceiptRetryPreview>;
  requeue(input: ChannelFulfillmentReceiptRetryExecution): Promise<ChannelFulfillmentReceiptRetryResult>;
}

const queryResultSchema = z.object({ rows: z.array(z.record(z.unknown())) });
const AUDIT_ACTION = "oms.channel_fulfillment_receipt.review_requeued";

function resultRows(result: unknown): Record<string, unknown>[] {
  return queryResultSchema.parse(result).rows;
}

function targetFor(receiptId: number): string {
  return `oms.channel_fulfillment_receipt:${receiptId}`;
}

async function loadSnapshot(
  executor: QueryExecutor,
  scope: ChannelFulfillmentReceiptRetryScope,
  lock: boolean,
): Promise<ChannelFulfillmentReceiptRetryPreview> {
  const result = resultRows(await executor.execute(sql`
    SELECT jsonb_build_object(
      'receiptId', receipt.id,
      'receiptKey', receipt.receipt_key,
      'requestHash', receipt.request_hash,
      'sourceProvider', receipt.source_provider,
      'sourceOrderId', receipt.source_order_id,
      'sourceFulfillmentId', receipt.source_fulfillment_id,
      'sourceEventId', receipt.source_event_id,
      'eventKind', receipt.event_kind,
      'processingStatus', receipt.processing_status,
      'attemptCount', receipt.attempt_count,
      'retryFailureCount', receipt.retry_failure_count,
      'leaseToken', receipt.lease_token,
      'leaseExpiresAt', receipt.lease_expires_at,
      'errorCode', receipt.error_code,
      'errorMessage', receipt.error_message,
      'processedAt', receipt.processed_at,
      'omsOrderId', receipt.oms_order_id,
      'orderNumber', oms_order.external_order_number,
      'externalOrderId', oms_order.external_order_id,
      'physicalShipmentId', receipt.physical_shipment_id,
      'trackingNumber', package.tracking_number,
      'physicalShipmentStatus', package.status,
      'items', COALESCE(item_scope.items, '[]'::jsonb)
    ) AS snapshot
    FROM oms.channel_fulfillment_receipts AS receipt
    LEFT JOIN oms.oms_orders AS oms_order ON oms_order.id = receipt.oms_order_id
    LEFT JOIN wms.physical_shipments AS package ON package.id = receipt.physical_shipment_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'receiptItemId', receipt_item.id,
        'sourceFulfillmentLineId', receipt_item.source_fulfillment_line_id,
        'channelOrderLineId', receipt_item.channel_order_line_id,
        'quantity', receipt_item.quantity,
        'omsOrderLineId', receipt_item.oms_order_line_id,
        'omsOrderId', oms_line.order_id,
        'omsChannelOrderLineId', oms_line.external_line_item_id,
        'omsProductVariantId', oms_line.product_variant_id,
        'omsSku', oms_line.sku,
        'omsRequiresShipping', oms_line.requires_shipping,
        'omsInventoryTracking', oms_line.inventory_tracking, 'wmsInventoryTracking', wms_item.inventory_tracking,
        'omsCatalogProductId', oms_line.catalog_product_id, 'wmsCatalogProductId', wms_item.catalog_product_id,
        'omsPaidQuantity', oms_line.paid_quantity,
        'omsMaxPaidQuantity', COALESCE(authority.max_paid_quantity, 0),
        'wmsOrderItemId', receipt_item.wms_order_item_id,
        'wmsOrderId', wms_item.order_id,
        'wmsOmsOrderLineId', wms_item.oms_order_line_id,
        'wmsProductId', wms_item.product_id,
        'wmsSku', wms_item.sku,
        'wmsQuantity', wms_item.quantity,
        'wmsPickedQuantity', wms_item.picked_quantity,
        'wmsFulfilledQuantity', wms_item.fulfilled_quantity,
        'wmsItemStatus', wms_item.status,
        'wmsRequiresShipping', wms_item.requires_shipping,
        'wmsItemOnHold', wms_item.on_hold,
        'wmsOrderStatus', wms_order.warehouse_status,
        'wmsOrderOnHold', wms_order.on_hold,
        'catalogVariantId', variant.id,
        'catalogProductId', variant.product_id,
        'catalogSku', variant.sku,
        'catalogIsActive', variant.is_active,
        'catalogRequiresShipping', variant.requires_shipping,
        'catalogTrackInventory', COALESCE(variant.track_inventory, true)
      ) || jsonb_build_object(
        'sourceShipmentItemId', receipt_item.legacy_wms_shipment_item_id,
        'sourceShipmentId', source_item.shipment_id,
        'sourceOrderItemId', source_item.order_item_id,
        'sourceHeaderOrderId', source_shipment.order_id,
        'sourceReplacementForOrderItemId', source_item.replacement_for_order_item_id,
        'sourceCorrectionForShipmentItemId', source_item.correction_for_shipment_item_id,
        'sourceProductVariantId', source_item.product_variant_id,
        'sourceQuantity', source_item.qty,
        'sourcePurpose', source_item.shipment_item_purpose,
        'sourceFromLocationId', source_item.from_location_id,
        'sourceShipmentStatus', source_shipment.status,
        'sourceShipmentHeld', source_shipment.held,
        'physicalShipmentItemId', receipt_item.physical_shipment_item_id,
        'physicalShipmentId', physical_item.physical_shipment_id,
        'physicalOrderItemId', physical_item.wms_order_item_id,
        'physicalLegacySourceShipmentItemId', physical_item.legacy_wms_shipment_item_id,
        'physicalReplacementForOrderItemId', physical_item.replacement_for_order_item_id,
        'physicalCorrectionForShipmentItemId', physical_item.correction_for_physical_shipment_item_id,
        'physicalPackageAllocationEntryId', physical_item.package_allocation_entry_id,
        'physicalProductVariantId', physical_item.product_variant_id,
        'physicalSku', physical_item.sku,
        'physicalQuantity', physical_item.quantity_shipped,
        'physicalAdjustmentQuantity', COALESCE(adjustment.quantity_delta, 0),
        'physicalPurpose', physical_item.shipment_item_purpose,
        'physicalShipmentStatus', physical_package.status,
        'inventoryTransactionCount', (
          SELECT COUNT(*)::int
          FROM inventory.inventory_transactions AS inventory_transaction
          WHERE inventory_transaction.order_item_id = receipt_item.wms_order_item_id
             OR inventory_transaction.shipment_item_id = receipt_item.legacy_wms_shipment_item_id
        )
      ) ORDER BY receipt_item.id) AS items
      FROM oms.channel_fulfillment_receipt_items AS receipt_item
      LEFT JOIN oms.oms_order_lines AS oms_line ON oms_line.id = receipt_item.oms_order_line_id
      LEFT JOIN LATERAL (
        SELECT MAX(event.paid_quantity)::int AS max_paid_quantity
        FROM oms.oms_order_line_authority_events AS event
        WHERE event.order_line_id = oms_line.id
      ) AS authority ON TRUE
      LEFT JOIN wms.order_items AS wms_item ON wms_item.id = receipt_item.wms_order_item_id
      LEFT JOIN wms.orders AS wms_order ON wms_order.id = wms_item.order_id
      LEFT JOIN catalog.product_variants AS variant ON variant.id = oms_line.product_variant_id
      LEFT JOIN wms.outbound_shipment_items AS source_item
        ON source_item.id = receipt_item.legacy_wms_shipment_item_id
      LEFT JOIN wms.outbound_shipments AS source_shipment ON source_shipment.id = source_item.shipment_id
      LEFT JOIN wms.physical_shipment_items AS physical_item
        ON physical_item.id = receipt_item.physical_shipment_item_id
      LEFT JOIN wms.physical_shipments AS physical_package
        ON physical_package.id = physical_item.physical_shipment_id
      LEFT JOIN wms.physical_shipment_item_quantity_adjustments AS adjustment
        ON adjustment.physical_shipment_item_id = physical_item.id
      WHERE receipt_item.receipt_id = receipt.id
    ) AS item_scope ON TRUE
    WHERE receipt.id = ${scope.receiptId}
    ${lock ? sql`FOR UPDATE OF receipt` : sql``}
  `));
  if (result.length === 0) {
    throw new ChannelFulfillmentReceiptRetryError(
      "RECEIPT_RETRY_NOT_FOUND",
      "The channel fulfillment receipt was not found",
      404,
      { receiptId: scope.receiptId },
    );
  }
  if (result.length !== 1) throw new Error("Receipt retry snapshot returned multiple receipts");
  return previewChannelFulfillmentReceiptRetry(receiptRetrySnapshotSchema.parse(result[0].snapshot));
}

function classifyError(error: unknown): ChannelFulfillmentReceiptRetryError {
  if (error instanceof ChannelFulfillmentReceiptRetryError) return error;
  const postgresCode = typeof (error as { code?: unknown } | null)?.code === "string"
    ? String((error as { code: string }).code)
    : null;
  const retryable = postgresCode === "40001" || postgresCode === "40P01" || postgresCode === "55P03";
  return new ChannelFulfillmentReceiptRetryError(
    "RECEIPT_RETRY_DATABASE_ERROR",
    "Channel fulfillment receipt retry database operation failed",
    retryable ? 503 : 500,
    { postgresCode, retryable },
  );
}

async function loadPriorAudit(
  transaction: QueryExecutor,
  receiptId: number,
  idempotencyKey: string,
): Promise<Record<string, unknown>[]> {
  return resultRows(await transaction.execute(sql`
    SELECT actor, changes, context
    FROM public.audit_events
    WHERE action = ${AUDIT_ACTION}
      AND target = ${targetFor(receiptId)}
      AND context->>'idempotencyKey' = ${idempotencyKey}
    ORDER BY id DESC
    LIMIT 2
  `));
}

export function createChannelFulfillmentReceiptRetryRepository(
  database: Database = db,
): ChannelFulfillmentReceiptRetryRepository {
  return {
    async preview(rawInput) {
      const parsed = receiptRetryScopeSchema.safeParse(rawInput);
      if (!parsed.success) {
        throw new ChannelFulfillmentReceiptRetryError(
          "INVALID_RECEIPT_RETRY_INPUT",
          "A single positive receiptId is required",
          400,
          { issues: parsed.error.issues },
        );
      }
      try {
        return await database.transaction(
          (transaction) => loadSnapshot(transaction, parsed.data, false),
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
      } catch (error) {
        throw classifyError(error);
      }
    },

    async requeue(rawInput) {
      const parsed = receiptRetryExecutionSchema.safeParse(rawInput);
      if (!parsed.success) {
        throw new ChannelFulfillmentReceiptRetryError(
          "INVALID_RECEIPT_RETRY_INPUT",
          "Invalid channel fulfillment receipt retry execution input",
          400,
          { issues: parsed.error.issues },
        );
      }
      const input = parsed.data;
      const idempotencyKey = receiptRetryIdempotencyKey(input);
      try {
        return await database.transaction(async (transaction) => {
          const current = await loadSnapshot(transaction, input, true);
          const priorAudits = await loadPriorAudit(transaction, input.receiptId, idempotencyKey);
          if (priorAudits.length > 0) {
            if (priorAudits.length !== 1
              || priorAudits[0].actor !== input.actor
              || (priorAudits[0].context as Record<string, unknown> | null)?.reason !== input.reason
              || (priorAudits[0].context as Record<string, unknown> | null)?.expectedStateFingerprint
                !== input.expectedStateFingerprint) {
              throw new ChannelFulfillmentReceiptRetryError(
                "RECEIPT_RETRY_IDEMPOTENCY_CONFLICT",
                "The recorded receipt retry does not match this request",
                409,
              );
            }
            return Object.freeze({
              ...current,
              mode: "execute" as const,
              replayed: true,
              requeued: false,
            });
          }
          if (current.stateFingerprint !== input.expectedStateFingerprint) {
            throw new ChannelFulfillmentReceiptRetryError(
              "RECEIPT_RETRY_STATE_CHANGED",
              "The receipt or its fulfillment evidence changed; preview it again before retrying",
              409,
              { receiptId: input.receiptId },
            );
          }
          if (!current.eligibleForRetry) {
            throw new ChannelFulfillmentReceiptRetryError(
              "RECEIPT_RETRY_NOT_ELIGIBLE",
              "The receipt is not eligible for a no-inventory retry",
              409,
              { receiptId: input.receiptId, blockers: current.blockers },
            );
          }

          await persistAuditEvent(transaction, {
            actor: input.actor,
            action: AUDIT_ACTION,
            target: targetFor(input.receiptId),
            changes: {
              before: {
                processingStatus: current.snapshot.processingStatus,
                errorCode: current.snapshot.errorCode,
                errorMessage: current.snapshot.errorMessage,
                nextRetryAt: null,
              },
              after: {
                processingStatus: "pending",
                errorCode: null,
                errorMessage: null,
                nextRetryAt: input.requeuedAt.toISOString(),
              },
            },
            context: {
              idempotencyKey,
              expectedStateFingerprint: input.expectedStateFingerprint,
              reason: input.reason,
              requestHash: current.snapshot.requestHash,
              sourceProvider: current.snapshot.sourceProvider,
              sourceOrderId: current.snapshot.sourceOrderId,
              sourceFulfillmentId: current.snapshot.sourceFulfillmentId,
              omsOrderId: current.snapshot.omsOrderId,
              physicalShipmentId: current.snapshot.physicalShipmentId,
              receiptItemIds: current.snapshot.items.map((item) => item.receiptItemId),
              inventoryTransactionCount: 0,
              inventoryImpact: "none",
            },
          }, { timestamp: input.requeuedAt, emitStructuredLog: false });

          const updated = resultRows(await transaction.execute(sql`
            UPDATE oms.channel_fulfillment_receipts
            SET processing_status = 'pending',
                next_retry_at = ${input.requeuedAt},
                lease_token = NULL,
                lease_expires_at = NULL,
                error_code = NULL,
                error_message = NULL,
                processed_at = NULL,
                updated_at = ${input.requeuedAt}
            WHERE id = ${input.receiptId}
              AND processing_status = 'review'
              AND request_hash = ${current.snapshot.requestHash}
              AND attempt_count = ${current.snapshot.attemptCount}
              AND retry_failure_count = ${current.snapshot.retryFailureCount}
              AND lease_token IS NULL
              AND lease_expires_at IS NULL
              AND error_code = 'INVENTORY_RECORD_FAILED'
            RETURNING id
          `));
          if (updated.length !== 1) throw new Error("Receipt retry state changed while locked");
          return Object.freeze({
            ...current,
            mode: "execute" as const,
            replayed: false,
            requeued: true,
          });
        }, { isolationLevel: "serializable", accessMode: "read write" });
      } catch (error) {
        throw classifyError(error);
      }
    },
  };
}
