import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DropshipEbayListingSetupService,
  type DropshipEbayListingSetupDirectory,
  type DropshipEbayListingSetupDiscovery,
} from "../../application/dropship-ebay-listing-setup-service";
import {
  buildDefaultDropshipStoreListingConfig,
  type DropshipListingConfigService,
  type DropshipStoreListingConfigRecord,
  type NormalizedDropshipStoreListingConfigInput,
} from "../../application/dropship-listing-config-service";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type {
  DropshipEbayManagedLocationProvider,
} from "../../application/dropship-ebay-managed-location-service";
import type {
  DropshipEbayFulfillmentCapability,
  DropshipEbayFulfillmentPolicy,
} from "../../domain/ebay-fulfillment-policy-compatibility";

const now = new Date("2026-08-30T14:00:00.000Z");

describe("DropshipEbayListingSetupService", () => {
  let listingConfig: FakeListingConfig;
  let directory: FakeDirectory;
  let logs: DropshipLogEvent[];
  let service: DropshipEbayListingSetupService;

  beforeEach(() => {
    listingConfig = new FakeListingConfig();
    directory = new FakeDirectory();
    logs = [];
    service = new DropshipEbayListingSetupService({
      listingConfig: listingConfig as unknown as Pick<
        DropshipListingConfigService,
        "getForMember" | "replaceForMember" | "getForAdmin" | "replaceForAdmin"
      >,
      directory,
      fulfillmentCapabilities: {
        getForStoreConnection: async () => capability(),
      },
      managedLocations: managedLocations(directory),
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
    });
  });

  it("auto-selects each prerequisite only when eBay returns one valid option", async () => {
    const result = await service.autoConfigureAfterConnection({
      storeConnectionId: 44,
      accessToken: "access-token",
      environment: "production",
    });

    expect(result).toMatchObject({
      complete: true,
      marketplaceId: "EBAY_US",
      selection: {
        merchantLocationKey: "cardshellz-dropship-wh-1",
        fulfillmentPolicyId: "fulfillment-1",
        returnPolicyId: "return-1",
        paymentPolicyId: "payment-1",
      },
    });
    expect(directory.accessTokenCall).toEqual({
      accessToken: "access-token",
      environment: "production",
      marketplaceId: "EBAY_US",
      storeConnectionId: 44,
    });
    expect(listingConfig.replaceAdmin).toHaveBeenCalledTimes(1);
    expect(listingConfig.config.marketplaceConfig).toMatchObject({
      unrelatedSetting: "preserved",
      marketplaceId: "EBAY_US",
      merchantLocationKey: "cardshellz-dropship-wh-1",
      businessPolicies: {
        unrelatedPolicySetting: "preserved",
        fulfillmentPolicyId: "fulfillment-1",
        returnPolicyId: "return-1",
        paymentPolicyId: "payment-1",
      },
    });
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_EVALUATED",
      context: { complete: true, actorType: "system" },
    });
  });

  it("uses the Card Shellz-managed location even when other seller locations exist", async () => {
    directory.discovery = {
      ...directory.discovery,
      merchantLocations: [
        { id: "warehouse-east", name: "East" },
        { id: "warehouse-west", name: "West" },
      ],
      paymentPolicies: [
        { id: "payment-retail", name: "Retail" },
        { id: "payment-wholesale", name: "Wholesale" },
      ],
    };

    const result = await service.autoConfigureAfterConnection({
      storeConnectionId: 44,
      accessToken: "access-token",
      environment: "production",
    });

    expect(result.complete).toBe(false);
    expect(result.selection).toEqual({
      merchantLocationKey: "cardshellz-dropship-wh-1",
      fulfillmentPolicyId: "fulfillment-1",
      returnPolicyId: "return-1",
      paymentPolicyId: null,
    });
    expect(result.missingFields).toEqual(["paymentPolicyId"]);
  });

  it("replaces a seller-owned location while preserving valid policy choices", async () => {
    listingConfig.config = makeConfig({
      marketplaceId: "EBAY_US",
      merchantLocationKey: "warehouse-west",
      businessPolicies: {
        fulfillmentPolicyId: "fulfillment-2",
        returnPolicyId: "return-1",
        paymentPolicyId: "payment-1",
      },
    });
    directory.discovery = {
      ...directory.discovery,
      merchantLocations: [
        { id: "warehouse-east", name: "East" },
        { id: "warehouse-west", name: "West" },
      ],
      fulfillmentPolicies: [
        fulfillmentPolicy("fulfillment-1", "Standard"),
        fulfillmentPolicy("fulfillment-2", "Expedited"),
      ],
    };

    const result = await service.autoConfigureAfterConnection({
      storeConnectionId: 44,
      accessToken: "access-token",
      environment: "production",
    });

    expect(result.complete).toBe(true);
    expect(result.selection).toMatchObject({
      merchantLocationKey: "cardshellz-dropship-wh-1",
      fulfillmentPolicyId: "fulfillment-2",
    });
    expect(listingConfig.replaceAdmin).toHaveBeenCalledTimes(1);
  });

  it("marks persisted location and policy ids incomplete after eBay stops returning them", async () => {
    listingConfig.config = makeConfig({
      marketplaceId: "EBAY_US",
      merchantLocationKey: "deleted-location",
      businessPolicies: {
        fulfillmentPolicyId: "deleted-fulfillment",
        returnPolicyId: "deleted-return",
        paymentPolicyId: "deleted-payment",
      },
    });

    const result = await service.getForMember("member-1", 44);

    expect(result.complete).toBe(false);
    expect(result.missingFields).toEqual([
      "merchantLocationKey",
      "fulfillmentPolicyId",
      "returnPolicyId",
      "paymentPolicyId",
    ]);
  });

  it("rejects stale or fabricated vendor selections before writing config", async () => {
    await expect(service.replaceForMember("member-1", 44, {
      merchantLocationKey: "warehouse-main",
      fulfillmentPolicyId: "fabricated-policy",
      returnPolicyId: "return-1",
      paymentPolicyId: "payment-1",
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID",
      context: { invalidFields: ["fulfillmentPolicyId"] },
    });
    expect(listingConfig.replaceMember).not.toHaveBeenCalled();
  });

  it("saves a validated vendor selection without changing unrelated listing config", async () => {
    directory.discovery = {
      ...directory.discovery,
      fulfillmentPolicies: [
        fulfillmentPolicy("fulfillment-1", "Standard"),
        fulfillmentPolicy("fulfillment-2", "Expedited"),
      ],
    };

    const result = await service.replaceForMember("member-1", 44, {
      fulfillmentPolicyId: "fulfillment-2",
      returnPolicyId: "return-1",
      paymentPolicyId: "payment-1",
    });

    expect(result.complete).toBe(true);
    expect(listingConfig.replaceMember).toHaveBeenCalledTimes(1);
    expect(listingConfig.config).toMatchObject({
      listingMode: "live",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      isActive: true,
      marketplaceConfig: {
        unrelatedSetting: "preserved",
        businessPolicies: {
          unrelatedPolicySetting: "preserved",
          fulfillmentPolicyId: "fulfillment-2",
        },
      },
    });
  });

  it("rejects a real eBay policy whose handling promise is shorter than the OMS SLA", async () => {
    directory.discovery = {
      ...directory.discovery,
      fulfillmentPolicies: [{
        ...fulfillmentPolicy("fulfillment-fast", "Same day"),
        handlingTime: { value: 0, unit: "DAY" },
      }],
    };

    await expect(service.replaceForMember("member-1", 44, {
      fulfillmentPolicyId: "fulfillment-fast",
      returnPolicyId: "return-1",
      paymentPolicyId: "payment-1",
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
      context: {
        fulfillmentPolicyId: "fulfillment-fast",
        issues: [expect.objectContaining({ code: "handling_time_too_short" })],
        retryable: false,
      },
    });
    expect(listingConfig.replaceMember).not.toHaveBeenCalled();
  });
});

class FakeDirectory implements DropshipEbayListingSetupDirectory {
  discovery: DropshipEbayListingSetupDiscovery = {
    marketplaceId: "EBAY_US",
    merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
    fulfillmentPolicies: [fulfillmentPolicy("fulfillment-1", "Standard")],
    returnPolicies: [{ id: "return-1", name: "Thirty days" }],
    paymentPolicies: [{ id: "payment-1", name: "Managed payments" }],
  };
  accessTokenCall: unknown = null;

  async discoverForStoreConnection(): Promise<DropshipEbayListingSetupDiscovery> {
    return this.discovery;
  }

  async discoverWithAccessToken(
    input: Parameters<DropshipEbayListingSetupDirectory["discoverWithAccessToken"]>[0],
  ): Promise<DropshipEbayListingSetupDiscovery> {
    this.accessTokenCall = input;
    return this.discovery;
  }

  async getFulfillmentPolicyForStoreConnection(
    input: Parameters<DropshipEbayListingSetupDirectory["getFulfillmentPolicyForStoreConnection"]>[0],
  ): Promise<DropshipEbayFulfillmentPolicy> {
    return this.requiredPolicy(input.fulfillmentPolicyId);
  }

  async getFulfillmentPolicyWithAccessToken(
    input: Parameters<DropshipEbayListingSetupDirectory["getFulfillmentPolicyWithAccessToken"]>[0],
  ): Promise<DropshipEbayFulfillmentPolicy> {
    return this.requiredPolicy(input.fulfillmentPolicyId);
  }

  private requiredPolicy(id: string): DropshipEbayFulfillmentPolicy {
    const policy = this.discovery.fulfillmentPolicies.find((candidate) => candidate.id === id);
    if (!policy) throw new Error(`Missing fake policy ${id}`);
    return policy;
  }
}

function managedLocations(
  directory: FakeDirectory,
): DropshipEbayManagedLocationProvider {
  const ensure = async () => {
    const location = {
      merchantLocationKey: "cardshellz-dropship-wh-1",
      name: "Card Shellz Dropship - HQ",
      originWarehouseId: 1,
      action: "unchanged" as const,
    };
    directory.discovery = {
      ...directory.discovery,
      merchantLocations: [
        ...directory.discovery.merchantLocations.filter(
          (option) => option.id !== location.merchantLocationKey,
        ),
        { id: location.merchantLocationKey, name: location.name },
      ],
    };
    return location;
  };
  return {
    ensureForStoreConnection: ensure,
    ensureWithAccessToken: ensure,
  };
}

class FakeListingConfig {
  config = makeConfig();
  replaceMember = vi.fn(async (
    _memberId: string,
    _storeConnectionId: number,
    input: NormalizedDropshipStoreListingConfigInput,
  ) => this.replace(input));
  replaceAdmin = vi.fn(async (
    _storeConnectionId: number,
    input: NormalizedDropshipStoreListingConfigInput,
  ) => this.replace(input));

  async getForMember() {
    return this.context();
  }

  async getForAdmin() {
    return this.context();
  }

  async replaceForMember(
    memberId: string,
    storeConnectionId: number,
    input: NormalizedDropshipStoreListingConfigInput,
  ) {
    return this.replaceMember(memberId, storeConnectionId, input);
  }

  async replaceForAdmin(
    storeConnectionId: number,
    input: NormalizedDropshipStoreListingConfigInput,
  ) {
    return this.replaceAdmin(storeConnectionId, input);
  }

  private context() {
    return {
      vendor: { vendorId: 10 },
      storeConnection: {
        vendorId: 10,
        storeConnectionId: 44,
        platform: "ebay" as const,
        status: "connected" as const,
        setupStatus: "ready",
      },
      config: this.config,
    };
  }

  private replace(input: NormalizedDropshipStoreListingConfigInput) {
    this.config = {
      ...this.config,
      ...input,
      marketplaceConfig: { ...input.marketplaceConfig },
      requiredConfigKeys: [...input.requiredConfigKeys],
      requiredProductFields: [...input.requiredProductFields],
      updatedAt: now,
    };
    return { ...this.context(), config: this.config };
  }
}

function makeConfig(
  marketplaceConfig: Record<string, unknown> = {
    marketplaceId: "EBAY_US",
    unrelatedSetting: "preserved",
    businessPolicies: { unrelatedPolicySetting: "preserved" },
  },
): DropshipStoreListingConfigRecord {
  return {
    id: 9,
    storeConnectionId: 44,
    platform: "ebay",
    ...buildDefaultDropshipStoreListingConfig("ebay"),
    marketplaceConfig,
    createdAt: now,
    updatedAt: now,
  };
}

function fulfillmentPolicy(id: string, name: string): DropshipEbayFulfillmentPolicy {
  return {
    id,
    name,
    marketplaceId: "EBAY_US",
    handlingTime: { value: 1, unit: "DAY" },
    shippingOptions: [{ optionType: "DOMESTIC", shippingServiceCodes: ["USPSParcel"] }],
    localPickup: false,
    freightShipping: false,
    pickupDropOff: false,
  };
}

function capability(): DropshipEbayFulfillmentCapability {
  return {
    marketplaceId: "EBAY_US",
    requiredHandlingTimeBusinessDays: 1,
    destinationCountry: "US",
    destinationRegions: ["CA"],
    destinationCoverageComplete: true,
    supportedServices: [{
      carrier: "USPS",
      ebayServiceCode: "USPSParcel",
      serviceName: "USPS Ground Advantage",
      shipStationCarrierCode: "usps",
      shipStationServiceCode: "usps_ground_advantage",
    }],
    evidenceHash: "capability-hash",
    source: {
      omsChannelId: 103,
      originWarehouseId: 1,
      rateBookId: 34,
      rateBookCode: "dropship-vendor-default",
      rateTableId: 5,
      serviceLevelId: 7,
      fulfillmentRoutingRevision: 4,
    },
  };
}
