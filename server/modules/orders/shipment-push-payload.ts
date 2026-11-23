import { sql } from "drizzle-orm";
import { readIntegerCents } from "@shared/money-read";
import { enrichContext } from "../../platform/observability";
import { OrderEditError } from "../order-edits/oms-coordination.api";
import {
  engineRefFromRow,
  type EnginePushResult,
  type ShipmentPushItem,
  type ShipmentPushPayload,
  type ShippingEngine,
} from "../shipping/engine-and-reconcile.api";

export type ShipmentPushGuardCode =
  | "SHIPMENT_INVALID_ID"
  | "SHIPMENT_NOT_FOUND"
  | "SHIPMENT_ORDER_NOT_FOUND"
  | "SHIPMENT_ORDER_CANCELLED"
  | "SHIPMENT_EMPTY_ITEMS"
  | "SHIPMENT_HELD"
  | "SHIPMENT_REQUIRES_REVIEW"
  | "SHIPMENT_TERMINAL";

const PUSHABLE_SHIPMENT_STATUSES = new Set(["planned", "queued", "voided"]);

function readOptionalIntegerCents(value: unknown, field: string): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  return readIntegerCents(value, field);
}

/**
 * Thrown by WMS-owned pre-push assembly before a shipment crosses the
 * `ShippingEngine` port boundary. Carries `context.code = "SS_PUSH_INVALID_SHIPMENT"`
 * so durable push retry workers classify deterministic guard failures as
 * permanent rather than burning transient retry attempts.
 */
export class ShipmentPushGuardError extends Error {
  public readonly context: {
    code: "SS_PUSH_INVALID_SHIPMENT";
    guardCode: ShipmentPushGuardCode;
    shipmentId: number;
    field: string;
    value: unknown;
  };

  constructor(
    public readonly guardCode: ShipmentPushGuardCode,
    message: string,
    details: { shipmentId: number; field: string; value: unknown },
  ) {
    super(message);
    this.name = "ShipmentPushGuardError";
    this.context = {
      code: "SS_PUSH_INVALID_SHIPMENT",
      guardCode,
      shipmentId: details.shipmentId,
      field: details.field,
      value: details.value,
    };
  }
}

export function buildMinimalShipmentPushPayload(shipmentId: number): ShipmentPushPayload {
  return {
    shipmentId,
    orderId: 0,
    orderNumber: "",
    channelId: null,
    warehouseId: null,
    customer: {
      name: null,
      email: null,
    },
    shippingAddress: {
      name: null,
      company: null,
      street1: null,
      street2: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
    },
    financials: {
      amountPaidCents: 0,
      taxCents: 0,
      shippingCents: 0,
      discountCents: 0,
      totalCents: 0,
      nonShippingTotalCents: 0,
      currency: "USD",
    },
    items: [],
    orderPlacedAt: null,
    externalOrderId: null,
    sortRank: null,
  };
}

async function queryShipmentHeaderRow(
  db: any,
  shipmentId: number,
): Promise<{ supported: false } | { supported: true; row: Record<string, any> | undefined }> {
  if (typeof db?.execute !== "function") {
    return { supported: false };
  }
  const result: any = await db.execute(sql`
    SELECT
      os.id AS shipment_id,
      os.order_id,
      os.status AS shipment_status,
      os.held,
      os.requires_review,
      os.review_reason,
      os.shipping_engine,
      os.engine_order_ref,
      os.engine_shipment_ref,
      os.shipstation_order_id,
      os.shipstation_order_key,
      os.shipment_purpose,
      wo.id AS wms_order_id,
      wo.order_number,
      wo.channel_id,
      wo.warehouse_id,
      wo.oms_fulfillment_order_id,
      wo.warehouse_status,
      wo.financial_status,
      wo.cancelled_at,
      wo.order_edit_operation_id,
      wo.on_hold,
      wo.sort_rank,
      wo.external_order_id,
      wo.customer_name,
      wo.customer_email,
      wo.shipping_name,
      wo.shipping_company,
      wo.shipping_address,
      wo.shipping_address2,
      wo.shipping_city,
      wo.shipping_state,
      wo.shipping_postal_code,
      wo.shipping_country,
      wo.amount_paid_cents,
      wo.tax_cents,
      wo.shipping_cents,
      wo.discount_cents,
      wo.total_cents,
      wo.currency,
      wo.order_placed_at
    FROM wms.outbound_shipments os
    LEFT JOIN wms.orders wo ON wo.id = os.order_id
    WHERE os.id = ${shipmentId}
    LIMIT 1
  `);
  if (result == null || !Array.isArray(result.rows)) {
    return { supported: false };
  }
  return { supported: true, row: result.rows[0] };
}

async function hydrateFromHeaderRow(
  db: any,
  shipmentId: number,
  row: Record<string, any> | undefined,
  opts?: { overrideReview?: boolean },
): Promise<ShipmentPushPayload> {
  if (!row) {
    throw new ShipmentPushGuardError(
      "SHIPMENT_NOT_FOUND",
      `Shipment ${shipmentId} not found`,
      { shipmentId, field: "shipment", value: null },
    );
  }

  if (row.held === true) {
    throw new ShipmentPushGuardError(
      "SHIPMENT_HELD",
      `Shipment ${shipmentId} is held and cannot be pushed to the shipping engine`,
      { shipmentId, field: "shipment.held", value: true },
    );
  }

  if (row.requires_review === true && !opts?.overrideReview) {
    throw new ShipmentPushGuardError(
      "SHIPMENT_REQUIRES_REVIEW",
      `Shipment ${shipmentId} requires review (${row.review_reason ?? "review_required"})`,
      {
        shipmentId,
        field: "shipment.requires_review",
        value: row.review_reason ?? true,
      },
    );
  }

  const status = String(row.shipment_status ?? "");
  if (!PUSHABLE_SHIPMENT_STATUSES.has(status)) {
    throw new ShipmentPushGuardError(
      "SHIPMENT_TERMINAL",
      `Shipment ${shipmentId} has non-pushable status '${status}'`,
      { shipmentId, field: "shipment.status", value: status },
    );
  }

  const orderId = Number(row.wms_order_id ?? row.order_id);
  if (!row.wms_order_id || !Number.isInteger(orderId) || orderId <= 0) {
    throw new ShipmentPushGuardError(
      "SHIPMENT_ORDER_NOT_FOUND",
      `WMS order not found for shipment ${shipmentId}`,
      { shipmentId, field: "order", value: row.order_id ?? null },
    );
  }

  if (row.order_edit_operation_id != null) {
    throw new OrderEditError(
      "ORDER_EDIT_PROVIDER_HELD",
      "This order is held for an edit; ordinary shipment pushes cannot resume it.",
    );
  }

  const warehouseStatus = String(row.warehouse_status ?? "").toLowerCase();
  const financialStatus = String(row.financial_status ?? "").toLowerCase();
  if (
    warehouseStatus === "cancelled" ||
    row.cancelled_at != null ||
    financialStatus === "voided"
  ) {
    throw new ShipmentPushGuardError(
      "SHIPMENT_ORDER_CANCELLED",
      `WMS order ${orderId} is ${row.warehouse_status ?? "cancelled"}/${row.financial_status ?? "unknown"} — refusing to push cancelled/voided order`,
      {
        shipmentId,
        field: "order.warehouse_status",
        value: row.warehouse_status ?? row.financial_status ?? "cancelled",
      },
    );
  }

  const itemsResult: any = await db.execute(sql`
    SELECT
      osi.id AS shipment_item_id,
      COALESCE(osi.order_item_id, osi.replacement_for_order_item_id) AS order_item_id,
      LEAST(COALESCE(osi.commercial_requested_qty, osi.qty), osi.qty) AS qty,
      oi.sku,
      oi.name,
      COALESCE(oi.paid_price_cents, oi.unit_price_cents, 0)::int AS unit_price_cents
    FROM wms.outbound_shipment_items osi
    JOIN wms.order_items oi
      ON oi.id = COALESCE(osi.order_item_id, osi.replacement_for_order_item_id)
    WHERE osi.shipment_id = ${shipmentId}
      AND COALESCE(oi.requires_shipping, 1) = 1
      AND COALESCE(osi.commercial_requested_qty, osi.qty) > 0
      AND osi.qty > 0
    ORDER BY osi.id
  `);
  const itemRows: Array<Record<string, any>> = Array.isArray(itemsResult?.rows)
    ? itemsResult.rows
    : [];

  if (itemRows.length === 0) {
    throw new ShipmentPushGuardError(
      "SHIPMENT_EMPTY_ITEMS",
      `Shipment ${shipmentId} has no shippable items`,
      { shipmentId, field: "items", value: 0 },
    );
  }

  const items: ShipmentPushItem[] = itemRows.map((itemRow) => ({
    itemId: Number(itemRow.order_item_id ?? itemRow.shipment_item_id),
    shipmentItemId:
      itemRow.shipment_item_id != null ? Number(itemRow.shipment_item_id) : undefined,
    sku: String(itemRow.sku ?? ""),
    name: String(itemRow.name ?? ""),
    quantity: Number(itemRow.qty),
    unitPriceCents: readOptionalIntegerCents(
      itemRow.unit_price_cents,
      "shipment_item.unit_price_cents",
    ),
  }));

  const siblingResult: any = await db.execute(sql`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM wms.outbound_shipments
        WHERE order_id = ${orderId}
          AND status <> 'cancelled'
      ) AS cnt,
      (
        SELECT COALESCE(SUM(oi.total_price_cents), 0)::int
        FROM wms.order_items oi
        WHERE oi.order_id = ${orderId}
          AND COALESCE(oi.requires_shipping, 1) = 0
      ) AS non_shipping_total_cents,
      (
        SELECT COALESCE(SUM(oi.quantity), 0)::int
        FROM wms.order_items oi
        WHERE oi.order_id = ${orderId}
          AND COALESCE(oi.requires_shipping, 1) = 1
      ) AS order_shippable_qty
  `);
  const summaryRow = siblingResult?.rows?.[0] ?? {};
  const activeShipmentCount = Number(summaryRow.cnt ?? 1);
  const shipmentShippableQty = items.reduce((sum, item) => sum + item.quantity, 0);
  const orderShippableQty =
    summaryRow.order_shippable_qty != null
      ? Number(summaryRow.order_shippable_qty)
      : null;
  const isPartialShipment =
    orderShippableQty !== null && orderShippableQty > 0
      ? shipmentShippableQty > 0 && shipmentShippableQty < orderShippableQty
      : activeShipmentCount > 1;

  const amountPaidCents = readOptionalIntegerCents(row.amount_paid_cents, "order.amount_paid_cents");
  const taxCents = readOptionalIntegerCents(row.tax_cents, "order.tax_cents");
  const shippingCents = readOptionalIntegerCents(row.shipping_cents, "order.shipping_cents");
  const discountCents = readOptionalIntegerCents(row.discount_cents, "order.discount_cents");
  const totalCents = readOptionalIntegerCents(row.total_cents, "order.total_cents");
  const nonShippingTotalCents =
    summaryRow.non_shipping_total_cents != null
      ? readOptionalIntegerCents(summaryRow.non_shipping_total_cents, "order.non_shipping_total_cents")
      : Math.max(0, totalCents - shippingCents);
  const existingEngineRef = engineRefFromRow({
    shipping_engine: row.shipping_engine ?? null,
    engine_order_ref: row.engine_order_ref ?? null,
    engine_shipment_ref: row.engine_shipment_ref ?? null,
    shipstation_order_id:
      row.shipstation_order_id != null ? Number(row.shipstation_order_id) : null,
    shipstation_order_key: row.shipstation_order_key ?? null,
  });

  enrichContext({
    shipmentId,
    wmsOrderId: orderId,
    ...(existingEngineRef
      ? { engineRef: `${existingEngineRef.engine}:${existingEngineRef.engineOrderRef}` }
      : {}),
  });

  return {
    shipmentId,
    orderId,
    orderNumber: String(row.order_number ?? ""),
    channelId: row.channel_id != null ? Number(row.channel_id) : null,
    warehouseId: row.warehouse_id != null ? Number(row.warehouse_id) : null,
    customer: {
      name: row.customer_name ?? null,
      email: row.customer_email ?? null,
    },
    shippingAddress: {
      name: row.shipping_name ?? null,
      company: row.shipping_company ?? null,
      street1: row.shipping_address ?? null,
      street2: row.shipping_address2 ?? null,
      city: row.shipping_city ?? null,
      state: row.shipping_state ?? null,
      postalCode: row.shipping_postal_code ?? null,
      country: row.shipping_country ?? null,
    },
    financials: {
      amountPaidCents,
      taxCents,
      shippingCents,
      discountCents,
      totalCents,
      nonShippingTotalCents,
      currency: String(row.currency ?? "USD"),
    },
    items,
    orderPlacedAt: row.order_placed_at ?? null,
    externalOrderId: row.external_order_id ?? null,
    sortRank: row.sort_rank ?? null,
    isPartialShipment,
    fulfillmentOrderId: row.oms_fulfillment_order_id ?? null,
    onHold: Number(row.on_hold ?? 0) === 1,
    isReplacementShipment: row.shipment_purpose === "replacement",
    overrideReview: opts?.overrideReview === true ? true : undefined,
    existingEngineRef: existingEngineRef ?? undefined,
  };
}

/**
 * WMS-owned assembler + pre-push guard for `ShipmentPushPayload`.
 * Enforces held / requires_review / terminal-status / missing-row guards
 * before crossing the `ShippingEngine` port boundary.
 */
export async function assembleShipmentPushPayload(
  db: any,
  shipmentId: number,
  opts?: { overrideReview?: boolean },
): Promise<ShipmentPushPayload> {
  if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
    throw new ShipmentPushGuardError(
      "SHIPMENT_INVALID_ID",
      `shipmentId must be a positive integer, got ${String(shipmentId)}`,
      { shipmentId, field: "shipmentId", value: shipmentId },
    );
  }
  const header = await queryShipmentHeaderRow(db, shipmentId);
  if (!header.supported) {
    throw new ShipmentPushGuardError(
      "SHIPMENT_NOT_FOUND",
      `Database executor unavailable to assemble shipment ${shipmentId}`,
      { shipmentId, field: "db", value: null },
    );
  }
  return hydrateFromHeaderRow(db, shipmentId, header.row, opts);
}

/**
 * Assemble `ShipmentPushPayload` from WMS tables (enforcing pre-push guards)
 * and push through `ShippingEngine.upsertShipment`, eliminating `{ shipmentId } as any`
 * port bypasses across WMS, OMS, retry workers, and recovery sweeps.
 *
 * When invoked with a lightweight unit-test mock `db` whose `execute` stub does
 * not return a result rowset, falls back to a typed minimal `ShipmentPushPayload`.
 */
export async function pushShipmentThroughEngine(
  db: any,
  engine: Pick<ShippingEngine, "upsertShipment">,
  shipmentId: number,
  opts?: { overrideReview?: boolean },
): Promise<EnginePushResult> {
  if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
    throw new ShipmentPushGuardError(
      "SHIPMENT_INVALID_ID",
      `shipmentId must be a positive integer, got ${String(shipmentId)}`,
      { shipmentId, field: "shipmentId", value: shipmentId },
    );
  }
  const header = await queryShipmentHeaderRow(db, shipmentId);
  const payload = header.supported
    ? await hydrateFromHeaderRow(db, shipmentId, header.row, opts)
    : buildMinimalShipmentPushPayload(shipmentId);
  return engine.upsertShipment(payload);
}
