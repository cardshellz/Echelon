import { z } from "zod";
import { customerReturnOrderChoicesSchema } from "@shared/returns/customer-return-access.contract";
import type { CustomerReturnCustomerOrdersService } from "./customer-return-customer-orders.service";
import type { CustomerReturnOrderAccessService } from "./customer-return-order-access.service";

/** Reuse the existing chooser and return history. Its entire order universe is
 * the one purchase in the email grant; there is no customer-wide email search.
 * Eligibility is checked by the canonical order/review/submit services, not by
 * adding provider calculations to this navigation lookup. */
export class CustomerReturnGuestOrdersService {
  constructor(private readonly dependencies: { omsOrderId: number; access: Pick<CustomerReturnOrderAccessService, "resolveOwned">;
    orders: Pick<CustomerReturnCustomerOrdersService, "order" | "review"> }) {}
  async choices(raw: unknown) {
    const input = z.object({ beforeOmsOrderId: z.number().int().positive().safe().optional() }).strict().parse(raw);
    const order = await this.dependencies.access.resolveOwned({ omsOrderId: this.dependencies.omsOrderId });
    const include = !order.cancelledAt && (input.beforeOmsOrderId === undefined || order.omsOrderId < input.beforeOmsOrderId);
    return customerReturnOrderChoicesSchema.parse({ orders: include ? [{ omsOrderId: order.omsOrderId,
      orderReference: order.externalOrderNumber, purchasedAt: null, eligibleItemCount: null }] : [],
      nextBeforeOmsOrderId: null, unavailableOrderCount: 0 });
  }
  order(id: number) { return this.dependencies.orders.order(id); }
  review(id: number, raw: unknown) { return this.dependencies.orders.review(id, raw); }
}
