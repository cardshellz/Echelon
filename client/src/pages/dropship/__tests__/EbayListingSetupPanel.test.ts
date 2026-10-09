import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { DropshipEbayListingSetupResponse } from "@/lib/dropship-ops-surface";
import { DropshipApiError } from "@/lib/dropship-ops-surface";
import { ebayListingSetupQueryKey } from "@/lib/dropship-ebay-listing-query-sync";
import { buildEbayListingSetupSaveRequest } from "@/lib/dropship-ebay-listing-setup";
import { listingPushNextStep } from "@/lib/dropship-listing-push-status";
import {
  buildEbayListingSetupDraft,
  EbayListingSetupPanel,
  hasMissingVendorOptions,
  ListingSetupError,
  listingSetupHasUnsavedPolicy,
  listingSetupStatusLabel,
  rebaseEbayListingSetupDraft,
  suggestedListingSetupFields,
} from "../EbayListingSetupPanel";

vi.mock("../EbayStoreCategoryAuthorizationRecovery", () => ({
  EbayStoreCategoryAuthorizationRecovery: () => React.createElement("button", null, "Start customer consent"),
}));

describe("EbayListingSetupPanel", () => {
  it.each([
    { code: "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", title: "eBay listing access needs support.", consent: false },
    { code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", title: "eBay listing authorization needs attention.", consent: true },
    { code: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", title: "eBay listing setup is unavailable.", consent: false },
  ])("shows the correct recovery action for $code", ({ code, title, consent }) => {
    vi.stubGlobal("React", React);
    try {
      const markup = renderToStaticMarkup(React.createElement(ListingSetupError, {
        error: new DropshipApiError({ status: 403, code, message: "Temporary access failure" }),
        storeConnectionId: 44, storeName: "Test store",
      }));
      expect(markup).toContain(title);
      expect(markup.includes("Start customer consent")).toBe(consent);
      expect(markup).not.toContain("Echelon");
      if (code.endsWith("ACCESS_DENIED")) expect(markup).toContain("Do not keep reauthorizing");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { code: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", title: "Temporary setup outage", consent: false },
    { code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", title: "eBay listing authorization needs attention.", consent: true },
    { code: "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", title: "eBay listing access needs support.", consent: false },
  ])("keeps cached setup and the correct recovery action for $code", async ({ code, title, consent }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("React", React);
    try {
      client.setQueryData(ebayListingSetupQueryKey(44), setup({ complete: true }));
      await expect(client.fetchQuery({
        queryKey: ebayListingSetupQueryKey(44),
        queryFn: async () => { throw new DropshipApiError({ status: 403, code, message: "Temporary setup outage" }); },
      })).rejects.toThrow("Temporary setup outage");
      const markup = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
        React.createElement(EbayListingSetupPanel, {
          storeConnectionId: 44, storeName: "Test store", onConfigurationChange: () => undefined,
        }),
      ));
      expect(markup).toContain(title);
      expect(markup.includes("Start customer consent")).toBe(consent);
      expect(markup).toContain("Showing the last loaded setup");
      expect(markup).toContain("Refresh options");
      expect(markup).toContain("Card Shellz fulfillment capabilities");
    } finally {
      client.clear();
      vi.unstubAllGlobals();
    }
  });

  it("prefills only unambiguous missing selections", () => {
    const draft = buildEbayListingSetupDraft(setup({
      selection: {
        merchantLocationKey: null,
        fulfillmentPolicyId: null,
        returnPolicyId: null,
        paymentPolicyId: null,
      },
      options: {
        merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
        fulfillmentPolicies: [
          policyOption("fulfillment-standard", "Standard"),
          policyOption("fulfillment-fast", "Fast"),
        ],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    }));

    expect(draft).toEqual({
      fulfillmentPolicyId: "",
      returnPolicyId: "return-30",
      paymentPolicyId: "payment-managed",
    });
  });

  it("marks a policy Card Shellz filled in as a suggestion until the vendor saves or changes it", () => {
    const response = setup({
      selection: { merchantLocationKey: null, fulfillmentPolicyId: null, returnPolicyId: "return-30", paymentPolicyId: null },
      options: {
        merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
        fulfillmentPolicies: [policyOption("fulfillment-standard", "Standard"), policyOption("fulfillment-fast", "Fast")],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    });
    const draft = buildEbayListingSetupDraft(response);
    // Payment was filled in (one choice, none saved); return is the saved choice; fulfillment is open.
    expect([...suggestedListingSetupFields(response, draft)]).toEqual(["paymentPolicyId"]);
    // Once the vendor picks something else, it is their change, not a suggestion.
    expect([...suggestedListingSetupFields(response, { ...draft, paymentPolicyId: "" })]).toEqual([]);
  });

  it("counts a policy as unsaved only when the draft holds one that is not saved", () => {
    const twoOfEach = {
      merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
      fulfillmentPolicies: [policyOption("fulfillment-standard", "Standard"), policyOption("fulfillment-fast", "Fast")],
      returnPolicies: [{ id: "return-30", name: "Thirty days" }, { id: "return-60", name: "Sixty days" }],
      paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }, { id: "payment-other", name: "Other" }],
    };
    const nothingSaved = setup({
      selection: { merchantLocationKey: null, fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null },
      options: twoOfEach,
    });
    // Nothing saved and several choices: the fields open empty, which is nothing to lose.
    expect(listingSetupHasUnsavedPolicy(nothingSaved, buildEbayListingSetupDraft(nothingSaved))).toBe(false);
    // Nothing saved and no choices at all: the same.
    const noChoices = setup({
      selection: nothingSaved.selection,
      options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] },
    });
    expect(listingSetupHasUnsavedPolicy(noChoices, buildEbayListingSetupDraft(noChoices))).toBe(false);
    // A saved policy eBay no longer offers opens empty; the vendor has changed nothing.
    const withdrawn = setup({
      selection: { merchantLocationKey: null, fulfillmentPolicyId: "fulfillment-gone", returnPolicyId: "return-30", paymentPolicyId: "payment-managed" },
      options: twoOfEach,
    });
    expect(buildEbayListingSetupDraft(withdrawn).fulfillmentPolicyId).toBe("");
    expect(listingSetupHasUnsavedPolicy(withdrawn, buildEbayListingSetupDraft(withdrawn))).toBe(false);
    // Picking a policy that is not saved is unsaved; picking the saved one again is not.
    expect(listingSetupHasUnsavedPolicy(withdrawn, { ...buildEbayListingSetupDraft(withdrawn), fulfillmentPolicyId: "fulfillment-fast" })).toBe(true);
    expect(listingSetupHasUnsavedPolicy(withdrawn, { ...buildEbayListingSetupDraft(withdrawn), returnPolicyId: "return-60" })).toBe(true);
    expect(listingSetupHasUnsavedPolicy(withdrawn, { ...buildEbayListingSetupDraft(withdrawn), returnPolicyId: "return-30" })).toBe(false);
    // A policy Card Shellz filled in (one choice, none saved) is unsaved until saved.
    const oneChoice = setup({
      selection: nothingSaved.selection,
      options: { ...twoOfEach, paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }] },
    });
    expect(listingSetupHasUnsavedPolicy(oneChoice, buildEbayListingSetupDraft(oneChoice))).toBe(true);
    // Once saved, the same draft is not.
    const saved = setup({ selection: { ...nothingSaved.selection, paymentPolicyId: "payment-managed" }, options: oneChoice.options });
    expect(listingSetupHasUnsavedPolicy(saved, buildEbayListingSetupDraft(oneChoice))).toBe(false);
  });

  it("preserves a valid existing choice when multiple choices are available", () => {
    const draft = buildEbayListingSetupDraft(setup({
      selection: {
        merchantLocationKey: "warehouse-west",
        fulfillmentPolicyId: "fulfillment-fast",
        returnPolicyId: "return-30",
        paymentPolicyId: "payment-managed",
      },
      options: {
        merchantLocations: [
          { id: "warehouse-east", name: "East" },
          { id: "warehouse-west", name: "West" },
        ],
        fulfillmentPolicies: [
          policyOption("fulfillment-standard", "Standard"),
          policyOption("fulfillment-fast", "Fast"),
        ],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    }));

    expect(draft.fulfillmentPolicyId).toBe("fulfillment-fast");
  });

  it("does not prefill an incompatible fulfillment policy", () => {
    const draft = buildEbayListingSetupDraft(setup({
      options: {
        merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
        fulfillmentPolicies: [{
          ...policyOption("fulfillment-fast", "Fast"),
          compatible: false,
          compatibilityIssues: [{
            code: "handling_time_too_short",
            message: "Handling time is too short.",
          }],
        }],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    }));

    expect(draft.fulfillmentPolicyId).toBe("");
  });

  it("keeps setup and authorization recovery inline on Catalog", () => {
    const source = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "EbayListingSetupPanel.tsx"),
      "utf8",
    );
    const catalogSource = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "DropshipPortalCatalog.tsx"),
      "utf8",
    );

    expect(source).toContain("eBay listing setup");
    expect(source).toContain("Card Shellz fulfillment capabilities");
    expect(source).toContain('label="Allowed carriers"');
    expect(source).not.toContain('label="Connected carriers"');
    expect(source).toContain("Card Shellz controls the physical inventory location");
    expect(source).toContain("offerShipFromRepair");
    expect(source).not.toContain("managedLocationNeedsReconciliation");
    expect(source).not.toContain('label="Inventory location"');
    expect(source).toContain("max-h-64 overflow-y-auto");
    expect(source).toContain("/api/dropship/ebay/listing-setup/");
    expect(source).toContain("<EbayStoreCategoryAuthorizationRecovery");
    expect(catalogSource).toContain("<EbayListingSetupPanel");
  });

  it("gives the Catalog's setup and policy override panels their own keys, so a store switch unmounts the last store's panels", () => {
    const catalogSource = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "DropshipPortalCatalog.tsx"),
      "utf8",
    );

    // Siblings sharing a key leave React unable to tell them apart, so the previous store's panel could stay mounted.
    const setupKey = /<EbayListingSetupPanel\s+key=\{`([^`]*)`\}/.exec(catalogSource)?.[1];
    const overrideKey = /<EbayListingPolicyOverridePanel\s+key=\{`([^`]*)`\}/.exec(catalogSource)?.[1];
    expect(setupKey).toBe("listing-setup-${selectedStoreConnectionIdNumber}");
    expect(overrideKey).toBe("policy-override-${selectedStoreConnectionIdNumber}");
    expect(setupKey).not.toBe(overrideKey);
    // Each panel is placed once, so no other copy carries an older, shared key.
    expect(catalogSource.split("<EbayListingSetupPanel").length - 1).toBe(1);
    expect(catalogSource.split("<EbayListingPolicyOverridePanel").length - 1).toBe(1);
    // Both panels work on the store the keys name.
    for (const panel of ["<EbayListingSetupPanel", "<EbayListingPolicyOverridePanel"]) {
      const start = catalogSource.indexOf(panel);
      const tag = catalogSource.slice(start, catalogSource.indexOf("/>", start));
      expect(tag, panel).toContain("storeConnectionId={selectedStoreConnectionIdNumber}");
    }
  });

  it("saves against the loaded revision with a reused request key, and repairs the ship-from location on its own", () => {
    const source = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "EbayListingSetupPanel.tsx"),
      "utf8",
    );

    // Saving no longer repairs the location; the repair is its own request (W10).
    expect(source).not.toContain("Save setup to reconcile it automatically");
    expect(source).not.toContain("!draftChanged && !managedLocationNeedsReconciliation");
    expect(source).toContain("Update ship-from location");
    expect(source).toContain("/api/dropship/ebay/listing-setup/${storeConnectionId}/ship-from/repair");
    expect(source).toMatch(/postJson<DropshipEbayListingSetupResponse>\(\s*`\/api\/dropship\/ebay\/listing-setup\/\$\{storeConnectionId\}\/ship-from\/repair`,\s*buildEbayShipFromRepairRequest\(setupQuery\.data, repairKeys\.current\.keyFor\(attempt\)\),/);
    // The PUT body is built from the revision and a request key, never the bare draft.
    expect(source).toContain("buildEbayListingSetupSaveRequest(setupQuery.data, draft, saveKeys.current.keyFor(attempt))");
    expect(source).toMatch(/putJson<DropshipEbayListingSetupResponse>\(\s*`\/api\/dropship\/ebay\/listing-setup\/\$\{storeConnectionId\}`,\s*body,\s*\)/);
    // One key holder per kind of request, kept across renders; a key is dropped only once the server confirmed it.
    expect(source).toContain('useRef(new ListingSetupRequestKeys("ebay-setup"))');
    expect(source).toContain('useRef(new ListingSetupRequestKeys("ebay-ship-from"))');
    expect(source).toContain("const attempt = { revision: setupQuery.data.revision ?? null, draft };");
    expect(source.indexOf("saveKeys.current.settled()")).toBeGreaterThan(source.indexOf("await putJson<DropshipEbayListingSetupResponse>("));
    expect(source.indexOf("repairKeys.current.settled()")).toBeGreaterThan(source.indexOf("await postJson<DropshipEbayListingSetupResponse>("));
    expect(source).toContain("listingSetupSaveErrorMessage(caught,");
    // The button's words are the ones a failed push tells the vendor to choose.
    expect(listingPushNextStep("DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH", false)).toContain("choose Update ship-from location");
  });

  it("shows a paused store's settings read-only, without the ship-from button or a usable save", () => {
    const markup = renderPanel(setup({
      revision: 3,
      access: { canEdit: false, reason: "store_paused" },
      checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
      fulfillmentCapability: null,
      missingFields: ["merchantLocationKey"],
      selection: { merchantLocationKey: "old-warehouse", fulfillmentPolicyId: "fulfillment-fast",
        returnPolicyId: "return-30", paymentPolicyId: "payment-managed" },
    }));

    expect(markup).toContain("Test store is paused, so its settings can&#x27;t be changed now.");
    expect(markup).not.toContain("Card Shellz fulfillment capabilities");
    expect(markup).not.toContain("Update ship-from location");
    expect(buttonTag(markup, "Fulfillment policy")).toContain(DISABLED);
    expect(buttonTag(markup, "Return policy")).toContain(DISABLED);
    expect(buttonTag(markup, "Payment policy")).toContain(DISABLED);
    expect(buttonTagContaining(markup, "Save eBay listing setup")).toContain(DISABLED);
  });

  it("explains a Card Shellz shipping outage with a support reference instead of the capability summary", () => {
    const markup = renderPanel(setup({
      revision: 3,
      access: { canEdit: true, reason: null },
      checks: { ebay: "checked", fulfillment: {
        status: "unavailable", reference: "DROPSHIP_SHIPPING_CONFIG_REQUIRED", kind: "setup_incomplete",
      } },
      fulfillmentCapability: null,
      // eBay was read; without Card Shellz shipping no shipping policy could be checked.
      options: {
        merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
        fulfillmentPolicies: [{ ...policyOption("fulfillment-standard", "Standard"), compatible: false, compatibilityChecked: false }],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    }));

    expect(markup).toContain("Card Shellz is finishing shipping setup for your store. You can pick a shipping policy when it&#x27;s done.");
    expect(markup).toContain("Reference: DROPSHIP_SHIPPING_CONFIG_REQUIRED");
    expect(markup).not.toContain("Card Shellz fulfillment capabilities");
  });

  it("offers the ship-from update when Card Shellz's warehouse destination is not the saved one", () => {
    const markup = renderPanel(setup({
      revision: 3,
      access: { canEdit: true, reason: null },
      checks: { ebay: "checked", fulfillment: { status: "checked" } },
      missingFields: ["merchantLocationKey"],
    }));

    expect(markup).toContain("Card Shellz needs to update where your items ship from. It changes no policy.");
    expect(buttonTagContaining(markup, "Update ship-from location")).not.toContain(DISABLED);
    expect(markup).not.toContain("Save setup to reconcile it automatically");
    expect(markup).toContain("Card Shellz fulfillment capabilities");
  });

  it("shows no read-only or shipping notice to a vendor who can edit, on an answer from a server before revisions", () => {
    const markup = renderPanel(setup({ complete: true }));
    expect(markup).not.toContain("can&#x27;t be changed");
    expect(markup).not.toContain("finishing shipping setup");
    expect(markup).not.toContain("Update ship-from location");
  });

  it("does not offer the ship-from update while Card Shellz shipping can't be checked, and says so instead of setup required", () => {
    const markup = renderPanel(setup({
      revision: 3,
      access: { canEdit: true, reason: null },
      checks: { ebay: "checked", fulfillment: {
        status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", kind: "temporary",
      } },
      fulfillmentCapability: null,
      missingFields: ["merchantLocationKey"],
      options: {
        merchantLocations: [],
        fulfillmentPolicies: [{ ...policyOption("fulfillment-standard", "Standard"), compatible: false, compatibilityChecked: false }],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    }));

    expect(markup).toContain("Can&#x27;t check Card Shellz shipping right now. Your saved settings still apply. Choose Refresh options in a few minutes.");
    expect(markup).toContain("Reference: DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE");
    expect(markup).not.toContain("Update ship-from location");
    expect(markup).not.toContain("Card Shellz needs to update where your items ship from");
    expect(markup).toContain("Not checked");
    expect(markup).not.toContain("Setup required");
    // Unchecked shipping policies are not "missing": nothing to create in Seller Hub.
    expect(markup).not.toContain("eBay did not return every required compatible business policy");
  });

  it("shows a read-only view without claiming eBay returned no options or that policies are missing", () => {
    const markup = renderPanel(setup({
      revision: 3,
      access: { canEdit: false, reason: "store_disconnected" },
      checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
      fulfillmentCapability: null,
      selection: { merchantLocationKey: "warehouse-main", fulfillmentPolicyId: "fulfillment-fast",
        returnPolicyId: "return-30", paymentPolicyId: null },
      storedNames: { fulfillmentPolicyName: "Fast", returnPolicyName: "Thirty days", paymentPolicyName: null },
    }));

    expect(markup).toContain("Test store is disconnected, so its settings can&#x27;t be changed now.");
    expect(markup).toContain("View only");
    expect(markup).not.toContain("No eligible options were returned by eBay.");
    expect(markup).not.toContain("eBay did not return every required compatible business policy");
    expect(markup).not.toContain("Setup required");
  });

  it("gates the ship-from block on offerShipFromRepair, and shows the saved policies when eBay's lists were not read", () => {
    const source = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "EbayListingSetupPanel.tsx"),
      "utf8",
    );

    // The repair is offered only when the location is missing, shipping was checked, and the view can be changed.
    const definition = /const offerShipFromRepair = Boolean\(([\s\S]*?)\);/.exec(source)?.[1] ?? "";
    expect(definition).toContain('setupQuery.data.missingFields.includes("merchantLocationKey")');
    expect(definition).toContain("listingSetupShippingChecked(setupQuery.data)");
    expect(definition).toContain("!savedValuesOnly");
    expect(definition).toContain("!readOnlyMessage");
    // The block with the message and the button is rendered only under that gate.
    const gate = source.indexOf("{offerShipFromRepair && (");
    expect(gate).toBeGreaterThan(-1);
    const blockEnd = source.indexOf("\n          )}", gate);
    expect(blockEnd).toBeGreaterThan(gate);
    const block = source.slice(gate, blockEnd);
    expect(block).toContain("Card Shellz needs to update where your items ship from. It changes no policy.");
    expect(block).toContain("onClick={() => void repairShipFrom()}");
    expect(source.split("repairShipFrom()}").length - 1).toBe(1);
    expect(source.split("Card Shellz needs to update where your items ship from").length - 1).toBe(1);

    // Without eBay's lists, each field offers its saved policy only, never eBay's (empty) list.
    for (const field of ["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"]) {
      expect(source).toMatch(new RegExp(
        `options=\\{savedValuesOnly\\s*\\?\\s*listingSetupSavedOption\\(setupQuery\\.data, "${field}"\\)`,
      ));
    }
    expect(source).toMatch(/:\s*fulfillmentPolicyDisplayOptions\(setupQuery\.data\.options\.fulfillmentPolicies\)\}/);
    expect(source).toMatch(/:\s*setupQuery\.data\.options\.returnPolicies\}/);
    expect(source).toMatch(/:\s*setupQuery\.data\.options\.paymentPolicies\}/);
    expect(source.split("savedValuesOnly={savedValuesOnly}").length - 1).toBe(3);
    // Shipping option words come from the shared description, not a local copy.
    expect(source).toContain("description: fulfillmentPolicyOptionDescription(policy)");
  });

  it("saves any one changed policy, and holds the ship-from repair only while a policy the vendor picked is unsaved", () => {
    const source = readFileSync(
      join(process.cwd(), "client", "src", "pages", "dropship", "EbayListingSetupPanel.tsx"),
      "utf8",
    );

    // A save sends only what changed, so one changed policy is enough; nothing asks for all three any more.
    expect(source).toContain("const canSave = setupQuery.data !== undefined && listingSetupHasUnsavedPolicy(setupQuery.data, draft);");
    expect(source).not.toMatch(/\bdraftComplete\b|\bdraftChanged\b/);
    const saveGuard = /async function saveSetup\(\): Promise<void> \{\s*if \(([^)]*)\) return;/.exec(source)?.[1] ?? "";
    expect(saveGuard.split(" || ")).toContain("!canSave");
    const saveOnClick = source.indexOf("onClick={saveSetup}");
    expect(saveOnClick).toBeGreaterThan(-1);
    const saveButton = source.slice(source.lastIndexOf("<Button", saveOnClick), saveOnClick);
    expect(saveButton).toMatch(/disabled=\{[^}]*\|\| !canSave \|\|[^}]*\}/);

    // The repair reloads the setup, so it waits until a policy the vendor picked is saved or undone.
    // A Card Shellz suggestion does not hold it: the vendor can't undo one, and the reload fills it in again.
    const pickDefinition = /const unsavedPick = useMemo\(([\s\S]*?)\n {2}\);/.exec(source)?.[1] ?? "";
    expect(pickDefinition).toContain("unsavedPolicy && setupQuery.data !== undefined");
    expect(pickDefinition).toContain('draft[field] !== ""');
    expect(pickDefinition).toContain('draft[field] !== (setupQuery.data?.selection[field] ?? "")');
    expect(pickDefinition).toContain("!suggestedFields.has(field)");
    // The guard, the hint and the button all use the vendor's pick, never any unsaved policy.
    const repairGuard = /async function repairShipFrom\(\): Promise<void> \{\s*if \(([^)]*)\) return;/.exec(source)?.[1] ?? "";
    expect(repairGuard.split(" || ")).toContain("unsavedPick");
    expect(repairGuard).not.toContain("unsavedPolicy");
    const gate = source.indexOf("{offerShipFromRepair && (");
    const block = source.slice(gate, source.indexOf("\n          )}", gate));
    expect(block).toContain('{unsavedPick && <span className="mt-1 block text-xs">Save or undo your policy change first.</span>}');
    expect(block).not.toContain("unsavedPolicy");
    const repairOnClick = block.indexOf("onClick={() => void repairShipFrom()}");
    expect(repairOnClick).toBeGreaterThan(-1);
    const repairButton = block.slice(block.lastIndexOf("<Button", repairOnClick), repairOnClick);
    expect(repairButton).toMatch(/disabled=\{[^}]*\|\| unsavedPick\}/);
    expect(source.split("Save or undo your policy change first.").length - 1).toBe(1);
    // A suggestion is still not saved: the badge and the leave guard count every unsaved policy.
    expect(source).toContain("eBay listing setup{unsavedPolicy && <NotSavedBadge />}");
    expect(source).toContain('useUnsavedDraft(`listing-setup:${storeConnectionId}`, "eBay listing setup", unsavedPolicy);');

    // A failed repair gets the repair's words (a conflict asks for the repair again, not a save); a failed save keeps the save's.
    const repairStart = source.indexOf("async function repairShipFrom(): Promise<void>");
    const repairBody = source.slice(repairStart, source.indexOf("\n  }\n", repairStart));
    expect(repairBody).toContain('setSaveError(listingSetupSaveErrorMessage(caught, "The ship-from location could not be updated.", "ship_from_repair"));');
    const saveStart = source.indexOf("async function saveSetup(): Promise<void>");
    const saveBody = source.slice(saveStart, source.indexOf("\n  }\n", saveStart));
    expect(saveBody).toContain('setSaveError(listingSetupSaveErrorMessage(caught, "eBay listing setup could not be saved."));');
    expect(source.split('"ship_from_repair"').length - 1).toBe(1);

    // Each newer answer rebases the draft on the one it was built from, so a refetch keeps the vendor's picks.
    expect(source).toContain("const draftBase = useRef<DropshipEbayListingSetupResponse | null>(null);");
    expect(source).toMatch(/const previous = draftBase\.current;\s*draftBase\.current = next;\s*setDraft\(\(current\) => rebaseEbayListingSetupDraft\(previous, current, next\)\);/);
  });

  it("starts with Save off and the repair on for a loaded answer, before any policy is picked", () => {
    // The server render holds the empty first draft: nothing changed, so nothing to save and nothing holding the repair.
    const markup = renderPanel(setup({
      revision: 3,
      access: { canEdit: true, reason: null },
      checks: { ebay: "checked", fulfillment: { status: "checked" } },
      missingFields: ["merchantLocationKey"],
      selection: { merchantLocationKey: null, fulfillmentPolicyId: "fulfillment-standard",
        returnPolicyId: "return-30", paymentPolicyId: "payment-managed" },
      options: {
        merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
        fulfillmentPolicies: [policyOption("fulfillment-standard", "Standard")],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    }));

    expect(buttonTagContaining(markup, "Save eBay listing setup")).toContain(DISABLED);
    expect(buttonTagContaining(markup, "Update ship-from location")).not.toContain(DISABLED);
    expect(markup).not.toContain("Save or undo your policy change first.");
  });
});

describe("rebaseEbayListingSetupDraft", () => {
  const CHECKED = { ebay: "checked" as const, fulfillment: { status: "checked" as const } };
  const LISTS = {
    merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
    fulfillmentPolicies: [policyOption("fulfillment-standard", "Standard"), policyOption("fulfillment-fast", "Fast")],
    returnPolicies: [{ id: "return-30", name: "Thirty days" }, { id: "return-60", name: "Sixty days" }, { id: "return-90", name: "Ninety days" }],
    paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }, { id: "payment-other", name: "Other" }],
  };
  const SAVED = {
    merchantLocationKey: "warehouse-main",
    fulfillmentPolicyId: "fulfillment-standard",
    returnPolicyId: "return-30",
    paymentPolicyId: "payment-managed",
  };
  /** An editable, fully checked answer at revision 3 with SAVED saved. */
  const loaded = (overrides: Partial<DropshipEbayListingSetupResponse> = {}) => setup({
    revision: 3, access: { canEdit: true, reason: null }, checks: CHECKED, selection: SAVED, options: LISTS, ...overrides,
  });
  /** The vendor changed shipping and return; payment is as saved. */
  const PICKED = { fulfillmentPolicyId: "fulfillment-fast", returnPolicyId: "return-60", paymentPolicyId: "payment-managed" };

  it("keeps the vendor's picks when the same answer is read again as a new object", () => {
    const previous = loaded();
    const next = structuredClone(previous);
    expect(next).not.toBe(previous);

    expect(rebaseEbayListingSetupDraft(previous, PICKED, next)).toEqual(PICKED);
    // With nothing picked, the draft is what the answer starts from.
    expect(rebaseEbayListingSetupDraft(previous, buildEbayListingSetupDraft(previous), next)).toEqual(buildEbayListingSetupDraft(next));
  });

  it("after a revision conflict reload, keeps the vendor's pick and takes the other window's change for the fields they left alone", () => {
    const previous = loaded();
    // The vendor changed only the return policy.
    const draft = { ...buildEbayListingSetupDraft(previous), returnPolicyId: "return-60" };
    // Meanwhile another window saved a new shipping and payment policy.
    const next = loaded({ revision: 4, selection: { ...SAVED, fulfillmentPolicyId: "fulfillment-fast", paymentPolicyId: "payment-other" } });

    const rebased = rebaseEbayListingSetupDraft(previous, draft, next);

    expect(rebased).toEqual({ fulfillmentPolicyId: "fulfillment-fast", returnPolicyId: "return-60", paymentPolicyId: "payment-other" });
    // Save stays on, and saving again sends only the vendor's change against the new revision.
    expect(listingSetupHasUnsavedPolicy(next, rebased)).toBe(true);
    expect(buildEbayListingSetupSaveRequest(next, rebased, "ebay-setup:key-0002")).toEqual({
      expectedRevision: 4, idempotencyKey: "ebay-setup:key-0002", returnPolicyId: "return-60",
    });
  });

  it("keeps the vendor's pick over the other window's save of the same field, and has nothing unsaved when both chose the same", () => {
    const previous = loaded();
    const draft = { ...buildEbayListingSetupDraft(previous), returnPolicyId: "return-60" };

    const otherChoice = loaded({ revision: 4, selection: { ...SAVED, returnPolicyId: "return-90" } });
    expect(rebaseEbayListingSetupDraft(previous, draft, otherChoice).returnPolicyId).toBe("return-60");

    const sameChoice = loaded({ revision: 4, selection: { ...SAVED, returnPolicyId: "return-60" } });
    const rebased = rebaseEbayListingSetupDraft(previous, draft, sameChoice);
    expect(rebased.returnPolicyId).toBe("return-60");
    expect(listingSetupHasUnsavedPolicy(sameChoice, rebased)).toBe(false);
  });

  it("drops a pick eBay no longer lists, and starts that field from the new answer", () => {
    const previous = loaded();
    const next = loaded({ options: {
      ...LISTS,
      fulfillmentPolicies: [policyOption("fulfillment-standard", "Standard")],
      returnPolicies: [{ id: "return-30", name: "Thirty days" }, { id: "return-90", name: "Ninety days" }],
    } });

    expect(rebaseEbayListingSetupDraft(previous, PICKED, next)).toEqual(buildEbayListingSetupDraft(next));
    expect(rebaseEbayListingSetupDraft(previous, PICKED, next)).toEqual({
      fulfillmentPolicyId: "fulfillment-standard", returnPolicyId: "return-30", paymentPolicyId: "payment-managed",
    });
    // When the saved one is gone too and several are left, the field opens empty rather than guessing.
    const bothGone = loaded({ options: { ...LISTS, returnPolicies: [{ id: "return-90", name: "Ninety days" }, { id: "return-120", name: "120 days" }] } });
    expect(rebaseEbayListingSetupDraft(previous, PICKED, bothGone).returnPolicyId).toBe("");
  });

  it("drops a shipping pick that was checked and no longer fits Card Shellz shipping", () => {
    const previous = loaded();
    const next = loaded({ options: { ...LISTS, fulfillmentPolicies: [
      policyOption("fulfillment-standard", "Standard"),
      { ...policyOption("fulfillment-fast", "Fast"), compatible: false, compatibilityChecked: true,
        compatibilityIssues: [{ code: "handling_time_too_short", message: "Handling time is too short." }] },
    ] } });

    const rebased = rebaseEbayListingSetupDraft(previous, PICKED, next);
    expect(rebased.fulfillmentPolicyId).toBe("fulfillment-standard");
    // The other pick still stands.
    expect(rebased.returnPolicyId).toBe("return-60");
  });

  it("drops a shipping pick that could not be checked, keeping the saved policy, while return and payment picks stay", () => {
    const previous = loaded();
    const next = loaded({
      checks: { ebay: "checked", fulfillment: {
        status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", kind: "temporary",
      } },
      fulfillmentCapability: null,
      options: { ...LISTS, fulfillmentPolicies: LISTS.fulfillmentPolicies.map((policy) => ({
        ...policy, compatible: false, compatibilityChecked: false,
      })) },
    });
    const draft = { ...PICKED, paymentPolicyId: "payment-other" };

    expect(rebaseEbayListingSetupDraft(previous, draft, next)).toEqual({
      fulfillmentPolicyId: "fulfillment-standard", returnPolicyId: "return-60", paymentPolicyId: "payment-other",
    });
  });

  it("keeps no pick on an answer that shows saved values only, even when it carries lists", () => {
    const previous = loaded();
    for (const next of [
      loaded({ checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } } }),
      loaded({
        access: { canEdit: false, reason: "store_paused" },
        checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
        fulfillmentCapability: null,
        options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] },
      }),
    ]) {
      expect(rebaseEbayListingSetupDraft(previous, PICKED, next)).toEqual({
        fulfillmentPolicyId: "fulfillment-standard", returnPolicyId: "return-30", paymentPolicyId: "payment-managed",
      });
    }
  });

  it("drops a policy Card Shellz suggested, so the new answer decides it", () => {
    // Nothing saved for payment and eBay offered one: Card Shellz filled it in.
    const previous = loaded({
      selection: { ...SAVED, paymentPolicyId: null },
      options: { ...LISTS, paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }] },
    });
    const draft = { ...buildEbayListingSetupDraft(previous), returnPolicyId: "return-60" };
    expect(draft.paymentPolicyId).toBe("payment-managed");
    expect([...suggestedListingSetupFields(previous, draft)]).toEqual(["paymentPolicyId"]);

    // eBay now offers two: the suggestion is not the vendor's pick, so the field opens empty.
    const twoNow = loaded({ selection: { ...SAVED, paymentPolicyId: null } });
    expect(rebaseEbayListingSetupDraft(previous, draft, twoNow)).toEqual({
      fulfillmentPolicyId: "fulfillment-standard", returnPolicyId: "return-60", paymentPolicyId: "",
    });
    // Another window saved a payment policy: that one is shown.
    const savedElsewhere = loaded({ revision: 4, selection: { ...SAVED, paymentPolicyId: "payment-other" } });
    expect(rebaseEbayListingSetupDraft(previous, draft, savedElsewhere).paymentPolicyId).toBe("payment-other");
  });

  it("starts over for another store's answer", () => {
    const previous = loaded();
    const otherStore = loaded({ storeConnectionId: 45, selection: { ...SAVED, returnPolicyId: "return-90" } });

    expect(rebaseEbayListingSetupDraft(previous, PICKED, otherStore)).toEqual(buildEbayListingSetupDraft(otherStore));
    expect(rebaseEbayListingSetupDraft(previous, PICKED, otherStore)).toEqual({
      fulfillmentPolicyId: "fulfillment-standard", returnPolicyId: "return-90", paymentPolicyId: "payment-managed",
    });
  });

  it("builds the draft from the answer alone when there is no earlier one", () => {
    const next = loaded({ selection: { ...SAVED, returnPolicyId: null } });
    expect(rebaseEbayListingSetupDraft(null, PICKED, next)).toEqual(buildEbayListingSetupDraft(next));
    expect(rebaseEbayListingSetupDraft(null, { fulfillmentPolicyId: "", returnPolicyId: "", paymentPolicyId: "" }, next))
      .toEqual(buildEbayListingSetupDraft(next));
  });

  it("does not change the answers or the draft it is given", () => {
    const previous = loaded();
    const next = loaded({ revision: 4, selection: { ...SAVED, paymentPolicyId: "payment-other" } });
    const draft = { ...PICKED };
    const before = structuredClone({ previous, next, draft });

    const rebased = rebaseEbayListingSetupDraft(previous, draft, next);

    expect({ previous, next, draft }).toEqual(before);
    expect(rebased).not.toBe(draft);
    // Frozen inputs work too: writing to one would throw in this strict module.
    const frozen = { selection: Object.freeze({ ...SAVED, paymentPolicyId: "payment-other" }) };
    expect(rebaseEbayListingSetupDraft(Object.freeze(loaded()), Object.freeze({ ...PICKED }), Object.freeze(loaded(frozen))))
      .toEqual({ ...PICKED, paymentPolicyId: "payment-other" });
  });
});

describe("buildEbayListingSetupDraft", () => {
  const twoOfEach = {
    merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
    fulfillmentPolicies: [policyOption("fulfillment-standard", "Standard"), policyOption("fulfillment-fast", "Fast")],
    returnPolicies: [{ id: "return-30", name: "Thirty days" }, { id: "return-60", name: "Sixty days" }],
    paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }, { id: "payment-other", name: "Other" }],
  };

  it("starts a view without eBay's lists from the saved selection, as it is", () => {
    const draft = buildEbayListingSetupDraft(setup({
      checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
      selection: { merchantLocationKey: "warehouse-main", fulfillmentPolicyId: "fulfillment-fast",
        returnPolicyId: "return-30", paymentPolicyId: "payment-managed" },
      // No lists: nothing to check the saved values against, and nothing to drop them for.
      options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] },
    }));
    expect(draft).toEqual({
      fulfillmentPolicyId: "fulfillment-fast", returnPolicyId: "return-30", paymentPolicyId: "payment-managed",
    });
  });

  it("leaves a policy empty in a view without eBay's lists when none is saved, even if eBay offers one choice", () => {
    const draft = buildEbayListingSetupDraft(setup({
      checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
      selection: { merchantLocationKey: null, fulfillmentPolicyId: null, returnPolicyId: "return-30", paymentPolicyId: null },
      options: {
        merchantLocations: [],
        fulfillmentPolicies: [policyOption("fulfillment-standard", "Standard")],
        returnPolicies: [],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    }));
    expect(draft).toEqual({ fulfillmentPolicyId: "", returnPolicyId: "return-30", paymentPolicyId: "" });
  });

  it("keeps a saved shipping policy that could not be checked", () => {
    const draft = buildEbayListingSetupDraft(setup({
      checks: { ebay: "checked", fulfillment: {
        status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", kind: "temporary",
      } },
      selection: { merchantLocationKey: "warehouse-main", fulfillmentPolicyId: "fulfillment-fast",
        returnPolicyId: "return-30", paymentPolicyId: "payment-managed" },
      options: {
        ...twoOfEach,
        fulfillmentPolicies: twoOfEach.fulfillmentPolicies.map((policy) => ({
          ...policy, compatible: false, compatibilityChecked: false,
        })),
      },
    }));
    expect(draft.fulfillmentPolicyId).toBe("fulfillment-fast");
  });

  it("drops a saved shipping policy that was checked and does not fit", () => {
    const draft = buildEbayListingSetupDraft(setup({
      checks: { ebay: "checked", fulfillment: { status: "checked" } },
      selection: { merchantLocationKey: "warehouse-main", fulfillmentPolicyId: "fulfillment-fast",
        returnPolicyId: "return-30", paymentPolicyId: "payment-managed" },
      options: {
        ...twoOfEach,
        fulfillmentPolicies: [
          policyOption("fulfillment-standard", "Standard"),
          { ...policyOption("fulfillment-fast", "Fast"), compatible: false, compatibilityChecked: true,
            compatibilityIssues: [{ code: "handling_time_too_short", message: "Handling time is too short." }] },
          policyOption("fulfillment-economy", "Economy"),
        ],
      },
    }));
    expect(draft.fulfillmentPolicyId).toBe("");
  });

  it("fills in the one checked policy that fits when the saved one does not fit", () => {
    const draft = buildEbayListingSetupDraft(setup({
      checks: { ebay: "checked", fulfillment: { status: "checked" } },
      selection: { merchantLocationKey: "warehouse-main", fulfillmentPolicyId: "fulfillment-fast",
        returnPolicyId: "return-30", paymentPolicyId: "payment-managed" },
      options: {
        ...twoOfEach,
        fulfillmentPolicies: [
          policyOption("fulfillment-standard", "Standard"),
          { ...policyOption("fulfillment-fast", "Fast"), compatible: false, compatibilityChecked: true },
        ],
      },
    }));
    expect(draft.fulfillmentPolicyId).toBe("fulfillment-standard");
  });

  it("never fills in a shipping policy that could not be checked, even when eBay offers only that one", () => {
    const draft = buildEbayListingSetupDraft(setup({
      checks: { ebay: "checked", fulfillment: {
        status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED", kind: "setup_incomplete",
      } },
      options: {
        merchantLocations: [],
        fulfillmentPolicies: [{ ...policyOption("fulfillment-standard", "Standard"), compatible: false, compatibilityChecked: false }],
        returnPolicies: [{ id: "return-30", name: "Thirty days" }],
        paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
      },
    }));
    // Return and payment still get their only choice; shipping stays open.
    expect(draft).toEqual({ fulfillmentPolicyId: "", returnPolicyId: "return-30", paymentPolicyId: "payment-managed" });
  });

  it("fills in the only checked policy that fits among several eBay offers", () => {
    const draft = buildEbayListingSetupDraft(setup({
      checks: { ebay: "checked", fulfillment: { status: "checked" } },
      options: {
        ...twoOfEach,
        fulfillmentPolicies: [
          { ...policyOption("fulfillment-fast", "Fast"), compatible: false, compatibilityChecked: true },
          policyOption("fulfillment-standard", "Standard"),
        ],
      },
    }));
    expect(draft.fulfillmentPolicyId).toBe("fulfillment-standard");
  });

  it("does not change the answer it was built from", () => {
    const answer = setup({
      checks: { ebay: "checked", fulfillment: { status: "checked" } },
      selection: { merchantLocationKey: null, fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null },
      options: twoOfEach,
    });
    const before = structuredClone(answer);
    buildEbayListingSetupDraft(answer);
    expect(answer).toEqual(before);
  });
});

describe("hasMissingVendorOptions", () => {
  const complete = {
    merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
    fulfillmentPolicies: [policyOption("fulfillment-standard", "Standard")],
    returnPolicies: [{ id: "return-30", name: "Thirty days" }],
    paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
  };
  const checked = { ebay: "checked" as const, fulfillment: { status: "checked" as const } };
  const unchecked = { ebay: "checked" as const, fulfillment: {
    status: "unavailable" as const, reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", kind: "temporary" as const,
  } };
  const noLists = { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] };

  it("says nothing is missing when every policy kind has a choice and a shipping policy fits", () => {
    expect(hasMissingVendorOptions(setup({ checks: checked, options: complete }))).toBe(false);
  });

  it("says nothing without eBay's lists, however empty they are", () => {
    expect(hasMissingVendorOptions(setup({ checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } }, options: noLists })))
      .toBe(false);
  });

  it("does not call shipping policies missing when they could not be checked", () => {
    const options = { ...complete, fulfillmentPolicies: [{ ...policyOption("fulfillment-standard", "Standard"),
      compatible: false, compatibilityChecked: false }] };
    expect(hasMissingVendorOptions(setup({ checks: unchecked, options }))).toBe(false);
  });

  it("still calls shipping policies missing when eBay returned none at all, checked or not", () => {
    expect(hasMissingVendorOptions(setup({ checks: unchecked, options: { ...complete, fulfillmentPolicies: [] } }))).toBe(true);
    expect(hasMissingVendorOptions(setup({ checks: checked, options: { ...complete, fulfillmentPolicies: [] } }))).toBe(true);
  });

  it("calls shipping policies missing when they were checked and none fits", () => {
    const options = { ...complete, fulfillmentPolicies: [{ ...policyOption("fulfillment-fast", "Fast"),
      compatible: false, compatibilityChecked: true }] };
    expect(hasMissingVendorOptions(setup({ checks: checked, options }))).toBe(true);
    // A server from before the check states always checked.
    expect(hasMissingVendorOptions(setup({ options }))).toBe(true);
  });

  it("calls return or payment policies missing when eBay returned none, whatever happened to shipping", () => {
    for (const checks of [checked, unchecked]) {
      expect(hasMissingVendorOptions(setup({ checks, options: { ...complete, returnPolicies: [] } }))).toBe(true);
      expect(hasMissingVendorOptions(setup({ checks, options: { ...complete, paymentPolicies: [] } }))).toBe(true);
    }
  });
});

describe("listingSetupStatusLabel", () => {
  const ready = { verificationAvailable: true, readOnly: false };
  const checked = { ebay: "checked" as const, fulfillment: { status: "checked" as const } };

  it("says verification is pending while the answer is not settled, whatever the answer says", () => {
    expect(listingSetupStatusLabel(setup({ complete: true, checks: checked }), { verificationAvailable: false, readOnly: false }))
      .toBe("Verification pending");
    expect(listingSetupStatusLabel(setup({ complete: false }), { verificationAvailable: false, readOnly: true }))
      .toBe("Verification pending");
  });

  it("says view only for a store the vendor can't change, or an answer without eBay's lists", () => {
    expect(listingSetupStatusLabel(setup({ complete: false, checks: checked }), { verificationAvailable: true, readOnly: true }))
      .toBe("View only");
    expect(listingSetupStatusLabel(setup({ complete: false, checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } } }), ready))
      .toBe("View only");
  });

  it("says not checked, not setup required, when Card Shellz shipping could not be read", () => {
    for (const kind of ["temporary", "setup_incomplete", "marketplace_unsupported"] as const) {
      expect(listingSetupStatusLabel(setup({ complete: false, checks: { ebay: "checked", fulfillment: {
        status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_NO_RATE_BOOK", kind,
      } } }), ready), kind).toBe("Not checked");
    }
  });

  it("says ready or setup required only for a fully checked answer", () => {
    expect(listingSetupStatusLabel(setup({ complete: true, checks: checked }), ready)).toBe("Ready");
    expect(listingSetupStatusLabel(setup({ complete: false, checks: checked }), ready)).toBe("Setup required");
  });

  it("reads an answer from a server before the check states as fully checked", () => {
    expect(listingSetupStatusLabel(setup({ complete: true }), ready)).toBe("Ready");
    expect(listingSetupStatusLabel(setup({ complete: false }), ready)).toBe("Setup required");
  });
});

/** The attribute React renders for a disabled button (class names also mention "disabled:"). */
const DISABLED = ' disabled=""';

function renderPanel(answer: DropshipEbayListingSetupResponse): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("React", React);
  try {
    client.setQueryData(ebayListingSetupQueryKey(44), answer);
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(EbayListingSetupPanel, {
        storeConnectionId: 44, storeName: "Test store", onConfigurationChange: () => undefined,
      }),
    ));
  } finally {
    client.clear();
    vi.unstubAllGlobals();
  }
}

/** The opening tag of the combobox button labelled `label`. */
function buttonTag(markup: string, label: string): string {
  const match = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(markup);
  if (!match) throw new Error(`No button labelled ${label}`);
  return match[0];
}

/** The opening tag of the button whose content includes `text`. */
function buttonTagContaining(markup: string, text: string): string {
  const tags = [...markup.matchAll(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g)].map((match) => match[0]);
  const button = tags.find((tag) => tag.includes(text));
  if (!button) throw new Error(`No button containing ${text}`);
  return button.slice(0, button.indexOf(">") + 1);
}

function setup(
  overrides: Partial<DropshipEbayListingSetupResponse>,
): DropshipEbayListingSetupResponse {
  return {
    storeConnectionId: 44,
    marketplaceId: "EBAY_US",
    complete: false,
    missingFields: [],
    fulfillmentCapability: {
      marketplaceId: "EBAY_US",
      requiredHandlingTimeBusinessDays: 1,
      destinationCountry: "US",
      destinationRegions: ["CA", "NY"],
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
    },
    selection: {
      merchantLocationKey: null,
      fulfillmentPolicyId: null,
      returnPolicyId: null,
      paymentPolicyId: null,
    },
    options: {
      merchantLocations: [],
      fulfillmentPolicies: [],
      returnPolicies: [],
      paymentPolicies: [],
    },
    ...overrides,
  };
}

function policyOption(id: string, name: string) {
  return {
    id,
    name,
    compatible: true,
    compatibilityIssues: [],
  };
}
