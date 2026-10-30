import { z } from "zod";
import { customerReturnLabelSubmitInputSchema } from "@shared/returns/customer-return-label.contract";
import { customerReturnWorkflowPhaseSchema, customerReturnWorkflowReasonSchema } from "@shared/returns/customer-return-workflow.contract";
import { customerReturnCanonicalOrderScopeSchema } from "./customer-return-order-access.service";
import type { CustomerReturnCustomerPrincipal } from "./customer-return-customer-operations.service";

export const returnWorkflowRecordSchema = z.object({
  request: customerReturnLabelSubmitInputSchema,
  scope: customerReturnCanonicalOrderScopeSchema,
  actor: z.string().trim().min(1).max(255),
  phase: customerReturnWorkflowPhaseSchema,
  reason: customerReturnWorkflowReasonSchema.nullable(),
  authorizationId: z.number().int().positive().safe().nullable(),
  failures: z.number().int().min(0).max(6),
  explicitRetry: z.boolean(),
  leaseToken: z.string().uuid().nullable(),
  updatedAt: z.coerce.date(),
}).strict();
export type ReturnWorkflowRecord = z.infer<typeof returnWorkflowRecordSchema>;
export interface ReturnWorkflowTransition {
  phase: ReturnWorkflowRecord["phase"];
  reason: ReturnWorkflowRecord["reason"];
  authorizationId: number | null;
  failures: number;
  nextRunAt: Date;
  errorCode: string | null;
}
export interface CustomerReturnWorkflowStore {
  enqueue(input: { request: ReturnWorkflowRecord["request"]; scope: ReturnWorkflowRecord["scope"]; actor: string; now: Date; authorizationId?: number }): Promise<ReturnWorkflowRecord>;
  acceptedRequest(principal: CustomerReturnCustomerPrincipal, authorizationId: number): Promise<{ request: ReturnWorkflowRecord["request"]; scope: ReturnWorkflowRecord["scope"] } | null>;
  readOwned(principal: CustomerReturnCustomerPrincipal, key: string): Promise<ReturnWorkflowRecord | null>;
  readOwnedOrder(principal: CustomerReturnCustomerPrincipal, omsOrderId: number): Promise<ReturnWorkflowRecord | null>;
  readOwnedAuthorization(principal: CustomerReturnCustomerPrincipal, authorizationId: number): Promise<ReturnWorkflowRecord | null>;
  retryOwned(principal: CustomerReturnCustomerPrincipal, key: string, now: Date): Promise<ReturnWorkflowRecord | null>;
  claim(limit: number, token: string, now: Date): Promise<readonly ReturnWorkflowRecord[]>;
  settle(record: ReturnWorkflowRecord, result: ReturnWorkflowTransition, now: Date): Promise<boolean>;
}
