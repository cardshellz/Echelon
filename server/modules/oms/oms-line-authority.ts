import { ChannelQuantityEvidenceError, observeChannelMerchandiseQuantity } from "./domain/channel-merchandise-quantity";

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
   * Shopify's current merchandise (excludes removed/refunded units). A refund
   * amount is never used to infer this quantity. Fulfillable is remaining work.
   */
  currentQuantity?: number | null;
  channelUpdatedAt?: Date | string | null;
  previous?: {
    channelObservedQuantity?: number | null;
    channelCurrentQuantity?: number | null;
    channelQuantityUpdatedAt?: Date | string | null;
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
  channelCurrentQuantity?: number | null;
  channelQuantityUpdatedAt?: Date | null;
  staleChannelObservation?: boolean;
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
  if (field === "currentQuantity" && (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647))
    throw new ChannelQuantityEvidenceError("Current channel quantity must be a nonnegative PostgreSQL integer.");
  return requireNonNegativeInteger(value, field);
}

function isPaidFinancialStatus(status: string | null | undefined): boolean {
  return PAID_FINANCIAL_STATUSES.has(String(status ?? "").toLowerCase());
}

/**
 * A line added to an already-paid order by a Shopify order edit arrives only
 * via orders/updated: an equal-price swap creates no new payment, so no
 * orders/paid follows. #64592 (2026-10-21) left such a line 'seen' with zero
 * authority; nothing ever shipped it and the empty order was later cancelled.
 *
 * A readiness refresh may grant FIRST authority only when Shopify reports the
 * whole order fully paid ("paid", not partially_paid: an edit that raised the
 * total waits for that payment) and the line has never been paid or given any
 * disposition. Refunded, cancelled and review lines keep their owning decision.
 */
function canGrantFirstAuthorityFromPaidRefresh(input: OmsLineAuthorityInput): boolean {
  // The edit itself arrives as orders/updated; the shopify/reconcile poll does
  // not grant first authority, so it never revives historical unpaid lines.
  if (input.sourceTopic !== "orders/updated") return false;
  if (String(input.financialStatus ?? "").toLowerCase() !== "paid") return false;
  const previous = input.previous;
  if (!previous) return true;
  return Number(previous.paidQuantity ?? 0) === 0
    && Number(previous.authorityFulfillableQuantity ?? 0) === 0
    && Number(previous.cancelledQuantity ?? 0) === 0
    && Number(previous.refundedQuantity ?? 0) === 0
    && String(previous.authorizationStatus ?? "seen") === "seen";
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
 * Remaining channel work cannot lower cumulative paid-line authority. Once
 * readiness has opened, current_quantity supplies the explicit commercial
 * ceiling; a partial fulfillment is not a new, smaller authorization.
 *
 * A line first authorized while held still waits for positive readiness. A
 * payload without current_quantity may raise readiness, but cannot prove an
 * edit/cancellation from a depleted fulfillable_quantity. Observed quantity
 * reductions and the disposition owners continue to constrain authority.
 */
function fulfillableReadinessCap(input: {
  previousAuthority: number;
  incomingFulfillableQuantity: number | null;
  incomingCurrentQuantity: number | null;
}): number {
  const openedAuthority = Math.max(
    input.previousAuthority,
    input.incomingFulfillableQuantity ?? 0,
  );
  if (input.incomingCurrentQuantity !== null && openedAuthority > 0) {
    return input.incomingCurrentQuantity;
  }
  return openedAuthority;
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
  // Legacy callers may have current_quantity without a source version. Keep
  // their existing cap behavior, but never manufacture dated channel evidence
  // from processing time or overwrite a verified observation with undated data.
  if (input.currentQuantity != null && input.channelUpdatedAt == null && input.previous?.channelQuantityUpdatedAt != null)
    throw new Error("A verified channel quantity cannot be replaced by an undated observation.");
  const merchandise = observeChannelMerchandiseQuantity({
    purchasedQuantity: observedQuantity,
    currentQuantity: input.channelUpdatedAt == null ? null : input.currentQuantity,
    updatedAt: input.channelUpdatedAt,
    previous: input.previous,
  });
  const merchandiseValues = merchandise.channelCurrentQuantity === null ? {} : {
    channelCurrentQuantity: merchandise.channelCurrentQuantity,
    channelQuantityUpdatedAt: merchandise.channelQuantityUpdatedAt,
  };
  if (merchandise.stale) return {
    staleChannelObservation: true,
    channelObservedQuantity: requireNonNegativeInteger(input.previous?.channelObservedQuantity ?? observedQuantity, "previous.channelObservedQuantity"),
    ...merchandiseValues,
    paidQuantity: requireNonNegativeInteger(input.previous?.paidQuantity, "previous.paidQuantity"),
    authorityFulfillableQuantity: requireNonNegativeInteger(input.previous?.authorityFulfillableQuantity, "previous.authorityFulfillableQuantity"),
    authorizationStatus: statusAfterNonAuthorizingUpdate(input.previous?.paidQuantity ?? 0, input.previous?.authorizationStatus ?? "seen"),
    authorizedAt: coerceDate(input.previous?.authorizedAt),
    authorizedByEventId: input.previous?.authorizedByEventId ?? null,
    authoritySourceTopic: input.sourceTopic,
    authoritySourceInboxId: input.sourceInboxId ?? null,
  };
  const eventCanAuthorize =
    (canSourceTopicAuthorizeOmsLine(input.sourceTopic) &&
      isPaidFinancialStatus(input.financialStatus))
    || canGrantFirstAuthorityFromPaidRefresh(input);
  const incomingCurrentQuantity = finiteNonNegativeIntegerOrNull(
    merchandise.channelCurrentQuantity ?? input.currentQuantity,
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
      ...merchandiseValues,
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
    (incomingFulfillableQuantity !== null || incomingCurrentQuantity !== null) &&
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
      }),
    )
    : Math.min(previousFulfillableQuantity, paidQuantity, incomingCurrentQuantity ?? observedQuantity);

  return {
    channelObservedQuantity: observedQuantity,
    ...merchandiseValues,
    paidQuantity,
    authorityFulfillableQuantity,
    authorizationStatus: merchandise.channelCurrentQuantity !== null && previousAuthorizationStatus !== "review"
      ? merchandise.channelCurrentQuantity === 0 ? "cancelled"
        : paidQuantity === 0 ? "seen"
          : merchandise.channelCurrentQuantity < paidQuantity ? "partially_cancelled" : "authorized"
      : statusAfterNonAuthorizingUpdate(paidQuantity, previousAuthorizationStatus),
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
