import { describe, expect, it } from "vitest";
import type { ShippingFulfillmentRoutingProfile } from "@shared/types/shipping-fulfillment-routing";
import { resolveFulfillmentRouteCandidates } from "../../domain/fulfillment-routing";

describe("resolveFulfillmentRouteCandidates", () => {
  it("returns only scope-compatible methods in configured priority order", () => {
    const result = resolveFulfillmentRouteCandidates(profile(), "domestic");

    expect(result).toMatchObject({
      ok: true,
      profileRevision: 4,
      scope: "domestic",
    });
    if (!result.ok) throw new Error("Expected a successful resolution.");
    expect(result.candidates.map((method) => method.serviceCode)).toEqual([
      "usps_ground_advantage",
      "fedex_ground",
    ]);
  });

  it("fails closed when no configured method supports the requested scope", () => {
    expect(resolveFulfillmentRouteCandidates(profile(), "international")).toMatchObject({
      ok: false,
      code: "SHIPPING_FULFILLMENT_ROUTING_NO_ELIGIBLE_METHODS",
    });
  });

  it("does not treat an empty initial profile as a valid route", () => {
    expect(resolveFulfillmentRouteCandidates({
      ...profile(),
      revision: 0,
      methods: [],
    }, "domestic")).toMatchObject({
      ok: false,
      code: "SHIPPING_FULFILLMENT_ROUTING_PROFILE_NOT_CONFIGURED",
    });
  });

  it("rejects duplicated or gapped priorities instead of guessing an order", () => {
    const invalid = profile();
    invalid.methods[1] = { ...invalid.methods[1], priority: 1 };

    expect(resolveFulfillmentRouteCandidates(invalid, "domestic")).toMatchObject({
      ok: false,
      code: "SHIPPING_FULFILLMENT_ROUTING_PROFILE_INVALID",
    });
  });
});

function profile(): ShippingFulfillmentRoutingProfile {
  return {
    serviceLevelId: 7,
    revision: 4,
    legacyUnscopedMethodCount: 0,
    updatedBy: "operator-1",
    updatedAt: "2026-09-01T12:00:00.000Z",
    methods: [
      {
        providerConnectionId: 11,
        providerConnectionName: "Primary ShipStation",
        provider: "shipstation_v2",
        providerAccountId: "se-usps",
        providerAccountName: "USPS account",
        carrierCode: "stamps_com",
        carrierName: "USPS",
        serviceCode: "usps_ground_advantage",
        serviceName: "USPS Ground Advantage",
        domestic: true,
        international: false,
        priority: 1,
      },
      {
        providerConnectionId: 11,
        providerConnectionName: "Primary ShipStation",
        provider: "shipstation_v2",
        providerAccountId: "se-fedex",
        providerAccountName: "FedEx account",
        carrierCode: "fedex",
        carrierName: "FedEx",
        serviceCode: "fedex_ground",
        serviceName: "FedEx Ground",
        domestic: true,
        international: false,
        priority: 2,
      },
    ],
  };
}
