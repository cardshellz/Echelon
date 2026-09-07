import { exactMoneyAsInput, parseExactMoneyInput } from "./exact-money-input";
import { rfqQuoteEvidenceSchema, type RfqQuoteEvidence } from "@shared/procurement/rfq-workflow";

export type RfqQuoteForm = {
  basis: "per_piece" | "per_purchase_uom" | "extended_total";
  quantity: string;
  amount: string;
  purchaseUom: string;
  piecesPerUom: string;
  packagingTreatment: "separate" | "included_in_product" | "unknown";
  packagingAmount: string;
  quoteReference: string;
  quoteDate: string;
  quoteValidUntil: string;
  leadTimeDays: string;
  reason: string;
};

function positiveInteger(raw: string, name: string): number {
  if (!/^[1-9]\d*$/.test(raw.trim())) throw new Error(`${name} must be a positive whole number.`);
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result > 2_147_483_647) throw new Error(`${name} exceeds the supported limit.`);
  return result;
}

export function parseRfqMoney(raw: string, precision: 2 | 4): number {
  return parseExactMoneyInput(raw, precision);
}

export function rfqMoneyAsInput(value: number, precision: 2 | 4): string {
  if (value < 0) throw new Error("Recorded quote amount is invalid.");
  return exactMoneyAsInput(value, precision);
}
export function rfqQuoteFromForm(form: RfqQuoteForm): RfqQuoteEvidence {
  const quantity = positiveInteger(form.quantity, "Quantity");
  const pricing = form.basis === "per_purchase_uom"
    ? { basis: form.basis, purchaseUom: form.purchaseUom.trim(), uomQuantity: quantity, piecesPerUom: positiveInteger(form.piecesPerUom, "Pieces per purchase unit"), quotedCostMillsPerUom: parseRfqMoney(form.amount, 4) }
    : form.basis === "extended_total"
      ? { basis: form.basis, quantityPieces: quantity, quotedTotalCents: parseRfqMoney(form.amount, 2) }
      : { basis: form.basis, quantityPieces: quantity, unitCostMills: parseRfqMoney(form.amount, 4) };
  let leadTimeDays: number | null = null;
  if (form.leadTimeDays.trim()) {
    if (!/^\d+$/.test(form.leadTimeDays.trim())) throw new Error("Lead time must be a nonnegative whole number of days.");
    leadTimeDays = Number(form.leadTimeDays);
  }
  return rfqQuoteEvidenceSchema.parse({
    pricing, packagingTreatment: form.packagingTreatment,
    packagingCostCents: form.packagingTreatment === "separate" ? parseRfqMoney(form.packagingAmount, 2) : null,
    quoteReference: form.quoteReference.trim(), quoteValidUntil: form.quoteValidUntil || null,
    quotedAt: `${form.quoteDate}T00:00:00.000Z`, leadTimeDays, reason: form.reason.trim(),
  });
}

export function rfqQuoteFormFromEvidence(quote: RfqQuoteEvidence | null, requestedPieces: number, today: string): RfqQuoteForm {
  const pricing = quote?.pricing;
  return {
    basis: pricing?.basis ?? "per_piece",
    quantity: String(pricing?.basis === "per_purchase_uom" ? pricing.uomQuantity : pricing?.quantityPieces ?? requestedPieces),
    amount: pricing ? pricing.basis === "extended_total" ? rfqMoneyAsInput(pricing.quotedTotalCents, 2) : rfqMoneyAsInput(pricing.basis === "per_piece" ? pricing.unitCostMills : pricing.quotedCostMillsPerUom, 4) : "",
    purchaseUom: pricing?.basis === "per_purchase_uom" ? pricing.purchaseUom : "",
    piecesPerUom: pricing?.basis === "per_purchase_uom" ? String(pricing.piecesPerUom) : "",
    packagingTreatment: quote?.packagingTreatment ?? "unknown",
    packagingAmount: quote?.packagingCostCents == null ? "" : rfqMoneyAsInput(quote.packagingCostCents, 2),
    quoteReference: quote?.quoteReference ?? "", quoteDate: quote?.quotedAt.slice(0, 10) ?? today,
    quoteValidUntil: quote?.quoteValidUntil ?? "", leadTimeDays: quote?.leadTimeDays == null ? "" : String(quote.leadTimeDays), reason: "",
  };
}
