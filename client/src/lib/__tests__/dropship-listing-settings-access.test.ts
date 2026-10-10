import { describe, expect, it } from "vitest";
import { DropshipApiError } from "../dropship-ops-surface";
import {
  CONNECTION_BANNER_KINDS,
  LISTING_SETTINGS_RIGHTS,
  bannerFromWriteError,
  chooseConnectionBanner,
  listingSettingsEditRights,
  readListingSetupState,
  type ConnectionBannerKind,
  type ListingSettingsAccessInput,
  type ListingSettingsRightName,
  type ListingSettingsRightsInput,
  type ListingSetupFacts,
} from "../dropship-listing-settings-access";

/**
 * Edit rights and the one banner (plan 4.3, 4.4). The matrix checks every
 * vendor × entitlement × store × setup cell against an oracle written
 * straight from the plan's table, not from the code.
 */

const apiError = (status: number, code: string, context?: Record<string, unknown>) =>
  new DropshipApiError({ message: `refused: ${code}`, status, code, context });

const setupChecked = (overrides: Partial<ListingSetupFacts> = {}): ListingSetupFacts => ({
  access: { canEdit: true, reason: null },
  revision: 4,
  checks: { ebay: "checked", fulfillment: { status: "checked" } },
  missingFields: [],
  ...overrides,
});

function input(overrides: Partial<ListingSettingsRightsInput> = {}): ListingSettingsRightsInput {
  return {
    account: { status: "active", entitlementStatus: "active" },
    summary: { storeStatus: "connected", catalog: { state: "ok", products: 3, sizes: 9 } },
    setup: { data: setupChecked(), error: null },
    shelves: { data: { categories: [] }, error: null },
    blocked: null,
    ...overrides,
  };
}

const editableRights = (rights: ReturnType<typeof listingSettingsEditRights>) =>
  LISTING_SETTINGS_RIGHTS.filter((right) => rights[right].editable);

// ---------------------------------------------------------------------------
// The rights matrix
// ---------------------------------------------------------------------------

const VENDORS = ["active", "onboarding", "paused", "lapsed", "suspended", "closed"] as const;
const ENTITLEMENTS = ["active", "grace", "lapsed"] as const;
const STORES = ["connected", "needs_reauth", "refresh_failed", "paused", "grace_period", "disconnected"] as const;
const SETUP_OUTCOMES = ["checked", "sign_in_403", "unreachable_502", "read_only", "shipping_unchecked", "other_site"] as const;
type SetupOutcome = (typeof SETUP_OUTCOMES)[number];

function setupFor(outcome: SetupOutcome): ListingSettingsAccessInput["setup"] {
  switch (outcome) {
    case "checked":
      // The ship-from location needs updating, so the repair is offered whenever shipping can be saved.
      return { data: setupChecked({ missingFields: ["merchantLocationKey"] }), error: null };
    case "sign_in_403":
      return { data: undefined, error: apiError(403, "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED") };
    case "unreachable_502":
      return { data: undefined, error: apiError(502, "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE") };
    case "read_only":
      return {
        data: setupChecked({ access: { canEdit: false, reason: "store_disconnecting" }, checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } } }),
        error: null,
      };
    case "shipping_unchecked":
      return {
        data: setupChecked({ missingFields: ["merchantLocationKey"], checks: { ebay: "checked", fulfillment: { status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE", kind: "temporary" } } }),
        error: null,
      };
    case "other_site":
      return {
        data: setupChecked({ checks: { ebay: "checked", fulfillment: { status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", kind: "marketplace_unsupported" } } }),
        error: null,
      };
  }
}

/**
 * Plan 4.3, row by row. A read-only setup answer is a fact like any other:
 * its reason (here "being disconnected") holds for every writer.
 */
function oracle(vendor: string, entitlement: string, store: string, outcome: SetupOutcome): Record<ListingSettingsRightName, boolean> {
  const effectiveStore = outcome === "read_only" ? "grace_period" : store;
  const listingVendor = vendor === "active" || vendor === "onboarding";
  const configVendor = !["closed", "lapsed", "suspended"].includes(vendor);
  const entitled = entitlement === "active";
  const anotherSite = outcome === "other_site";
  // Sign-in is needed when the store says so or eBay refused the setup read for it.
  const signIn = effectiveStore === "needs_reauth" || outcome === "sign_in_403";
  // W1, W9 and W4 (dropship-pricing-rules-service.ts, dropship-listing-price-service.ts, dropship-listing-content-service.ts).
  const listingStore = ["connected", "needs_reauth", "refresh_failed"].includes(effectiveStore);
  const price = listingVendor && entitled && listingStore && !anotherSite;
  // W3 never during a sign-in (dropship-ebay-category-rules-service.ts ebayIdentity).
  const ebayCategory = listingVendor && entitled && ["connected", "refresh_failed"].includes(effectiveStore) && !anotherSite && !signIn;
  // W2: the vendor may configure, the setup read answered (canEdit, revision, eBay read; C1), not another site.
  const setupAnswered = outcome === "checked" || outcome === "shipping_unchecked";
  const policies = configVendor && listingStore && !signIn && setupAnswered && !anotherSite;
  const shipping = policies && outcome === "checked";
  return {
    price, exactPrice: price, description: price, ebayCategory,
    policies, shelfNone: policies, shelfPick: policies, shipping, shipFrom: shipping,
  };
}

describe("edit rights matrix (plan 4.3)", () => {
  for (const vendor of VENDORS) {
    for (const entitlement of ENTITLEMENTS) {
      it(`vendor ${vendor}, .ops ${entitlement}: every store and setup outcome`, () => {
        for (const store of STORES) {
          for (const outcome of SETUP_OUTCOMES) {
            const cell = input({
              account: { status: vendor, entitlementStatus: entitlement },
              summary: { storeStatus: store, catalog: { state: "ok", products: 3, sizes: 9 } },
              setup: setupFor(outcome),
            });
            const rights = listingSettingsEditRights(cell);
            const expected = oracle(vendor, entitlement, store, outcome);
            const label = `${vendor}/${entitlement}/${store}/${outcome}`;
            for (const right of LISTING_SETTINGS_RIGHTS) {
              expect({ label, right, editable: rights[right].editable }).toEqual({ label, right, editable: expected[right] });
              // A row that can't be changed always says why: its own line, or the banner shown.
              if (!rights[right].editable) {
                expect({ label, right, reason: rights[right].reason }).not.toEqual({ label, right, reason: null });
                if (rights[right].reason === "banner") expect({ label, banner: chooseConnectionBanner(cell) }).not.toEqual({ label, banner: null });
              }
            }
          }
        }
      });
    }
  }
});

describe("edit rights: reasons", () => {
  it("everything is editable for an active vendor on a connected store with a checked setup", () => {
    expect(editableRights(listingSettingsEditRights(input()))).toEqual(LISTING_SETTINGS_RIGHTS.filter((right) => right !== "shipFrom"));
    // Nothing to repair: the note isn't offered, and it says nothing.
    expect(listingSettingsEditRights(input()).shipFrom).toEqual({ editable: false, reason: "not_needed" });
  });

  it("waits for the account and the summary, then for the eBay reads", () => {
    expect(listingSettingsEditRights(input({ account: null })).price).toEqual({ editable: false, reason: "loading" });
    expect(listingSettingsEditRights(input({ summary: null })).description).toEqual({ editable: false, reason: "loading" });
    const setupLoading = listingSettingsEditRights(input({ setup: { data: undefined, error: null } }));
    expect(setupLoading.policies).toEqual({ editable: false, reason: "checking_ebay" });
    // Prices, the eBay category and the description never wait for eBay's setup read.
    expect(editableRights(setupLoading)).toEqual(["price", "exactPrice", "ebayCategory", "description"]);
    const shelvesLoading = listingSettingsEditRights(input({ shelves: { data: undefined, error: null } }));
    expect(shelvesLoading.shelfPick).toEqual({ editable: false, reason: "checking_ebay" });
    expect(shelvesLoading.shelfNone.editable).toBe(true);
  });

  it("a known block shows its banner even while the account loads", () => {
    const rights = listingSettingsEditRights(input({ account: null, summary: { storeStatus: "paused", catalog: { state: "ok", products: 1, sizes: 1 } } }));
    expect(rights.price).toEqual({ editable: false, reason: "banner" });
  });

  it("during a sign-in, prices and descriptions stay editable and eBay choices say Reconnect (R:500)", () => {
    for (const cell of [
      input({ summary: { storeStatus: "needs_reauth", catalog: { state: "ok", products: 1, sizes: 1 } }, setup: { error: apiError(409, "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED") } }),
      input({ setup: { error: apiError(403, "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED") } }),
      input({ blocked: { kind: "sign_in", diagnosticReference: null } }),
      input({ shelves: { error: apiError(403, "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED") } }),
    ]) {
      const rights = listingSettingsEditRights(cell);
      expect(editableRights(rights)).toEqual(["price", "exactPrice", "description"]);
      for (const right of ["policies", "shipping", "shelfPick", "shelfNone", "shipFrom", "ebayCategory"] as const) {
        expect(rights[right]).toEqual({ editable: false, reason: "sign_in" });
      }
      expect(chooseConnectionBanner(cell)?.kind).toBe("sign_in");
    }
  });

  it("eBay unreachable keeps every choice that needs no setup read (R:502)", () => {
    const cell = input({ setup: { error: apiError(503, "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED") } });
    const rights = listingSettingsEditRights(cell);
    expect(editableRights(rights)).toEqual(["price", "exactPrice", "ebayCategory", "description"]);
    expect(rights.policies).toEqual({ editable: false, reason: "unreachable" });
    expect(chooseConnectionBanner(cell)).toEqual({ kind: "unreachable", diagnosticReference: null });
  });

  it("a failed setup read that names nothing is shown as unreachable, so Try again is offered", () => {
    for (const error of [new TypeError("Failed to fetch"), apiError(500, "DROPSHIP_EBAY_LISTING_SETUP_INTERNAL_ERROR"), apiError(404, "DROPSHIP_STORE_CONNECTION_NOT_FOUND")]) {
      expect(readListingSetupState({ data: undefined, error })).toEqual({ state: "failed", banner: { kind: "unreachable", diagnosticReference: null } });
      expect(listingSettingsEditRights(input({ setup: { error } })).shipping).toEqual({ editable: false, reason: "unreachable" });
    }
  });

  it("the latest failed refetch wins over the older answer it would have replaced", () => {
    const cell = input({ setup: { data: setupChecked(), error: apiError(502, "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE") } });
    expect(listingSettingsEditRights(cell).policies).toEqual({ editable: false, reason: "unreachable" });
  });

  it("an answer without a revision asks for a reload; one that didn't read eBay can't be saved from (C1)", () => {
    expect(listingSettingsEditRights(input({ setup: { data: setupChecked({ revision: null }) } })).policies)
      .toEqual({ editable: false, reason: "reload" });
    expect(listingSettingsEditRights(input({ setup: { data: setupChecked({ revision: undefined }) } })).shelfNone)
      .toEqual({ editable: false, reason: "reload" });
    expect(listingSettingsEditRights(input({ setup: { data: setupChecked({ checks: { ebay: "not_checked", fulfillment: { status: "checked" } } }) } })).shelfNone)
      .toEqual({ editable: false, reason: "unreachable" });
  });

  it("the shipping policy waits for Card Shellz shipping; return, payment and shelves don't", () => {
    const unfinished = listingSettingsEditRights(input({ setup: { data: setupChecked({ missingFields: ["merchantLocationKey"], checks: { ebay: "checked", fulfillment: { status: "unavailable", reference: "R-1", kind: "setup_incomplete" } } }) } }));
    expect(unfinished.shipping).toEqual({ editable: false, reason: "shipping_setup" });
    expect(unfinished.shipFrom).toEqual({ editable: false, reason: "shipping_setup" });
    expect(editableRights(unfinished)).toEqual(["price", "exactPrice", "policies", "shelfPick", "shelfNone", "ebayCategory", "description"]);
    const outage = listingSettingsEditRights(input({ setup: { data: setupChecked({ checks: { ebay: "checked", fulfillment: { status: "unavailable", reference: "R-2", kind: "temporary" } } }) } }));
    expect(outage.shipping).toEqual({ editable: false, reason: "shipping_unavailable" });
  });

  it("the ship-from repair waits for a policy change that isn't saved (C19)", () => {
    const needsRepair = { setup: { data: setupChecked({ missingFields: ["merchantLocationKey"] }) } };
    expect(listingSettingsEditRights(input(needsRepair)).shipFrom).toEqual({ editable: true, reason: null });
    expect(listingSettingsEditRights(input({ ...needsRepair, unsavedPolicyDraft: true })).shipFrom).toEqual({ editable: false, reason: "save_policy_first" });
  });

  it("picking a shelf needs the shelves read; None needs only the setup read", () => {
    const rights = listingSettingsEditRights(input({ shelves: { error: apiError(502, "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE") } }));
    expect(rights.shelfPick).toEqual({ editable: false, reason: "unreachable" });
    expect(rights.shelfNone.editable).toBe(true);
    expect(chooseConnectionBanner(input({ shelves: { error: apiError(502, "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE") } }))).toBeNull();
  });

  it("more than 10,000 sizes turns every Save off (R:521)", () => {
    for (const cell of [
      input({ summary: { storeStatus: "connected", catalog: { state: "too_large", limit: 10_000 } } }),
      input({ blocked: bannerFromWriteError(apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE")) }),
    ]) {
      expect(editableRights(listingSettingsEditRights(cell))).toEqual([]);
      expect(chooseConnectionBanner(cell)?.kind).toBe("too_large");
    }
  });

  it("a block a save reported sticks: it locks what it names until a refetch clears it", () => {
    const ops = listingSettingsEditRights(input({ blocked: { kind: "ops_inactive", diagnosticReference: null } }));
    expect(editableRights(ops)).toEqual(["policies", "shipping", "shelfPick", "shelfNone"]);
    const otherSite = listingSettingsEditRights(input({ blocked: { kind: "other_site", diagnosticReference: null } }));
    expect(editableRights(otherSite)).toEqual([]);
  });

  it("eBay access refused under a wider banner gets its own line", () => {
    const cell = input({
      account: { status: "paused", entitlementStatus: "active" },
      setup: { error: apiError(403, "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", { diagnosticReference: "8d1c7f0e-2b8b-4c55-9f1e-3f4a6b7c8d9e" }) },
    });
    expect(chooseConnectionBanner(cell)?.kind).toBe("selling_paused");
    const rights = listingSettingsEditRights(cell);
    expect(rights.policies).toEqual({ editable: false, reason: "ebay_access_denied" });
    expect(rights.price).toEqual({ editable: false, reason: "banner" });
  });

  it("statuses this page doesn't know fail closed", () => {
    const vendor = input({ account: { status: "reviewing", entitlementStatus: "active" } });
    expect(editableRights(listingSettingsEditRights(vendor))).toEqual([]);
    expect(chooseConnectionBanner(vendor)?.kind).toBe("account_inactive");
    const store = input({ summary: { storeStatus: "migrating", catalog: { state: "ok", products: 1, sizes: 1 } } });
    expect(editableRights(listingSettingsEditRights(store))).toEqual([]);
    expect(chooseConnectionBanner(store)?.kind).toBe("store_disconnected");
    const entitlement = input({ account: { status: "active", entitlementStatus: "not_entitled" } });
    expect(chooseConnectionBanner(entitlement)?.kind).toBe("ops_inactive");
  });

  it("never mutates its input and returns a frozen answer", () => {
    const cell = input({ setup: { data: setupChecked({ missingFields: ["merchantLocationKey"] }) } });
    const before = JSON.stringify(cell);
    const rights = listingSettingsEditRights(cell);
    expect(JSON.stringify(cell)).toBe(before);
    expect(Object.isFrozen(rights)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The one banner
// ---------------------------------------------------------------------------

type Facet = "vendor" | "entitlement" | "storeStatus" | "catalog" | "setup" | "shelves" | "blocked";
interface Way { facets: Facet[]; apply: (cell: ListingSettingsRightsInput) => ListingSettingsRightsInput }

const blocked = (kind: ConnectionBannerKind): Way => ({ facets: ["blocked"], apply: (cell) => ({ ...cell, blocked: { kind, diagnosticReference: null } }) });
const withSetup = (setup: ListingSettingsAccessInput["setup"]): Way => ({ facets: ["setup"], apply: (cell) => ({ ...cell, setup }) });
const withStore = (storeStatus: string): Way => ({ facets: ["storeStatus"], apply: (cell) => ({ ...cell, summary: { ...cell.summary!, storeStatus } }) });
const withVendor = (status: string): Way => ({ facets: ["vendor"], apply: (cell) => ({ ...cell, account: { ...cell.account!, status } }) });

/** Every way each banner's condition can arise (plan 4.4 "When"). */
const WAYS: Readonly<Record<ConnectionBannerKind, Way[]>> = {
  account_inactive: [withVendor("closed"), withSetup({ data: setupChecked({ access: { canEdit: false, reason: "vendor_not_active" } }) }), blocked("account_inactive")],
  store_paused: [withStore("paused"), withSetup({ data: setupChecked({ access: { canEdit: false, reason: "store_paused" } }) }), blocked("store_paused")],
  store_disconnecting: [withStore("grace_period"), withSetup({ data: setupChecked({ access: { canEdit: false, reason: "store_disconnecting" } }) }), blocked("store_disconnecting")],
  store_disconnected: [withStore("disconnected"), withSetup({ data: setupChecked({ access: { canEdit: false, reason: "store_disconnected" } }) }), blocked("store_disconnected")],
  too_large: [{ facets: ["catalog"], apply: (cell) => ({ ...cell, summary: { ...cell.summary!, catalog: { state: "too_large", limit: 10_000 } } }) }, blocked("too_large")],
  other_site: [withSetup({ data: setupChecked({ checks: { ebay: "checked", fulfillment: { status: "unavailable", reference: "X", kind: "marketplace_unsupported" } } }) }), blocked("other_site")],
  selling_paused: [withVendor("paused"), blocked("selling_paused")],
  ops_inactive: [{ facets: ["entitlement"], apply: (cell) => ({ ...cell, account: { ...cell.account!, entitlementStatus: "grace" } }) }, blocked("ops_inactive")],
  sign_in: [withStore("needs_reauth"), withSetup({ error: apiError(409, "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED") }),
    { facets: ["shelves"], apply: (cell) => ({ ...cell, shelves: { error: apiError(403, "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED") } }) }, blocked("sign_in")],
  access_denied: [withSetup({ error: apiError(403, "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED") }),
    { facets: ["shelves"], apply: (cell) => ({ ...cell, shelves: { error: apiError(403, "DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED") } }) }, blocked("access_denied")],
  unreachable: [withSetup({ error: apiError(502, "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE") })],
};

describe("the one connection banner (plan 4.4)", () => {
  it("shows none when nothing needs the vendor", () => {
    expect(chooseConnectionBanner(input())).toBeNull();
    // refresh_failed has no banner; the strip's reconnect line covers it (C4).
    expect(chooseConnectionBanner(input({ summary: { storeStatus: "refresh_failed", catalog: { state: "ok", products: 1, sizes: 1 } } }))).toBeNull();
  });

  it("every way a condition arises shows its banner", () => {
    for (const kind of CONNECTION_BANNER_KINDS) {
      for (const way of WAYS[kind]) expect({ kind, shown: chooseConnectionBanner(way.apply(input()))?.kind }).toEqual({ kind, shown: kind });
    }
  });

  it("shows exactly one, the widest, for every pair of conditions", () => {
    let pairs = 0;
    CONNECTION_BANNER_KINDS.forEach((first, firstIndex) => {
      for (const second of CONNECTION_BANNER_KINDS.slice(firstIndex + 1)) {
        const combination = WAYS[first].flatMap((a) => WAYS[second].map((b) => [a, b] as const))
          .find(([a, b]) => !a.facets.some((facet) => b.facets.includes(facet)));
        expect({ first, second, composable: combination !== undefined }).toEqual({ first, second, composable: true });
        const [a, b] = combination!;
        const banner = chooseConnectionBanner(b.apply(a.apply(input())));
        expect({ first, second, shown: banner?.kind }).toEqual({ first, second, shown: first });
        pairs += 1;
      }
    });
    expect(pairs).toBe((CONNECTION_BANNER_KINDS.length * (CONNECTION_BANNER_KINDS.length - 1)) / 2);
  });

  it("orders kinds that lock every change before the ones that leave some open", () => {
    // A paused vendor whose store is also paused can't change policies either, so the store banner shows.
    expect(chooseConnectionBanner(input({ account: { status: "paused", entitlementStatus: "active" }, summary: { storeStatus: "paused", catalog: { state: "ok", products: 1, sizes: 1 } } }))?.kind)
      .toBe("store_paused");
  });

  it("carries the support code eBay's refusal gave, and drops one that isn't a code", () => {
    const reference = "8d1c7f0e-2b8b-4c55-9f1e-3f4a6b7c8d9e";
    expect(chooseConnectionBanner(input({ setup: { error: apiError(403, "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", { diagnosticReference: reference }) } })))
      .toEqual({ kind: "access_denied", diagnosticReference: reference });
    expect(chooseConnectionBanner(input({ setup: { error: apiError(403, "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", { diagnosticReference: "<b>call us</b>" }) } })))
      .toEqual({ kind: "access_denied", diagnosticReference: null });
  });
});

describe("bannerFromWriteError (plan 4.5 blocked codes)", () => {
  const cases: Array<[number, string, Record<string, unknown> | undefined, ConnectionBannerKind | null]> = [
    // W2, W10
    [409, "DROPSHIP_LISTING_CONFIG_STORE_PAUSED", undefined, "store_paused"],
    [409, "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING", undefined, "store_disconnecting"],
    [409, "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED", undefined, "store_disconnected"],
    [409, "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE", { status: "grace_period" }, "store_disconnecting"],
    [409, "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE", undefined, null],
    [409, "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", { status: "paused" }, "store_paused"],
    [409, "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", { status: "needs_reauth" }, "sign_in"],
    [409, "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", { status: "refresh_failed" }, null],
    [409, "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED", undefined, "sign_in"],
    [403, "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", undefined, "sign_in"],
    [403, "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", undefined, "access_denied"],
    [403, "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED", undefined, "sign_in"],
    [403, "DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED", undefined, "access_denied"],
    [409, "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", undefined, "other_site"],
    [403, "DROPSHIP_ENTITLEMENT_REQUIRED", undefined, "ops_inactive"],
    [403, "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED", undefined, "account_inactive"],
    // W1, W4: vendor, .ops or store; the reads say which.
    [403, "DROPSHIP_PRICING_NOT_ALLOWED", undefined, null],
    [403, "DROPSHIP_CONTENT_NOT_ALLOWED", undefined, null],
    // W3
    [403, "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED", undefined, "sign_in"],
    [403, "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED", undefined, "access_denied"],
    [403, "DROPSHIP_EBAY_CATEGORY_RULES_NOT_ALLOWED", undefined, null],
    [403, "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED", { status: "disconnected" }, "store_disconnected"],
    [422, "DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED", undefined, "other_site"],
    // W9
    [403, "DROPSHIP_LISTING_VENDOR_BLOCKED", undefined, null],
    [403, "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", undefined, "ops_inactive"],
    [403, "DROPSHIP_LISTING_STORE_BLOCKED", undefined, null],
    // The lists
    [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", undefined, "too_large"],
    // Not blocks
    [409, "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT", undefined, null],
    [429, "DROPSHIP_EBAY_LISTING_SETUP_RATE_LIMITED", undefined, null],
    [502, "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", undefined, null],
    [403, "constructor", undefined, null],
    [403, "toString", undefined, null],
  ];

  it.each(cases)("%i %s %o → %s", (status, code, context, kind) => {
    const banner = bannerFromWriteError(apiError(status, code, context));
    expect(banner?.kind ?? null).toBe(kind);
  });

  it("reads only refusals from the server", () => {
    expect(bannerFromWriteError(new Error("DROPSHIP_LISTING_CONFIG_STORE_PAUSED"))).toBeNull();
    expect(bannerFromWriteError(new DropshipApiError({ message: "no code", status: 403 }))).toBeNull();
    expect(bannerFromWriteError(null)).toBeNull();
  });

  it("keeps the support code only on an access refusal", () => {
    const reference = "8d1c7f0e-2b8b-4c55-9f1e-3f4a6b7c8d9e";
    expect(bannerFromWriteError(apiError(403, "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED", { diagnosticReference: ` ${reference} ` })))
      .toEqual({ kind: "access_denied", diagnosticReference: reference });
    expect(bannerFromWriteError(apiError(403, "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", { diagnosticReference: reference })))
      .toEqual({ kind: "sign_in", diagnosticReference: null });
  });
});
