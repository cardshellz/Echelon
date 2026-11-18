import { z } from "zod";
import {
  customerOrderProgressSchema,
  customerRefundActivitiesSchema,
  type CustomerOrderProgress,
} from "@shared/customer-account/order-progress";
import {
  customerAccountProgressScopeSchema,
  type CustomerAccountProgressReader,
  type CustomerAccountDeliveryProgressReader,
  type CustomerAccountReturnProgressReader,
  type CustomerAccountCancellationRefundReader,
} from "./customer-account-progress.ports";

/** Combines query-only owner projections. A delivery outage never fabricates an
 * empty return history, hides native payment facts, or prevents reading receipts. */
export class CustomerAccountProgressService
  implements CustomerAccountProgressReader
{
  constructor(
    private readonly dependencies: {
      delivery: CustomerAccountDeliveryProgressReader;
      returns: CustomerAccountReturnProgressReader;
      cancellations?: CustomerAccountCancellationRefundReader;
      report(event: { code: string }): void;
    },
  ) {}
  async read(
    raw: Parameters<CustomerAccountProgressReader["read"]>[0],
    instant: Date,
  ) {
    const scope = customerAccountProgressScopeSchema.parse(raw),
      now = z.date().parse(instant);
    const output = new Map<number, CustomerOrderProgress>();
    if (!scope.orders.length) return output;
    const [delivery, returns, cancellations] = await Promise.allSettled([
      this.dependencies.delivery.read(scope, now),
      this.dependencies.returns.read(scope, now),
      this.dependencies.cancellations?.read(scope, now) ?? Promise.resolve(new Map<number, CustomerOrderProgress["refunds"]>(scope.orders.map(order => [order.omsOrderId, []]))),
    ]);
    for (const [track, result] of [
      ["delivery", delivery],
      ["returns", returns],
      ["cancellation_refunds", cancellations],
    ] as const) {
      if (result.status === "rejected")
        this.dependencies.report({
          code: `CUSTOMER_ACCOUNT_${track.toUpperCase()}_PROGRESS_UNAVAILABLE`,
        });
      else if (
        [...result.value.keys()].some(
          (id) => !scope.orders.some((order) => order.omsOrderId === id),
        )
      )
        throw new Error(
          "Progress owner returned an unrequested order identity.",
        );
    }
    for (const order of scope.orders) {
      const cancellationRefunds = cancellations.status === "fulfilled"
        ? customerRefundActivitiesSchema.safeParse(cancellations.value.get(order.omsOrderId)) : null;
      let shipping =
        delivery.status === "fulfilled"
          ? delivery.value.get(order.omsOrderId)
          : undefined;
      let returned =
        returns.status === "fulfilled"
          ? returns.value.get(order.omsOrderId)
          : undefined;
      if (
        shipping &&
        !customerOrderProgressSchema.safeParse({
          ...shipping,
          returns: [],
          refunds: [],
        }).success
      ) {
        shipping = undefined;
        this.dependencies.report({
          code: "CUSTOMER_ACCOUNT_DELIVERY_PROGRESS_INVALID",
        });
      }
      if (
        returned &&
        !customerOrderProgressSchema.safeParse({
          ...returned,
          delivery: null,
          packages: [],
        }).success
      ) {
        returned = undefined;
        this.dependencies.report({
          code: "CUSTOMER_ACCOUNT_RETURNS_PROGRESS_INVALID",
        });
      }
      const refunds = customerRefundActivitiesSchema.safeParse([...(returned?.refunds ?? []), ...(cancellationRefunds?.success ? cancellationRefunds.data : [])]);
      const uniqueRefunds = refunds.success && new Set(refunds.data.map(item => item.key)).size === refunds.data.length;
      const refundsUnavailable = returned === undefined || !cancellationRefunds?.success || !uniqueRefunds;
      if (!uniqueRefunds) this.dependencies.report({ code: "CUSTOMER_ACCOUNT_REFUND_PROGRESS_INVALID" });
      output.set(
        order.omsOrderId,
        customerOrderProgressSchema.parse({
          delivery: shipping?.delivery ?? null,
          packages: shipping?.packages ?? [],
          returns: returned?.returns ?? [],
          refunds: !refundsUnavailable && refunds.success ? refunds.data : [],
          unavailable: [...new Set([
            ...(!shipping ? ["delivery"] : []),
            ...(returned === undefined ? ["returns", "refunds"] : []),
            ...(!cancellationRefunds?.success || !uniqueRefunds ? ["refunds"] : []),
          ])],
        }),
      );
    }
    return output;
  }
}
