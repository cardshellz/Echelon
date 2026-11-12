import { describe, expect, it, vi } from "vitest";

import { ChannelInventoryApiError } from "../api";
import {
  EMPTY_STOCK_RULE_INPUT, describeLastSent, describeStockRuleOutcome, discardPendingStockRule, hasPendingChange,
  listChannelStockRules, mergeStockRuleInput, needsStockRuleRewrite, sameRuleValue, sameStockRuleInput,
  saveAndApplyStockRule, stockRuleConflict, stockRuleInputFor, stockRuleScope, stockRuleValue, stopsSelling,
  type LastSentRow, type StockRuleSaveSteps,
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
    expect(shopify).toMatchObject({ managed: true, hasException: true, ruleSource: "sku", pending: false });
    const ebay = rows.find(row => row.channel.id === 4)!;
    expect(ebay.cells.shareBps).toEqual({ display: "90%", source: "channel" });
    expect(ebay.cells.maxPublish).toEqual({ display: "100", source: "channel" });
    expect(ebay).toMatchObject({ managed: true, hasException: false, ruleSource: "channel" });
  });

  it("marks a channel with no default as not managed instead of inventing values", () => {
    const amazon = listChannelStockRules(view({ policyHeads: [channelDefault(3)] }), sku).find(row => row.channel.id === 6)!;
    expect(amazon.managed).toBe(false);
    expect(amazon.cells.maxPublish).toEqual({ display: "Not set", source: "unset" });
    expect(amazon.ruleSource).toBe("unset");
  });

  it("reads the whole product without picking up a SKU rule, and skips inactive channels", () => {
    const base = view({ policyHeads: [channelDefault(3), skuRule(3, policyValue({ maxPublish: { mode: "units", units: "0" } }))] });
    const rows = listChannelStockRules({ ...base, channels: base.channels.map(channel => channel.id === 4 ? { ...channel, status: "inactive" } : channel) }, product);
    expect(rows.some(row => row.channel.id === 4)).toBe(false);
    expect(rows.find(row => row.channel.id === 3)).toMatchObject({ hasException: false, ruleSource: "channel" });
  });

  it("shows what is in effect, and reports a saved change that was never applied separately", () => {
    const pending = listChannelStockRules(view({ policyHeads: [channelDefault(3),
      skuRule(3, policyValue({ shareBps: 5000, maxPublish: { mode: "units", units: "0" } }), true)] }), sku)[0];
    // Nothing was applied: the channel still uses its default and the item is still selling.
    expect(pending.cells.shareBps).toEqual({ display: "100%", source: "channel" });
    expect(pending.cells.maxPublish).toEqual({ display: "No max", source: "channel" });
    expect(pending).toMatchObject({ pending: true, pendingChange: "Stock % 50%, Max 0", hasException: true, ruleSource: "channel" });
  });

  it("keeps showing the applied rule while a newer change to it waits", () => {
    const head = policyHead({ scopeKey: "channel:3:variant:101", channelId: 3, scope: stockRuleScope(3, sku),
      active: policyValue({ maxPublish: { mode: "units", units: "0" } }), draft: policyValue({ inheritAll: true }), revision: "5" });
    const row = listChannelStockRules(view({ policyHeads: [channelDefault(3), head] }), sku)[0];
    expect(row.cells.maxPublish).toEqual({ display: "0", source: "sku" });
    expect(row).toMatchObject({ ruleSource: "sku", pending: true, pendingChange: "Clear exception" });
  });

  it("does not show an unapplied whole-product rule as in effect on a SKU", () => {
    const productDraft = policyHead({ scopeKey: "channel:3:product:10", channelId: 3, scope: stockRuleScope(3, product),
      draft: policyValue({ maxPublish: { mode: "units", units: "0" } }) });
    const onSku = listChannelStockRules(view({ policyHeads: [channelDefault(3), productDraft] }), sku)[0];
    expect(onSku).toMatchObject({ ruleSource: "channel", pending: false, pendingChange: null });
    const onProduct = listChannelStockRules(view({ policyHeads: [channelDefault(3), productDraft] }), product)[0];
    expect(onProduct).toMatchObject({ ruleSource: "channel", pending: true, pendingChange: "Max 0" });
  });

  it("ignores a cleared rule and names an old out-of-stock draft as Max 0", () => {
    const cleared = listChannelStockRules(view({ policyHeads: [channelDefault(3), skuRule(3, policyValue({ inheritAll: true }))] }), sku)[0];
    expect(cleared).toMatchObject({ hasException: false, ruleSource: "channel", pending: false });
    expect(cleared.cells.shareBps.source).toBe("channel");
    const retired = listChannelStockRules(view({ policyHeads: [channelDefault(3), skuRule(3, policyValue({ eligible: false }), true)] }), sku)[0];
    expect(retired).toMatchObject({ pendingChange: "Max 0", ruleSource: "channel" });
  });

  it("names the product rule when it is the most specific one in use on a SKU", () => {
    const row = listChannelStockRules(view({ policyHeads: [channelDefault(3), productRule(3, policyValue({ holdbackSellableUnits: "5" }))] }), sku)[0];
    expect(row).toMatchObject({ ruleSource: "product", hasException: false });
  });

  it("does not report a saved version that changes nothing as a pending change", () => {
    const max0 = policyValue({ maxPublish: { mode: "units", units: "0" } });
    const applied = skuRule(3, max0);
    // The same rule saved again over the applied one. Its hash differs (the fixture gives
    // every saved version its own), which must not matter: the values are what count.
    const sameAgain = { ...applied, draftPolicy: skuRule(3, { ...max0, sourceFulfillmentNodeIds: null }, true).draftPolicy };
    expect(sameAgain.draftPolicy!.definitionHash).not.toBe(applied.activePolicy!.definitionHash);
    expect(hasPendingChange(sameAgain)).toBe(false);
    expect(listChannelStockRules(view({ policyHeads: [channelDefault(3), sameAgain] }), sku)[0])
      .toMatchObject({ pending: false, pendingChange: null, ruleSource: "sku", hasException: true });
    // "Use the default" saved where no rule is applied: also nothing.
    const nothing = skuRule(3, policyValue({ inheritAll: true }), true);
    expect(hasPendingChange(nothing)).toBe(false);
    expect(listChannelStockRules(view({ policyHeads: [channelDefault(3), nothing] }), sku)[0])
      .toMatchObject({ pending: false, hasException: false, ruleSource: "channel" });
    expect(hasPendingChange(skuRule(3, max0, true))).toBe(true);
    expect(hasPendingChange(applied)).toBe(false);
    expect(hasPendingChange(null)).toBe(false);
  });

  it("compares rule values by meaning, not by how they were written", () => {
    const base = policyValue({ shareBps: 5000, maxPublish: { mode: "units", units: "10" }, sourceFulfillmentNodeIds: [8, 7] });
    expect(sameRuleValue(base, { ...base, sourceFulfillmentNodeIds: [7, 8] })).toBe(true);
    expect(sameRuleValue(policyValue({ shareBps: 5000 }), { ...policyValue({ shareBps: 5000 }), sourceFulfillmentNodeIds: null })).toBe(true);
    expect(sameRuleValue(policyValue({ inheritAll: true }), policyValue({ inheritAll: true }))).toBe(true);
    for (const other of [
      policyValue({ shareBps: 4000, maxPublish: { mode: "units", units: "10" }, sourceFulfillmentNodeIds: [8, 7] }),
      { ...base, maxPublish: { mode: "units" as const, units: "11" } }, { ...base, maxPublish: { mode: "unlimited" as const } },
      { ...base, maxPublish: null }, { ...base, holdbackSellableUnits: "1" }, { ...base, minPublishSellableUnits: "1" },
      { ...base, eligible: false }, { ...base, allocationSemantics: "partitioned" as const }, { ...base, sourceFulfillmentNodeIds: [7] },
      policyValue({ inheritAll: true }),
    ]) expect(sameRuleValue(base, other)).toBe(false);
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

  it("rejects a Hide when below that a non-zero Max can never reach", () => {
    const result = stockRuleValue({ ...EMPTY_STOCK_RULE_INPUT, maxMode: "units", maxUnits: "5", hideBelowUnits: "10" }, null);
    expect(result).toEqual({ ok: false, errors: [{ field: "minPublishSellableUnits",
      message: "Hide when below (10) is more than Max (5), so this channel would always be sent 0. Lower it, or set Max to 0 to stop selling here." }] });
    // Equal is reachable; Max 0, no max and an inherited max or cutoff are not conflicts on this rule.
    expect(stockRuleValue({ ...EMPTY_STOCK_RULE_INPUT, maxMode: "units", maxUnits: "10", hideBelowUnits: "10" }, null).ok).toBe(true);
    expect(stockRuleConflict({ maxPublish: { mode: "units", units: "0" }, minPublishSellableUnits: "10" })).toBeNull();
    expect(stockRuleConflict({ maxPublish: { mode: "unlimited" }, minPublishSellableUnits: "10" })).toBeNull();
    expect(stockRuleConflict({ maxPublish: null, minPublishSellableUnits: "10" })).toBeNull();
    expect(stockRuleConflict({ maxPublish: { mode: "units", units: "5" }, minPublishSellableUnits: null })).toBeNull();
    // Compared as whole numbers, not text: 100 is not below 9.
    expect(stockRuleConflict({ maxPublish: { mode: "units", units: "100" }, minPublishSellableUnits: "9" })).toBeNull();
  });

  it("knows when the typed Max stops selling", () => {
    expect(stopsSelling({ maxMode: "units", maxUnits: " 0 " })).toBe(true);
    expect(stopsSelling({ maxMode: "units", maxUnits: "10" })).toBe(false);
    expect(stopsSelling({ maxMode: "units", maxUnits: "" })).toBe(false);
    expect(stopsSelling({ maxMode: "inherit", maxUnits: "0" })).toBe(false);
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
  const quantities = [{ targetId: 5, channelName: "Shopify US", variantId: 101, sku: "CARD-P5", current: "12", proposed: "0" }];
  const setResult = { receipt: {}, quantities, skippedDestinations: ["eBay: stock is not updating."], warnings: [] } as never;
  const blockedError = () => new ChannelInventoryApiError(409, "CHANNEL_RULE_REVIEW_BLOCKED",
    "This rule would create a problem, so it was not saved. Nothing changed.", ["Listing would be oversold."]);
  function steps(overrides: Partial<StockRuleSaveSteps> = {}) {
    let key = 0;
    const calls: string[] = [];
    const base: StockRuleSaveSteps = {
      set: vi.fn(async () => { calls.push("set"); return setResult; }),
      save: vi.fn(async () => { calls.push("save"); return saved; }),
      newKey: () => `key-${key += 1}`,
      ...overrides,
    };
    return { steps: base, calls };
  }
  const row = { scope, head: null };

  it("sends one command that saves and applies the rule", async () => {
    const h = steps();
    await expect(saveAndApplyStockRule({ row, value, changed: true, note: " stop the case " }, h.steps))
      .resolves.toEqual({ status: "applied", quantities, skipped: ["eBay: stock is not updating."] });
    expect(h.calls).toEqual(["set"]);
    expect(h.steps.set).toHaveBeenCalledWith({ scope, value, expectedHeadRevision: "0", expectedDraftPolicyId: null,
      expectedDraftDefinitionHash: null, changeReason: "stop the case", idempotencyKey: "key-1" });
  });

  it("fences the command on the rule the operator was looking at", async () => {
    const h = steps();
    await saveAndApplyStockRule({ row: { scope, head: skuRule(3, policyValue({ shareBps: 5000 })) }, value, changed: true, note: "" }, h.steps);
    expect(h.steps.set).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadRevision: "4", expectedDraftPolicyId: null,
      expectedDraftDefinitionHash: null, changeReason: null }));
  });

  it("replaces a change that was saved earlier but never applied", async () => {
    const h = steps();
    const earlier = skuRule(3, policyValue({ shareBps: 2500 }), true);
    await saveAndApplyStockRule({ row: { scope, head: earlier }, value, changed: true, note: "" }, h.steps);
    expect(h.steps.set).toHaveBeenCalledWith(expect.objectContaining({ value, expectedHeadRevision: "4",
      expectedDraftPolicyId: 2, expectedDraftDefinitionHash: HASH_B }));
  });

  it("applies a change that was saved earlier but never applied when nothing new was typed", async () => {
    const h = steps();
    const waiting = policyValue({ shareBps: 2500 });
    const head = skuRule(3, waiting, true);
    await expect(saveAndApplyStockRule({ row: { scope, head }, value, changed: false, note: "" }, h.steps))
      .resolves.toMatchObject({ status: "applied" });
    // Exactly the waiting change, not whatever the form holds.
    expect(h.steps.set).toHaveBeenCalledWith(expect.objectContaining({ value: waiting, expectedHeadRevision: "4",
      expectedDraftPolicyId: 2, expectedDraftDefinitionHash: HASH_B }));
    expect(h.steps.save).not.toHaveBeenCalled();
  });

  it("does nothing when nothing changed and nothing is waiting", async () => {
    const h = steps();
    await expect(saveAndApplyStockRule({ row, value, changed: false, note: "" }, h.steps)).resolves.toEqual({ status: "unchanged" });
    expect(h.calls).toEqual([]);
  });

  it("ignores a saved version that changes nothing instead of applying it", async () => {
    const h = steps();
    const head = skuRule(3, policyValue({ inheritAll: true }), true);
    await expect(saveAndApplyStockRule({ row: { scope, head }, value, changed: false, note: "" }, h.steps)).resolves.toEqual({ status: "unchanged" });
    expect(h.calls).toEqual([]);
  });

  it("reports the problems of a refused save and writes nothing more: the server saved nothing", async () => {
    const h = steps({ set: vi.fn(async () => { throw blockedError(); }) });
    await expect(saveAndApplyStockRule({ row, value, changed: true, note: "" }, h.steps))
      .resolves.toEqual({ status: "blocked", blockers: ["Listing would be oversold."], leftover: false });
    // No compensation: there is no half-saved rule to put back.
    expect(h.steps.set).toHaveBeenCalledTimes(1);
    expect(h.steps.save).not.toHaveBeenCalled();
  });

  it("falls back to the refusal's message when it lists no problems", async () => {
    const h = steps({ set: vi.fn(async () => { throw new ChannelInventoryApiError(409, "CHANNEL_RULE_REVIEW_BLOCKED", "Nothing changed."); }) });
    await expect(saveAndApplyStockRule({ row, value, changed: true, note: "" }, h.steps))
      .resolves.toEqual({ status: "blocked", blockers: ["Nothing changed."], leftover: false });
  });

  it("says an earlier saved change is still waiting after a refusal, without touching it", async () => {
    const earlier = skuRule(3, policyValue({ shareBps: 2500 }), true);
    const blocked = steps({ set: vi.fn(async () => { throw blockedError(); }) });
    await expect(saveAndApplyStockRule({ row: { scope, head: earlier }, value, changed: true, note: "" }, blocked.steps))
      .resolves.toMatchObject({ status: "blocked", leftover: true });
    expect(blocked.steps.save).not.toHaveBeenCalled();
    const stale = steps({ set: vi.fn(async () => { throw new ChannelInventoryApiError(409, "CONFLICT", "This rule changed."); }) });
    await expect(saveAndApplyStockRule({ row: { scope, head: earlier }, value: earlier.draftPolicy!.value, changed: false, note: "" }, stale.steps))
      .resolves.toEqual({ status: "rejected", message: "This rule changed.", leftover: true });
    expect(stale.steps.save).not.toHaveBeenCalled();
  });

  it("reports a rejected save as not saved", async () => {
    const h = steps({ set: vi.fn(async () => { throw new ChannelInventoryApiError(409, "INVENTORY_CHANNEL_EXPOSURE_STALE_POLICY_DRAFT", "This rule changed."); }) });
    await expect(saveAndApplyStockRule({ row, value, changed: true, note: "" }, h.steps))
      .resolves.toEqual({ status: "rejected", message: "This rule changed.", leftover: false });
    expect(h.steps.set).toHaveBeenCalledTimes(1);
  });

  it("never claims success or failure when the response is lost, and writes nothing more", async () => {
    const dropped = steps({ set: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) });
    expect((await saveAndApplyStockRule({ row, value, changed: true, note: "" }, dropped.steps)).status).toBe("unknown");
    const timeout = steps({ set: vi.fn(async () => { throw new ChannelInventoryApiError(504, "GATEWAY_TIMEOUT", "Gateway timeout"); }) });
    expect((await saveAndApplyStockRule({ row, value, changed: true, note: "" }, timeout.steps)).status).toBe("unknown");
    // Even a refusal code is not trusted on a 5xx: the command may have committed.
    const blockedOn500 = steps({ set: vi.fn(async () => { throw new ChannelInventoryApiError(500, "CHANNEL_RULE_REVIEW_BLOCKED", "?"); }) });
    expect((await saveAndApplyStockRule({ row, value, changed: true, note: "" }, blockedOn500.steps)).status).toBe("unknown");
    for (const h of [dropped, timeout, blockedOn500]) expect(h.steps.save).not.toHaveBeenCalled();
  });

  it("discards a leftover saved change without applying anything", async () => {
    const h = steps();
    const applied = skuRule(3, policyValue({ shareBps: 5000 }));
    const head = { ...applied, draftPolicy: skuRule(3, value, true).draftPolicy };
    await expect(discardPendingStockRule({ scope, head }, h.steps)).resolves.toEqual({ status: "undone" });
    expect(h.calls).toEqual(["save"]);
    expect(h.steps.save).toHaveBeenCalledWith(expect.objectContaining({ value: policyValue({ shareBps: 5000 }),
      expectedHeadRevision: "4", expectedDraftPolicyId: 2, expectedDraftDefinitionHash: HASH_B }));
    // No applied rule: the leftover is overwritten with "use the default".
    const alone = steps();
    await discardPendingStockRule({ scope, head: skuRule(3, value, true) }, alone.steps);
    expect(alone.steps.save).toHaveBeenCalledWith(expect.objectContaining({ value: policyValue({ inheritAll: true }) }));
  });

  it("has nothing to discard when nothing waits, and reports a failed discard", async () => {
    const h = steps();
    await expect(discardPendingStockRule({ scope, head: skuRule(3, value) }, h.steps)).resolves.toEqual({ status: "unchanged" });
    await expect(discardPendingStockRule({ scope, head: null }, h.steps)).resolves.toEqual({ status: "unchanged" });
    expect(h.calls).toEqual([]);
    const refused = steps({ save: vi.fn(async () => { throw new ChannelInventoryApiError(409, "CONFLICT", "This rule changed."); }) });
    await expect(discardPendingStockRule({ scope, head: skuRule(3, value, true) }, refused.steps))
      .resolves.toEqual({ status: "rejected", message: "This rule changed.", leftover: true });
    const dropped = steps({ save: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) });
    expect((await discardPendingStockRule({ scope, head: skuRule(3, value, true) }, dropped.steps)).status).toBe("unknown");
  });

  it("refuses to edit a channel default from this view", async () => {
    await expect(saveAndApplyStockRule({ row: { scope: { scopeType: "channel", channelId: 3 }, head: null }, value, changed: true, note: "" }, steps().steps))
      .rejects.toThrow();
  });

  it("describes each outcome in one plain line", () => {
    expect(describeStockRuleOutcome({ status: "applied", quantities, skipped: [] }, 101)).toBe("Saved. Shopify US 12 → 0.");
    expect(describeStockRuleOutcome({ status: "applied", quantities, skipped: [] }, 102)).toBe("Saved. The quantity sent does not change right now.");
    expect(describeStockRuleOutcome({ status: "applied", quantities: [{ ...quantities[0], current: null }], skipped: [] }, null)).toBe("Saved. Shopify US ? → 0.");
    expect(describeStockRuleOutcome({ status: "unchanged" }, null)).toBe("No change.");
    expect(describeStockRuleOutcome({ status: "undone" }, null)).toBe("Saved change discarded. Nothing changed on the channel.");
    expect(describeStockRuleOutcome({ status: "blocked", blockers: ["Reason."], leftover: false }, null)).toBe("Not saved. Reason.");
    expect(describeStockRuleOutcome({ status: "rejected", message: "Changed.", leftover: false }, null)).toBe("Not saved. Changed.");
    expect(describeStockRuleOutcome({ status: "rejected", message: "Stale.", leftover: true }, null))
      .toBe("Not saved. Stale. An earlier saved change is still waiting on this rule; open Edit to apply or discard it.");
  });
});

describe("the quantity a channel was last sent", () => {
  const at = "2026-10-28T14:00:00.000Z";
  const desired = (outboxId: string, quantity: string, state: NonNullable<LastSentRow["desired"]>["state"]) =>
    ({ outboxId, revision: outboxId, quantity, targetRevision: "1", state, createdAt: at });
  const listed = (overrides: Partial<LastSentRow> = {}): LastSentRow => ({
    productVariantId: 101, activeInventoryItemId: "item-1", desired: desired("7", "100", "verified"),
    acknowledged: { outboxId: "7", quantity: "100", acknowledgedAt: at }, observed: null, ...overrides,
  });

  it("shows the accepted quantity and when it was accepted", () => {
    expect(describeLastSent(listed())).toEqual({ primary: "100", detail: null, at, tone: "normal" });
    expect(describeLastSent(listed({ acknowledged: { outboxId: "7", quantity: "6059", acknowledgedAt: at } })).primary).toBe("6,059");
    expect(describeLastSent(listed({ acknowledged: { outboxId: "7", quantity: "0", acknowledgedAt: at } })).primary).toBe("0");
  });

  it("says not listed when the SKU has no listing on the destination", () => {
    expect(describeLastSent(undefined)).toEqual({ primary: "Not listed", detail: null, at: null, tone: "muted" });
    expect(describeLastSent(listed({ activeInventoryItemId: null }))).toMatchObject({ primary: "Not listed" });
  });

  it("says never sent when a listed SKU has no accepted send", () => {
    expect(describeLastSent(listed({ desired: null, acknowledged: null }))).toEqual({ primary: "Never sent", detail: null, at: null, tone: "muted" });
  });

  it("keeps the accepted quantity while a newer one is on its way", () => {
    expect(describeLastSent(listed({ desired: desired("8", "95", "queued") })))
      .toEqual({ primary: "100", detail: "Sending 95 now", at, tone: "normal" });
    expect(describeLastSent(listed({ desired: desired("8", "95", "queued"), acknowledged: null })))
      .toEqual({ primary: "Never sent", detail: "Sending 95 now", at: null, tone: "normal" });
  });

  it("flags a newer send that failed, without hiding what the channel last accepted", () => {
    expect(describeLastSent(listed({ desired: desired("8", "95", "dead_letter") })))
      .toEqual({ primary: "100", detail: "Sending 95 failed", at, tone: "problem" });
  });

  it("does not report a replaced or cancelled newer request as in progress", () => {
    expect(describeLastSent(listed({ desired: desired("8", "95", "cancelled") }))).toEqual({ primary: "100", detail: null, at, tone: "normal" });
  });
});
