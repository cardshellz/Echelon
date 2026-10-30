import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  mergeDeliveryStatus,
  salesChannelDeliveryEvidenceSchema,
  type DatedDeliveryStatus,
} from "./sales-channel-delivery.domain";
import { normalizeTrackingNumber } from "./carrier-tracking.domain";
import { createCarrierTrackingProjectionReader } from "./carrier-tracking-projection.repository";
import { PostgresPackageHistoryStore } from "./package-history.repository";
import {
  presentCarrierPackageStatus,
  presentCustomerDelivery,
} from "./customer-delivery-progress";
import { wmsOmsOrderIdSql } from "../oms/oms-wms-order-link.sql";
import {
  customerAccountProgressScopeSchema,
  type CustomerAccountDeliveryProgressReader,
  type CustomerOrderDeliveryProgress,
} from "../customer-account/application/customer-account-progress.ports";

const id = z.coerce.number().int().positive().safe();
const orderRow = z
  .object({
    id,
    externalOrderId: z.string(),
    fulfillmentStatus: z.string().nullable(),
    remainingUnits: z.boolean(),
  })
  .strict();
const packageRow = z
  .object({
    orderId: id,
    key: z.string(),
    providerReference: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    labelId: id.nullable(),
  })
  .strict();
const binding = new PgDialect().sqlToQuery(
  wmsOmsOrderIdSql({
    source: sql.raw("wo.source"),
    omsFulfillmentOrderId: sql.raw("wo.oms_fulfillment_order_id"),
    legacySourceTableId: sql.raw("wo.source_table_id"),
  }),
).sql;
const owned = `SELECT o.id,replace(o.external_order_id,'gid://shopify/Order/','') AS "externalOrderId",
  o.fulfillment_status AS "fulfillmentStatus",EXISTS(
    SELECT 1 FROM wms.orders wo JOIN wms.order_items wi ON wi.order_id=wo.id
    WHERE (${binding}=o.id OR replace(wo.external_order_id,'gid://shopify/Order/','')=replace(o.external_order_id,'gid://shopify/Order/','')) AND wo.channel_id=$1 AND wo.warehouse_status<>'cancelled'
      AND wi.requires_shipping=1 AND wi.status<>'cancelled' AND wi.quantity>wi.fulfilled_quantity
  ) AS "remainingUnits" FROM oms.oms_orders o
  JOIN jsonb_to_recordset($3::jsonb) AS expected("omsOrderId" bigint,"externalOrderId" text)
    ON expected."omsOrderId"=o.id AND replace(o.external_order_id,'gid://shopify/Order/','')=expected."externalOrderId"
  WHERE o.channel_id=$1 AND o.external_customer_id=$2`;

/** Query-only adapter over exact outbound package bindings and shipping's
 * matched carrier projection. Return labels and tracking-only guesses cannot
 * complete original delivery. Verified package-history documents cover legacy
 * purchases without inventing native package rows. */
export class PostgresCustomerOrderDeliveryReader
  implements CustomerAccountDeliveryProgressReader
{
  constructor(private readonly pool: Pool) {}
  async read(
    raw: Parameters<CustomerAccountDeliveryProgressReader["read"]>[0],
    instant: Date,
  ) {
    const scope = customerAccountProgressScopeSchema.parse(raw),
      now = z.date().parse(instant);
    const output = new Map<number, CustomerOrderDeliveryProgress>();
    if (!scope.orders.length) return output;
    const parameters = [
      scope.channelId,
      scope.externalCustomerId,
      JSON.stringify(scope.orders),
    ];
    const orders = z
      .array(orderRow)
      .max(20)
      .parse((await this.pool.query(owned, parameters)).rows)
      .filter((order) =>
        scope.orders.some(
          (expected) =>
            expected.omsOrderId === order.id &&
            expected.externalOrderId === order.externalOrderId,
        ),
      );
    const native = z
      .array(packageRow)
      .max(4000)
      .parse(
        (
          await this.pool.query(
            `WITH owned AS (${owned}), packages AS (
      SELECT DISTINCT o.id AS order_id,'physical:'||p.id::text AS package_key,CASE WHEN p.provider='shipstation' THEN regexp_replace(p.provider_physical_shipment_id,'^shipstation_shipment:','') ELSE NULL END AS provider_reference,
        p.tracking_number,p.id AS physical_id,NULL::integer AS legacy_id
      FROM owned o JOIN wms.fulfillment_plans fp ON fp.oms_order_id=o.id
      JOIN wms.fulfillment_plan_lines fl ON fl.fulfillment_plan_id=fp.id
      JOIN wms.physical_shipment_items pi ON pi.fulfillment_plan_line_id=fl.id
      JOIN wms.physical_shipments p ON p.id=pi.physical_shipment_id AND p.status<>'voided'
      WHERE pi.shipment_item_purpose='customer_fulfillment'
      UNION
      SELECT DISTINCT o.id,'legacy:'||s.id::text,NULL,s.tracking_number,NULL::bigint,s.id
      FROM owned o JOIN wms.orders wo ON (${binding}=o.id OR replace(wo.external_order_id,'gid://shopify/Order/','')=o."externalOrderId") AND wo.channel_id=$1
      JOIN wms.outbound_shipments s ON s.order_id=wo.id AND s.status NOT IN ('voided','cancelled')
      WHERE NOT EXISTS(SELECT 1 FROM wms.outbound_shipment_items si JOIN wms.physical_shipment_items pi
        ON pi.legacy_wms_shipment_item_id=si.id WHERE si.shipment_id=s.id)
    ) SELECT p.order_id AS "orderId",p.package_key AS key,COALESCE(l.provider_label_id,p.provider_reference) AS "providerReference",
      COALESCE(l.tracking_number,p.tracking_number) AS "trackingNumber",l.id AS "labelId"
    FROM packages p LEFT JOIN wms.shipping_provider_label_links link
      ON (p.physical_id IS NOT NULL AND link.physical_shipment_id=p.physical_id)
      OR (p.legacy_id IS NOT NULL AND link.legacy_wms_shipment_id=p.legacy_id)
    LEFT JOIN wms.shipping_provider_labels l ON l.id=link.shipping_provider_label_id
      AND l.label_direction='outbound' AND l.label_status='active'
    ORDER BY p.order_id,p.package_key,l.id LIMIT 4001`,
            parameters,
          )
        ).rows,
      );
    const expected = new Map<number, Array<z.infer<typeof packageRow>>>();
    const history = new PostgresPackageHistoryStore(this.pool, () => now);
    const savedHistory = await history.readMany(
      orders.map((order) => ({
        omsOrderId: order.id,
        channelId: scope.channelId,
        externalOrderId: order.externalOrderId,
      })),
    );
    for (const order of orders) {
      const saved = savedHistory.get(order.id);
      const rows = native.filter((p) => p.orderId === order.id);
      for (const parcel of saved?.packages ?? []) {
        const matching = rows.filter(
          (p) =>
            p.providerReference === parcel.providerShipmentId &&
            p.trackingNumber !== null &&
            normalizeTrackingNumber(p.trackingNumber) ===
              normalizeTrackingNumber(parcel.trackingNumber),
        );
        for (const match of matching)
          if (match.providerReference === null)
            match.providerReference = parcel.providerShipmentId;
        if (!matching.length)
          rows.push({
            orderId: order.id,
            key: `history:${parcel.providerShipmentId}`,
            providerReference: parcel.providerShipmentId,
            trackingNumber: parcel.trackingNumber,
            labelId: null,
          });
      }
      expected.set(order.id, rows);
    }
    const historyReferences = [...expected.values()]
      .flat()
      .filter((p) => p.labelId === null && p.providerReference !== null)
      .map((p) => p.providerReference!);
    const historyLabels = historyReferences.length
      ? (
          await this.pool.query(
            `SELECT id,provider_label_id FROM wms.shipping_provider_labels
      WHERE provider='shipstation' AND label_direction='outbound' AND label_status='active' AND provider_label_id=ANY($1::text[])`,
            [historyReferences],
          )
        ).rows
      : [];
    for (const rows of expected.values())
      for (const parcel of rows) {
        if (parcel.labelId !== null || parcel.providerReference === null)
          continue;
        const matches = historyLabels.filter(
          (l) => l.provider_label_id === parcel.providerReference,
        );
        if (matches.length === 1) parcel.labelId = id.parse(matches[0].id);
      }
    const labelIds = [
      ...new Set(
        [...expected.values()]
          .flat()
          .flatMap((p) => (p.labelId === null ? [] : [p.labelId])),
      ),
    ];
    const statuses = new Map<number, DatedDeliveryStatus>();
    if (labelIds.length) {
      const result = await createCarrierTrackingProjectionReader(
        drizzle(this.pool),
      ).listChangedPackages({
        changedSince: null,
        observedThrough: now,
        after: null,
        limit: 4000,
        providerLabelIds: labelIds,
      });
      if (result.hasMore)
        throw new Error(
          "Delivery projection exceeded its bounded package plan.",
        );
      for (const parcel of result.packages)
        statuses.set(id.parse(parcel.providerLabelId), {
          status: parcel.canonicalStatus,
          occurredAt: parcel.eventOccurredAt,
        });
    }
    const evidenceBindings = [...savedHistory.values()].flatMap((history) =>
      history.packages.map((parcel) => ({
        orderId: history.omsOrderId,
        providerReference: parcel.providerShipmentId,
        trackingNumber: parcel.trackingNumber,
        fulfillmentId: parcel.fulfillmentId,
        nativeRevision: history.nativeRevision,
        providerObservationHash: parcel.providerObservationHash,
      })),
    );
    const channelStatuses = new Map<string, DatedDeliveryStatus>();
    const evidenceKey = (orderId: number, reference: string, number: string) =>
      `${orderId}:${reference}:${normalizeTrackingNumber(number)}`;
    if (evidenceBindings.length) {
      const evidence = await this.pool.query(
        `WITH owned AS (${owned})
        SELECT DISTINCT ON (e.oms_order_id,e.provider_reference,e.tracking_number) e.proof
        FROM wms.sales_channel_delivery_evidence e JOIN owned o ON o.id=e.oms_order_id AND o."externalOrderId"=e.external_order_id
        JOIN jsonb_to_recordset($4::jsonb) AS b("orderId" bigint,"providerReference" text,"trackingNumber" text,
          "fulfillmentId" text,"nativeRevision" text,"providerObservationHash" text)
          ON b."orderId"=e.oms_order_id AND b."providerReference"=e.provider_reference AND b."trackingNumber"=e.tracking_number
          AND b."fulfillmentId"=e.fulfillment_id AND b."nativeRevision"=e.native_revision AND b."providerObservationHash"=e.provider_observation_hash
        WHERE e.channel_id=$1 AND e.occurred_at<=$5 AND e.observed_at<=$5
        ORDER BY e.oms_order_id,e.provider_reference,e.tracking_number,e.occurred_at DESC,
          CASE WHEN e.canonical_status IN ('exception','delivery_attempt') THEN 0 WHEN e.canonical_status='delivered' THEN 1 ELSE 2 END,e.id DESC LIMIT 4001`,
        [...parameters, JSON.stringify(evidenceBindings), now],
      );
      const rows = z
        .array(z.object({ proof: salesChannelDeliveryEvidenceSchema }))
        .max(4000)
        .parse(evidence.rows);
      for (const { proof } of rows)
        channelStatuses.set(
          evidenceKey(
            proof.omsOrderId,
            proof.providerReference,
            proof.trackingNumber,
          ),
          {
            status: proof.canonicalStatus,
            occurredAt: new Date(proof.occurredAt),
          },
        );
    }
    // Recheck owner identity after asynchronous reads; a reassigned purchase is
    // never exposed using a grant from the beginning of the request.
    const current = z
      .array(orderRow)
      .max(20)
      .parse((await this.pool.query(owned, parameters)).rows);
    for (const order of orders) {
      if (
        !current.some(
          (row) =>
            row.id === order.id &&
            row.externalOrderId === order.externalOrderId,
        )
      )
        continue;
      const grouped = new Map<string, z.infer<typeof packageRow>[]>();
      for (const parcel of expected.get(order.id) ?? [])
        grouped.set(parcel.key, [...(grouped.get(parcel.key) ?? []), parcel]);
      const packages = [...grouped].map(([key, candidates]) => {
        const unique = [
          ...new Set(
            candidates.flatMap((c) => (c.labelId === null ? [] : [c.labelId])),
          ),
        ];
        const candidate =
          unique.length === 1
            ? candidates.find((c) => c.labelId === unique[0])!
            : unique.length === 0 &&
                new Set(
                  candidates.map(
                    (c) => `${c.providerReference}:${c.trackingNumber}`,
                  ),
                ).size === 1
              ? candidates[0]
              : null;
        const channel =
          candidate?.providerReference && candidate.trackingNumber
            ? (channelStatuses.get(
                evidenceKey(
                  order.id,
                  candidate.providerReference,
                  candidate.trackingNumber,
                ),
              ) ?? null)
            : null;
        return {
          key,
          trackingNumber:
            unique.length === 1
              ? candidates.find((candidate) => candidate.labelId === unique[0])!
                  .trackingNumber
              : new Set(candidates.map((candidate) => candidate.trackingNumber))
                    .size === 1
                ? candidates[0].trackingNumber
                : null,
          status: presentCarrierPackageStatus(
            mergeDeliveryStatus(
              unique.length === 1 ? (statuses.get(unique[0]) ?? null) : null,
              channel,
            ),
          ),
        };
      });
      if (packages.length > 200)
        throw new Error("Delivery package limit exceeded.");
      output.set(order.id, {
        packages,
        delivery: presentCustomerDelivery(
          packages.map((p) => p.status),
          current.find((row) => row.id === order.id)!.fulfillmentStatus ===
            "fulfilled" &&
            !current.find((row) => row.id === order.id)!.remainingUnits,
        ),
      });
    }
    return output;
  }
}
