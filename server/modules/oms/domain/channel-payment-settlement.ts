import { parseDecimalCents } from "@shared/money-read";

/**
 * The sales channel owns what was bought and paid for. This module reads the
 * channel's own statement of payment so OMS does not infer it from which
 * webhook topic happened to carry the news.
 *
 * Why this exists (order #65696, 2026-11-16): an operator edited a paid
 * Shopify order in Shopify admin, adding 2 units and a 15% discount. The new
 * total was lower than what the customer had already paid, so Shopify issued
 * a refund and sent no orders/paid. OMS only raised paid quantity on
 * "authorizing" topics, so the line stayed at its old paid quantity and the
 * extra units never reached WMS or the shipping engine, silently.
 */

/** Shopify financial statuses under which a non-positive outstanding balance means "fully paid". */
const SETTLEABLE_FINANCIAL_STATUSES = new Set(["paid", "partially_refunded"]);

/**
 * True when Shopify reports the order fully paid for its CURRENT contents:
 * the financial status is paid/partially_refunded AND total_outstanding is
 * zero or negative (negative = the customer overpaid, e.g. after an edit that
 * lowered the total, before or after Shopify refunds the difference).
 *
 * Returns null when the payload carries no total_outstanding: the channel has
 * not stated it, so callers must keep their previous, more conservative rule.
 * A present but malformed amount throws MoneyInputError: a channel payload
 * that breaks its own money contract must fail loudly, never authorize.
 */
export function deriveShopifyChannelPaymentSettled(input: {
  financialStatus: string | null | undefined;
  totalOutstanding: string | number | null | undefined;
}): boolean | null {
  if (input.totalOutstanding === null || input.totalOutstanding === undefined) return null;
  const outstandingCents = parseDecimalCents(input.totalOutstanding, "total_outstanding", true);
  const status = String(input.financialStatus ?? "").trim().toLowerCase();
  return SETTLEABLE_FINANCIAL_STATUSES.has(status) && outstandingCents <= 0;
}

export const CHANNEL_AUTHORITY_GAP_EVENT_TYPE = "channel_quantity_not_authorized";

/** Expected: the channel says money is still owed for these units. */
export const OMS_LINE_AWAITING_CHANNEL_PAYMENT = "OMS_LINE_AWAITING_CHANNEL_PAYMENT";
/** Defect: the channel says the order is fully paid, yet OMS will not ship these units. */
export const OMS_PAID_QUANTITY_BELOW_CHANNEL = "OMS_PAID_QUANTITY_BELOW_CHANNEL";

export interface ChannelAuthorityGapLineInput {
  id: number;
  sku: string | null;
  quantity: number | null;
  channelCurrentQuantity: number | null;
  paidQuantity: number | null;
  authorizationStatus: string | null;
  requiresShipping: boolean | null;
}

export interface ChannelAuthorityGapLine {
  orderLineId: number;
  sku: string | null;
  channelQuantity: number;
  paidQuantity: number;
  unauthorizedQuantity: number;
}

export interface ChannelAuthorityGap {
  code: typeof OMS_LINE_AWAITING_CHANNEL_PAYMENT | typeof OMS_PAID_QUANTITY_BELOW_CHANNEL;
  /** Deterministic fingerprint of the gap; unchanged gaps are recorded once. */
  signature: string;
  lines: ChannelAuthorityGapLine[];
}

/**
 * Line dispositions owned by other commands (cancel, refund, review). A gap on
 * them is not "unpaid demand", so it is not reported here.
 */
const GAP_ELIGIBLE_STATUSES = new Set(["seen", "authorized"]);

function nonNegativeInteger(value: number | null | undefined, field: string): number {
  const normalized = Number(value ?? 0);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`Channel authority gap ${field} must be a non-negative integer (got ${String(value)})`);
  }
  return normalized;
}

/**
 * Units the channel says were bought (current quantity) that OMS has no paid
 * authority for. Returns null when there is no gap. Pure; inputs are not mutated.
 */
export function summarizeChannelAuthorityGap(input: {
  lines: readonly ChannelAuthorityGapLineInput[];
  channelPaymentSettled: boolean | null;
}): ChannelAuthorityGap | null {
  const gapLines: ChannelAuthorityGapLine[] = [];
  for (const line of input.lines) {
    if (line.requiresShipping === false) continue;
    if (!GAP_ELIGIBLE_STATUSES.has(String(line.authorizationStatus ?? "seen"))) continue;
    const channelQuantity = nonNegativeInteger(line.channelCurrentQuantity ?? line.quantity, "channelQuantity");
    const paidQuantity = nonNegativeInteger(line.paidQuantity, "paidQuantity");
    if (channelQuantity <= paidQuantity) continue;
    gapLines.push({
      orderLineId: line.id,
      sku: line.sku,
      channelQuantity,
      paidQuantity,
      unauthorizedQuantity: channelQuantity - paidQuantity,
    });
  }
  if (gapLines.length === 0) return null;
  gapLines.sort((left, right) => left.orderLineId - right.orderLineId);
  const code = input.channelPaymentSettled === true
    ? OMS_PAID_QUANTITY_BELOW_CHANNEL
    : OMS_LINE_AWAITING_CHANNEL_PAYMENT;
  const signature = [
    code,
    ...gapLines.map((line) => `${line.orderLineId}:${line.channelQuantity}:${line.paidQuantity}`),
  ].join("|");
  return { code, signature, lines: gapLines };
}
