import { describe, expect, it, vi } from "vitest";
import type { DropshipEbayListingSetupResult } from "../../application/dropship-ebay-listing-setup-service";
import {
  DropshipEbayListingPolicyOverrideService,
  hashEbayListingPolicyOverride,
  type DropshipEbayListingPolicyOverride,
  type DropshipEbayListingPolicyOverrideContext,
  type DropshipEbayListingPolicyOverrideRepository,
  type ReplaceDropshipEbayListingPolicyOverrideRepositoryInput,
} from "../../application/dropship-ebay-listing-policy-override-service";
import type { DropshipVendorProvisioningService } from "../../application/dropship-vendor-provisioning-service";

const NOW = new Date("2026-09-01T15:00:00.000Z");

describe("DropshipEbayListingPolicyOverrideService", () => {
  it("lists store defaults, current options, and store-variant overrides", async () => {
    const fixture = makeFixture();

    const result = await fixture.service.listForMember("member-1", { storeConnectionId: 44 });

    expect(result).toMatchObject({
      storeConnectionId: 44,
      defaults: {
        fulfillmentPolicyId: "fulfillment-default",
        returnPolicyId: "return-default",
        paymentPolicyId: "payment-default",
      },
      assignments: fixture.repository.assignments,
      fetchedAt: NOW,
    });
  });

  it("validates and persists a compatible listing-level policy override", async () => {
    const fixture = makeFixture();

    await fixture.service.replaceForMember("member-1", {
      storeConnectionId: 44,
      productVariantId: 501,
      fulfillmentPolicyId: "fulfillment-compatible",
      returnPolicyId: "return-override",
      paymentPolicyId: null,
      idempotencyKey: "listing-policy-001",
    });

    expect(fixture.repository.lastReplaceInput).toEqual({
      vendorId: 10,
      storeConnectionId: 44,
      productVariantId: 501,
      expectedRevisionId: null,
      fulfillmentPolicyId: "fulfillment-compatible",
      returnPolicyId: "return-override",
      paymentPolicyId: null,
      idempotencyKey: "listing-policy-001",
      requestHash: hashEbayListingPolicyOverride({
        storeConnectionId: 44,
        productVariantId: 501,
        expectedRevisionId: null,
        fulfillmentPolicyId: "fulfillment-compatible",
        returnPolicyId: "return-override",
        paymentPolicyId: null,
      }),
      actor: { actorType: "vendor", actorId: "member-1" },
      now: NOW,
    });
  });

  it("rejects an incompatible fulfillment policy before persistence", async () => {
    const fixture = makeFixture();

    await expect(fixture.service.replaceForMember("member-1", {
      storeConnectionId: 44,
      productVariantId: 501,
      fulfillmentPolicyId: "fulfillment-incompatible",
      returnPolicyId: null,
      paymentPolicyId: null,
      idempotencyKey: "listing-policy-002",
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_INVALID",
      context: { invalidFields: ["fulfillmentPolicyId"] },
    });
    expect(fixture.repository.lastReplaceInput).toBeNull();
  });

  it("accepts three null policy ids to clear the listing override", async () => {
    const fixture = makeFixture();

    const result = await fixture.service.replaceForMember("member-1", {
      storeConnectionId: 44,
      productVariantId: 501,
      fulfillmentPolicyId: null,
      returnPolicyId: null,
      paymentPolicyId: null,
      idempotencyKey: "listing-policy-003",
    });

    expect(result.assignment).toBeNull();
    expect(fixture.repository.lastReplaceInput).toMatchObject({
      fulfillmentPolicyId: null,
      returnPolicyId: null,
      paymentPolicyId: null,
    });
  });
});

class FakeRepository implements DropshipEbayListingPolicyOverrideRepository {
  context: DropshipEbayListingPolicyOverrideContext | null = {
    vendorId: 10,
    storeConnectionId: 44,
    platform: "ebay",
    status: "connected",
  };
  assignments: DropshipEbayListingPolicyOverride[] = [{
    productVariantId: 501,
    revisionId: 90,
    fulfillmentPolicyId: "fulfillment-compatible",
    returnPolicyId: null,
    paymentPolicyId: null,
    updatedAt: NOW,
  }];
  lastReplaceInput: ReplaceDropshipEbayListingPolicyOverrideRepositoryInput | null = null;

  async loadStoreContext() {
    return this.context;
  }

  async listAssignments() {
    return this.assignments;
  }

  async replaceAssignment(input: ReplaceDropshipEbayListingPolicyOverrideRepositoryInput) {
    this.lastReplaceInput = input;
    const assignment = input.fulfillmentPolicyId === null
      && input.returnPolicyId === null
      && input.paymentPolicyId === null
      ? null
      : {
          productVariantId: input.productVariantId,
          revisionId: 91,
          fulfillmentPolicyId: input.fulfillmentPolicyId,
          returnPolicyId: input.returnPolicyId,
          paymentPolicyId: input.paymentPolicyId,
          updatedAt: input.now,
        };
    return { assignment, revisionId: 91, idempotentReplay: false };
  }
}

function setupResult(): DropshipEbayListingSetupResult {
  return {
    storeConnectionId: 44,
    marketplaceId: "EBAY_US",
    complete: true,
    missingFields: [],
    fulfillmentCapability: {
      marketplaceId: "EBAY_US",
      requiredHandlingTimeBusinessDays: 1,
      destinationCountry: "US",
      destinationRegions: ["NY"],
      destinationCoverageComplete: true,
      supportedServices: [],
      evidenceHash: "evidence",
      source: {
        omsChannelId: 103,
        originWarehouseId: 1,
        rateBookId: 34,
        rateBookCode: "dropship-vendor-default",
        rateTableId: 5,
        serviceLevelId: 7,
        fulfillmentRoutingRevision: 4,
      },
    },
    selection: {
      merchantLocationKey: "managed-location",
      fulfillmentPolicyId: "fulfillment-default",
      returnPolicyId: "return-default",
      paymentPolicyId: "payment-default",
    },
    options: {
      merchantLocations: [{ id: "managed-location", name: "Managed" }],
      fulfillmentPolicies: [
        { id: "fulfillment-default", name: "Default", compatible: true, compatibilityIssues: [] },
        { id: "fulfillment-compatible", name: "Compatible", compatible: true, compatibilityIssues: [] },
        {
          id: "fulfillment-incompatible",
          name: "Too fast",
          compatible: false,
          compatibilityIssues: [{ code: "handling_time_too_short", message: "Too fast." }],
        },
      ],
      returnPolicies: [
        { id: "return-default", name: "Default" },
        { id: "return-override", name: "Override" },
      ],
      paymentPolicies: [{ id: "payment-default", name: "Default" }],
    },
  };
}

function makeFixture() {
  const repository = new FakeRepository();
  const vendorProvisioning = {
    provisionForMember: vi.fn(async (memberId: string) => ({
      vendor: { vendorId: 10, memberId },
      created: false,
      changedFields: [],
    })),
  } as unknown as DropshipVendorProvisioningService;
  const listingSetup = {
    getForMember: vi.fn(async () => setupResult()),
  };
  const service = new DropshipEbayListingPolicyOverrideService({
    vendorProvisioning,
    repository,
    listingSetup,
    clock: { now: () => NOW },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { service, repository, listingSetup };
}
