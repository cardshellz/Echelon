import { z } from "zod";
import type { CustomerOrderActionSnapshot, CustomerOrderActionPage } from "@shared/customer-account/order-actions";
import type { CustomerAccountOrderSummariesInput } from "@shared/customer-account/customer-account-orders";

export const orderActionScopeSchema = z.object({
  omsOrderId: z.number().int().positive().safe(),
  channelId: z.number().int().positive().safe(),
  connectionId: z.number().int().positive().safe(),
  externalOrderId: z.string().regex(/^[1-9][0-9]*$/).max(30),
  externalCustomerId: z.string().regex(/^[1-9][0-9]*$/).max(30),
  orderReference: z.string().min(1).max(50),
  generation: z.string().regex(/^[1-9][0-9]*$/),
  leaseId: z.string().uuid(),
  attempts: z.number().int().nonnegative().safe(),
}).strict();
export type OrderActionScope = z.infer<typeof orderActionScopeSchema>;

export interface OrderActionProjectionReader {
  read(input: CustomerAccountOrderSummariesInput & { channelId: number; externalCustomerId: string }, now: Date): Promise<CustomerOrderActionPage>;
}
export interface OrderActionProjectionStore extends OrderActionProjectionReader {
  drainInvalidations(limit: number): Promise<number>;
  seed(limit: number): Promise<number>;
  claim(limit: number, now: Date, leaseId: string): Promise<OrderActionScope[]>;
  complete(scope: OrderActionScope, snapshot: CustomerOrderActionSnapshot, now: Date, validUntil: Date,
    failureClass?: "permanent" | "transient"): Promise<boolean>;
  fail(scope: OrderActionScope, now: Date, retryAt: Date, code: string): Promise<void>;
}
export interface OrderActionProjectionInspector {
  inspect(scope: OrderActionScope): Promise<CustomerOrderActionSnapshot & { failureClass?: "permanent" | "transient" }>;
}
