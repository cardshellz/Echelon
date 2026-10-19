import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { poFinancialEvidenceIdSchema } from "@shared/procurement/po-financial-evidence";

const historySchema = z.object({
  hasInvoiceLinks: z.boolean(),
  hasInvoiceLines: z.boolean(),
}).strict();

export type PoInvoiceHistory = z.infer<typeof historySchema>;

/** The mutation caller holds the inventory graph lock and the PO row lock.
 * Include retained/voided and malformed-source relationships: an absent invoice
 * header must not make its surviving financial references disappear. */
export async function readPoInvoiceHistory(
  tx: { execute(query: SQL): Promise<{ rows: unknown[] }> },
  purchaseOrderId: number,
): Promise<PoInvoiceHistory> {
  const id = poFinancialEvidenceIdSchema.parse(purchaseOrderId);
  const result = await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM procurement.vendor_invoice_po_links
      WHERE purchase_order_id = ${id}
    ) AS "hasInvoiceLinks", EXISTS (
      SELECT 1 FROM procurement.vendor_invoice_lines invoice_line
      INNER JOIN procurement.purchase_order_lines po_line ON po_line.id = invoice_line.purchase_order_line_id
      WHERE po_line.purchase_order_id = ${id}
    ) AS "hasInvoiceLines"
  `);
  return historySchema.parse(result.rows[0]);
}

export function hasPoInvoiceHistory(history: PoInvoiceHistory): boolean {
  return history.hasInvoiceLinks || history.hasInvoiceLines;
}
