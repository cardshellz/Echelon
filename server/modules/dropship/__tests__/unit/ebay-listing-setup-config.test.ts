import { describe, expect, it } from "vitest";
import {
  EBAY_BUSINESS_POLICY_FIELDS,
  EBAY_BUSINESS_POLICY_NAMES_KEY,
  EBAY_STORE_SHELF_DEFAULT_KEY,
  MAX_EBAY_STORE_SHELVES,
  ebayPolicyNameKey,
  marketplaceConfigForListingIntent,
  readEbayBusinessPolicyNames,
  readEbayStoreShelfDefault,
  readStoredEbayPolicyName,
} from "../../domain/ebay-listing-setup-config";

const NO_NAMES = { fulfillmentPolicyName: null, returnPolicyName: null, paymentPolicyName: null };

/** The three policy ids as a setup save stores them in businessPolicies. */
function savedPolicyIds() {
  return { fulfillmentPolicyId: "fulfillment-1", returnPolicyId: "return-1", paymentPolicyId: "payment-1" };
}

/** Names as a setup save stores them: keyed by policy field, each with the id it names. */
function savedNames() {
  return {
    fulfillmentPolicyId: { id: "fulfillment-1", name: "Free shipping 1 day" },
    returnPolicyId: { id: "return-1", name: "30 day returns" },
    paymentPolicyId: { id: "payment-1", name: "Immediate payment" },
  };
}

describe("stored marketplace_config keys", () => {
  it("keeps the key names saved configs already use", () => {
    // These name JSON keys inside stored rows; renaming one would orphan every saved value.
    expect(EBAY_BUSINESS_POLICY_NAMES_KEY).toBe("businessPolicyNames");
    expect(EBAY_STORE_SHELF_DEFAULT_KEY).toBe("storeShelfDefault");
  });

  it("allows a primary and a secondary shelf, as eBay does on an offer", () => {
    expect(MAX_EBAY_STORE_SHELVES).toBe(2);
  });

  it("pairs each policy id with its name", () => {
    expect(EBAY_BUSINESS_POLICY_FIELDS).toEqual(["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"]);
    expect(EBAY_BUSINESS_POLICY_FIELDS.map(ebayPolicyNameKey))
      .toEqual(["fulfillmentPolicyName", "returnPolicyName", "paymentPolicyName"]);
  });
});

describe("readEbayBusinessPolicyNames", () => {
  it("reads the three saved names, trimmed, while each one names the saved policy id", () => {
    expect(readEbayBusinessPolicyNames({
      businessPolicies: savedPolicyIds(),
      businessPolicyNames: {
        fulfillmentPolicyId: { id: "fulfillment-1", name: "  Free shipping 1 day  " },
        returnPolicyId: { id: "return-1", name: "30 day returns" },
        paymentPolicyId: { id: "payment-1", name: "\tImmediate payment\n" },
      },
    })).toEqual({
      fulfillmentPolicyName: "Free shipping 1 day",
      returnPolicyName: "30 day returns",
      paymentPolicyName: "Immediate payment",
    });
  });

  it("reads a name that was never saved as null, and keeps the others", () => {
    expect(readEbayBusinessPolicyNames({
      businessPolicies: savedPolicyIds(),
      businessPolicyNames: { returnPolicyId: { id: "return-1", name: "30 day returns" } },
    })).toEqual({ ...NO_NAMES, returnPolicyName: "30 day returns" });
  });

  // Another writer (staff, a per-store PUT) can change a policy id without
  // touching the names; the old policy's name must never be shown for the new id.
  it("reads a name as null once the saved policy id is another one, and keeps the names that still match", () => {
    expect(readEbayBusinessPolicyNames({
      businessPolicies: { ...savedPolicyIds(), fulfillmentPolicyId: "fulfillment-2" },
      businessPolicyNames: savedNames(),
    })).toEqual({
      fulfillmentPolicyName: null,
      returnPolicyName: "30 day returns",
      paymentPolicyName: "Immediate payment",
    });
  });

  it.each([
    ["no saved policies at all", {}],
    ["saved policies that are not an object", { businessPolicies: "fulfillment-1" }],
    ["saved policies as a list", { businessPolicies: ["fulfillment-1", "return-1", "payment-1"] }],
    ["null saved policies", { businessPolicies: null }],
    ["saved policies without these three ids", { businessPolicies: { unrelatedPolicySetting: "kept" } }],
    ["blank saved policy ids", { businessPolicies: { fulfillmentPolicyId: "", returnPolicyId: "  ", paymentPolicyId: "\t" } }],
    ["saved policy ids that are not text", { businessPolicies: { fulfillmentPolicyId: 1, returnPolicyId: null, paymentPolicyId: true } }],
  ])("reads every name as null when there is %s, even with names stored", (_label, policies) => {
    expect(readEbayBusinessPolicyNames({ ...policies, businessPolicyNames: savedNames() })).toEqual(NO_NAMES);
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", "   \t\n"],
    ["a number", 42],
    ["zero", 0],
    ["a boolean", true],
    ["null", null],
    ["missing", undefined],
    ["an object", { name: "Free shipping" }],
    ["an array", ["Free shipping"]],
  ])("reads a name that is %s as null", (_label, value) => {
    expect(readEbayBusinessPolicyNames({
      businessPolicies: savedPolicyIds(),
      businessPolicyNames: {
        fulfillmentPolicyId: { id: "fulfillment-1", name: value },
        returnPolicyId: { id: "return-1", name: value },
        paymentPolicyId: { id: "payment-1", name: value },
      },
    })).toEqual(NO_NAMES);
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", "  "],
    ["the same id as a number", 1],
    ["null", null],
    ["missing", undefined],
  ])("reads a name whose stored id is %s as null", (_label, id) => {
    expect(readEbayBusinessPolicyNames({
      businessPolicies: { ...savedPolicyIds(), fulfillmentPolicyId: "1" },
      businessPolicyNames: { ...savedNames(), fulfillmentPolicyId: { id, name: "Free shipping 1 day" } },
    })).toEqual({ ...NO_NAMES, returnPolicyName: "30 day returns", paymentPolicyName: "Immediate payment" });
  });

  it.each([
    ["a string", "Free shipping 1 day"],
    ["null", null],
    ["a list", [{ id: "fulfillment-1", name: "Free shipping 1 day" }]],
    ["a number", 7],
  ])("reads a stored entry that is %s as no name", (_label, entry) => {
    expect(readEbayBusinessPolicyNames({
      businessPolicies: savedPolicyIds(),
      businessPolicyNames: { ...savedNames(), fulfillmentPolicyId: entry },
    })).toEqual({ ...NO_NAMES, returnPolicyName: "30 day returns", paymentPolicyName: "Immediate payment" });
  });

  it("matches ids after trimming both the saved id and the stored one", () => {
    expect(readEbayBusinessPolicyNames({
      businessPolicies: { ...savedPolicyIds(), fulfillmentPolicyId: " fulfillment-1 " },
      businessPolicyNames: { fulfillmentPolicyId: { id: "fulfillment-1\n", name: "Free shipping 1 day" } },
    })).toEqual({ ...NO_NAMES, fulfillmentPolicyName: "Free shipping 1 day" });
  });

  it("compares ids exactly otherwise: case and inner spaces matter", () => {
    for (const storedId of ["Fulfillment-1", "fulfillment 1", "fulfillment-10"]) {
      expect(readEbayBusinessPolicyNames({
        businessPolicies: savedPolicyIds(),
        businessPolicyNames: { fulfillmentPolicyId: { id: storedId, name: "Free shipping 1 day" } },
      })).toEqual(NO_NAMES);
    }
  });

  it("reads each name only from its own policy's entry, never from another policy's", () => {
    // The return entry names the saved fulfillment id; it is still not the fulfillment name.
    expect(readEbayBusinessPolicyNames({
      businessPolicies: { fulfillmentPolicyId: "shared-id", returnPolicyId: "return-1" },
      businessPolicyNames: { returnPolicyId: { id: "shared-id", name: "Wrong place" } },
    })).toEqual(NO_NAMES);
  });

  it("reads names stored in the flat shape, without their ids, as null", () => {
    expect(readEbayBusinessPolicyNames({
      businessPolicies: savedPolicyIds(),
      businessPolicyNames: {
        fulfillmentPolicyName: "Free shipping 1 day",
        returnPolicyName: "30 day returns",
        paymentPolicyName: "Immediate payment",
      },
    })).toEqual(NO_NAMES);
  });

  it.each([
    ["missing", {}],
    ["null", { businessPolicyNames: null }],
    ["a string", { businessPolicyNames: "Free shipping" }],
    ["a number", { businessPolicyNames: 7 }],
    ["an array", { businessPolicyNames: ["Free shipping", "30 day returns", "Immediate payment"] }],
  ])("reads every name as null when the saved names are %s", (_label, stored) => {
    expect(readEbayBusinessPolicyNames({ businessPolicies: savedPolicyIds(), ...stored })).toEqual(NO_NAMES);
  });

  it("returns only the three names, ignoring anything else stored beside them", () => {
    const names = readEbayBusinessPolicyNames({
      businessPolicies: { ...savedPolicyIds(), shippingPolicyId: "legacy-1" },
      businessPolicyNames: {
        fulfillmentPolicyId: { id: "fulfillment-1", name: "Ship", savedAt: "x" },
        shippingPolicyId: { id: "legacy-1", name: "Legacy" },
        extra: "x",
      },
      fulfillmentPolicyName: "not here",
    });
    expect(names).toEqual({ ...NO_NAMES, fulfillmentPolicyName: "Ship" });
    expect(Object.keys(names).sort()).toEqual(["fulfillmentPolicyName", "paymentPolicyName", "returnPolicyName"]);
  });

  it("does not change the config it reads", () => {
    const marketplaceConfig = deepFreeze({
      businessPolicies: { fulfillmentPolicyId: " fulfillment-1 " },
      businessPolicyNames: { fulfillmentPolicyId: { id: " fulfillment-1 ", name: "  Ship  " } },
    });
    const before = structuredClone(marketplaceConfig);
    expect(readEbayBusinessPolicyNames(marketplaceConfig)).toEqual({ ...NO_NAMES, fulfillmentPolicyName: "Ship" });
    expect(marketplaceConfig).toEqual(before);
  });
});

describe("readStoredEbayPolicyName", () => {
  const marketplaceConfig = () => ({ businessPolicies: savedPolicyIds(), businessPolicyNames: savedNames() });

  it.each([
    ["fulfillmentPolicyId", { id: "fulfillment-1", name: "Free shipping 1 day" }],
    ["returnPolicyId", { id: "return-1", name: "30 day returns" }],
    ["paymentPolicyId", { id: "payment-1", name: "Immediate payment" }],
  ] as const)("gives the stored id and name for %s while that id is saved", (field, expected) => {
    expect(readStoredEbayPolicyName(marketplaceConfig(), field)).toEqual(expected);
  });

  it("gives the trimmed id and name", () => {
    expect(readStoredEbayPolicyName({
      businessPolicies: { returnPolicyId: "return-1" },
      businessPolicyNames: { returnPolicyId: { id: "  return-1 ", name: " 30 day returns\t" } },
    }, "returnPolicyId")).toEqual({ id: "return-1", name: "30 day returns" });
  });

  it("gives null once the saved id is another one, without touching the other policies", () => {
    const config = { ...marketplaceConfig(), businessPolicies: { ...savedPolicyIds(), paymentPolicyId: "payment-2" } };
    expect(readStoredEbayPolicyName(config, "paymentPolicyId")).toBeNull();
    expect(readStoredEbayPolicyName(config, "fulfillmentPolicyId")).toEqual({ id: "fulfillment-1", name: "Free shipping 1 day" });
  });

  it("gives null when the policy was removed, even though its name is still stored", () => {
    const { returnPolicyId: _removed, ...policies } = savedPolicyIds();
    expect(readStoredEbayPolicyName({ ...marketplaceConfig(), businessPolicies: policies }, "returnPolicyId")).toBeNull();
  });

  it.each([
    ["no name", { id: "return-1" }],
    ["a blank name", { id: "return-1", name: " " }],
    ["no id", { name: "30 day returns" }],
    ["a blank id", { id: "", name: "30 day returns" }],
  ])("gives null for an entry with %s", (_label, entry) => {
    expect(readStoredEbayPolicyName({
      businessPolicies: savedPolicyIds(),
      businessPolicyNames: { returnPolicyId: entry },
    }, "returnPolicyId")).toBeNull();
  });

  it("gives an answer of its own and never changes the config it reads", () => {
    const config = deepFreeze(marketplaceConfig());
    const before = structuredClone(config);
    const stored = readStoredEbayPolicyName(config, "fulfillmentPolicyId")!;
    expect(stored).not.toBe(config.businessPolicyNames.fulfillmentPolicyId);
    stored.name = "changed by the caller";
    expect(config).toEqual(before);
  });
});

describe("readEbayStoreShelfDefault", () => {
  it("reads one shelf", () => {
    expect(readEbayStoreShelfDefault({ storeShelfDefault: { ids: ["101"], names: ["Toploaders"] } }))
      .toEqual({ ids: ["101"], names: ["Toploaders"] });
  });

  it("reads two shelves in order, primary first, trimmed", () => {
    expect(readEbayStoreShelfDefault({
      storeShelfDefault: { ids: [" 202 ", "101"], names: ["Supplies > Sleeves ", " Toploaders"] },
    })).toEqual({ ids: ["202", "101"], names: ["Supplies > Sleeves", "Toploaders"] });
  });

  it("ignores other keys stored on the shelf default", () => {
    expect(readEbayStoreShelfDefault({ storeShelfDefault: { ids: ["101"], names: ["Toploaders"], savedAt: "x" } }))
      .toEqual({ ids: ["101"], names: ["Toploaders"] });
  });

  it("returns arrays of its own, so changing the answer cannot change the config", () => {
    const marketplaceConfig = { storeShelfDefault: { ids: ["101"], names: ["Toploaders"] } };
    const shelfDefault = readEbayStoreShelfDefault(marketplaceConfig)!;
    shelfDefault.ids.push("202");
    shelfDefault.names.push("Sleeves");
    expect(marketplaceConfig.storeShelfDefault).toEqual({ ids: ["101"], names: ["Toploaders"] });
  });

  it("does not change the config it reads", () => {
    const marketplaceConfig = deepFreeze({ storeShelfDefault: { ids: [" 101 "], names: [" Toploaders "] } });
    const before = structuredClone(marketplaceConfig);
    expect(readEbayStoreShelfDefault(marketplaceConfig)).toEqual({ ids: ["101"], names: ["Toploaders"] });
    expect(marketplaceConfig).toEqual(before);
  });

  // A malformed value was never written by the setup save; guessing at it could publish the wrong shelf.
  it.each([
    ["missing", {}],
    ["null", { storeShelfDefault: null }],
    ["a string", { storeShelfDefault: "101" }],
    ["an array of ids", { storeShelfDefault: ["101"] }],
    ["without ids", { storeShelfDefault: { names: ["Toploaders"] } }],
    ["without names", { storeShelfDefault: { ids: ["101"] } }],
    ["ids that are not a list", { storeShelfDefault: { ids: "101", names: ["Toploaders"] } }],
    ["names that are not a list", { storeShelfDefault: { ids: ["101"], names: "Toploaders" } }],
    ["no shelves", { storeShelfDefault: { ids: [], names: [] } }],
    ["three shelves", { storeShelfDefault: { ids: ["1", "2", "3"], names: ["A", "B", "C"] } }],
    ["more ids than names", { storeShelfDefault: { ids: ["101", "202"], names: ["Toploaders"] } }],
    ["more names than ids", { storeShelfDefault: { ids: ["101"], names: ["Toploaders", "Sleeves"] } }],
    ["a blank id", { storeShelfDefault: { ids: ["101", "  "], names: ["Toploaders", "Sleeves"] } }],
    ["an empty id", { storeShelfDefault: { ids: [""], names: ["Toploaders"] } }],
    ["a blank name", { storeShelfDefault: { ids: ["101", "202"], names: ["Toploaders", "\t"] } }],
    ["a numeric id", { storeShelfDefault: { ids: [101], names: ["Toploaders"] } }],
    ["a null id", { storeShelfDefault: { ids: [null], names: ["Toploaders"] } }],
    ["a name that is not text", { storeShelfDefault: { ids: ["101"], names: [{ path: "Toploaders" }] } }],
    ["the same id twice", { storeShelfDefault: { ids: ["101", "101"], names: ["Toploaders", "Toploaders"] } }],
    ["the same id twice once trimmed", { storeShelfDefault: { ids: ["101", " 101 "], names: ["Toploaders", "Sleeves"] } }],
  ])("reads a shelf default that is %s as no default", (_label, marketplaceConfig) => {
    expect(readEbayStoreShelfDefault(marketplaceConfig as Record<string, unknown>)).toBeNull();
  });
});

describe("marketplaceConfigForListingIntent", () => {
  const stored = () => ({
    marketplaceId: "EBAY_US",
    merchantLocationKey: "cardshellz-dropship-22",
    businessPolicies: {
      fulfillmentPolicyId: "fulfillment-1",
      returnPolicyId: "return-1",
      paymentPolicyId: "payment-1",
    },
    businessPolicyNames: {
      fulfillmentPolicyId: { id: "fulfillment-1", name: "Free shipping" },
      returnPolicyId: { id: "return-1", name: "30 day returns" },
      paymentPolicyId: { id: "payment-1", name: "Immediate payment" },
    },
    storeShelfDefault: { ids: ["101"], names: ["Toploaders"] },
    profileId: "profile-1",
  });

  it("leaves out the policy names and the shelf default, and keeps every other key as it is", () => {
    const config = stored();
    const intentConfig = marketplaceConfigForListingIntent(config);
    expect(intentConfig).toEqual({
      marketplaceId: "EBAY_US",
      merchantLocationKey: "cardshellz-dropship-22",
      businessPolicies: {
        fulfillmentPolicyId: "fulfillment-1",
        returnPolicyId: "return-1",
        paymentPolicyId: "payment-1",
      },
      profileId: "profile-1",
    });
    expect(Object.keys(intentConfig)).toEqual(["marketplaceId", "merchantLocationKey", "businessPolicies", "profileId"]);
  });

  it("never changes the config it is given, and returns a new object", () => {
    const config = deepFreeze(stored());
    const before = structuredClone(config);
    const intentConfig = marketplaceConfigForListingIntent(config);
    expect(config).toEqual(before);
    expect(config).toHaveProperty(EBAY_BUSINESS_POLICY_NAMES_KEY);
    expect(config).toHaveProperty(EBAY_STORE_SHELF_DEFAULT_KEY);
    expect(intentConfig).not.toBe(config);
    // The copy is the caller's: adding to it does not reach the stored config.
    intentConfig.addedLater = true;
    expect(config).not.toHaveProperty("addedLater");
  });

  it("removes the two keys whatever they hold, malformed or empty", () => {
    for (const value of [null, "", {}, [], 0, { ids: ["1", "2", "3"] }]) {
      expect(marketplaceConfigForListingIntent({ profileId: "profile-1", businessPolicyNames: value, storeShelfDefault: value }))
        .toEqual({ profileId: "profile-1" });
    }
  });

  it("removes only those two top-level keys: similar or nested keys stay", () => {
    const config = {
      businessPolicies: { businessPolicyNames: "nested stays" },
      BusinessPolicyNames: "case differs",
      storeShelfDefaults: "plural differs",
      storeCategoryNames: ["Toploaders"],
    };
    expect(marketplaceConfigForListingIntent(config)).toEqual(config);
  });

  it("gives an equal copy of a config that has neither key, and an empty copy of an empty config", () => {
    const config = { marketplaceId: "EBAY_US", businessPolicies: { fulfillmentPolicyId: "fulfillment-1" } };
    const intentConfig = marketplaceConfigForListingIntent(config);
    expect(intentConfig).toEqual(config);
    expect(intentConfig).not.toBe(config);
    expect(marketplaceConfigForListingIntent({})).toEqual({});
  });

  it("gives the same intent config before and after eBay renames a policy or the shelf default changes", () => {
    const renamed = {
      ...stored(),
      businessPolicyNames: {
        ...stored().businessPolicyNames,
        fulfillmentPolicyId: { id: "fulfillment-1", name: "Free shipping (renamed)" },
      },
      storeShelfDefault: { ids: ["202", "101"], names: ["Sleeves", "Toploaders"] },
    };
    expect(JSON.stringify(marketplaceConfigForListingIntent(renamed)))
      .toBe(JSON.stringify(marketplaceConfigForListingIntent(stored())));
  });
});

/** Freezes a plain value all the way down, so any write to it throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
