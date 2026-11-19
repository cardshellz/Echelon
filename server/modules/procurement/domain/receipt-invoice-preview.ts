import { receiptSegmentCost } from "@shared/procurement/receipt-cost-segments";
import { allocateIntegerCostInterval } from "@shared/utils/integer-cost-interval";
import type { ReceiptCostingReceipt } from "@shared/procurement/receipt-invoice-costs";
import { costInteger } from "../../inventory/infrastructure/cost-evidence-values";
import type { ReceiptInvoiceSource as PurchaseCostSource } from "./receipt-invoice-costs";
import { resolvePurchaseCostSource } from "./purchase-cost-source";

export function receiptInvoiceCostRows(
  source: PurchaseCostSource,
  receipts: ReceiptCostingReceipt[],
) {
  const selected = resolvePurchaseCostSource(source);
  return receipts.map((receipt) => {
    let total = BigInt(0),
      confirmed = receipt.pieces,
      known = true;
    for (const component of selected) {
      if (
        component.totalMills === null ||
        component.basePieces === null ||
        !["estimated", "confirmed"].includes(component.evidence)
      ) {
        known = false;
        confirmed = 0;
        continue;
      }
      if (component.receiptCostSegments) {
        const amount = receiptSegmentCost(
          component.receiptCostSegments,
          receipt.startBasePiece,
          receipt.pieces,
          receipt.receivingLineId,
        );
        total += BigInt(amount.totalMills);
        confirmed = Math.min(confirmed, amount.confirmedPieces);
      } else {
        total += allocateIntegerCostInterval(
          BigInt(component.totalMills),
          BigInt(component.basePieces),
          BigInt(receipt.startBasePiece),
          BigInt(receipt.pieces),
        );
        if (component.evidence !== "confirmed") confirmed = 0;
      }
    }
    return {
      ...receipt,
      confirmedPieces: confirmed,
      provisionalPieces: receipt.pieces - confirmed,
      supplierMills: known
        ? costInteger(total.toString(), "receipt supplier total")
        : null,
    };
  });
}
