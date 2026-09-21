export const OMS_LINE_AUTHORIZATION_STATUSES = [
  "seen",
  "authorized",
  "partially_cancelled",
  "cancelled",
  "partially_refunded",
  "refunded",
  "review",
] as const;

export type OmsLineAuthorizationStatus =
  (typeof OMS_LINE_AUTHORIZATION_STATUSES)[number];

export interface OmsLineAuthorityInput {
  sourceTopic: string;
  sourceEventId?: string | null;
  sourceInboxId?: number | null;
  financialStatus?: string | null;
  quantity: number | null | undefined;
  fulfillableQuantity?: number | null;
  /**
   * Shopify line `current_quantity`: the ordered quantity minus units removed
   * by order edits or cancellation. This, not `fulfillable_quantity`, is the
   * commercial ceiling for what the warehouse still owes. Null when the
   * channel payload does not carry it.
   */
  currentQuantity?: number | null;
  previous?: {
    paidQuantity?: number | null;
    authorityFulfillableQuantity?: number | null;
    cancelledQuantity?: number | null;
    refundedQuantity?: number | null;
    authorizationStatus?: string | null;
    authorizedAt?: Date | string | null;
    authorizedByEventId?: string | null;
  } | null;
  now?: Date;
}

export interface OmsLineAuthorityState {
  channelObservedQuantity: number;
  paidQuantity: number;
  authorityFulfillableQuantity: number;
  authorizationStatus: OmsLineAuthorizationStatus;
  authorizedAt: Date | null;
  authorizedByEventId: string | null;
  authoritySourceTopic: string;
  authoritySourceInboxId: number | null;
}

const AUTHORIZING_TOPICS = new Set([
  "orders/create",
  "orders/paid",
  "ebay/order",
  "ebay/orders",
  "ebay/poll",
  "ebay/webhook",
  "manual/create",
  "shopify/bridge",
  // Operator/reconciler backfill: re-authorize a paid line that was left
  // unauthorized by a defect (e.g. the 2026-07 orders/paid+orders/updated race).
  // Authorizes from order-paid truth, same as a first-party paid event.
  "reconciler/authorize",
]);

const PAID_FINANCIAL_STATUSES = new Set([
  "paid",
  "partially_paid",
  "partially_refunded",
]);

const READINESS_REFRESH_TOPICS = new Set([
  "orders/updated",
  "shopify/reconcile",
]);

const READINESS_REFRESH_FINANCIAL_STATUSES = new Set([
  "paid",
  "partially_paid",
]);

function requireNonNegativeInteger(
  value: number | null | undefined,
  field: string,
): number {
  const normalized = Number(value ?? 0);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(
      `OMS line authority ${field} must be a non-negative integer (got ${String(value)})`,
    );
  }
  return normalized;
}

function finiteNonNegativeIntegerOrNull(
  value: number | null | undefined,
  field: string,
): number | null {
  if (value === null || value === undefined) return null;
  return requireNonNegativeInteger(value, field);
}

function isPaidFinancialStatus(status: string | null | undefined): boolean {
  return PAID_FINANCIAL_STATUSES.has(String(status ?? "").toLowerCase());
}

export function canSourceTopicAuthorizeOmsLine(sourceTopic: string): boolean {
  return AUTHORIZING_TOPICS.has(sourceTopic);
}

function statusForQuantities(paidQuantity: number): OmsLineAuthorizationStatus {
  if (paidQuantity <= 0) return "seen";
  return "authorized";
}

/**
 * Shopify's `fulfillable_quantity` is workflow permission, not demand. It
 * drops to 0 while a fulfillment order is on hold (a merchant-of-record app
 * such as Global-e processing an international order, a fraud check, an
 * address problem), scheduled, or moving between locations, and it falls as
 * units are fulfilled. None of those mean the customer no longer wants the
 * goods (see channel-fulfillment-quantity-authority.ts: "remaining work, not a
 * lifetime cap or a cancellation count").
 *
 * So a readiness refresh may RAISE authority (a hold or schedule is released)
 * but may LOWER it only to `current_quantity`, the channel's record of units
 * removed by an order edit or cancellation. Lowering on a hold used to cancel
 * already-materialized WMS lines that were never restored when the hold lifted
 * (order #63275, 2026-09-18).
 *
 * When `current_quantity` is absent, keep the legacy fulfillable-driven rule:
 * without it an order-edit removal is indistinguishable from a hold, and
 * picking units the customer removed is the costlier mistake.
 */
function refreshedReadinessAuthority(input: {
  paidQuantity: number;
  previousFulfillableQuantity: number;
  incomingFulfillableQuantity: number;
  incomingCurrentQuantity: number | null;
}): number {
  const raisedByReadiness = Math.max(
    input.previousFulfillableQuantity,
    input.incomingFulfillableQuantity,
  );
  const commercialCeiling =
    input.incomingCurrentQuantity ?? input.incomingFulfillableQuantity;
  return Math.min(input.paidQuantity, commercialCeiling, raisedByReadiness);
}

function coerceDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function deriveOmsLineAuthority(
  input: OmsLineAuthorityInput,
): OmsLineAuthorityState {
  const observedQuantity = requireNonNegativeInteger(
    input.quantity,
    "quantity",
  );
  const eventCanAuthorize =
    canSourceTopicAuthorizeOmsLine(input.sourceTopic) &&
    isPaidFinancialStatus(input.financialStatus);

  if (eventCanAuthorize) {
    const fulfillableQuantity = finiteNonNegativeIntegerOrNull(
      input.fulfillableQuantity,
      "fulfillableQuantity",
    );
    const authorityFulfillableQuantity = Math.min(
      observedQuantity,
      fulfillableQuantity ?? observedQuantity,
    );

    return {
      channelObservedQuantity: observedQuantity,
      paidQuantity: observedQuantity,
      authorityFulfillableQuantity,
      authorizationStatus: statusForQuantities(observedQuantity),
      authorizedAt: input.now ?? new Date(),
      authorizedByEventId: input.sourceEventId ?? null,
      authoritySourceTopic: input.sourceTopic,
      authoritySourceInboxId: input.sourceInboxId ?? null,
    };
  }

  const previousPaidQuantity = requireNonNegativeInteger(
    input.previous?.paidQuantity ?? 0,
    "previous.paidQuantity",
  );
  const previousFulfillableQuantity = requireNonNegativeInteger(
    input.previous?.authorityFulfillableQuantity ?? 0,
    "previous.authorityFulfillableQuantity",
  );
  const previousCancelledQuantity = requireNonNegativeInteger(
    input.previous?.cancelledQuantity ?? 0,
    "previous.cancelledQuantity",
  );
  const previousRefundedQuantity = requireNonNegativeInteger(
    input.previous?.refundedQuantity ?? 0,
    "previous.refundedQuantity",
  );
  const paidQuantity = Math.min(previousPaidQuantity, observedQuantity);
  const incomingFulfillableQuantity = finiteNonNegativeIntegerOrNull(
    input.fulfillableQuantity,
    "fulfillableQuantity",
  );
  const incomingCurrentQuantity = finiteNonNegativeIntegerOrNull(
    input.currentQuantity,
    "currentQuantity",
  );
  const previousAuthorizationStatus = String(
    input.previous?.authorizationStatus ??
      statusForQuantities(previousPaidQuantity),
  );
  const canRefreshOperationalReadiness =
    READINESS_REFRESH_TOPICS.has(input.sourceTopic) &&
    READINESS_REFRESH_FINANCIAL_STATUSES.has(
      String(input.financialStatus ?? ""),
    ) &&
    incomingFulfillableQuantity !== null &&
    previousCancelledQuantity === 0 &&
    previousRefundedQuantity === 0 &&
    (previousAuthorizationStatus === "seen" ||
      previousAuthorizationStatus === "authorized");
  const authorityFulfillableQuantity = canRefreshOperationalReadiness
    ? refreshedReadinessAuthority({
      paidQuantity,
      previousFulfillableQuantity,
      incomingFulfillableQuantity,
      incomingCurrentQuantity,
    })
    : Math.min(previousFulfillableQuantity, paidQuantity);

  return {
    channelObservedQuantity: observedQuantity,
    paidQuantity,
    authorityFulfillableQuantity,
    authorizationStatus: statusForQuantities(paidQuantity),
    authorizedAt: coerceDate(input.previous?.authorizedAt),
    authorizedByEventId: input.previous?.authorizedByEventId ?? null,
    authoritySourceTopic: input.sourceTopic,
    authoritySourceInboxId: input.sourceInboxId ?? null,
  };
}

export function getOmsLineMaterializableQuantity(line: {
  quantity?: number | null;
  authorityFulfillableQuantity?: number | null;
}): number {
  const explicitAuthority = line.authorityFulfillableQuantity;
  if (explicitAuthority !== null && explicitAuthority !== undefined) {
    return requireNonNegativeInteger(
      explicitAuthority,
      "authorityFulfillableQuantity",
    );
  }
  return requireNonNegativeInteger(line.quantity ?? 0, "quantity");
}

export function getOmsLineRemainingMaterializableQuantity(line: {
  quantity?: number | null;
  authorityFulfillableQuantity?: number | null;
  wmsMaterializedQuantity?: number | null;
}): number {
  const authorizedQuantity = getOmsLineMaterializableQuantity(line);
  const materializedQuantity = requireNonNegativeInteger(
    line.wmsMaterializedQuantity ?? 0,
    "wmsMaterializedQuantity",
  );
  return Math.max(authorizedQuantity - materializedQuantity, 0);
}
