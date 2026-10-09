export interface OrderEditCredentials {
  connectionId: number;
  channelId: number;
  shopDomain: string;
  accessToken: string;
}

export interface OrderEditCredentialStore {
  get(connectionId: number): Promise<OrderEditCredentials | null>;
}

export interface OrderEditLine {
  id: string;
  variantId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  unfulfilledQuantity: number;
  originalUnitPriceCents: number;
  discountedUnitPriceCents: number;
  totalCents: number;
  discountFingerprint: string;
  unsupported: boolean;
}

export interface OrderEditTransaction {
  id: string;
  parentId: string | null;
  kind: string;
  status: string;
  gateway: string;
  amountCents: number;
  manual: boolean;
}

export interface OrderEditRefund {
  id: string;
  note: string | null;
  amountCents: number;
  transactions: OrderEditTransaction[];
}

/** JSON-safe persisted evidence. Amounts are exact USD integer cents. */
export interface OrderEditSnapshot {
  /** Optional read-only pricing evidence for provisional previews; excluded from legacy fingerprints. */
  previewProductDiscounts?: Array<{
    lineId: string;
    amountCents: number;
    automaticCents: number;
  }>;
  /** Optional only for operations saved before shipping repricing was introduced. */
  shippingContext?: import("./order-edit-shipping").OrderEditShippingContext;
  /** Optional for legacy saved operations; enrichment does not alter their identity fingerprint. */
  financials?: OrderEditFinancials;
  discountRules?: OrderEditDiscountRule[];
  paymentDates?: Record<string, string | null>;
  connectionId: number;
  channelId: number;
  orderId: string;
  name: string;
  customerId: string | null;
  currency: "USD";
  updatedAt: string;
  editable: boolean;
  editableErrors: string[];
  cancelled: boolean;
  closed: boolean;
  fullyPaid: boolean;
  totalCents: number;
  outstandingCents: number;
  subtotalCents: number;
  taxCents: number;
  netPaidCents: number;
  capturableCents: number;
  shippingCents: number;
  paymentUrl: string | null;
  memberPlan: string | null;
  memberPricingEnabled: boolean;
  discountsPresent: boolean;
  lines: OrderEditLine[];
  transactions: OrderEditTransaction[];
  refunds: OrderEditRefund[];
  contentFingerprint: string;
  fingerprint: string;
  evidence: Record<string, unknown>;
}

export interface OrderEditPlan {
  changes: Array<{ lineItemId: string; quantity: number }>;
  additions: Array<{ variantId: string; quantity: number }>;
}

export interface OrderEditExpectedLine {
  title: string;
  variantTitle: string | null;
  originalLineId: string | null;
  /** The added quantity fulfills an increase on this unchanged original line. */
  quantityIncreaseOfLineId?: string;
  calculatedLineId: string;
  variantId: string;
  quantity: number;
  originalUnitPriceCents: number;
  discountedUnitPriceCents: number;
  totalCents: number;
}

export interface OrderEditQuote {
  shippingRepricing?: import("@shared/order-edits/order-edit-shipping").OrderEditShippingRepricing;
  financials?: OrderEditFinancials;
  connectionId: number;
  channelId: number;
  orderId: string;
  operationId: string;
  calculatedOrderId: string;
  sessionId: string;
  baselineFingerprint: string;
  baseline: OrderEditSnapshot;
  plan: OrderEditPlan;
  lines: OrderEditExpectedLine[];
  totalCents: number;
  outstandingCents: number;
  deltaCents: number;
  shippingCents: number;
  createdAt: string;
  evidence: Record<string, unknown>;
}

export interface OrderEditVariant {
  id: string;
  title: string;
  sku: string | null;
  priceCents: number;
  available: boolean;
  availableQuantity: number;
}

export interface OrderEditRefundIntent {
  connectionId: number;
  channelId: number;
  orderId: string;
  operationId: string;
  idempotencyKey: string;
  currency: "USD";
  amountCents: number;
  parentTransactionId: string;
  gateway: string;
  note: string;
  contentFingerprint: string;
}

export type OrderEditRefundResult = {
  status: "succeeded" | "pending";
  refundId: string;
  evidence: OrderEditRefund;
};

export class OrderEditProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly outcome: "rejected" | "unknown" = "rejected",
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "OrderEditProviderError";
  }
}

/** The provider proves that orderEditCommit was never invoked for this attempt. */
export class OrderEditCommitNotSentError extends OrderEditProviderError {
  constructor(
    code: string,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(code, message, "rejected", context);
    this.name = "OrderEditCommitNotSentError";
  }
}

export interface OrderEditProvider {
  readOrder(
    connectionId: number,
    externalOrderId: string,
  ): Promise<OrderEditSnapshot>;
  searchVariants(
    connectionId: number,
    search: string,
  ): Promise<OrderEditVariant[]>;
  /** Stage and verify a preview only; never commit the order or move money. */
  quote(
    connectionId: number,
    snapshot: OrderEditSnapshot,
    plan: OrderEditPlan,
    operationId: string,
  ): Promise<OrderEditQuote>;
  commit(
    connectionId: number,
    quote: OrderEditQuote,
    operationId: string,
  ): Promise<OrderEditSnapshot>;
  reconcileCommit(
    connectionId: number,
    baseline: OrderEditSnapshot,
    quote: OrderEditQuote,
    operationId: string,
  ): Promise<{
    status: "applied" | "not_applied" | "conflict";
    snapshot: OrderEditSnapshot;
  }>;
  prepareRefund(
    connectionId: number,
    snapshot: OrderEditSnapshot,
    operationId: string,
    idempotencyKey: string,
  ): Promise<OrderEditRefundIntent>;
  refund(
    connectionId: number,
    intent: OrderEditRefundIntent,
    firstAttemptAt: string,
  ): Promise<OrderEditRefundResult>;
  recoverUnpaid(
    connectionId: number,
    baseline: OrderEditSnapshot,
    quote: OrderEditQuote,
    operationId: string,
  ): Promise<OrderEditSnapshot>;
  reconcileRecovery(
    connectionId: number,
    baseline: OrderEditSnapshot,
    operationId: string,
    quote?: OrderEditQuote,
  ): Promise<{ status: "restored" | "conflict"; snapshot: OrderEditSnapshot }>;
}
import type { OrderEditFinancials } from "@shared/order-edits/order-edit-financials";

export interface OrderEditDiscountRule {
  index: number;
  type: string;
  targetType: string;
  allocationMethod: string;
  targetSelection: string;
  label: string;
  value:
    | { type: "percentage"; percentage: number }
    | { type: "fixed"; amountCents: number };
}
