import { describe, expect, it, vi } from "vitest";
import type { ChannelRuleCopyResult } from "@shared/types/inventory-channel-rule";

import { ChannelInventoryApiError } from "../api";
import { copySources, copyStockRules, describeCopyOutcome, hasNoStockRules } from "../copy-stock-rules";
import { policyHead, policyValue, HASH_A } from "./fixtures";

const defaults = policyValue({ allocationSemantics: "exposure", eligible: true, shareBps: 10_000,
  holdbackSellableUnits: "0", maxPublish: { mode: "unlimited" }, minPublishSellableUnits: "0" });
const channelDefault = (channelId: number, state: "active" | "draft") => policyHead({ scopeKey: `channel:${channelId}`, channelId,
  scope: { scopeType: "channel", channelId }, active: state === "active" ? defaults : null, draft: state === "draft" ? defaults : null });
const exception = (channelId: number) => policyHead({ scopeKey: `channel:${channelId}:variant:101`, channelId,
  scope: { scopeType: "variant", channelId, productId: 10, productVariantId: 101 }, active: policyValue({ maxPublish: { mode: "units", units: "0" } }) });
const channels = [{ id: 3, name: "Shopify" }, { id: 4, name: "eBay" }, { id: 6, name: "Amazon" }, { id: 7, name: "Walmart" }];
const result = (overrides: Partial<ChannelRuleCopyResult> = {}): ChannelRuleCopyResult => ({
  receipt: { channelId: 7, appliedAt: "2026-11-12T12:00:00.000Z", appliedBy: "operator-1", reviewHash: HASH_A,
    publicationIds: [], changedDefinitions: 1, alreadyApplied: false },
  sourceChannelId: 3, sourceChannelName: "Shopify", targetChannelName: "Walmart", copiedExceptions: 0,
  skippedRules: [], changedQuantities: 0, skippedDestinations: [], warnings: [], ...overrides,
});

describe("which channels can give and receive a copy", () => {
  // Shopify: default and an exception in effect. eBay: a default saved but never applied. Amazon: only an exception. Walmart: nothing.
  const heads = [channelDefault(3, "active"), exception(3), channelDefault(4, "draft"), exception(6)];

  it("offers only channels whose default is in effect, and never the channel being copied to", () => {
    expect(copySources(channels, heads, 7).map(channel => channel.name)).toEqual(["Shopify"]);
    expect(copySources(channels, heads, 3)).toEqual([]);
    expect(copySources(channels, heads, null).map(channel => channel.name)).toEqual(["Shopify"]);
    expect(copySources(channels, [], 7)).toEqual([]);
  });

  it("lets only a channel with no rule of any kind receive one", () => {
    expect(hasNoStockRules(heads, 7)).toBe(true);
    expect(hasNoStockRules(heads, 3)).toBe(false);
    // A saved-but-unapplied default and a lone exception are both decisions a copy must not overwrite.
    expect(hasNoStockRules(heads, 4)).toBe(false);
    expect(hasNoStockRules(heads, 6)).toBe(false);
  });
});

describe("copying", () => {
  const input = { sourceChannelId: 3, targetChannelId: 7, idempotencyKey: "key-1" };

  it("sends one command with the two channels and the retry key", async () => {
    const send = vi.fn(async () => result());
    await expect(copyStockRules(input, send)).resolves.toEqual({ status: "copied", result: result() });
    expect(send).toHaveBeenCalledWith({ sourceChannelId: 3, targetChannelId: 7, idempotencyKey: "key-1" });
  });

  it("reports a refusal as not copied, with the server's reasons", async () => {
    const send = vi.fn(async () => { throw new ChannelInventoryApiError(409, "CHANNEL_RULE_COPY_BLOCKED", "Nothing was copied.", ["eBay / P5: over-allocated."]); });
    await expect(copyStockRules(input, send)).resolves.toEqual({ status: "rejected", message: "Nothing was copied.", details: ["eBay / P5: over-allocated."] });
  });

  it("never claims success or failure when the response is lost or the server times out", async () => {
    for (const error of [new TypeError("Failed to fetch"), new ChannelInventoryApiError(504, "GATEWAY_TIMEOUT", "Gateway timeout"),
      new ChannelInventoryApiError(500, "CHANNEL_RULE_RESULT_INVALID", "Not confirmed")]) {
      expect((await copyStockRules(input, vi.fn(async () => { throw error; }))).status).toBe("unknown");
    }
  });

  it("describes each outcome in plain words", () => {
    expect(describeCopyOutcome({ status: "copied", result: result() }))
      .toBe("Copied the default from Shopify to Walmart. No quantity sent to a channel changes right now.");
    expect(describeCopyOutcome({ status: "copied", result: result({ copiedExceptions: 1, changedQuantities: 1 }) }))
      .toBe("Copied the default and 1 exception from Shopify to Walmart. 1 quantity sent to channels changed.");
    expect(describeCopyOutcome({ status: "copied", result: result({ copiedExceptions: 12, changedQuantities: 1_240,
      skippedRules: ["OLD-SKU: no longer sold, so its rule was not copied."], skippedDestinations: ["Walmart: listing not linked"] }) }))
      .toBe("Copied the default and 12 exceptions from Shopify to Walmart. 1,240 quantities sent to channels changed. "
        + "Not copied: OLD-SKU: no longer sold, so its rule was not copied. 1 destination was skipped.");
    expect(describeCopyOutcome({ status: "copied", result: result({ skippedRules: ["a.", "b.", "c.", "d.", "e."] }) }))
      .toContain("Not copied: a. b. c. And 2 more.");
    expect(describeCopyOutcome({ status: "rejected", message: "Walmart already has stock rules, so nothing was copied.", details: [] }))
      .toBe("Not copied. Walmart already has stock rules, so nothing was copied.");
    expect(describeCopyOutcome({ status: "rejected", message: "Nothing was copied.", details: ["a.", "b.", "c.", "d."] }))
      .toBe("Not copied. Nothing was copied. a. b. c. And 1 more.");
    expect(describeCopyOutcome({ status: "unknown", message: "The outcome is unknown." })).toBe("The outcome is unknown.");
  });
});
