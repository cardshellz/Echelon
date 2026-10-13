import { describe, expect, it, vi } from "vitest";
import type { EbayCategoryOption } from "../../../../../shared/dropship/ebay-category-rules";
import type { ProductListingSettingValues } from "../../../../../shared/dropship/listing-setting-values";
import type { DropshipEbayListingSetupDiscovery } from "../../application/dropship-ebay-listing-setup-service";
import type { DropshipEbayStoreCategory } from "../../application/dropship-ebay-store-category-service";
import {
  newListingSettingEbayFields,
  resolveListingSettingEbayValues,
  setsListingSettingEbayId,
  type ListingSettingEbayIdsPatch,
  type ListingSettingEbayPort,
  type ListingSettingEbayPreflight,
} from "../../application/dropship-listing-setting-ebay-values";
import type { DropshipEbayFulfillmentCapability, DropshipEbayFulfillmentPolicy } from "../../domain/ebay-fulfillment-policy-compatibility";
import { DropshipError } from "../../domain/errors";
import { listingSettingWriteErrorAnswer } from "../../interfaces/http/dropship-listing-setting-write-errors";

/**
 * eBay values for listing settings (plan PR 9, P13, 6.5 step 3): known ids
 * keep their stored value with no call, only new ids ask eBay, in a fixed
 * order, a store that needs a sign-in is refused before any call, and eBay's
 * values are bounded to the stored contract.
 */

const STORE = 22;
const VENDOR = 10;

function fulfillmentPolicy(id: string, name: string): DropshipEbayFulfillmentPolicy {
  return { id, name, marketplaceId: "EBAY_US", handlingTime: { value: 1, unit: "DAY" },
    shippingOptions: [{ optionType: "DOMESTIC", shippingServiceCodes: ["USPSParcel"] }],
    localPickup: false, freightShipping: false, pickupDropOff: false };
}

function capability(): DropshipEbayFulfillmentCapability {
  return {
    marketplaceId: "EBAY_US", requiredHandlingTimeBusinessDays: 1, destinationCountry: "US", destinationRegions: ["CA"],
    destinationCoverageComplete: true,
    supportedServices: [{ carrier: "USPS", ebayServiceCode: "USPSParcel", serviceName: "USPS Ground Advantage",
      shipStationCarrierCode: "usps", shipStationServiceCode: "usps_ground_advantage" }],
    evidenceHash: "capability-hash",
    source: { omsChannelId: 103, originWarehouseId: 1, rateBookId: 34, rateBookCode: "dropship-vendor-default", rateTableId: 5,
      serviceLevelId: 7, fulfillmentRoutingRevision: 4 },
  };
}

function discovery(names: Partial<Record<"ship" | "return" | "payment", string>> = {}): DropshipEbayListingSetupDiscovery {
  return {
    marketplaceId: "EBAY_US", merchantLocations: [],
    fulfillmentPolicies: [fulfillmentPolicy("ship-new", names.ship ?? "Standard")],
    returnPolicies: [{ id: "return-new", name: names.return ?? "Thirty days" }],
    paymentPolicies: [{ id: "payment-new", name: names.payment ?? "Managed payments" }],
  };
}

const SHELVES: DropshipEbayStoreCategory[] = [
  { categoryId: "101", categoryName: "Toploaders", path: "Supplies:Toploaders", level: 2 },
  { categoryId: "102", categoryName: "Sleeves", path: "Supplies:Sleeves", level: 2 },
];

function category(categoryId: string, fields: Partial<EbayCategoryOption> = {}): EbayCategoryOption {
  return { categoryId, categoryName: "Card Sleeves", path: ["Collectibles", "Card Sleeves"], leaf: true, ...fields };
}

/** The product's stored eBay values, as the preflight read them. */
const KNOWN: Pick<ProductListingSettingValues, "ebayCategory" | "storeShelf" | "shippingPolicy" | "returnPolicy" | "paymentPolicy"> = {
  ebayCategory: { categoryId: "183438", categoryName: "Card Toploaders", path: ["Collectibles", "Card Toploaders"] },
  storeShelf: { mode: "own", shelves: [{ id: "201", name: "Old:Top" }, { id: "202", name: "Old:Second" }] },
  shippingPolicy: { id: "ship-old", name: "Saved shipping" },
  returnPolicy: { id: "return-old", name: null },
  paymentPolicy: { id: "payment-old", name: "Saved payment" },
};

function preflight(fields: Partial<ListingSettingEbayPreflight> = {}): ListingSettingEbayPreflight {
  return { keyIsNew: true, storeStatus: "connected", marketplaceId: "EBAY_US", known: KNOWN, ...fields };
}

/** A port that records its calls in order, answering from the fixtures. */
function recordingPort(overrides: Partial<Record<keyof ListingSettingEbayPort, unknown>> = {}) {
  const calls: string[] = [];
  const port = {
    describeCategories: vi.fn(async (_identity: unknown, ids: readonly string[]) => {
      calls.push(`describe:${ids.join(",")}`);
      return (overrides.describeCategories as Map<string, EbayCategoryOption> | undefined) ?? new Map(ids.map((id) => [id, category(id)]));
    }),
    discoverPolicies: vi.fn(async () => { calls.push("discover"); return (overrides.discoverPolicies as DropshipEbayListingSetupDiscovery | undefined) ?? discovery(); }),
    loadFulfillmentCapability: vi.fn(async () => { calls.push("capability"); return capability(); }),
    listStoreShelves: vi.fn(async () => { calls.push("shelves"); return (overrides.listStoreShelves as DropshipEbayStoreCategory[] | undefined) ?? SHELVES; }),
  } satisfies ListingSettingEbayPort;
  return { port, calls };
}

/** A port every call of which fails the test. */
function throwingPort(): ListingSettingEbayPort {
  const fail = async (): Promise<never> => { throw new Error("eBay must not be asked"); };
  return { describeCategories: fail, discoverPolicies: fail, loadFulfillmentCapability: fail, listStoreShelves: fail };
}

const resolve = (port: ListingSettingEbayPort, patch: ListingSettingEbayIdsPatch, pre: ListingSettingEbayPreflight = preflight()) =>
  resolveListingSettingEbayValues(port, { vendorId: VENDOR, storeConnectionId: STORE, patch, preflight: pre });

async function refusal(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

describe("setsListingSettingEbayId and newListingSettingEbayFields", () => {
  it("says whether a patch sets any eBay id: a category, an own shelf or a policy", () => {
    expect(setsListingSettingEbayId({})).toBe(false);
    expect(setsListingSettingEbayId({ ebayCategory: null, storeShelf: { mode: "none" }, shippingPolicy: null })).toBe(false);
    expect(setsListingSettingEbayId({ ebayCategory: { categoryId: "1" } })).toBe(true);
    expect(setsListingSettingEbayId({ storeShelf: { mode: "own", shelfIds: ["101"] } })).toBe(true);
    expect(setsListingSettingEbayId({ paymentPolicy: { id: "p" } })).toBe(true);
  });

  it("names only ids not stored on the target, a shelf list compared in order", () => {
    expect(newListingSettingEbayFields({ ebayCategory: { categoryId: "183438" }, shippingPolicy: { id: "ship-old" },
      storeShelf: { mode: "own", shelfIds: ["201", "202"] } }, KNOWN)).toEqual([]);
    expect(newListingSettingEbayFields({ storeShelf: { mode: "own", shelfIds: ["202", "201"] }, returnPolicy: { id: "return-new" },
      ebayCategory: { categoryId: "261328" } }, KNOWN)).toEqual(["ebayCategory", "storeShelf", "returnPolicy"]);
    expect(newListingSettingEbayFields({ shippingPolicy: { id: "ship-old" }, storeShelf: { mode: "own", shelfIds: ["201"] } }, null))
      .toEqual(["storeShelf", "shippingPolicy"]);
  });
});

describe("resolveListingSettingEbayValues (plan PR 9, 6.5 step 3)", () => {
  it("keeps every known id's stored value and asks eBay nothing, even for a store that needs a sign-in", async () => {
    const patch = Object.freeze({ ebayCategory: { categoryId: "183438" }, storeShelf: { mode: "own" as const, shelfIds: ["201", "202"] },
      shippingPolicy: { id: "ship-old" }, returnPolicy: { id: "return-old" }, paymentPolicy: { id: "payment-old" } });

    const result = await resolve(throwingPort(), patch, preflight({ storeStatus: "needs_reauth" }));

    expect(result).toEqual({ status: "resolved", askedEbay: false, values: KNOWN });
  });

  it("passes resets and an explicit no-shelf through with no call", async () => {
    const result = await resolve(throwingPort(), { ebayCategory: null, storeShelf: { mode: "none" }, shippingPolicy: null,
      returnPolicy: null, paymentPolicy: null });
    expect(result).toEqual({ status: "resolved", askedEbay: false, values: { ebayCategory: null, storeShelf: { mode: "none" },
      shippingPolicy: null, returnPolicy: null, paymentPolicy: null } });
  });

  it("refuses a store that needs a sign-in before any eBay call when an id is new, naming the new fields", async () => {
    const error = await refusal(resolve(throwingPort(), { shippingPolicy: { id: "ship-old" }, returnPolicy: { id: "return-new" },
      storeShelf: { mode: "own", shelfIds: ["101"] } }, preflight({ storeStatus: "needs_reauth" })));
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED");
    expect(error.context).toEqual({ storeConnectionId: STORE, fields: ["storeShelf", "returnPolicy"], retryable: false,
      classification: "permanent" });
  });

  it("asks eBay nothing when the preflight found the request key already used: the transaction answers it", async () => {
    const result = await resolve(throwingPort(), { shippingPolicy: { id: "ship-new" } },
      preflight({ keyIsNew: false, storeStatus: "needs_reauth" }));
    expect(result).toEqual({ status: "skipped" });
  });

  it("asks eBay in a fixed order, category, policies (capability before the lists) and shelves, each once", async () => {
    const { port, calls } = recordingPort();
    const result = await resolve(port, { storeShelf: { mode: "own", shelfIds: ["102", "101"] }, paymentPolicy: { id: "payment-new" },
      shippingPolicy: { id: "ship-new" }, ebayCategory: { categoryId: "261328" }, returnPolicy: { id: "return-new" } });

    expect(calls).toEqual(["describe:261328", "capability", "discover", "shelves"]);
    expect(port.discoverPolicies).toHaveBeenCalledWith({ vendorId: VENDOR, storeConnectionId: STORE, marketplaceId: "EBAY_US" });
    expect(port.loadFulfillmentCapability).toHaveBeenCalledWith({ storeConnectionId: STORE, marketplaceId: "EBAY_US" });
    expect(port.listStoreShelves).toHaveBeenCalledWith({ vendorId: VENDOR, storeConnectionId: STORE });
    expect(result).toEqual({ status: "resolved", askedEbay: true, values: {
      ebayCategory: { categoryId: "261328", categoryName: "Card Sleeves", path: ["Collectibles", "Card Sleeves"] },
      storeShelf: { mode: "own", shelves: [{ id: "102", name: "Supplies:Sleeves" }, { id: "101", name: "Supplies:Toploaders" }] },
      shippingPolicy: { id: "ship-new", name: "Standard" },
      returnPolicy: { id: "return-new", name: "Thirty days" },
      paymentPolicy: { id: "payment-new", name: "Managed payments" },
    } });
  });

  it("reads Card Shellz shipping only for a new shipping policy, and eBay's lists only for new policies", async () => {
    const onlyReturn = recordingPort();
    await resolve(onlyReturn.port, { returnPolicy: { id: "return-new" }, shippingPolicy: { id: "ship-old" } });
    expect(onlyReturn.calls).toEqual(["discover"]);

    const known = recordingPort();
    const result = await resolve(known.port, { shippingPolicy: { id: "ship-old" }, ebayCategory: { categoryId: "261328" } });
    expect(known.calls).toEqual(["describe:261328"]);
    expect(result).toMatchObject({ values: { shippingPolicy: KNOWN.shippingPolicy } });
  });

  it("stores a policy name longer than the column as unknown, and a blank one as unknown", async () => {
    const { port } = recordingPort({ discoverPolicies: discovery({ return: "r".repeat(201), payment: "p".repeat(200) }) });
    const result = await resolve(port, { returnPolicy: { id: "return-new" }, paymentPolicy: { id: "payment-new" } });
    expect(result).toMatchObject({ values: { returnPolicy: { id: "return-new", name: null },
      paymentPolicy: { id: "payment-new", name: "p".repeat(200) } } });

    const blank = recordingPort({ discoverPolicies: discovery({ return: "   " }) });
    expect(await resolve(blank.port, { returnPolicy: { id: "return-new" } })).toMatchObject({ values: { returnPolicy: { name: null } } });
  });

  it("refuses a policy eBay does not list with W2's code and words, naming the patch's own fields", async () => {
    const { port } = recordingPort();
    const error = await refusal(resolve(port, { returnPolicy: { id: "return-gone" } }));
    expect(error.code).toBe("DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID");
    expect(error.message).toBe("One or more eBay listing setup selections are no longer available.");
    expect(error.context).toEqual({ storeConnectionId: STORE, invalidFields: ["returnPolicy"], retryable: false,
      classification: "permanent" });

    const two = await refusal(resolve(recordingPort().port, { paymentPolicy: { id: "payment-gone" }, shippingPolicy: { id: "ship-gone" } }));
    expect(two.context).toMatchObject({ invalidFields: ["shippingPolicy", "paymentPolicy"] });
  });

  it("refuses a shipping policy Card Shellz cannot ship with W2's code and words, and each reason on the shipping policy", async () => {
    const { port } = recordingPort({ discoverPolicies: { ...discovery(),
      fulfillmentPolicies: [{ ...fulfillmentPolicy("ship-new", "Standard"), marketplaceId: "EBAY_GB" }] } });
    const error = await refusal(resolve(port, { shippingPolicy: { id: "ship-new" } }));
    expect(error.code).toBe("DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE");
    expect(error.message).toBe("The selected eBay fulfillment policy exceeds Card Shellz fulfillment capabilities.");
    // The issue's own message quotes eBay's values, so only its code is kept.
    expect(error.context).toEqual({ storeConnectionId: STORE, invalidFields: ["shippingPolicy"],
      issues: [{ path: ["shippingPolicy"], code: "marketplace_mismatch" }], retryable: false, classification: "permanent" });
    // The reasons reach the vendor: an issue with no path would be dropped by the allow-list.
    expect(listingSettingWriteErrorAnswer(error).body.error.context).toEqual(error.context);
  });

  it("refuses a shelf the store does not have, and one eBay names past the stored bounds", async () => {
    const missing = await refusal(resolve(recordingPort().port, { storeShelf: { mode: "own", shelfIds: ["101", "999"] } }));
    expect(missing.code).toBe("DROPSHIP_EBAY_STORE_CATEGORY_INVALID");
    expect(missing.context).toEqual({ storeConnectionId: STORE, invalidFields: ["storeShelf"], reason: "not_found", retryable: false,
      classification: "permanent" });

    const longId = "9".repeat(41);
    const tooLongId = await refusal(resolve(recordingPort({ listStoreShelves: [{ categoryId: longId, categoryName: "X", path: "X", level: 1 }] }).port,
      { storeShelf: { mode: "own", shelfIds: [longId] } }));
    expect(tooLongId.context).toMatchObject({ reason: "too_long", invalidFields: ["storeShelf"] });

    const tooLongPath = await refusal(resolve(recordingPort({ listStoreShelves: [{ categoryId: "103", categoryName: "X", path: "p".repeat(501), level: 1 }] }).port,
      { storeShelf: { mode: "own", shelfIds: ["103"] } }));
    expect(tooLongPath.context).toMatchObject({ reason: "too_long" });

    const atBounds = await resolve(recordingPort({ listStoreShelves: [{ categoryId: "9".repeat(40), categoryName: "X", path: "p".repeat(500), level: 1 }] }).port,
      { storeShelf: { mode: "own", shelfIds: ["9".repeat(40)] } });
    expect(atBounds).toMatchObject({ values: { storeShelf: { mode: "own", shelves: [{ id: "9".repeat(40), name: "p".repeat(500) }] } } });
  });

  it("refuses a category eBay does not list, one above the last level, and one the stored schema cannot keep", async () => {
    // W3's code, words and reason; the field is the patch's, and eBay's number is not sent as a (Card Shellz) categoryId.
    const unknown = await refusal(resolve(recordingPort({ describeCategories: new Map() }).port, { ebayCategory: { categoryId: "261328" } }));
    expect(unknown).toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULE_INVALID",
      message: "That eBay category is not in eBay's current category list. Search again and pick a current category." });
    expect(unknown.context).toEqual({ storeConnectionId: STORE, invalidFields: ["ebayCategory"], reason: "not_found",
      retryable: false, classification: "permanent" });

    const branch = await refusal(resolve(recordingPort({ describeCategories: new Map([["261328", category("261328", { leaf: false })]]) }).port,
      { ebayCategory: { categoryId: "261328" } }));
    expect(branch.code).toBe("DROPSHIP_EBAY_CATEGORY_RULE_INVALID");
    expect(branch.context).toEqual({ storeConnectionId: STORE, invalidFields: ["ebayCategory"], reason: "not_leaf",
      retryable: false, classification: "permanent" });

    const deep = Array.from({ length: 13 }, (_, index) => `Level ${index}`);
    const unstorable = await refusal(resolve(recordingPort({ describeCategories: new Map([["261328", category("261328", { path: deep })]]) }).port,
      { ebayCategory: { categoryId: "261328" } }));
    expect(unstorable.code).toBe("DROPSHIP_EBAY_CATEGORY_RULE_INVALID");
    expect(unstorable.context).toEqual({ storeConnectionId: STORE, invalidFields: ["ebayCategory"], reason: "not_storable",
      retryable: false, classification: "permanent" });
  });

  it("refuses a new eBay category outside eBay US before asking eBay, and keeps a known one there", async () => {
    const error = await refusal(resolve(throwingPort(), { ebayCategory: { categoryId: "261328" } }, preflight({ marketplaceId: "EBAY_GB" })));
    expect(error.code).toBe("DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED");
    const known = await resolve(throwingPort(), { ebayCategory: { categoryId: "183438" } }, preflight({ marketplaceId: "EBAY_GB" }));
    expect(known).toMatchObject({ values: { ebayCategory: KNOWN.ebayCategory } });
  });

  it("propagates a provider failure with its own code", async () => {
    const port = { ...recordingPort().port, listStoreShelves: vi.fn(async () => {
      throw new DropshipError("DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE", "eBay is down.", { retryable: true });
    }) };
    const error = await refusal(resolve(port, { storeShelf: { mode: "own", shelfIds: ["101"] } }));
    expect(error.code).toBe("DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE");
  });
});
