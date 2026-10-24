import { z } from "zod";
import type { OrderEditSnapshot } from "../application/order-edit-provider";
import {
  orderEditQuoteSchema,
  orderEditRefundIntentSchema,
  orderEditSnapshotSchema,
} from "../application/order-edit-provider.schema";
import { matchesOrderEditQuote } from "../application/order-edit-evidence";
import { OrderEditError } from "../domain/order-edit-error";
import {
  matchingRefund,
  proveRefund,
} from "./shopify-order-edit-refund-evidence";

const documentSchema = z.object({
  id: z.string().uuid(),
  omsOrderId: z.number().int().positive(),
  connectionId: z.number().int().positive(),
  actorId: z.string().min(1),
  status: z.literal("synchronizing"),
  kind: z.string().optional(),
  commitStartedAt: z.string().datetime(),
  refundStartedAt: z.string().datetime(),
  refundIntent: orderEditRefundIntentSchema,
  quote: orderEditQuoteSchema,
  baseline: orderEditSnapshotSchema,
  lastSnapshot: orderEditSnapshotSchema,
});

/** The same native refund proof used by settlement; this never issues a command. */
export function proveStoppedRefundEditRecovery(input: {
  operationId: string;
  omsOrderId: number;
  document: unknown;
  snapshot: OrderEditSnapshot;
}) {
  const document = documentSchema.parse(input.document);
  const snapshot = orderEditSnapshotSchema.parse(input.snapshot);
  const { quote, refundIntent } = document;
  if (
    document.id !== input.operationId ||
    document.omsOrderId !== input.omsOrderId ||
    document.kind === "cancel_order" ||
    document.connectionId !== snapshot.connectionId ||
    quote.operationId !== document.id ||
    quote.baselineFingerprint !== document.baseline.fingerprint ||
    quote.deltaCents >= 0 ||
    refundIntent.operationId !== document.id ||
    refundIntent.connectionId !== snapshot.connectionId ||
    refundIntent.channelId !== snapshot.channelId ||
    refundIntent.orderId !== snapshot.orderId ||
    refundIntent.amountCents !== -quote.deltaCents ||
    refundIntent.contentFingerprint !== snapshot.contentFingerprint ||
    document.lastSnapshot.fingerprint !== snapshot.fingerprint ||
    !matchesOrderEditQuote(snapshot, quote) ||
    snapshot.cancelled ||
    snapshot.closed ||
    !snapshot.fullyPaid ||
    snapshot.netPaidCents !== snapshot.totalCents ||
    snapshot.outstandingCents !== 0 ||
    snapshot.capturableCents !== 0 ||
    snapshot.lines.every((line) => line.quantity === 0) ||
    snapshot.lines.some(
      (line) =>
        line.quantity !== line.unfulfilledQuantity ||
        (line.quantity > 0 && line.unsupported),
    ) ||
    [
      ...snapshot.transactions,
      ...snapshot.refunds.flatMap((refund) => refund.transactions),
    ].some((tx) => !["SUCCESS", "FAILURE", "ERROR"].includes(tx.status))
  ) {
    throw new OrderEditError(
      "ORDER_EDIT_STOPPED_RECOVERY_UNPROVEN",
      "The stopped warehouse work does not match a settled, unfulfilled refund edit.",
    );
  }
  const refund = matchingRefund(snapshot.refunds, refundIntent);
  if (!refund || proveRefund(refund, refundIntent).status !== "succeeded")
    throw new OrderEditError(
      "ORDER_EDIT_STOPPED_RECOVERY_UNPROVEN",
      "The existing refund has not been proven successful.",
    );
  return {
    connectionId: document.connectionId,
    actorId: document.actorId,
    refundId: refund.id,
  };
}
