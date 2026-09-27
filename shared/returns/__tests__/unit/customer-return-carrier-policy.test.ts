import { describe, expect, it } from "vitest";
import {
  customerReturnCarrierPolicySchema,
  customerReturnWeightLimitSchema,
  isReturnCarrierServiceAllowed,
  normalizeCustomerReturnCarrierRules,
  returnCarrierWeightLimitGrams,
  returnCarrierRuleAllowsWeight,
  type CustomerReturnCarrierPolicy,
} from "../../customer-return-carrier-policy";

const policy = (): CustomerReturnCarrierPolicy => ({
  selectionMode: "cheapest_eligible",
  carrierId: null,
  serviceCode: null,
  carrierRules: [
    {
      carrierId: "se-usps",
      serviceCodes: ["usps_ground_advantage"],
      maxWeightLb: "20",
    },
    { carrierId: "se-ups", serviceCodes: ["ups_ground"], maxWeightLb: null },
  ],
});

describe("return carrier policy", () => {
  it("keeps the previous fixed-service wire format readable", () => {
    expect(
      customerReturnCarrierPolicySchema.parse({
        carrierId: "se-ups",
        serviceCode: "ups_ground",
      }),
    ).toEqual({
      selectionMode: "fixed_service",
      carrierId: "se-ups",
      serviceCode: "ups_ground",
      carrierRules: [],
    });
  });
  it("normalizes decimal pounds without using a binary floating-point boundary", () => {
    expect(customerReturnWeightLimitSchema.parse(" 020.000 ")).toBe("20");
    expect(returnCarrierWeightLimitGrams("20")).toBe(9072);
    expect(returnCarrierWeightLimitGrams("0.001")).toBe(1);
    expect(returnCarrierWeightLimitGrams(null)).toBeNull();
  });
  it.each([
    "",
    "0",
    "0.000",
    "-1",
    ".5",
    "1e3",
    "NaN",
    "Infinity",
    "20 lb",
    "20.0001",
    "1000000000",
    "1\n2",
  ])(
    "rejects malformed or unsupported limit %j without throwing from decimal parsing",
    (value) => {
      expect(() =>
        customerReturnWeightLimitSchema.safeParse(value),
      ).not.toThrow();
      expect(customerReturnWeightLimitSchema.safeParse(value).success).toBe(
        false,
      );
    },
  );
  it("uses an inclusive ceiling at the system's whole-gram resolution", () => {
    const rule = policy().carrierRules[0];
    expect(returnCarrierRuleAllowsWeight(rule, 9072)).toBe(true);
    expect(returnCarrierRuleAllowsWeight(rule, 9073)).toBe(false);
    expect(
      isReturnCarrierServiceAllowed(policy(), "se-ups", "ups_ground", 20_000),
    ).toBe(true);
  });
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("never admits invalid parcel weight %s", (grams) => {
    expect(
      isReturnCarrierServiceAllowed(policy(), "se-ups", "ups_ground", grams),
    ).toBe(false);
  });
  it("uses exact carrier accounts and explicit allowed services", () => {
    expect(
      isReturnCarrierServiceAllowed(
        policy(),
        "se-other-usps",
        "usps_ground_advantage",
        100,
      ),
    ).toBe(false);
    expect(
      isReturnCarrierServiceAllowed(
        policy(),
        "se-usps",
        "usps_priority_mail",
        100,
      ),
    ).toBe(false);
  });
  it.each([
    { ...policy(), carrierRules: [] },
    { ...policy(), carrierId: "se-ups" },
    { ...policy(), serviceCode: "ups_ground" },
    { ...policy(), selectionMode: "fixed_service" },
    {
      ...policy(),
      carrierRules: [policy().carrierRules[0], policy().carrierRules[0]],
    },
    {
      ...policy(),
      carrierRules: [
        {
          ...policy().carrierRules[0],
          serviceCodes: ["usps_ground_advantage", "usps_ground_advantage"],
        },
      ],
    },
    {
      ...policy(),
      carrierRules: [{ ...policy().carrierRules[0], serviceCodes: [] }],
    },
  ])("rejects contradictory or ambiguous selection policy %#", (value) => {
    expect(customerReturnCarrierPolicySchema.safeParse(value).success).toBe(
      false,
    );
  });
  it("does not mutate rule order or service arrays while normalizing snapshots", () => {
    const rules = [
      {
        carrierId: "se-z",
        serviceCodes: ["service_z", "service_a"],
        maxWeightLb: null,
      },
      { carrierId: "se-a", serviceCodes: ["service_b"], maxWeightLb: "20" },
    ];
    const before = structuredClone(rules);
    expect(normalizeCustomerReturnCarrierRules(rules)).toEqual([
      { carrierId: "se-a", serviceCodes: ["service_b"], maxWeightLb: "20" },
      {
        carrierId: "se-z",
        serviceCodes: ["service_a", "service_z"],
        maxWeightLb: null,
      },
    ]);
    expect(rules).toEqual(before);
  });
  it("canonicalizes JSONB object keys as well as carrier and service order", () => {
    const left = [
      {
        carrierId: "se-usps",
        serviceCodes: ["usps_ground_advantage", "usps_priority_mail"],
        maxWeightLb: "20",
      },
    ];
    const right = [
      {
        maxWeightLb: "20",
        serviceCodes: ["usps_priority_mail", "usps_ground_advantage"],
        carrierId: "se-usps",
      },
    ];
    expect(JSON.stringify(normalizeCustomerReturnCarrierRules(left))).toBe(
      JSON.stringify(normalizeCustomerReturnCarrierRules(right)),
    );
  });
});
