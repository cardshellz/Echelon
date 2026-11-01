import { z } from "zod";
import {
  customerOrderProgressSchema,
  type CustomerOrderProgress,
} from "@shared/customer-account/order-progress";
import {
  customerAccountProgressScopeSchema,
  type CustomerAccountProgressReader,
  type CustomerAccountDeliveryProgressReader,
  type CustomerAccountReturnProgressReader,
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
    const [delivery, returns] = await Promise.allSettled([
      this.dependencies.delivery.read(scope, now),
      this.dependencies.returns.read(scope, now),
    ]);
    for (const [track, result] of [
      ["delivery", delivery],
      ["returns", returns],
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
      output.set(
        order.omsOrderId,
        customerOrderProgressSchema.parse({
          delivery: shipping?.delivery ?? null,
          packages: shipping?.packages ?? [],
          returns: returned?.returns ?? [],
          refunds: returned?.refunds ?? [],
          unavailable: [
            ...(!shipping ? ["delivery"] : []),
            ...(returned === undefined ? ["returns", "refunds"] : []),
          ],
        }),
      );
    }
    return output;
  }
}
