import { z } from "zod";
import { readIntegerCents, readIntegerMills } from "@shared/money-read";
import { purchaseTaxEvidenceSchema, type PurchaseTaxEvidence } from "@shared/procurement/purchase-tax";
import { allocateCentsFromNumericBasis } from "./shipment-allocation-basis";

export class PurchaseTaxError extends Error {
  constructor(message: string, readonly code = "PURCHASE_TAX_REVIEW_REQUIRED", readonly statusCode = 409) {
    super(message); this.name = "PurchaseTaxError";
  }
}

/** Match the existing purchasing correction owners' monotonic version time.
 * The injected clock can lag a stored update on another process. */
export function purchaseTaxApprovalTime(clock: Date, versions: readonly unknown[]): Date {
  let latest = z.date().parse(clock).getTime();
  for (const value of versions) {
    if (value == null) continue;
    const date = z.union([z.date(), z.string().min(1)]).pipe(z.coerce.date()).parse(value);
    latest = Math.max(latest, date.getTime() + 1);
  }
  return z.date().parse(new Date(latest));
}

export function purchaseTaxAmounts(value: unknown) {
  const rows = z.array(purchaseTaxEvidenceSchema).max(1000).parse(value);
  const total = (treatment?: PurchaseTaxEvidence["treatment"]) => readIntegerMills(rows
    .filter(row => treatment === undefined || row.treatment === treatment)
    .reduce((sum, row) => sum + BigInt(row.amountMills), BigInt(0)), "tax amount");
  return { taxMills: total(), inventoryMills: total("inventory"), recoverableMills: total("recoverable"), unclassifiedMills: total("unclassified") };
}

/** Header/unparented PO tax follows net goods value. The existing exact largest-
 * remainder allocator conserves cents and breaks ties by stable line identity. */
export function allocatePurchaseTax(amountCents: number, lines: readonly { id: number; goodsCents: number }[]) {
  readIntegerCents(amountCents, "PO tax");
  if (!lines.length && amountCents !== 0) throw new PurchaseTaxError("Tax has no product lines to receive its cost.", "PURCHASE_TAX_ALLOCATION_REQUIRED");
  const weights = lines.map(line => ({ lineId: z.number().int().positive().parse(line.id), basis: readIntegerCents(line.goodsCents, "tax allocation goods value") }));
  if (new Set(weights.map(row => row.lineId)).size !== weights.length) throw new PurchaseTaxError("Tax allocation requires unique product lines.", "PURCHASE_TAX_ALLOCATION_REQUIRED");
  if (amountCents === 0) return weights.map(row => ({ lineId: row.lineId, amountMills: 0 }));
  if (amountCents !== 0 && weights.every(row => row.basis === 0)) throw new PurchaseTaxError("Tax cannot be allocated by value when all product values are zero.", "PURCHASE_TAX_ALLOCATION_REQUIRED");
  return allocateCentsFromNumericBasis(amountCents, weights).map(row => ({ lineId: row.lineId, amountMills: readIntegerMills(BigInt(row.allocatedCents) * BigInt(100), "allocated tax") }));
}

export function purchaseTaxEvidence(value: unknown): PurchaseTaxEvidence[] {
  return value === undefined ? [] : z.array(purchaseTaxEvidenceSchema).max(1000).parse(value);
}

export function taxTreatmentIssue(rows: readonly PurchaseTaxEvidence[]) {
  return rows.some(row => row.amountMills !== 0 && row.treatment === "unclassified")
    ? { code: "PURCHASE_TAX_TYPE_REQUIRED", message: "Choose the saved tax type on this purchase so its tax can be included in inventory or recorded separately." } : null;
}
