import { sql } from "drizzle-orm";

import {
  buildProviderPhysicalShipmentIdentity,
} from "./channel-fulfillment-authority.repository";
import {
  ChannelFulfillmentIngressError,
  type NormalizedChannelFulfillmentIngress,
} from "./channel-fulfillment-ingress";

export interface IngressInventoryItem {
  readonly legacyWmsShipmentId: number;
  readonly legacyWmsShipmentItemId: number;
  readonly wmsOrderId: number;
  readonly wmsOrderItemId: number;
  readonly productVariantId: number | null;
  readonly warehouseLocationId: number | null;
  readonly quantity: number;
  readonly deductFromOnHandOnly: boolean;
}

export interface IngressEngineCancellationCandidate {
  readonly wmsShipmentId: number;
  readonly engine: string;
  readonly engineOrderRef: string;
  readonly engineShipmentRef: string | null;
}

export interface PreparedChannelFulfillmentReceipt {
  readonly receiptId: number;
  readonly omsOrderId: number;
  readonly terminalReplay: boolean;
  readonly sourceEcho: boolean;
  readonly physicalShipmentId: number | null;
  readonly legacyWmsShipmentIds: readonly number[];
  readonly inventoryItems: readonly IngressInventoryItem[];
  readonly cancellationCandidates: readonly IngressEngineCancellationCandidate[];
  readonly partialOverlapShipmentIds: readonly number[];
}

export interface ClaimChannelFulfillmentReceiptInput {
  readonly receiptId: number;
  readonly input: NormalizedChannelFulfillmentIngress;
  readonly now: Date;
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
}

export interface ClaimedChannelFulfillmentReceipt {
  readonly receiptId: number;
  readonly terminalReplay: boolean;
  readonly sourceEcho: boolean;
  readonly physicalShipmentId: number | null;
  readonly leaseToken: string | null;
  readonly attemptNumber: number;
}

export interface RenewChannelFulfillmentReceiptLeaseInput {
  readonly receiptId: number;
  readonly leaseToken: string;
  readonly now: Date;
  readonly leaseDurationMs: number;
}

export interface StageChannelFulfillmentReceiptResult {
  readonly receiptId: number;
  readonly processingStatus: string;
  readonly physicalShipmentId: number | null;
}

export interface CompleteChannelFulfillmentReceiptInput {
  readonly receiptId: number;
  readonly leaseToken: string;
  readonly processingStatus: "processed" | "ignored" | "review";
  readonly physicalShipmentId?: number | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly completedAt: Date;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ChannelFulfillmentIngressRepository {
  stageReceipt(input: NormalizedChannelFulfillmentIngress): Promise<StageChannelFulfillmentReceiptResult>;
  claimReceipt(input: ClaimChannelFulfillmentReceiptInput): Promise<ClaimedChannelFulfillmentReceipt>;
  prepareReceipt(
    receiptId: number,
    input: NormalizedChannelFulfillmentIngress,
    leaseToken: string,
    now: Date,
  ): Promise<PreparedChannelFulfillmentReceipt>;
  renewReceiptLease(input: RenewChannelFulfillmentReceiptLeaseInput): Promise<void>;
  attachPhysicalShipment(
    receiptId: number,
    physicalShipmentId: number,
    leaseToken: string,
    now: Date,
  ): Promise<void>;
  recordTrackingAmendment(
    receiptId: number,
    physicalShipmentId: number,
    leaseToken: string,
    input: NormalizedChannelFulfillmentIngress,
    occurredAt: Date,
    now: Date,
  ): Promise<void>;
  completeReceipt(input: CompleteChannelFulfillmentReceiptInput): Promise<void>;
  recordReviewException(input: {
    receiptId: number;
    rule: string;
    summary: string;
    details: Readonly<Record<string, unknown>>;
    wmsShipmentId?: number | null;
  }): Promise<void>;
}

interface ResolvedLineRow {
  oms_order_id: number;
  oms_order_line_id: number;
  channel_order_line_id: string;
  source_channel_id: number;
  channel_provider: string;
  paid_quantity: number;
  authority_fulfillable_quantity: number;
  max_paid_quantity: number;
  product_variant_id: number | null;
  sku: string | null;
  wms_order_id: number | null;
  wms_order_status: string | null;
  wms_order_item_id: number | null;
  wms_item_quantity: number | null;
  wms_item_picked_quantity: number | null;
  wms_item_status: string | null;
  warehouse_location_id: number | null;
}

interface ResolvedLine {
  omsOrderId: number;
  omsOrderLineId: number;
  channelOrderLineId: string;
  sourceChannelId: number;
  channelProvider: string;
  maxAuthorizedQuantity: number;
  productVariantId: number | null;
  sku: string;
  wmsOrderId: number;
  wmsOrderItemId: number;
  wmsOrderStatus: string;
  wmsItemQuantity: number;
  wmsItemPickedQuantity: number;
  wmsItemStatus: string;
  warehouseLocationId: number | null;
  quantity: number;
  sourceFulfillmentLineId: string | null;
}

function rowsOf<T>(result: any): T[] {
  return Array.isArray(result?.rows) ? result.rows as T[] : [];
}

function firstRow<T>(result: any): T | null {
  return rowsOf<T>(result)[0] ?? null;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nullableText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function assertLeaseClaimInput(input: ClaimChannelFulfillmentReceiptInput): void {
  if (
    !Number.isInteger(input.receiptId)
    || input.receiptId <= 0
    || !(input.now instanceof Date)
    || Number.isNaN(input.now.getTime())
    || !input.leaseToken.trim()
    || !Number.isInteger(input.leaseDurationMs)
    || input.leaseDurationMs <= 0
  ) {
    throw new ChannelFulfillmentIngressError(
      "INVALID_INPUT",
      "Invalid channel fulfillment receipt lease claim",
      { receiptId: input.receiptId, leaseDurationMs: input.leaseDurationMs },
      { reviewRequired: false },
    );
  }
}

function leaseOwnershipError(
  receiptId: number,
  context: Record<string, unknown> = {},
): ChannelFulfillmentIngressError {
  return new ChannelFulfillmentIngressError(
    "RECEIPT_LEASE_OWNERSHIP_LOST",
    `Channel fulfillment receipt ${receiptId} is not owned by this worker`,
    { receiptId, ...context },
    { reviewRequired: false },
  );
}

async function assertActiveReceiptLease(
  executor: any,
  receiptId: number,
  leaseToken: string,
  now: Date,
): Promise<any> {
  const receipt = firstRow<any>(await executor.execute(sql`
    SELECT
      id,
      processing_status,
      attempt_count,
      lease_token,
      lease_expires_at,
      last_attempt_at,
      physical_shipment_id
    FROM oms.channel_fulfillment_receipts
    WHERE id = ${receiptId}
    FOR UPDATE
  `));
  if (
    !receipt
    || receipt.processing_status !== "processing"
    || receipt.lease_token !== leaseToken
    || !receipt.lease_expires_at
    || new Date(receipt.lease_expires_at).getTime() <= now.getTime()
  ) {
    throw leaseOwnershipError(receiptId, {
      processingStatus: receipt?.processing_status ?? null,
      leaseExpiresAt: receipt?.lease_expires_at ?? null,
    });
  }
  return receipt;
}

function inputLineMap(input: NormalizedChannelFulfillmentIngress): Map<string, number> {
  return new Map(input.lineItems.map((line) => [line.channelOrderLineId, line.quantity]));
}

function assertExactAllocation(
  expected: ReadonlyMap<string, number>,
  actualRows: readonly { channel_order_line_id: string; quantity: number }[],
  errorCode: "ECHO_COMMAND_CONFLICT" | "CANONICAL_PACKAGE_CONFLICT",
  context: Record<string, unknown>,
): void {
  const actual = new Map<string, number>();
  for (const row of actualRows) {
    actual.set(row.channel_order_line_id, (actual.get(row.channel_order_line_id) ?? 0) + Number(row.quantity));
  }
  const mismatch = expected.size !== actual.size
    || [...expected.entries()].some(([lineId, quantity]) => actual.get(lineId) !== quantity);
  if (mismatch) {
    throw new ChannelFulfillmentIngressError(
      errorCode,
      "Provider fulfillment line allocations do not match the existing canonical package",
      {
        ...context,
        expected: Object.fromEntries(expected),
        actual: Object.fromEntries(actual),
      },
    );
  }
}

async function resolveOmsOrder(
  tx: any,
  input: NormalizedChannelFulfillmentIngress,
): Promise<{ omsOrderId: number; sourceChannelId: number }> {
  const result = input.sourceChannelId
    ? await tx.execute(sql`
        SELECT oo.id::bigint AS oms_order_id, oo.channel_id AS source_channel_id,
               LOWER(channel.provider) AS channel_provider
        FROM oms.oms_orders oo
        JOIN channels.channels channel ON channel.id = oo.channel_id
        WHERE oo.channel_id = ${input.sourceChannelId}
          AND oo.external_order_id = ${input.sourceOrderId}
        FOR UPDATE OF oo
      `)
    : await tx.execute(sql`
        SELECT oo.id::bigint AS oms_order_id, oo.channel_id AS source_channel_id,
               LOWER(channel.provider) AS channel_provider
        FROM oms.oms_orders oo
        JOIN channels.channels channel ON channel.id = oo.channel_id
        WHERE LOWER(channel.provider) = ${input.sourceProvider}
          AND oo.external_order_id = ${input.sourceOrderId}
        FOR UPDATE OF oo
      `);
  const rows = rowsOf<{ oms_order_id: number; source_channel_id: number; channel_provider: string }>(result);
  if (rows.length === 0) {
    throw new ChannelFulfillmentIngressError(
      "SOURCE_ORDER_NOT_FOUND",
      `No OMS order matches ${input.sourceProvider} order ${input.sourceOrderId}`,
      { sourceProvider: input.sourceProvider, sourceChannelId: input.sourceChannelId, sourceOrderId: input.sourceOrderId },
    );
  }
  if (rows.length !== 1) {
    throw new ChannelFulfillmentIngressError(
      "SOURCE_ORDER_AMBIGUOUS",
      `Multiple OMS orders match ${input.sourceProvider} order ${input.sourceOrderId}`,
      { sourceProvider: input.sourceProvider, sourceOrderId: input.sourceOrderId, matches: rows.length },
    );
  }
  const row = rows[0];
  if (row.channel_provider !== input.sourceProvider) {
    throw new ChannelFulfillmentIngressError(
      "SOURCE_CHANNEL_MISMATCH",
      `Channel ${row.source_channel_id} is not a ${input.sourceProvider} channel`,
      { sourceProvider: input.sourceProvider, sourceChannelId: row.source_channel_id, actualProvider: row.channel_provider },
    );
  }
  return { omsOrderId: Number(row.oms_order_id), sourceChannelId: Number(row.source_channel_id) };
}

async function resolveExactLines(
  tx: any,
  input: NormalizedChannelFulfillmentIngress,
  omsOrderId: number,
): Promise<ResolvedLine[]> {
  const lineIds = input.lineItems.map((line) => line.channelOrderLineId);
  const lockedOmsLineResult = await tx.execute(sql`
    SELECT
      ol.id::bigint AS oms_order_line_id,
      ol.external_line_item_id AS channel_order_line_id
    FROM oms.oms_order_lines ol
    WHERE ol.order_id = ${omsOrderId}
      AND ol.external_line_item_id = ANY(${lineIds}::text[])
    ORDER BY ol.id
    FOR UPDATE OF ol
  `);
  const lockedOmsLines = rowsOf<{
    oms_order_line_id: number;
    channel_order_line_id: string;
  }>(lockedOmsLineResult);
  const lockedOmsLinesByChannelLine = new Map<string, number[]>();
  for (const row of lockedOmsLines) {
    const omsLineIds = lockedOmsLinesByChannelLine.get(row.channel_order_line_id) ?? [];
    omsLineIds.push(Number(row.oms_order_line_id));
    lockedOmsLinesByChannelLine.set(row.channel_order_line_id, omsLineIds);
  }
  for (const inputLine of input.lineItems) {
    const omsLineIds = lockedOmsLinesByChannelLine.get(inputLine.channelOrderLineId) ?? [];
    if (omsLineIds.length === 0) {
      throw new ChannelFulfillmentIngressError(
        "CHANNEL_LINE_NOT_FOUND",
        `Channel line ${inputLine.channelOrderLineId} was not found on OMS order ${omsOrderId}`,
        { omsOrderId, channelOrderLineId: inputLine.channelOrderLineId },
      );
    }
    if (omsLineIds.length !== 1) {
      throw new ChannelFulfillmentIngressError(
        "CHANNEL_LINE_AMBIGUOUS",
        `Channel line ${inputLine.channelOrderLineId} maps to multiple OMS lines`,
        { omsOrderId, channelOrderLineId: inputLine.channelOrderLineId, omsOrderLineIds: omsLineIds },
      );
    }
  }

  const result = await tx.execute(sql`
    SELECT
      oo.id::bigint AS oms_order_id,
      ol.id::bigint AS oms_order_line_id,
      ol.external_line_item_id AS channel_order_line_id,
      oo.channel_id AS source_channel_id,
      LOWER(channel.provider) AS channel_provider,
      COALESCE(ol.paid_quantity, 0)::int AS paid_quantity,
      COALESCE(ol.authority_fulfillable_quantity, 0)::int AS authority_fulfillable_quantity,
      COALESCE(authority.max_paid_quantity, 0)::int AS max_paid_quantity,
      ol.product_variant_id,
      ol.sku,
      w.id AS wms_order_id,
      w.warehouse_status AS wms_order_status,
      oi.id AS wms_order_item_id,
      oi.quantity::int AS wms_item_quantity,
      oi.picked_quantity::int AS wms_item_picked_quantity,
      oi.status AS wms_item_status,
      COALESCE(
        (
          SELECT inventory_tx.from_location_id
          FROM inventory.inventory_transactions inventory_tx
          WHERE inventory_tx.order_item_id = oi.id
            AND inventory_tx.product_variant_id = ol.product_variant_id
            AND inventory_tx.transaction_type = 'pick'
            AND inventory_tx.from_location_id IS NOT NULL
          ORDER BY inventory_tx.created_at DESC, inventory_tx.id DESC
          LIMIT 1
        ),
        (
          SELECT product_location.warehouse_location_id
          FROM warehouse.product_locations product_location
          JOIN warehouse.warehouse_locations location
            ON location.id = product_location.warehouse_location_id
          WHERE product_location.product_variant_id = ol.product_variant_id
            AND product_location.status = 'active'
            AND location.cycle_count_freeze_id IS NULL
          ORDER BY product_location.is_primary DESC, product_location.id
          LIMIT 1
        ),
        (
          SELECT level.warehouse_location_id
          FROM inventory.inventory_levels level
          JOIN warehouse.warehouse_locations location
            ON location.id = level.warehouse_location_id
          WHERE level.product_variant_id = ol.product_variant_id
            AND level.variant_qty > 0
            AND location.cycle_count_freeze_id IS NULL
          ORDER BY level.variant_qty DESC, level.warehouse_location_id
          LIMIT 1
        )
      ) AS warehouse_location_id
    FROM oms.oms_orders oo
    JOIN channels.channels channel ON channel.id = oo.channel_id
    JOIN oms.oms_order_lines ol ON ol.order_id = oo.id
    LEFT JOIN LATERAL (
      SELECT MAX(event.paid_quantity)::int AS max_paid_quantity
      FROM oms.oms_order_line_authority_events event
      WHERE event.order_line_id = ol.id
    ) authority ON TRUE
    JOIN wms.order_items oi
      ON oi.oms_order_line_id = ol.id
    JOIN wms.orders w
      ON w.id = oi.order_id
     AND w.warehouse_status <> 'cancelled'
    WHERE oo.id = ${omsOrderId}
      AND ol.external_line_item_id = ANY(${lineIds}::text[])
    ORDER BY ol.id, w.id, oi.id
    FOR UPDATE OF ol, w, oi
  `);
  const byChannelLine = new Map<string, ResolvedLineRow[]>();
  for (const row of rowsOf<ResolvedLineRow>(result)) {
    const rows = byChannelLine.get(row.channel_order_line_id) ?? [];
    rows.push(row);
    byChannelLine.set(row.channel_order_line_id, rows);
  }

  const resolved: ResolvedLine[] = [];
  for (const inputLine of input.lineItems) {
    const rows = byChannelLine.get(inputLine.channelOrderLineId) ?? [];
    if (rows.length === 0) {
      throw new ChannelFulfillmentIngressError(
        "WMS_LINEAGE_MISSING",
        `OMS line ${lockedOmsLinesByChannelLine.get(inputLine.channelOrderLineId)?.[0]} has no active WMS item`,
        {
          omsOrderId,
          omsOrderLineId: lockedOmsLinesByChannelLine.get(inputLine.channelOrderLineId)?.[0],
          channelOrderLineId: inputLine.channelOrderLineId,
        },
      );
    }
    const omsLineIds = new Set(rows.map((row) => Number(row.oms_order_line_id)));
    if (omsLineIds.size !== 1) {
      throw new ChannelFulfillmentIngressError(
        "CHANNEL_LINE_AMBIGUOUS",
        `Channel line ${inputLine.channelOrderLineId} maps to multiple OMS lines`,
        { omsOrderId, channelOrderLineId: inputLine.channelOrderLineId, omsOrderLineIds: [...omsLineIds] },
      );
    }
    const wmsRows = rows.filter((row) => positiveInteger(row.wms_order_item_id));
    if (wmsRows.length !== 1) {
      throw new ChannelFulfillmentIngressError(
        "WMS_LINEAGE_AMBIGUOUS",
        `OMS line ${[...omsLineIds][0]} maps to multiple active WMS items`,
        {
          omsOrderId,
          channelOrderLineId: inputLine.channelOrderLineId,
          wmsOrderItemIds: wmsRows.map((row) => Number(row.wms_order_item_id)),
        },
      );
    }
    const row = wmsRows[0];
    const maxAuthorizedQuantity = Math.max(
      Number(row.paid_quantity ?? 0),
      Number(row.max_paid_quantity ?? 0),
    );
    if (inputLine.quantity > maxAuthorizedQuantity) {
      throw new ChannelFulfillmentIngressError(
        "FULFILLMENT_AUTHORITY_EXCEEDED",
        `Fulfillment quantity exceeds proven paid authority for channel line ${inputLine.channelOrderLineId}`,
        {
          omsOrderId,
          omsOrderLineId: Number(row.oms_order_line_id),
          channelOrderLineId: inputLine.channelOrderLineId,
          fulfillmentQuantity: inputLine.quantity,
          maxAuthorizedQuantity,
        },
      );
    }
    const sku = nullableText(row.sku);
    if (!sku) {
      throw new ChannelFulfillmentIngressError(
        "WMS_LINEAGE_MISSING",
        `OMS line ${row.oms_order_line_id} has no SKU snapshot`,
        { omsOrderId, omsOrderLineId: Number(row.oms_order_line_id) },
      );
    }
    resolved.push({
      omsOrderId,
      omsOrderLineId: Number(row.oms_order_line_id),
      channelOrderLineId: inputLine.channelOrderLineId,
      sourceChannelId: Number(row.source_channel_id),
      channelProvider: row.channel_provider,
      maxAuthorizedQuantity,
      productVariantId: positiveInteger(row.product_variant_id),
      sku,
      wmsOrderId: Number(row.wms_order_id),
      wmsOrderItemId: Number(row.wms_order_item_id),
      wmsOrderStatus: String(row.wms_order_status),
      wmsItemQuantity: Number(row.wms_item_quantity),
      wmsItemPickedQuantity: Number(row.wms_item_picked_quantity),
      wmsItemStatus: String(row.wms_item_status),
      warehouseLocationId: positiveInteger(row.warehouse_location_id),
      quantity: inputLine.quantity,
      sourceFulfillmentLineId: inputLine.sourceFulfillmentLineId,
    });
  }
  return resolved;
}

async function findExactEcho(
  tx: any,
  input: NormalizedChannelFulfillmentIngress,
  omsOrderId: number,
): Promise<{ physicalShipmentId: number; itemRows: any[] } | null> {
  const providerIds = input.sourceProvider === "shopify" && /^\d+$/.test(input.sourceFulfillmentId)
    ? [input.sourceFulfillmentId, `gid://shopify/Fulfillment/${input.sourceFulfillmentId}`]
    : [input.sourceFulfillmentId];
  const result = await tx.execute(sql`
    SELECT
      push.id AS push_id,
      push.physical_shipment_id,
      item.channel_order_line_id,
      item.quantity_pushed::int AS quantity,
      physical_item.id AS physical_shipment_item_id,
      physical_item.legacy_wms_shipment_item_id
    FROM oms.channel_fulfillment_pushes push
    JOIN oms.channel_fulfillment_push_items item
      ON item.channel_fulfillment_push_id = push.id
    LEFT JOIN wms.physical_shipment_items physical_item
      ON physical_item.id = item.physical_shipment_item_id
    WHERE push.channel_provider = ${input.sourceProvider}
      AND push.oms_order_id = ${omsOrderId}
      AND push.channel_fulfillment_id = ANY(${providerIds}::text[])
      AND push.push_status IN ('success', 'ignored')
    ORDER BY push.id, item.id
  `);
  const rows = rowsOf<any>(result);
  if (rows.length === 0) return null;
  const pushIds = new Set(rows.map((row) => Number(row.push_id)));
  const physicalIds = new Set(rows.map((row) => Number(row.physical_shipment_id)));
  if (pushIds.size !== 1 || physicalIds.size !== 1) {
    throw new ChannelFulfillmentIngressError(
      "ECHO_COMMAND_CONFLICT",
      "A provider fulfillment id maps to multiple outbound fulfillment commands",
      { sourceProvider: input.sourceProvider, sourceFulfillmentId: input.sourceFulfillmentId, pushIds: [...pushIds] },
    );
  }
  assertExactAllocation(inputLineMap(input), rows, "ECHO_COMMAND_CONFLICT", {
    sourceProvider: input.sourceProvider,
    sourceFulfillmentId: input.sourceFulfillmentId,
    pushId: [...pushIds][0],
  });
  return { physicalShipmentId: [...physicalIds][0], itemRows: rows };
}

async function findExistingCanonicalPackage(
  tx: any,
  input: NormalizedChannelFulfillmentIngress,
): Promise<{ physicalShipmentId: number; itemRows: any[] } | null> {
  const result = await tx.execute(sql`
    SELECT
      physical.id AS physical_shipment_id,
      oms_line.external_line_item_id AS channel_order_line_id,
      item.quantity_shipped::int AS quantity,
      item.id AS physical_shipment_item_id,
      item.legacy_wms_shipment_item_id,
      legacy_item.shipment_id AS legacy_wms_shipment_id
    FROM wms.physical_shipments physical
    JOIN wms.physical_shipment_items item ON item.physical_shipment_id = physical.id
    LEFT JOIN wms.outbound_shipment_items legacy_item
      ON legacy_item.id = item.legacy_wms_shipment_item_id
    JOIN wms.fulfillment_plan_lines plan_line ON plan_line.id = item.fulfillment_plan_line_id
    JOIN oms.oms_order_lines oms_line ON oms_line.id = plan_line.oms_order_line_id
    WHERE physical.provider = ${input.sourceProvider}
      AND physical.provider_physical_shipment_id = ${input.sourceFulfillmentId}
      AND item.shipment_item_purpose = 'customer_fulfillment'
    ORDER BY physical.id, item.id
  `);
  const rows = rowsOf<any>(result);
  if (rows.length === 0) return null;
  const physicalIds = new Set(rows.map((row) => Number(row.physical_shipment_id)));
  if (physicalIds.size !== 1) {
    throw new ChannelFulfillmentIngressError(
      "CANONICAL_PACKAGE_CONFLICT",
      "A provider physical shipment identity maps to multiple canonical packages",
      { sourceProvider: input.sourceProvider, sourceFulfillmentId: input.sourceFulfillmentId, physicalShipmentIds: [...physicalIds] },
    );
  }
  assertExactAllocation(inputLineMap(input), rows, "CANONICAL_PACKAGE_CONFLICT", {
    sourceProvider: input.sourceProvider,
    sourceFulfillmentId: input.sourceFulfillmentId,
  });
  return { physicalShipmentId: [...physicalIds][0], itemRows: rows };
}

async function findOrCreateLegacyPackage(
  tx: any,
  input: NormalizedChannelFulfillmentIngress,
  lines: readonly ResolvedLine[],
): Promise<{ legacyShipmentIds: number[]; inventoryItems: IngressInventoryItem[]; lineRows: any[] }> {
  const physicalIdentity = buildProviderPhysicalShipmentIdentity(
    input.sourceProvider,
    input.sourceFulfillmentId,
  );
  const byWmsOrder = new Map<number, ResolvedLine[]>();
  for (const line of lines) {
    const group = byWmsOrder.get(line.wmsOrderId) ?? [];
    group.push(line);
    byWmsOrder.set(line.wmsOrderId, group);
  }

  const legacyShipmentIds: number[] = [];
  const inventoryItems: IngressInventoryItem[] = [];
  const lineRows: any[] = [];
  for (const [wmsOrderId, orderLines] of [...byWmsOrder.entries()].sort(([left], [right]) => left - right)) {
    let shipment = firstRow<{ id: number }>(await tx.execute(sql`
      SELECT id
      FROM wms.outbound_shipments
      WHERE order_id = ${wmsOrderId}
        AND external_fulfillment_id = ${physicalIdentity}
      FOR UPDATE
    `));
    if (!shipment) {
      shipment = firstRow<{ id: number }>(await tx.execute(sql`
        INSERT INTO wms.outbound_shipments (
          order_id,
          channel_id,
          external_fulfillment_id,
          source,
          status,
          carrier,
          tracking_number,
          tracking_url,
          shipped_at,
          shipping_engine,
          engine_order_ref,
          engine_shipment_ref,
          shopify_fulfillment_id,
          requires_review,
          review_reason,
          created_at,
          updated_at
        )
        VALUES (
          ${wmsOrderId},
          ${orderLines[0].sourceChannelId},
          ${physicalIdentity},
          ${`${input.sourceProvider}_fulfillment_receipt`},
          'shipped',
          ${input.carrier},
          ${input.trackingNumber},
          ${input.trackingUrl},
          ${input.shippedAt},
          ${input.sourceProvider},
          ${input.sourceOrderId},
          ${input.sourceFulfillmentId},
          ${input.sourceProvider === "shopify" ? input.sourceFulfillmentId : null},
          ${orderLines.some((line) => !line.productVariantId || !line.warehouseLocationId)},
          ${orderLines.some((line) => !line.productVariantId || !line.warehouseLocationId)
            ? "external_fulfillment_inventory_lineage_missing"
            : null},
          NOW(),
          NOW()
        )
        RETURNING id
      `));
    }
    if (!shipment) {
      throw new ChannelFulfillmentIngressError(
        "CANONICAL_PACKAGE_CONFLICT",
        "Failed to create the compatibility shipment row",
        { wmsOrderId, sourceFulfillmentId: input.sourceFulfillmentId },
        { reviewRequired: false },
      );
    }
    const legacyWmsShipmentId = Number(shipment.id);
    legacyShipmentIds.push(legacyWmsShipmentId);

    for (const line of orderLines) {
      let shipmentItem = firstRow<{ id: number; qty: number }>(await tx.execute(sql`
        SELECT id, qty::int AS qty
        FROM wms.outbound_shipment_items
        WHERE shipment_id = ${legacyWmsShipmentId}
          AND order_item_id = ${line.wmsOrderItemId}
          AND shipment_item_purpose = 'customer_fulfillment'
        FOR UPDATE
      `));
      if (shipmentItem && Number(shipmentItem.qty) !== line.quantity) {
        throw new ChannelFulfillmentIngressError(
          "PACKAGE_ITEM_CONFLICT",
          "An existing compatibility shipment item has a different quantity",
          {
            legacyWmsShipmentId,
            wmsOrderItemId: line.wmsOrderItemId,
            existingQuantity: Number(shipmentItem.qty),
            receiptQuantity: line.quantity,
          },
        );
      }
      if (!shipmentItem) {
        shipmentItem = firstRow<{ id: number; qty: number }>(await tx.execute(sql`
          INSERT INTO wms.outbound_shipment_items (
            shipment_id,
            order_item_id,
            shipment_item_purpose,
            product_variant_id,
            qty,
            from_location_id,
            tracking_id,
            created_at
          )
          VALUES (
            ${legacyWmsShipmentId},
            ${line.wmsOrderItemId},
            'customer_fulfillment',
            ${line.productVariantId},
            ${line.quantity},
            ${line.warehouseLocationId},
            ${input.trackingNumber},
            NOW()
          )
          RETURNING id, qty::int AS qty
        `));
      }
      if (!shipmentItem) {
        throw new ChannelFulfillmentIngressError(
          "CANONICAL_PACKAGE_CONFLICT",
          "Failed to create the compatibility shipment item",
          { legacyWmsShipmentId, wmsOrderItemId: line.wmsOrderItemId },
          { reviewRequired: false },
        );
      }
      const legacyWmsShipmentItemId = Number(shipmentItem.id);
      lineRows.push({
        line,
        legacyWmsShipmentItemId,
        physicalShipmentItemId: null,
      });
      inventoryItems.push(Object.freeze({
        legacyWmsShipmentId,
        legacyWmsShipmentItemId,
        wmsOrderId,
        wmsOrderItemId: line.wmsOrderItemId,
        productVariantId: line.productVariantId,
        warehouseLocationId: line.warehouseLocationId,
        quantity: line.quantity,
        deductFromOnHandOnly: line.wmsItemPickedQuantity <= 0,
      }));
    }
  }
  return { legacyShipmentIds, inventoryItems, lineRows };
}

async function persistReceiptItems(
  tx: any,
  receiptId: number,
  lineRows: readonly any[],
): Promise<void> {
  for (const row of lineRows) {
    const line: ResolvedLine = row.line;
    await tx.execute(sql`
      INSERT INTO oms.channel_fulfillment_receipt_items (
        receipt_id,
        source_fulfillment_line_id,
        channel_order_line_id,
        quantity,
        oms_order_line_id,
        wms_order_item_id,
        legacy_wms_shipment_item_id,
        physical_shipment_item_id,
        created_at
      )
      VALUES (
        ${receiptId},
        ${line.sourceFulfillmentLineId},
        ${line.channelOrderLineId},
        ${line.quantity},
        ${line.omsOrderLineId},
        ${line.wmsOrderItemId},
        ${row.legacyWmsShipmentItemId ?? null},
        ${row.physicalShipmentItemId ?? null},
        NOW()
      )
      ON CONFLICT (receipt_id, channel_order_line_id) DO NOTHING
    `);
  }
  const persisted = rowsOf<any>(await tx.execute(sql`
    SELECT
      channel_order_line_id,
      quantity::int AS quantity,
      oms_order_line_id,
      wms_order_item_id,
      legacy_wms_shipment_item_id,
      physical_shipment_item_id
    FROM oms.channel_fulfillment_receipt_items
    WHERE receipt_id = ${receiptId}
    ORDER BY channel_order_line_id
  `));
  if (persisted.length !== lineRows.length) {
    throw new ChannelFulfillmentIngressError(
      "PACKAGE_ITEM_CONFLICT",
      "Persisted receipt item count does not match the provider event",
      { receiptId, expectedCount: lineRows.length, actualCount: persisted.length },
    );
  }
  for (const row of lineRows) {
    const actual = persisted.find((item) => item.channel_order_line_id === row.line.channelOrderLineId);
    if (
      !actual
      || Number(actual.quantity) !== row.line.quantity
      || Number(actual.oms_order_line_id) !== row.line.omsOrderLineId
      || Number(actual.wms_order_item_id) !== row.line.wmsOrderItemId
      || (row.legacyWmsShipmentItemId != null
        && Number(actual.legacy_wms_shipment_item_id) !== Number(row.legacyWmsShipmentItemId))
      || (row.physicalShipmentItemId != null
        && Number(actual.physical_shipment_item_id) !== Number(row.physicalShipmentItemId))
    ) {
      throw new ChannelFulfillmentIngressError(
        "PACKAGE_ITEM_CONFLICT",
        `Receipt line ${row.line.channelOrderLineId} conflicts with retained evidence`,
        { receiptId, channelOrderLineId: row.line.channelOrderLineId },
      );
    }
  }
}

async function findCancellationCandidates(
  tx: any,
  input: NormalizedChannelFulfillmentIngress,
  lines: readonly ResolvedLine[],
  packageLegacyShipmentIds: readonly number[],
): Promise<{ candidates: IngressEngineCancellationCandidate[]; partialOverlapShipmentIds: number[] }> {
  const wmsOrderIds = [...new Set(lines.map((line) => line.wmsOrderId))];
  if (wmsOrderIds.length === 0) return { candidates: [], partialOverlapShipmentIds: [] };
  const result = await tx.execute(sql`
    SELECT
      shipment.id AS wms_shipment_id,
      COALESCE(NULLIF(BTRIM(shipment.shipping_engine), ''),
        CASE WHEN shipment.shipstation_order_id IS NOT NULL THEN 'shipstation' END
      ) AS engine,
      COALESCE(NULLIF(BTRIM(shipment.engine_order_ref), ''), shipment.shipstation_order_id::text) AS engine_order_ref,
      NULLIF(BTRIM(shipment.engine_shipment_ref), '') AS engine_shipment_ref,
      item.order_item_id,
      item.qty::int AS quantity
    FROM wms.outbound_shipments shipment
    JOIN wms.outbound_shipment_items item ON item.shipment_id = shipment.id
    WHERE shipment.order_id = ANY(${wmsOrderIds}::int[])
      AND shipment.id <> ALL(${packageLegacyShipmentIds}::int[])
      AND shipment.status IN ('planned', 'queued', 'labeled', 'on_hold')
      AND item.shipment_item_purpose = 'customer_fulfillment'
      AND item.qty > 0
    ORDER BY shipment.id, item.id
  `);
  const fulfilledByOrderItem = new Map(lines.map((line) => [line.wmsOrderItemId, line.quantity]));
  const grouped = new Map<number, any[]>();
  for (const row of rowsOf<any>(result)) {
    const rows = grouped.get(Number(row.wms_shipment_id)) ?? [];
    rows.push(row);
    grouped.set(Number(row.wms_shipment_id), rows);
  }
  const candidates: IngressEngineCancellationCandidate[] = [];
  const partialOverlapShipmentIds: number[] = [];
  for (const [shipmentId, shipmentRows] of grouped) {
    const overlap = shipmentRows.some((row) => fulfilledByOrderItem.has(Number(row.order_item_id)));
    if (!overlap) continue;
    const fullyCovered = shipmentRows.every((row) =>
      (fulfilledByOrderItem.get(Number(row.order_item_id)) ?? 0) >= Number(row.quantity),
    );
    const first = shipmentRows[0];
    const engine = nullableText(first.engine);
    const engineOrderRef = nullableText(first.engine_order_ref);
    if (fullyCovered && engine && engineOrderRef && engine !== input.sourceProvider) {
      candidates.push(Object.freeze({
        wmsShipmentId: shipmentId,
        engine,
        engineOrderRef,
        engineShipmentRef: nullableText(first.engine_shipment_ref),
      }));
    } else if (!fullyCovered) {
      partialOverlapShipmentIds.push(shipmentId);
    }
  }
  return { candidates, partialOverlapShipmentIds };
}

export function createChannelFulfillmentIngressRepository(
  db: any,
): ChannelFulfillmentIngressRepository {
  async function stageReceipt(
    input: NormalizedChannelFulfillmentIngress,
  ): Promise<StageChannelFulfillmentReceiptResult> {
    await db.execute(sql`
      INSERT INTO oms.channel_fulfillment_receipts (
        receipt_key,
        request_hash,
        source_provider,
        source_channel_id,
        source_order_id,
        source_fulfillment_id,
        source_event_id,
        source_inbox_id,
        event_kind,
        source,
        tracking_number,
        carrier,
        tracking_url,
        shipped_at,
        raw_payload,
        correlation_id,
        causation_id,
        created_at,
        updated_at
      )
      VALUES (
        ${input.receiptKey},
        ${input.requestHash},
        ${input.sourceProvider},
        ${input.sourceChannelId},
        ${input.sourceOrderId},
        ${input.sourceFulfillmentId},
        ${input.sourceEventId},
        ${input.sourceInboxId},
        ${input.eventKind},
        ${input.source},
        ${input.trackingNumber},
        ${input.carrier},
        ${input.trackingUrl},
        ${input.shippedAt},
        ${json(input.rawPayload)}::jsonb,
        ${input.correlationId},
        ${input.causationId},
        NOW(),
        NOW()
      )
      ON CONFLICT (receipt_key) DO NOTHING
    `);
    const row = firstRow<any>(await db.execute(sql`
      SELECT id, request_hash, processing_status, physical_shipment_id
      FROM oms.channel_fulfillment_receipts
      WHERE receipt_key = ${input.receiptKey}
    `));
    if (!row) {
      throw new ChannelFulfillmentIngressError(
        "CANONICAL_PACKAGE_CONFLICT",
        "Channel fulfillment receipt was not retained",
        { receiptKey: input.receiptKey },
        { reviewRequired: false },
      );
    }
    if (row.request_hash !== input.requestHash) {
      throw new ChannelFulfillmentIngressError(
        "PACKAGE_ITEM_CONFLICT",
        "The same provider event identity arrived with a different payload",
        { receiptId: Number(row.id), receiptKey: input.receiptKey },
      );
    }
    return Object.freeze({
      receiptId: Number(row.id),
      processingStatus: String(row.processing_status),
      physicalShipmentId: positiveInteger(row.physical_shipment_id),
    });
  }

  async function claimReceipt(
    claim: ClaimChannelFulfillmentReceiptInput,
  ): Promise<ClaimedChannelFulfillmentReceipt> {
    assertLeaseClaimInput(claim);
    const leaseExpiresAt = new Date(claim.now.getTime() + claim.leaseDurationMs);
    return db.transaction(async (tx: any) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${claim.input.sourceProvider}:${claim.input.sourceFulfillmentId}`}, 0)
        )
      `);
      const receipt = firstRow<any>(await tx.execute(sql`
        SELECT
          id,
          processing_status,
          attempt_count,
          lease_token,
          lease_expires_at,
          last_attempt_at,
          physical_shipment_id
        FROM oms.channel_fulfillment_receipts
        WHERE id = ${claim.receiptId}
        FOR UPDATE
      `));
      if (!receipt) {
        throw new ChannelFulfillmentIngressError(
          "CANONICAL_PACKAGE_CONFLICT",
          `Channel fulfillment receipt ${claim.receiptId} was not found`,
          { receiptId: claim.receiptId },
          { reviewRequired: false },
        );
      }

      const currentStatus = String(receipt.processing_status);
      const currentAttempt = Number(receipt.attempt_count ?? 0);
      if (currentStatus === "processed" || currentStatus === "ignored") {
        return Object.freeze({
          receiptId: claim.receiptId,
          terminalReplay: true,
          sourceEcho: currentStatus === "ignored",
          physicalShipmentId: positiveInteger(receipt.physical_shipment_id),
          leaseToken: null,
          attemptNumber: currentAttempt,
        });
      }

      const currentLeaseExpiresAt = receipt.lease_expires_at
        ? new Date(receipt.lease_expires_at)
        : null;
      if (
        currentStatus === "processing"
        && currentLeaseExpiresAt
        && currentLeaseExpiresAt.getTime() > claim.now.getTime()
      ) {
        throw new ChannelFulfillmentIngressError(
          "RECEIPT_ALREADY_PROCESSING",
          `Channel fulfillment receipt ${claim.receiptId} is already being processed`,
          {
            receiptId: claim.receiptId,
            attemptNumber: currentAttempt,
            leaseExpiresAt: currentLeaseExpiresAt.toISOString(),
          },
          { reviewRequired: false },
        );
      }

      if (currentStatus === "processing") {
        const previousStartedAt = receipt.last_attempt_at
          ? new Date(receipt.last_attempt_at)
          : claim.now;
        await tx.execute(sql`
          INSERT INTO oms.channel_fulfillment_receipt_attempts (
            receipt_id,
            attempt_number,
            lease_token,
            outcome,
            started_at,
            completed_at,
            error_code,
            error_message,
            metadata,
            created_at
          )
          VALUES (
            ${claim.receiptId},
            ${currentAttempt},
            ${String(receipt.lease_token)},
            'lease_expired',
            ${previousStartedAt},
            ${claim.now},
            'RECEIPT_LEASE_EXPIRED',
            'Receipt processing lease expired before completion',
            ${json({ previousLeaseExpiresAt: currentLeaseExpiresAt?.toISOString() ?? null })}::jsonb,
            ${claim.now}
          )
          ON CONFLICT (receipt_id, attempt_number) DO NOTHING
        `);
      }

      const claimed = firstRow<any>(await tx.execute(sql`
        UPDATE oms.channel_fulfillment_receipts
        SET processing_status = 'processing',
            attempt_count = attempt_count + 1,
            lease_token = ${claim.leaseToken},
            lease_expires_at = ${leaseExpiresAt},
            last_attempt_at = ${claim.now},
            error_code = NULL,
            error_message = NULL,
            processed_at = NULL,
            updated_at = ${claim.now}
        WHERE id = ${claim.receiptId}
        RETURNING attempt_count, physical_shipment_id
      `));
      if (!claimed) {
        throw leaseOwnershipError(claim.receiptId);
      }
      return Object.freeze({
        receiptId: claim.receiptId,
        terminalReplay: false,
        sourceEcho: false,
        physicalShipmentId: positiveInteger(claimed.physical_shipment_id),
        leaseToken: claim.leaseToken,
        attemptNumber: Number(claimed.attempt_count),
      });
    });
  }

  async function prepareReceipt(
    receiptId: number,
    input: NormalizedChannelFulfillmentIngress,
    leaseToken: string,
    now: Date,
  ): Promise<PreparedChannelFulfillmentReceipt> {
    return db.transaction(async (tx: any) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${input.sourceProvider}:${input.sourceFulfillmentId}`}, 0)
        )
      `);
      const receipt = firstRow<any>(await tx.execute(sql`
        SELECT id, processing_status, physical_shipment_id, oms_order_id
        FROM oms.channel_fulfillment_receipts
        WHERE id = ${receiptId}
        FOR UPDATE
      `));
      if (!receipt) {
        throw new ChannelFulfillmentIngressError(
          "CANONICAL_PACKAGE_CONFLICT",
          `Channel fulfillment receipt ${receiptId} was not found`,
          { receiptId },
          { reviewRequired: false },
        );
      }
      await assertActiveReceiptLease(tx, receiptId, leaseToken, now);

      const order = await resolveOmsOrder(tx, input);
      const lines = await resolveExactLines(tx, input, order.omsOrderId);
      await tx.execute(sql`
        UPDATE oms.channel_fulfillment_receipts
        SET oms_order_id = ${order.omsOrderId},
            source_channel_id = COALESCE(source_channel_id, ${order.sourceChannelId}),
            updated_at = NOW()
        WHERE id = ${receiptId}
      `);

      const echo = await findExactEcho(tx, input, order.omsOrderId);
      if (echo) {
        const byChannelLine = new Map(echo.itemRows.map((row) => [row.channel_order_line_id, row]));
        await persistReceiptItems(tx, receiptId, lines.map((line) => {
          const row = byChannelLine.get(line.channelOrderLineId);
          return {
            line,
            legacyWmsShipmentItemId: positiveInteger(row?.legacy_wms_shipment_item_id),
            physicalShipmentItemId: positiveInteger(row?.physical_shipment_item_id),
          };
        }));
        return Object.freeze({
          receiptId,
          omsOrderId: order.omsOrderId,
          terminalReplay: false,
          sourceEcho: true,
          physicalShipmentId: echo.physicalShipmentId,
          legacyWmsShipmentIds: Object.freeze([]),
          inventoryItems: Object.freeze([]),
          cancellationCandidates: Object.freeze([]),
          partialOverlapShipmentIds: Object.freeze([]),
        });
      }

      const existingPhysical = await findExistingCanonicalPackage(tx, input);
      let packageRows: any[];
      let physicalShipmentId: number | null;
      let legacyWmsShipmentIds: number[];
      let inventoryItems: IngressInventoryItem[];
      if (existingPhysical) {
        physicalShipmentId = existingPhysical.physicalShipmentId;
        const byChannelLine = new Map(existingPhysical.itemRows.map((row) => [row.channel_order_line_id, row]));
        packageRows = lines.map((line) => {
          const row = byChannelLine.get(line.channelOrderLineId);
          return {
            line,
            legacyWmsShipmentItemId: positiveInteger(row?.legacy_wms_shipment_item_id),
            legacyWmsShipmentId: positiveInteger(row?.legacy_wms_shipment_id),
            physicalShipmentItemId: positiveInteger(row?.physical_shipment_item_id),
          };
        });
        legacyWmsShipmentIds = rowsOf<{ legacy_shipment_id: number }>(await tx.execute(sql`
          SELECT DISTINCT shipment_item.shipment_id AS legacy_shipment_id
          FROM wms.physical_shipment_items physical_item
          JOIN wms.outbound_shipment_items shipment_item
            ON shipment_item.id = physical_item.legacy_wms_shipment_item_id
          WHERE physical_item.physical_shipment_id = ${physicalShipmentId}
          ORDER BY shipment_item.shipment_id
        `)).map((row) => Number(row.legacy_shipment_id));
        inventoryItems = packageRows
          .filter((row) =>
            positiveInteger(row.legacyWmsShipmentItemId)
            && positiveInteger(row.legacyWmsShipmentId))
          .map((row) => Object.freeze({
            legacyWmsShipmentId: Number(row.legacyWmsShipmentId),
            legacyWmsShipmentItemId: Number(row.legacyWmsShipmentItemId),
            wmsOrderId: row.line.wmsOrderId,
            wmsOrderItemId: row.line.wmsOrderItemId,
            productVariantId: row.line.productVariantId,
            warehouseLocationId: row.line.warehouseLocationId,
            quantity: row.line.quantity,
            deductFromOnHandOnly: row.line.wmsItemPickedQuantity <= 0,
          }));
      } else {
        const created = await findOrCreateLegacyPackage(tx, input, lines);
        physicalShipmentId = null;
        packageRows = created.lineRows;
        legacyWmsShipmentIds = created.legacyShipmentIds;
        inventoryItems = created.inventoryItems;
      }
      await persistReceiptItems(tx, receiptId, packageRows);
      const cancellation = await findCancellationCandidates(
        tx,
        input,
        lines,
        legacyWmsShipmentIds,
      );
      return Object.freeze({
        receiptId,
        omsOrderId: order.omsOrderId,
        terminalReplay: false,
        sourceEcho: false,
        physicalShipmentId,
        legacyWmsShipmentIds: Object.freeze([...legacyWmsShipmentIds]),
        inventoryItems: Object.freeze([...inventoryItems]),
        cancellationCandidates: Object.freeze(cancellation.candidates),
        partialOverlapShipmentIds: Object.freeze(cancellation.partialOverlapShipmentIds),
      });
    });
  }

  async function renewReceiptLease(
    input: RenewChannelFulfillmentReceiptLeaseInput,
  ): Promise<void> {
    if (
      !Number.isInteger(input.receiptId)
      || input.receiptId <= 0
      || !(input.now instanceof Date)
      || Number.isNaN(input.now.getTime())
      || !input.leaseToken.trim()
      || !Number.isInteger(input.leaseDurationMs)
      || input.leaseDurationMs <= 0
    ) {
      throw new ChannelFulfillmentIngressError(
        "INVALID_INPUT",
        "Invalid channel fulfillment receipt lease renewal",
        { receiptId: input.receiptId, leaseDurationMs: input.leaseDurationMs },
        { reviewRequired: false },
      );
    }
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseDurationMs);
    const renewed = await db.execute(sql`
      UPDATE oms.channel_fulfillment_receipts
      SET lease_expires_at = ${leaseExpiresAt},
          updated_at = ${input.now}
      WHERE id = ${input.receiptId}
        AND processing_status = 'processing'
        AND lease_token = ${input.leaseToken}
        AND lease_expires_at > ${input.now}
      RETURNING id
    `);
    if (rowsOf(renewed).length !== 1) {
      throw leaseOwnershipError(input.receiptId);
    }
  }

  async function attachPhysicalShipment(
    receiptId: number,
    physicalShipmentId: number,
    leaseToken: string,
    now: Date,
  ): Promise<void> {
    await db.transaction(async (tx: any) => {
      const receipt = await assertActiveReceiptLease(tx, receiptId, leaseToken, now);
      const existingPhysicalShipmentId = positiveInteger(receipt.physical_shipment_id);
      if (existingPhysicalShipmentId && existingPhysicalShipmentId !== physicalShipmentId) {
        throw new ChannelFulfillmentIngressError(
          "CANONICAL_PACKAGE_CONFLICT",
          `Receipt ${receiptId} is already attached to a different physical shipment`,
          { receiptId, existingPhysicalShipmentId, physicalShipmentId },
        );
      }
      await tx.execute(sql`
        UPDATE oms.channel_fulfillment_receipts
        SET physical_shipment_id = COALESCE(physical_shipment_id, ${physicalShipmentId}),
            updated_at = NOW()
        WHERE id = ${receiptId}
          AND (physical_shipment_id IS NULL OR physical_shipment_id = ${physicalShipmentId})
      `);
      await tx.execute(sql`
        UPDATE oms.channel_fulfillment_receipt_items receipt_item
        SET physical_shipment_item_id = physical_item.id
        FROM wms.physical_shipment_items physical_item
        WHERE receipt_item.receipt_id = ${receiptId}
          AND receipt_item.legacy_wms_shipment_item_id = physical_item.legacy_wms_shipment_item_id
          AND physical_item.physical_shipment_id = ${physicalShipmentId}
          AND receipt_item.physical_shipment_item_id IS NULL
      `);
      const unresolved = firstRow<{ count: number }>(await tx.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM oms.channel_fulfillment_receipt_items
        WHERE receipt_id = ${receiptId}
          AND physical_shipment_item_id IS NULL
      `));
      if (Number(unresolved?.count ?? 0) > 0) {
        throw new ChannelFulfillmentIngressError(
          "CANONICAL_PACKAGE_CONFLICT",
          "Not every receipt item resolved to the canonical physical package",
          { receiptId, physicalShipmentId, unresolvedItems: Number(unresolved?.count ?? 0) },
        );
      }
    });
  }

  async function recordTrackingAmendment(
    receiptId: number,
    physicalShipmentId: number,
    leaseToken: string,
    input: NormalizedChannelFulfillmentIngress,
    occurredAt: Date,
    now: Date,
  ): Promise<void> {
    await db.transaction(async (tx: any) => {
      await assertActiveReceiptLease(tx, receiptId, leaseToken, now);
      await tx.execute(sql`
        INSERT INTO wms.physical_shipment_tracking_amendments (
        physical_shipment_id,
        provider,
        provider_event_id,
        request_hash,
        tracking_number,
        carrier,
        tracking_url,
        occurred_at,
        source,
        raw_payload,
        created_at
      )
      VALUES (
        ${physicalShipmentId},
        ${input.sourceProvider},
        ${input.sourceEventId},
        ${input.requestHash},
        ${input.trackingNumber},
        ${input.carrier},
        ${input.trackingUrl},
        ${input.shippedAt ?? occurredAt},
        ${input.source},
        ${json({ receiptId, payload: input.rawPayload })}::jsonb,
        NOW()
      )
        ON CONFLICT (physical_shipment_id, request_hash) DO NOTHING
      `);
    });
  }

  async function completeReceipt(input: CompleteChannelFulfillmentReceiptInput): Promise<void> {
    if (!(input.completedAt instanceof Date) || Number.isNaN(input.completedAt.getTime())) {
      throw new ChannelFulfillmentIngressError(
        "INVALID_INPUT",
        "Receipt completion requires a valid completedAt timestamp",
        { receiptId: input.receiptId },
        { reviewRequired: false },
      );
    }
    await db.transaction(async (tx: any) => {
      const receipt = await assertActiveReceiptLease(
        tx,
        input.receiptId,
        input.leaseToken,
        input.completedAt,
      );
      const existingPhysicalShipmentId = positiveInteger(receipt.physical_shipment_id);
      if (
        existingPhysicalShipmentId
        && input.physicalShipmentId
        && existingPhysicalShipmentId !== input.physicalShipmentId
      ) {
        throw new ChannelFulfillmentIngressError(
          "CANONICAL_PACKAGE_CONFLICT",
          `Receipt ${input.receiptId} cannot complete against a different physical shipment`,
          {
            receiptId: input.receiptId,
            existingPhysicalShipmentId,
            physicalShipmentId: input.physicalShipmentId,
          },
        );
      }
      const startedAt = receipt.last_attempt_at
        ? new Date(receipt.last_attempt_at)
        : input.completedAt;
      await tx.execute(sql`
        INSERT INTO oms.channel_fulfillment_receipt_attempts (
          receipt_id,
          attempt_number,
          lease_token,
          outcome,
          started_at,
          completed_at,
          error_code,
          error_message,
          metadata,
          created_at
        )
        VALUES (
          ${input.receiptId},
          ${Number(receipt.attempt_count)},
          ${input.leaseToken},
          ${input.processingStatus},
          ${startedAt},
          ${input.completedAt},
          ${input.errorCode ?? null},
          ${input.errorMessage?.slice(0, 2_000) ?? null},
          ${json(input.metadata ?? {})}::jsonb,
          ${input.completedAt}
        )
      `);
      await tx.execute(sql`
        UPDATE oms.channel_fulfillment_receipts
        SET processing_status = ${input.processingStatus},
            physical_shipment_id = COALESCE(physical_shipment_id, ${input.physicalShipmentId ?? null}),
            lease_token = NULL,
            lease_expires_at = NULL,
            error_code = ${input.errorCode ?? null},
            error_message = ${input.errorMessage?.slice(0, 2_000) ?? null},
            processed_at = ${input.completedAt},
            updated_at = ${input.completedAt}
        WHERE id = ${input.receiptId}
      `);
    });
  }

  async function recordReviewException(input: {
    receiptId: number;
    rule: string;
    summary: string;
    details: Readonly<Record<string, unknown>>;
    wmsShipmentId?: number | null;
  }): Promise<void> {
    const receipt = firstRow<any>(await db.execute(sql`
      SELECT source_provider, source_order_id, source_fulfillment_id
      FROM oms.channel_fulfillment_receipts
      WHERE id = ${input.receiptId}
    `));
    if (!receipt) return;
    const idempotencyKey = `channel_fulfillment_ingress:${input.receiptId}:${input.rule}:${input.wmsShipmentId ?? 0}`;
    await db.execute(sql`
      INSERT INTO wms.reconciliation_exceptions (
        source,
        classification,
        rule,
        status,
        severity,
        wms_shipment_id,
        external_system,
        external_order_ref,
        external_shipment_ref,
        idempotency_key,
        summary,
        details,
        first_seen_at,
        last_seen_at,
        occurrence_count,
        created_at,
        updated_at
      )
      VALUES (
        'channel_fulfillment_ingress',
        'data_conflict',
        ${input.rule},
        'open',
        'review',
        ${input.wmsShipmentId ?? null},
        ${receipt.source_provider},
        ${receipt.source_order_id},
        ${receipt.source_fulfillment_id},
        ${idempotencyKey},
        ${input.summary},
        ${json({ receiptId: input.receiptId, ...input.details })}::jsonb,
        NOW(),
        NOW(),
        1,
        NOW(),
        NOW()
      )
      ON CONFLICT (idempotency_key) DO UPDATE
      SET last_seen_at = NOW(),
          occurrence_count = wms.reconciliation_exceptions.occurrence_count + 1,
          summary = EXCLUDED.summary,
          details = EXCLUDED.details,
          updated_at = NOW()
    `);
  }

  return {
    stageReceipt,
    claimReceipt,
    prepareReceipt,
    renewReceiptLease,
    attachPhysicalShipment,
    recordTrackingAmendment,
    completeReceipt,
    recordReviewException,
  };
}
