import { describe, expect, it } from "vitest";
import {
  customerReturnCarrierPolicySchema,
  isReturnCarrierServiceAllowed,
} from "@shared/returns/customer-return-carrier-policy";
import { isReturnRateCatalogServiceEligible } from "../../application/return-rate-catalog";
import { normalizeCarrierServicesResponse } from "../../infrastructure/shipstation-v2-rating.adapter";

const unknownSupport = {
  domestic: true,
  supportsReturns: false,
  returnSupport: "unknown",
  sendRates: true,
};

describe("return rate catalog availability", () => {
  it("offers documented domestic rating services without claiming proven return support", () => {
    const [service] = normalizeCarrierServicesResponse(
      {
        services: [
          {
            service_code: "usps_ground_advantage",
            domestic: true,
            send_rates: true,
          },
        ],
      },
      { carrierId: "se-111", code: "usps", name: "USPS" },
    );
    expect(service.returnSupport).toBe("unknown");
    expect(service.supportsReturns).toBe(false);
    expect(isReturnRateCatalogServiceEligible(service)).toBe(true);

    const policy = customerReturnCarrierPolicySchema.parse({
      selectionMode: "cheapest_eligible",
      carrierId: null,
      serviceCode: null,
      carrierRules: [
        {
          carrierId: "se-222",
          serviceCodes: [service.serviceCode],
          maxWeightLb: null,
        },
      ],
    });
    expect(
      isReturnCarrierServiceAllowed(
        policy,
        service.carrierId,
        service.serviceCode,
        100,
      ),
    ).toBe(false);
    const explicitlyAllowed = customerReturnCarrierPolicySchema.parse({
      ...policy,
      carrierRules: [
        {
          carrierId: service.carrierId,
          serviceCodes: [service.serviceCode],
          maxWeightLb: null,
        },
      ],
    });
    expect(
      isReturnCarrierServiceAllowed(
        explicitlyAllowed,
        service.carrierId,
        service.serviceCode,
        100,
      ),
    ).toBe(true);
    expect(
      isReturnCarrierServiceAllowed(
        explicitlyAllowed,
        service.carrierId,
        "usps_priority_mail",
        100,
      ),
    ).toBe(false);
  });

  it("retains explicit and legacy support when sendRates is false", () => {
    expect(
      isReturnRateCatalogServiceEligible({
        ...unknownSupport,
        returnSupport: "supported",
        supportsReturns: true,
        sendRates: false,
      }),
    ).toBe(true);
    expect(
      isReturnRateCatalogServiceEligible({
        domestic: true,
        supportsReturns: true,
        sendRates: false,
      }),
    ).toBe(true);
  });

  it.each([
    { ...unknownSupport, domestic: false },
    { ...unknownSupport, returnSupport: "unsupported" },
    { ...unknownSupport, returnSupport: "unsupported", supportsReturns: true },
    { ...unknownSupport, sendRates: false },
    { ...unknownSupport, supportsReturns: true, sendRates: false },
    { ...unknownSupport, returnSupport: "supported", sendRates: false },
    { ...unknownSupport, returnSupport: "invalid" },
    { ...unknownSupport, domestic: "true" },
    { ...unknownSupport, sendRates: "true" },
    { ...unknownSupport, supportsReturns: "true" },
    { domestic: true, supportsReturns: false },
    null,
    undefined,
  ])(
    "excludes invalid, international-only or non-rating unknown support: %j",
    (service) => {
      expect(isReturnRateCatalogServiceEligible(service)).toBe(false);
    },
  );

  it("does not offer explicit false or malformed provider support even when send_rates is true", () => {
    const services = normalizeCarrierServicesResponse(
      {
        services: [false, null, "true", 1].map((flag) => ({
          service_code: "usps_ground_advantage",
          domestic: true,
          send_rates: true,
          is_return_supported: flag,
        })),
      },
      { carrierId: "se-111", code: "usps", name: "USPS" },
    );
    expect(services).toHaveLength(4);
    expect(services.filter(isReturnRateCatalogServiceEligible)).toEqual([]);
  });
});
