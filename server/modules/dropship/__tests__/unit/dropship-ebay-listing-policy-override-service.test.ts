import { describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import type {
  DropshipEbayFulfillmentCapability,
  DropshipEbayFulfillmentPolicy,
} from "../../domain/ebay-fulfillment-policy-compatibility";
import {
  DropshipEbayListingSetupService,
  type DropshipEbayListingSetupDirectory,
  type DropshipEbayListingSetupDiscovery,
  type DropshipEbayListingSetupResult,
} from "../../application/dropship-ebay-listing-setup-service";
import {
  buildDefaultDropshipStoreListingConfig,
  decideDropshipListingConfigAccess,
  type DropshipStoreListingConfigRecord,
} from "../../application/dropship-listing-config-service";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipEbayListingPolicyOverrideService,
  hashEbayListingPolicyOverride,
  type DropshipEbayListingPolicyOverride,
  type DropshipEbayListingPolicyOverrideContext,
  type DropshipEbayListingPolicyOverrideRepository,
  type ReplaceDropshipEbayListingPolicyOverrideRepositoryInput,
  type ReplaceDropshipEbayListingPoliciesRepositoryInput,
} from "../../application/dropship-ebay-listing-policy-override-service";
import type { DropshipVendorProvisioningService } from "../../application/dropship-vendor-provisioning-service";

const NOW = new Date("2026-09-01T15:00:00.000Z");

describe("DropshipEbayListingPolicyOverrideService", () => {
  it("validates the entire batch once, sorts targets, and preserves independent choices", async () => {
    const fixture = makeFixture();
    const request = bulkInput();
    const original = structuredClone(request);

    await fixture.service.replaceManyForMember("member-1", request);

    expect(request).toEqual(original);
    expect(fixture.listingSetup.getForMember).toHaveBeenCalledTimes(1);
    expect(fixture.repository.lastBulkInput).toMatchObject({
      vendorId: 10,
      storeConnectionId: 44,
      idempotencyKey: request.idempotencyKey,
      actor: { actorType: "vendor", actorId: "member-1" },
      now: NOW,
      assignments: [request.assignments[1], request.assignments[0]],
    });
    expect(fixture.repository.lastBulkInput?.requestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("canonicalizes ordering but binds the hash to all targets, choices, and revisions", async () => {
    const fixture = makeFixture();
    const request = bulkInput();
    await fixture.service.replaceManyForMember("member-1", request);
    const hash = fixture.repository.lastBulkInput?.requestHash;
    await fixture.service.replaceManyForMember("member-1", { ...request, assignments: [...request.assignments].reverse() });
    expect(fixture.repository.lastBulkInput?.requestHash).toBe(hash);

    for (const update of [
      { productVariantId: 503 },
      { expectedRevisionId: 99 },
      { fulfillmentPolicyId: "fulfillment-default" },
      { returnPolicyId: "return-default" },
      { paymentPolicyId: "payment-default" },
    ]) {
      await fixture.service.replaceManyForMember("member-1", {
        ...request, assignments: [{ ...request.assignments[0], ...update }, request.assignments[1]],
      });
      expect(fixture.repository.lastBulkInput?.requestHash).not.toBe(hash);
    }
  });

  it.each(["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"] as const)(
    "rejects a bad %s on any row before any persistence",
    async (field) => {
      const fixture = makeFixture();
      const request = bulkInput();
      request.assignments[0][field] = "missing-policy";
      await expect(fixture.service.replaceManyForMember("member-1", request)).rejects.toMatchObject({
        code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_INVALID",
        context: { productVariantId: 502, invalidFields: [field] },
      });
      expect(fixture.repository.lastBulkInput).toBeNull();
    },
  );

  it("rejects an incompatible policy in a bulk operation", async () => {
    const fixture = makeFixture();
    const request = bulkInput();
    request.assignments[0].fulfillmentPolicyId = "fulfillment-incompatible";
    await expect(fixture.service.replaceManyForMember("member-1", request)).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_INVALID",
    });
    expect(fixture.repository.lastBulkInput).toBeNull();
  });

  it.each(["missing", "disconnected", "needs_reauth", "paused", "grace_period", "wrong-platform"])("rejects a %s store before loading options", async (state) => {
    const fixture = makeFixture();
    if (state === "missing") fixture.repository.context = null;
    else if (state === "wrong-platform") fixture.repository.context!.platform = "shopify";
    else fixture.repository.context!.status = state;
    await expect(fixture.service.replaceManyForMember("member-1", bulkInput())).rejects.toBeInstanceOf(Error);
    if (state === "needs_reauth") {
      await expect(fixture.service.listForMember("member-1", { storeConnectionId: 44 }))
        .rejects.toMatchObject({ code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED" });
    }
    expect(fixture.listingSetup.getForMember).not.toHaveBeenCalled();
    expect(fixture.repository.lastBulkInput).toBeNull();
  });

  it("allows recoverable token health to reach listing-setup credential recovery", async () => {
    const fixture = makeFixture();
    fixture.repository.context!.status = "refresh_failed";
    await fixture.service.replaceManyForMember("member-1", bulkInput());
    expect(fixture.listingSetup.getForMember).toHaveBeenCalledTimes(1);
    expect(fixture.repository.lastBulkInput).not.toBeNull();
  });

  it("rejects empty, oversized, duplicate, incomplete, unsafe, or unrecognized batch inputs", async () => {
    const fixture = makeFixture();
    const request = bulkInput();
    const invalid = [
      { ...request, assignments: [] },
      { ...request, assignments: Array.from({ length: 501 }, (_, index) => ({ ...request.assignments[0], productVariantId: index + 1 })) },
      { ...request, assignments: [request.assignments[0], request.assignments[0]] },
      { ...request, assignments: [{ productVariantId: 501 }] },
      { ...request, assignments: [{ ...request.assignments[0], productVariantId: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...request, assignments: [{ ...request.assignments[0], vendorId: 99 }] },
      { ...request, idempotencyKey: "" },
      { ...request, vendorId: 99 },
    ];
    for (const input of invalid) {
      await expect(fixture.service.replaceManyForMember("member-1", input)).rejects.toMatchObject({ name: "ZodError" });
    }
    expect(fixture.listingSetup.getForMember).not.toHaveBeenCalled();
    expect(fixture.repository.lastBulkInput).toBeNull();
  });

  it("accepts the maximum batch and explicit inheritance even without store defaults", async () => {
    const fixture = makeFixture();
    const setup = setupResult();
    setup.selection.fulfillmentPolicyId = null;
    setup.selection.returnPolicyId = null;
    setup.selection.paymentPolicyId = null;
    setup.complete = false;
    fixture.listingSetup.getForMember.mockResolvedValue(setup);
    const request = bulkInput();
    request.assignments = Array.from({ length: 500 }, (_, index) => ({
      productVariantId: index + 1, expectedRevisionId: null,
      fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null,
    }));
    await expect(fixture.service.replaceManyForMember("member-1", request)).resolves.toMatchObject({ idempotentReplay: false });
    expect(fixture.repository.lastBulkInput?.assignments).toHaveLength(500);
  });

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

  it("fails closed on a fulfillment policy that was never checked, should such a setup reach validation", async () => {
    // getForMember throws when Card Shellz shipping can't be read, so this
    // setup does not reach the override path today. If it ever did, an
    // unchecked policy is not compatible and the override is refused.
    const fixture = makeFixture();
    fixture.listingSetup.getForMember.mockResolvedValue(setupResultWithoutShippingCheck());

    await expect(fixture.service.replaceForMember("member-1", {
      storeConnectionId: 44,
      productVariantId: 501,
      fulfillmentPolicyId: "fulfillment-compatible",
      returnPolicyId: null,
      paymentPolicyId: null,
      idempotencyKey: "listing-policy-004",
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_INVALID",
      context: { productVariantId: 501, invalidFields: ["fulfillmentPolicyId"] },
    });
    await expect(fixture.service.replaceManyForMember("member-1", bulkInput())).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_INVALID",
      context: { productVariantId: 502, invalidFields: ["fulfillmentPolicyId"] },
    });
    expect(fixture.repository.lastReplaceInput).toBeNull();
    expect(fixture.repository.lastBulkInput).toBeNull();
  });

  it("passes the listing settings read-only refusal through before any persistence", async () => {
    // getForMember refuses read-only setups (closed, lapsed or suspended
    // vendors) instead of returning a view, so per-size writers cannot save.
    const fixture = makeFixture();
    const readOnly = new DropshipError(
      "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
      "Dropship vendor status does not allow listing configuration changes.",
      { vendorId: 10, storeConnectionId: 44, retryable: false },
    );
    fixture.listingSetup.getForMember.mockRejectedValue(readOnly);

    await expect(fixture.service.replaceForMember("member-1", {
      storeConnectionId: 44,
      productVariantId: 501,
      fulfillmentPolicyId: "fulfillment-compatible",
      returnPolicyId: null,
      paymentPolicyId: null,
      idempotencyKey: "listing-policy-006",
    })).rejects.toBe(readOnly);
    await expect(fixture.service.replaceManyForMember("member-1", bulkInput())).rejects.toBe(readOnly);
    await expect(fixture.service.listForMember("member-1", { storeConnectionId: 44 })).rejects.toBe(readOnly);
    expect(fixture.repository.lastReplaceInput).toBeNull();
    expect(fixture.repository.lastBulkInput).toBeNull();
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
  lastBulkInput: ReplaceDropshipEbayListingPoliciesRepositoryInput | null = null;

  async replaceAssignments(input: ReplaceDropshipEbayListingPoliciesRepositoryInput) {
    this.lastBulkInput = input;
    return { results: [], idempotentReplay: false };
  }

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
        { id: "fulfillment-default", name: "Default", compatible: true, compatibilityChecked: true, compatibilityIssues: [] },
        { id: "fulfillment-compatible", name: "Compatible", compatible: true, compatibilityChecked: true, compatibilityIssues: [] },
        {
          id: "fulfillment-incompatible",
          name: "Too fast",
          compatible: false,
          compatibilityChecked: true,
          compatibilityIssues: [{ code: "handling_time_too_short", message: "Too fast." }],
        },
      ],
      returnPolicies: [
        { id: "return-default", name: "Default" },
        { id: "return-override", name: "Override" },
      ],
      paymentPolicies: [{ id: "payment-default", name: "Default" }],
    },
    revision: 3,
    access: { canEdit: true, reason: null },
    checks: { ebay: "checked", fulfillment: { status: "checked" } },
    storedNames: {
      fulfillmentPolicyName: "Default",
      returnPolicyName: "Default",
      paymentPolicyName: "Default",
    },
    storeShelfDefault: null,
  };
}

/**
 * A setup whose Card Shellz shipping could not be read, as the page read
 * (getViewForMember) reports it: eBay's lists are current, but no fulfillment
 * policy was judged, so each one is unchecked and not compatible.
 * getForMember never answers this way; it throws the shipping failure instead.
 */
function setupResultWithoutShippingCheck(): DropshipEbayListingSetupResult {
  const setup = setupResult();
  return {
    ...setup,
    complete: false,
    fulfillmentCapability: null,
    checks: {
      ebay: "checked",
      fulfillment: { status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", kind: "temporary" },
    },
    options: {
      ...setup.options,
      fulfillmentPolicies: setup.options.fulfillmentPolicies.map((policy) => ({
        id: policy.id,
        name: policy.name,
        compatible: false,
        compatibilityChecked: false,
        compatibilityIssues: [],
      })),
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
    getSavedSelectionForMember: vi.fn(async () => setupResult().selection),
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

describe("saved eBay policy display is independent from verification", () => {
  it("classifies corrupt stored assignments as an internal response failure, not bad user input", async () => {
    const fixture = makeFixture();
    fixture.repository.assignments.push({ ...fixture.repository.assignments[0] });
    await expect(fixture.service.listSavedForMember("member-1", { storeConnectionId: 44 }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_SAVED_POLICIES_INVALID" });
    expect(fixture.listingSetup.getForMember).not.toHaveBeenCalled();
    expect(fixture.repository.lastReplaceInput).toBeNull();
  });

  it("returns saved defaults and overrides without any live provider discovery", async () => {
    const fixture = makeFixture();
    fixture.listingSetup.getForMember.mockRejectedValue(new DropshipError("DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", "Provider down."));
    const result = await fixture.service.listSavedForMember("member-1", { storeConnectionId: 44 });
    expect(result).toMatchObject({ storeConnectionId: 44, verification: "not_checked",
      defaults: { fulfillmentPolicyId: "fulfillment-default" },
      assignments: [{ productVariantId: 501, revisionId: 90, fulfillmentPolicyId: "fulfillment-compatible" }] });
    expect(fixture.listingSetup.getForMember).not.toHaveBeenCalled();
    expect(fixture.listingSetup.getSavedSelectionForMember).toHaveBeenCalledExactlyOnceWith("member-1", 44);
    expect(fixture.repository.lastReplaceInput).toBeNull();
  });

  it.each(["needs_reauth", "paused", "disconnected"])("allows display for a %s store but still blocks policy writes", async (status) => {
    const fixture = makeFixture();
    fixture.repository.context!.status = status;
    await expect(fixture.service.listSavedForMember("member-1", { storeConnectionId: 44 })).resolves.toMatchObject({ verification: "not_checked" });
    await expect(fixture.service.replaceManyForMember("member-1", bulkInput())).rejects.toBeInstanceOf(DropshipError);
    expect(fixture.repository.lastBulkInput).toBeNull();
  });

  it("does not expose another vendor's store or a non-eBay store", async () => {
    const fixture = makeFixture();
    fixture.repository.context = null;
    await expect(fixture.service.listSavedForMember("member-1", { storeConnectionId: 44 })).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(fixture.listingSetup.getSavedSelectionForMember).not.toHaveBeenCalled();
    const nonEbay = makeFixture(); nonEbay.repository.context!.platform = "shopify";
    await expect(nonEbay.service.listSavedForMember("member-1", { storeConnectionId: 44 })).rejects.toMatchObject({ code: "DROPSHIP_EBAY_STORE_REQUIRED" });
  });

  it.each([{}, { storeConnectionId: 0 }, { storeConnectionId: 1.2 }])("validates saved read input before accessing the store", async (input) => {
    const fixture = makeFixture();
    await expect(fixture.service.listSavedForMember("member-1", input)).rejects.toThrow();
    expect(fixture.listingSetup.getSavedSelectionForMember).not.toHaveBeenCalled();
  });

  it("continues to reject all writes if live verification fails, even after a successful saved read", async () => {
    const fixture = makeFixture();
    await fixture.service.listSavedForMember("member-1", { storeConnectionId: 44 });
    const outage = new DropshipError("DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", "Provider down.");
    fixture.listingSetup.getForMember.mockRejectedValue(outage);
    await expect(fixture.service.replaceManyForMember("member-1", bulkInput())).rejects.toBe(outage);
    await expect(fixture.service.replaceForMember("member-1", { storeConnectionId: 44, productVariantId: 501,
      expectedRevisionId: 90, fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null,
      idempotencyKey: "failed-live-verification" })).rejects.toBe(outage);
    expect(fixture.repository.lastBulkInput).toBeNull();
    expect(fixture.repository.lastReplaceInput).toBeNull();
  });
});

function bulkInput(): {
  storeConnectionId: number;
  idempotencyKey: string;
  assignments: ReplaceDropshipEbayListingPoliciesRepositoryInput["assignments"];
} {
  return {
    storeConnectionId: 44,
    idempotencyKey: "listing-policy-bulk-001",
    assignments: [
      { productVariantId: 502, expectedRevisionId: null, fulfillmentPolicyId: "fulfillment-compatible", returnPolicyId: "return-override", paymentPolicyId: null },
      { productVariantId: 501, expectedRevisionId: 90, fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: "payment-default" },
    ],
  };
}

/**
 * One Card Shellz shipping failure of each kind the listing setup tells apart
 * (classifyCapabilityFailure): a passing outage, a Card Shellz setup still
 * being finished, and a store on an eBay site Card Shellz does not list on.
 * Built fresh per test so no test sees another's error object.
 */
const CAPABILITY_FAILURES: ReadonlyArray<{
  kind: "temporary" | "setup_incomplete" | "marketplace_unsupported";
  error: () => DropshipError;
}> = [
  {
    kind: "temporary",
    error: () => new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
      "Card Shellz fulfillment routing could not be verified.",
      { serviceLevelId: 7, routingCode: null, retryable: true },
    ),
  },
  {
    kind: "setup_incomplete",
    error: () => new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_RATE_TABLE_REQUIRED",
      "Exactly one active Standard dropship rate table is required.",
      { rateBookId: 34, activeTableIds: [], retryable: false },
    ),
  },
  {
    kind: "marketplace_unsupported",
    error: () => new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED",
      "Card Shellz fulfillment capability validation currently supports EBAY_US only.",
      { storeConnectionId: 44, marketplaceId: "EBAY_US", retryable: false },
    ),
  },
];

describe("per-size overrides on the live listing setup (getForMember)", () => {
  it("saves an override when eBay and Card Shellz shipping were both read", async () => {
    // The control for the refusals below: the same wiring, with shipping read.
    const fixture = makeLiveSetupFixture({ capability: async () => liveCapability() });

    await fixture.service.replaceForMember("member-1", {
      storeConnectionId: 44,
      productVariantId: 501,
      fulfillmentPolicyId: "fulfillment-compatible",
      returnPolicyId: "return-override",
      paymentPolicyId: null,
      idempotencyKey: "listing-policy-live-001",
    });

    expect(fixture.getCapability).toHaveBeenCalledExactlyOnceWith({ storeConnectionId: 44, marketplaceId: "EBAY_US" });
    expect(fixture.repository.lastReplaceInput).toMatchObject({
      productVariantId: 501,
      fulfillmentPolicyId: "fulfillment-compatible",
      returnPolicyId: "return-override",
    });
  });

  it.each(CAPABILITY_FAILURES)(
    "refuses every override with Card Shellz shipping's own error when it is $kind, without writing",
    async ({ error }) => {
      const failure = error();
      const fixture = makeLiveSetupFixture({ capability: async () => { throw failure; } });

      // A fulfillment override, a return/payment-only override, a clear, a
      // bulk save and the live list: none of them goes on without the check.
      await expect(fixture.service.replaceForMember("member-1", {
        storeConnectionId: 44,
        productVariantId: 501,
        fulfillmentPolicyId: "fulfillment-compatible",
        returnPolicyId: null,
        paymentPolicyId: null,
        idempotencyKey: "listing-policy-live-002",
      })).rejects.toBe(failure);
      await expect(fixture.service.replaceForMember("member-1", {
        storeConnectionId: 44,
        productVariantId: 501,
        fulfillmentPolicyId: null,
        returnPolicyId: "return-override",
        paymentPolicyId: "payment-default",
        idempotencyKey: "listing-policy-live-003",
      })).rejects.toBe(failure);
      await expect(fixture.service.replaceForMember("member-1", {
        storeConnectionId: 44,
        productVariantId: 501,
        fulfillmentPolicyId: null,
        returnPolicyId: null,
        paymentPolicyId: null,
        idempotencyKey: "listing-policy-live-004",
      })).rejects.toBe(failure);
      await expect(fixture.service.replaceManyForMember("member-1", bulkInput())).rejects.toBe(failure);
      await expect(fixture.service.listForMember("member-1", { storeConnectionId: 44 })).rejects.toBe(failure);

      expect(fixture.repository.lastReplaceInput).toBeNull();
      expect(fixture.repository.lastBulkInput).toBeNull();
      expect(fixture.getCapability).toHaveBeenCalledTimes(5);
      // Thrown, not shown: the page read's "shown without the shipping check" event is not logged.
      expect(fixture.setupLogs.map((event) => event.code))
        .not.toContain("DROPSHIP_EBAY_LISTING_SETUP_CAPABILITY_UNAVAILABLE");
      fixture.expectNoListingSetupWrites();
    },
  );

  it.each([
    ["an inactive vendor", "closed", "connected", "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED"],
    ["a refresh-failed store of an inactive vendor", "suspended", "refresh_failed", "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED"],
  ] as const)(
    "refuses with the read-only error for %s, before asking eBay or Card Shellz shipping",
    async (_label, vendorStatus, storeStatus, code) => {
      const fixture = makeLiveSetupFixture({ capability: async () => liveCapability(), vendorStatus, storeStatus });

      await expect(fixture.service.replaceForMember("member-1", {
        storeConnectionId: 44,
        productVariantId: 501,
        fulfillmentPolicyId: "fulfillment-compatible",
        returnPolicyId: null,
        paymentPolicyId: null,
        idempotencyKey: "listing-policy-live-005",
      })).rejects.toMatchObject({ code, context: { vendorId: 10, storeConnectionId: 44, retryable: false } });
      await expect(fixture.service.replaceManyForMember("member-1", bulkInput())).rejects.toMatchObject({ code });

      expect(fixture.discover).not.toHaveBeenCalled();
      expect(fixture.getCapability).not.toHaveBeenCalled();
      expect(fixture.repository.lastReplaceInput).toBeNull();
      expect(fixture.repository.lastBulkInput).toBeNull();
      fixture.expectNoListingSetupWrites();
    },
  );
});

/**
 * The override service on the real listing setup service, faked only at the
 * setup's edges: the store's saved listing config, eBay's lists and Card
 * Shellz shipping. The setup's writers, shelves and ship-from location are
 * spies, so a test sees any call to them.
 */
function makeLiveSetupFixture(input: {
  capability: () => Promise<DropshipEbayFulfillmentCapability>;
  vendorStatus?: string;
  storeStatus?: "connected" | "refresh_failed";
}) {
  const vendorStatus = input.vendorStatus ?? "active";
  const storeStatus = input.storeStatus ?? "connected";
  const config: DropshipStoreListingConfigRecord = {
    id: 9,
    storeConnectionId: 44,
    ...buildDefaultDropshipStoreListingConfig("ebay"),
    marketplaceConfig: {
      marketplaceId: "EBAY_US",
      merchantLocationKey: "cardshellz-dropship-wh-1",
      businessPolicies: {
        fulfillmentPolicyId: "fulfillment-default",
        returnPolicyId: "return-default",
        paymentPolicyId: "payment-default",
      },
    },
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const listingConfig = {
    getViewForMember: vi.fn(async (_memberId: string, storeConnectionId: number) => ({
      vendor: { vendorId: 10, status: vendorStatus },
      storeConnection: { vendorId: 10, storeConnectionId, platform: "ebay", status: storeStatus, setupStatus: "ready" },
      config,
      access: decideDropshipListingConfigAccess(vendorStatus, storeStatus),
    })),
    getForMember: vi.fn(),
    findKeyedRequest: vi.fn(),
    findConfig: vi.fn(),
    replaceForMember: vi.fn(),
    getForAdmin: vi.fn(),
    replaceForAdmin: vi.fn(),
  };
  const discovery: DropshipEbayListingSetupDiscovery = {
    marketplaceId: "EBAY_US",
    merchantLocations: [{ id: "cardshellz-dropship-wh-1", name: "Card Shellz Dropship - HQ" }],
    fulfillmentPolicies: [
      ebayFulfillmentPolicy("fulfillment-default", "Default"),
      ebayFulfillmentPolicy("fulfillment-compatible", "Compatible"),
    ],
    returnPolicies: [
      { id: "return-default", name: "Default" },
      { id: "return-override", name: "Override" },
    ],
    paymentPolicies: [{ id: "payment-default", name: "Default" }],
  };
  const discover = vi.fn<DropshipEbayListingSetupDirectory["discoverForStoreConnection"]>(async () => discovery);
  const directory = {
    discoverForStoreConnection: discover,
    discoverWithAccessToken: vi.fn(),
    getFulfillmentPolicyForStoreConnection: vi.fn(),
    getFulfillmentPolicyWithAccessToken: vi.fn(),
  } as unknown as DropshipEbayListingSetupDirectory;
  const getCapability = vi.fn(async (_input: { storeConnectionId: number; marketplaceId: string }) => input.capability());
  const listLeafCategories = vi.fn();
  const ensureForStoreConnection = vi.fn();
  const ensureWithAccessToken = vi.fn();
  const setupLogs: DropshipLogEvent[] = [];
  const listingSetup = new DropshipEbayListingSetupService({
    listingConfig: listingConfig as unknown as ConstructorParameters<typeof DropshipEbayListingSetupService>[0]["listingConfig"],
    directory,
    storeShelves: { listLeafCategories },
    fulfillmentCapabilities: { getForStoreConnection: getCapability },
    managedLocations: { ensureForStoreConnection, ensureWithAccessToken },
    logger: {
      info: (event) => setupLogs.push(event),
      warn: (event) => setupLogs.push(event),
      error: (event) => setupLogs.push(event),
    },
  });
  const repository = new FakeRepository();
  repository.context!.status = storeStatus;
  const vendorProvisioning = {
    provisionForMember: vi.fn(async (memberId: string) => ({
      vendor: { vendorId: 10, memberId },
      created: false,
      changedFields: [],
    })),
  } as unknown as DropshipVendorProvisioningService;
  const service = new DropshipEbayListingPolicyOverrideService({
    vendorProvisioning,
    repository,
    listingSetup,
    clock: { now: () => NOW },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return {
    service,
    repository,
    discover,
    getCapability,
    setupLogs,
    /** The per-size path only reads the store's listing setup; it never saves it. */
    expectNoListingSetupWrites(): void {
      expect(listingConfig.replaceForMember).not.toHaveBeenCalled();
      expect(listingConfig.replaceForAdmin).not.toHaveBeenCalled();
      expect(ensureForStoreConnection).not.toHaveBeenCalled();
      expect(ensureWithAccessToken).not.toHaveBeenCalled();
      expect(listLeafCategories).not.toHaveBeenCalled();
    },
  };
}

/** An eBay fulfillment policy Card Shellz shipping can honour: one handling day, a service it ships. */
function ebayFulfillmentPolicy(id: string, name: string): DropshipEbayFulfillmentPolicy {
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

function liveCapability(): DropshipEbayFulfillmentCapability {
  return {
    ...setupResult().fulfillmentCapability!,
    supportedServices: [{
      carrier: "USPS",
      ebayServiceCode: "USPSParcel",
      serviceName: "USPS Ground Advantage",
      shipStationCarrierCode: "usps",
      shipStationServiceCode: "usps_ground_advantage",
    }],
  };
}
