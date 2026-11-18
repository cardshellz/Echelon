import {
  invoiceCostComponentEvidenceSchema, invoiceCostReviewSchema, type InvoiceCostReview,
} from "@shared/procurement/invoice-cost-review";
import { exactMoneyAsInput, parseExactMoneyInput } from "./exact-money-input";
import type { InvoiceCostAdjustment } from "@shared/procurement/invoice-cost-adjustments";

export type InvoiceCostReviewForm = {
  packagingTreatment: "" | "separate" | "included_in_product" | "combined";
  product: string;
  packaging: string;
  adjustment: string;
  reason: string;
  adjustments?: Array<Omit<InvoiceCostAdjustment, "amountMills"> & { amount: string }>;
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
    ...(parsed.data.adjustments === undefined ? {} : { adjustments: parsed.data.adjustments.map(({ amountMills, ...row }) => ({ ...row, amount: exactMoneyAsInput(amountMills, 4) })) }),
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
    ...(form.adjustments === undefined ? {} : { adjustments: form.adjustments.map(({ amount: input, ...row }) => ({ ...row, amountMills: amount(input, row.label || "Billed adjustment", true) })) }),
  };
}

export function invoiceCostComponentsFromForm(form: InvoiceCostReviewForm, lineTotalCents: number): Pick<InvoiceCostReview, "packagingTreatment" | "productMills" | "packagingMills" | "adjustmentMills" | "adjustments"> {
  if (!Number.isSafeInteger(lineTotalCents)) throw new Error("The recorded invoice total cannot be reviewed safely.");
  if (!form.packagingTreatment) throw new Error("Select the packaging treatment from the supplier evidence.");
  const amounts = invoiceCostReviewAmounts(form);
  if (form.packagingTreatment !== "separate" && amounts.packagingMills !== 0) {
    throw new Error("Packaging included in product must have a separate packaging amount of zero.");
  }
  if (BigInt(amounts.productMills) + BigInt(amounts.packagingMills) + BigInt(amounts.adjustmentMills) !== BigInt(lineTotalCents) * BigInt(100)) {
    throw new Error("Product, packaging and adjustments must equal the recorded invoice line total exactly.");
  }
  return { packagingTreatment: form.packagingTreatment, ...amounts };
}

export function invoiceCostReviewFromForm(form: InvoiceCostReviewForm, expectedVersion: string, lineTotalCents: number): InvoiceCostReview {
  const amounts = invoiceCostComponentsFromForm(form, lineTotalCents);
  if (!form.reason.trim()) throw new Error("Enter a reason or reference for this cost review.");
  return invoiceCostReviewSchema.parse({ expectedVersion, ...amounts, reason: form.reason.trim() });
}
