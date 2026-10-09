import { describe, expect, it, vi } from "vitest";
import type { DropshipStoreConnectionSummary } from "../dropship-ops-surface";
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
