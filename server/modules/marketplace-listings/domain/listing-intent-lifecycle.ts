import type { ListingWorkAction } from "@shared/listing-work-action";
import type { StockPublicationSelection } from "@shared/types/stock-publication-selection";
import type { ListingMemberRetirement } from "@shared/types/listing-member-lifecycle";
import { listingIntentLifecycleEvidenceSchema } from "@shared/listing-intent-lifecycle";
import type { IntentHandoff } from "./listing-intent-propagation";
import { hasUnconfirmedMemberDispatch } from "./listing-member-lifecycle";

export interface ListingIntentRemainingWork {
  productVariantId: number;
  state: "settled" | "pending" | "attention";
  code: string;
  message: string;
  references: string[];
  nextActions?: ListingWorkAction[];
}
export interface ListingContentWork {
  state: "pending" | "attention";
  action: ListingWorkAction;
}

/** Listing lifecycle owns disposition, not selection, quantities or provider execution.
 * A catalog exclusion is never proof that an existing remote obligation is done. */
export function resolveListingIntentLifecycle(input: {
  selection: StockPublicationSelection;
  accountId: string;
  retainedVariantIds: readonly number[];
  retirements: readonly ListingMemberRetirement[];
  stock: readonly ListingIntentRemainingWork[];
  contentWork: readonly ListingContentWork[];
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
      const duty = member.action === "zero"
          ? "stock_clear"
          : "none";
      const base = { productVariantId: member.productVariantId, duty };
      if (member.blockers.length)
        return {
          ...base,
          state: "attention",
          code: member.blockers[0].code,
          nextActions: [{ owner: "listing_mapping" }],
          message: member.blockers[0].message,
          references: [],
        };
      const outstanding = input.stock.find(
        (row) =>
          row.productVariantId === member.productVariantId &&
          row.state === "pending",
      );
      if (outstanding) return { ...base, ...outstanding, duty: "stock_clear" as const, nextActions: [{ owner: "stock_publication" as const }] };
      if (input.contentWork.length > 0)
        return {
          ...base,
          state: "pending",
          code: "LISTING_LIFECYCLE_PRIOR_WORK",
          message:
            input.contentWork.length > 100
              ? `${input.contentWork.length} earlier listing operations remain unresolved. Showing the first 100; refresh after resolving them.`
              : "An earlier listing operation still needs completion or reconciliation in the listing workspace.",
          references: [...new Set(input.contentWork.flatMap(work => work.action.operationId ? [work.action.operationId] : []))].slice(0,100),
          nextActions: [...new Map(input.contentWork.map(work => [JSON.stringify(work.action),work.action])).values()].slice(0,100),
        };
      if (member.catalogArchived) {
        const matching = input.retirements.filter(
          (row) => row.identity.productVariantId === member.productVariantId,
        );
        // A new catalog generation must not hide an older, possibly dispatched
        // removal. Keep each unresolved receipt reachable in the workspace.
        const outstanding = matching.filter((row) => row.state !== "retired"
          && (row.state !== "superseded" || hasUnconfirmedMemberDispatch(row))
          && !(row.code === "LISTING_MEMBER_IDENTITY_INVALID" && row.dispatchStatus === "none"));
        if (outstanding.length > 0) {
          const primary = outstanding.find((row) => row.state === "failed" || row.state === "superseded") ?? outstanding[0];
          return {
            ...base, duty: "retirement",
            state: outstanding.some((row) => row.state === "failed" || row.state === "superseded") ? "attention" : "pending",
            code: primary.state === "superseded" ? "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED"
              : primary.code ?? "LISTING_LIFECYCLE_RETIREMENT_PENDING",
            message: primary.state === "superseded"
              ? "An older removal was marked superseded after it may have been sent. Review the saved channel listing; its outcome has not been confirmed."
              : primary.message ?? "The listing lifecycle must confirm this archived member's remaining channel work.",
            references: outstanding.slice(0, 100).map((row) => row.operationId),
            nextActions: outstanding.slice(0, 100).map((row) => row.code === "LISTING_MEMBER_IDENTITY_CONFLICT"
              ? { owner: "listing_mapping" as const }
              : { owner: "listing_member_retirement" as const, operationId: row.operationId }),
          };
        }
        const retired = matching.length === 1 ? matching[0] : null;
        if (retired?.state === "retired" && retired.verifiedAt)
          return {
            ...base, duty: "retirement",
            state: "settled",
            code: "LISTING_LIFECYCLE_RETIREMENT_VERIFIED",
            message: "Removal of this archived member was verified.",
            references: [retired.operationId],
          };
        return { ...base, state: "settled", code: "LISTING_LIFECYCLE_ARCHIVED_LOCALLY",
          message: "This variant is archived and excluded from updates. A channel listing may still be live until explicitly unpublished.",
          references: [] };
      }
      if (member.action === "zero") {
        const work = input.stock.filter(
          (row) => row.productVariantId === member.productVariantId,
        );
        if (work.length === 1) return { ...base, ...work[0], ...(work[0].state === "settled" ? {} : { nextActions: [{ owner: "stock_publication" as const }] }) };
        return {
          ...base,
          state: "attention",
          code: "LISTING_LIFECYCLE_CLEARING_UNPROVEN",
          nextActions: [{ owner: "stock_publication" }],
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
          nextActions: [{ owner: "listing_mapping" }],
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
      ? selection.variants.some(member => member.catalogArchived)
        ? "Archived variants are excluded from updates. Their channel listings may remain live until explicitly unpublished."
        : "No content update is required for these excluded members. Their remaining channel obligations were verified complete at the recorded check."
      : evidence.members.some(member => member.code === "LISTING_MEMBER_IDENTITY_CONFLICT")
        ? "A saved listing link conflicts with another. Review the links; Echelon will check the affected removal after the links change."
        : evidence.members.some(member => member.code === "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED")
          ? "An earlier channel removal is unresolved. Open the listing workspace to review the saved listing and its remaining work."
          : "These members are excluded from content updates. Channel clearing or removal is still outstanding; automatic checks will continue. Open the listing workspace for the remaining work.",
  };
}
