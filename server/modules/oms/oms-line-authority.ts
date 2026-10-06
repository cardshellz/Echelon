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
   * by an order edit or cancellation. This, not `fulfillable_quantity`, is the
   * commercial ceiling for what the warehouse still owes. Null/undefined when
   * the channel payload does not carry it.
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

/**
 * Dropship order acceptance. A dropship order is paid when the vendor's wallet
 * is debited for it, and acceptance grants this authority in that same
 * transaction (grantDropshipAcceptanceLineAuthorityWithClient).
 */
export const DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC = "dropship/acceptance";

const AUTHORIZING_TOPICS = new Set([
  "orders/create",
  "orders/paid",
  "ebay/order",
  "ebay/orders",
  "ebay/poll",
  "ebay/webhook",
  "walmart/acknowledged",
  "manual/create",
  "shopify/bridge",
  // Operator/reconciler backfill: re-authorize a paid line that was left
  // unauthorized by a defect (e.g. the 2026-07 orders/paid+orders/updated race).
  // Authorizes from order-paid truth, same as a first-party paid event.
  "reconciler/authorize",
  DROPSHIP_ACCEPTANCE_AUTHORITY_TOPIC,
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

function statusAfterNonAuthorizingUpdate(
  paidQuantity: number,
  previousStatus: string,
): OmsLineAuthorizationStatus {
  // Paid quantity is historical payment evidence, not permission to undo a
  // refund, cancellation or review. In particular, resetting review here would
  // let a second readiness update bypass canRefreshOperationalReadiness below.
  // This observation has no disposition evidence with which to replace those
  // states; their owning commands must make that decision.
  switch (previousStatus) {
    case "partially_cancelled":
    case "cancelled":
    case "partially_refunded":
    case "refunded":
    case "review":
      return previousStatus;
    default:
      return statusForQuantities(paidQuantity);
  }
}

/**
 * Shopify's `fulfillable_quantity` is workflow permission, not demand. It
 * drops to 0 while a fulfillment order is on hold (a merchant-of-record app
 * such as Global-e processing an international order, a fraud check, an
 * address problem), scheduled, or moving between locations, and it falls as
 * units are fulfilled. None of those mean the customer no longer wants the
 * goods (channel-fulfillment-quantity-authority.ts: "remaining work, not a
 * lifetime cap or a cancellation count").
 *
 * So readiness may RAISE authority (a hold or schedule is released) but may
 * LOWER it only to `current_quantity`, the channel's record of units removed
 * by an order edit or cancellation. Lowering on a hold cancelled
 * already-materialized WMS lines that nothing restored when the hold lifted
 * (#63275 on 2026-09-18, #63861 on 2026-10-06).
 *
 * `allowFulfillableToLower` covers a readiness refresh without
 * `current_quantity`: orders/updated is the topic that carries order edits,
 * and without `current_quantity` an edit removal is indistinguishable from a
 * hold, so the legacy fulfillable-driven rule stays (picking units the
 * customer removed is the costlier mistake). Authorizing topics pass false:
 * they record payment, never an edit, so a fulfillable dip there is always a
 * hold or fulfillment progress.
 */
function fulfillableReadinessCap(input: {
  previousAuthority: number;
  incomingFulfillableQuantity: number;
  incomingCurrentQuantity: number | null;
  allowFulfillableToLower: boolean;
}): number {
  const raisedByReadiness = Math.max(
    input.previousAuthority,
    input.incomingFulfillableQuantity,
  );
  if (input.incomingCurrentQuantity !== null) {
    return Math.min(input.incomingCurrentQuantity, raisedByReadiness);
  }
  return input.allowFulfillableToLower
    ? input.incomingFulfillableQuantity
    : raisedByReadiness;
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
  const incomingCurrentQuantity = finiteNonNegativeIntegerOrNull(
    input.currentQuantity,
    "currentQuantity",
  );

  if (eventCanAuthorize) {
    const fulfillableQuantity = finiteNonNegativeIntegerOrNull(
      input.fulfillableQuantity,
      "fulfillableQuantity",
    );
    const dispositionCap = input.sourceTopic === "walmart/acknowledged"
      ? Math.max(0, observedQuantity
        - requireNonNegativeInteger(input.previous?.cancelledQuantity, "previous.cancelledQuantity")
        - requireNonNegativeInteger(input.previous?.refundedQuantity, "previous.refundedQuantity"))
      : observedQuantity;
    // A first authorization still waits for readiness (a line already on hold
    // at payment is not materialized until released). A re-authorization of a
    // line that already carries authority is never lowered by a hold.
    const readinessCap = fulfillableQuantity === null
      ? incomingCurrentQuantity ?? observedQuantity
      : fulfillableReadinessCap({
        previousAuthority: requireNonNegativeInteger(
          input.previous?.authorityFulfillableQuantity ?? 0,
          "previous.authorityFulfillableQuantity",
        ),
        incomingFulfillableQuantity: fulfillableQuantity,
        incomingCurrentQuantity,
        allowFulfillableToLower: false,
      });
    const authorityFulfillableQuantity = Math.min(
      observedQuantity,
      dispositionCap,
      readinessCap,
    );
    let authorizationStatus = statusForQuantities(observedQuantity);
    if (input.sourceTopic === "walmart/acknowledged" && dispositionCap < observedQuantity) {
      const previousStatus = input.previous?.authorizationStatus;
      switch (previousStatus) {
        case "cancelled": case "partially_cancelled": case "refunded": case "partially_refunded":
          authorizationStatus = previousStatus;
          break;
        default:
          authorizationStatus = "review";
      }
    }

    return {
      channelObservedQuantity: observedQuantity,
      paidQuantity: observedQuantity,
      authorityFulfillableQuantity,
      authorizationStatus,
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
    ? Math.min(
      paidQuantity,
      fulfillableReadinessCap({
        previousAuthority: previousFulfillableQuantity,
        incomingFulfillableQuantity,
        incomingCurrentQuantity,
        allowFulfillableToLower: true,
      }),
    )
    : Math.min(previousFulfillableQuantity, paidQuantity);

  return {
    channelObservedQuantity: observedQuantity,
    paidQuantity,
    authorityFulfillableQuantity,
    authorizationStatus: statusAfterNonAuthorizingUpdate(
      paidQuantity,
      previousAuthorizationStatus,
    ),
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

/**
 * Units of a line that dropship acceptance stages into WMS before the order is
 * paid.
 *
 * Staging runs before the vendor's wallet is debited, so the line has no OMS
 * authority yet: authority_fulfillable_quantity is still 0, its column default
 * (migration 106). Staging needs the ordered quantity so it can hold one
 * whole-order inventory claim. Its WMS order is created `pending`, which is not
 * pickable and which the WMS authority trigger (migration 108) does not check.
 * Finalization grants paid authority for the same quantity in the transaction
 * that marks the OMS order paid, so the sync that then promotes the paid order
 * to `ready` finds authority equal to what WMS holds.
 */
export function getOmsLineDropshipStagingQuantity(line: {
  quantity?: number | null;
}): number {
  return requireNonNegativeInteger(line.quantity ?? 0, "quantity");
}

export function getOmsLineRemainingDropshipStagingQuantity(line: {
  quantity?: number | null;
  wmsMaterializedQuantity?: number | null;
}): number {
  const stagingQuantity = getOmsLineDropshipStagingQuantity(line);
  const materializedQuantity = requireNonNegativeInteger(
    line.wmsMaterializedQuantity ?? 0,
    "wmsMaterializedQuantity",
  );
  return Math.max(stagingQuantity - materializedQuantity, 0);
}
