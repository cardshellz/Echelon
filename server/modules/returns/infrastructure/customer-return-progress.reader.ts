import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  customerOrderProgressSchema,
  type CustomerOrderProgress,
} from "@shared/customer-account/order-progress";
import {
  customerAccountProgressScopeSchema,
  type CustomerAccountReturnProgressReader,
} from "../../customer-account/application/customer-account-progress.ports";
import {
  aggregateCustomerReturnCases,
  customerReturnCaseProgressFactsSchema,
} from "../domain/customer-return-progress";
import { returnLabelRecordSchema } from "../../shipping-engine/application/return-label-provider.port";
import { createCarrierTrackingProjectionReader } from "../../shipping/carrier-tracking-projection.repository";
import { presentCarrierPackageStatus } from "../../shipping/customer-delivery-progress";
import type { CanonicalCarrierTrackingStatus } from "../../shipping/carrier-tracking.domain";

const id = z.coerce.number().int().positive().safe();
const count = z.coerce.number().int().nonnegative().safe();
const caseRow = z
  .object({
    id,
    orderId: id,
    reference: z.string(),
    sourceEventType: z.string(),
    authorizationId: id.nullable(),
    authorizationNumber: z.string().nullable(),
    caseStatus: z.string(),
    approvalStatus: z.string(),
    logisticsStatus: z.string(),
    inspectionStatus: z.string(),
    customerRefundStatus: z.string(),
    refundAttemptStatus: z.string().nullable(),
    quantity: count,
    receivedQuantity: count,
  })
  .strict();
const parcelRow = z
  .object({
    orderId: id,
    authorizationId: id,
    id,
    labelStatus: z.string().nullable(),
    result: z.unknown(),
    shippingLabelId: id.nullable(),
    shippingLabelStatus: z.string().nullable(),
    shippingLabelDirection: z.string().nullable(),
  captureError:z.string().nullable(),
  })
  .strict();
const owned = `SELECT o.id FROM oms.oms_orders o
  JOIN jsonb_to_recordset($3::jsonb) AS expected("omsOrderId" bigint,"externalOrderId" text)
    ON expected."omsOrderId"=o.id AND replace(o.external_order_id,'gid://shopify/Order/','')=expected."externalOrderId"
  WHERE o.channel_id=$1 AND o.external_customer_id=$2`;

/** Reads accepted returns and canonical receipts/refund evidence only. A refund
 * webhook's legacy case is not a new physical return without actual receipt or
 * an explicit accepted return authorization. No eligibility/provider call runs. */
export class PostgresCustomerReturnProgressReader
  implements CustomerAccountReturnProgressReader
{
  constructor(private readonly pool: Pool) {}
  async read(
    raw: Parameters<CustomerAccountReturnProgressReader["read"]>[0],
    instant: Date,
  ) {
    const scope = customerAccountProgressScopeSchema.parse(raw),
      now = z.date().parse(instant);
    const output = new Map<
      number,
      Pick<CustomerOrderProgress, "returns" | "refunds">
    >();
    if (!scope.orders.length) return output;
    const args = [
      scope.channelId,
      scope.externalCustomerId,
      JSON.stringify(scope.orders),
    ];
    const cases = z
      .array(caseRow)
      .max(4000)
      .parse(
        (
          await this.pool.query(
            `WITH owned AS (${owned})
      SELECT rc.id,rc.oms_order_id AS "orderId",rc.case_number AS reference,rc.source_event_type AS "sourceEventType",
        a.id AS "authorizationId",a.authorization_number AS "authorizationNumber",
        rc.case_status AS "caseStatus",rc.approval_status AS "approvalStatus",rc.logistics_status AS "logisticsStatus",
        rc.inspection_status AS "inspectionStatus",rc.customer_refund_status AS "customerRefundStatus",
        refund.status AS "refundAttemptStatus",COALESCE(units.quantity,0)::text AS quantity,COALESCE(units.received,0)::text AS "receivedQuantity"
      FROM returns.return_cases rc JOIN owned o ON o.id=rc.oms_order_id
      LEFT JOIN returns.customer_return_case_links link ON link.case_id=rc.id
      LEFT JOIN returns.customer_return_authorizations a ON a.id=link.authorization_id AND a.oms_order_id=rc.oms_order_id AND a.channel_id=rc.channel_id
      LEFT JOIN LATERAL (SELECT sum(ci.quantity) AS quantity,sum(ri.received_qty) AS received
        FROM returns.return_case_items ci JOIN wms.return_items ri ON ri.id=ci.wms_return_item_id WHERE ci.return_case_id=rc.id) units ON true
      LEFT JOIN LATERAL (SELECT status FROM returns.return_case_customer_refunds WHERE return_case_id=rc.id AND channel_id=$1
        ORDER BY requested_at DESC,id DESC LIMIT 1) refund ON true
      WHERE rc.channel_id=$1 ORDER BY rc.oms_order_id,rc.id LIMIT 4001`,
            args,
          )
        ).rows,
      );
    const parcels = z
      .array(parcelRow)
      .max(4000)
      .parse(
        (
          await this.pool.query(
            `WITH owned AS (${owned})
      SELECT a.oms_order_id AS "orderId",a.id AS "authorizationId",p.id,t.status AS "labelStatus",t.result_snapshot AS result,
        l.id AS "shippingLabelId",l.label_status AS "shippingLabelStatus",l.label_direction AS "shippingLabelDirection",capture.last_error_code AS "captureError"
      FROM returns.customer_return_authorizations a JOIN owned o ON o.id=a.oms_order_id
      JOIN returns.customer_return_parcels p ON p.authorization_id=a.id
      LEFT JOIN LATERAL (SELECT id,status,result_snapshot FROM returns.customer_return_label_attempts WHERE parcel_id=p.id ORDER BY attempt_number DESC LIMIT 1) t ON true
      LEFT JOIN wms.shipping_provider_labels l ON l.provider='shipstation' AND l.provider_label_id=t.result_snapshot->>'labelId'
      LEFT JOIN wms.saved_label_status_jobs capture ON capture.source_kind='return' AND capture.source_id=t.id AND capture.provider_reference=t.result_snapshot->>'labelId'
      WHERE a.channel_id=$1 ORDER BY a.oms_order_id,a.id,p.id LIMIT 4001`,
            args,
          )
        ).rows,
      );
    const labelIds = [
      ...new Set(
        parcels.flatMap((p) =>
          p.shippingLabelId !== null &&
          p.shippingLabelDirection === "return" &&
          p.shippingLabelStatus === "active"
            ? [p.shippingLabelId]
            : [],
        ),
      ),
    ];
    const tracking = new Map<number, CanonicalCarrierTrackingStatus>();
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
        throw new Error("Return tracking exceeded its bounded parcel plan.");
      for (const parcel of result.packages)
        tracking.set(id.parse(parcel.providerLabelId), parcel.canonicalStatus);
    }
    const current = (await this.pool.query(owned, args)).rows;
    for (const expected of scope.orders) {
      if (!current.some((row) => id.parse(row.id) === expected.omsOrderId))
        continue;
      const ownCases = cases.filter((c) => c.orderId === expected.omsOrderId);
      const returns: CustomerOrderProgress["returns"] = [],
        refunds: CustomerOrderProgress["refunds"] = [];
      const groups = new Map<string, z.infer<typeof caseRow>[]>(),
        refundGroups = new Map<string, z.infer<typeof caseRow>[]>();
      for (const row of ownCases) {
        const key =
          row.authorizationId === null
            ? `case:${row.id}`
            : `authorization:${row.authorizationId}`;
        refundGroups.set(key, [...(refundGroups.get(key) ?? []), row]);
        if (
          row.sourceEventType === "refund" &&
          row.authorizationId === null &&
          row.receivedQuantity === 0
        )
          continue;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      for (const [key, rows] of groups) {
        const ownParcels =
          rows[0].authorizationId === null
            ? []
            : parcels.filter(
                (p) =>
                  p.authorizationId === rows[0].authorizationId &&
                  p.orderId === expected.omsOrderId,
              );
        const labels = ownParcels.map((p) => {
          const saved =
            p.labelStatus === "succeeded"
              ? returnLabelRecordSchema.parse(p.result)
              : null;
          return {
            key: `parcel:${p.id}`,
            trackingNumber: saved?.trackingNumber ?? null,
            status: presentCarrierPackageStatus(
              p.shippingLabelId !== null &&
                p.shippingLabelDirection === "return" &&
                p.shippingLabelStatus === "active"
                ? (tracking.get(p.shippingLabelId) ?? null)
                : null,
            ),
          };
        });
        const labelReady =
          ownParcels.length > 0 &&
          ownParcels.every(
            (p) =>
              p.labelStatus === "succeeded" && p.captureError !== "SAVED_LABEL_STATUS_VOID_TIME_UNAVAILABLE" &&
              !["voided", "superseded"].includes(p.shippingLabelStatus ?? ""),
          );
        const labelInvalid = ownParcels.some((p) =>
          ["voided", "superseded"].includes(p.shippingLabelStatus ?? "") || p.captureError === "SAVED_LABEL_STATUS_VOID_TIME_UNAVAILABLE",
        );
        const result = aggregateCustomerReturnCases(
          rows.map((row) =>
            customerReturnCaseProgressFactsSchema.parse({
              ...pickFacts(row),
              labelReady,
              labelInvalid,
            }),
          ),
          labels.map((p) => p.status),
        );
        returns.push({
          key,
          reference: rows[0].authorizationNumber ?? rows[0].reference,
          ...result,
          parcels: labels,
        });
      }
      for (const [key, rows] of refundGroups) {
        const refund = aggregateCustomerReturnCases(
          rows.map((row) =>
            customerReturnCaseProgressFactsSchema.parse({
              ...pickFacts(row),
              labelReady: false,
            }),
          ),
          [],
        ).refund;
        if (refund.code !== "not_started" && refund.code !== "not_required")
          refunds.push({
            key,
            reference: rows[0].authorizationNumber ?? rows[0].reference,
            status: refund,
          });
      }
      const checked = customerOrderProgressSchema.parse({
        delivery: null,
        packages: [],
        returns,
        refunds,
      });
      output.set(expected.omsOrderId, {
        returns: checked.returns,
        refunds: checked.refunds,
      });
    }
    return output;
  }
}
function pickFacts(row: z.infer<typeof caseRow>) {
  return {
    caseStatus: row.caseStatus,
    approvalStatus: row.approvalStatus,
    logisticsStatus: row.logisticsStatus,
    inspectionStatus: row.inspectionStatus,
    customerRefundStatus: row.customerRefundStatus,
    refundAttemptStatus: row.refundAttemptStatus,
    quantity: row.quantity,
    receivedQuantity: row.receivedQuantity,
  };
}
