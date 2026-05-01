import { beforeEach, describe, expect, it } from "vitest";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE,
  DROPSHIP_DEFAULT_LISTING_MODE,
  DROPSHIP_DEFAULT_LISTING_PRICE_MODE,
  DropshipListingConfigService,
  type DropshipListingConfigRepository,
  type DropshipListingConfigStoreConnectionContext,
  type DropshipStoreListingConfigRecord,
  type EnsureDropshipStoreListingConfigRepositoryInput,
  type ReplaceDropshipStoreListingConfigRepositoryInput,
} from "../../application/dropship-listing-config-service";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "../../application/dropship-vendor-provisioning-service";

const now = new Date("2026-05-01T18:30:00.000Z");

describe("DropshipListingConfigService", () => {
  let repository: FakeListingConfigRepository;
  let vendorProvisioning: FakeVendorProvisioningService;
  let logs: DropshipLogEvent[];
  let service: DropshipListingConfigService;

  beforeEach(() => {
    repository = new FakeListingConfigRepository();
    vendorProvisioning = new FakeVendorProvisioningService();
    logs = [];
    service = new DropshipListingConfigService({
      vendorProvisioning: vendorProvisioning as unknown as DropshipVendorProvisioningService,
      repository,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
    });
  });

  it("ensures a neutral listing config for a connected store", async () => {
    const result = await service.getForMember("member-1", 22);

    expect(result.config).toMatchObject({
      storeConnectionId: 22,
      platform: "shopify",
      listingMode: DROPSHIP_DEFAULT_LISTING_MODE,
      inventoryMode: DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE,
      priceMode: DROPSHIP_DEFAULT_LISTING_PRICE_MODE,
      marketplaceConfig: {},
      requiredConfigKeys: [],
      requiredProductFields: [],
      isActive: true,
    });
    expect(repository.lastEnsureInput).toMatchObject({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
      actor: { actorType: "vendor", actorId: "member-1" },
    });
  });

  it("replaces listing config with normalized required keys and fields", async () => {
    const result = await service.replaceForMember("member-1", 22, {
      listingMode: "live",
      inventoryMode: "manual_quantity",
      priceMode: "vendor_defined",
      marketplaceConfig: { fulfillmentPolicyId: "fulfillment-1" },
      requiredConfigKeys: [" fulfillmentPolicyId ", "fulfillmentPolicyId", "payment.policy"],
      requiredProductFields: ["sku", "brand", "sku"],
      isActive: true,
    });

    expect(result.config).toMatchObject({
      listingMode: "live",
      inventoryMode: "manual_quantity",
      priceMode: "vendor_defined",
      marketplaceConfig: { fulfillmentPolicyId: "fulfillment-1" },
      requiredConfigKeys: ["fulfillmentPolicyId", "payment.policy"],
      requiredProductFields: ["sku", "brand"],
    });
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_LISTING_CONFIG_REPLACED" });
  });

  it("blocks updates for disconnected stores", async () => {
    repository.storeConnection = {
      ...repository.storeConnection,
      status: "disconnected",
    };

    await expect(service.replaceForMember("member-1", 22, {
      listingMode: "draft_first",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      marketplaceConfig: {},
      requiredConfigKeys: [],
      requiredProductFields: [],
      isActive: true,
    })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED" });
  });

  it("rejects unsupported required product fields at the boundary", async () => {
    await expect(service.replaceForMember("member-1", 22, {
      listingMode: "draft_first",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      marketplaceConfig: {},
      requiredConfigKeys: [],
      requiredProductFields: ["unknownField"],
      isActive: true,
    })).rejects.toMatchObject({ issues: expect.any(Array) });
  });
});

class FakeVendorProvisioningService {
  vendor = makeVendor();

  async provisionForMember(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    return {
      vendor: { ...this.vendor, memberId },
      created: false,
      changedFields: [],
    };
  }
}

class FakeListingConfigRepository implements DropshipListingConfigRepository {
  storeConnection: DropshipListingConfigStoreConnectionContext = {
    vendorId: 10,
    storeConnectionId: 22,
    platform: "shopify",
    status: "connected",
    setupStatus: "pending",
  };
  config: DropshipStoreListingConfigRecord | null = null;
  lastEnsureInput: EnsureDropshipStoreListingConfigRepositoryInput | null = null;

  async loadStoreConnectionContext(): Promise<DropshipListingConfigStoreConnectionContext | null> {
    return this.storeConnection;
  }

  async ensureDefaultConfig(
    input: EnsureDropshipStoreListingConfigRepositoryInput,
  ): Promise<DropshipStoreListingConfigRecord> {
    this.lastEnsureInput = input;
    this.config ??= {
      id: 1,
      storeConnectionId: input.storeConnectionId,
      platform: input.platform,
      listingMode: DROPSHIP_DEFAULT_LISTING_MODE,
      inventoryMode: DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE,
      priceMode: DROPSHIP_DEFAULT_LISTING_PRICE_MODE,
      marketplaceConfig: {},
      requiredConfigKeys: [],
      requiredProductFields: [],
      isActive: true,
      createdAt: input.now,
      updatedAt: input.now,
    };
    return this.config;
  }

  async replaceConfig(
    input: ReplaceDropshipStoreListingConfigRepositoryInput,
  ): Promise<DropshipStoreListingConfigRecord> {
    this.config = {
      id: 1,
      storeConnectionId: input.storeConnectionId,
      platform: input.platform,
      listingMode: input.config.listingMode,
      inventoryMode: input.config.inventoryMode,
      priceMode: input.config.priceMode,
      marketplaceConfig: input.config.marketplaceConfig,
      requiredConfigKeys: input.config.requiredConfigKeys,
      requiredProductFields: input.config.requiredProductFields,
      isActive: input.config.isActive,
      createdAt: now,
      updatedAt: input.now,
    };
    return this.config;
  }
}

function makeVendor(overrides: Partial<DropshipProvisionedVendorProfile> = {}): DropshipProvisionedVendorProfile {
  return {
    vendorId: 10,
    memberId: "member-1",
    currentSubscriptionId: "sub-1",
    currentPlanId: "ops-plan",
    businessName: "Vendor LLC",
    contactName: "Vendor User",
    email: "vendor@cardshellz.com",
    phone: null,
    status: "active",
    entitlementStatus: "active",
    entitlementCheckedAt: now,
    membershipGraceEndsAt: null,
    includedStoreConnections: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
