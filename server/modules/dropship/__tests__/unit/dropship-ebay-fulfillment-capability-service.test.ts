import { describe, expect, it, vi } from "vitest";
import {
  DROPSHIP_EBAY_US_DESTINATION_REGIONS,
  DropshipEbayFulfillmentCapabilityService,
  mapConnectedServicesToEbay,
} from "../../application/dropship-ebay-fulfillment-capability-service";

describe("DropshipEbayFulfillmentCapabilityService", () => {
  it("derives a complete, hashed capability from operational evidence", async () => {
    const evidence = vi.fn(async () => internalEvidence());
    const carrierServices = vi.fn(async () => [{
      carrierCode: "usps",
      serviceCode: "usps_ground_advantage",
      serviceName: "USPS Ground Advantage",
      domestic: true,
    }]);
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
        ebayServiceCode: "USPSGround",
        shipStationServiceCode: "usps_ground_advantage",
      }],
      source: {
        omsChannelId: 103,
        originWarehouseId: 1,
        rateBookId: 34,
        rateTableId: 5,
      },
    });
    expect(result.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("caches ordinary reads, forces a refresh for push, and never returns shared mutable arrays", async () => {
    const evidence = vi.fn(async () => internalEvidence());
    const carrierServices = vi.fn(async () => [{
      carrierCode: "ups",
      serviceCode: "ups_ground",
      serviceName: "UPS Ground",
      domestic: true,
    }]);
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

  it("fails closed when no connected service has an exact eBay mapping", async () => {
    const service = new DropshipEbayFulfillmentCapabilityService({
      evidence: { loadForStoreConnection: async () => internalEvidence() },
      carrierServices: {
        listServices: async () => [{
          carrierCode: "custom",
          serviceCode: "custom_same_day",
          serviceName: "Custom Same Day",
          domestic: true,
        }],
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
});

describe("mapConnectedServicesToEbay", () => {
  it("maps exact domestic services and excludes international or ambiguous aliases", () => {
    expect(mapConnectedServicesToEbay([
      {
        carrierCode: "fedex",
        serviceCode: "fedex_ground",
        serviceName: "FedEx Ground",
        domestic: true,
      },
      {
        carrierCode: "fedex",
        serviceCode: "fedex_2day_am",
        serviceName: "FedEx 2Day AM",
        domestic: true,
      },
      {
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
      carrierCode: "usps",
      serviceCode: "usps_ground_advantage",
      serviceName: "USPS Ground Advantage",
      domestic: true,
    };
    const second = {
      carrierCode: "stamps_com",
      serviceCode: "usps_ground_advantage",
      serviceName: "USPS Ground Advantage",
      domestic: true,
    };

    expect(mapConnectedServicesToEbay([first, second])).toEqual(
      mapConnectedServicesToEbay([second, first]),
    );
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
    offeredDestinations: DROPSHIP_EBAY_US_DESTINATION_REGIONS.map((region) => ({
      country: "US",
      region,
    })),
  };
}
