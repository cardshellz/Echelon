import { sql } from "drizzle-orm";
import { poLineAmountCents, type PoQuantityPreviewRequest } from "@shared/procurement/po-quantity-amendment";
import { preparePurchaseOrderLine, PurchaseOrderLineCommandError } from "./purchase-order-line-commands";
import { PoQuantityAmendmentError, type AmendmentHeader, type PreparedPoAddition } from "./po-quantity-amendment.policy";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import { costFingerprint, costInteger } from "../inventory/infrastructure/cost-evidence-values";

/** Never detach an actual receipt, invoice, movement or cost from its PO line.
 * Even voided/cancelled downstream records retain document provenance. */
export async function readPoLineRemovalBlocks(tx: AmendmentTransaction, lineIds: number[]): Promise<Record<number, string>> {
  if (!lineIds.length) return {};
  const result = await tx.execute(sql`SELECT l.id,
    EXISTS(SELECT 1 FROM procurement.inbound_shipment_lines s WHERE s.purchase_order_line_id=l.id) AS shipment,
    EXISTS(SELECT 1 FROM procurement.receiving_lines r WHERE r.purchase_order_line_id=l.id)
      OR EXISTS(SELECT 1 FROM procurement.po_receipts r WHERE r.purchase_order_line_id=l.id) AS receipt,
    EXISTS(SELECT 1 FROM procurement.vendor_invoice_lines i WHERE i.purchase_order_line_id=l.id) AS invoice,
    EXISTS(SELECT 1 FROM inventory.inventory_lots i WHERE i.po_line_id=l.id)
      OR EXISTS(SELECT 1 FROM procurement.landed_cost_snapshots s WHERE s.purchase_order_line_id=l.id)
      OR EXISTS(SELECT 1 FROM procurement.landed_cost_adjustments a WHERE a.purchase_order_line_id=l.id) AS inventory
    FROM procurement.purchase_order_lines l WHERE l.id=ANY(${sql.param(lineIds)}::int[]) ORDER BY l.id`);
  const blocks: Record<number, string> = {};
  for (const row of result.rows) {
    const dependencies = [row.shipment && "shipment lines", row.receipt && "receipts", row.invoice && "invoices", row.inventory && "inventory or posted costs"].filter(Boolean);
    if (dependencies.length) blocks[costInteger(row.id, "PO line", 1)] = `This line is linked to ${dependencies.join(", ")} and must retain that history. Correct its values here or reverse the actual transaction from its linked document.`;
  }
  return blocks;
}

export async function preparePoAdditions(tx: AmendmentTransaction, header: AmendmentHeader, firstLineNumber: number, request: PoQuantityPreviewRequest): Promise<PreparedPoAddition[]> {
  const prepared: PreparedPoAddition[] = [];
  for (const addition of request.additions ?? []) {
    try {
      const { clientKey, discountCents, taxCents, ...input } = addition;
      const source = await preparePurchaseOrderLine(tx, header, firstLineNumber + prepared.length, { ...input, pricingSource: "manual" });
      // Approval supplies its injected timestamp; the draft owner uses SQL time.
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...preparedValues } = source.values;
      const values = { ...preparedValues, discountCents, taxCents,
        lineTotalCents: poLineAmountCents(source.values.totalProductCostCents, addition.packagingCostCents, discountCents, taxCents) };
      prepared.push({ values, review: {
        clientKey, lineNumber: values.lineNumber, productId: addition.productId,
        name: values.productName, sku: values.sku, expectedReceiveVariantId: addition.expectedReceiveVariantId,
        expectedReceiveUnitsPerVariant: addition.expectedReceiveUnitsPerVariant, orderQty: values.orderQty,
        unitCostMills: values.unitCostMills, totalProductCostCents: values.totalProductCostCents,
        packagingCostCents: values.packagingCostCents, discountCents, taxCents, lineTotalCents: values.lineTotalCents,
        sourceFingerprint: costFingerprint(source.context),
      } });
    } catch (error) {
      if (error instanceof PurchaseOrderLineCommandError) throw new PoQuantityAmendmentError(error.message, String(error.details?.code ?? "PO_AMENDMENT_ADDITION_INVALID"), error.statusCode);
      throw error;
    }
  }
  return prepared;
}
