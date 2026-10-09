import { describe, expect, it, vi } from "vitest";
import type { DropshipEbayListingSetupResponse, DropshipStoreConnectionSummary } from "../dropship-ops-surface";
import {
  CATALOG_STEPS,
  catalogStepFromLocation,
  catalogStepPath,
  catalogStoreName,
  catalogStoreOptions,
  catalogStoreStorageKey,
  chooseCatalogStore,
  chooseStepTick,
  describeCatalogActionBar,
  describeListingSettingsRail,
  isCatalogLocation,
  nextCatalogStep,
  readRememberedCatalogStore,
  rememberCatalogStore,
  type ListingSettingsRailInput,
} from "../dropship-catalog-steps";

function connection(overrides: Partial<DropshipStoreConnectionSummary>): DropshipStoreConnectionSummary {
  return {
    storeConnectionId: 5, platform: "ebay", status: "connected", setupStatus: "ready", externalDisplayName: "Marz Cards",
    shopDomain: null, hasAccessToken: true, hasRefreshToken: true, launchReady: true, updatedAt: "2026-09-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("catalog step locations", () => {
  it("names each step by its path, on the portal host and under the /dropship-portal prefix", () => {
    for (const step of CATALOG_STEPS) {
      expect(catalogStepFromLocation(catalogStepPath(step))).toBe(step);
      expect(catalogStepFromLocation(`/dropship-portal${catalogStepPath(step)}`)).toBe(step);
      expect(catalogStepFromLocation(`${catalogStepPath(step)}/`)).toBe(step);
    }
  });

  it("names no step for the bare catalog path, an unknown step, a deeper path or another page", () => {
    expect(catalogStepFromLocation("/catalog")).toBeNull();
    expect(catalogStepFromLocation("/dropship-portal/catalog/")).toBeNull();
    expect(catalogStepFromLocation("/catalog/status")).toBeNull();
    expect(catalogStepFromLocation("/catalog/Choose")).toBeNull();
    expect(catalogStepFromLocation("/catalog/setup/extra")).toBeNull();
    expect(catalogStepFromLocation("/wallet")).toBeNull();
    expect(catalogStepFromLocation("")).toBeNull();
  });

  it("sends only the page's own addresses to Choose, never a page the vendor is leaving for", () => {
    for (const path of ["/catalog", "/catalog/", "/dropship-portal/catalog", "/catalog/status", "/catalog/Choose", "/catalog/choose"]) {
      expect(isCatalogLocation(path)).toBe(true);
    }
    for (const path of ["/onboarding", "/dropship-portal/wallet", "/catalogue", "/catalog/setup/extra", "/__catalog-access-test"]) {
      expect(isCatalogLocation(path)).toBe(false);
    }
  });

  it("orders the steps choose, setup, publish", () => {
    expect(nextCatalogStep("choose")).toBe("setup");
    expect(nextCatalogStep("setup")).toBe("publish");
    expect(nextCatalogStep("publish")).toBeNull();
  });
});

describe("catalog step ticks", () => {
  it("ticks Choose once any active include rule exists, and claims nothing while rules load", () => {
    expect(chooseStepTick(undefined)).toBe("unknown");
    expect(chooseStepTick([])).toBe("todo");
    expect(chooseStepTick([{ action: "exclude", isActive: true }])).toBe("todo");
    expect(chooseStepTick([{ action: "include", isActive: false }])).toBe("todo");
    expect(chooseStepTick([{ action: "exclude" }, { action: "include" }])).toBe("done");
  });

});

describe("the rail's line under Listing settings", () => {
  type Rail = Extract<ListingSettingsRailInput["summary"], { status: "ready" }>["rail"];
  const ready = (rail: Partial<Rail> = {}): ListingSettingsRailInput["summary"] =>
    ({ status: "ready", rail: { state: "all_set", productsNeedingFix: 0, missingPolicy: null, ...rail } });
  const rail = (input: Partial<ListingSettingsRailInput> = {}) => describeListingSettingsRail({
    storesLoaded: true, storeChosen: true, summary: ready(), liveSetup: null, ...input });

  it("claims nothing while the stores or the summary load, and says when no eBay store is ready", () => {
    expect(rail({ storesLoaded: false, storeChosen: false })).toEqual({ tick: "unknown", line: "Checking…", retry: false });
    expect(rail({ summary: { status: "loading" } })).toEqual({ tick: "unknown", line: "Checking…", retry: false });
    expect(rail({ storeChosen: false, summary: { status: "loading" } })).toEqual({ tick: "todo", line: "No eBay store", retry: false });
  });

  it("offers Try again when the summary could not be read", () => {
    expect(rail({ summary: { status: "failed" } })).toEqual({ tick: "unknown", line: "Couldn't check", retry: true });
  });

  it("ticks only when everything is set", () => {
    expect(rail()).toEqual({ tick: "done", line: "All set", retry: false });
    expect(rail({ liveSetup: { missingFields: [] } })).toEqual({ tick: "done", line: "All set", retry: false });
  });

  it("names the first thing to do: reconnect, then policies, then ship-from, then products", () => {
    expect(rail({ summary: ready({ state: "reconnect_store" }), liveSetup: { missingFields: ["fulfillmentPolicyId"] } }).line)
      .toBe("Reconnect eBay");
    expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "return" }) }))
      .toEqual({ tick: "todo", line: "Choose a return policy", retry: false });
    expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "payment" }), liveSetup: { missingFields: ["fulfillmentPolicyCompatibility"] } }).line)
      .toBe("Choose a shipping policy");
    expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 2 }), liveSetup: { missingFields: ["merchantLocationKey"] } }).line)
      .toBe("Ship-from location needs updating");
    expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 1 }) }).line).toBe("1 product needs a fix");
    expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 3 }) }).line).toBe("3 products need a fix");
    expect(rail({ summary: ready({ state: "too_many_sizes" }) }).line).toBe("Too many sizes to check");
  });

  it("never says All set over a problem the live eBay check found", () => {
    expect(rail({ liveSetup: { missingFields: ["fulfillmentPolicyCompatibility"] } }).line).toBe("Choose a shipping policy");
    expect(rail({ liveSetup: { missingFields: ["paymentPolicyId"] } }).line).toBe("Choose a payment policy");
    expect(rail({ liveSetup: { missingFields: ["merchantLocationKey"] } }).line).toBe("Ship-from location needs updating");
    expect(rail({ liveSetup: { missingFields: ["somethingNew"] } })).toEqual({ tick: "todo", line: "Finish your eBay setup", retry: false });
  });

  it("still asks for policies when a broken answer names none", () => {
    expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: null }) }).line).toBe("Choose your eBay policies");
  });

  describe("a live check that did not run everything", () => {
    type Checks = NonNullable<NonNullable<ListingSettingsRailInput["liveSetup"]>["checks"]>;
    const COULD_NOT_CHECK = { tick: "unknown", line: "Couldn't check", retry: true };
    const FINISHING_SETUP = { tick: "unknown", line: "Card Shellz is finishing setup", retry: false };
    const CONTACT_SUPPORT = { tick: "todo", line: "Contact support", retry: false };
    const todo = (line: string) => ({ tick: "todo", line, retry: false });
    /** Checks that missed only for a passing reason (eBay not read, a shipping outage, shipping not read): worth a retry. */
    const TEMPORARY: ReadonlyArray<{ name: string; checks: Checks }> = [
      { name: "eBay not read", checks: { ebay: "not_checked", fulfillment: { status: "checked" } } },
      { name: "shipping temporarily unavailable", checks: { ebay: "checked", fulfillment: { status: "unavailable", kind: "temporary" } } },
      { name: "shipping not checked", checks: { ebay: "checked", fulfillment: { status: "not_checked" } } },
      { name: "eBay not read, shipping temporarily unavailable",
        checks: { ebay: "not_checked", fulfillment: { status: "unavailable", kind: "temporary" } } },
      { name: "neither checked", checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } } },
    ];
    /** Shipping unread because Card Shellz has not finished the store's shipping setup: a retry changes nothing. */
    const SETUP_INCOMPLETE: ReadonlyArray<{ name: string; checks: Checks }> = [
      { name: "eBay read", checks: { ebay: "checked", fulfillment: { status: "unavailable", kind: "setup_incomplete" } } },
      { name: "eBay not read", checks: { ebay: "not_checked", fulfillment: { status: "unavailable", kind: "setup_incomplete" } } },
    ];
    /** The store is on an eBay site Card Shellz does not list on: only support can help. */
    const MARKETPLACE_UNSUPPORTED: ReadonlyArray<{ name: string; checks: Checks }> = [
      { name: "eBay read", checks: { ebay: "checked", fulfillment: { status: "unavailable", kind: "marketplace_unsupported" } } },
      { name: "eBay not read", checks: { ebay: "not_checked", fulfillment: { status: "unavailable", kind: "marketplace_unsupported" } } },
    ];
    const UNCHECKED = [...TEMPORARY, ...SETUP_INCOMPLETE, ...MARKETPLACE_UNSUPPORTED];

    it.each(TEMPORARY)("says Couldn't check and offers Try again instead of All set ($name)", ({ checks }) => {
      expect(rail({ liveSetup: { missingFields: [], checks } })).toEqual(COULD_NOT_CHECK);
    });

    it.each(SETUP_INCOMPLETE)("says Card Shellz is finishing setup, with no Try again, when its shipping setup is not done ($name)", ({ checks }) => {
      expect(rail({ liveSetup: { missingFields: [], checks } })).toEqual(FINISHING_SETUP);
    });

    it.each(MARKETPLACE_UNSUPPORTED)("asks the vendor to contact support for a store on an eBay site Card Shellz does not list on ($name)", ({ checks }) => {
      expect(rail({ liveSetup: { missingFields: [], checks } })).toEqual(CONTACT_SUPPORT);
    });

    it("takes the live setup answer as the page passes it, with the shipping check's reference and kind", () => {
      // DropshipPortalCatalog hands the whole setup answer over; its unavailable check carries more than the status.
      const answer = (kind: "temporary" | "setup_incomplete" | "marketplace_unsupported"): Pick<
        DropshipEbayListingSetupResponse, "missingFields" | "access" | "checks"
      > => ({
        missingFields: [],
        access: { canEdit: true, reason: null },
        checks: { ebay: "checked", fulfillment: {
          status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", kind,
        } },
      });
      expect(rail({ liveSetup: answer("temporary") })).toEqual(COULD_NOT_CHECK);
      expect(rail({ liveSetup: answer("setup_incomplete") })).toEqual(FINISHING_SETUP);
      expect(rail({ liveSetup: answer("marketplace_unsupported") })).toEqual(CONTACT_SUPPORT);
      const readOnly: Pick<DropshipEbayListingSetupResponse, "missingFields" | "access" | "checks"> = {
        missingFields: [],
        access: { canEdit: false, reason: "store_paused" },
        checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
      };
      expect(rail({ liveSetup: readOnly })).toEqual({ tick: "unknown", line: "View only", retry: false });
    });

    // Changed on purpose (review round 4, describeListingSettingsRail): a store on an eBay site Card
    // Shellz does not list on now says Contact support over anything else the vendor could do, and
    // the ship-from line waits for Card Shellz shipping to be checked (see "while Card Shellz
    // shipping is unchecked" below), so neither is asserted for every unchecked answer here.
    it.each([...TEMPORARY, ...SETUP_INCOMPLETE])("still names a policy, setup or product the vendor can fix ($name)", ({ checks }) => {
      expect(rail({ liveSetup: { missingFields: ["paymentPolicyId"], checks } })).toEqual(todo("Choose a payment policy"));
      expect(rail({ liveSetup: { missingFields: ["returnPolicyId"], checks } })).toEqual(todo("Choose a return policy"));
      expect(rail({ liveSetup: { missingFields: ["somethingNew"], checks } })).toEqual(todo("Finish your eBay setup"));
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "return" }), liveSetup: { missingFields: [], checks } }))
        .toEqual(todo("Choose a return policy"));
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "payment" }), liveSetup: { missingFields: [], checks } }))
        .toEqual(todo("Choose a payment policy"));
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: null }), liveSetup: { missingFields: [], checks } }))
        .toEqual(todo("Choose your eBay policies"));
      expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 2 }), liveSetup: { missingFields: [], checks } }))
        .toEqual(todo("2 products need a fix"));
    });

    it.each(UNCHECKED)("still says Reconnect eBay or Too many sizes first ($name)", ({ checks }) => {
      expect(rail({ summary: ready({ state: "reconnect_store" }), liveSetup: { missingFields: ["paymentPolicyId"], checks } }))
        .toEqual(todo("Reconnect eBay"));
      expect(rail({ summary: ready({ state: "too_many_sizes" }), liveSetup: { missingFields: [], checks } }))
        .toEqual(todo("Too many sizes to check"));
    });

    it("names the ship-from location when only eBay went unread: Card Shellz shipping was checked", () => {
      const checks: Checks = { ebay: "not_checked", fulfillment: { status: "checked" } };
      expect(rail({ liveSetup: { missingFields: ["merchantLocationKey"], checks } })).toEqual(todo("Ship-from location needs updating"));
      expect(rail({ liveSetup: { missingFields: ["fulfillmentPolicyCompatibility", "merchantLocationKey"], checks } }))
        .toEqual(todo("Choose a shipping policy"));
    });

    it.each(MARKETPLACE_UNSUPPORTED)("says Contact support over every policy, ship-from, setup or product line ($name)", ({ checks }) => {
      // Card Shellz can't list on this eBay site at all, so nothing else on Listing settings would help.
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "return" }), liveSetup: { missingFields: [], checks } }))
        .toEqual(CONTACT_SUPPORT);
      expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 2 }), liveSetup: { missingFields: [], checks } }))
        .toEqual(CONTACT_SUPPORT);
      expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 2 }),
        liveSetup: { missingFields: ["returnPolicyId"], checks } })).toEqual(CONTACT_SUPPORT);
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: null }), liveSetup: { missingFields: [], checks } }))
        .toEqual(CONTACT_SUPPORT);
      for (const missingFields of [["fulfillmentPolicyId"], ["fulfillmentPolicyCompatibility"], ["returnPolicyId"], ["paymentPolicyId"],
        ["merchantLocationKey"], ["somethingNew"], ["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId", "merchantLocationKey"]]) {
        expect(rail({ liveSetup: { missingFields, checks } }), missingFields.join()).toEqual(CONTACT_SUPPORT);
      }
    });

    it("says Contact support before a missing return policy and before products that need a fix", () => {
      const checks: Checks = { ebay: "checked", fulfillment: { status: "unavailable", kind: "marketplace_unsupported" } };
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "return" }), liveSetup: { missingFields: ["returnPolicyId"], checks } }))
        .toEqual(CONTACT_SUPPORT);
      expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 1 }), liveSetup: { missingFields: [], checks } }))
        .toEqual(CONTACT_SUPPORT);
      // The same answers on a site Card Shellz does list on name the vendor's own fix.
      const listed: Checks = { ebay: "checked", fulfillment: { status: "checked" } };
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "return" }), liveSetup: { missingFields: ["returnPolicyId"], checks: listed } }))
        .toEqual(todo("Choose a return policy"));
      expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 1 }), liveSetup: { missingFields: [], checks: listed } }))
        .toEqual(todo("1 product needs a fix"));
    });

    it("says All set for a fully checked answer, an answer from a server before checks, or no live check yet", () => {
      const allSet = { tick: "done", line: "All set", retry: false };
      expect(rail({ liveSetup: { missingFields: [], checks: { ebay: "checked", fulfillment: { status: "checked" } } } })).toEqual(allSet);
      // A server before the check states sent no checks field; it always ran both checks.
      expect(rail({ liveSetup: { missingFields: [] } })).toEqual(allSet);
      expect(rail({ liveSetup: { missingFields: [], checks: undefined } })).toEqual(allSet);
      // A server before access was reported sent no access field; the rail does not read that as view only.
      expect(rail({ liveSetup: { missingFields: [], access: undefined } })).toEqual(allSet);
      expect(rail({ liveSetup: null })).toEqual(allSet);
    });

    it("still says Couldn't check, not the live check's words, when the summary could not be read", () => {
      for (const { checks } of UNCHECKED) {
        expect(rail({ summary: { status: "failed" }, liveSetup: { missingFields: [], checks } }), JSON.stringify(checks))
          .toEqual(COULD_NOT_CHECK);
        expect(rail({ summary: { status: "loading" }, liveSetup: { missingFields: [], checks } }), JSON.stringify(checks))
          .toEqual({ tick: "unknown", line: "Checking…", retry: false });
      }
    });
  });

  describe("a store the vendor can only view", () => {
    const VIEW_ONLY = { tick: "unknown", line: "View only", retry: false };
    const viewOnly = (missingFields: readonly string[] = [], checks?: NonNullable<ListingSettingsRailInput["liveSetup"]>["checks"]) =>
      ({ missingFields, access: { canEdit: false }, checks });

    it("says View only, with no Try again, for a read-only answer", () => {
      // A read-only answer reads neither eBay nor Card Shellz shipping; nothing here would change on a retry.
      expect(rail({ liveSetup: viewOnly([], { ebay: "not_checked", fulfillment: { status: "not_checked" } }) })).toEqual(VIEW_ONLY);
      expect(rail({ liveSetup: viewOnly() })).toEqual(VIEW_ONLY);
    });

    it("says View only over a policy, ship-from, product or setup line the vendor could not act on", () => {
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "return" }), liveSetup: viewOnly() })).toEqual(VIEW_ONLY);
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: null }), liveSetup: viewOnly() })).toEqual(VIEW_ONLY);
      expect(rail({ liveSetup: viewOnly(["fulfillmentPolicyCompatibility"]) })).toEqual(VIEW_ONLY);
      expect(rail({ liveSetup: viewOnly(["paymentPolicyId"]) })).toEqual(VIEW_ONLY);
      expect(rail({ liveSetup: viewOnly(["merchantLocationKey"]) })).toEqual(VIEW_ONLY);
      expect(rail({ liveSetup: viewOnly(["somethingNew"]) })).toEqual(VIEW_ONLY);
      expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 2 }), liveSetup: viewOnly() })).toEqual(VIEW_ONLY);
      for (const kind of ["temporary", "setup_incomplete", "marketplace_unsupported"] as const) {
        expect(rail({ liveSetup: viewOnly([], { ebay: "checked", fulfillment: { status: "unavailable", kind } }) }), kind).toEqual(VIEW_ONLY);
      }
    });

    it("still says Reconnect eBay or Too many sizes first, and still waits for or retries the summary", () => {
      expect(rail({ summary: ready({ state: "reconnect_store" }), liveSetup: viewOnly(["paymentPolicyId"]) }))
        .toEqual({ tick: "todo", line: "Reconnect eBay", retry: false });
      expect(rail({ summary: ready({ state: "too_many_sizes" }), liveSetup: viewOnly() }))
        .toEqual({ tick: "todo", line: "Too many sizes to check", retry: false });
      expect(rail({ summary: { status: "failed" }, liveSetup: viewOnly() })).toEqual({ tick: "unknown", line: "Couldn't check", retry: true });
      expect(rail({ summary: { status: "loading" }, liveSetup: viewOnly() })).toEqual({ tick: "unknown", line: "Checking…", retry: false });
      expect(rail({ storeChosen: false, liveSetup: viewOnly() })).toEqual({ tick: "todo", line: "No eBay store", retry: false });
    });

    it("reads a store the vendor can change as usual", () => {
      const canEdit = (missingFields: readonly string[] = []) => ({ missingFields, access: { canEdit: true } });
      expect(rail({ liveSetup: canEdit() })).toEqual({ tick: "done", line: "All set", retry: false });
      expect(rail({ liveSetup: canEdit(["paymentPolicyId"]) })).toEqual({ tick: "todo", line: "Choose a payment policy", retry: false });
    });
  });

  describe("a live check that could not be read again", () => {
    type LiveAnswer = Pick<DropshipEbayListingSetupResponse, "missingFields" | "access" | "checks">;
    /**
     * What DropshipPortalCatalog passes when the live read failed: the last
     * good answer's missing fields, nothing checked, and no access, so a
     * failed read never vouches for the store or calls it view only.
     */
    const failedLiveRead = (lastAnswer: LiveAnswer | undefined): NonNullable<ListingSettingsRailInput["liveSetup"]> => ({
      missingFields: lastAnswer?.missingFields ?? [],
      checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
    });
    const CHECKED = { ebay: "checked", fulfillment: { status: "checked" } } as const;
    const COULD_NOT_CHECK = { tick: "unknown", line: "Couldn't check", retry: true };

    it("says Couldn't check and offers Try again, never All set or View only", () => {
      expect(rail({ liveSetup: failedLiveRead(undefined) })).toEqual(COULD_NOT_CHECK);
      expect(rail({ liveSetup: failedLiveRead({ missingFields: [], access: { canEdit: true, reason: null }, checks: CHECKED }) }))
        .toEqual(COULD_NOT_CHECK);
      // The last answer said view only; a failed read cannot say whether it still is.
      expect(rail({ liveSetup: failedLiveRead({
        missingFields: [], access: { canEdit: false, reason: "store_paused" },
        checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
      }) })).toEqual(COULD_NOT_CHECK);
    });

    const last = (missingFields: string[]): LiveAnswer => ({ missingFields, access: { canEdit: true, reason: null }, checks: CHECKED });

    it("still names a return, payment, setup or product problem the last good answer showed", () => {
      expect(rail({ liveSetup: failedLiveRead(last(["returnPolicyId"])) }))
        .toEqual({ tick: "todo", line: "Choose a return policy", retry: false });
      expect(rail({ liveSetup: failedLiveRead(last(["returnPolicyId", "merchantLocationKey"])) }))
        .toEqual({ tick: "todo", line: "Choose a return policy", retry: false });
      expect(rail({ liveSetup: failedLiveRead(last(["fulfillmentPolicyCompatibility", "returnPolicyId"])) }))
        .toEqual({ tick: "todo", line: "Choose a return policy", retry: false });
      expect(rail({ liveSetup: failedLiveRead(last(["paymentPolicyId"])) }))
        .toEqual({ tick: "todo", line: "Choose a payment policy", retry: false });
      expect(rail({ liveSetup: failedLiveRead(last(["somethingNew"])) }))
        .toEqual({ tick: "todo", line: "Finish your eBay setup", retry: false });
      expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 1 }), liveSetup: failedLiveRead(last([])) }))
        .toEqual({ tick: "todo", line: "1 product needs a fix", retry: false });
    });

    it("says Couldn't check, with Try again, over a shipping or ship-from problem the last good answer showed", () => {
      // Changed on purpose (review round 4, describeListingSettingsRail): a failed read did not check
      // Card Shellz shipping, so the shipping policy can't be chosen and the ship-from location can't
      // be fixed from it. Before, the rail kept asking for them from the stale answer.
      for (const missingFields of [["fulfillmentPolicyCompatibility"], ["fulfillmentPolicyId"], ["merchantLocationKey"],
        ["fulfillmentPolicyId", "merchantLocationKey"]]) {
        expect(rail({ liveSetup: failedLiveRead(last(missingFields)) }), missingFields.join()).toEqual(COULD_NOT_CHECK);
      }
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "shipping" }), liveSetup: failedLiveRead(last([])) }))
        .toEqual(COULD_NOT_CHECK);
    });
  });

  describe("while Card Shellz shipping is unchecked", () => {
    type Checks = NonNullable<NonNullable<ListingSettingsRailInput["liveSetup"]>["checks"]>;
    const COULD_NOT_CHECK = { tick: "unknown", line: "Couldn't check", retry: true };
    const FINISHING_SETUP = { tick: "unknown", line: "Card Shellz is finishing setup", retry: false };
    const todo = (line: string) => ({ tick: "todo", line, retry: false });
    /** Each way shipping goes unchecked, and what the rail says about it: only a passing outage is worth a retry. */
    const SHIPPING_UNCHECKED: ReadonlyArray<{ name: string; checks: Checks; waiting: typeof COULD_NOT_CHECK }> = [
      { name: "temporarily unavailable", checks: { ebay: "checked", fulfillment: { status: "unavailable", kind: "temporary" } },
        waiting: COULD_NOT_CHECK },
      { name: "temporarily unavailable, eBay not read",
        checks: { ebay: "not_checked", fulfillment: { status: "unavailable", kind: "temporary" } }, waiting: COULD_NOT_CHECK },
      { name: "not checked", checks: { ebay: "checked", fulfillment: { status: "not_checked" } }, waiting: COULD_NOT_CHECK },
      { name: "neither checked", checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } }, waiting: COULD_NOT_CHECK },
      { name: "setup incomplete", checks: { ebay: "checked", fulfillment: { status: "unavailable", kind: "setup_incomplete" } },
        waiting: FINISHING_SETUP },
      { name: "setup incomplete, eBay not read",
        checks: { ebay: "not_checked", fulfillment: { status: "unavailable", kind: "setup_incomplete" } }, waiting: FINISHING_SETUP },
    ];
    const TEMPORARY: Checks = { ebay: "checked", fulfillment: { status: "unavailable", kind: "temporary" } };
    const SETUP_INCOMPLETE: Checks = { ebay: "checked", fulfillment: { status: "unavailable", kind: "setup_incomplete" } };

    it("says Couldn't check, with Try again, for a missing shipping policy while shipping is temporarily unavailable", () => {
      expect(rail({ liveSetup: { missingFields: ["fulfillmentPolicyId"], checks: TEMPORARY } })).toEqual(COULD_NOT_CHECK);
      expect(rail({ liveSetup: { missingFields: ["fulfillmentPolicyCompatibility"], checks: TEMPORARY } })).toEqual(COULD_NOT_CHECK);
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "shipping" }), liveSetup: { missingFields: [], checks: TEMPORARY } }))
        .toEqual(COULD_NOT_CHECK);
    });

    it("says Card Shellz is finishing setup, with no Try again, for a missing shipping policy, but asks for a missing return policy first", () => {
      expect(rail({ liveSetup: { missingFields: ["fulfillmentPolicyId"], checks: SETUP_INCOMPLETE } })).toEqual(FINISHING_SETUP);
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "shipping" }),
        liveSetup: { missingFields: ["fulfillmentPolicyCompatibility"], checks: SETUP_INCOMPLETE } })).toEqual(FINISHING_SETUP);
      expect(rail({ liveSetup: { missingFields: ["fulfillmentPolicyId", "returnPolicyId"], checks: SETUP_INCOMPLETE } }))
        .toEqual(todo("Choose a return policy"));
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "return" }),
        liveSetup: { missingFields: ["fulfillmentPolicyCompatibility"], checks: SETUP_INCOMPLETE } })).toEqual(todo("Choose a return policy"));
      // Once the return policy is chosen, the rail says what the shipping policy waits on.
      expect(rail({ liveSetup: { missingFields: ["fulfillmentPolicyCompatibility"], checks: SETUP_INCOMPLETE } })).toEqual(FINISHING_SETUP);
    });

    it("says Card Shellz is finishing setup, with no Try again, when nothing is missing", () => {
      expect(rail({ liveSetup: { missingFields: [], checks: SETUP_INCOMPLETE } })).toEqual(FINISHING_SETUP);
      expect(rail({ liveSetup: { missingFields: [], access: { canEdit: true }, checks: SETUP_INCOMPLETE } })).toEqual(FINISHING_SETUP);
    });

    it.each(SHIPPING_UNCHECKED)("never asks for a shipping policy the vendor can't choose yet, and says why instead ($name)", ({ checks, waiting }) => {
      for (const missingFields of [["fulfillmentPolicyId"], ["fulfillmentPolicyCompatibility"], ["fulfillmentPolicyId", "fulfillmentPolicyCompatibility"]]) {
        expect(rail({ liveSetup: { missingFields, checks } }), missingFields.join()).toEqual(waiting);
      }
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "shipping" }), liveSetup: { missingFields: [], checks } }))
        .toEqual(waiting);
      expect(rail({ liveSetup: { missingFields: [], checks } })).toEqual(waiting);
    });

    it.each(SHIPPING_UNCHECKED)("asks for a missing return or payment policy before saying why shipping waits ($name)", ({ checks }) => {
      expect(rail({ liveSetup: { missingFields: ["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"], checks } }))
        .toEqual(todo("Choose a return policy"));
      expect(rail({ liveSetup: { missingFields: ["fulfillmentPolicyCompatibility", "paymentPolicyId"], checks } }))
        .toEqual(todo("Choose a payment policy"));
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "shipping" }), liveSetup: { missingFields: ["paymentPolicyId"], checks } }))
        .toEqual(todo("Choose a payment policy"));
    });

    it.each(SHIPPING_UNCHECKED)("says why a missing shipping policy waits before the fallback, ship-from, setup and product lines ($name)", ({ checks, waiting }) => {
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: null }), liveSetup: { missingFields: ["fulfillmentPolicyId"], checks } }))
        .toEqual(waiting);
      expect(rail({ liveSetup: { missingFields: ["fulfillmentPolicyId", "merchantLocationKey", "somethingNew"], checks } })).toEqual(waiting);
      expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 2 }), liveSetup: { missingFields: ["fulfillmentPolicyId"], checks } }))
        .toEqual(waiting);
    });

    it.each(SHIPPING_UNCHECKED)("hides the ship-from line, which can't be fixed until shipping is checked ($name)", ({ checks, waiting }) => {
      expect(rail({ liveSetup: { missingFields: ["merchantLocationKey"], checks } })).toEqual(waiting);
      expect(rail({ liveSetup: { missingFields: ["merchantLocationKey"], checks } }).line).not.toBe("Ship-from location needs updating");
      // What comes after the ship-from line still shows.
      expect(rail({ liveSetup: { missingFields: ["merchantLocationKey", "somethingNew"], checks } })).toEqual(todo("Finish your eBay setup"));
      expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 2 }), liveSetup: { missingFields: ["merchantLocationKey"], checks } }))
        .toEqual(todo("2 products need a fix"));
      // And the fallback before it.
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: null }), liveSetup: { missingFields: ["merchantLocationKey"], checks } }))
        .toEqual(todo("Choose your eBay policies"));
    });

    it("reads an answer from a server before checks as before: it always checked shipping", () => {
      // No checks field: shipping counts as checked, so the shipping policy and ship-from lines show.
      expect(rail({ liveSetup: { missingFields: ["fulfillmentPolicyId"] } })).toEqual(todo("Choose a shipping policy"));
      expect(rail({ liveSetup: { missingFields: ["fulfillmentPolicyCompatibility", "returnPolicyId"] } })).toEqual(todo("Choose a shipping policy"));
      expect(rail({ liveSetup: { missingFields: ["merchantLocationKey"] } })).toEqual(todo("Ship-from location needs updating"));
      expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 2 }), liveSetup: { missingFields: ["merchantLocationKey"] } }))
        .toEqual(todo("Ship-from location needs updating"));
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "shipping" }), liveSetup: { missingFields: [] } }))
        .toEqual(todo("Choose a shipping policy"));
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: "shipping" }), liveSetup: null }))
        .toEqual(todo("Choose a shipping policy"));
      expect(rail({ liveSetup: { missingFields: ["fulfillmentPolicyId"], checks: undefined } })).toEqual(todo("Choose a shipping policy"));
      // The rest of the order is unchanged too: the policies fallback, ship-from, an unknown field, then products.
      expect(rail({ summary: ready({ state: "choose_policy", missingPolicy: null }), liveSetup: { missingFields: ["merchantLocationKey"] } }))
        .toEqual(todo("Choose your eBay policies"));
      expect(rail({ liveSetup: { missingFields: ["somethingNew", "merchantLocationKey"] } })).toEqual(todo("Ship-from location needs updating"));
      expect(rail({ summary: ready({ state: "products_need_fix", productsNeedingFix: 2 }), liveSetup: { missingFields: ["somethingNew"] } }))
        .toEqual(todo("Finish your eBay setup"));
      expect(rail({ liveSetup: { missingFields: [], access: { canEdit: true } } })).toEqual({ tick: "done", line: "All set", retry: false });
    });
  });
});

describe("catalog step lines and action bar", () => {
  it("lets Choose continue only once something is selected", () => {
    expect(describeCatalogActionBar({ step: "choose", selectedCount: 3, storeName: "Marz Cards" })).toEqual({
      summary: "3 selected", next: { step: "setup", label: "Next: Listing settings", disabled: false },
    });
    expect(describeCatalogActionBar({ step: "choose", selectedCount: 0, storeName: "Marz Cards" }).next?.disabled).toBe(true);
    expect(describeCatalogActionBar({ step: "choose", selectedCount: null, storeName: null })).toEqual({
      summary: "Loading your selection", next: { step: "setup", label: "Next: Listing settings", disabled: true },
    });
  });

  it("names the store on Listing settings and Publish, and leaves Publish's actions to its panel", () => {
    expect(describeCatalogActionBar({ step: "setup", selectedCount: 3, storeName: "Marz Cards" })).toEqual({
      summary: "Settings for Marz Cards", next: { step: "publish", label: "Next: Publish", disabled: false },
    });
    expect(describeCatalogActionBar({ step: "setup", selectedCount: 3, storeName: null }).summary).toBe("No eBay store ready");
    expect(describeCatalogActionBar({ step: "publish", selectedCount: 3, storeName: "Marz Cards" })).toEqual({
      summary: "3 selected · publishing to Marz Cards", next: null,
    });
    expect(describeCatalogActionBar({ step: "publish", selectedCount: 3, storeName: null })).toEqual({ summary: "3 selected", next: null });
  });
});

describe("catalog store choice", () => {
  const ebay = connection({ storeConnectionId: 5 });
  const secondEbay = connection({ storeConnectionId: 9, externalDisplayName: null, shopDomain: "second-store" });
  const shopify = connection({ storeConnectionId: 3, platform: "shopify", externalDisplayName: "Test Shop" });
  const notReady = connection({ storeConnectionId: 7, launchReady: false });

  it("lists launch-ready stores only, and never lets a store on another platform be chosen", () => {
    expect(catalogStoreOptions([shopify, notReady, ebay])).toEqual([
      { storeConnectionId: 3, name: "Test Shop", platform: "shopify", selectable: false },
      { storeConnectionId: 5, name: "Marz Cards", platform: "ebay", selectable: true },
    ]);
  });

  it("names a store by its display name, then its domain, then its platform", () => {
    expect(catalogStoreName(secondEbay)).toBe("second-store");
    expect(catalogStoreName({ externalDisplayName: null, shopDomain: null, platform: "ebay" })).toBe("Ebay store name pending");
  });

  it("uses the preferred store while it can be chosen, else the first eBay store, else none", () => {
    const options = catalogStoreOptions([shopify, ebay, secondEbay]);
    expect(chooseCatalogStore(options, null)).toBe(5);
    expect(chooseCatalogStore(options, 9)).toBe(9);
    // A remembered store that is gone, not ready or not eBay falls back to the first eBay store.
    expect(chooseCatalogStore(options, 3)).toBe(5);
    expect(chooseCatalogStore(options, 42)).toBe(5);
    expect(chooseCatalogStore(catalogStoreOptions([shopify]), 3)).toBeNull();
    expect(chooseCatalogStore([], null)).toBeNull();
  });
});

describe("remembered catalog store", () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    };
  }

  it("remembers the choice per member", () => {
    const storage = memoryStorage();
    rememberCatalogStore(storage, "m-1", 9);
    expect(storage.setItem).toHaveBeenCalledWith(catalogStoreStorageKey("m-1"), "9");
    expect(readRememberedCatalogStore(storage, "m-1")).toBe(9);
    expect(readRememberedCatalogStore(storage, "m-2")).toBeNull();
  });

  it("ignores anything that is not a store id, and a missing member or storage", () => {
    for (const stored of ["0", "-4", "9.5", "abc", "", "12345678901", " 9"]) {
      expect(readRememberedCatalogStore(memoryStorage({ [catalogStoreStorageKey("m-1")]: stored }), "m-1")).toBeNull();
    }
    expect(readRememberedCatalogStore(null, "m-1")).toBeNull();
    expect(readRememberedCatalogStore(memoryStorage(), null)).toBeNull();
    const storage = memoryStorage();
    rememberCatalogStore(storage, null, 9);
    rememberCatalogStore(storage, "m-1", 0);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("keeps working when the browser refuses storage", () => {
    const refusing = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
    };
    expect(readRememberedCatalogStore(refusing, "m-1")).toBeNull();
    expect(() => rememberCatalogStore(refusing, "m-1", 9)).not.toThrow();
  });
});
