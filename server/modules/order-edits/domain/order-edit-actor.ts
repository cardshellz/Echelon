import { z } from "zod";
import { OrderEditError } from "./order-edit-error";

const customerSchema = z.object({
  channelId: z.number().int().positive().safe(),
  externalCustomerId: z.string().max(30).regex(/^[1-9][0-9]*$/),
}).strict();
export type OrderEditCustomerActor = z.infer<typeof customerSchema>;

/** Same channel + Shopify customer identity used by the existing returns audit.
 * This is an audit/cache identity, never a credential or a local staff user. */
export function customerOrderEditActorId(raw: OrderEditCustomerActor): string {
  const value = customerSchema.parse(raw);
  return `customer:${value.channelId}:${value.externalCustomerId}`;
}

export function readCustomerOrderEditActor(actorId: string): OrderEditCustomerActor | null {
  if (!actorId.startsWith("customer:")) return null;
  const match = /^customer:([1-9][0-9]*):([1-9][0-9]*)$/.exec(actorId);
  const parsed = match ? customerSchema.safeParse({ channelId: Number(match[1]), externalCustomerId: match[2] }) : null;
  if (!parsed?.success) throw new OrderEditError("ORDER_EDIT_ACTOR_INVALID", "The order edit identity could not be verified.", 403);
  return parsed.data;
}

export function orderEditAuditActor(actorId: string | null): {
  staffId: string | null; customerChannelId: number | null; externalCustomerId: string | null;
} {
  if (actorId === null) return { staffId: null, customerChannelId: null, externalCustomerId: null };
  z.string().min(1).max(255).parse(actorId);
  const customer = readCustomerOrderEditActor(actorId);
  return customer
    ? { staffId: null, customerChannelId: customer.channelId, externalCustomerId: customer.externalCustomerId }
    : { staffId: actorId, customerChannelId: null, externalCustomerId: null };
}
