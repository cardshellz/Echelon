import { sql } from "drizzle-orm";
import {
  isPositivePostgresInteger,
  parseExactPositiveWmsShipmentItems,
} from "../shipping/shipstation-provider-contents.domain";

export interface ExpectedShipStationOrderIdentity {
  shipmentId: number;
  wmsOrderId: number;
  orderNumber: string;
  items: ReadonlyArray<{
    lineItemKey: string;
    quantity: number;
  }>;
}

export interface ShipStationOrderIdentityEvidence {
  orderId?: number | null;
  orderKey?: string | null;
  orderNumber?: string | null;
  orderStatus?: string | null;
  advancedOptions?: {
    customField2?: string | null;
  } | null;
  items?: ReadonlyArray<{
    lineItemKey?: string | null;
    quantity?: number | null;
  }> | null;
}

export type ShipStationAdoptionProof =
  | { matched: true; providerOrderId: number; orderKey: string }
  | {
      matched: false;
      reason:
        | "invalid_provider_order_id"
        | "order_key_mismatch"
        | "order_number_mismatch"
        | "wms_metadata_mismatch"
        | "item_signature_mismatch"
        | "provider_order_cancelled";
    };

export type ShipStationAdoptionResult =
  | { state: "linked"; wmsOrderId: number }
  | {
      state: "conflict" | "not_found" | "not_adoptable_status";
      existingProviderOrderId: number | null;
    };

function normalizeItemSignature(
  items: ReadonlyArray<{ lineItemKey?: string | null; quantity?: number | null }>,
): string[] | null {
  const exactItems = parseExactPositiveWmsShipmentItems(items);
  return exactItems?.map((item) =>
    `wms-item-${item.sourceShipmentItemId}:${item.quantity}`
  ) ?? null;
}

/**
 * Proves that provider evidence belongs to one exact WMS shipment.
 *
 * The order key alone is not enough: a stale or manually copied provider row
 * could reuse it. The WMS metadata and complete item signature must also agree
 * before Echelon may adopt the provider order without operator review.
 */
export function proveShipStationOrderAdoption(
  expected: ExpectedShipStationOrderIdentity,
  evidence: ShipStationOrderIdentityEvidence,
): ShipStationAdoptionProof {
  const providerOrderId = Number(evidence.orderId);
  if (!isPositivePostgresInteger(providerOrderId)) {
    return { matched: false, reason: "invalid_provider_order_id" };
  }

  const expectedOrderKey = `echelon-wms-shp-${expected.shipmentId}`;
  if (String(evidence.orderKey ?? "") !== expectedOrderKey) {
    return { matched: false, reason: "order_key_mismatch" };
  }
  if (String(evidence.orderNumber ?? "") !== expected.orderNumber) {
    return { matched: false, reason: "order_number_mismatch" };
  }
  if (String(evidence.orderStatus ?? "").toLowerCase() === "cancelled") {
    return { matched: false, reason: "provider_order_cancelled" };
  }

  const expectedMetadata =
    `wms_order_id:${expected.wmsOrderId}|shipment_id:${expected.shipmentId}`;
  if (String(evidence.advancedOptions?.customField2 ?? "") !== expectedMetadata) {
    return { matched: false, reason: "wms_metadata_mismatch" };
  }

  const expectedItems = normalizeItemSignature(expected.items);
  const providerItems = normalizeItemSignature(evidence.items ?? []);
  if (
    expectedItems === null ||
    providerItems === null ||
    expectedItems.length === 0 ||
    expectedItems.length !== providerItems.length ||
    expectedItems.some((value, index) => value !== providerItems[index])
  ) {
    return { matched: false, reason: "item_signature_mismatch" };
  }

  return {
    matched: true,
    providerOrderId,
    orderKey: expectedOrderKey,
  };
}

/**
 * Persists a proven provider identity without overwriting a conflicting link.
 * Handoff commands are closed only after the WMS row carries the same
 * provider order identity.
 */
export async function adoptProvenShipStationOrder(
  dbArg: any,
  input: {
    shipmentId: number;
    providerOrderId: number;
    orderKey: string;
  },
): Promise<ShipStationAdoptionResult> {
  if (!isPositivePostgresInteger(input.shipmentId)) {
    throw new Error("shipmentId must fit the WMS PostgreSQL integer column");
  }
  if (!isPositivePostgresInteger(input.providerOrderId)) {
    throw new Error("providerOrderId must fit the WMS PostgreSQL integer column");
  }
  const updated = await dbArg.execute(sql`
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

  const linkedRow = updated?.rows?.[0];
  if (linkedRow) {
    await resolveShipStationHandoffCommands(
      dbArg,
      input.shipmentId,
      "provider identity adopted",
    );
    return { state: "linked", wmsOrderId: Number(linkedRow.order_id) };
  }

  const current = await dbArg.execute(sql`
    SELECT shipstation_order_id, status
    FROM wms.outbound_shipments
    WHERE id = ${input.shipmentId}
    LIMIT 1
  `);
  const row = current?.rows?.[0];
  if (!row) {
    return { state: "not_found", existingProviderOrderId: null };
  }

  const existingProviderOrderId = Number(row.shipstation_order_id);
  if (
    Number.isSafeInteger(existingProviderOrderId) &&
    existingProviderOrderId > 0 &&
    existingProviderOrderId !== input.providerOrderId
  ) {
    return { state: "conflict", existingProviderOrderId };
  }

  return {
    state: "not_adoptable_status",
    existingProviderOrderId:
      Number.isSafeInteger(existingProviderOrderId) && existingProviderOrderId > 0
        ? existingProviderOrderId
        : null,
  };
}

/**
 * Closes handoff commands only after the WMS row carries the proven provider
 * identity. Dead rows are included because exact provider proof establishes
 * that the externally completed handoff was merely not persisted locally.
 */
export async function resolveShipStationHandoffCommands(
  dbArg: any,
  shipmentId: number,
  message: string,
): Promise<number> {
  const resolved = await dbArg.execute(sql`
    UPDATE oms.webhook_retry_queue
    SET status = 'success',
        last_error = ${message},
        updated_at = NOW()
    WHERE provider = 'internal'
      AND topic = 'shipstation_shipment_push'
      AND payload->>'shipmentId' = ${String(shipmentId)}
      AND status IN ('pending', 'dead')
    RETURNING id
  `);
  return Array.isArray(resolved?.rows) ? resolved.rows.length : 0;
}
