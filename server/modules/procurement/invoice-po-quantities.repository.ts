import { and, asc, eq, exists, getTableColumns } from "drizzle-orm";
import { ZodError } from "zod";
import { buildInvoicePoQuantities, type InvoicePoQuantities } from "@shared/procurement/invoice-po-quantities";
import { purchaseOrderLines, vendorInvoiceLines, vendorInvoicePoLinks } from "@shared/schema";
import type { VendorInvoiceLine } from "@shared/schema/procurement.schema";
import { db } from "../../db";
import { logger } from "../../platform/observability/logger";

type InvoiceLineWithPoQuantities = VendorInvoiceLine & { poQuantities: InvoicePoQuantities };

/** One SQL snapshot supplies both comparison counts; reading never repairs invoice records. */
export async function getInvoiceLinesWithPoQuantities(invoiceId: number): Promise<InvoiceLineWithPoQuantities[]> {
  try {
    const rows = await db.select({
      invoiceLine: getTableColumns(vendorInvoiceLines),
      purchaseOrderLine: {
        id: purchaseOrderLines.id,
        purchaseOrderId: purchaseOrderLines.purchaseOrderId,
        orderQty: purchaseOrderLines.orderQty,
        receivedQty: purchaseOrderLines.receivedQty,
      },
    })
      .from(vendorInvoiceLines)
      .leftJoin(purchaseOrderLines, and(
        eq(purchaseOrderLines.id, vendorInvoiceLines.purchaseOrderLineId),
        exists(db.select({ id: vendorInvoicePoLinks.id }).from(vendorInvoicePoLinks).where(and(
          eq(vendorInvoicePoLinks.vendorInvoiceId, vendorInvoiceLines.vendorInvoiceId),
          eq(vendorInvoicePoLinks.purchaseOrderId, purchaseOrderLines.purchaseOrderId),
        ))),
      ))
      .where(eq(vendorInvoiceLines.vendorInvoiceId, invoiceId))
      .orderBy(asc(vendorInvoiceLines.lineNumber));

    return rows.map(({ invoiceLine, purchaseOrderLine }) => ({
      ...invoiceLine,
      poQuantities: buildInvoicePoQuantities(invoiceLine.purchaseOrderLineId, purchaseOrderLine),
    }));
  } catch (error) {
    logger.error("procurement.invoice_po_quantities_read", {
      outcome: "failed", invoice_id: invoiceId,
      error_code: error instanceof ZodError ? "AP_INVOICE_PO_QUANTITY_INVALID" : "AP_INVOICE_PO_QUANTITY_READ_FAILED",
      error_class: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}
