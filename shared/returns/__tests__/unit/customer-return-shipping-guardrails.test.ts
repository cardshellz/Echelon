import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { returnCarrierWeightLimitGrams } from "../../customer-return-carrier-policy";
import { customerReturnShippingGuardrailsSchema, defaultCustomerReturnShippingGuardrails,
  customerReturnPackingLimits, customerReturnPackingIssue, customerReturnParcelGeometry } from "../../customer-return-shipping-guardrails";
import { splitCustomerReturnItemsByWeight } from "../../customer-return-weight-split";

const dimensions = (length: number, width: number, height: number) => ({ lengthMm: new Decimal(length).times(25.4).toNumber(),
  widthMm: new Decimal(width).times(25.4).toNumber(), heightMm: new Decimal(height).times(25.4).toNumber() });
const limits = (serviceCode: string) => customerReturnPackingLimits({ selectionMode: "fixed_service", carrierId: "se-test",
  serviceCode, carrierRules: [], parcelGuardrails: defaultCustomerReturnShippingGuardrails() });
describe("versioned prepaid parcel guardrails", () => {
  it("uses exact length plus girth regardless of which side the customer calls length", () => {
    const permutations = [dimensions(55, 28, 27), dimensions(27, 55, 28), dimensions(28, 27, 55)];
    for (const box of permutations) expect(customerReturnParcelGeometry(box)).toEqual({ longestMm: 1397, lengthPlusGirthMm: 4191 });
  });
  it.each(["usps_ground_advantage", "ups_ground", "fedex_ground"])("enforces the weight boundary for %s", service => {
    const configured = limits(service)!;
    const maximum = configured[0].maxWeightGrams;
    expect(customerReturnPackingIssue(configured, maximum, dimensions(8, 6, 4))).toBeNull();
    expect(customerReturnPackingIssue(configured, maximum + 1, dimensions(8, 6, 4))).toBe("weight");
  });
  it("allows USPS at 130 inches and rejects an additional millimeter", () => {
    const box = dimensions(44, 22, 21);
    expect(customerReturnPackingIssue(limits("usps_ground_advantage"), 100, box)).toBeNull();
    expect(customerReturnPackingIssue(limits("usps_ground_advantage"), 100, { ...box, lengthMm: box.lengthMm + 1 })).toBe("size");
  });
  it.each(["ups_ground", "fedex_ground"])("enforces both 165 inches combined and 108 inches longest for %s", service => {
    const configured = limits(service);
    const box = dimensions(55, 28, 27);
    expect(customerReturnPackingIssue(configured, 100, box)).toBeNull(); // No independent volume cap.
    expect(customerReturnPackingIssue(configured, 100, { ...box, heightMm: box.heightMm + 1 })).toBe("size");
    expect(customerReturnPackingIssue(configured, 100, dimensions(108, 1, 1))).toBeNull();
    expect(customerReturnPackingIssue(configured, 100, dimensions(109, 1, 1))).toBe("size");
  });
  it("combines family and account caps without admitting unsupported services", () => {
    const configured = customerReturnPackingLimits({ selectionMode: "cheapest_eligible", carrierId: null, serviceCode: null,
      carrierRules: [{ carrierId: "se-test", serviceCodes: ["ups_ground"], maxWeightLb: "10" }],
      parcelGuardrails: defaultCustomerReturnShippingGuardrails() })!;
    expect(configured[0].maxWeightGrams).toBe(returnCarrierWeightLimitGrams("10"));
    expect(limits("unverified_service")).toEqual([]);
    expect(customerReturnPackingIssue([], 100, dimensions(8, 6, 4))).toBe("unsupported");
  });
  it("does not reinterpret a historical policy that has no guardrail snapshot", () => {
    expect(customerReturnPackingLimits({ selectionMode: "fixed_service", carrierId: "se-test", serviceCode: "ups_ground", carrierRules: [] })).toBeNull();
    expect(customerReturnPackingIssue(null, 100000, dimensions(200, 200, 200))).toBeNull();
  });
  it("does not apply an inactive cost comparison to reduced size limits", () => {
    const configured = defaultCustomerReturnShippingGuardrails();
    configured.costProtection = false;
    configured.ups.maxLengthPlusGirthInches = "80";
    expect(customerReturnShippingGuardrailsSchema.safeParse(configured).success).toBe(true);
    configured.costProtection = true;
    expect(customerReturnShippingGuardrailsSchema.safeParse(configured).success).toBe(false);
  });
  it.each(["usps", "ups", "fedex"] as const)("prevents raising the %s merchant weight ceiling or carrier girth ceiling", family => {
    const configured = defaultCustomerReturnShippingGuardrails();
    configured[family].maxWeightLb = family === "usps" ? "21" : "51";
    expect(customerReturnShippingGuardrailsSchema.safeParse(configured).success).toBe(false);
    configured[family].maxWeightLb = "1";
    configured[family].maxLengthPlusGirthInches = family === "usps" ? "131" : "166";
    expect(customerReturnShippingGuardrailsSchema.safeParse(configured).success).toBe(false);
  });
  it("rejects international scope, unknown fields, zero, invalid and oversize reference dimensions", () => {
    const configured = defaultCustomerReturnShippingGuardrails();
    expect(customerReturnShippingGuardrailsSchema.safeParse({ ...configured, geography: "international" }).success).toBe(false);
    expect(customerReturnShippingGuardrailsSchema.safeParse({ ...configured, volumeLimit: 1000 }).success).toBe(false);
    for (const value of [0, -1, Infinity, NaN, 100000]) {
      configured.ups.costReferenceDimensions.lengthMm = value;
      expect(customerReturnShippingGuardrailsSchema.safeParse(configured).success).toBe(false);
    }
  });
});
describe("whole-unit weight splitting", () => {
  const cap = returnCarrierWeightLimitGrams("50")!;
  it("puts two 30 lb units into two boxes while keeping every purchased unit", () => {
    const input = [{ lineId: "heavy", quantity: 2, unitWeightGrams: 13607.7711 }];
    const before = structuredClone(input);
    expect(splitCustomerReturnItemsByWeight(input, cap, 20)).toEqual({ ok: true,
      boxes: [[{ lineId: "heavy", quantity: 1 }], [{ lineId: "heavy", quantity: 1 }]] });
    expect(input).toEqual(before);
  });
  it("packs exact fractional product weights and is deterministic across input order", () => {
    const input = [{ lineId: "b", quantity: 3, unitWeightGrams: 0.3 }, { lineId: "a", quantity: 3, unitWeightGrams: 0.2 }];
    const forward = splitCustomerReturnItemsByWeight(input, 1, 20);
    expect(forward).toEqual(splitCustomerReturnItemsByWeight([...input].reverse(), 1, 20));
    expect(forward.ok && forward.boxes).toHaveLength(2);
  });
  it("does not split one overweight purchased unit", () => {
    expect(splitCustomerReturnItemsByWeight([{ lineId: "heavy", quantity: 1, unitWeightGrams: cap + 1 }], cap, 20))
      .toEqual({ ok: false, reason: "individual_item" });
  });
  it("bounds huge quantities without allocating one object per unit", () => {
    expect(splitCustomerReturnItemsByWeight([{ lineId: "heavy", quantity: Number.MAX_SAFE_INTEGER, unitWeightGrams: cap }], cap, 20))
      .toEqual({ ok: false, reason: "too_many_boxes" });
  });
  it.each([null, 0, -1, NaN, Infinity])("rejects missing or invalid product weight %s", weight => {
    expect(splitCustomerReturnItemsByWeight([{ lineId: "bad", quantity: 1, unitWeightGrams: weight }], cap, 20))
      .toEqual({ ok: false, reason: "weight_unknown" });
  });
  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid quantity %s", quantity => {
    expect(splitCustomerReturnItemsByWeight([{ lineId: "bad", quantity, unitWeightGrams: 1 }], cap, 20)).toEqual({ ok: false, reason: "invalid" });
  });
});
