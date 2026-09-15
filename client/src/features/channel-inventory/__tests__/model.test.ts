import { describe, expect, it } from "vitest";

import {
  EMPTY_POLICY_FORM,
  buildChannelRail,
  describeDestination,
  describeDropshipStore,
  describeIdentity,
  describePublishing,
  describeSupply,
  destinationOptionsFor,
  explainQuantity,
  explicitFieldLabels,
  listExceptions,
  missingChannelDefaultFields,
  policyFormToValue,
  policyValueToForm,
  reconcileSelection,
  resolveSavedFields,
  summarizePendingChanges,
} from "../model";
import { HASH_A, policyHead, policyValue, previewRow, target, view } from "./fixtures";

describe("policy form ↔ value", () => {
  it("maps Inherit to null and explicit choices to exact server values", () => {
    const result = policyFormToValue({
      ...EMPTY_POLICY_FORM,
      shareMode: "set",
      sharePercent: "80",
      holdbackMode: "set",
      holdbackUnits: "5",
      maxMode: "units",
      maxUnits: "60",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        allocationSemantics: null,
        eligible: null,
        shareBps: 8_000,
        holdbackSellableUnits: "5",
        maxPublish: { mode: "units", units: "60" },
        minPublishSellableUnits: null,
      },
    });
  });

  it("keeps explicit zero and No limit distinct from Inherit", () => {
    const zero = policyFormToValue({ ...EMPTY_POLICY_FORM, holdbackMode: "set", holdbackUnits: "0" });
    expect(zero).toMatchObject({ ok: true, value: { holdbackSellableUnits: "0" } });
    const unlimited = policyFormToValue({ ...EMPTY_POLICY_FORM, maxMode: "unlimited" });
    expect(unlimited).toMatchObject({ ok: true, value: { maxPublish: { mode: "unlimited" } } });
  });

  it("refuses a rule with nothing explicit and explains that whole-rule removal is not available", () => {
    const result = policyFormToValue(EMPTY_POLICY_FORM);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatchObject({ field: "form" });
  });

  it("reports field-level validation errors instead of sending them", () => {
    const result = policyFormToValue({ ...EMPTY_POLICY_FORM, shareMode: "set", sharePercent: "120", minMode: "set", minUnits: "1.5" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.field)).toEqual(["shareBps", "minPublishSellableUnits"]);
    }
  });

  it("round-trips a saved value through the form", () => {
    const value = policyValue({
      allocationSemantics: "partitioned",
      eligible: false,
      shareBps: 1_250,
      holdbackSellableUnits: "2",
      maxPublish: { mode: "unlimited" },
      minPublishSellableUnits: "3",
    });
    const result = policyFormToValue(policyValueToForm(value));
    expect(result).toEqual({ ok: true, value });
    expect(policyValueToForm(null)).toEqual(EMPTY_POLICY_FORM);
  });

  it("lists which fields a saved rule sets explicitly", () => {
    expect(explicitFieldLabels(policyValue({ shareBps: 5_000, maxPublish: { mode: "unlimited" } })))
      .toEqual(["Offer", "Maximum to show"]);
  });

  it("names every field a channel default still needs before activation", () => {
    expect(missingChannelDefaultFields(null)).toHaveLength(6);
    expect(missingChannelDefaultFields(policyValue({
      allocationSemantics: "exposure", eligible: true, shareBps: 5_000,
      holdbackSellableUnits: "0", maxPublish: { mode: "unlimited" }, minPublishSellableUnits: "0",
    }))).toEqual([]);
    expect(missingChannelDefaultFields(policyValue({ shareBps: 5_000 }))).toContain("Keep back");
  });
});

describe("inheritance readout (display only)", () => {
  const heads = [
    policyHead({
      scopeKey: "channel:3",
      channelId: 3,
      scope: { scopeType: "channel", channelId: 3 },
      active: policyValue({ allocationSemantics: "exposure", eligible: true, shareBps: 5_000, holdbackSellableUnits: "0", maxPublish: { mode: "unlimited" }, minPublishSellableUnits: "0" }),
      draft: policyValue({ allocationSemantics: "exposure", eligible: true, shareBps: 4_000, holdbackSellableUnits: "0", maxPublish: { mode: "unlimited" }, minPublishSellableUnits: "0" }),
    }),
    policyHead({
      scopeKey: "channel:3:product:10",
      channelId: 3,
      scope: { scopeType: "product", channelId: 3, productId: 10 },
      active: policyValue({ holdbackSellableUnits: "5" }),
    }),
  ];

  it("resolves each field independently, SKU → product → channel, preferring the saved draft", () => {
    const sources = resolveSavedFields(heads, { scopeType: "variant", channelId: 3, productId: 10, productVariantId: 101 });
    expect(sources.shareBps).toEqual({ kind: "channel", display: "40%", authority: "draft", scopeKey: "channel:3" });
    expect(sources.holdbackSellableUnits).toEqual({ kind: "product", display: "5 units", authority: "active", scopeKey: "channel:3:product:10" });
    expect(sources.maxPublish).toMatchObject({ kind: "channel", display: "No limit" });
  });

  it("reports fields nothing sets as unset rather than inventing a value", () => {
    const sources = resolveSavedFields([heads[1]!], { scopeType: "variant", channelId: 3, productId: 10, productVariantId: 101 });
    expect(sources.shareBps).toEqual({ kind: "unset" });
    expect(sources.holdbackSellableUnits.kind).toBe("product");
  });

  it("never lets a channel default inherit from anything", () => {
    const sources = resolveSavedFields(heads, { scopeType: "channel", channelId: 3 });
    expect(Object.values(sources).every((source) => source.kind === "unset")).toBe(true);
  });
});

describe("dropship store labels", () => {
  const store = (overrides: Partial<ReturnType<typeof baseStore>> = {}) => ({ ...baseStore(), ...overrides });
  function baseStore() {
    return {
      id: 90,
      vendorId: 1,
      vendorName: "Vendor Co" as string | null,
      platform: "ebay" as const,
      status: "connected",
      externalAccountLabel: "vendor-ebay" as string | null,
      verifiedExternalAccountId: "vendor-user-1" as string | null,
    };
  }

  it("uses the vendor name with the account when both are present", () => {
    expect(describeDropshipStore(store())).toBe("Vendor Co · vendor-ebay");
  });

  // Regression: dropship.dropship_vendors.business_name is nullable, and a
  // String(null) coercion used to render the literal word "null" as a name.
  it("falls back to the account label when the vendor has no trading name", () => {
    expect(describeDropshipStore(store({ vendorName: null }))).toBe("vendor-ebay");
  });

  it("falls back to the store id when neither name nor account label exists", () => {
    expect(describeDropshipStore(store({ vendorName: null, externalAccountLabel: null })))
      .toBe("store #90");
  });

  it("never renders the text null for a nameless vendor", () => {
    const label = describeDropshipStore(store({ vendorName: null, externalAccountLabel: null }));
    expect(label).not.toContain("null");
  });
});

describe("destinations and publishing state", () => {
  it("names a Shopify destination by its store and exact location", () => {
    expect(describeDestination(target(), view())).toMatchObject({
      title: "us-store.myshopify.com",
      scope: "Shopify location gid://shopify/Location/1",
      provider: "shopify",
    });
  });

  it("names an eBay destination by its verified seller account", () => {
    const ebayTarget = target({ id: 6, channelId: 4, channelConnectionId: 44, providerScopeType: "account", externalScopeId: "ebay-user-9" });
    expect(describeDestination(ebayTarget, view())).toMatchObject({ title: "cardshellz", scope: "eBay account ebay-user-9" });
  });

  it("names a dropship destination by vendor and store", () => {
    const dropship = target({ id: 7, destinationKind: "dropship_store_connection", channelConnectionId: null, dropshipStoreConnectionId: 90, providerScopeType: "account", externalScopeId: "vendor-user-1" });
    expect(describeDestination(dropship, view())).toMatchObject({ title: "Vendor Co · vendor-ebay", provider: "ebay" });
  });

  it("reads publishing state in operator terms and lets an external publisher win over the state column", () => {
    expect(describePublishing(target({ state: "live" }))).toMatchObject({ label: "Publishing", tone: "live" });
    expect(describePublishing(target({ state: "preview" }))).toMatchObject({ label: "Calculating only", tone: "preview" });
    expect(describePublishing(target({ state: "disabled" }))).toMatchObject({ label: "Not publishing", tone: "off" });
    expect(describePublishing(target({ state: "live", publicationAuthority: "external_provider" })))
      .toMatchObject({ label: "Externally managed", tone: "external" });
  });

  it("summarizes the channel rail from server evidence", () => {
    const [shopify] = buildChannelRail(view());
    expect(shopify).toMatchObject({ previewCount: 1, liveCount: 0, hasChannelDefault: false, exceptionCount: 0 });
  });

  it("keeps a selection when it still exists and falls back to the first option otherwise", () => {
    expect(reconcileSelection(5, [{ id: 5 }, { id: 6 }])).toBe(5);
    expect(reconcileSelection(9, [{ id: 5 }, { id: 6 }])).toBe(5);
    expect(reconcileSelection(9, [])).toBeNull();
  });
});

describe("supply", () => {
  it("treats a missing binding as not configured, never as every warehouse", () => {
    expect(describeSupply(null)).toEqual({ activeNodeIds: [], draftNodeIds: null, savedNodeIds: [], pending: false, configured: false });
  });

  it("prefers the saved draft like the server preview and flags it pending", () => {
    const binding = (id: number, nodes: number[], lifecycle: "draft" | "sealed") => ({
      bindingId: id, publicationTargetId: 5, version: id, lifecycleStatus: lifecycle, definitionHash: HASH_A,
      fulfillmentNodeIds: nodes, changeReason: null, createdBy: "operator-1",
      createdAt: "2026-09-10T10:00:00.000Z", updatedAt: "2026-09-10T10:00:00.000Z",
    });
    const supply = describeSupply({ publicationTargetId: 5, revision: "2", activeBinding: binding(1, [7], "sealed"), draftBinding: binding(2, [7, 8], "draft") });
    expect(supply).toMatchObject({ activeNodeIds: [7], draftNodeIds: [7, 8], savedNodeIds: [7, 8], pending: true, configured: true });
  });
});

describe("exceptions and pending changes", () => {
  const richView = view({
    policyHeads: [
      policyHead({ scopeKey: "channel:3", channelId: 3, scope: { scopeType: "channel", channelId: 3 }, draft: policyValue({ shareBps: 5_000 }) }),
      policyHead({ scopeKey: "channel:3:product:10", channelId: 3, scope: { scopeType: "product", channelId: 3, productId: 10 }, active: policyValue({ holdbackSellableUnits: "5" }) }),
      policyHead({ scopeKey: "channel:3:variant:101", channelId: 3, scope: { scopeType: "variant", channelId: 3, productId: 10, productVariantId: 101 }, active: policyValue({ shareBps: 8_000 }), draft: policyValue({ shareBps: 8_000, maxPublish: { mode: "units", units: "60" } }) }),
      policyHead({ scopeKey: "channel:4:product:11", channelId: 4, scope: { scopeType: "product", channelId: 4, productId: 11 }, draft: policyValue({ eligible: false }) }),
    ],
    policySubjects: [
      { scopeKey: "channel:3:product:10", productId: 10, productSku: "CARD", productName: "Card Shell", productVariantId: null, variantSku: null, variantName: null, unitsPerVariant: null },
      { scopeKey: "channel:3:variant:101", productId: 10, productSku: "CARD", productName: "Card Shell", productVariantId: 101, variantSku: "CARD-P5", variantName: "Pack of 5", unitsPerVariant: 5 },
    ],
  });

  it("lists only this channel's product and SKU rules with catalog labels and status", () => {
    const rows = listExceptions(richView, 3);
    expect(rows.map((row) => row.scopeKey)).toEqual(["channel:3:product:10", "channel:3:variant:101"]);
    expect(rows[0]).toMatchObject({ title: "CARD · Card Shell", subtitle: "Whole product", explicitFields: ["Keep back"], pending: false, active: true });
    expect(rows[1]).toMatchObject({ title: "CARD-P5", subtitle: "CARD · Card Shell · SKU rule", explicitFields: ["Offer", "Maximum to show"], pending: true, active: true, productVariantId: 101 });
  });

  it("falls back to ids when a subject label is missing instead of hiding the rule", () => {
    expect(listExceptions(richView, 4)[0]).toMatchObject({ title: "Product #11", pending: true, active: false });
  });

  it("counts saved drafts that the live authority is not using yet", () => {
    expect(summarizePendingChanges(richView, 3, 5)).toEqual({ supply: false, channelDefault: true, exceptionCount: 1, identityCount: 0, total: 2 });
    expect(summarizePendingChanges(view(), 3, null).total).toBe(0);
  });
});

describe("quantity explanation", () => {
  it("labels the server's breakdown in calculation order without recomputing it", () => {
    const explanation = explainQuantity(previewRow());
    expect(explanation.steps.map((step) => [step.label, step.units])).toEqual([
      ["Available", "100"],
      ["Offer 80%", "80"],
      ["Keep back 5", "75"],
      ["Maximum 60", "60"],
      ["Show zero below 0", "60"],
    ]);
    expect(explanation.proposedUnits).toBe("60");
    expect(explanation.zeroReason).toBeNull();
  });

  it("explains zero from ineligibility, the show-zero threshold, or empty availability", () => {
    const row = previewRow();
    expect(explainQuantity({ ...row, policy: { ...row.policy!, eligible: false }, publishedUnits: "0" }).zeroReason).toMatch(/not eligible/);
    expect(explainQuantity({ ...row, policy: { ...row.policy!, minPublishSellableUnits: "70" }, publishedUnits: "0" }).zeroReason).toMatch(/below the show-zero threshold of 70/);
    expect(explainQuantity({ ...row, canonicalAtpUnits: "0", sharedUnits: "0", afterHoldbackUnits: "0", cappedUnits: "0", publishedUnits: "0", sourceWarehouseBreakdown: [] }).zeroReason).toMatch(/No availability/);
  });

  it("says why nothing can be proposed when no complete rule resolves", () => {
    const explanation = explainQuantity(previewRow({ policy: null, publishedUnits: "0" }));
    expect(explanation.steps).toHaveLength(1);
    expect(explanation.zeroReason).toMatch(/No complete rule/);
  });

  it("reads SKU identity from the saved draft first and reports missing identities plainly", () => {
    expect(describeIdentity(null)).toEqual({ kind: "missing" });
    const mapping = (id: number, lifecycle: "draft" | "sealed") => ({
      mappingId: id, publicationTargetId: 5, productVariantId: 101, version: id, lifecycleStatus: lifecycle,
      externalInventoryItemId: `item-${id}`, externalSku: "CARD-P5", definitionHash: HASH_A, changeReason: null,
      createdBy: "operator-1", createdAt: "2026-09-10T10:00:00.000Z", updatedAt: "2026-09-10T10:00:00.000Z",
    });
    expect(describeIdentity({ publicationTargetId: 5, productVariantId: 101, revision: "2", activeMapping: mapping(1, "sealed"), draftMapping: mapping(2, "draft") }))
      .toMatchObject({ kind: "draft", externalInventoryItemId: "item-2", version: 2 });
  });
});

describe("destination setup", () => {
  const data = view();
  const shopify = data.channels[0]!;
  const ebay = data.channels[1]!;
  const amazon = data.channels[2]!;

  it("shapes setup per provider: Shopify needs a location, eBay a verified account, unknown providers are not registrable", () => {
    const shopifyOptions = destinationOptionsFor(shopify, data);
    expect(shopifyOptions[0]).toMatchObject({ kind: "channel_connection", scopeType: "location", suggestedLocationId: "gid://shopify/Location/1", supported: true });
    const ebayOptions = destinationOptionsFor(ebay, data);
    expect(ebayOptions[0]).toMatchObject({ kind: "channel_connection", scopeType: "account", verifiedAccountId: "ebay-user-9", supported: true });
    expect(destinationOptionsFor(amazon, data)[0]).toMatchObject({ supported: false });
  });

  it("offers dropship stores only under the internal dropship channel, and only where an adapter exists", () => {
    const dropshipChannel = data.channels.find((channel) => channel.id === data.dropshipDestinationChannelId)!;
    const options = destinationOptionsFor(dropshipChannel, data).filter((option) => option.kind === "dropship_store_connection");
    expect(options.map((option) => [option.id, option.supported])).toEqual([[90, true], [91, false]]);
  });

  // Dropship quantities are planned and published against the one internal
  // dropship channel, so a storefront must never be registerable under Shopify
  // or eBay, where its channel_id would contradict the runtime.
  it("never offers dropship stores under a marketplace channel", () => {
    for (const channel of [shopify, ebay, amazon]) {
      expect(destinationOptionsFor(channel, data).some((option) => option.kind === "dropship_store_connection")).toBe(false);
    }
  });

  it("offers no dropship store at all when the internal dropship channel is not configured", () => {
    const unconfigured = view({ dropshipDestinationChannelId: null });
    const dropshipChannel = data.channels.find((channel) => channel.id === 7)!;
    expect(destinationOptionsFor(dropshipChannel, unconfigured)
      .some((option) => option.kind === "dropship_store_connection")).toBe(false);
  });

  it("does not offer an account-scoped destination that is already registered", () => {
    const registered = view({ publicationTargets: [target({ id: 6, channelId: 4, channelConnectionId: 44, providerScopeType: "account", externalScopeId: "ebay-user-9" })] });
    expect(destinationOptionsFor(ebay, registered).some((option) => option.kind === "channel_connection")).toBe(false);
  });

});
