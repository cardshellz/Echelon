export const OMS_LINE_AUTHORIZATION_STATUSES = [
  "seen",
  "authorized",
  "partially_cancelled",
  "cancelled",
  "partially_refunded",
  "refunded",
  "review",
] as const;

export type OmsLineAuthorizationStatus = typeof OMS_LINE_AUTHORIZATION_STATUSES[number];

export interface OmsLineAuthorityInput {
  sourceTopic: string;
  sourceEventId?: string | null;
  sourceInboxId?: number | null;
  financialStatus?: string | null;
  quantity: number | null | undefined;
  fulfillableQuantity?: number | null;
  previous?: {
    paidQuantity?: number | null;
    authorityFulfillableQuantity?: number | null;
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

function requireNonNegativeInteger(value: number | null | undefined, field: string): number {
  const normalized = Number(value ?? 0);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`OMS line authority ${field} must be a non-negative integer (got ${String(value)})`);
  }
  return normalized;
}

function finiteNonNegativeIntegerOrNull(value: number | null | undefined, field: string): number | null {
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

function coerceDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function deriveOmsLineAuthority(input: OmsLineAuthorityInput): OmsLineAuthorityState {
  const observedQuantity = requireNonNegativeInteger(input.quantity, "quantity");
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
  const paidQuantity = Math.min(previousPaidQuantity, observedQuantity);
  const authorityFulfillableQuantity = Math.min(previousFulfillableQuantity, paidQuantity);

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
    return requireNonNegativeInteger(explicitAuthority, "authorityFulfillableQuantity");
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
