import { sql } from "drizzle-orm";
import type { AutoDraftPoAgingRow } from "./auto-draft-po-aging.service";

type DbWithExecute = {
  execute: (query: any) => Promise<{ rows: unknown[] }>;
};

export async function fetchAutoDraftPoAgingRows(
  db: DbWithExecute,
  options: { scanLimit?: number } = {},
): Promise<AutoDraftPoAgingRow[]> {
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
      po.auto_draft_date AS "autoDraftDate",
      po.order_date AS "orderDate",
      po.approved_at AS "approvedAt",
      po.sent_to_vendor_at AS "sentToVendorAt",
      po.expected_delivery_date AS "expectedDeliveryDate",
      po.confirmed_delivery_date AS "confirmedDeliveryDate",
      po.actual_delivery_date AS "actualDeliveryDate",
      po.first_shipped_at AS "firstShippedAt",
      po.first_arrived_at AS "firstArrivedAt",
      po.first_invoiced_at AS "firstInvoicedAt",
      po.first_paid_at AS "firstPaidAt",
      po.fully_paid_at AS "fullyPaidAt",
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
    WHERE po.source = 'auto_draft'
      AND COALESCE(po.status, 'draft') <> 'cancelled'
      AND COALESCE(po.physical_status, 'draft') <> 'cancelled'
      AND NOT (
        COALESCE(po.status, 'draft') = 'closed'
        AND COALESCE(po.physical_status, 'draft') IN ('received', 'short_closed')
        AND COALESCE(po.financial_status, 'unbilled') = 'paid'
      )
    ORDER BY COALESCE(po.updated_at, po.created_at) DESC
    LIMIT ${sql.raw(String(scanLimit))}
  `);

  return result.rows as AutoDraftPoAgingRow[];
}
