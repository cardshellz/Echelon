import { z } from "zod";
import { supplierReturnDetailSchema, supplierReturnStockPreviewLineSchema, supplierReturnStockReceiptSchema, type SupplierReturnDetail } from "./supplier-return";
/** A physical collection is evidence of stock and value leaving custody. It is
 * neither a new cost revision, a supplier credit, nor an external journal. */
export const supplierReturnReportSchema = z.object({
    contractVersion: z.literal(1), eventType: z.literal("inventory.supplier_return_recorded"),
    currency: z.literal("USD"), returnId: z.number().int().positive().safe(),
    vendorId: z.number().int().positive().safe(), returnCalendarDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    evidenceReference: z.string().min(1), reason: z.string().min(3),
    actorId: z.string().min(1), recordedAt: z.string().datetime({ offset: true }),
    receipt: supplierReturnStockReceiptSchema,
    lines: z.array(z.object({ returnLineId: z.number().int().positive().safe(), source: supplierReturnStockPreviewLineSchema }).strict()).min(1).max(100),
}).strict().superRefine((event, context) => {
    if (event.receipt.returnId !== event.returnId || event.receipt.actorId !== event.actorId
        || event.receipt.occurredAt !== event.recordedAt || event.receipt.lines.length !== event.lines.length
        || new Set(event.lines.map(line => line.returnLineId)).size !== event.lines.length) {
        context.addIssue({ code: "custom", message: "Physical return report and immutable stock receipt disagree." });
    }
    for (const line of event.lines) {
        const receipt = event.receipt.lines.find(row => row.returnLineId === line.returnLineId);
        if (!receipt || receipt.inventoryLotId !== line.source.inventoryLotId || receipt.quantity !== line.source.quantity
            || receipt.productVariantId !== line.source.productVariantId || receipt.warehouseLocationId !== line.source.warehouseLocationId
            || line.source.sourceProof.origin.vendorId !== event.vendorId) {
            context.addIssue({ code: "custom", message: "Physical return report source does not match its stock movement." });
        }
    }
});
export type SupplierReturnReport = z.infer<typeof supplierReturnReportSchema>;
export function createSupplierReturnReport(raw: SupplierReturnDetail): SupplierReturnReport {
    const document = supplierReturnDetailSchema.parse(raw);
    return supplierReturnReportSchema.parse({ contractVersion: 1, eventType: "inventory.supplier_return_recorded", currency: "USD",
        returnId: document.id, vendorId: document.vendorId, returnCalendarDate: document.returnCalendarDate,
        evidenceReference: document.evidenceReference, reason: document.reason, actorId: document.recordedBy, recordedAt: document.recordedAt,
        receipt: document.inventoryReceipt, lines: document.lines.map(line => ({ returnLineId: line.id, source: line.source })) });
}
