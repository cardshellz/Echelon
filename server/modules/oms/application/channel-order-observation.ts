import { z } from "zod";

const id = z.number().int().positive().safe();
const quantity = z.number().int().nonnegative().max(2_147_483_647);
const cents = quantity;
export const channelOrderIdentitySchema = z.object({
  channelId: id, provider: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
  externalOrderId: z.string().trim().min(1).max(100),
});
export const channelOrderObservationSchema = channelOrderIdentitySchema.extend({
  orderId: id, actor: z.string().trim().min(1), observedAt: z.date(),
  sourceEventId: z.string().min(1), status: z.enum(["confirmed", "cancelled"]),
  fulfillmentStatus: z.enum(["unfulfilled", "fulfilled"]),
  subtotalCents: cents, shippingCents: cents, taxCents: cents, totalCents: cents,
  rawPayload: z.unknown(),
  lines: z.array(z.object({
    externalLineItemId: z.string().min(1).max(100), quantity: quantity.positive(),
    cancelledQuantity: quantity, paidPriceCents: cents, totalCents: cents,
    providerStates: z.unknown(),
  }).refine(line => line.cancelledQuantity <= line.quantity, "Cancellation exceeds ordered quantity")).min(1),
}).superRefine((input, context) => {
  if (new Set(input.lines.map(line => line.externalLineItemId)).size !== input.lines.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Observation contains duplicate line identities" });
  }
});

export type ChannelOrderIdentity = z.infer<typeof channelOrderIdentitySchema>;
export type ChannelOrderObservation = z.infer<typeof channelOrderObservationSchema>;
/** OMS owns persisted financial/disposition comparisons and all resulting writes. */
export interface ChannelOrderObservationWriter {
  findOrder(identity: ChannelOrderIdentity): Promise<number | null>;
  reconcile(observation: ChannelOrderObservation): Promise<void>;
}
export class ChannelOrderObservationError extends Error {
  constructor(readonly code: "OMS_ORDER_IDENTITY_AMBIGUOUS" | "OMS_ORDER_MISSING" | "OMS_ORDER_FINANCIAL_DRIFT" | "OMS_ORDER_AUTHORITY_CONFLICT", message: string) {
    super(message);
    this.name = "ChannelOrderObservationError";
  }
}
export interface ChannelOrderLineDisposition {
  quantity: number; cancelled_quantity: number; refunded_quantity: number;
  authority_fulfillable_quantity: number; authorization_status: string;
}
export function reconcileChannelOrderLineDisposition(
  line: ChannelOrderObservation["lines"][number], before: ChannelOrderLineDisposition,
): ChannelOrderLineDisposition {
  const cancelled = line.cancelledQuantity;
  if (before.quantity !== line.quantity || before.cancelled_quantity > cancelled || before.refunded_quantity > 0) {
    throw new ChannelOrderObservationError("OMS_ORDER_AUTHORITY_CONFLICT", "Provider order conflicts with an existing quantity, cancellation or refund disposition");
  }
  return { ...before, cancelled_quantity: cancelled,
    authority_fulfillable_quantity: Math.min(before.authority_fulfillable_quantity, before.quantity - cancelled),
    authorization_status: cancelled === before.quantity ? "cancelled" : cancelled > 0 ? "partially_cancelled" : before.authorization_status };
}
