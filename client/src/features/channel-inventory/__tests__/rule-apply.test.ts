import { describe, expect, it } from "vitest";

import { buildApplyRuleCommand, ruleSelectionFor, splitRuleQuantities, summarizeRuleDelivery } from "../rule-apply";
import { HASH_A, HASH_B, policyHead, policyValue } from "./fixtures";

const scope = { scopeType: "variant" as const, channelId: 3, productId: 10, productVariantId: 101 };

describe("applying one saved channel rule", () => {
  it("pins the exact saved draft and head revision the operator is looking at", () => {
    const head = policyHead({ scopeKey: "channel:3:variant:101", channelId: 3, scope,
      active: policyValue({ shareBps: 5000 }), draft: policyValue({ eligible: false }), revision: "4" });
    expect(ruleSelectionFor(scope, head)).toEqual({ scope, draftPolicyId: 2, expectedHeadRevision: "4", expectedDefinitionHash: HASH_B });
  });

  it("has nothing to apply without a saved draft, and never applies a channel default here", () => {
    expect(ruleSelectionFor(scope, null)).toBeNull();
    expect(ruleSelectionFor(scope, policyHead({ scopeKey: "channel:3:variant:101", channelId: 3, scope, active: policyValue({ eligible: false }) }))).toBeNull();
    const channelScope = { scopeType: "channel" as const, channelId: 3 };
    expect(ruleSelectionFor(channelScope, policyHead({ scopeKey: "channel:3", channelId: 3, scope: channelScope, draft: policyValue({ shareBps: 1 }) }))).toBeNull();
  });

  it("builds one command from the reviewed hash and keeps the given retry key", () => {
    const selection = { scope, draftPolicyId: 2, expectedHeadRevision: "4", expectedDefinitionHash: HASH_B };
    expect(buildApplyRuleCommand({ selection, reviewHash: HASH_A }, "key-1"))
      .toEqual({ ...selection, expectedReviewHash: HASH_A, idempotencyKey: "key-1" });
    expect(() => buildApplyRuleCommand({ selection, reviewHash: "short" }, "key-1")).toThrow();
  });

  it("lists moving quantities first and keeps unchanged ones available", () => {
    const row = (targetId: number, current: string | null, proposed: string) => ({ targetId, channelName: "Shopify", variantId: 101, sku: "CARD-P5", current, proposed });
    const result = splitRuleQuantities({ quantities: [row(5, "60", "0"), row(6, "60", "60"), row(7, null, "0")] });
    expect(result.changed.map(item => item.targetId)).toEqual([5, 7]);
    expect(result.unchanged.map(item => item.targetId)).toEqual([6]);
  });

  it("summarizes delivery: confirmed, still in flight, and needing attention", () => {
    const publication = (state: "verified" | "queued" | "dead_letter") => ({ id: "1", targetId: 5, variantId: 101, state, desiredQuantity: "0", errorCode: null });
    expect(summarizeRuleDelivery({ publications: [publication("verified"), publication("queued")] }))
      .toEqual({ total: 2, confirmed: 1, inFlight: true, needsAttention: false });
    expect(summarizeRuleDelivery({ publications: [publication("dead_letter")] }))
      .toEqual({ total: 1, confirmed: 0, inFlight: false, needsAttention: true });
  });
});
