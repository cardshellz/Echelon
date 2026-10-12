import { describe, expect, it } from "vitest";
import { invoiceLineDraft } from "../../invoice-line-editor";

const current = { beforeQuantity: 25000, recordedUnitCostMills: 5023, invoiceLineAmountCents: 1338750 };
const values = { quantity: "25000", unitPrice: "0.5023", lineAmount: "13387.50" };

describe("invoice line edit validation", () => {
  it("recognizes unchanged saved values despite harmless decimal formatting", () => {
    expect(invoiceLineDraft({ ...values, unitPrice: "00.5023", lineAmount: "013387.5" }, current)).toEqual({
      valid: true, quantityPieces: 25000, unitCostMills: 5023, lineTotalCents: 1338750, changed: false,
    });
  });
  it.each([{ quantity: "20000" }, { unitPrice: "0.5355" }, { lineAmount: "13337.50" }])("detects a manual change %j", patch => {
    expect(invoiceLineDraft({ ...values, ...patch }, current)).toMatchObject({ valid: true, changed: true });
  });
  it.each(["", "0", "-1", "1.5", "1e3", "2147483648", "9999999999999999999999999999999999999"])("rejects an invalid quantity %s", quantity => {
    expect(invoiceLineDraft({ ...values, quantity }, current)).toMatchObject({ valid: false, message: expect.stringContaining("whole number") });
  });
  it.each(["", "-0.10", "0.50231", "1e3", "999999999999999999999999.0000"])("rejects an invalid unit price %s", unitPrice => {
    expect(invoiceLineDraft({ ...values, unitPrice }, current)).toMatchObject({ valid: false, message: expect.stringContaining("Unit price:") });
  });
  it.each(["", "-1.00", "13387.501", "1e3", "999999999999999999999999.00"])("rejects an invalid line amount %s", lineAmount => {
    expect(invoiceLineDraft({ ...values, lineAmount }, current)).toMatchObject({ valid: false, message: expect.stringContaining("Line amount:") });
  });
  it("preserves exact zero and maximum supported monetary values", () => {
    expect(invoiceLineDraft({ ...values, unitPrice: "0", lineAmount: "0.00" }, current)).toMatchObject({ valid: true, unitCostMills: 0, lineTotalCents: 0 });
    expect(invoiceLineDraft({ ...values, unitPrice: "900719925474.0991", lineAmount: "90071992547409.91" }, current)).toMatchObject({ valid: true, unitCostMills: Number.MAX_SAFE_INTEGER, lineTotalCents: Number.MAX_SAFE_INTEGER });
  });
  it("does not change the draft or saved evidence while validating", () => {
    const draft = { ...values }, before = { ...current };
    invoiceLineDraft(draft, before);
    expect(draft).toEqual(values); expect(before).toEqual(current);
  });
});
