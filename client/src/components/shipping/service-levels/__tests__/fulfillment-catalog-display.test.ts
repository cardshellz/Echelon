import { describe, expect, it } from "vitest";
import type {
  ShippingFulfillmentCatalogMethod,
} from "@shared/types/shipping-fulfillment-routing";
import {
  groupFulfillmentCatalogMethodsByScope,
} from "../fulfillment-catalog-display";

function catalogMethod(input: {
  serviceCode: string;
  serviceName: string;
  domestic: boolean;
  international: boolean;
}): ShippingFulfillmentCatalogMethod {
  return {
    providerConnectionId: 1,
    providerConnectionName: "ShipStation",
    provider: "shipstation_v2",
    providerAccountId: "se-ups",
    providerAccountName: "UPS",
    carrierCode: "ups",
    carrierName: "UPS",
    serviceCode: input.serviceCode,
    serviceName: input.serviceName,
    domestic: input.domestic,
    international: input.international,
    capabilities: {
      supportsMultiPackage: true,
      supportsReturns: true,
      supportsPrepaidDutiesTaxes: false,
      sendRates: true,
      displaySchemes: ["label"],
    },
  };
}

describe("fulfillment catalog destination grouping", () => {
  it("shows same-code domestic and international identities in separate sections", () => {
    const domestic = catalogMethod({
      serviceCode: "ups_worldwide_saver",
      serviceName: "UPS Worldwide Saver",
      domestic: true,
      international: false,
    });
    const international = catalogMethod({
      serviceCode: "ups_worldwide_saver",
      serviceName: "UPS Worldwide Saver",
      domestic: false,
      international: true,
    });

    const groups = groupFulfillmentCatalogMethodsByScope([international, domestic]);

    expect(groups.map((group) => group.label)).toEqual(["Domestic", "International"]);
    expect(groups[0].methods).toEqual([domestic]);
    expect(groups[1].methods).toEqual([international]);
  });

  it("shows a dual-scope identity in both destination sections", () => {
    const dualScope = catalogMethod({
      serviceCode: "postal_service",
      serviceName: "Postal service",
      domestic: true,
      international: true,
    });

    const groups = groupFulfillmentCatalogMethodsByScope([dualScope]);

    expect(groups).toHaveLength(2);
    expect(groups[0].methods).toEqual([dualScope]);
    expect(groups[1].methods).toEqual([dualScope]);
  });

  it("omits empty destination sections", () => {
    const domestic = catalogMethod({
      serviceCode: "ups_ground",
      serviceName: "UPS Ground",
      domestic: true,
      international: false,
    });

    expect(groupFulfillmentCatalogMethodsByScope([domestic])).toEqual([{
      scope: "domestic",
      label: "Domestic",
      methods: [domestic],
    }]);
  });
});
