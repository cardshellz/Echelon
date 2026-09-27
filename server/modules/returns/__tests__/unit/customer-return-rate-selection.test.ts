import { describe, expect, it } from "vitest";
import type { CustomerReturnCarrierPolicy } from "@shared/returns/customer-return-carrier-policy";
import type {
  ReturnRateCandidate,
  ReturnRateResult,
} from "../../../shipping-engine/application/return-rate-provider.port";
import { selectCustomerReturnRate } from "../../domain/customer-return-rate-selection";

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
    {
      carrierId: "se-ups",
      serviceCodes: ["ups_ground", "ups_ground_saver"],
      maxWeightLb: null,
    },
  ],
});
function rate(
  carrierId: string,
  serviceCode: string,
  cents: number,
): ReturnRateCandidate {
  return {
    carrierId,
    carrierCode: carrierId === "se-usps" ? "stamps_com" : "ups",
    serviceCode,
    amountCents: cents,
    currency: "USD",
    rateId: null,
    rateType: "quick",
    packageType: "package",
    trackable: true,
    validationStatus: "valid",
    warningCount: 0,
    amounts: {
      shippingCents: cents,
      insuranceCents: 0,
      confirmationCents: 0,
      otherCents: 0,
    },
  };
}
const result = (...rates: ReturnRateCandidate[]): ReturnRateResult => ({
  status: "completed",
  rates,
  exclusions: [],
});

describe("cheapest eligible customer return service", () => {
  it("selects independently per box and excludes USPS above its configured weight", () => {
    const quotes = result(
      rate("se-usps", "usps_ground_advantage", 600),
      rate("se-ups", "ups_ground", 900),
    );
    expect(
      selectCustomerReturnRate({
        policy: policy(),
        weightGrams: 9072,
        result: quotes,
      }).selected.carrierId,
    ).toBe("se-usps");
    const heavy = selectCustomerReturnRate({
      policy: policy(),
      weightGrams: 9073,
      result: quotes,
    });
    expect(heavy.selected.carrierId).toBe("se-ups");
    expect(heavy.excludedRates).toEqual([
      {
        carrierId: "se-usps",
        serviceCode: "usps_ground_advantage",
        reason: "weight_limit",
      },
    ]);
  });
  it("compares total USD charges rather than the base shipping component", () => {
    const surcharge = rate("se-usps", "usps_ground_advantage", 1200);
    surcharge.amounts.shippingCents = 500;
    surcharge.amounts.otherCents = 700;
    expect(
      selectCustomerReturnRate({
        policy: policy(),
        weightGrams: 100,
        result: result(surcharge, rate("se-ups", "ups_ground", 1100)),
      }).selected.carrierId,
    ).toBe("se-ups");
  });
  it("never admits a cheaper unapproved account or service", () => {
    const selection = selectCustomerReturnRate({
      policy: policy(),
      weightGrams: 100,
      result: result(
        rate("se-other", "ups_ground", 10),
        rate("se-usps", "usps_priority_mail", 20),
        rate("se-ups", "ups_ground", 500),
      ),
    });
    expect(selection.selected.amountCents).toBe(500);
    expect(selection.excludedRates).toHaveLength(2);
  });
  it("uses account and service identity for deterministic equal-price ties", () => {
    const quotes = [
      rate("se-usps", "usps_ground_advantage", 500),
      rate("se-ups", "ups_ground_saver", 500),
      rate("se-ups", "ups_ground", 500),
    ];
    for (const ordered of [
      quotes,
      [...quotes].reverse(),
      [quotes[1], quotes[0], quotes[2]],
    ]) {
      expect(
        selectCustomerReturnRate({
          policy: policy(),
          weightGrams: 100,
          result: result(...ordered),
        }).selected,
      ).toMatchObject({ carrierId: "se-ups", serviceCode: "ups_ground" });
    }
  });
  it("preserves a fixed service instead of silently rerating its selection", () => {
    const fixed: CustomerReturnCarrierPolicy = {
      selectionMode: "fixed_service",
      carrierId: "se-ups",
      serviceCode: "ups_ground",
      carrierRules: [],
    };
    expect(
      selectCustomerReturnRate({
        policy: fixed,
        weightGrams: 100,
        result: result(
          rate("se-usps", "usps_ground_advantage", 1),
          rate("se-ups", "ups_ground", 900),
        ),
      }).selected.carrierId,
    ).toBe("se-ups");
  });
  it.each([
    { rates: [] },
    { rates: [rate("se-usps", "usps_ground_advantage", 500)] },
  ])("blocks an empty eligible rate set %#", ({ rates }) => {
    expect(() =>
      selectCustomerReturnRate({
        policy: policy(),
        weightGrams: 10_000,
        result: result(...rates),
      }),
    ).toThrow("No allowed return service");
  });
  it("rejects ambiguous duplicate purchase identities", () => {
    expect(() =>
      selectCustomerReturnRate({
        policy: policy(),
        weightGrams: 100,
        result: result(
          rate("se-ups", "ups_ground", 500),
          rate("se-ups", "ups_ground", 600),
        ),
      }),
    ).toThrow("could not be verified");
  });
  it.each([
    "EUR",
    -1,
    0.1,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid quote currency/amount %s", (invalid) => {
    const candidate = rate("se-ups", "ups_ground", 500);
    const malformed =
      typeof invalid === "string"
        ? { ...candidate, currency: invalid }
        : { ...candidate, amountCents: invalid };
    expect(() =>
      selectCustomerReturnRate({
        policy: policy(),
        weightGrams: 100,
        result: result(malformed as ReturnRateCandidate),
      }),
    ).toThrow("could not be verified");
  });
  it("does not mutate caller policy, rates, amounts or ordering", () => {
    const input = {
      policy: policy(),
      weightGrams: 100,
      result: result(
        rate("se-usps", "usps_ground_advantage", 900),
        rate("se-ups", "ups_ground", 500),
      ),
    };
    const before = structuredClone(input);
    selectCustomerReturnRate(input);
    expect(input).toEqual(before);
  });
});
