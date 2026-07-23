export type ChannelFulfillmentWritebackBlockReason =
  | "blocking_review"
  | "fulfillment_provider_mismatch"
  | "terminal_commercial_order"
  | "terminal_financial_order"
  | "physical_quantity_exceeds_current_authority";

export interface ChannelFulfillmentWritebackPolicyInput {
  readonly channelProvider: string;
  readonly lineFulfillmentProvider: string;
  readonly omsOrderStatus: string | null;
  readonly omsFinancialStatus: string | null;
  readonly requiresReview: boolean;
  readonly reviewReason: string | null;
  readonly currentAuthorizedQuantity: number;
  readonly cumulativePhysicalQuantity: number;
}

export interface ChannelFulfillmentWritebackPolicyDecision {
  readonly allowed: boolean;
  readonly reasons: readonly ChannelFulfillmentWritebackBlockReason[];
}

const CHANNEL_WRITEBACK_BLOCKING_REVIEW_REASONS = new Set([
  "shipstation_shipped_after_cancel",
  "shipstation_shipped_after_refund",
  "physical_shipment_exceeds_current_line_authority",
]);

const TERMINAL_COMMERCIAL_ORDER_STATUSES = new Set(["cancelled", "refunded"]);
const TERMINAL_FINANCIAL_STATUSES = new Set(["refunded", "voided"]);

function normalized(value: string | null): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Decides whether one canonical physical-package line may be written back to
 * its sales channel. This is intentionally pure so every webhook, sweeper,
 * replay, and future shipping adapter applies the same commercial authority.
 */
export function evaluateChannelFulfillmentWritebackPolicy(
  input: ChannelFulfillmentWritebackPolicyInput,
): ChannelFulfillmentWritebackPolicyDecision {
  const reasons: ChannelFulfillmentWritebackBlockReason[] = [];
  const channelProvider = normalized(input.channelProvider);
  const lineFulfillmentProvider = normalized(input.lineFulfillmentProvider);
  const orderStatus = normalized(input.omsOrderStatus);
  const financialStatus = normalized(input.omsFinancialStatus);
  const reviewReason = normalized(input.reviewReason);

  if (
    input.requiresReview
    && CHANNEL_WRITEBACK_BLOCKING_REVIEW_REASONS.has(reviewReason)
  ) {
    reasons.push("blocking_review");
  }
  if (!channelProvider || lineFulfillmentProvider !== channelProvider) {
    reasons.push("fulfillment_provider_mismatch");
  }
  if (TERMINAL_COMMERCIAL_ORDER_STATUSES.has(orderStatus)) {
    reasons.push("terminal_commercial_order");
  }
  if (TERMINAL_FINANCIAL_STATUSES.has(financialStatus)) {
    reasons.push("terminal_financial_order");
  }
  if (input.cumulativePhysicalQuantity > input.currentAuthorizedQuantity) {
    reasons.push("physical_quantity_exceeds_current_authority");
  }

  return Object.freeze({
    allowed: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}
