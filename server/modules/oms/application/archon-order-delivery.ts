import { readIntegerCents } from "@shared/money-read";
import { ZodError } from "zod";
import type { Pool, PoolClient } from "pg";
import {
  commerceSnapshotSchema,
  type ArchonOrderCostEvidence,
} from "../../../../shared/archon-commerce-contract";
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
  if (financials && readIntegerCents(o.refund_amount_cents, "refund amount", true) > financials.orderTotalCents)
    throw new Error("ARCHON_REFUND_EXCEEDS_PROVIDER_TOTAL");

  // Read recorded FIFO COGS (product + packaging + landed, net of unpicks & sellable returns)
  // and outbound carrier shipping cost when WMS/COGS tables exist in this database.
  const costInfo = await loadOptionalArchonOrderCosts(db, Number(o.id), String(o.currency ?? ""));

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
      total_cents: financials?.orderTotalCents ?? readIntegerCents(o.total_cents, "total", true),
      subtotal_cents:
        financials?.netMerchandiseCents ?? readIntegerCents(o.subtotal_cents, "subtotal", true),
      shipping_cents:
        financials?.grossShippingCents ?? readIntegerCents(o.shipping_cents, "shipping", true),
      tax_cents: financials
        ? financials.taxAddedCents + financials.taxIncludedCents
        : readIntegerCents(o.tax_cents, "tax", true),
      discount_cents: financials
        ? financials.merchandiseDiscountCents + financials.shippingDiscountCents
        : readIntegerCents(o.discount_cents, "discount", true),
      discount_evidence: discountEvidence
        ? { ...discountEvidence, ...(financials ? { financials } : {}) }
        : undefined,
      refund_cents: readIntegerCents(o.refund_amount_cents, "refund", true),
      ...(costInfo?.cogsCents !== undefined ? { cogs_cents: costInfo.cogsCents } : {}),
      ...(costInfo?.cogsMills !== undefined ? { cogs_mills: costInfo.cogsMills } : {}),
      ...(costInfo?.carrierCostCents !== undefined ? { carrier_cost_cents: costInfo.carrierCostCents } : {}),
      ...(costInfo?.costEvidence !== undefined ? { cost_evidence: costInfo.costEvidence } : {}),
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
              price_cents: readIntegerCents(l.retail_price_cents, "price", true),
              discount_cents: readIntegerCents(l.total_discount_cents, "discount", true),
              product_id: l.external_product_id,
              fulfillment_status: l.fulfillment_status,
            })),
    },
  };
  return commerceSnapshotSchema.parse(payload);
}

async function loadOptionalArchonOrderCosts(
  db: PoolClient,
  omsOrderId: number,
  currency: string,
): Promise<{
  cogsCents?: number;
  cogsMills?: string;
  carrierCostCents?: number;
  costEvidence?: ArchonOrderCostEvidence;
} | undefined> {
  // Inventory costs and carrier costs are denominated in USD; never mix into foreign-currency snapshots.
  if (currency !== "USD") return undefined;
  const reg = await db.query(
    `SELECT
       to_regclass('wms.orders') IS NOT NULL AS has_wms,
       to_regclass('oms.order_item_costs') IS NOT NULL AS has_cogs,
       to_regclass('inventory.inventory_lots') IS NOT NULL AS has_lots,
       to_regclass('wms.outbound_shipments') IS NOT NULL AS has_shipments,
       to_regclass('inventory.return_cost_allocations') IS NOT NULL AS has_returns,
       to_regclass('inventory.inventory_transactions') IS NOT NULL AS has_tx`,
  );
  const flags = reg.rows?.[0];
  if (!flags?.has_wms) return undefined;

  let cogsCents: number | undefined;
  let cogsMills: string | undefined;
  let costEvidence: ArchonOrderCostEvidence | undefined;
  let carrierCostCents: number | undefined;

  if (flags.has_shipments) {
    const shipRes = await db.query(
      `SELECT
         (COUNT(*) FILTER (WHERE os.carrier_cost_cents IS NOT NULL) > 0) AS has_carrier_records,
         COALESCE(SUM(os.carrier_cost_cents) FILTER (WHERE os.carrier_cost_cents IS NOT NULL), 0)::bigint AS carrier_cost_cents
       FROM wms.outbound_shipments os
       JOIN wms.orders wo ON wo.id = os.order_id
       WHERE (
         (wo.source = 'oms' AND wo.oms_fulfillment_order_id ~ '^[0-9]{1,9}$' AND wo.oms_fulfillment_order_id::bigint = $1)
         OR (wo.source <> 'oms' AND wo.source_table_id ~ '^[0-9]{1,9}$' AND wo.source_table_id::bigint = $1)
       )
       AND COALESCE(os.status, '') NOT IN ('cancelled', 'voided')`,
      [omsOrderId],
    );
    const shipRow = shipRes.rows?.[0];
    if (Boolean(shipRow?.has_carrier_records)) {
      const parsedCarrier = readIntegerCents(shipRow.carrier_cost_cents, "carrier cost", true);
      if (parsedCarrier >= 0 && parsedCarrier <= 2147483647) {
        carrierCostCents = parsedCarrier;
      }
    }
  }

  if (flags.has_cogs) {
    const lotJoin = flags.has_lots
      ? "LEFT JOIN inventory.inventory_lots il ON il.id = oic.inventory_lot_id"
      : "";
    const provisionalExpr = flags.has_lots
      ? "COUNT(DISTINCT oic.inventory_lot_id) FILTER (WHERE COALESCE(il.cost_provisional, 0) = 1 AND oic.qty > 0)::int"
      : "0::int";
    const cogsRes = await db.query(
      `SELECT
         COUNT(*)::int AS row_count,
         COALESCE(SUM(COALESCE(NULLIF(oic.total_cost_mills, 0), oic.total_cost_cents::bigint * 100, 0)), 0)::text AS total_mills,
         COALESCE(SUM(COALESCE(oic.product_total_cost_mills,
           CASE WHEN oic.qty <> 0 THEN oic.qty::bigint * COALESCE(${flags.has_lots ? "il.po_unit_cost_mills" : "NULL"}, oic.unit_cost_mills, oic.unit_cost_cents::bigint * 100) ELSE 0 END
         )), 0)::text AS product_mills,
         COALESCE(SUM(COALESCE(oic.packaging_total_cost_mills,
           CASE WHEN oic.qty <> 0 THEN oic.qty::bigint * COALESCE(${flags.has_lots ? "il.packaging_cost_mills" : "0"}, 0) ELSE 0 END
         )), 0)::text AS packaging_mills,
         COALESCE(SUM(COALESCE(oic.landed_total_cost_mills,
           CASE WHEN oic.qty <> 0 THEN oic.qty::bigint * COALESCE(${flags.has_lots ? "il.landed_cost_mills" : "0"}, 0) ELSE 0 END
         )), 0)::text AS landed_mills,
         ${provisionalExpr} AS provisional_lots
       FROM oms.order_item_costs oic
       JOIN wms.orders wo ON wo.id = oic.order_id
       ${lotJoin}
       WHERE (
         (wo.source = 'oms' AND wo.oms_fulfillment_order_id ~ '^[0-9]{1,9}$' AND wo.oms_fulfillment_order_id::bigint = $1)
         OR (wo.source <> 'oms' AND wo.source_table_id ~ '^[0-9]{1,9}$' AND wo.source_table_id::bigint = $1)
       )`,
      [omsOrderId],
    );
    const cogsRow = cogsRes.rows?.[0];
    if (Number(cogsRow?.row_count ?? 0) > 0) {
      let totalMills = BigInt(String(cogsRow.total_mills ?? "0"));
      let productMills = BigInt(String(cogsRow.product_mills ?? "0"));
      let packagingMills = BigInt(String(cogsRow.packaging_mills ?? "0"));
      let landedMills = BigInt(String(cogsRow.landed_mills ?? "0"));

      if (flags.has_returns && flags.has_lots) {
        const retRes = await db.query(
          `SELECT
             COALESCE(SUM(rca.quantity::bigint * COALESCE(rlot.po_unit_cost_mills, 0)), 0)::text AS ret_po_mills,
             COALESCE(SUM(rca.quantity::bigint * COALESCE(rlot.packaging_cost_mills, 0)), 0)::text AS ret_pkg_mills,
             COALESCE(SUM(rca.quantity::bigint * COALESCE(rlot.landed_cost_mills, 0)), 0)::text AS ret_landed_mills,
             COALESCE(SUM(
               COALESCE(
                 CASE WHEN rlot.cost_basis_qty IS NOT NULL AND rlot.cost_basis_qty = rca.quantity
                   THEN COALESCE(rlot.product_total_cost_mills, 0) + COALESCE(rlot.packaging_total_cost_mills, 0) + COALESCE(rlot.landed_total_cost_mills, 0)
                   ELSE NULL END,
                 rca.quantity::bigint * COALESCE(rlot.total_unit_cost_mills, rlot.unit_cost_mills, COALESCE(rlot.unit_cost_cents, 0)::bigint * 100)
               )
             ), 0)::text AS ret_total_mills
           FROM inventory.return_cost_allocations rca
           JOIN inventory.inventory_lots rlot ON rlot.id = rca.returned_lot_id
           JOIN wms.orders wo ON wo.id = rca.wms_order_id
           WHERE (
             (wo.source = 'oms' AND wo.oms_fulfillment_order_id ~ '^[0-9]{1,9}$' AND wo.oms_fulfillment_order_id::bigint = $1)
             OR (wo.source <> 'oms' AND wo.source_table_id ~ '^[0-9]{1,9}$' AND wo.source_table_id::bigint = $1)
           )
           AND rca.source_order_item_cost_id IS NOT NULL
           AND (
             $2::boolean = FALSE
             OR NOT EXISTS (
               SELECT 1 FROM inventory.inventory_transactions qtx
               WHERE qtx.inventory_lot_id = rca.returned_lot_id
                 AND (qtx.reference_type = 'return_quarantine' OR (qtx.transaction_type = 'return' AND qtx.target_state IN ('damaged', 'defective')))
             )
           )`,
          [omsOrderId, Boolean(flags.has_tx)],
        );
        const retRow = retRes.rows?.[0];
        totalMills -= BigInt(String(retRow?.ret_total_mills ?? "0"));
        productMills -= BigInt(String(retRow?.ret_po_mills ?? "0"));
        packagingMills -= BigInt(String(retRow?.ret_pkg_mills ?? "0"));
        landedMills -= BigInt(String(retRow?.ret_landed_mills ?? "0"));
      }

      if (totalMills < BigInt(0)) totalMills = BigInt(0);
      if (productMills < BigInt(0)) productMills = BigInt(0);
      if (packagingMills < BigInt(0)) packagingMills = BigInt(0);
      if (landedMills < BigInt(0)) landedMills = BigInt(0);

      const roundedCentsBig = (totalMills + BigInt(50)) / BigInt(100);
      if (roundedCentsBig <= BigInt(2147483647)) {
        cogsCents = readIntegerCents(roundedCentsBig, "order cogs cents");
        cogsMills = totalMills.toString();
        costEvidence = {
          version: 1,
          total_cogs_mills: cogsMills,
          total_cogs_cents: cogsCents,
          product_cost_mills: productMills.toString(),
          packaging_cost_mills: packagingMills.toString(),
          landed_cost_mills: landedMills.toString(),
          provisional_lot_count: Math.max(0, Number(cogsRow.provisional_lots ?? 0)),
          carrier_cost_cents: carrierCostCents ?? null,
        };
      }
    }
  }

  if (cogsCents === undefined && carrierCostCents === undefined) {
    return undefined;
  }
  return { cogsCents, cogsMills, carrierCostCents, costEvidence };
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
