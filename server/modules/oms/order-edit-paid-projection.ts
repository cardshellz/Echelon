import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { OrderEditSnapshot } from "../order-edits/application/order-edit-provider";
import {
  orderEditSnapshotSchema,
  orderEditQuoteSchema,
} from "../order-edits/application/order-edit-provider.schema";
import {
  matchesOrderEditQuote,
  isUnpaidRecoveryRestored,
} from "../order-edits/application/order-edit-evidence";
import { OrderEditError } from "../order-edits/domain/order-edit-error";
import { wmsOmsOrderIdSql } from "./oms-wms-order-link.sql";
import { buildOmsLineAuthorityEvent } from "./oms-line-authority-ledger";
import { appendOrderEditAudit } from "../order-edits/infrastructure/order-edit-audit.writer";

const integer = z.coerce.number().int().nonnegative().safe();
const positive = integer.refine((value) => value > 0);
const operationDocument = z.object({
  id: z.string().uuid(),
  omsOrderId: positive,
  connectionId: positive,
  actorId: z.string().min(1),
  status: z.enum(["synchronizing", "recovering"]),
  commitStartedAt: z.string().datetime(),
  recoveryStartedAt: z.string().datetime().nullable(),
  baseline: orderEditSnapshotSchema,
  quote: orderEditQuoteSchema,
  lastSnapshot: orderEditSnapshotSchema,
});
const headerSchema = z.object({
  id: positive,
  channel_id: positive,
  external_order_id: z.string(),
  currency: z.literal("USD"),
  cancelled_at: z.unknown().nullable(),
  status: z.string(),
  financial_status: z.string(),
  subtotal_cents: integer,
  gross_subtotal_cents: integer,
  shipping_cents: integer,
  tax_cents: integer,
  discount_cents: integer,
  total_cents: integer,
});
const lineSchema = z.object({
  id: positive,
  external_line_item_id: z.string(),
  product_variant_id: positive.nullable(),
  quantity: integer,
  channel_observed_quantity: integer,
  paid_quantity: integer,
  authority_fulfillable_quantity: integer,
  cancelled_quantity: integer,
  refunded_quantity: integer,
  authorization_status: z.string(),
  authorized_by_event_id: z.string().nullable(),
  paid_price_cents: integer,
  retail_price_cents: integer,
  total_price_cents: integer,
  total_discount_cents: integer,
  plan_discount_cents: integer,
  coupon_discount_cents: integer,
  fulfillable_quantity: integer.nullable(),
});
type Line = z.infer<typeof lineSchema>;
const binding = new PgDialect().sqlToQuery(
  wmsOmsOrderIdSql({
    source: sql.raw("wo.source"),
    omsFulfillmentOrderId: sql.raw("wo.oms_fulfillment_order_id"),
    legacySourceTableId: sql.raw("wo.source_table_id"),
  }),
).sql;
const numericId = (value: string) =>
  value.replace(/^gid:\/\/shopify\/[A-Za-z]+\//, "");
const TOPIC = "order-edit/paid";

/** OMS owns the paid-current projection; historical purchased quantity stays intact. */
export class OrderEditPaidProjection {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date,
  ) {}

  async project(
    omsOrderId: number,
    operationId: string,
    input: OrderEditSnapshot,
  ): Promise<void> {
    positive.parse(omsOrderId);
    z.string().uuid().parse(operationId);
    const snapshot = orderEditSnapshotSchema.parse(input);
    const now = z.date().parse(this.clock());
    if (
      !snapshot.fullyPaid ||
      snapshot.outstandingCents !== 0 ||
      snapshot.netPaidCents !== snapshot.totalCents ||
      snapshot.capturableCents !== 0 ||
      snapshot.cancelled ||
      snapshot.closed ||
      snapshot.transactions.some((tx) =>
        ["PENDING", "AWAITING_RESPONSE", "UNKNOWN"].includes(tx.status),
      ) ||
      snapshot.lines.some(
        (line) =>
          (line.quantity > 0 && line.unsupported) ||
          line.quantity !== line.unfulfilledQuantity,
      )
    ) {
      reject(
        "ORDER_EDIT_PAYMENT_REQUIRED",
        "Only a verified, settled, entirely unfulfilled edit can authorize warehouse quantities.",
      );
    }
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await this.projectLocked(client, omsOrderId, operationId, snapshot, now);
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  private async projectLocked(
    client: PoolClient,
    omsOrderId: number,
    operationId: string,
    snapshot: OrderEditSnapshot,
    now: Date,
  ) {
    const header = headerSchema.parse(
      (
        await client.query(
          `SELECT id,channel_id,external_order_id,currency,cancelled_at,
      status,financial_status,subtotal_cents,gross_subtotal_cents,shipping_cents,tax_cents,discount_cents,total_cents
      FROM oms.oms_orders WHERE id=$1 FOR UPDATE`,
          [omsOrderId],
        )
      ).rows[0],
    );
    if (
      header.channel_id !== snapshot.channelId ||
      numericId(header.external_order_id) !== numericId(snapshot.orderId) ||
      header.cancelled_at !== null ||
      ["cancelled", "closed"].includes(header.status)
    )
      reject(
        "ORDER_EDIT_SOURCE_CHANGED",
        "The current Shopify snapshot does not belong to this active source order.",
      );
    const orders = z
      .array(
        z.object({
          id: positive,
          channel_id: positive,
          order_edit_operation_id: z.string().uuid().nullable(),
          started_at: z.unknown().nullable(),
          assigned_picker_id: z.string().nullable(),
          picked_count: integer,
        }),
      )
      .parse(
        (
          await client.query(
            `SELECT wo.id,wo.channel_id,wo.order_edit_operation_id,wo.started_at,
      wo.assigned_picker_id,wo.picked_count FROM wms.orders wo WHERE ${binding}=$1 ORDER BY wo.id FOR UPDATE OF wo`,
            [omsOrderId],
          )
        ).rows,
      );
    if (
      orders.length === 0 ||
      orders.some(
        (order) =>
          order.channel_id !== snapshot.channelId ||
          order.order_edit_operation_id !== operationId ||
          order.started_at !== null ||
          order.assigned_picker_id !== null ||
          order.picked_count !== 0,
      )
    )
      reject(
        "ORDER_EDIT_HOLD_MISSING",
        "The edit must own every unpicked warehouse partition before authorizing quantities.",
      );
    const operationRow = (
      await client.query(
        `SELECT id,oms_order_id,connection_id,status,document
      FROM oms.order_edit_operations WHERE id=$1 FOR UPDATE`,
        [operationId],
      )
    ).rows[0];
    const document = operationDocument.parse(operationRow?.document);
    if (
      operationRow.id !== operationId ||
      Number(operationRow.oms_order_id) !== omsOrderId ||
      operationRow.connection_id !== snapshot.connectionId ||
      operationRow.status !== document.status ||
      document.id !== operationId ||
      document.omsOrderId !== omsOrderId ||
      document.connectionId !== snapshot.connectionId ||
      document.baseline.orderId !== snapshot.orderId ||
      document.baseline.channelId !== snapshot.channelId ||
      document.quote.operationId !== operationId ||
      document.quote.baselineFingerprint !== document.baseline.fingerprint ||
      document.lastSnapshot.fingerprint !== snapshot.fingerprint ||
      canonicalJson(document.lastSnapshot) !== canonicalJson(snapshot) ||
      (document.status === "synchronizing" &&
        !matchesOrderEditQuote(snapshot, document.quote)) ||
      (document.status === "recovering" &&
        (!document.recoveryStartedAt ||
          !isUnpaidRecoveryRestored(
            snapshot,
            document.baseline,
            document.quote,
          )))
    )
      reject(
        "ORDER_EDIT_PROJECTION_UNPROVEN",
        "The paid snapshot does not match this edit's persisted, verified financial phase.",
      );
    const previous = (
      await client.query(
        `SELECT operation_id,source_updated_at,fingerprint,snapshot FROM oms.order_edit_paid_projections
      WHERE oms_order_id=$1 FOR UPDATE`,
        [omsOrderId],
      )
    ).rows[0];
    // Shopify revisions may share a timestamp. A separately owned edit whose
    // immutable baseline equals our prior proof establishes causal succession.
    const causalSuccessor =
      previous &&
      previous.operation_id !== operationId &&
      previous.fingerprint === document.baseline.fingerprint;
    if (
      previous &&
      (new Date(previous.source_updated_at).getTime() >
        Date.parse(snapshot.updatedAt) ||
        (new Date(previous.source_updated_at).getTime() ===
          Date.parse(snapshot.updatedAt) &&
          previous.fingerprint !== snapshot.fingerprint &&
          !causalSuccessor))
    )
      reject(
        "ORDER_EDIT_PROJECTION_STALE",
        "A newer or conflicting paid order projection already exists.",
      );
    const lines = z.array(lineSchema).parse(
      (
        await client.query(
          `SELECT id,external_line_item_id,product_variant_id,quantity,
      channel_observed_quantity,paid_quantity,authority_fulfillable_quantity,cancelled_quantity,refunded_quantity,
      authorization_status,authorized_by_event_id,paid_price_cents,retail_price_cents,total_price_cents,total_discount_cents,plan_discount_cents,coupon_discount_cents,
      fulfillable_quantity FROM oms.oms_order_lines WHERE order_id=$1 ORDER BY id FOR UPDATE`,
          [omsOrderId],
        )
      ).rows,
    );
    const expected = new Map(
      snapshot.lines.map((line) => [numericId(line.id), line]),
    );
    if (
      expected.size !== snapshot.lines.length ||
      new Set(lines.map((line) => numericId(line.external_line_item_id)))
        .size !== lines.length ||
      lines.length !== expected.size
    )
      reject(
        "ORDER_EDIT_OMS_LINES_PENDING",
        "Waiting for the exact Shopify line identities to reach Echelon.",
      );
    const mappings = z
      .array(
        z.object({
          external_variant_id: z.string(),
          product_variant_id: positive,
        }),
      )
      .parse(
        (
          await client.query(
            `
      SELECT DISTINCT external_variant_id,product_variant_id FROM channels.channel_listings
      WHERE channel_id=$1 AND REPLACE(external_variant_id,'gid://shopify/ProductVariant/','')=ANY($2::text[])
      AND product_variant_id IS NOT NULL`,
            [
              snapshot.channelId,
              snapshot.lines
                .filter((line) => line.quantity > 0)
                .map((line) => numericId(line.variantId)),
            ],
          )
        ).rows,
      );
    for (const line of lines) {
      const target = expected.get(numericId(line.external_line_item_id));
      if (
        !target ||
        line.cancelled_quantity !== 0 ||
        line.refunded_quantity !== 0 ||
        line.quantity < target.quantity
      )
        reject(
          "ORDER_EDIT_OMS_LINES_PENDING",
          "The received line history or disposition conflicts with this paid edit.",
        );
      // Retired historical lines may no longer have an active catalog variant.
      // Their exact Shopify line identity and verified zero quantity are sufficient
      // to revoke authority; only positive demand requires a catalog mapping.
      if (target.quantity === 0) continue;
      const mapped = new Set(
        mappings
          .filter(
            (entry) =>
              numericId(entry.external_variant_id) ===
              numericId(target.variantId),
          )
          .map((entry) => entry.product_variant_id),
      );
      if (
        mapped.size !== 1 ||
        line.product_variant_id === null ||
        !mapped.has(line.product_variant_id)
      )
        reject(
          "ORDER_EDIT_CATALOG_PENDING",
          "A Shopify line's exact channel variant mapping is not verified.",
        );
    }
    const gross = cents(
      snapshot.lines.reduce(
        (total, line) =>
          total + BigInt(line.originalUnitPriceCents) * BigInt(line.quantity),
        BigInt(0),
      ),
    );
    const discount = cents(BigInt(gross) - BigInt(snapshot.subtotalCents));
    if (
      snapshot.lines.reduce(
        (total, line) => total + BigInt(line.totalCents),
        BigInt(0),
      ) !== BigInt(snapshot.subtotalCents) ||
      BigInt(snapshot.subtotalCents) +
        BigInt(snapshot.shippingCents) +
        BigInt(snapshot.taxCents) !==
        BigInt(snapshot.totalCents)
    )
      reject(
        "ORDER_EDIT_PROJECTION_TOTALS_INVALID",
        "The verified current line prices do not add up to the order total.",
      );
    const sourceEventId = `order-edit:${operationId}:${snapshot.fingerprint.slice(0, 16)}`;
    // The scoped database fence accepts only this validated operation's certified
    // writes; ordinary stale webhook replays cannot replace its paid authority.
    await client.query(
      "SELECT set_config('echelon.order_edit_projection_operation',$1,true)",
      [operationId],
    );
    let changed = false;
    for (const line of lines) {
      const target = expected.get(numericId(line.external_line_item_id))!;
      const lineDiscount = cents(
        BigInt(target.originalUnitPriceCents) * BigInt(target.quantity) -
          BigInt(target.totalCents),
      );
      // Preserve the existing normalizer's categories: accepted originals have
      // verified automatic discounts (coupon), while the provider applies new
      // member prices as manual line discounts (plan). Other promotions cannot
      // reach a verified quote in this pilot.
      const original = document.baseline.lines.some(
        (entry) => entry.id === target.id,
      );
      const planDiscount = original ? 0 : lineDiscount;
      const couponDiscount = original ? lineDiscount : 0;
      if (
        line.authorized_by_event_id === sourceEventId &&
        line.paid_quantity === target.quantity &&
        line.authority_fulfillable_quantity === target.quantity &&
        line.fulfillable_quantity === target.quantity &&
        line.paid_price_cents === target.discountedUnitPriceCents &&
        line.retail_price_cents === target.originalUnitPriceCents &&
        line.total_price_cents === target.totalCents &&
        line.total_discount_cents === lineDiscount &&
        line.plan_discount_cents === planDiscount &&
        line.coupon_discount_cents === couponDiscount
      )
        continue;
      await client.query(
        `UPDATE oms.oms_order_lines SET channel_observed_quantity=$2,paid_quantity=$2,
        authority_fulfillable_quantity=$2,fulfillable_quantity=$2,authorization_status='authorized',authorized_at=$3,
        authorized_by_event_id=$4,authority_source_topic=$5,authority_source_inbox_id=NULL,
        paid_price_cents=$6,retail_price_cents=$7,total_price_cents=$8,total_discount_cents=$9,
        plan_discount_cents=$10,coupon_discount_cents=$11,updated_at=$3 WHERE id=$1`,
        [
          line.id,
          target.quantity,
          now,
          sourceEventId,
          TOPIC,
          target.discountedUnitPriceCents,
          target.originalUnitPriceCents,
          target.totalCents,
          lineDiscount,
          planDiscount,
          couponDiscount,
        ],
      );
      await this.recordLine(
        client,
        omsOrderId,
        line,
        target.quantity,
        sourceEventId,
        now,
      );
      changed = true;
    }
    const financialStatus = snapshot.refunds.some(
      (refund) => refund.amountCents > 0,
    )
      ? "partially_refunded"
      : "paid";
    if (
      header.subtotal_cents !== snapshot.subtotalCents ||
      header.gross_subtotal_cents !== gross ||
      header.shipping_cents !== snapshot.shippingCents ||
      header.tax_cents !== snapshot.taxCents ||
      header.discount_cents !== discount ||
      header.total_cents !== snapshot.totalCents ||
      header.financial_status !== financialStatus
    ) {
      await client.query(
        `UPDATE oms.oms_orders SET subtotal_cents=$2,gross_subtotal_cents=$3,shipping_cents=$4,tax_cents=$5,
        discount_cents=$6,total_cents=$7,financial_status=$8,updated_at=$9 WHERE id=$1`,
        [
          omsOrderId,
          snapshot.subtotalCents,
          gross,
          snapshot.shippingCents,
          snapshot.taxCents,
          discount,
          snapshot.totalCents,
          financialStatus,
          now,
        ],
      );
      changed = true;
    }
    if (
      changed ||
      previous?.fingerprint !== snapshot.fingerprint ||
      previous?.operation_id !== operationId
    ) {
      const persistedHeader = (
        await client.query(
          `SELECT id,channel_id,external_order_id,currency,financial_status,
        subtotal_cents,gross_subtotal_cents,shipping_cents,tax_cents,discount_cents,total_cents,updated_at
        FROM oms.oms_orders WHERE id=$1`,
          [omsOrderId],
        )
      ).rows[0];
      const persistedLines = (
        await client.query(
          `SELECT id,external_line_item_id,product_variant_id,quantity,
        channel_observed_quantity,paid_quantity,authority_fulfillable_quantity,fulfillable_quantity,
        paid_price_cents,retail_price_cents,total_price_cents,total_discount_cents,plan_discount_cents,coupon_discount_cents,
        authority_source_topic,authorized_by_event_id,authorized_at,updated_at
        FROM oms.oms_order_lines WHERE order_id=$1 ORDER BY id`,
          [omsOrderId],
        )
      ).rows;
      // This ledger has database-enforced immutability. Capture actual locked DB
      // before/after values, not only the provider snapshot or service phase.
      await appendOrderEditAudit(client, {
        operationId,
        connectionId: snapshot.connectionId,
        actorId: document.actorId,
        action: "paid_current_projected",
        before: { header, lines },
        after: {
          snapshot,
          sourceEventId,
          sourceUpdatedAt: snapshot.updatedAt,
          header: persistedHeader,
          lines: persistedLines,
        },
        occurredAt: now,
      });
      await client.query(
        `INSERT INTO oms.oms_order_events(order_id,event_type,details,created_at) VALUES($1,'order_edit_paid_projected',$2,$3)`,
        [
          omsOrderId,
          JSON.stringify({
            operationId,
            actorId: document.actorId,
            sourceEventId,
            sourceUpdatedAt: snapshot.updatedAt,
            fingerprint: snapshot.fingerprint,
            before: { header, lines },
            after: snapshot,
          }),
          now,
        ],
      );
      await client.query(
        `INSERT INTO oms.order_edit_paid_projections(oms_order_id,operation_id,source_updated_at,fingerprint,snapshot,projected_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(oms_order_id) DO UPDATE SET operation_id=EXCLUDED.operation_id,
        source_updated_at=EXCLUDED.source_updated_at,fingerprint=EXCLUDED.fingerprint,snapshot=EXCLUDED.snapshot,projected_at=EXCLUDED.projected_at`,
        [
          omsOrderId,
          operationId,
          snapshot.updatedAt,
          snapshot.fingerprint,
          JSON.stringify(snapshot),
          now,
        ],
      );
    }
  }

  private async recordLine(
    client: PoolClient,
    orderId: number,
    line: Line,
    quantity: number,
    sourceEventId: string,
    now: Date,
  ) {
    const event = buildOmsLineAuthorityEvent({
      orderId,
      orderLineId: line.id,
      eventType: "line_updated",
      sourceEventId,
      previous: {
        channelObservedQuantity: line.channel_observed_quantity,
        paidQuantity: line.paid_quantity,
        authorityFulfillableQuantity: line.authority_fulfillable_quantity,
        authorizationStatus: line.authorization_status,
      },
      authority: {
        channelObservedQuantity: quantity,
        paidQuantity: quantity,
        authorityFulfillableQuantity: quantity,
        authorizationStatus: "authorized",
        authorizedAt: now,
        authorizedByEventId: sourceEventId,
        authoritySourceTopic: TOPIC,
        authoritySourceInboxId: null,
      },
    });
    await client.query(
      `INSERT INTO oms.oms_order_line_authority_events(event_key,event_type,order_id,order_line_id,source_topic,
      source_event_id,source_inbox_id,previous_channel_observed_quantity,previous_paid_quantity,previous_authority_fulfillable_quantity,
      previous_authorization_status,channel_observed_quantity,paid_quantity,authority_fulfillable_quantity,cancelled_quantity,
      refunded_quantity,authorization_status,authorized_at,authorized_by_event_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT(event_key) DO NOTHING`,
      [
        event.eventKey,
        event.eventType,
        event.orderId,
        event.orderLineId,
        event.sourceTopic,
        event.sourceEventId,
        event.sourceInboxId,
        event.previousChannelObservedQuantity,
        event.previousPaidQuantity,
        event.previousAuthorityFulfillableQuantity,
        event.previousAuthorizationStatus,
        event.channelObservedQuantity,
        event.paidQuantity,
        event.authorityFulfillableQuantity,
        event.cancelledQuantity,
        event.refundedQuantity,
        event.authorizationStatus,
        event.authorizedAt,
        event.authorizedByEventId,
        now,
      ],
    );
  }
}
function cents(value: bigint): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER))
    reject(
      "ORDER_EDIT_PROJECTION_TOTALS_INVALID",
      "A current order amount is outside the supported exact range.",
    );
  return Number(value);
}
function reject(code: string, message: string): never {
  throw new OrderEditError(code, message);
}
