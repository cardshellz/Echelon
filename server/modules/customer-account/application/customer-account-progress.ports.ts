import { z } from "zod";
import type { CustomerOrderProgress } from "@shared/customer-account/order-progress";

export const customerAccountProgressScopeSchema = z
  .object({
    channelId: z.number().int().positive().safe(),
    externalCustomerId: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .max(30),
    orders: z
      .array(
        z
          .object({
            omsOrderId: z.number().int().positive().safe(),
            externalOrderId: z
              .string()
              .regex(/^[1-9][0-9]*$/)
              .max(30),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .superRefine((scope, context) => {
    if (
      new Set(scope.orders.map((o) => o.omsOrderId)).size !==
        scope.orders.length ||
      new Set(scope.orders.map((o) => o.externalOrderId)).size !==
        scope.orders.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate order identities are not allowed.",
      });
  });
export type CustomerAccountProgressScope = z.infer<
  typeof customerAccountProgressScopeSchema
>;
export type CustomerOrderDeliveryProgress = Pick<
  CustomerOrderProgress,
  "delivery" | "packages"
>;
export interface CustomerAccountDeliveryProgressReader {
  read(
    scope: CustomerAccountProgressScope,
    now: Date,
  ): Promise<ReadonlyMap<number, CustomerOrderDeliveryProgress>>;
}
export interface CustomerAccountReturnProgressReader {
  read(
    scope: CustomerAccountProgressScope,
    now: Date,
  ): Promise<
    ReadonlyMap<number, Pick<CustomerOrderProgress, "returns" | "refunds">>
  >;
}
export interface CustomerAccountProgressReader {
  read(
    scope: CustomerAccountProgressScope,
    now: Date,
  ): Promise<ReadonlyMap<number, CustomerOrderProgress>>;
}
