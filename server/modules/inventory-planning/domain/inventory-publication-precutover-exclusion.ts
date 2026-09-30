import { z } from "zod";
import { inventoryCutoverEvidenceHash } from "./inventory-cutover-manifest";

const id = z.number().int().positive().max(2_147_483_647);
const revision = z.string().regex(/^[1-9][0-9]*$/)
  .refine(value => BigInt(value) < BigInt("9223372036854775807"));
const text = z.string().trim().min(1).max(240);
const observedAt = z.string().datetime();
const retainedListingEvidenceSchema = z.object({
  requestedItemId: text, observedAt, httpStatus: z.literal(200),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/),
  // Error 17 means deleted OR not owned by this seller. Preserve that distinction;
  // it does not certify that the listing never exists in another seller account.
  outcome: z.enum(["ended", "completed", "inaccessible_to_seller"]),
  errorCode: z.literal("17").nullable(),
}).strict();
/** Authenticated, exact-identity GET evidence supplied by the operator adapter.
 * This is not a public HTTP input or an assertion that remote stock is zero. */
export const nonLiveListingEvidenceSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("shopify"), observedAt,
    inventoryItemHttpStatus: z.literal(404) }).strict(),
  z.object({ provider: z.literal("ebay"), observedAt, offerHttpStatus: z.literal(200),
    offerId: text, status: z.literal("UNPUBLISHED"), listingId: text.nullable(),
    availableQuantity: z.number().int().nonnegative().safe(),
    retainedListingEvidence: retainedListingEvidenceSchema.optional() }).strict(),
]);
const exclusionSchema = z.object({
  publicationTargetId: id, expectedTargetRevision: revision,
  channelId: id, channelConnectionId: id,
  providerScopeType: z.enum(["account", "location"]), externalScopeId: text,
  productVariantId: id, externalInventoryItemId: text, externalSku: text.nullable(),
  evidence: nonLiveListingEvidenceSchema,
}).strict().superRefine((row, context) => {
  if (row.evidence.provider !== "ebay") return;
  const evidence = row.evidence;
  const retained = evidence.retainedListingEvidence;
  if (evidence.listingId === null ? retained !== undefined
    : !retained || retained.requestedItemId !== evidence.listingId
      || (retained.outcome === "inaccessible_to_seller") !== (retained.errorCode === "17")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence", "retainedListingEvidence"],
      message: "An unpublished offer retaining a listing ID requires exact seller-scoped non-live listing evidence." });
  }
});
export const reviewPrecutoverExclusionSchema = z.object({
  exclusions: z.array(exclusionSchema).min(1).max(100).refine(rows =>
    new Set(rows.map(row => `${row.publicationTargetId}:${row.productVariantId}`)).size === rows.length,
  "Duplicate publication target and SKU"),
  reason: z.string().trim().min(1).max(1000),
}).strict();
export const applyPrecutoverExclusionSchema = reviewPrecutoverExclusionSchema.extend({
  expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().trim().min(1).max(70),
}).strict();
export type ReviewPrecutoverExclusion = z.infer<typeof reviewPrecutoverExclusionSchema>;
export type ApplyPrecutoverExclusion = z.infer<typeof applyPrecutoverExclusionSchema>;
export const precutoverExclusionFactsSchema = z.object({
  authority: z.enum(["legacy", "canonical"]), authorityRevision: revision,
  configurationRunId: z.string().nullable(), frozen: z.boolean(), publicationSuppressed: z.boolean(),
  targets: z.array(z.object({
    id, revision, state: z.string(), mode: z.string(), authority: z.string(),
    destinationKind: z.string(), channelId: id, channelConnectionId: id.nullable(),
    provider: z.string(), providerScopeType: z.string(), externalScopeId: z.string(),
    pendingPublication: z.boolean(), initiallyPrepared: z.boolean(),
  }).strict()),
  members: z.array(z.object({
    publicationTargetId: id, productVariantId: id, sku: z.string(),
    versionId: revision, version: revision, included: z.boolean(),
    mappingId: revision, mappingHash: z.string(),
    externalInventoryItemId: z.string(), externalSku: z.string().nullable(),
  }).strict()),
}).strict();
export type PrecutoverExclusionFacts = z.infer<typeof precutoverExclusionFactsSchema>;
export interface PrecutoverExclusionReview {
  ready: boolean;
  reviewHash: string;
  blockers: string[];
  facts: PrecutoverExclusionFacts;
}
// Short-lived evidence is rechecked at apply; failures never become fake zero readbacks.
export const PRE_CUTOVER_PROVIDER_EVIDENCE_MAX_AGE_MS = 5 * 60 * 1000;
export function reviewPrecutoverExclusion(input: ReviewPrecutoverExclusion,
  rawFacts: PrecutoverExclusionFacts, now: Date): PrecutoverExclusionReview {
  const request = reviewPrecutoverExclusionSchema.parse(input);
  const facts = precutoverExclusionFactsSchema.parse(rawFacts);
  z.date().parse(now);
  const blockers = new Set<string>();
  if (facts.authority !== "legacy" || facts.configurationRunId !== null || facts.frozen || facts.publicationSuppressed)
    blockers.add("PRECUTOVER_EXCLUSION_AUTHORITY_UNAVAILABLE");
  for (const row of request.exclusions) {
    const target = facts.targets.find(target => target.id === row.publicationTargetId);
    const member = facts.members.find(member => member.publicationTargetId === row.publicationTargetId
      && member.productVariantId === row.productVariantId);
    if (!target || target.state !== "preview" || target.mode !== "explicit" || target.authority !== "echelon"
      || target.destinationKind !== "channel_connection" || !target.initiallyPrepared)
      blockers.add("PRECUTOVER_EXCLUSION_TARGET_UNAVAILABLE");
    if (!target || target.revision !== row.expectedTargetRevision || target.channelId !== row.channelId
      || target.channelConnectionId !== row.channelConnectionId || target.provider !== row.evidence.provider
      || target.providerScopeType !== row.providerScopeType || target.externalScopeId !== row.externalScopeId)
      blockers.add("PRECUTOVER_EXCLUSION_TARGET_CHANGED");
    if (target?.pendingPublication) blockers.add("PRECUTOVER_EXCLUSION_PUBLICATION_PENDING");
    if (!member?.included || member.externalInventoryItemId !== row.externalInventoryItemId
      || member.externalSku !== row.externalSku) blockers.add("PRECUTOVER_EXCLUSION_MAPPING_CHANGED");
    const age = now.getTime() - new Date(row.evidence.observedAt).getTime();
    if (age < 0 || age > PRE_CUTOVER_PROVIDER_EVIDENCE_MAX_AGE_MS)
      blockers.add("PRECUTOVER_EXCLUSION_PROVIDER_EVIDENCE_EXPIRED");
    if (row.evidence.provider === "ebay" && row.evidence.retainedListingEvidence) {
      const listingAge = now.getTime() - new Date(row.evidence.retainedListingEvidence.observedAt).getTime();
      if (listingAge < 0 || listingAge > PRE_CUTOVER_PROVIDER_EVIDENCE_MAX_AGE_MS)
        blockers.add("PRECUTOVER_EXCLUSION_PROVIDER_EVIDENCE_EXPIRED");
    }
  }
  const byPair = (a: { publicationTargetId: number; productVariantId: number },
    b: { publicationTargetId: number; productVariantId: number }) =>
    a.publicationTargetId - b.publicationTargetId || a.productVariantId - b.productVariantId;
  return { ready: blockers.size === 0, blockers: [...blockers].sort(), facts,
    reviewHash: inventoryCutoverEvidenceHash({ contractVersion: "precutover_listing_exclusion_v1",
      request: { ...request, exclusions: [...request.exclusions].sort(byPair) },
      facts: { ...facts, targets: [...facts.targets].sort((a, b) => a.id - b.id), members: [...facts.members].sort(byPair) } }) };
}
