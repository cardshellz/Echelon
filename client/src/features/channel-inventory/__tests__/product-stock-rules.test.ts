import { describe, expect, it, vi } from "vitest";

import { ChannelInventoryApiError } from "../api";
import {
  EMPTY_STOCK_RULE_INPUT, describeStockRuleOutcome, listChannelStockRules, mergeStockRuleInput,
  needsStockRuleRewrite, sameStockRuleInput,
  saveAndApplyStockRule, stockRuleInputFor, stockRuleScope, stockRuleValue, type StockRuleSaveSteps,
} from "../product-stock-rules";
import { HASH_A, HASH_B, policyHead, policyValue, view } from "./fixtures";

const sku = { productId: 10, productVariantId: 101 };
const product = { productId: 10, productVariantId: null };
const channelDefault = (channelId: number, overrides = {}) => policyHead({
  scopeKey: `channel:${channelId}`, channelId, scope: { scopeType: "channel", channelId },
  active: policyValue({ allocationSemantics: "exposure", eligible: true, shareBps: 10_000, holdbackSellableUnits: "0",
    maxPublish: { mode: "unlimited" }, minPublishSellableUnits: "0", ...overrides }),
});
const skuRule = (channelId: number, value: ReturnType<typeof policyValue>, draft = false) => policyHead({
  scopeKey: `channel:${channelId}:variant:101`, channelId, scope: stockRuleScope(channelId, sku),
  ...(draft ? { draft: value } : { active: value }), revision: "4",
});
const productRule = (channelId: number, value: ReturnType<typeof policyValue>) => policyHead({
  scopeKey: `channel:${channelId}:product:10`, channelId, scope: stockRuleScope(channelId, product), active: value,
});

describe("one SKU's stock rules across channels", () => {
  it("shows, per channel, the value that wins and where it comes from", () => {
    const rows = listChannelStockRules(view({ policyHeads: [
      channelDefault(3), productRule(3, policyValue({ holdbackSellableUnits: "5" })),
      skuRule(3, policyValue({ maxPublish: { mode: "units", units: "0" } })),
      channelDefault(4, { shareBps: 9000, maxPublish: { mode: "units", units: "100" } }),
    ] }), sku);
    const shopify = rows.find(row => row.channel.id === 3)!;
    expect(shopify.cells.shareBps).toEqual({ display: "100%", source: "channel" });
    expect(shopify.cells.holdbackSellableUnits).toEqual({ display: "5", source: "product" });
    expect(shopify.cells.maxPublish).toEqual({ display: "0", source: "sku" });
    expect(shopify).toMatchObject({ managed: true, hasException: true, outOfStock: true, pending: false });
    const ebay = rows.find(row => row.channel.id === 4)!;
    expect(ebay.cells.shareBps).toEqual({ display: "90%", source: "channel" });
    expect(ebay.cells.maxPublish).toEqual({ display: "100", source: "channel" });
    expect(ebay).toMatchObject({ managed: true, hasException: false, outOfStock: false });
  });

  it("marks a channel with no default as not managed instead of inventing values", () => {
    const amazon = listChannelStockRules(view({ policyHeads: [channelDefault(3)] }), sku).find(row => row.channel.id === 6)!;
    expect(amazon.managed).toBe(false);
    expect(amazon.cells.maxPublish).toEqual({ display: "Not set", source: "unset" });
    expect(amazon.outOfStock).toBe(false);
  });

  it("reads the whole product without picking up a SKU rule, and skips inactive channels", () => {
    const base = view({ policyHeads: [channelDefault(3), skuRule(3, policyValue({ maxPublish: { mode: "units", units: "0" } }))] });
    const rows = listChannelStockRules({ ...base, channels: base.channels.map(channel => channel.id === 4 ? { ...channel, status: "inactive" } : channel) }, product);
    expect(rows.some(row => row.channel.id === 4)).toBe(false);
    expect(rows.find(row => row.channel.id === 3)).toMatchObject({ hasException: false, outOfStock: false });
  });

  it("shows what is in effect, and reports a saved change that was never applied separately", () => {
    const pending = listChannelStockRules(view({ policyHeads: [channelDefault(3),
      skuRule(3, policyValue({ shareBps: 5000, maxPublish: { mode: "units", units: "0" } }), true)] }), sku)[0];
    // Nothing was applied: the channel still uses its default and the item is still selling.
    expect(pending.cells.shareBps).toEqual({ display: "100%", source: "channel" });
    expect(pending.cells.maxPublish).toEqual({ display: "No max", source: "channel" });
    expect(pending).toMatchObject({ pending: true, pendingChange: "Stock % 50%, Max 0", hasException: true, liveException: false, outOfStock: false });
  });

  it("keeps showing the applied rule while a newer change to it waits", () => {
    const head = policyHead({ scopeKey: "channel:3:variant:101", channelId: 3, scope: stockRuleScope(3, sku),
      active: policyValue({ maxPublish: { mode: "units", units: "0" } }), draft: policyValue({ inheritAll: true }), revision: "5" });
    const row = listChannelStockRules(view({ policyHeads: [channelDefault(3), head] }), sku)[0];
    expect(row.cells.maxPublish).toEqual({ display: "0", source: "sku" });
    expect(row).toMatchObject({ outOfStock: true, liveException: true, pending: true, pendingChange: "Clear exception" });
  });

  it("does not show an unapplied whole-product rule as in effect on a SKU", () => {
    const productDraft = policyHead({ scopeKey: "channel:3:product:10", channelId: 3, scope: stockRuleScope(3, product),
      draft: policyValue({ maxPublish: { mode: "units", units: "0" } }) });
    const onSku = listChannelStockRules(view({ policyHeads: [channelDefault(3), productDraft] }), sku)[0];
    expect(onSku).toMatchObject({ outOfStock: false, pending: false, pendingChange: null, liveException: false });
    const onProduct = listChannelStockRules(view({ policyHeads: [channelDefault(3), productDraft] }), product)[0];
    expect(onProduct).toMatchObject({ outOfStock: false, pending: true, pendingChange: "Max 0" });
  });

  it("ignores a cleared rule and names an old out-of-stock draft as Max 0", () => {
    const cleared = listChannelStockRules(view({ policyHeads: [channelDefault(3), skuRule(3, policyValue({ inheritAll: true }))] }), sku)[0];
    expect(cleared).toMatchObject({ hasException: false, liveException: false, pending: false });
    expect(cleared.cells.shareBps.source).toBe("channel");
    const retired = listChannelStockRules(view({ policyHeads: [channelDefault(3), skuRule(3, policyValue({ eligible: false }), true)] }), sku)[0];
    expect(retired).toMatchObject({ pendingChange: "Max 0", outOfStock: false });
  });
});

describe("turning what was typed into the saved rule", () => {
  it("round-trips a saved rule into the form and back", () => {
    const head = skuRule(3, policyValue({ shareBps: 5000, holdbackSellableUnits: "2", maxPublish: { mode: "units", units: "25" }, minPublishSellableUnits: "3" }));
    const input = stockRuleInputFor(head);
    expect(input).toEqual({ sharePercent: "50", bufferUnits: "2", maxMode: "units", maxUnits: "25", hideBelowUnits: "3" });
    expect(stockRuleValue(input, head)).toEqual({ ok: true, value: head.activePolicy!.value });
  });

  it("writes Max 0 as an explicit zero, not as 'no value'", () => {
    const result = stockRuleValue({ ...EMPTY_STOCK_RULE_INPUT, maxMode: "units", maxUnits: "0" }, null);
    expect(result).toEqual({ ok: true, value: policyValue({ maxPublish: { mode: "units", units: "0" } }) });
  });

  it("keeps settings this view does not show", () => {
    const head = skuRule(3, policyValue({ allocationSemantics: "partitioned", sourceFulfillmentNodeIds: [7], shareBps: 5000 }));
    const result = stockRuleValue({ ...EMPTY_STOCK_RULE_INPUT, bufferUnits: "4" }, head);
    expect(result).toEqual({ ok: true, value: policyValue({ allocationSemantics: "partitioned",
      sourceFulfillmentNodeIds: [7], holdbackSellableUnits: "4" }) });
  });

  it("shows a retired Show as out of stock rule as Max 0 and rewrites it as Max 0", () => {
    const head = skuRule(3, policyValue({ eligible: false }));
    const row = listChannelStockRules(view({ policyHeads: [channelDefault(3), head] }), sku)
      .find(candidate => candidate.channel.id === 3)!;
    expect(row.cells.maxPublish).toEqual({ display: "0", source: "sku" });
    expect(row.outOfStock).toBe(true);
    const input = stockRuleInputFor(head);
    expect(input).toMatchObject({ maxMode: "units", maxUnits: "0" });
    // Nothing typed, yet the rule must be saved again or the old flag would be applied.
    expect(needsStockRuleRewrite(head)).toBe(true);
    expect(stockRuleValue(input, head)).toEqual({ ok: true, value: policyValue({ maxPublish: { mode: "units", units: "0" } }) });
    expect(needsStockRuleRewrite(skuRule(3, policyValue({ maxPublish: { mode: "units", units: "0" } })))).toBe(false);
    expect(needsStockRuleRewrite(null)).toBe(false);
  });

  it("clears to 'follow the defaults' when every field is blank", () => {
    expect(stockRuleValue(EMPTY_STOCK_RULE_INPUT, skuRule(3, policyValue({ shareBps: 5000 }))))
      .toEqual({ ok: true, value: policyValue({ inheritAll: true }) });
  });

  it("rejects bad numbers and a Max with no number", () => {
    for (const input of [
      { ...EMPTY_STOCK_RULE_INPUT, sharePercent: "150" }, { ...EMPTY_STOCK_RULE_INPUT, bufferUnits: "-1" },
      { ...EMPTY_STOCK_RULE_INPUT, bufferUnits: "1.5" }, { ...EMPTY_STOCK_RULE_INPUT, hideBelowUnits: "abc" },
      { ...EMPTY_STOCK_RULE_INPUT, maxMode: "units" as const, maxUnits: "" },
    ]) expect(stockRuleValue(input, null).ok).toBe(false);
  });

  it("for all channels, writes only what was typed and keeps each channel's other values", () => {
    const current = { sharePercent: "50", bufferUnits: "2", maxMode: "unlimited" as const, maxUnits: "", hideBelowUnits: "" };
    expect(mergeStockRuleInput(current, { ...EMPTY_STOCK_RULE_INPUT, maxMode: "units", maxUnits: "0" }))
      .toEqual({ sharePercent: "50", bufferUnits: "2", maxMode: "units", maxUnits: "0", hideBelowUnits: "" });
    expect(mergeStockRuleInput(current, EMPTY_STOCK_RULE_INPUT)).toEqual(current);
    expect(mergeStockRuleInput(current, { ...EMPTY_STOCK_RULE_INPUT, hideBelowUnits: "5", sharePercent: " " }).sharePercent).toBe("50");
  });

  it("compares inputs ignoring spaces and a hidden max number", () => {
    expect(sameStockRuleInput({ ...EMPTY_STOCK_RULE_INPUT, bufferUnits: " 2 " }, { ...EMPTY_STOCK_RULE_INPUT, bufferUnits: "2" })).toBe(true);
    expect(sameStockRuleInput({ ...EMPTY_STOCK_RULE_INPUT, maxUnits: "9" }, EMPTY_STOCK_RULE_INPUT)).toBe(true);
    expect(sameStockRuleInput({ ...EMPTY_STOCK_RULE_INPUT, maxMode: "units", maxUnits: "9" }, { ...EMPTY_STOCK_RULE_INPUT, maxMode: "units", maxUnits: "8" })).toBe(false);
  });
});

describe("saving a rule so it takes effect", () => {
  const scope = stockRuleScope(3, sku);
  const value = policyValue({ maxPublish: { mode: "units", units: "0" } });
  const saved = { definitionId: 9, version: 2, definitionHash: HASH_B, headRevision: "5", alreadyApplied: false,
    runtimeAuthorityChanged: false as const, providerWriteAttempted: false as const };
  const selection = { scope, draftPolicyId: 9, expectedHeadRevision: "5", expectedDefinitionHash: HASH_B };
  const quantities = [{ targetId: 5, channelName: "Shopify US", variantId: 101, sku: "CARD-P5", current: "12", proposed: "0" }];
  const review = (ready = true) => ({ selection, reviewHash: HASH_A, ready, blockers: ready ? [] : ["Listing would be oversold."],
    quantities, skippedDestinations: [] }) as never;
  function steps(overrides: Partial<StockRuleSaveSteps> = {}) {
    let key = 0;
    const calls: string[] = [];
    const base: StockRuleSaveSteps = {
      save: vi.fn(async () => { calls.push("save"); return saved; }),
      review: vi.fn(async () => { calls.push("review"); return review(); }),
      apply: vi.fn(async () => { calls.push("apply"); return {} as never; }),
      newKey: () => `key-${key += 1}`,
      ...overrides,
    };
    return { steps: base, calls };
  }
  const row = { scope, head: null };

  it("saves, checks, then applies exactly the draft it just saved", async () => {
    const h = steps();
    await expect(saveAndApplyStockRule({ row, value, changed: true, note: " stop the case " }, h.steps))
      .resolves.toEqual({ status: "applied", quantities, skipped: [] });
    expect(h.calls).toEqual(["save", "review", "apply"]);
    expect(h.steps.save).toHaveBeenCalledWith(expect.objectContaining({ scope, value, expectedHeadRevision: "0",
      expectedDraftPolicyId: null, changeReason: "stop the case", idempotencyKey: "key-1" }));
    expect(h.steps.review).toHaveBeenCalledWith(selection);
    expect(h.steps.apply).toHaveBeenCalledWith({ ...selection, expectedReviewHash: HASH_A, idempotencyKey: "key-2" });
  });

  it("applies a change that was saved earlier but never applied, without saving again", async () => {
    const h = steps();
    const head = skuRule(3, value, true);
    await saveAndApplyStockRule({ row: { scope, head }, value, changed: false, note: "" }, h.steps);
    expect(h.calls).toEqual(["review", "apply"]);
    expect(h.steps.review).toHaveBeenCalledWith({ scope, draftPolicyId: 2, expectedHeadRevision: "4", expectedDefinitionHash: HASH_B });
  });

  it("does nothing when nothing changed and nothing is waiting", async () => {
    const h = steps();
    await expect(saveAndApplyStockRule({ row, value, changed: false, note: "" }, h.steps)).resolves.toEqual({ status: "unchanged" });
    expect(h.calls).toEqual([]);
  });

  it("does not apply a rule the check says would cause a problem", async () => {
    const h = steps({ review: vi.fn(async () => review(false)) });
    await expect(saveAndApplyStockRule({ row, value, changed: true, note: "" }, h.steps))
      .resolves.toEqual({ status: "blocked", blockers: ["Listing would be oversold."] });
    expect(h.steps.apply).not.toHaveBeenCalled();
  });

  it("reports a rejected save as not saved and stops", async () => {
    const h = steps({ save: vi.fn(async () => { throw new ChannelInventoryApiError(409, "CONFLICT", "This rule changed."); }) });
    await expect(saveAndApplyStockRule({ row, value, changed: true, note: "" }, h.steps))
      .resolves.toEqual({ status: "rejected", message: "This rule changed.", saved: false });
    expect(h.steps.review).not.toHaveBeenCalled();
  });

  it("reports a rejected apply as saved but not applied", async () => {
    const h = steps({ apply: vi.fn(async () => { throw new ChannelInventoryApiError(409, "CHANNEL_RULE_REVIEW_STALE", "Check the change again."); }) });
    await expect(saveAndApplyStockRule({ row, value, changed: true, note: "" }, h.steps))
      .resolves.toEqual({ status: "rejected", message: "Check the change again.", saved: true });
  });

  it("never claims success or failure when the network drops mid-request", async () => {
    for (const failing of ["save", "apply"] as const) {
      const h = steps({ [failing]: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) });
      const outcome = await saveAndApplyStockRule({ row, value, changed: true, note: "" }, h.steps);
      expect(outcome.status).toBe("unknown");
    }
    const timeout = steps({ apply: vi.fn(async () => { throw new ChannelInventoryApiError(504, "GATEWAY_TIMEOUT", "Gateway timeout"); }) });
    expect((await saveAndApplyStockRule({ row, value, changed: true, note: "" }, timeout.steps)).status).toBe("unknown");
  });

  it("treats a failed check as saved-not-applied, since a read changes nothing", async () => {
    const h = steps({ review: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) });
    const outcome = await saveAndApplyStockRule({ row, value, changed: true, note: "" }, h.steps);
    expect(outcome).toMatchObject({ status: "rejected", saved: true });
    expect(h.steps.apply).not.toHaveBeenCalled();
  });

  it("refuses to edit a channel default from this view", async () => {
    await expect(saveAndApplyStockRule({ row: { scope: { scopeType: "channel", channelId: 3 }, head: null }, value, changed: true, note: "" }, steps().steps))
      .rejects.toThrow();
  });

  it("describes each outcome in one plain line", () => {
    expect(describeStockRuleOutcome({ status: "applied", quantities, skipped: [] }, 101)).toBe("Applied. Shopify US 12 → 0.");
    expect(describeStockRuleOutcome({ status: "applied", quantities, skipped: [] }, 102)).toBe("Applied. No quantity changes right now.");
    expect(describeStockRuleOutcome({ status: "applied", quantities: [{ ...quantities[0], current: null }], skipped: [] }, null)).toBe("Applied. Shopify US ? → 0.");
    expect(describeStockRuleOutcome({ status: "unchanged" }, null)).toBe("No change.");
    expect(describeStockRuleOutcome({ status: "blocked", blockers: ["Reason."] }, null)).toBe("Saved but not applied: Reason.");
    expect(describeStockRuleOutcome({ status: "rejected", message: "Changed.", saved: false }, null)).toBe("Not saved: Changed.");
    expect(describeStockRuleOutcome({ status: "rejected", message: "Stale.", saved: true }, null)).toBe("Saved but not applied: Stale.");
  });
});
