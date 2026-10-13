import { invoiceQuantityIdSchema, type InvoiceQuantityPreview } from "@shared/procurement/invoice-quantity-correction";
import { parseExactMoneyInput } from "@/lib/exact-money-input";

type InvoiceLineDraft =
  | { valid: true; quantityPieces: number; unitCostMills: number; lineTotalCents: number; changed: boolean }
  | { valid: false; message: string };

/** Validate the editable draft before requesting a fresh server review. No money is rounded. */
export function invoiceLineDraft(
  values: { quantity: string; unitPrice: string; lineAmount: string },
  current: Pick<InvoiceQuantityPreview, "beforeQuantity" | "recordedUnitCostMills" | "invoiceLineAmountCents">,
): InvoiceLineDraft {
  const quantity = values.quantity.trim();
  const count = /^[1-9]\d*$/.test(quantity) ? invoiceQuantityIdSchema.safeParse(Number(quantity)) : null;
  if (!count?.success) return { valid: false, message: "Enter a positive whole number of pieces within the supported range." };
  let unitCostMills: number;
  let lineTotalCents: number;
  try { unitCostMills = parseExactMoneyInput(values.unitPrice, 4); }
  catch (error) { return { valid: false, message: `Unit price: ${error instanceof Error ? error.message : "Enter a valid amount."}` }; }
  try { lineTotalCents = parseExactMoneyInput(values.lineAmount, 2); }
  catch (error) { return { valid: false, message: `Line amount: ${error instanceof Error ? error.message : "Enter a valid amount."}` }; }
  return { valid: true, quantityPieces: count.data, unitCostMills, lineTotalCents,
    changed: count.data !== current.beforeQuantity || unitCostMills !== current.recordedUnitCostMills || lineTotalCents !== current.invoiceLineAmountCents };
}
