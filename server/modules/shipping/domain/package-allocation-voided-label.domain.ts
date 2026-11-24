import { z } from "zod";
import { projectPersistedDeclaredPackageLifecycleShadow, type PersistedDeclaredPackageEvidence } from "./declared-package-lifecycle-shadow.domain";

/** Facts read in the same transaction as label history, never inferred from a void alone. */
export const voidedLabelPostingFactsSchema = z.object({
  shippingProviderLabelId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  provider: z.literal("shipstation"),
  providerPhysicalShipmentId: z.string().min(1).max(200),
  trackingNumber: z.string().min(1).max(200),
  hasOrderScope: z.boolean(),
  hasAllocationBinding: z.boolean(),
  hasPhysicalPackage: z.boolean(),
  hasLegacyPackage: z.boolean(),
  hasChannelCommand: z.boolean(),
  hasChannelReceipt: z.boolean(),
}).strict();

export type VoidedLabelPostingFacts = z.infer<typeof voidedLabelPostingFactsSchema>;

export const voidedLabelExclusionEvidenceSchema = z.object({
  evidenceKey: z.string().regex(/^shipping-provider-label:[1-9]\d*$/),
  reason: z.literal("voided_without_posting_or_allocation"),
  lifecycleEvidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  postingFacts: voidedLabelPostingFactsSchema,
}).strict().superRefine((evidence, context) => {
  const facts = evidence.postingFacts;
  if (evidence.evidenceKey !== `shipping-provider-label:${facts.shippingProviderLabelId}`
    || !facts.hasOrderScope || facts.hasAllocationBinding || facts.hasPhysicalPackage
    || facts.hasLegacyPackage || facts.hasChannelCommand || facts.hasChannelReceipt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Voided label exclusion requires matching identity and absence of prior posting/allocation" });
  }
});
export type VoidedLabelExclusionEvidence = z.infer<typeof voidedLabelExclusionEvidenceSchema>;

/**
 * A retired label is still audit history, but is not another package to fulfill.
 * Missing/invalid footprint evidence, any prior posting/binding, or carrier
 * possession keeps it in the existing reconciliation path. A previous planner
 * binding must also be retained by the caller, even if these facts say otherwise.
 */
export function assessVoidedLabelExclusion(
  evidenceKey: string,
  persisted: PersistedDeclaredPackageEvidence,
  rawPostingFacts: unknown,
): VoidedLabelExclusionEvidence | null {
  const factsResult = voidedLabelPostingFactsSchema.safeParse(rawPostingFacts);
  if (!factsResult.success) return null;
  const facts = factsResult.data;
  if (evidenceKey !== `shipping-provider-label:${persisted.shippingProviderLabelId}`
    || facts.shippingProviderLabelId !== persisted.shippingProviderLabelId
    || facts.provider !== persisted.provider
    || facts.providerPhysicalShipmentId !== persisted.providerPhysicalShipmentId
    || facts.trackingNumber !== persisted.currentTrackingNumber
    || !facts.hasOrderScope || facts.hasAllocationBinding || facts.hasPhysicalPackage
    || facts.hasLegacyPackage || facts.hasChannelCommand || facts.hasChannelReceipt) return null;

  const result = projectPersistedDeclaredPackageLifecycleShadow(persisted);
  if (result.outcome !== "projected" || result.evidenceCoverage !== "current_flow") return null;
  const projection = result.projection;
  if (projection.labelStatus !== "voided" || projection.labelVoidedProviderOccurredAt === null
    || projection.carrierStatus !== "not_confirmed" || projection.disposition !== "not_dispatched") return null;
  // This exception is about obsolete contents only, not unrelated lifecycle errors.
  if (projection.reviewReasons.some(reason => ![
    "conflicting_package_contents", "package_contents_not_observed",
    "package_contents_omitted", "package_contents_empty", "package_contents_unrecognized",
    "package_contents_malformed", "package_contents_mixed",
  ].includes(reason))) return null;

  return Object.freeze({
    evidenceKey,
    reason: "voided_without_posting_or_allocation" as const,
    lifecycleEvidenceHash: projection.evidenceHash,
    postingFacts: Object.freeze(facts),
  });
}
