import { sql } from "drizzle-orm";
import type { InFlightPoAgingRow } from "./in-flight-po-aging.service";

type DbWithExecute = {
  execute: (query: any) => Promise<{ rows: unknown[] }>;
};

export async function fetchInFlightPoAgingRows(
  db: DbWithExecute,
  options: { scanLimit?: number } = {},
): Promise<InFlightPoAgingRow[]> {
  const scanLimit = Math.max(1, Math.min(1000, Number(options.scanLimit ?? 500) || 500));
  const result = await db.execute(sql`
    SELECT
      po.id,
      po.po_number AS "poNumber",
      po.vendor_id AS "vendorId",
      v.name AS "vendorName",
      po.status,
      po.physical_status AS "physicalStatus",
      po.financial_status AS "financialStatus",
      po.line_count AS "lineCount",
      po.total_cents AS "totalCents",
      po.source,
      po.order_date AS "orderDate",
      po.sent_to_vendor_at AS "sentToVendorAt",
      po.expected_delivery_date AS "expectedDeliveryDate",
      po.confirmed_delivery_date AS "confirmedDeliveryDate",
      po.actual_delivery_date AS "actualDeliveryDate",
      po.first_shipped_at AS "firstShippedAt",
      po.first_arrived_at AS "firstArrivedAt",
      receiving_activity.latest_receiving_activity_at AS "latestReceivingActivityAt",
      receiving_activity.active_receiving_order_id AS "activeReceivingOrderId",
      receiving_activity.active_receipt_number AS "activeReceiptNumber",
      receiving_activity.active_receipt_status AS "activeReceiptStatus",
      po.created_at AS "createdAt",
      po.updated_at AS "updatedAt",
      COALESCE(open_exceptions.open_exception_count, 0)::int AS "openExceptionCount"
    FROM procurement.purchase_orders po
    LEFT JOIN procurement.vendors v ON v.id = po.vendor_id
    LEFT JOIN (
      SELECT po_id, COUNT(*)::int AS open_exception_count
      FROM procurement.po_exceptions
      WHERE status IN ('open', 'acknowledged')
      GROUP BY po_id
    ) open_exceptions ON open_exceptions.po_id = po.id
    LEFT JOIN (
      SELECT
        ro.purchase_order_id,
        MAX(
          GREATEST(
            ro.created_at,
            ro.updated_at,
            COALESCE(ro.received_date, ro.created_at),
            COALESCE(ro.closed_date, ro.created_at)
          )
        ) FILTER (WHERE ro.status <> 'cancelled') AS latest_receiving_activity_at,
        (
          ARRAY_AGG(ro.id ORDER BY ro.updated_at DESC, ro.id DESC)
          FILTER (WHERE ro.status IN ('draft', 'open', 'receiving', 'verified'))
        )[1] AS active_receiving_order_id,
        (
          ARRAY_AGG(ro.receipt_number ORDER BY ro.updated_at DESC, ro.id DESC)
          FILTER (WHERE ro.status IN ('draft', 'open', 'receiving', 'verified'))
        )[1] AS active_receipt_number,
        (
          ARRAY_AGG(ro.status ORDER BY ro.updated_at DESC, ro.id DESC)
          FILTER (WHERE ro.status IN ('draft', 'open', 'receiving', 'verified'))
        )[1] AS active_receipt_status
      FROM procurement.receiving_orders ro
      WHERE ro.purchase_order_id IS NOT NULL
      GROUP BY ro.purchase_order_id
    ) receiving_activity ON receiving_activity.purchase_order_id = po.id
    WHERE COALESCE(po.source, 'manual') <> 'auto_draft'
      AND COALESCE(po.status, 'draft') NOT IN ('draft', 'pending_approval', 'received', 'closed', 'cancelled')
      AND (
        COALESCE(po.physical_status, 'draft') IN ('sent', 'acknowledged', 'shipped', 'in_transit', 'arrived', 'receiving')
        OR COALESCE(po.status, 'draft') IN ('sent', 'acknowledged', 'partially_received')
      )
      AND COALESCE(po.physical_status, 'draft') NOT IN ('received', 'short_closed', 'cancelled')
    ORDER BY COALESCE(po.confirmed_delivery_date, po.expected_delivery_date, po.sent_to_vendor_at, po.order_date, po.updated_at, po.created_at) ASC
    LIMIT ${sql.raw(String(scanLimit))}
  `);

  return result.rows as InFlightPoAgingRow[];
}
