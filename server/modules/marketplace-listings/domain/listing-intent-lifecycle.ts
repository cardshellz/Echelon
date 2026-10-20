import type { StockPublicationSelection } from "@shared/types/stock-publication-selection";
import type { ListingMemberRetirement } from "@shared/types/listing-member-lifecycle";
import { listingIntentLifecycleEvidenceSchema } from "@shared/listing-intent-lifecycle";
import type { IntentHandoff } from "./listing-intent-propagation";

export interface ListingIntentRemainingWork {
  productVariantId: number;
  state: "settled" | "pending" | "attention";
  code: string;
  message: string;
  references: string[];
}

/** Listing lifecycle owns disposition, not selection, quantities or provider execution.
 * A catalog exclusion is never proof that an existing remote obligation is done. */
export function resolveListingIntentLifecycle(input: {
  selection: StockPublicationSelection;
  accountId: string;
  retainedVariantIds: readonly number[];
  retirements: readonly ListingMemberRetirement[];
  stock: readonly ListingIntentRemainingWork[];
  pendingContent: boolean;
  now: Date;
}): IntentHandoff | null {
  const { selection } = input;
  // Mixed products still need their selected members sent to the existing owner.
  // Stock tracking, clearing and read-only preview are not content selection.
  // An omitted decision remains with the existing content admission owner.
  if (selection.variants.some((member) => member.listingSelected !== false))
    return null;
  if (!selection.variants.length)
    throw new Error(
      "Listing lifecycle requires an exact nonempty member scope.",
    );
  const evidence = listingIntentLifecycleEvidenceSchema.parse({
    assessedAt: input.now.toISOString(),
    selectionFingerprint: selection.fingerprint,
    members: selection.variants.map((member) => {
      const duty = member.catalogArchived
        ? "retirement"
        : member.action === "zero"
          ? "stock_clear"
          : "none";
      const base = { productVariantId: member.productVariantId, duty };
      if (member.blockers.length)
        return {
          ...base,
          state: "attention",
          code: member.blockers[0].code,
          message: member.blockers[0].message,
          references: [],
        };
      const outstanding = input.stock.find(
        (row) =>
          row.productVariantId === member.productVariantId &&
          row.state === "pending",
      );
      if (outstanding) return { ...base, ...outstanding };
      if (input.pendingContent)
        return {
          ...base,
          state: "pending",
          code: "LISTING_LIFECYCLE_PRIOR_WORK",
          message:
            "An earlier listing operation still needs completion or reconciliation in the listing workspace.",
          references: [],
        };
      if (member.catalogArchived) {
        const matching = input.retirements.filter(
          (row) => row.identity.productVariantId === member.productVariantId,
        );
        const retired = matching.length === 1 ? matching[0] : null;
        if (retired?.state === "retired" && retired.verifiedAt)
          return {
            ...base,
            state: "settled",
            code: "LISTING_LIFECYCLE_RETIREMENT_VERIFIED",
            message: "Removal of this archived member was verified.",
            references: [retired.operationId],
          };
        return {
          ...base,
          state: retired?.state === "failed" ? "attention" : "pending",
          code: retired?.code ?? "LISTING_LIFECYCLE_RETIREMENT_PENDING",
          message:
            retired?.message ??
            "The listing lifecycle must confirm removal of this archived member.",
          references: retired ? [retired.operationId] : [],
        };
      }
      if (member.action === "zero") {
        const work = input.stock.filter(
          (row) => row.productVariantId === member.productVariantId,
        );
        if (work.length === 1) return { ...base, ...work[0] };
        return {
          ...base,
          state: "attention",
          code: "LISTING_LIFECYCLE_CLEARING_UNPROVEN",
          message:
            "This excluded member still needs stock clearing. Review its stock connection; completion has not been verified.",
          references: [],
        };
      }
      if (
        (member.retirementEvidence &&
          member.retirementEvidence.externalAccountId !== input.accountId) ||
        (!member.retirementEvidence &&
          input.retainedVariantIds.includes(member.productVariantId))
      ) {
        return {
          ...base,
          state: "attention",
          code: "LISTING_LIFECYCLE_REMOVAL_UNPROVEN",
          message:
            "A saved channel identity remains, but removal has not been confirmed for this account. Review its listing status and connection.",
          references: [],
        };
      }
      return {
        ...base,
        state: "settled",
        code: "LISTING_LIFECYCLE_NO_DUTY",
        message: member.reason,
        references: member.retirementEvidence
          ? [member.retirementEvidence.operationId]
          : [],
      };
    }),
  });
  const settled = evidence.members.every(
    (member) => member.state === "settled",
  );
  return {
    state: settled ? "not_applicable" : "waiting_lifecycle",
    lifecycle: evidence,
    code: settled
      ? "LISTING_INTENT_NOT_SELECTED"
      : "LISTING_INTENT_LIFECYCLE_PENDING",
    message: settled
      ? "No content update is required for these excluded members. Their remaining channel obligations were verified complete at the recorded check."
      : "These members are excluded from content updates. Channel clearing or removal is still outstanding; automatic checks will continue. Open the listing workspace for the remaining work.",
  };
}
