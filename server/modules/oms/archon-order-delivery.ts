import { ZodError } from "zod";
import type { Pool, PoolClient } from "pg";
import { commerceSnapshotSchema } from "../../../shared/archon-commerce-contract";
import { classifyCommerceOrigin } from "./archon-commerce-origin";
import { readStorefrontAcquisition } from "./archon-acquisition-contract";
import { extractMarketingConsent } from "./marketing-consent";
import {
  extractReconciledShopifyLines,
  extractShopifySalesFinancials,
} from "./archon-sales-financials";
import { extractShopifyDiscountEvidence } from "./archon-discount-evidence";
/** Read one consistent OMS snapshot. No calls to marketplaces or inventory writes. */
export async function loadArchonSnapshot(
  db: PoolClient,
  orderId: number,
  revision: string,
) {
  const result = await db.query("SELECT * FROM oms.oms_orders WHERE id=$1", [
    orderId,
  ]);
  const o = result.rows[0];
  if (!o) throw new Error("OMS_ORDER_MISSING");
  const channels = await db.query(
    "SELECT name,provider,shipping_config FROM channels.channels WHERE id=$1",
    [o.channel_id],
  );
  const c = channels.rows[0];
  if (!c) throw new Error("OMS_CHANNEL_MISSING");
  const origin = classifyCommerceOrigin(
    c.provider,
    c.shipping_config,
    o.raw_payload,
  );
  if (origin.connector === "unknown")
    throw new Error("OMS_CONNECTOR_UNSUPPORTED");
  const lines = await db.query(
    "SELECT * FROM oms.oms_order_lines WHERE order_id=$1 ORDER BY id",
    [orderId],
  );
  const raw = o.raw_payload?.order ?? o.raw_payload ?? {};
  const dropship = origin.connector === "dropship";
  const discountEvidence =
    origin.connector === "shopify"
      ? extractShopifyDiscountEvidence(o.raw_payload, o.currency)
      : undefined;
  const financials =
    origin.connector === "shopify"
      ? extractShopifySalesFinancials(
          o.raw_payload,
          discountEvidence,
          String(o.external_order_id),
          o.currency,
        )
      : undefined;
  // Archon receives one reconciled provider financial snapshot. This changes no
  // OMS order, inventory, payment, or fulfillment state. Refunds stay separate.
  if (financials && Number(o.refund_amount_cents) > financials.orderTotalCents)
    throw new Error("ARCHON_REFUND_EXCEEDS_PROVIDER_TOTAL");
  const payload = {
    event: "order.snapshot",
    revision,
    order: {
      echelon_order_id: Number(o.id),
      commerce_origin: origin,
      external_order_id: o.external_order_id,
      order_number: o.external_order_number,
      channel_id: Number(o.channel_id),
      channel_name: c.name,
      customer_email: dropship ? null : o.customer_email || null,
      customer_name: dropship ? null : o.customer_name,
      customer_phone: dropship ? null : o.customer_phone,
      external_customer_id: dropship ? null : o.external_customer_id,
      discount_codes: Array.isArray(raw.discount_codes)
        ? raw.discount_codes
        : undefined,
      tags: typeof o.tags === "string" ? o.tags : null,
      marketing_consent: dropship ? undefined : extractMarketingConsent(raw),
      marketing_attribution: dropship
        ? []
        : readStorefrontAcquisition(raw).touches,
      total_cents: financials?.orderTotalCents ?? Number(o.total_cents),
      subtotal_cents:
        financials?.netMerchandiseCents ?? Number(o.subtotal_cents),
      shipping_cents:
        financials?.grossShippingCents ?? Number(o.shipping_cents),
      tax_cents: financials
        ? financials.taxAddedCents + financials.taxIncludedCents
        : Number(o.tax_cents),
      discount_cents: financials
        ? financials.merchandiseDiscountCents + financials.shippingDiscountCents
        : Number(o.discount_cents),
      discount_evidence: discountEvidence
        ? { ...discountEvidence, ...(financials ? { financials } : {}) }
        : undefined,
      refund_cents: Number(o.refund_amount_cents),
      currency: o.currency,
      financial_status:
        o.status === "cancelled" ? "voided" : o.financial_status,
      fulfillment_status: o.fulfillment_status,
      ordered_at:
        o.ordered_at instanceof Date
          ? o.ordered_at.toISOString()
          : o.ordered_at,
      tracking_number: o.tracking_number,
      tracking_carrier: o.tracking_carrier,
      // Wholesale order totals must not be presented as partner retail line revenue.
      line_items: dropship
        ? []
        : financials
          ? extractReconciledShopifyLines(o.raw_payload, financials)
          : lines.rows.map((l) => ({
              sku: l.sku,
              title: l.title,
              quantity: l.quantity,
              price_cents: Number(l.retail_price_cents),
              discount_cents: Number(l.total_discount_cents),
              product_id: l.external_product_id,
              fulfillment_status: l.fulfillment_status,
            })),
    },
  };
  return commerceSnapshotSchema.parse(payload);
}
export function createArchonOrderDelivery(deps: {
  pool: Pool;
  clock: () => Date;
  leaseId: () => string;
  send: (payload: unknown) => Promise<void>;
  log: (code: string, orderId: number) => void;
}) {
  return async () => {
    for (let index = 0; index < 20; index++) {
      const now = deps.clock(),
        lease = deps.leaseId();
      const claimed = await deps.pool.query(
        `UPDATE oms.archon_order_outbox SET lease_id=$1,lease_until=$2,attempts=attempts+1 WHERE order_id=(
    SELECT order_id FROM oms.archon_order_outbox WHERE delivered_revision<revision AND next_attempt_at<=$3 AND (lease_until IS NULL OR lease_until<=$3)
    ORDER BY next_attempt_at,order_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING order_id,revision`,
        [lease, new Date(now.getTime() + 60000), now],
      );
      if (!claimed.rows.length) return;
      const { order_id: orderId, revision } = claimed.rows[0];
      try {
        const db = await deps.pool.connect();
        let payload;
        try {
          await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          payload = await loadArchonSnapshot(
            db,
            Number(orderId),
            String(revision),
          );
          await db.query("COMMIT");
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        } finally {
          db.release();
        }
        await deps.send(payload);
        await deps.pool.query(
          "UPDATE oms.archon_order_outbox SET delivered_revision=GREATEST(delivered_revision,$1),delivered_at=$2,lease_id=NULL,lease_until=NULL,last_error=NULL WHERE order_id=$3 AND lease_id=$4",
          [revision, deps.clock(), orderId, lease],
        );
      } catch (error) {
        const code =
          error instanceof ZodError
            ? "ARCHON_SNAPSHOT_INVALID"
            : error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
              ? error.message
              : "ARCHON_DELIVERY_FAILED";
        await deps.pool.query(
          "UPDATE oms.archon_order_outbox SET lease_id=NULL,lease_until=NULL,last_error=CASE WHEN revision=$5 THEN $1 ELSE last_error END,next_attempt_at=CASE WHEN revision=$5 THEN $2::timestamptz ELSE next_attempt_at END WHERE order_id=$3 AND lease_id=$4",
          [
            code,
            [
              "ARCHON_SNAPSHOT_INVALID",
              "ARCHON_IDENTITY_CONFLICT",
              "OMS_CONNECTOR_UNSUPPORTED",
              "OMS_CHANNEL_MISSING",
            ].includes(code)
              ? "infinity"
              : new Date(deps.clock().getTime() + 300000),
            orderId,
            lease,
            revision,
          ],
        );
        deps.log(code, Number(orderId));
      }
    }
  };
}
