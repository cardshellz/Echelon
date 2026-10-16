import { sql } from "drizzle-orm";
import { z } from "zod";
import { reconciliationReportSchema } from "@shared/procurement/cost-reconciliation";
import { costInteger, type CostEvidenceTransaction } from "./cost-evidence.repository";

/** Balances include the full ledger; the activity list is deliberately bounded. */
export async function readCostReconciliationReport(tx: CostEvidenceTransaction) {
  const rows = await tx.execute(sql`WITH balances AS (
      SELECT destination,SUM(delta_mills)::text AS amount FROM inventory.cost_reconciliation_postings GROUP BY destination
    ), activity AS (
      SELECT p.*,a.actor_name,a.reason,l.inbound_shipment_id,l.sku,po.id AS purchase_order_id,po.po_number
      FROM inventory.cost_reconciliation_postings p JOIN inventory.cost_reconciliation_approvals a ON a.id=p.approval_id
      JOIN procurement.inbound_shipment_lines l ON l.id=p.inbound_shipment_line_id
      JOIN procurement.purchase_order_lines pol ON pol.id=l.purchase_order_line_id
      JOIN procurement.purchase_orders po ON po.id=pol.purchase_order_id ORDER BY p.id DESC LIMIT 101
    ) SELECT (SELECT amount FROM balances WHERE destination='historical_cogs') AS historical_cogs,
      (SELECT amount FROM balances WHERE destination='inventory_variance') AS inventory_variance,
      COALESCE((SELECT jsonb_agg(to_jsonb(activity) ORDER BY id DESC) FROM activity),'[]'::jsonb) AS activity`);
  const result = rows.rows[0];
  if (!result) throw new Error("Reconciliation report returned invalid evidence");
  const activity = z.array(z.record(z.unknown())).parse(result.activity);
  return reconciliationReportSchema.parse({
    currency: "USD",
    balances: {
      historical_cogs: costInteger(result.historical_cogs ?? 0, "historicalCogs"),
      inventory_variance: costInteger(result.inventory_variance ?? 0, "inventoryVariance"),
    },
    truncated: activity.length > 100,
    entries: activity
      .slice(0, 100)
      .map((row) => ({
        id: costInteger(row.id, "postingId", 1),
        lineId: costInteger(row.inbound_shipment_line_id, "lineId", 1),
        shipmentId: costInteger(row.inbound_shipment_id, "shipmentId", 1),
        purchaseOrderId: costInteger(row.purchase_order_id, "purchaseOrderId", 1),
        poNumber: row.po_number,
        sku: row.sku,
        destination: row.destination,
        beforeMills: costInteger(row.before_mills, "before"),
        afterMills: costInteger(row.after_mills, "after"),
        deltaMills: costInteger(row.delta_mills, "delta", -Number.MAX_SAFE_INTEGER),
        actorName: row.actor_name,
        reason: row.reason,
        recordedAt: new Date(z.string().datetime({ offset: true }).parse(row.recorded_at)).toISOString(),
      })),
  });
}
