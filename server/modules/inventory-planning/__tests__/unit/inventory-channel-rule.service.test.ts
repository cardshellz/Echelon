import { describe, expect, it, vi } from "vitest";
import { ChannelRuleService, type ChannelRuleStore } from "../../application/inventory-channel-rule.service";
import { inventoryCutoverEvidenceHash } from "../../domain/inventory-cutover-manifest";
import { channelRuleReviewSchema } from "@shared/types/inventory-channel-rule";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const scope = { scopeType: "variant" as const, channelId: 36, productId: 11, productVariantId: 22 };
const selection = { scope, draftPolicyId: 900, expectedHeadRevision: "1", expectedDefinitionHash: HASH_B };
const command = { ...selection, expectedReviewHash: HASH_A, idempotencyKey: "apply-one-rule" };
const receipt = { channelId: 36, appliedAt: "2026-11-07T12:00:00.000Z", appliedBy: "operator", reviewHash: HASH_A,
  publicationIds: ["41"], changedDefinitions: 1, alreadyApplied: false, scopeKey: "channel:36:variant:22", productId: 11, policyId: 900 };
const review = { selection, scopeKey: "channel:36:variant:22", channelId: 36, channelName: "Shopify", productId: 11,
  authorityRevision: "2", activationRunId: "46", reviewHash: HASH_A, ready: true, blockers: [], warnings: [], skippedDestinations: [],
  change: { selection: { kind: "channel_policy" as const, key: "channel:36:variant:22", definitionId: 900, definitionHash: HASH_B },
    headRevision: "1", label: "SHLZ-TOP-40PT-BLU-C1000", before: null, after: { eligible: false } },
  quantities: [{ targetId: 1, channelName: "Shopify", variantId: 22, sku: "SHLZ-TOP-40PT-BLU-C1000", current: "153", proposed: "0" }] };

function fixture() {
  const store = { review: vi.fn<ChannelRuleStore["review"]>(), apply: vi.fn<ChannelRuleStore["apply"]>(),
    progress: vi.fn<ChannelRuleStore["progress"]>(async () => null) } satisfies ChannelRuleStore;
  const service = new ChannelRuleService(store, { now: () => new Date("2026-11-07T12:00:00.000Z") });
  return { store, service };
}

describe("single channel rule boundary", () => {
  it("rejects channel defaults, extra fields and malformed identities before the store", async () => {
    const { store, service } = fixture();
    await expect(service.review({ ...selection, scope: { scopeType: "channel", channelId: 36 } })).rejects.toThrow();
    await expect(service.review({ ...selection, activate: true })).rejects.toThrow();
    await expect(service.review({ ...selection, draftPolicyId: 0 })).rejects.toThrow();
    await expect(service.review({ ...selection, expectedDefinitionHash: "not-a-hash" })).rejects.toThrow();
    await expect(service.review({ ...selection, scope: { ...scope, productVariantId: undefined } })).rejects.toThrow();
    expect(store.review).not.toHaveBeenCalled();
  });

  it("pins the actor, kind and injected time so a retry is the same logical command", async () => {
    const { store, service } = fixture();
    store.apply.mockResolvedValue(receipt);
    await service.apply(command, "operator");
    await service.apply(command, "operator");
    expect(store.apply.mock.calls[1]).toEqual(store.apply.mock.calls[0]);
    expect(store.apply.mock.calls[0][2]).toBe(inventoryCutoverEvidenceHash({ kind: "channel_rule", command, actor: "operator" }));
    expect(store.apply.mock.calls[0][3]).toEqual(new Date("2026-11-07T12:00:00.000Z"));
    await service.apply(command, "other-operator");
    expect(store.apply.mock.calls[2][2]).not.toBe(store.apply.mock.calls[0][2]);
  });

  it("never matches a whole-channel command that reused the same retry key", async () => {
    const { store, service } = fixture();
    store.apply.mockResolvedValue(receipt);
    await service.apply(command, "operator");
    const channelCommand = { channelId: 36, expectedReviewHash: HASH_A, idempotencyKey: command.idempotencyKey };
    expect(store.apply.mock.calls[0][2]).not.toBe(inventoryCutoverEvidenceHash({ command: channelCommand, actor: "operator" }));
  });

  it("requires an authenticated actor", async () => {
    const { store, service } = fixture();
    await expect(service.apply(command, " ")).rejects.toThrow();
    await expect(service.apply(command, undefined)).rejects.toThrow();
    expect(store.apply).not.toHaveBeenCalled();
  });

  it("treats a malformed review or receipt as an unverified server result, not success", async () => {
    const { store, service } = fixture();
    store.review.mockResolvedValue({ ready: true } as never);
    await expect(service.review(selection)).rejects.toMatchObject({ code: "CHANNEL_RULE_RESULT_INVALID", status: 500 });
    store.apply.mockResolvedValue({ ...receipt, scopeKey: "channel:36" } as never);
    await expect(service.apply(command, "operator")).rejects.toMatchObject({ code: "CHANNEL_RULE_RESULT_INVALID", status: 500 });
  });

  it("returns a valid review unchanged", async () => {
    const { store, service } = fixture();
    store.review.mockResolvedValue(review);
    await expect(service.review(selection)).resolves.toEqual(review);
  });

  it("reads progress only for product or SKU rule keys", async () => {
    const { store, service } = fixture();
    await expect(service.progress("channel:36:variant:22")).resolves.toBeNull();
    expect(store.progress).toHaveBeenCalledWith("channel:36:variant:22");
    for (const key of ["channel:36", "channel:0:variant:22", "channel:36:variant:22;DROP", undefined]) {
      await expect(service.progress(key)).rejects.toThrow();
    }
  });
});

describe("single channel rule review contract", () => {
  it("requires readiness to match the blockers", () => {
    expect(channelRuleReviewSchema.safeParse(review).success).toBe(true);
    expect(channelRuleReviewSchema.safeParse({ ...review, blockers: ["Shopify / C1000: new problem"] }).success).toBe(false);
    expect(channelRuleReviewSchema.safeParse({ ...review, ready: false, blockers: ["Shopify / C1000: new problem"] }).success).toBe(true);
  });

  it("requires the reviewed change to be exactly the selected draft and scope", () => {
    expect(channelRuleReviewSchema.safeParse({ ...review, change: { ...review.change,
      selection: { ...review.change.selection, definitionId: 901 } } }).success).toBe(false);
    expect(channelRuleReviewSchema.safeParse({ ...review, change: { ...review.change,
      selection: { ...review.change.selection, key: "channel:67:variant:22" } } }).success).toBe(false);
    expect(channelRuleReviewSchema.safeParse({ ...review, scopeKey: "channel:36:product:11" }).success).toBe(false);
    expect(channelRuleReviewSchema.safeParse({ ...review, productId: 12 }).success).toBe(false);
  });

  it("rejects duplicate destination/SKU rows and fractional or negative quantities", () => {
    expect(channelRuleReviewSchema.safeParse({ ...review, quantities: [...review.quantities, review.quantities[0]] }).success).toBe(false);
    for (const proposed of ["-1", "1.5", "01"]) {
      expect(channelRuleReviewSchema.safeParse({ ...review, quantities: [{ ...review.quantities[0], proposed }] }).success).toBe(false);
    }
  });
});
