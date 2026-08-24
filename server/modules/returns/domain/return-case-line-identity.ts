export type ReturnCaseLineIdentityConflict =
  | "OMS_LINE_NOT_IN_SOURCE_ORDER"
  | "EXTERNAL_LINE_ID_MISMATCH"
  | "INVALID_EVIDENCE";

export type ReturnCaseLineIdentityResolution =
  | { status: "resolved"; externalLineItemId: string }
  | { status: "missing" }
  | { status: "conflict"; reason: ReturnCaseLineIdentityConflict };

export interface ReturnCaseLineIdentityEvidence {
  omsOrderLineId: number | null;
  storedExternalLineItemId: string | null;
  omsExternalLineItemId: string | null;
  omsLineMatchedSourceOrder: boolean;
}

/**
 * Resolves provider line identity without weakening immutable Return Case evidence.
 * An OMS link is authoritative only when it resolves inside the source OMS order.
 */
export function resolveReturnCaseExternalLineItemId(
  evidence: ReturnCaseLineIdentityEvidence,
): ReturnCaseLineIdentityResolution {
  const storedExternalLineItemId = normalizeExternalId(evidence.storedExternalLineItemId);
  const omsExternalLineItemId = normalizeExternalId(evidence.omsExternalLineItemId);

  if (evidence.omsOrderLineId === null) {
    if (evidence.omsLineMatchedSourceOrder || omsExternalLineItemId !== null) {
      return { status: "conflict", reason: "INVALID_EVIDENCE" };
    }
    return storedExternalLineItemId === null
      ? { status: "missing" }
      : { status: "resolved", externalLineItemId: storedExternalLineItemId };
  }

  if (!evidence.omsLineMatchedSourceOrder) {
    return { status: "conflict", reason: "OMS_LINE_NOT_IN_SOURCE_ORDER" };
  }
  if (
    storedExternalLineItemId !== null
    && omsExternalLineItemId !== null
    && storedExternalLineItemId !== omsExternalLineItemId
  ) {
    return { status: "conflict", reason: "EXTERNAL_LINE_ID_MISMATCH" };
  }
  const resolved = omsExternalLineItemId ?? storedExternalLineItemId;
  return resolved === null
    ? { status: "missing" }
    : { status: "resolved", externalLineItemId: resolved };
}

function normalizeExternalId(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  const shopifyLineItemPrefix = "gid://shopify/LineItem/";
  if (
    normalized.startsWith(shopifyLineItemPrefix)
    && /^\d+$/.test(normalized.slice(shopifyLineItemPrefix.length))
  ) {
    return normalized.slice(shopifyLineItemPrefix.length);
  }
  return normalized.length === 0 ? null : normalized;
}
