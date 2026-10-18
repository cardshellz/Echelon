import { describe, expect, it, vi } from "vitest";
import type { DropshipEbayFulfillmentCapabilityProvider } from "../../application/dropship-ebay-fulfillment-capability-service";
import {
  CHECKED_LISTING_POLICY_KEYS,
  buildFulfillmentPolicyOptions,
  checkListingPolicyIds,
  listingPolicyNamesFromDiscovery,
  resolveStoreShelfIds,
  verifyEbayLeafCategories,
  type EbayCategoryRequest,
} from "../../application/dropship-ebay-listing-checks";
import {
  DropshipEbayListingSetupService,
  type DropshipEbayListingSetupDirectory,
  type DropshipEbayListingSetupDiscovery,
} from "../../application/dropship-ebay-listing-setup-service";
import {
  managedMerchantLocationKeyForWarehouse,
  type DropshipEbayManagedLocationProvider,
} from "../../application/dropship-ebay-managed-location-service";
import type { DropshipEbayStoreCategory } from "../../application/dropship-ebay-store-category-service";
import {
  buildDefaultDropshipStoreListingConfig,
  type DropshipListingConfigService,
  type DropshipStoreListingConfigRecord,
} from "../../application/dropship-listing-config-service";
import type { DropshipLogger } from "../../application/dropship-ports";
import type {
  DropshipEbayFulfillmentCapability,
  DropshipEbayFulfillmentPolicy,
} from "../../domain/ebay-fulfillment-policy-compatibility";
import { EBAY_BUSINESS_POLICY_FIELDS } from "../../domain/ebay-listing-setup-config";
import { DropshipError } from "../../domain/errors";
import type { EbayCategoryOption } from "../../../../../shared/dropship/ebay-category-rules";
import { PRODUCT_LISTING_SETTING_FIELDS, listingSettingPolicySchema } from "../../../../../shared/dropship/listing-setting-values";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const STORE_CONNECTION_ID = 44;
const VENDOR_ID = 10;

const silentLogger: DropshipLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fulfillmentPolicy(id: string, name: string, handlingDays = 1): DropshipEbayFulfillmentPolicy {
  return {
    id,
    name,
    marketplaceId: "EBAY_US",
    handlingTime: { value: handlingDays, unit: "DAY" },
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

function discovery(): DropshipEbayListingSetupDiscovery {
  return {
    marketplaceId: "EBAY_US",
    merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
    fulfillmentPolicies: [fulfillmentPolicy("fulfillment-1", "Standard"), fulfillmentPolicy("fulfillment-fast", "Same day", 0)],
    returnPolicies: [{ id: "return-1", name: "Thirty days" }],
    paymentPolicies: [{ id: "payment-1", name: "Managed payments" }],
  };
}

function shelves(): DropshipEbayStoreCategory[] {
  return [
    { categoryId: "101", categoryName: "Toploaders", path: "Supplies:Toploaders", level: 2 },
    { categoryId: "102", categoryName: "Penny sleeves", path: "Supplies:Penny sleeves", level: 2 },
  ];
}

function unexpected(name: string) {
  return vi.fn(async () => {
    throw new Error(`${name} must not be called`);
  });
}

/**
 * The store-default setup save (W2) with every port stubbed: an editable eBay
 * store at listing-config revision 1, no recorded request keys, and a write
 * port that must never be reached by a refused save.
 */
function makeSetupFixture() {
  const config: DropshipStoreListingConfigRecord = {
    id: 9,
    storeConnectionId: STORE_CONNECTION_ID,
    ...buildDefaultDropshipStoreListingConfig("ebay"),
    marketplaceConfig: { marketplaceId: "EBAY_US" },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const replaceForMember = unexpected("replaceForMember");
  const listingConfig = {
    getViewForMember: vi.fn(async () => ({
      vendor: { vendorId: VENDOR_ID, status: "active" },
      storeConnection: { vendorId: VENDOR_ID, storeConnectionId: STORE_CONNECTION_ID, platform: "ebay", status: "connected", setupStatus: "ready" },
      config,
      access: { canEdit: true, reason: null },
    })),
    findKeyedRequest: vi.fn(async () => null),
    replaceForMember,
    findConfig: unexpected("findConfig"),
    getForAdmin: unexpected("getForAdmin"),
    replaceForAdmin: unexpected("replaceForAdmin"),
  };
  const directory: DropshipEbayListingSetupDirectory = {
    discoverForStoreConnection: vi.fn(async () => discovery()),
    discoverWithAccessToken: unexpected("discoverWithAccessToken"),
    getFulfillmentPolicyForStoreConnection: unexpected("getFulfillmentPolicyForStoreConnection"),
    getFulfillmentPolicyWithAccessToken: unexpected("getFulfillmentPolicyWithAccessToken"),
  };
  const capabilities: DropshipEbayFulfillmentCapabilityProvider = { getForStoreConnection: vi.fn(async () => capability()) };
  const locations: DropshipEbayManagedLocationProvider = {
    ensureForStoreConnection: vi.fn(async (input: { originWarehouseId: number }) => ({
      merchantLocationKey: managedMerchantLocationKeyForWarehouse(input.originWarehouseId),
      name: "Card Shellz Dropship - HQ",
      originWarehouseId: input.originWarehouseId,
      action: "unchanged" as const,
    })),
    ensureWithAccessToken: unexpected("ensureWithAccessToken"),
  };
  const service = new DropshipEbayListingSetupService({
    listingConfig: listingConfig as unknown as Pick<
      DropshipListingConfigService,
      "getViewForMember" | "findKeyedRequest" | "findConfig" | "replaceForMember" | "getForAdmin" | "replaceForAdmin"
    >,
    directory,
    storeShelves: { listLeafCategories: vi.fn(async () => shelves()) },
    fulfillmentCapabilities: capabilities,
    managedLocations: locations,
    logger: silentLogger,
  });
  return { service, replaceForMember };
}

/** Inputs are frozen all the way down, so a check that mutated one would throw. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** The refusal a call answers, in full: code, words and context. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string; context: unknown }> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  if (!(error instanceof DropshipError)) throw new Error(`Expected a DropshipError, got ${String(error)}`);
  return { code: error.code, message: error.message, context: error.context };
}

/**
 * The refusals of the two callers whose checks move into the checks module,
 * written and run on the code before PR 9b. Each pins the code, the words and
 * the whole context, so moving the checks cannot change what a vendor sees.
 */
describe("eBay listing check callers (pinned before PR 9b)", () => {
  it("setup save: refuses policies eBay no longer lists, naming every such field in field order", async () => {
    const fixture = makeSetupFixture();

    const answer = await refusal(fixture.service.replaceForMember("member-1", STORE_CONNECTION_ID, {
      expectedRevision: 1, idempotencyKey: "setup-save-pin-1", paymentPolicyId: "payment-gone", returnPolicyId: "return-gone",
    }));

    expect(answer).toEqual({
      code: "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID",
      message: "One or more eBay listing setup selections are no longer available.",
      context: { storeConnectionId: STORE_CONNECTION_ID, invalidFields: ["returnPolicyId", "paymentPolicyId"], retryable: false },
    });
    expect(fixture.replaceForMember).not.toHaveBeenCalled();
  });

  it("setup save: refuses a shipping policy Card Shellz shipping cannot meet, with eBay's issues", async () => {
    const fixture = makeSetupFixture();

    const answer = await refusal(fixture.service.replaceForMember("member-1", STORE_CONNECTION_ID, {
      expectedRevision: 1, idempotencyKey: "setup-save-pin-2", fulfillmentPolicyId: "fulfillment-fast",
    }));

    expect(answer).toEqual({
      code: "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
      message: "The selected eBay fulfillment policy exceeds Card Shellz fulfillment capabilities.",
      context: {
        storeConnectionId: STORE_CONNECTION_ID,
        fulfillmentPolicyId: "fulfillment-fast",
        issues: [{ code: "handling_time_too_short", message: "Policy must allow at least 1 business day of handling time." }],
        retryable: false,
      },
    });
    expect(fixture.replaceForMember).not.toHaveBeenCalled();
  });

  it("setup save: refuses a shelf default naming a shelf the store no longer has, in the setup's own words", async () => {
    const fixture = makeSetupFixture();

    const answer = await refusal(fixture.service.replaceForMember("member-1", STORE_CONNECTION_ID, {
      expectedRevision: 1, idempotencyKey: "setup-save-pin-3", storeShelfDefault: { ids: ["101", "shelf-gone"] },
    }));

    expect(answer).toEqual({
      code: "DROPSHIP_EBAY_STORE_SHELF_DEFAULT_INVALID",
      message: "That shelf is not in your eBay store anymore. Choose another shelf.",
      context: { storeConnectionId: STORE_CONNECTION_ID, invalidFields: ["storeShelfDefault"], retryable: false },
    });
    expect(fixture.replaceForMember).not.toHaveBeenCalled();
  });
});

describe("checkListingPolicyIds", () => {
  it("checks nothing and needs no eBay lists when the request sends no policy", () => {
    expect(checkListingPolicyIds(deepFreeze({}), null, null, STORE_CONNECTION_ID)).toEqual({});
  });

  it("refuses a sent policy without eBay's lists as a broken invariant", async () => {
    expect(await refusal(Promise.resolve().then(() =>
      checkListingPolicyIds(deepFreeze({ returnPolicyId: "return-1" }), null, null, STORE_CONNECTION_ID)))).toEqual({
      code: "DROPSHIP_EBAY_LISTING_SETUP_INVARIANT_FAILED",
      message: "eBay's policy lists are required to check a policy save.",
      context: { storeConnectionId: STORE_CONNECTION_ID, retryable: false },
    });
  });

  it("returns each sent policy, and only those, with the name eBay lists, in the stored shape", () => {
    const checked = checkListingPolicyIds(
      deepFreeze({ fulfillmentPolicyId: "fulfillment-1", paymentPolicyId: "payment-1" }),
      deepFreeze(discovery()), deepFreeze(capability()), STORE_CONNECTION_ID,
    );

    expect(checked).toEqual({
      shippingPolicy: { id: "fulfillment-1", name: "Standard" },
      paymentPolicy: { id: "payment-1", name: "Managed payments" },
    });
    for (const value of Object.values(checked)) expect(listingSettingPolicySchema.parse(value)).toEqual(value);
  });

  it.each([
    ["trimmed", "  Thirty days  ", "Thirty days"],
    ["null when eBay lists it blank", "   ", null],
  ])("gives the name %s", (_label, ebayName, stored) => {
    const lists = { ...discovery(), returnPolicies: [{ id: "return-1", name: ebayName }] };

    expect(checkListingPolicyIds(deepFreeze({ returnPolicyId: "return-1" }), deepFreeze(lists), null, STORE_CONNECTION_ID))
      .toEqual({ returnPolicy: { id: "return-1", name: stored } });
  });

  it("refuses ids eBay does not list, naming every such field in field order, before the shipping check", async () => {
    // Sent in another key order than the fields', with an incompatible shipping policy.
    const answer = await refusal(Promise.resolve().then(() => checkListingPolicyIds(
      deepFreeze({ paymentPolicyId: "payment-gone", returnPolicyId: "return-gone", fulfillmentPolicyId: "fulfillment-fast" }),
      deepFreeze(discovery()), deepFreeze(capability()), STORE_CONNECTION_ID,
    )));

    expect(answer).toEqual({
      code: "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID",
      message: "One or more eBay listing setup selections are no longer available.",
      context: { storeConnectionId: STORE_CONNECTION_ID, invalidFields: ["returnPolicyId", "paymentPolicyId"], retryable: false },
    });
  });

  it.each([
    ["Card Shellz shipping cannot meet", capability(),
      [{ code: "handling_time_too_short", message: "Policy must allow at least 1 business day of handling time." }]],
    ["Card Shellz shipping could not be read for", null, []],
  ])("refuses a shipping policy %s", async (_label, checkedCapability, issues) => {
    const answer = await refusal(Promise.resolve().then(() => checkListingPolicyIds(
      deepFreeze({ fulfillmentPolicyId: checkedCapability ? "fulfillment-fast" : "fulfillment-1" }),
      deepFreeze(discovery()), checkedCapability ? deepFreeze(checkedCapability) : null, STORE_CONNECTION_ID,
    )));

    expect(answer).toEqual({
      code: "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
      message: "The selected eBay fulfillment policy exceeds Card Shellz fulfillment capabilities.",
      context: {
        storeConnectionId: STORE_CONNECTION_ID,
        fulfillmentPolicyId: checkedCapability ? "fulfillment-fast" : "fulfillment-1",
        issues,
        retryable: false,
      },
    });
  });

  it("checks return and payment policies without Card Shellz shipping", () => {
    expect(checkListingPolicyIds(deepFreeze({ returnPolicyId: "return-1", paymentPolicyId: "payment-1" }), deepFreeze(discovery()), null,
      STORE_CONNECTION_ID)).toEqual({
      returnPolicy: { id: "return-1", name: "Thirty days" },
      paymentPolicy: { id: "payment-1", name: "Managed payments" },
    });
  });

  it("names each listing config policy field by its listing setting key", () => {
    expect(Object.keys(CHECKED_LISTING_POLICY_KEYS)).toEqual([...EBAY_BUSINESS_POLICY_FIELDS]);
    expect(CHECKED_LISTING_POLICY_KEYS).toEqual({
      fulfillmentPolicyId: "shippingPolicy", returnPolicyId: "returnPolicy", paymentPolicyId: "paymentPolicy",
    });
    for (const key of Object.values(CHECKED_LISTING_POLICY_KEYS)) {
      expect(PRODUCT_LISTING_SETTING_FIELDS as readonly string[]).toContain(key);
    }
  });
});

describe("buildFulfillmentPolicyOptions", () => {
  it.each([
    ["judges each policy against Card Shellz shipping", capability(), [
      { id: "fulfillment-1", name: "Standard", compatible: true, compatibilityChecked: true, compatibilityIssues: [] },
      { id: "fulfillment-fast", name: "Same day", compatible: false, compatibilityChecked: true,
        compatibilityIssues: [{ code: "handling_time_too_short", message: "Policy must allow at least 1 business day of handling time." }] },
    ]],
    ["marks every policy unchecked and not compatible without Card Shellz shipping", null, [
      { id: "fulfillment-1", name: "Standard", compatible: false, compatibilityChecked: false, compatibilityIssues: [] },
      { id: "fulfillment-fast", name: "Same day", compatible: false, compatibilityChecked: false, compatibilityIssues: [] },
    ]],
  ])("%s", (_label, checkedCapability, expected) => {
    expect(buildFulfillmentPolicyOptions(deepFreeze(discovery().fulfillmentPolicies), checkedCapability ? deepFreeze(checkedCapability) : null))
      .toEqual(expected);
  });
});

describe("listingPolicyNamesFromDiscovery", () => {
  it("names each final id: a changed one over the current one, null removing it, a missing field keeping it", () => {
    const lists = {
      ...discovery(),
      fulfillmentPolicies: [fulfillmentPolicy("fulfillment-1", " Standard "), fulfillmentPolicy("fulfillment-2", "Express")],
      paymentPolicies: [{ id: "payment-1", name: "  " }],
    };

    expect(listingPolicyNamesFromDiscovery(
      deepFreeze(lists),
      deepFreeze({ fulfillmentPolicyId: "fulfillment-1", returnPolicyId: "return-1", paymentPolicyId: "payment-1" }),
      deepFreeze({ fulfillmentPolicyId: "fulfillment-2", returnPolicyId: null }),
    )).toEqual({ fulfillmentPolicyId: "Express" });
    expect(listingPolicyNamesFromDiscovery(
      deepFreeze(lists),
      deepFreeze({ fulfillmentPolicyId: "fulfillment-1", returnPolicyId: null, paymentPolicyId: null }),
      deepFreeze({}),
    )).toEqual({ fulfillmentPolicyId: "Standard" });
  });

  it("gives no name for an id eBay does not list", () => {
    expect(listingPolicyNamesFromDiscovery(
      deepFreeze(discovery()),
      deepFreeze({ fulfillmentPolicyId: null, returnPolicyId: "return-gone", paymentPolicyId: null }),
      deepFreeze({ paymentPolicyId: "payment-gone" }),
    )).toEqual({});
  });
});

describe("resolveStoreShelfIds", () => {
  const neverRefused = (shelfId: string): DropshipError => {
    throw new Error(`Unexpected refusal for ${shelfId}`);
  };

  it("returns each shelf's id and path, in request order", () => {
    expect(resolveStoreShelfIds(deepFreeze(["102", "101"]), deepFreeze(shelves()), neverRefused)).toEqual([
      { id: "102", name: "Supplies:Penny sleeves" },
      { id: "101", name: "Supplies:Toploaders" },
    ]);
  });

  it("throws the caller's own refusal for the first shelf the store does not have", () => {
    const invalidShelf = vi.fn((shelfId: string) => new DropshipError("CALLER_REFUSAL", "Caller words.", { shelfId }));

    expect(() => resolveStoreShelfIds(deepFreeze(["101", "gone-b", "gone-a"]), deepFreeze(shelves()), invalidShelf))
      .toThrow(expect.objectContaining({ code: "CALLER_REFUSAL", message: "Caller words.", context: { shelfId: "gone-b" } }));
    expect(invalidShelf.mock.calls).toEqual([["gone-b"]]);
  });

  it("matches ids exactly, so a shelf id with spaces is not the store's shelf", () => {
    const invalidShelf = vi.fn((shelfId: string) => new DropshipError("CALLER_REFUSAL", "Caller words.", { shelfId }));

    expect(() => resolveStoreShelfIds(deepFreeze([" 101"]), deepFreeze(shelves()), invalidShelf)).toThrow(DropshipError);
    expect(invalidShelf.mock.calls).toEqual([[" 101"]]);
  });

  it("resolves no shelves to none, without refusing", () => {
    expect(resolveStoreShelfIds(deepFreeze([]), deepFreeze(shelves()), neverRefused)).toEqual([]);
  });
});

describe("verifyEbayLeafCategories", () => {
  const sleeves: EbayCategoryOption = { categoryId: "900102", categoryName: "Sleeves", path: ["Collectibles", "Card Storage", "Sleeves"], leaf: true };
  const mailers: EbayCategoryOption = { categoryId: "900103", categoryName: "Mailers", path: ["Collectibles", "Shipping Supplies", "Mailers"], leaf: true };
  const storage: EbayCategoryOption = { categoryId: "900100", categoryName: "Card Storage", path: ["Collectibles", "Card Storage"], leaf: false };
  // A frozen Map can still be changed through set(), so its options are frozen one by one.
  const described: ReadonlyMap<string, EbayCategoryOption> = new Map([sleeves, mailers, storage]
    .map((option) => [option.categoryId, deepFreeze(option)]));

  function verify(requests: EbayCategoryRequest[]) {
    return verifyEbayLeafCategories({ storeConnectionId: STORE_CONNECTION_ID, described, requests: deepFreeze(requests) });
  }

  it("returns eBay's own value for each requested id, without the leaf flag, on its own path array", () => {
    const verified = verify([{ categoryId: "900102", ruleId: null }, { categoryId: "900103", ruleId: "mailers" }]);

    expect([...verified.entries()]).toEqual([
      ["900102", { categoryId: "900102", categoryName: "Sleeves", path: ["Collectibles", "Card Storage", "Sleeves"] }],
      ["900103", { categoryId: "900103", categoryName: "Mailers", path: ["Collectibles", "Shipping Supplies", "Mailers"] }],
    ]);
    expect(verified.get("900102")!.path).not.toBe(sleeves.path);
  });

  it.each([
    ["not in eBay's list", "999001", "not_found",
      "That eBay category is not in eBay's current category list. Search again and pick a current category."],
    ["above the last level", "900100", "not_leaf",
      "Pick a more specific eBay category. eBay accepts listings only in the last level of a category path."],
  ])("refuses a category %s, naming its rule", async (_label, categoryId, reason, message) => {
    expect(await refusal(Promise.resolve().then(() => verify([{ categoryId, ruleId: "rule-1" }])))).toEqual({
      code: "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", message,
      context: { storeConnectionId: STORE_CONNECTION_ID, categoryId, ruleId: "rule-1", reason },
    });
  });

  it("refuses the first failing request in order, with the store default's null rule", async () => {
    const answer = await refusal(Promise.resolve().then(() => verify([
      { categoryId: "900100", ruleId: null },
      { categoryId: "999001", ruleId: "rule-1" },
    ])));

    expect(answer.context).toEqual({ storeConnectionId: STORE_CONNECTION_ID, categoryId: "900100", ruleId: null, reason: "not_leaf" });
  });

  it("keeps one value per id and names a failing id by its first request", async () => {
    expect([...verify([{ categoryId: "900102", ruleId: null }, { categoryId: "900102", ruleId: "sleeves" }]).keys()]).toEqual(["900102"]);
    const answer = await refusal(Promise.resolve().then(() => verify([
      { categoryId: "900103", ruleId: null },
      { categoryId: "999001", ruleId: "first" },
      { categoryId: "999001", ruleId: "second" },
    ])));
    expect(answer.context).toEqual(expect.objectContaining({ categoryId: "999001", ruleId: "first" }));
  });

  it("verifies no requests to nothing", () => {
    expect(verify([]).size).toBe(0);
  });
});
