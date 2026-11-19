import type { PoolClient } from "pg";

/**
 * OMS-owned transactional command seam for Dropship order creation and
 * canonical acceptance promotion (BOUNDARIES.md §2, COM-01 / OR-F01).
 *
 * Dropship owns intake validation, pricing snapshots, wallet debits, and
 * canonical acceptance staging (`dropship.*`), while OMS owns `oms.oms_orders`,
 * `oms.oms_order_lines`, and `oms.oms_order_events`. Dropship passes its open
 * transaction client here so order creation, line insertion, creation event
 * logging, and staged pending->paid promotion commit or roll back atomically
 * with the vendor wallet debit and line authority grant.
 */

export type DropshipOmsOrderCommandClient = Pick<PoolClient, "query">;

export interface DropshipOmsOrderLineInput {
  productVariantId: number;
  productId: number;
  externalLineItemId: string | null;
  sku: string | null;
  title: string;
  quantity: number;
  wholesaleUnitCostCents: number;
  wholesaleLineTotalCents: number;
}

export interface DropshipOmsOrderShipToInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  address1: string;
  address2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface CreateDropshipOmsOrderInput {
  channelId: number;
  omsExternalOrderId: string;
  externalOrderNumber: string | null;
  externalOrderId: string;
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  vendorMembershipPlanId: string | null;
  buyerShippingServiceCode: string | null;
  marketplaceRawPayload: Record<string, unknown>;
  shipTo: DropshipOmsOrderShipToInput;
  wholesaleSubtotalCents: number;
  shippingCents: number;
  totalDebitCents: number;
  currency: string;
  warehouseId: number;
  orderedAt: Date;
  acceptedAt: Date;
  stagedForCanonicalAcceptance?: boolean;
  lines: readonly DropshipOmsOrderLineInput[];
}

export interface CreatedDropshipOmsOrderLine {
  id: string | number;
  product_variant_id: number;
  quantity: number;
}

export interface CreatedDropshipOmsOrder {
  omsOrderId: number;
  lines: CreatedDropshipOmsOrderLine[];
}

export type DropshipOmsOrderCommandErrorCode =
  | "OMS_DROPSHIP_ORDER_EXTERNAL_KEY_CONFLICT"
  | "OMS_DROPSHIP_ORDER_LINE_INSERT_FAILED"
  | "OMS_DROPSHIP_ORDER_STAGE_PROMOTION_FAILED"
  | "OMS_DROPSHIP_ORDER_INVALID_ID";

export class DropshipOmsOrderCommandError extends Error {
  constructor(
    readonly code: DropshipOmsOrderCommandErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DropshipOmsOrderCommandError";
  }
}

interface OmsOrderRow {
  id: string | number;
}

function toSafeOmsOrderId(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DropshipOmsOrderCommandError(
      "OMS_DROPSHIP_ORDER_INVALID_ID",
      "OMS order insert returned an invalid order id.",
      { value },
    );
  }
  return parsed;
}

export async function createDropshipOrderInTransaction(
  client: DropshipOmsOrderCommandClient,
  input: CreateDropshipOmsOrderInput,
): Promise<CreatedDropshipOmsOrder> {
  const omsState = input.stagedForCanonicalAcceptance
    ? "'pending', 'pending'"
    : "'confirmed', 'paid'";
  const result = await client.query<OmsOrderRow>(
    `INSERT INTO oms.oms_orders
      (channel_id, external_order_id, external_order_number, status,
       financial_status, fulfillment_status, customer_name, customer_email,
       customer_phone, ship_to_name, ship_to_address1, ship_to_address2,
       ship_to_city, ship_to_state, ship_to_zip, ship_to_country,
       subtotal_cents, shipping_cents, tax_cents, discount_cents, total_cents,
       currency, warehouse_id, raw_payload, notes, tags, ordered_at, created_at, updated_at)
     VALUES ($1, $2, $3, ${omsState},
       'unfulfilled', $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12, $13,
       $14, $15, 0, 0, $16,
       $17, $18, $19::jsonb, $20, $21, $22, $23, $23)
     ON CONFLICT (channel_id, external_order_id) DO NOTHING
     RETURNING id`,
    [
      input.channelId,
      input.omsExternalOrderId,
      input.externalOrderNumber ?? input.externalOrderId,
      input.shipTo.name,
      input.shipTo.email || null,
      input.shipTo.phone || null,
      input.shipTo.name,
      input.shipTo.address1,
      input.shipTo.address2 || null,
      input.shipTo.city,
      input.shipTo.region,
      input.shipTo.postalCode,
      input.shipTo.country,
      input.wholesaleSubtotalCents,
      input.shippingCents,
      input.totalDebitCents,
      input.currency,
      input.warehouseId,
      JSON.stringify({
        dropship: {
          intakeId: input.intakeId,
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          // On a Dropship order the Card Shellz member is the vendor, not the
          // marketplace buyer, so WMS sync scores pick priority from this plan
          // (decidePickPriorityPlanSource, server/modules/oms).
          vendorMembershipPlanId: input.vendorMembershipPlanId,
          externalOrderId: input.externalOrderId,
          ...(input.stagedForCanonicalAcceptance
            ? { acceptanceState: "inventory_claim_required" }
            : {}),
          // The service the buyer paid the marketplace for. Kept on the OMS
          // order (not only inside the marketplace blob) so fulfillment and
          // reconciliation can read it without parsing platform-specific
          // payloads. oms_orders has no migrated column for it, so raw_payload
          // is the durable home until a dedicated column ships.
          buyerShippingServiceCode: input.buyerShippingServiceCode,
        },
        marketplace: input.marketplaceRawPayload,
      }),
      `Dropship order intake ${input.intakeId}`,
      JSON.stringify(["dropship", `vendor:${input.vendorId}`, `store:${input.storeConnectionId}`]),
      input.orderedAt,
      input.acceptedAt,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new DropshipOmsOrderCommandError(
      "OMS_DROPSHIP_ORDER_EXTERNAL_KEY_CONFLICT",
      "Dropship OMS order external key already exists before intake acceptance.",
      {
        intakeId: input.intakeId,
        channelId: input.channelId,
        omsExternalOrderId: input.omsExternalOrderId,
      },
    );
  }
  const omsOrderId = toSafeOmsOrderId(row.id);
  await client.query(
    `INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
     VALUES ($1, 'created', $2::jsonb, $3)`,
    [
      omsOrderId,
      JSON.stringify({
        source: "dropship_order_acceptance",
        intakeId: input.intakeId,
        storeConnectionId: input.storeConnectionId,
      }),
      input.acceptedAt,
    ],
  );

  const lines: CreatedDropshipOmsOrderLine[] = [];
  for (const line of input.lines) {
    const lineResult = await client.query<CreatedDropshipOmsOrderLine>(
      `INSERT INTO oms.oms_order_lines
        (order_id, product_variant_id, external_line_item_id, external_product_id,
         sku, title, variant_title, quantity, paid_price_cents, total_price_cents,
         total_discount_cents, taxable, requires_shipping, fulfillable_quantity,
         fulfillment_provider, fulfillment_status, order_number, created_at, updated_at)
       VALUES ($1, $2, $3, $4,
         $5, $6, NULL, $7, $8, $9,
         0, true, true, $7,
         'dropship', 'unfulfilled', $10, $11, $11)
       RETURNING id, product_variant_id, quantity`,
      [
        omsOrderId,
        line.productVariantId,
        line.externalLineItemId,
        String(line.productId),
        line.sku,
        line.title,
        line.quantity,
        line.wholesaleUnitCostCents,
        line.wholesaleLineTotalCents,
        input.externalOrderNumber,
        input.acceptedAt,
      ],
    );
    const insertedLine = lineResult.rows[0];
    if (!insertedLine) {
      throw new DropshipOmsOrderCommandError(
        "OMS_DROPSHIP_ORDER_LINE_INSERT_FAILED",
        "OMS order line insert did not return a row.",
        { omsOrderId, productVariantId: line.productVariantId },
      );
    }
    lines.push(insertedLine);
  }

  return { omsOrderId, lines };
}

export async function confirmStagedDropshipOrderPaidInTransaction(
  client: DropshipOmsOrderCommandClient,
  input: {
    omsOrderId: number;
    acceptedAt: Date;
  },
): Promise<void> {
  const result = await client.query<{ id: string | number }>(
    `UPDATE oms.oms_orders
     SET status = 'confirmed',
         financial_status = 'paid',
         updated_at = $2
     WHERE id = $1
       AND status = 'pending'
       AND financial_status = 'pending'
     RETURNING id`,
    [input.omsOrderId, input.acceptedAt],
  );
  if (result.rows.length !== 1) {
    throw new DropshipOmsOrderCommandError(
      "OMS_DROPSHIP_ORDER_STAGE_PROMOTION_FAILED",
      "Canonical dropship acceptance could not promote its staged OMS order.",
      { omsOrderId: input.omsOrderId },
    );
  }
}
