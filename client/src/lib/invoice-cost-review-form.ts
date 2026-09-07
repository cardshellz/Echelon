import {
  invoiceCostComponentEvidenceSchema, invoiceCostReviewSchema, type InvoiceCostReview,
} from "@shared/procurement/invoice-cost-review";
import { exactMoneyAsInput, parseExactMoneyInput } from "./exact-money-input";

export type InvoiceCostReviewForm = {
  packagingTreatment: "" | "separate" | "included_in_product";
  product: string;
  packaging: string;
  adjustment: string;
  reason: string;
};

export function invoiceCostReviewForm(evidence: unknown): InvoiceCostReviewForm {
  const parsed = invoiceCostComponentEvidenceSchema.safeParse(evidence);
  if (!parsed.success) return { packagingTreatment: "", product: "", packaging: "", adjustment: "", reason: "" };
  return {
    packagingTreatment: parsed.data.packagingTreatment,
    product: exactMoneyAsInput(parsed.data.productMills, 4),
    packaging: exactMoneyAsInput(parsed.data.packagingMills, 4),
    adjustment: exactMoneyAsInput(parsed.data.adjustmentMills, 4),
    reason: "",
  };
}

export function invoiceCostReviewAmounts(form: InvoiceCostReviewForm) {
  function amount(value: string, label: string, signed = false): number {
    try { return parseExactMoneyInput(value, 4, signed); }
    catch (error) { throw new Error(`${label}: ${error instanceof Error ? error.message : "Invalid amount."}`); }
  }
  return {
    productMills: amount(form.product, "Product"),
    packagingMills: amount(form.packaging, "Packaging"),
    adjustmentMills: amount(form.adjustment, "Adjustments", true),
  };
}

export function invoiceCostReviewFromForm(form: InvoiceCostReviewForm, expectedVersion: string, lineTotalCents: number): InvoiceCostReview {
  if (!Number.isSafeInteger(lineTotalCents)) throw new Error("The recorded invoice total cannot be reviewed safely.");
  if (!form.packagingTreatment) throw new Error("Select the packaging treatment from the supplier evidence.");
  if (!form.reason.trim()) throw new Error("Enter a reason or reference for this cost review.");
  const amounts = invoiceCostReviewAmounts(form);
  if (form.packagingTreatment === "included_in_product" && amounts.packagingMills !== 0) {
    throw new Error("Packaging included in product must have a separate packaging amount of zero.");
  }
  if (BigInt(amounts.productMills) + BigInt(amounts.packagingMills) + BigInt(amounts.adjustmentMills) !== BigInt(lineTotalCents) * BigInt(100)) {
    throw new Error("Product, packaging and adjustments must equal the recorded invoice line total exactly.");
  }
  return invoiceCostReviewSchema.parse({ expectedVersion, packagingTreatment: form.packagingTreatment, ...amounts, reason: form.reason.trim() });
}
