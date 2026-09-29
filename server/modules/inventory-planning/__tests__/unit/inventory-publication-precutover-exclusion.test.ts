import { describe, expect, it } from "vitest";
import { reviewPrecutoverExclusion, reviewPrecutoverExclusionSchema,
  type PrecutoverExclusionFacts, type ReviewPrecutoverExclusion } from "../../domain/inventory-publication-precutover-exclusion";

const now = new Date("2026-09-29T23:00:00.000Z");
const input = (): ReviewPrecutoverExclusion => ({ reason: "Exclude the confirmed absent channel listing.", exclusions: [{
  publicationTargetId: 1, expectedTargetRevision: "3", channelId: 36, channelConnectionId: 4,
  providerScopeType: "location", externalScopeId: "location", productVariantId: 101,
  externalInventoryItemId: "missing-item", externalSku: "P5",
  evidence: { provider: "shopify", observedAt: now.toISOString(), inventoryItemHttpStatus: 404 },
}] });
const facts = (): PrecutoverExclusionFacts => ({ authority: "legacy", authorityRevision: "1",
  configurationRunId: null, frozen: false, publicationSuppressed: false,
  targets: [{ id: 1, revision: "3", state: "preview", mode: "explicit", authority: "echelon",
    destinationKind: "channel_connection", channelId: 36, channelConnectionId: 4, provider: "shopify",
    providerScopeType: "location", externalScopeId: "location", pendingPublication: false, initiallyPrepared: true }],
  members: [{ publicationTargetId: 1, productVariantId: 101, sku: "P5", versionId: "1", version: "1",
    included: true, mappingId: "1", mappingHash: "a".repeat(64), externalInventoryItemId: "missing-item", externalSku: "P5" }],
});
describe("pre-cutover non-live listing exclusion", () => {
  it("accepts an exact absent Shopify item without inventing a zero acknowledgement", () => {
    const request = input(); const state = facts();
    const before = structuredClone({ request, state });
    expect(reviewPrecutoverExclusion(request, state, now)).toMatchObject({ ready: true, blockers: [] });
    expect({ request, state }).toEqual(before);
  });
  it("accepts an exact unpublished eBay offer without treating it as a live listing", () => {
    const request = input(); const state = facts();
    request.exclusions[0]!.evidence = { provider: "ebay", observedAt: now.toISOString(), offerHttpStatus: 200,
      offerId: "offer", status: "UNPUBLISHED", listingId: null, availableQuantity: 0 };
    state.targets[0]!.provider = "ebay";
    expect(reviewPrecutoverExclusion(request, state, now).ready).toBe(true);
  });
  it.each([
    ["canonical authority", (state: PrecutoverExclusionFacts) => { state.authority = "canonical"; }],
    ["activation owner", (state: PrecutoverExclusionFacts) => { state.configurationRunId = "42"; }],
    ["configuration freeze", (state: PrecutoverExclusionFacts) => { state.frozen = true; }],
    ["publication suppression", (state: PrecutoverExclusionFacts) => { state.publicationSuppressed = true; }],
    ["live target", (state: PrecutoverExclusionFacts) => { state.targets[0]!.state = "live"; }],
    ["disabled target", (state: PrecutoverExclusionFacts) => { state.targets[0]!.state = "disabled"; }],
    ["external ownership", (state: PrecutoverExclusionFacts) => { state.targets[0]!.authority = "external_provider"; }],
    ["wrong account", (state: PrecutoverExclusionFacts) => { state.targets[0]!.channelConnectionId = 9; }],
    ["wrong location", (state: PrecutoverExclusionFacts) => { state.targets[0]!.externalScopeId = "other"; }],
    ["target revision", (state: PrecutoverExclusionFacts) => { state.targets[0]!.revision = "4"; }],
    ["pending publication", (state: PrecutoverExclusionFacts) => { state.targets[0]!.pendingPublication = true; }],
    ["unprepared membership", (state: PrecutoverExclusionFacts) => { state.targets[0]!.initiallyPrepared = false; }],
    ["missing member", (state: PrecutoverExclusionFacts) => { state.members = []; }],
    ["already excluded", (state: PrecutoverExclusionFacts) => { state.members[0]!.included = false; }],
    ["different mapping", (state: PrecutoverExclusionFacts) => { state.members[0]!.externalInventoryItemId = "other"; }],
  ])("rejects %s", (_name, mutate) => {
    const state = facts(); mutate(state);
    expect(reviewPrecutoverExclusion(input(), state, now).ready).toBe(false);
  });
  it.each([-1, 300_001])("rejects provider evidence with age %s milliseconds", age => {
    const request = input(); request.exclusions[0]!.evidence.observedAt = new Date(now.getTime() - age).toISOString();
    expect(reviewPrecutoverExclusion(request, facts(), now).blockers).toContain("PRECUTOVER_EXCLUSION_PROVIDER_EVIDENCE_EXPIRED");
  });
  it("rejects generic errors, live offers, duplicate SKUs and unknown input", () => {
    const request = input();
    expect(reviewPrecutoverExclusionSchema.safeParse({ ...request, exclusions: [request.exclusions[0], request.exclusions[0]] }).success).toBe(false);
    expect(reviewPrecutoverExclusionSchema.safeParse({ ...request, force: true }).success).toBe(false);
    expect(reviewPrecutoverExclusionSchema.safeParse({ ...request, exclusions: [{ ...request.exclusions[0],
      evidence: { ...request.exclusions[0]!.evidence, inventoryItemHttpStatus: 500 } }] }).success).toBe(false);
    expect(reviewPrecutoverExclusionSchema.safeParse({ ...request, exclusions: [{ ...request.exclusions[0],
      evidence: { provider: "ebay", observedAt: now.toISOString(), offerHttpStatus: 200, offerId: "offer",
        status: "PUBLISHED", listingId: "live-listing", availableQuantity: 0 } }] }).success).toBe(false);
  });
  it("binds the selected membership version and provider evidence into the review", () => {
    const original = reviewPrecutoverExclusion(input(), facts(), now).reviewHash;
    const state = facts(); state.members[0]!.versionId = "2";
    expect(reviewPrecutoverExclusion(input(), state, now).reviewHash).not.toBe(original);
    const request = input(); request.exclusions[0]!.evidence.observedAt = new Date(now.getTime() - 1).toISOString();
    expect(reviewPrecutoverExclusion(request, facts(), now).reviewHash).not.toBe(original);
  });
});
