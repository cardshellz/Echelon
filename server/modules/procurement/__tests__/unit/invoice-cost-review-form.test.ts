import { describe, expect, it } from "vitest";
import { invoiceCostComponentEvidenceSchema, invoiceCostReviewResultSchema, invoiceCostReviewSchema } from "@shared/procurement/invoice-cost-review";
import { exactMoneyAsInput, parseExactMoneyInput } from "../../../../../client/src/lib/exact-money-input";
import { invoiceCostReviewForm, invoiceCostReviewFromForm } from "../../../../../client/src/lib/invoice-cost-review-form";

const version = "a".repeat(64);
const evidence = { contractVersion: 1, packagingTreatment: "separate", productMills: 1_000_000, packagingMills: 180_000, adjustmentMills: 0, source: "operator_review" };

describe("exact invoice cost review form", () => {
  it.each([null, undefined, {}, { ...evidence, productMills: null }, { ...evidence, packagingTreatment: "unknown" }])("keeps unresolved evidence blank: %j", (value) => {
    expect(invoiceCostReviewForm(value)).toEqual({ packagingTreatment: "", product: "", packaging: "", adjustment: "", reason: "" });
  });
  it("prefills only validated recorded component amounts", () => {
    expect(invoiceCostReviewForm(evidence)).toEqual({ packagingTreatment: "separate", product: "100.0000", packaging: "18.0000", adjustment: "0.0000", reason: "" });
  });
  it.each([
    [".0375", 375], ["0.0001", 1], ["-0.0001", -1], ["-55", -550_000],
    ["900719925474.0991", Number.MAX_SAFE_INTEGER], ["-900719925474.0991", -Number.MAX_SAFE_INTEGER],
  ])("parses %s exactly", (text, result) => {
    expect(parseExactMoneyInput(String(text), 4, true)).toBe(result);
    expect(parseExactMoneyInput(exactMoneyAsInput(Number(result), 4), 4, true)).toBe(result);
  });
  it.each(["", " ", "1e3", "1,000", "$2.00", "Infinity", "NaN", "0.00001", "1.", "900719925474.0992", "-900719925474.0992"])("rejects ambiguous or overflowing decimal input %s", (text) => {
    expect(() => parseExactMoneyInput(text, 4, true)).toThrow();
  });
  it("rejects negative product and packaging costs without clamping credits", () => {
    expect(() => parseExactMoneyInput("-1", 4)).toThrow();
    expect(() => invoiceCostReviewFromForm({ ...invoiceCostReviewForm(evidence), product: "-1", reason: "Credit" }, version, 11800)).toThrow(/Product/);
  });
  it("preserves signed adjustments and requires an exact document total", () => {
    const form = { ...invoiceCostReviewForm(evidence), adjustment: "-1.0000", reason: "Supplier credit on this line" };
    expect(invoiceCostReviewFromForm(form, version, 11700)).toEqual({ expectedVersion: version, packagingTreatment: "separate", productMills: 1_000_000, packagingMills: 180_000, adjustmentMills: -10_000, reason: form.reason });
    expect(() => invoiceCostReviewFromForm(form, version, 11800)).toThrow(/exactly/);
  });
  it("balances sub-cent components without rounding", () => {
    const form = { packagingTreatment: "separate" as const, product: "0.0375", packaging: "0.0025", adjustment: "0", reason: "Exact supplier evidence" };
    expect(invoiceCostReviewFromForm(form, version, 4)).toMatchObject({ productMills: 375, packagingMills: 25, adjustmentMills: 0 });
    expect(() => invoiceCostReviewFromForm({ ...form, packaging: "0.0024" }, version, 4)).toThrow(/exactly/);
  });
  it("requires explicit zero evidence, packaging treatment and a review reason", () => {
    const form = { ...invoiceCostReviewForm(evidence), reason: "Reviewed" };
    expect(() => invoiceCostReviewFromForm({ ...form, packagingTreatment: "" }, version, 11800)).toThrow(/packaging treatment/);
    expect(() => invoiceCostReviewFromForm({ ...form, adjustment: "" }, version, 11800)).toThrow(/Adjustments/);
    expect(() => invoiceCostReviewFromForm({ ...form, reason: " " }, version, 11800)).toThrow(/reason/);
    expect(() => invoiceCostReviewFromForm({ ...form, packagingTreatment: "included_in_product" }, version, 11800)).toThrow(/zero/);
  });
  it("retains zero and signed credit document totals", () => {
    const form = { packagingTreatment: "separate" as const, product: "0", packaging: "0", adjustment: "0", reason: "Zero confirmed" };
    expect(invoiceCostReviewFromForm(form, version, 0)).toMatchObject({ productMills: 0, packagingMills: 0 });
    expect(invoiceCostReviewFromForm({ ...form, adjustment: "-55" }, version, -5500)).toMatchObject({ adjustmentMills: -550000 });
  });
  it("rejects unrepresentable recorded totals", () => {
    expect(() => invoiceCostReviewFromForm({ ...invoiceCostReviewForm(evidence), reason: "Review" }, version, Number.MAX_SAFE_INTEGER + 1)).toThrow(/safely/);
  });
});

describe("invoice cost review boundary contracts", () => {
  it.each([null, "1000000", false, 1.5, Number.MAX_SAFE_INTEGER + 1])("does not coerce economic input %j", (productMills) => {
    expect(invoiceCostReviewSchema.safeParse({ expectedVersion: version, packagingTreatment: "separate", productMills, packagingMills: 0, adjustmentMills: 0, reason: "Reviewed" }).success).toBe(false);
  });
  it("rejects included packaging with a second packaging amount in stored evidence", () => {
    expect(invoiceCostComponentEvidenceSchema.safeParse({ ...evidence, packagingTreatment: "included_in_product" }).success).toBe(false);
  });
  it("requires a versioned response before the UI claims a saved review", () => {
    expect(invoiceCostReviewResultSchema.safeParse({ id: 72, costComponentEvidence: evidence, application: null }).success).toBe(false);
    expect(invoiceCostReviewResultSchema.parse({ id: 72, costComponentEvidence: evidence, costReviewVersion: version, application: null }).application).toBeNull();
  });
});
