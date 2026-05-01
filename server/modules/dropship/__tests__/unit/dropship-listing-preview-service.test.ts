import { beforeEach, describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipListingPreviewService,
  hashListingPushJobRequest,
  type CreateDropshipListingPushJobRepositoryInput,
  type CreateDropshipListingPushJobRepositoryResult,
  type DropshipExistingVendorListing,
  type DropshipListingCatalogCandidate,
  type DropshipListingPackageReadiness,
  type DropshipListingPreviewRepository,
  type DropshipListingStoreContext,
  type DropshipListingPushJobItemRecord,
  type DropshipListingPushJobRecord,
  type DropshipPricingPolicyRecord,
} from "../../application/dropship-listing-preview-service";
import type {
  DropshipAtpProvider,
} from "../../application/dropship-selection-atp-service";
import type { DropshipStoreListingConfig } from "../../application/dropship-marketplace-listing-provider";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "../../application/dropship-vendor-provisioning-service";
import type { DropshipCatalogExposureRule } from "../../domain/catalog-exposure";
import type {
  DropshipVendorSelectionRule,
  DropshipVendorVariantOverride,
} from "../../domain/vendor-selection";
import { ConfigDrivenDropshipMarketplaceListingProvider } from "../../infrastructure/dropship-config-driven-marketplace-listing.provider";

const now = new Date("2026-05-01T17:30:00.000Z");

describe("DropshipListingPreviewService", () => {
  let repository: FakeListingPreviewRepository;
  let logs: DropshipLogEvent[];
  let service: DropshipListingPreviewService;

  beforeEach(() => {
    repository = new FakeListingPreviewRepository();
    logs = [];
    service = new DropshipListingPreviewService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      atp: new FakeAtpProvider(),
      marketplaceListing: new ConfigDrivenDropshipMarketplaceListingProvider(),
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
    });
  });

  it("builds a ready listing preview from store connection listing config", async () => {
    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    });

    expect(result.summary).toEqual({ total: 1, ready: 1, blocked: 0, warning: 0 });
    expect(result.rows[0]).toMatchObject({
      productVariantId: 101,
      platform: "tiktok",
      listingMode: "live",
      previewStatus: "ready",
      priceCents: 1299,
      marketplaceQuantity: 4,
      blockers: [],
      warnings: [],
    });
    expect(result.rows[0]?.listingIntent).toMatchObject({
      platform: "tiktok",
      listingMode: "live",
      inventoryMode: "managed_quantity_sync",
      priceMode: "vendor_defined",
      productVariantId: 101,
      priceCents: 1299,
      quantity: 4,
    });
  });

  it("blocks from missing connection listing config instead of hardcoded marketplace rules", async () => {
    repository.config = null;

    const result = await service.previewForMember("member-1", {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    });

    expect(result.rows[0]?.previewStatus).toBe("blocked");
    expect(result.rows[0]?.blockers).toContain("listing_config_required");
    expect(result.rows[0]?.blockers).not.toContain("platform_not_supported");
  });

  it("creates listing push jobs idempotently and rejects request drift", async () => {
    const input = {
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
      idempotencyKey: "listing-job-001",
    };

    const first = await service.createListingPushJobForMember("member-1", input);
    const second = await service.createListingPushJobForMember("member-1", input);

    expect(first.job.status).toBe("queued");
    expect(first.idempotentReplay).toBe(false);
    expect(second.job.jobId).toBe(first.job.jobId);
    expect(second.idempotentReplay).toBe(true);
    expect(repository.jobs[0]?.requestHash).toBe(hashListingPushJobRequest({
      vendorId: 10,
      storeConnectionId: 22,
      productVariantIds: [101],
      requestedRetailPriceCents: 1299,
    }));
    expect(logs.map((event) => event.code)).toEqual([
      "DROPSHIP_LISTING_PUSH_JOB_CREATED",
      "DROPSHIP_LISTING_PUSH_JOB_REPLAYED",
    ]);

    await expect(service.createListingPushJobForMember("member-1", {
      ...input,
      requestedRetailPriceCents: 1499,
    })).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
  });
});

class FakeVendorProvisioningService {
  async provisionForMember(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    return {
      vendor: makeVendor({ memberId }),
      created: false,
      changedFields: [],
    };
  }
}

class FakeAtpProvider implements DropshipAtpProvider {
  async getBaseAtpByProductIds(): Promise<Map<number, number>> {
    return new Map([[501, 12]]);
  }
}

class FakeListingPreviewRepository implements DropshipListingPreviewRepository {
  context: DropshipListingStoreContext = {
    vendorId: 10,
    vendorStatus: "active",
    entitlementStatus: "active",
    storeConnectionId: 22,
    storeStatus: "connected",
    setupStatus: "ready",
    platform: "tiktok",
  };
  config: DropshipStoreListingConfig | null = {
    id: 7,
    storeConnectionId: 22,
    platform: "tiktok",
    listingMode: "live",
    inventoryMode: "managed_quantity_sync",
    priceMode: "vendor_defined",
    marketplaceConfig: { profileId: "profile-1" },
    requiredConfigKeys: ["profileId"],
    requiredProductFields: ["description", "brand"],
    isActive: true,
  };
  jobs: DropshipListingPushJobRecord[] = [];

  async loadStoreContext(): Promise<DropshipListingStoreContext | null> {
    return this.context;
  }

  async getStoreListingConfig(): Promise<DropshipStoreListingConfig | null> {
    return this.config;
  }

  async listCatalogExposureRules(): Promise<DropshipCatalogExposureRule[]> {
    return [{ id: 1, scopeType: "catalog", action: "include" }];
  }

  async listSelectionRules(): Promise<DropshipVendorSelectionRule[]> {
    return [{
      id: 2,
      scopeType: "catalog",
      action: "include",
      autoConnectNewSkus: true,
      autoListNewSkus: true,
      isActive: true,
    }];
  }

  async listCatalogCandidates(): Promise<DropshipListingCatalogCandidate[]> {
    return [makeCandidate()];
  }

  async listVariantOverrides(): Promise<DropshipVendorVariantOverride[]> {
    return [{ productVariantId: 101, marketplaceQuantityCap: 4 }];
  }

  async listExistingListings(): Promise<DropshipExistingVendorListing[]> {
    return [];
  }

  async listPricingPolicies(): Promise<DropshipPricingPolicyRecord[]> {
    return [];
  }

  async getPackageReadiness(): Promise<Map<number, DropshipListingPackageReadiness>> {
    return new Map([[101, {
      hasPackageProfile: true,
      hasActiveBox: true,
      hasActiveRateTable: true,
    }]]);
  }

  async createListingPushJob(
    input: CreateDropshipListingPushJobRepositoryInput,
  ): Promise<CreateDropshipListingPushJobRepositoryResult> {
    const existingJob = this.jobs.find((job) => job.idempotencyKey === input.idempotencyKey);
    if (existingJob) {
      if (existingJob.requestHash !== input.requestHash) {
        throw new DropshipError(
          "DROPSHIP_IDEMPOTENCY_CONFLICT",
          "Dropship listing push job idempotency key was reused with a different request.",
        );
      }
      return {
        job: existingJob,
        items: [makeJobItem(existingJob.jobId, input.preview.rows[0]?.previewHash ?? null)],
        idempotentReplay: true,
      };
    }

    const job: DropshipListingPushJobRecord = {
      jobId: this.jobs.length + 1,
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      status: input.preview.summary.ready + input.preview.summary.warning > 0 ? "queued" : "failed",
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.jobs.push(job);
    return {
      job,
      items: [makeJobItem(job.jobId, input.preview.rows[0]?.previewHash ?? null)],
      idempotentReplay: false,
    };
  }
}

function makeCandidate(): DropshipListingCatalogCandidate {
  return {
    productId: 501,
    productVariantId: 101,
    productLineIds: [9],
    category: "Protectors",
    productIsActive: true,
    variantIsActive: true,
    unitsPerVariant: 3,
    defaultRetailPriceCents: 1199,
    sku: "CS-TOPLOADER-35PT",
    productName: "Toploader",
    variantName: "35pt",
    title: "Card Shellz Toploader 35pt",
    description: "Rigid card protection for standard trading cards.",
    brand: "Card Shellz",
    gtin: "000000000101",
    mpn: "TL35",
    condition: "new",
    itemSpecifics: { size: "35pt" },
    imageUrls: ["https://cdn.example.test/toploader.jpg"],
  };
}

function makeJobItem(jobId: number, previewHash: string | null): DropshipListingPushJobItemRecord {
  return {
    itemId: 1,
    jobId,
    listingId: 100,
    productVariantId: 101,
    status: "queued",
    previewHash,
    errorCode: null,
    errorMessage: null,
  };
}

function makeVendor(input: { memberId: string }): DropshipProvisionedVendorProfile {
  return {
    vendorId: 10,
    memberId: input.memberId,
    currentSubscriptionId: "sub-1",
    currentPlanId: "ops",
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
  };
}
