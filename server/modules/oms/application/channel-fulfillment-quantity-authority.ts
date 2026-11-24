import { z } from "zod";
import { deriveRefundAuthority } from "./refund-line-disposition";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const quantity = z.number().int().min(0).max(POSTGRES_INTEGER_MAX);
const evidenceSchema = z.object({
  lifetimePaidQuantity: quantity,
  paidQuantity: quantity,
  channelRemainingQuantity: quantity,
  cancelledQuantity: quantity,
  refundedQuantity: quantity,
  refundCancelQuantity: quantity,
  refundOtherQuantity: quantity,
  useChannelQuantities: z.boolean().optional(),
  channelCurrentQuantity: quantity.nullable().optional(),
  channelQuantityUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).strict().superRefine((input, context) => {
  if (input.paidQuantity > input.lifetimePaidQuantity
    || input.channelRemainingQuantity > input.paidQuantity) {
    context.addIssue({ code: "custom", message: "Current quantities exceed proven paid authority" });
  }
  if (input.refundedQuantity !== input.refundCancelQuantity + input.refundOtherQuantity) {
    context.addIssue({ code: "custom", message: "Refund counter and line dispositions disagree" });
  }
  if (input.useChannelQuantities && (input.channelCurrentQuantity == null
    || input.channelQuantityUpdatedAt == null
    || input.channelCurrentQuantity > input.paidQuantity || input.channelRemainingQuantity > input.channelCurrentQuantity)) {
    context.addIssue({ code: "custom", message: "Verified channel merchandise and paid dispatch authority disagree" });
  }
  if (Math.max(input.cancelledQuantity, input.refundCancelQuantity) + input.refundOtherQuantity
    > (input.useChannelQuantities ? input.lifetimePaidQuantity : input.paidQuantity)) {
    context.addIssue({ code: "custom", message: "Line dispositions exceed paid quantity" });
  }
});

export type ChannelFulfillmentQuantityEvidence = z.infer<typeof evidenceSchema>;
export type ChannelFulfillmentQuantityAuthority = Readonly<ChannelFulfillmentQuantityEvidence & {
  commercialAuthorizedQuantity: number;
  quantityCancelled: number;
}>;

export class ChannelFulfillmentQuantityAuthorityError extends Error {
  readonly code = "INVALID_CHANNEL_FULFILLMENT_QUANTITY_AUTHORITY";
  constructor(readonly context: Readonly<{ issues: readonly z.ZodIssue[] }>) {
    super("Channel fulfillment requires consistent paid, cancellation, and refund evidence");
    this.name = "ChannelFulfillmentQuantityAuthorityError";
  }
}

/**
 * Physical shipped quantity is cumulative. Shopify's fulfillable_quantity is
 * remaining work, not a lifetime cap or a cancellation count. Use current paid
 * authority minus explicit commercial dispositions; never restore authority
 * from a historical maximum or infer fulfillment from depleted remaining work.
 * The provider executor separately verifies this exact package and live remaining
 * quantity in the originating account/warehouse immediately before writeback.
 */
export function deriveChannelFulfillmentQuantityAuthority(
  raw: unknown,
): ChannelFulfillmentQuantityAuthority {
  const parsed = evidenceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ChannelFulfillmentQuantityAuthorityError(Object.freeze({ issues: parsed.error.issues }));
  }
  const evidence = parsed.data;
  const disposition = deriveRefundAuthority({
    ...evidence,
    previousAuthorityFulfillableQuantity: evidence.paidQuantity,
    channelCurrentQuantity: evidence.useChannelQuantities ? evidence.channelCurrentQuantity : null,
  });
  return Object.freeze({
    ...evidence,
    commercialAuthorizedQuantity: disposition.authorityFulfillableQuantity,
    quantityCancelled: evidence.lifetimePaidQuantity - disposition.authorityFulfillableQuantity,
  });
}
