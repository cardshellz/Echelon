import { describe, expect, it } from "vitest";
import {
  LISTING_SETTINGS_FIELDS,
  LISTING_SETTINGS_FIX_CODES,
  LISTING_SETTINGS_SETTING_KEYS,
  LISTING_SETTINGS_VALUE_SOURCES,
} from "@shared/dropship/listing-settings";
import { evaluateDropshipEbayFulfillmentPolicyCompatibility } from "../../../../server/modules/dropship/domain/ebay-fulfillment-policy-compatibility";
import {
  CONNECTION_BANNER_KINDS,
  LISTING_SETTINGS_RIGHT_REASONS,
  chooseConnectionBanner,
  listingSettingsEditRights,
  type ListingSettingsRightsInput,
} from "../dropship-listing-settings-access";
import { DropshipApiError, type DropshipEbayFulfillmentCapability, type DropshipEbayListingSetupResponse } from "../dropship-ops-surface";
import {
  CHECKING_EBAY,
  GROUP_RULE_ORDER_NOTE,
  NOT_SET_NEEDED_TO_LIST,
  SIZES_DIFFER_WORDS,
  WORKS_WITH_CARD_SHELLZ_SHIPPING,
  connectionBannerWords,
  drawerDescriptionTemplateValue,
  drawerEbayCategoryValue,
  drawerMainTextValue,
  drawerPolicyValue,
  drawerSourceWords,
  drawerStoreShelfValue,
  fixReasonWords,
  fulfillmentIssueReason,
  fulfillmentIssueReasons,
  ownSettingsSentence,
  ownSettingsWords,
  productStatusWords,
  rightReasonLine,
  shippingPolicyFit,
  shippingPolicyNeeds,
  storeDefaultDescriptionValue,
  storeDefaultEbayCategoryValue,
  storeDefaultPolicyValue,
  storeShelfValue,
  usedByWords,
} from "../dropship-listing-settings-words";

/** A raw code or enum value leaking into vendor words: snake_case or a DROPSHIP_ code. */
const RAW_CODE = /\b[a-z]+_[a-z_]+\b|DROPSHIP_/;

function expectPlain(text: string | null): void {
  if (text === null) return;
  expect(text).not.toMatch(RAW_CODE);
  expect(text.trim()).toBe(text);
  expect(text.length).toBeGreaterThan(0);
}

const capability: DropshipEbayFulfillmentCapability = {
  marketplaceId: "EBAY_US",
  requiredHandlingTimeBusinessDays: 2,
  destinationCountry: "US",
  destinationRegions: ["US-48"],
  destinationCoverageComplete: true,
  supportedServices: [
    { carrier: "usps", ebayServiceCode: "USPSGroundAdvantage", serviceName: "USPS Ground Advantage", shipStationCarrierCode: "stamps_com", shipStationServiceCode: "usps_ground_advantage" },
    { carrier: "usps", ebayServiceCode: "USPSPriority", serviceName: "USPS Priority Mail", shipStationCarrierCode: "stamps_com", shipStationServiceCode: "usps_priority_mail" },
    { carrier: "usps", ebayServiceCode: "USPSPriorityFlatRate", serviceName: "USPS Priority Mail", shipStationCarrierCode: "stamps_com", shipStationServiceCode: "usps_priority_mail_flat" },
  ],
  evidenceHash: "hash",
  source: { omsChannelId: 1, originWarehouseId: 2, rateBookId: 3, rateBookCode: "STD", rateTableId: 4, serviceLevelId: 5, fulfillmentRoutingRevision: 6 },
};

describe("connection banner words (plan 4.4)", () => {
  it("gives every kind words and one button, naming the store and never a raw code", () => {
    for (const kind of CONNECTION_BANNER_KINDS) {
      const words = connectionBannerWords({ kind, diagnosticReference: null }, "MyShop");
      expectPlain(words.message);
      expect(words.action).toBeDefined();
    }
  });

  it("uses the record's words (R:500-507, R:521) and the plan's interim ones", () => {
    const say = (kind: (typeof CONNECTION_BANNER_KINDS)[number], reference: string | null = null) =>
      connectionBannerWords({ kind, diagnosticReference: reference }, "MyShop");
    expect(say("account_inactive").message).toBe("Your dropship account isn't active, so listing settings can't be changed. Contact support.");
    expect(say("store_paused").message).toBe("MyShop is paused, so its settings can't be changed now.");
    expect(say("store_disconnecting").message).toBe("MyShop is being disconnected, so its settings can't be changed now.");
    expect(say("store_disconnected").message).toBe("MyShop is disconnected, so its settings can't be changed now.");
    expect(say("too_large").message).toBe("You've chosen more than 10,000 sizes. Settings can't be checked until you choose 10,000 or fewer.");
    expect(say("other_site").message).toBe("Card Shellz lists on eBay US only. MyShop is set up for another eBay site. Contact support.");
    expect(say("selling_paused").message).toBe("Selling is paused on your account. Prices, eBay categories and descriptions can't be changed until it resumes.");
    expect(say("ops_inactive").message).toBe("Your Shellz Club .ops access is inactive, so prices, eBay categories and descriptions can't be changed. Contact support.");
    expect(say("sign_in").message).toBe("eBay needs you to sign in again for MyShop. Your settings are safe. Until you do, you can still change prices and descriptions.");
    expect(say("access_denied", "8d1c7f0e-2b8b").message).toBe("eBay won't let Card Shellz read MyShop. Signing in again won't fix this. Contact support and give this code: 8d1c7f0e-2b8b.");
    expect(say("access_denied").message).toBe("eBay won't let Card Shellz read MyShop. Signing in again won't fix this. Contact support.");
    expect(say("unreachable").message).toBe("Can't reach eBay right now. Your saved settings still apply.");
  });

  it("points each banner at the one step that lifts it", () => {
    const action = (kind: (typeof CONNECTION_BANNER_KINDS)[number]) => connectionBannerWords({ kind, diagnosticReference: null }, "MyShop").action;
    const support = { kind: "link", link: { label: "Email Card Shellz support", href: "mailto:support@cardshellz.com", external: true } };
    const storeConnection = { kind: "link", link: { label: "Go to store connection", href: "/onboarding", external: false } };
    expect(action("account_inactive")).toEqual(support);
    // Only Card Shellz pauses a store connection, so only support lifts it (L3).
    expect(action("store_paused")).toEqual(support);
    expect(action("store_disconnecting")).toEqual(storeConnection);
    expect(action("store_disconnected")).toEqual(storeConnection);
    expect(action("too_large")).toEqual({ kind: "go_to_step_1", label: "Go to step 1" });
    expect(action("other_site")).toEqual(support);
    expect(action("selling_paused")).toEqual({ kind: "link", link: { label: "Go to Wallet", href: "/wallet", external: false } });
    expect(action("ops_inactive")).toEqual(support);
    expect(action("sign_in")).toEqual({ kind: "link", link: { label: "Reconnect eBay", href: "/onboarding", external: false } });
    expect(action("access_denied")).toEqual(support);
    expect(action("unreachable")).toEqual({ kind: "retry", label: "Try again" });
  });

  it("never says the policies or the shelf can be changed when eBay has locked them under a paused account", () => {
    const paused = (overrides: Partial<ListingSettingsRightsInput>): ListingSettingsRightsInput => ({
      account: { status: "paused", entitlementStatus: "active" },
      summary: { storeStatus: "connected", catalog: { state: "ok", products: 3, sizes: 9 } },
      setup: { data: { access: { canEdit: true, reason: null }, revision: 4, checks: { ebay: "checked", fulfillment: { status: "checked" } }, missingFields: [] }, error: null },
      shelves: { data: { categories: [] }, error: null },
      blocked: null,
      ...overrides,
    });
    const refused = (status: number, code: string) => new DropshipApiError({ message: `refused: ${code}`, status, code });
    const cells = {
      alone: paused({}),
      signIn: paused({ summary: { storeStatus: "needs_reauth", catalog: { state: "ok", products: 3, sizes: 9 } } }),
      accessDenied: paused({ setup: { error: refused(403, "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED") } }),
      unreachable: paused({ setup: { error: refused(502, "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE") } }),
    };
    const message = "Selling is paused on your account. Prices, eBay categories and descriptions can't be changed until it resumes.";
    for (const [name, cell] of Object.entries(cells)) {
      const shown = chooseConnectionBanner(cell);
      expect(shown?.kind, name).toBe("selling_paused");
      expect(connectionBannerWords(shown!, "MyShop").message, name).toBe(message);
    }
    // The banner leaves the policies to their rows, which say why on their own line when eBay locks them.
    expect(listingSettingsEditRights(cells.alone).policies).toEqual({ editable: true, reason: null });
    expect(listingSettingsEditRights(cells.signIn).policies).toEqual({ editable: false, reason: "sign_in" });
    expect(listingSettingsEditRights(cells.accessDenied).policies).toEqual({ editable: false, reason: "ebay_access_denied" });
    expect(listingSettingsEditRights(cells.unreachable).shelfPick).toEqual({ editable: false, reason: "unreachable" });
  });

  it("reads well without a store name", () => {
    expect(connectionBannerWords({ kind: "store_paused", diagnosticReference: null }, "  ").message)
      .toBe("Your eBay store is paused, so its settings can't be changed now.");
    expect(connectionBannerWords({ kind: "sign_in", diagnosticReference: null }, "").message)
      .toBe("eBay needs you to sign in again for your eBay store. Your settings are safe. Until you do, you can still change prices and descriptions.");
  });
});

describe("why a row can't be changed (plan 4.3)", () => {
  it("has a line for every reason, or none when the banner explains or nothing is needed", () => {
    for (const reason of LISTING_SETTINGS_RIGHT_REASONS) expectPlain(rightReasonLine(reason));
    expect(rightReasonLine("banner")).toBeNull();
    expect(rightReasonLine("not_needed")).toBeNull();
    expect(rightReasonLine("sign_in")).toBe("Reconnect eBay to change this.");
    expect(rightReasonLine("unreachable")).toBe("Can't check eBay right now.");
    expect(rightReasonLine("checking_ebay")).toBe("Checking eBay…");
    expect(rightReasonLine("shipping_setup")).toBe("Card Shellz is finishing shipping setup for your store. You can pick a shipping policy when it's done.");
    expect(rightReasonLine("save_policy_first")).toBe("Save or cancel your policy change first.");
    expect(rightReasonLine("reload")).toBe("This page is out of date. Reload it, then save again.");
  });
});

type PolicySetup = Pick<DropshipEbayListingSetupResponse, "selection" | "storedNames" | "options" | "checks">;
const policySetup = (overrides: Partial<PolicySetup> = {}): PolicySetup => ({
  selection: { merchantLocationKey: null, fulfillmentPolicyId: "F1", returnPolicyId: null, paymentPolicyId: "P1" },
  storedNames: { fulfillmentPolicyName: "Free Standard (saved)", returnPolicyName: null, paymentPolicyName: "eBay payments" },
  options: {
    merchantLocations: [],
    fulfillmentPolicies: [{ id: "F1", name: "Free Standard US", compatible: true, compatibilityChecked: true, compatibilityIssues: [] }],
    returnPolicies: [{ id: "R1", name: "30 days" }],
    paymentPolicies: [],
  },
  checks: { ebay: "checked", fulfillment: { status: "checked" } },
  ...overrides,
});

describe("store default values (R:577-583)", () => {
  it("names a policy only from the live setup read (A4)", () => {
    // Loading: a saved policy waits for eBay; none saved says so at once.
    expect(storeDefaultPolicyValue({ kind: "shipping", savedPolicyId: "F1", setup: {} })).toBe(CHECKING_EBAY);
    expect(storeDefaultPolicyValue({ kind: "return", savedPolicyId: null, setup: {} })).toBe(NOT_SET_NEEDED_TO_LIST);
    // Answered: eBay's live name.
    expect(storeDefaultPolicyValue({ kind: "shipping", savedPolicyId: "F1", setup: { data: policySetup() } })).toBe("Free Standard US");
    expect(storeDefaultPolicyValue({ kind: "return", savedPolicyId: "R9", setup: { data: policySetup() } })).toBe(NOT_SET_NEEDED_TO_LIST);
    // Gone from eBay's list: the name stored at the last save.
    expect(storeDefaultPolicyValue({ kind: "payment", savedPolicyId: "P1", setup: { data: policySetup() } })).toBe("eBay payments");
    // A read-only view without eBay's lists: the stored name, else "Set".
    const readOnly = policySetup({ checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } } });
    expect(storeDefaultPolicyValue({ kind: "shipping", savedPolicyId: "F1", setup: { data: readOnly } })).toBe("Free Standard (saved)");
    expect(storeDefaultPolicyValue({ kind: "shipping", savedPolicyId: "F1", setup: { data: policySetup({ checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } }, storedNames: undefined }) } })).toBe("Set");
    // eBay can't be read: "Set", never the id.
    expect(storeDefaultPolicyValue({ kind: "shipping", savedPolicyId: "F1", setup: { error: new Error("down") } })).toBe("Set");
    expect(storeDefaultPolicyValue({ kind: "shipping", savedPolicyId: null, setup: { error: new Error("down") } })).toBe(NOT_SET_NEEDED_TO_LIST);
  });

  it("shows the eBay category by name or path, never by number", () => {
    expect(storeDefaultEbayCategoryValue(null)).toBe("Card Shellz picks one for each product (recommended)");
    expect(storeDefaultEbayCategoryValue({ categoryName: "Card Sleeves" })).toBe("Card Sleeves");
    expect(storeDefaultEbayCategoryValue({ categoryName: "Card Sleeves", path: ["Collectibles", "Trading Cards", "Card Sleeves"] }))
      .toBe("Collectibles › Trading Cards › Card Sleeves");
    expect(storeDefaultEbayCategoryValue({ categoryName: " ", path: [] })).toBe("An eBay category");
  });

  it("shows the store shelf and marks one gone from the eBay store", () => {
    const live = [{ categoryId: "11", categoryName: "Toploaders" }, { categoryId: "12", categoryName: "Penny Sleeves" }];
    expect(storeShelfValue(undefined, live)).toBeNull();
    expect(storeShelfValue(null, live)).toBe("None");
    expect(storeShelfValue({ ids: [], names: [] }, live)).toBe("None");
    expect(storeShelfValue({ ids: ["11"], names: ["Toploaders"] }, live)).toBe("Toploaders");
    expect(storeShelfValue({ ids: ["11", "12"], names: ["Toploaders", "Penny Sleeves"] }, live)).toBe("Toploaders · second: Penny Sleeves");
    expect(storeShelfValue({ ids: ["11", "99"], names: ["Toploaders", "Old Shelf"] }, live)).toBe("Toploaders · second: Old Shelf (no longer in your eBay store)");
    // Before the shelves read answers, nothing is marked gone.
    expect(storeShelfValue({ ids: ["99"], names: ["Old Shelf"] }, null)).toBe("Old Shelf");
    // A missing stored name falls back to eBay's, never to the id.
    expect(storeShelfValue({ ids: ["12"], names: [""] }, live)).toBe("Penny Sleeves");
    expect(storeShelfValue({ ids: ["77"], names: [] }, null)).toBe("A shelf");
  });

  it("describes the description default (R:582, R:442)", () => {
    expect(storeDefaultDescriptionValue({ hasIntroduction: false, hasFooter: false })).toBe("Card Shellz text");
    expect(storeDefaultDescriptionValue({ hasIntroduction: true, hasFooter: false })).toBe("Card Shellz text, with your text above");
    expect(storeDefaultDescriptionValue({ hasIntroduction: false, hasFooter: true })).toBe("Card Shellz text, with your text below");
    expect(storeDefaultDescriptionValue({ hasIntroduction: true, hasFooter: true })).toBe("Card Shellz text, with your text above and below");
    expect(storeDefaultDescriptionValue({ hasIntroduction: true, hasFooter: false }, "phone")).toBe("Card Shellz text + above");
    expect(storeDefaultDescriptionValue({ hasIntroduction: false, hasFooter: false }, "phone")).toBe("Card Shellz text");
  });
});

describe("shipping policy checks (R:573, R:575; C10)", () => {
  /** A policy that trips every check the server makes, so every code it can send is covered. */
  const everyIssue = evaluateDropshipEbayFulfillmentPolicyCompatibility({
    capability: { ...capability, destinationCoverageComplete: false },
    policy: {
      id: "F9", name: "Everything wrong", marketplaceId: "EBAY_GB",
      handlingTime: { value: 1, unit: "DAY" },
      shippingOptions: [
        { optionType: "INTERNATIONAL", shippingServiceCodes: ["IntlMail"] },
        { optionType: "PICKUP", shippingServiceCodes: [] },
        { optionType: "DOMESTIC", shippingServiceCodes: ["UPSNextDayAir"] },
      ],
      localPickup: true, freightShipping: true, pickupDropOff: true,
    },
  }).issues;
  const otherIssues = [
    ...evaluateDropshipEbayFulfillmentPolicyCompatibility({
      capability,
      policy: { id: "F8", name: "x", marketplaceId: null, handlingTime: null, shippingOptions: [], localPickup: false, freightShipping: false, pickupDropOff: false },
    }).issues,
    ...evaluateDropshipEbayFulfillmentPolicyCompatibility({
      capability,
      policy: { id: "F7", name: "y", marketplaceId: "EBAY_US", handlingTime: { value: 2, unit: "HOUR" }, shippingOptions: [], localPickup: false, freightShipping: false, pickupDropOff: false },
    }).issues,
  ];
  const allIssues = [...everyIssue, ...otherIssues];

  it("covers all 13 kinds the server sends, with plain words for each", () => {
    const kinds = new Set(allIssues.map((issue) => issue.code.split(":")[0]));
    expect([...kinds].sort()).toEqual([
      "destination_coverage_incomplete", "domestic_shipping_service_required", "freight_shipping_unsupported",
      "handling_time_missing", "handling_time_too_short", "handling_time_unit_unsupported",
      "international_direct_shipping_unsupported", "local_pickup_unsupported", "marketplace_mismatch", "marketplace_missing",
      "pickup_drop_off_unsupported", "shipping_option_type_unsupported", "shipping_service_unsupported",
    ]);
    for (const issue of allIssues) {
      const reason = fulfillmentIssueReason(issue, capability);
      expectPlain(reason);
      // A code this page knows never falls back to the unknown words.
      expect({ code: issue.code, reason }).not.toEqual({ code: issue.code, reason: "Card Shellz can't use this policy" });
    }
  });

  it("uses the record's reasons (R:575)", () => {
    const reason = (code: string) => fulfillmentIssueReason({ code }, capability);
    expect(reason("handling_time_too_short")).toBe("handling time must be 2 business days or more");
    expect(fulfillmentIssueReason({ code: "handling_time_too_short" }, { requiredHandlingTimeBusinessDays: 1 })).toBe("handling time must be 1 business day or more");
    expect(fulfillmentIssueReason({ code: "handling_time_too_short" }, null)).toBe("handling time is too short for Card Shellz");
    expect(reason("international_direct_shipping_unsupported")).toBe("Card Shellz ships to US addresses only");
    expect(reason("local_pickup_unsupported")).toBe("Card Shellz doesn't offer pickup");
    expect(reason("pickup_drop_off_unsupported")).toBe("Card Shellz doesn't offer pickup");
    expect(reason("freight_shipping_unsupported")).toBe("Card Shellz doesn't offer freight");
    expect(reason("domestic_shipping_service_required")).toBe("this policy has no US shipping service");
    expect(reason("marketplace_mismatch")).toBe("this policy is for another eBay site");
    expect(reason("shipping_service_unsupported:UPSNextDayAir")).toBe("Card Shellz doesn't ship with one of this policy's services");
    expect(reason("something_new")).toBe("Card Shellz can't use this policy");
  });

  it("lists each reason once, in the server's order, without Card Shellz's own coverage gap", () => {
    const reasons = fulfillmentIssueReasons(everyIssue, capability);
    expect(reasons).not.toContain("Card Shellz can't check this policy yet");
    expect(reasons.filter((text) => text === "Card Shellz doesn't offer pickup")).toHaveLength(1);
    expect(reasons[0]).toBe("this policy is for another eBay site");
  });

  it("says whether an option works, can't be used, or can't be checked", () => {
    expect(shippingPolicyFit({ compatible: true, compatibilityChecked: true, compatibilityIssues: [] }, capability))
      .toEqual({ fit: "works", line: WORKS_WITH_CARD_SHELLZ_SHIPPING });
    expect(WORKS_WITH_CARD_SHELLZ_SHIPPING).toBe("✓ Works with Card Shellz shipping");
    expect(shippingPolicyFit({ compatible: false, compatibilityChecked: true, compatibilityIssues: [{ code: "handling_time_too_short", message: "staff words" }] }, capability))
      .toEqual({ fit: "cant_use", reason: "handling time must be 2 business days or more", line: "✗ Can't use: handling time must be 2 business days or more" });
    // Card Shellz's coverage gap alone is not the vendor's problem.
    expect(shippingPolicyFit({ compatible: false, compatibilityChecked: true, compatibilityIssues: [{ code: "destination_coverage_incomplete", message: "m" }] }, capability))
      .toEqual({ fit: "unchecked", line: "Card Shellz can't check this policy yet" });
    // With a real problem too, the real problem is named.
    expect(shippingPolicyFit({ compatible: false, compatibilityChecked: true, compatibilityIssues: [{ code: "destination_coverage_incomplete", message: "m" }, { code: "freight_shipping_unsupported", message: "m" }] }, capability).fit)
      .toBe("cant_use");
    expect(shippingPolicyFit({ compatible: false, compatibilityChecked: false, compatibilityIssues: [] }, null))
      .toEqual({ fit: "unchecked", line: "Card Shellz can't check this policy right now" });
    expect(shippingPolicyFit({ compatible: false, compatibilityIssues: [] }, capability))
      .toEqual({ fit: "cant_use", reason: "Card Shellz can't use this policy", line: "✗ Can't use: Card Shellz can't use this policy" });
  });

  it("says what a shipping policy needs, with eBay's service names (R:573)", () => {
    const needs = shippingPolicyNeeds(capability);
    expect(needs?.title).toBe("What your shipping policy needs");
    expect(needs?.text).toBe("Card Shellz ships your orders, so your eBay shipping policy must: have a handling time of 2 business days or more; "
      + "ship to US addresses only (US territories and military addresses count); not offer local pickup or freight; "
      + "use only these services: USPS Ground Advantage, USPS Priority Mail. You decide what buyers pay for shipping.");
    expect(needs?.needs).toHaveLength(4);
    expect(shippingPolicyNeeds(null)).toBeNull();
    expect(shippingPolicyNeeds({ ...capability, requiredHandlingTimeBusinessDays: 0 })).toBeNull();
    expect(shippingPolicyNeeds({ ...capability, supportedServices: [] })?.needs[3]).toBe("use only services Card Shellz ships with");
  });
});

describe("the product drawer (C16, C17)", () => {
  it("tags every source for every setting in plain words", () => {
    for (const key of LISTING_SETTINGS_SETTING_KEYS) {
      for (const source of LISTING_SETTINGS_VALUE_SOURCES) {
        const words = drawerSourceWords(key, { source, ruleName: source === "group_rule" ? "Envelopes" : null });
        expectPlain(words.tag);
        expectPlain(words.note);
      }
    }
    expect(drawerSourceWords("shippingPolicy", { source: "store_default", ruleName: null })).toEqual({ tag: "Store default", note: null });
    expect(drawerSourceWords("descriptionTemplate", { source: "group_rule", ruleName: "Envelopes" }))
      .toEqual({ tag: "From your older group rule “Envelopes”", note: GROUP_RULE_ORDER_NOTE });
    expect(GROUP_RULE_ORDER_NOTE).toBe("Older group rules come after a product's own settings and before your store defaults.");
    expect(drawerSourceWords("storeShelf", { source: "size", ruleName: null }).tag).toBe("Set on each size");
    expect(drawerSourceWords("ebayCategory", { source: "catalog", ruleName: null }).tag).toBe("Card Shellz picks");
    expect(drawerSourceWords("mainText", { source: "catalog", ruleName: null }).tag).toBeNull();
    expect(drawerSourceWords("paymentPolicy", { source: "none", ruleName: null }).tag).toBeNull();
  });

  it("says each value by name, and what none means for each setting", () => {
    expect(drawerPolicyValue("shippingPolicy", { policyId: null }, { data: policySetup() })).toBe("Not set");
    expect(drawerPolicyValue("shippingPolicy", { policyId: "F1" }, { data: policySetup() })).toBe("Free Standard US");
    expect(drawerPolicyValue("returnPolicy", { policyId: "R1" }, { data: policySetup() })).toBe("30 days");
    // A size's own policy eBay no longer has.
    expect(drawerPolicyValue("returnPolicy", { policyId: "R7" }, { data: policySetup() })).toBe("A policy that's no longer on eBay");
    // The store default eBay no longer has keeps its stored name.
    expect(drawerPolicyValue("paymentPolicy", { policyId: "P1" }, { data: policySetup() })).toBe("eBay payments (no longer on eBay)");
    expect(drawerPolicyValue("shippingPolicy", { policyId: "F1" }, {})).toBe(CHECKING_EBAY);
    expect(drawerPolicyValue("shippingPolicy", { policyId: "F1" }, { error: new Error("down") })).toBe("Set");
    expect(drawerEbayCategoryValue({ categoryId: null, categoryName: null })).toBe("No eBay category");
    expect(drawerEbayCategoryValue({ categoryId: "261328", categoryName: "Card Sleeves" })).toBe("Card Sleeves");
    expect(drawerEbayCategoryValue({ categoryId: "261328", categoryName: null })).toBe("An eBay category");
    expect(drawerStoreShelfValue({ names: [] })).toBe("None");
    expect(drawerStoreShelfValue({ names: ["Toploaders", "Penny Sleeves"] })).toBe("Toploaders · second: Penny Sleeves");
    expect(drawerDescriptionTemplateValue({ hasIntroduction: false, hasFooter: false, groupConflict: true })).toBe("Two older rules tie, so no text is added");
    expect(drawerDescriptionTemplateValue({ hasIntroduction: true, hasFooter: false, groupConflict: false })).toBe("Card Shellz text, with your text above");
    expect(drawerMainTextValue({ own: false })).toBe("Main text: Card Shellz text");
    expect(drawerMainTextValue({ own: true })).toBe("Main text: your own (set in step 3)");
  });

  it("never prints a policy id or a category number", () => {
    const values = [
      drawerPolicyValue("returnPolicy", { policyId: "R7-6110958000" }, { data: policySetup() }),
      drawerPolicyValue("returnPolicy", { policyId: "R7-6110958000" }, { error: new Error("down") }),
      drawerEbayCategoryValue({ categoryId: "261328", categoryName: null }),
      storeShelfValue({ ids: ["77"], names: [] }, []),
    ];
    for (const value of values) expect(value).not.toMatch(/6110958000|261328|\b77\b/);
  });

  it("says when sizes differ and which sizes use a value (C16)", () => {
    expect(SIZES_DIFFER_WORDS).toBe("Sizes have different values. Each size keeps its own for now.");
    expect(usedByWords(["Pack of 100"])).toBe("used by Pack of 100");
    expect(usedByWords(["Pack of 100", "Box of 5"])).toBe("used by Pack of 100 and Box of 5");
    expect(usedByWords(["A", "B", "C"])).toBe("used by A, B and C");
    expect(usedByWords(["A", "B", "C", "D", "E"])).toBe("used by A, B, C and 2 more");
    expect(usedByWords([])).toBe("used by no chosen size");
  });
});

describe("Products list words (C15)", () => {
  it("gives every fix a reason", () => {
    for (const code of LISTING_SETTINGS_FIX_CODES) expectPlain(fixReasonWords(code));
    expect(fixReasonWords("no_ebay_category")).toBe("no eBay category");
    expect(fixReasonWords("size_cannot_be_priced")).toBe("a size can't be priced");
    expect(fixReasonWords("own_text_needs_check")).toBe("check your own text");
    expect(fixReasonWords("description_group_conflict")).toBe("two older description rules tie");
  });

  it("puts a fix before sizes that differ, and never says All set", () => {
    expect(productStatusWords({ fixes: [], sizesDiffer: [] })).toEqual({ tone: "ok", text: "No fixes needed" });
    expect(productStatusWords({ fixes: [], sizesDiffer: ["store_shelf"] })).toEqual({ tone: "differ", text: "Sizes differ" });
    expect(productStatusWords({ fixes: ["no_ebay_category"], sizesDiffer: ["store_shelf"] })).toEqual({ tone: "fix", text: "Needs a fix: no eBay category" });
    expect(productStatusWords({ fixes: ["no_ebay_category", "size_cannot_be_priced"], sizesDiffer: [] }).text)
      .toBe("Needs a fix: no eBay category, a size can't be priced");
  });

  it("lists own settings with exact prices first, in the contract's order", () => {
    expect(ownSettingsWords({ ownSettings: [], exactPriceCount: 0 })).toBe("—");
    expect(ownSettingsWords({ ownSettings: [], exactPriceCount: 1 })).toBe("1 exact price");
    expect(ownSettingsWords({ ownSettings: ["store_shelf", "shipping_policy"], exactPriceCount: 3 })).toBe("3 exact prices, shipping policy, store shelf");
    expect(ownSettingsWords({ ownSettings: ["store_shelf", "shipping_policy"], exactPriceCount: 0 })).toBe("Shipping policy, store shelf");
    expect(ownSettingsWords({ ownSettings: ["ebay_category"], exactPriceCount: 0 })).toBe("eBay category");
    for (const field of LISTING_SETTINGS_FIELDS) expectPlain(ownSettingsWords({ ownSettings: [field], exactPriceCount: 0 }));
    expect(ownSettingsSentence({ ownSettings: [], exactPriceCount: 0 }, false)).toBe("Everything uses your store defaults.");
    expect(ownSettingsSentence({ ownSettings: ["store_shelf"], exactPriceCount: 1 }, false))
      .toBe("Own settings: 1 exact price, store shelf. Everything else uses your store defaults.");
  });

  it("names older group rules beside the store defaults when one gives the product a value", () => {
    expect(ownSettingsSentence({ ownSettings: [], exactPriceCount: 0 }, true)).toBe("Everything uses your store defaults or older group rules.");
    expect(ownSettingsSentence({ ownSettings: ["store_shelf"], exactPriceCount: 1 }, true))
      .toBe("Own settings: 1 exact price, store shelf. Everything else uses your store defaults or older group rules.");
    expectPlain(ownSettingsSentence({ ownSettings: [...LISTING_SETTINGS_FIELDS], exactPriceCount: 2 }, true));
  });
});
