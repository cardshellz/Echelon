import {
  EBAY_POLICY_FIELDS,
  ebayPolicyDisplayOptions,
  type EbayPolicyField,
  type EbayPolicyPatch,
} from "./dropship-ebay-policy-assignment";
import type {
  DropshipEbayListingPolicyOverride,
  DropshipEbayListingPolicyOverrideResponse,
} from "./dropship-ops-surface";

/** Bounds mounted table rows; this is not a server-side catalog fetch limit. */
export const EBAY_POLICY_PAGE_SIZE = 50;

export function paginateEbayPolicyRows<T>(rows: readonly T[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / EBAY_POLICY_PAGE_SIZE));
  const page = Math.min(pageCount, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  const offset = (page - 1) * EBAY_POLICY_PAGE_SIZE;
  return {
    page,
    pageCount,
    total: rows.length,
    start: rows.length === 0 ? 0 : offset + 1,
    end: Math.min(offset + EBAY_POLICY_PAGE_SIZE, rows.length),
    rows: rows.slice(offset, offset + EBAY_POLICY_PAGE_SIZE),
  };
}

export function singleEbayListingPolicyPatch(
  assignment: DropshipEbayListingPolicyOverride | undefined,
): Record<EbayPolicyField, string | null> {
  // Store defaults remain null, even when the effective policy has an id.
  return {
    fulfillmentPolicyId: assignment?.fulfillmentPolicyId ?? null,
    returnPolicyId: assignment?.returnPolicyId ?? null,
    paymentPolicyId: assignment?.paymentPolicyId ?? null,
  };
}

export function hasEbayPolicyEditorChange(
  patch: EbayPolicyPatch,
  initial: Record<EbayPolicyField, string | null> | null,
): boolean {
  return EBAY_POLICY_FIELDS.some((field) => patch[field] !== undefined
    && (initial === null || patch[field] !== initial[field]));
}

export function summarizeEbayListingPolicy(
  data: DropshipEbayListingPolicyOverrideResponse,
  assignment: DropshipEbayListingPolicyOverride | undefined,
  field: EbayPolicyField,
): { name: string; source: "Store default" | "Override"; needsAttention: boolean } {
  const overrideId = assignment?.[field];
  const id = overrideId ?? data.defaults[field];
  const option = ebayPolicyDisplayOptions(data, field).find((candidate) => candidate.id === id);
  return {
    name: id === null ? "Not configured" : option?.name ?? `Unavailable policy (${id})`,
    source: overrideId ? "Override" : "Store default",
    needsAttention: id === null || option === undefined || ("disabled" in option && option.disabled === true),
  };
}
