import { describe, expect, it, vi } from "vitest";
import {
  EBAY_US_GROUND_ADVANTAGE_EVIDENCE,
  EBAY_US_LEGACY_GROUND_EVIDENCE,
} from "../fixtures/ebay-us-ground-advantage-evidence";
import {
  DROPSHIP_EBAY_US_DESTINATION_REGIONS,
  DropshipEbayFulfillmentCapabilityService,
  mapRoutedServicesToEbay,
} from "../../application/dropship-ebay-fulfillment-capability-service";

describe("DropshipEbayFulfillmentCapabilityService", () => {
  it("derives a complete, hashed capability from operational evidence", async () => {
    const evidence = vi.fn(async () => internalEvidence());
    const carrierServices = vi.fn(async () => ({
      serviceLevelId: 7,
      routingRevision: 4,
      services: [{
        provider: "shipstation_v2",
        carrierCode: "usps",
        serviceCode: "usps_ground_advantage",
        serviceName: "USPS Ground Advantage",
        domestic: true,
      }],
    }));
    const service = new DropshipEbayFulfillmentCapabilityService({
      evidence: { loadForStoreConnection: evidence },
      carrierServices: { listServices: carrierServices },
      clock: { now: () => new Date("2026-09-01T12:00:00.000Z") },
    });

    const result = await service.getForStoreConnection({
      storeConnectionId: 44,
      marketplaceId: "EBAY_US",
    });

    expect(result).toMatchObject({
      marketplaceId: "EBAY_US",
      requiredHandlingTimeBusinessDays: 1,
      destinationCountry: "US",
      destinationCoverageComplete: true,
      supportedServices: [{
        carrier: "USPS",
        ebayServiceCode: "USPSParcel",
        shipStationServiceCode: "usps_ground_advantage",
      }],
      source: {
        omsChannelId: 103,
        originWarehouseId: 1,
        rateBookId: 34,
        rateTableId: 5,
        serviceLevelId: 7,
        fulfillmentRoutingRevision: 4,
      },
    });
    expect(result.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(carrierServices).toHaveBeenCalledWith({ serviceLevelId: 7 });
  });

  it("caches ordinary reads, forces a refresh for push, and never returns shared mutable arrays", async () => {
    const evidence = vi.fn(async () => internalEvidence());
    const carrierServices = vi.fn(async () => ({
      serviceLevelId: 7,
      routingRevision: 4,
      services: [{
        provider: "shipstation_v2",
        carrierCode: "ups",
        serviceCode: "ups_ground",
        serviceName: "UPS Ground",
        domestic: true,
      }],
    }));
    const service = new DropshipEbayFulfillmentCapabilityService({
      evidence: { loadForStoreConnection: evidence },
      carrierServices: { listServices: carrierServices },
      clock: { now: () => new Date("2026-09-01T12:00:00.000Z") },
    });

    const first = await service.getForStoreConnection({
      storeConnectionId: 44,
      marketplaceId: "EBAY_US",
    });
    first.destinationRegions.length = 0;
    const cached = await service.getForStoreConnection({
      storeConnectionId: 44,
      marketplaceId: "EBAY_US",
    });
    const fresh = await service.getForStoreConnection({
      storeConnectionId: 44,
      marketplaceId: "EBAY_US",
      fresh: true,
    });

    expect(cached.destinationRegions).toHaveLength(
      DROPSHIP_EBAY_US_DESTINATION_REGIONS.length,
    );
    expect(fresh.destinationCoverageComplete).toBe(true);
    expect(evidence).toHaveBeenCalledTimes(2);
    expect(carrierServices).toHaveBeenCalledTimes(2);
  });

  it("changes the capability evidence hash when the routing revision changes", async () => {
    let routingRevision = 1;
    const service = new DropshipEbayFulfillmentCapabilityService({
      evidence: { loadForStoreConnection: async () => internalEvidence() },
      carrierServices: {
        listServices: async () => ({
          serviceLevelId: 7,
          routingRevision: routingRevision++,
          services: [{
            provider: "shipstation_v2",
            carrierCode: "ups",
            serviceCode: "ups_ground",
            serviceName: "UPS Ground",
            domestic: true,
          }],
        }),
      },
      clock: { now: () => new Date("2026-09-01T12:00:00.000Z") },
    });

    const first = await service.getForStoreConnection({
      storeConnectionId: 44,
      marketplaceId: "EBAY_US",
      fresh: true,
    });
    const second = await service.getForStoreConnection({
      storeConnectionId: 44,
      marketplaceId: "EBAY_US",
      fresh: true,
    });

    expect(first.source.fulfillmentRoutingRevision).toBe(1);
    expect(second.source.fulfillmentRoutingRevision).toBe(2);
    expect(second.evidenceHash).not.toBe(first.evidenceHash);
  });

  it("fails closed when no allowed routed method has an exact eBay mapping", async () => {
    const service = new DropshipEbayFulfillmentCapabilityService({
      evidence: { loadForStoreConnection: async () => internalEvidence() },
      carrierServices: {
        listServices: async () => ({
          serviceLevelId: 7,
          routingRevision: 4,
          services: [{
            provider: "shipstation_v2",
            carrierCode: "custom",
            serviceCode: "custom_same_day",
            serviceName: "Custom Same Day",
            domestic: true,
          }],
        }),
      },
    });

    await expect(service.getForStoreConnection({
      storeConnectionId: 44,
      marketplaceId: "EBAY_US",
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_FULFILLMENT_SERVICES_REQUIRED",
      context: { retryable: false },
    });
  });

  it("fails closed when routing resolves a different service level than the rate table", async () => {
    const service = new DropshipEbayFulfillmentCapabilityService({
      evidence: { loadForStoreConnection: async () => internalEvidence() },
      carrierServices: {
        listServices: async () => ({
          serviceLevelId: 8,
          routingRevision: 2,
          services: [],
        }),
      },
    });

    await expect(service.getForStoreConnection({
      storeConnectionId: 44,
      marketplaceId: "EBAY_US",
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_MISMATCH",
      context: {
        expectedServiceLevelId: 7,
        returnedServiceLevelId: 8,
        retryable: false,
      },
    });
  });
});

describe("mapRoutedServicesToEbay", () => {
  it.each(["usps", "stamps_com"])("maps %s Ground Advantage to the verified sellable eBay identity", (carrierCode) => {
    const result = mapRoutedServicesToEbay([{
      provider: "shipstation_v2",
      carrierCode,
      serviceCode: "usps_ground_advantage",
      serviceName: "USPS Ground Advantage",
      domestic: true,
    }]);

    expect(EBAY_US_GROUND_ADVANTAGE_EVIDENCE.ValidForSellingFlow).toBe(true);
    expect(EBAY_US_LEGACY_GROUND_EVIDENCE.ValidForSellingFlow).toBe(false);
    expect(result).toHaveLength(1);
    expect(result[0].ebayServiceCode).toBe(EBAY_US_GROUND_ADVANTAGE_EVIDENCE.ShippingService);
    expect(result[0].ebayServiceCode).not.toBe(EBAY_US_LEGACY_GROUND_EVIDENCE.ShippingService);
  });

  it("maps exact domestic services and excludes international or ambiguous aliases", () => {
    expect(mapRoutedServicesToEbay([
      {
        provider: "shipstation_v2",
        carrierCode: "fedex",
        serviceCode: "fedex_ground",
        serviceName: "FedEx Ground",
        domestic: true,
      },
      {
        provider: "shipstation_v2",
        carrierCode: "fedex",
        serviceCode: "fedex_2day_am",
        serviceName: "FedEx 2Day AM",
        domestic: true,
      },
      {
        provider: "shipstation_v2",
        carrierCode: "fedex",
        serviceCode: "fedex_international_economy",
        serviceName: "FedEx International Economy",
        domestic: false,
      },
    ])).toEqual([expect.objectContaining({
      ebayServiceCode: "FedExGround",
      shipStationServiceCode: "fedex_ground",
    })]);
  });

  it("selects the same canonical carrier evidence regardless of provider response order", () => {
    const first = {
      provider: "shipstation_v2",
      carrierCode: "usps",
      serviceCode: "usps_ground_advantage",
      serviceName: "USPS Ground Advantage",
      domestic: true,
    };
    const second = {
      provider: "shipstation_v2",
      carrierCode: "stamps_com",
      serviceCode: "usps_ground_advantage",
      serviceName: "USPS Ground Advantage",
      domestic: true,
    };

    expect(mapRoutedServicesToEbay([first, second])).toEqual(
      mapRoutedServicesToEbay([second, first]),
    );
  });

  it("does not reuse a ShipStation service-code mapping for another provider", () => {
    expect(mapRoutedServicesToEbay([{
      provider: "future_provider",
      carrierCode: "ups",
      serviceCode: "ups_ground",
      serviceName: "Future-provider UPS Ground",
      domestic: true,
    }])).toEqual([]);
  });
});

function internalEvidence() {
  return {
    omsChannelId: 103,
    originWarehouseId: 1,
    requiredHandlingTimeBusinessDays: 1,
    rateBookId: 34,
    rateBookCode: "dropship-vendor-default",
    rateTableId: 5,
    serviceLevelId: 7,
    offeredDestinations: DROPSHIP_EBAY_US_DESTINATION_REGIONS.map((region) => ({
      country: "US",
      region,
    })),
  };
}
