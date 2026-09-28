import { z } from "zod";
import { customerReturnFlowOrderSchema, customerReturnFlowReviewInputSchema, customerReturnFlowReviewSchema } from "@shared/returns/customer-return-flow.contract";
import { customerReturnCustomerOrderSchema, customerReturnCustomerOrderPageSchema } from "@shared/returns/customer-return-access.contract";
import type { CustomerReturnCustomerSession } from "./customer-return-customer-auth.service";
import type { CustomerReturnOrderAccessService } from "./customer-return-order-access.service";
import type { CustomerReturnLiveService } from "./customer-return-live.service";

export const customerReturnCustomerReviewInputSchema = customerReturnFlowReviewInputSchema.omit({ orderReference: true }).strict();
export class CustomerReturnCustomerOrdersService {
  constructor(private readonly dependencies: {
    principal: Pick<CustomerReturnCustomerSession, "channelId" | "externalCustomerId">;
    access: Pick<CustomerReturnOrderAccessService, "list" | "resolveOwned">;
    live: Pick<CustomerReturnLiveService, "lookupCanonical" | "reviewCanonical">;
    shippingVersion: () => Promise<number | null>;
    reportUnavailableOrder: (context: { channelId: number; omsOrderId: number; reason: "invalid_response" | "inspection_failed" }) => void;
  }) {}

  async list(raw: unknown) {
    const input = z.object({ beforeOmsOrderId: z.number().int().positive().safe().optional() }).strict().parse(raw);
    const page = await this.dependencies.access.list({ ...input, pageSize: 10 });
    const orders = [];
    let unavailableOrderCount = 0;
    const version = await this.dependencies.shippingVersion();
    // An unverifiable order is excluded, with an explicit incomplete-page signal.
    // It must neither expose unverified data nor hide other verified eligible orders.
    for (let i = 0; i < page.orders.length; i += 2) {
      const batch = await Promise.all(page.orders.slice(i, i + 2).map(async order => {
        const scope = { ...this.dependencies.principal, omsOrderId: order.omsOrderId, externalOrderId: order.externalOrderId };
        try {
          const { mode: _mode, ...fields } = await this.dependencies.live.lookupCanonical(scope);
          return customerReturnCustomerOrderSchema.parse({ omsOrderId: order.omsOrderId,
            order: customerReturnFlowOrderSchema.parse(fields), settingsVersion: version });
        } catch (error) {
          this.dependencies.reportUnavailableOrder({ channelId: scope.channelId, omsOrderId: scope.omsOrderId,
            reason: error instanceof z.ZodError ? "invalid_response" : "inspection_failed" });
          return null;
        }
      }));
      for (const item of batch) {
        if (item === null) unavailableOrderCount += 1;
        else if (item.order.lines.some(line => line.eligibleQuantity > 0)) orders.push(item);
      }
    }
    return customerReturnCustomerOrderPageSchema.parse({ orders, nextBeforeOmsOrderId: page.nextBeforeOmsOrderId, unavailableOrderCount });
  }

  async order(omsOrderId: number) {
    const owned = await this.dependencies.access.resolveOwned({ omsOrderId });
    const scope = { ...this.dependencies.principal, omsOrderId: owned.omsOrderId, externalOrderId: owned.externalOrderId };
    const { mode: _mode, ...fields } = await this.dependencies.live.lookupCanonical(scope);
    return customerReturnCustomerOrderSchema.parse({ omsOrderId: owned.omsOrderId,
      order: customerReturnFlowOrderSchema.parse(fields), settingsVersion: await this.dependencies.shippingVersion() });
  }

  async review(omsOrderId: number, raw: unknown) {
    const input = customerReturnCustomerReviewInputSchema.parse(raw);
    const owned = await this.dependencies.access.resolveOwned({ omsOrderId });
    const scope = { ...this.dependencies.principal, omsOrderId: owned.omsOrderId, externalOrderId: owned.externalOrderId };
    const { mode: _mode, ...review } = await this.dependencies.live.reviewCanonical({ ...input,
      channelId: owned.channelId, orderReference: owned.externalOrderNumber }, scope);
    return customerReturnFlowReviewSchema.parse(review);
  }
}
