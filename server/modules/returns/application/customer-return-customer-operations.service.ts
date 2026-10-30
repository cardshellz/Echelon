import { customerReturnWorkflowStatusSchema, customerReturnWorkflowResumeSchema } from "@shared/returns/customer-return-workflow.contract";
import type { CustomerReturnWorkflowStore, ReturnWorkflowRecord } from "./customer-return-workflow.ports";
import { z } from "zod";
import {
  CUSTOMER_RETURN_CUSTOMER_API,
  customerReturnCustomerLabelStatusSchema,
  customerReturnCustomerSubmitInputSchema,
  customerReturnCustomerHistoryInputSchema,
  customerReturnCustomerHistoryItemSchema,
  customerReturnCustomerHistorySchema,
  type CustomerReturnCustomerLabelStatus,
} from "@shared/returns/customer-return-customer.contract";
import { customerReturnLabelStatusSchema } from "@shared/returns/customer-return-label.contract";
import {
  customerReturnCanonicalOrderScopeSchema,
  customerReturnOrderAccessResultSchema,
  type CustomerReturnCanonicalOrderScope,
  type CustomerReturnOrderAccessService,
} from "./customer-return-order-access.service";
import { CustomerReturnIntakeError } from "./customer-return-intake.ports";
import type { CustomerReturnSubmissionService } from "./customer-return-submission.service";
import type { CustomerReturnLabelsService } from "./customer-return-labels.service";

const id = z.number().int().positive().safe();
export const customerReturnCustomerPrincipalSchema = customerReturnCanonicalOrderScopeSchema
  .omit({ omsOrderId: true, externalOrderId: true }).strict();
export type CustomerReturnCustomerPrincipal = z.infer<typeof customerReturnCustomerPrincipalSchema>;
export const customerReturnOwnedAuthorizationSchema = z.object({ authorizationId: id, omsOrderId: id }).strict();
export const customerReturnOwnedCommandSchema = z.object({ omsOrderId: id, authorizationId: id.nullable() }).strict();

/** Read ports must apply channel AND customer ownership in SQL, never just the resource ID. */
export interface CustomerReturnCustomerOwnershipReader {
  listReturns(principal: CustomerReturnCustomerPrincipal, input: z.infer<typeof customerReturnCustomerHistoryInputSchema>): Promise<readonly z.infer<typeof customerReturnCustomerHistoryItemSchema>[]>;
  readOwnedAuthorization(principal: CustomerReturnCustomerPrincipal, authorizationId: number): Promise<z.infer<typeof customerReturnOwnedAuthorizationSchema> | null>;
  readOwnedCommand(principal: CustomerReturnCustomerPrincipal, idempotencyKey: string): Promise<z.infer<typeof customerReturnOwnedCommandSchema> | null>;
}
export interface CustomerReturnCustomerOperationsDependencies {
  /** The composition supplies this only after verifying the current customer session. */
  principal: CustomerReturnCustomerPrincipal;
  orderAccess: Pick<CustomerReturnOrderAccessService, "resolveOwned">;
  ownership: CustomerReturnCustomerOwnershipReader;
  submissions: Pick<CustomerReturnSubmissionService, "submitForOrder" | "resumeForOrder" | "status">;
  labels: Pick<CustomerReturnLabelsService, "status" | "progress" | "artifact">;
  workflows?: CustomerReturnWorkflowStore;
  now?: () => Date;
}

/** Request-scoped public boundary; existing staff authorization is intentionally unchanged. */
export class CustomerReturnCustomerOperationsService {
  private readonly principal: Readonly<CustomerReturnCustomerPrincipal>;
  private readonly actor: string;
  constructor(private readonly dependencies: CustomerReturnCustomerOperationsDependencies) {
    this.principal = Object.freeze(customerReturnCustomerPrincipalSchema.parse(dependencies.principal));
    this.actor = `customer:${this.principal.channelId}:${this.principal.externalCustomerId}`;
  }

  async listReturns(raw: unknown = {}) {
    const input = parseInput(customerReturnCustomerHistoryInputSchema, raw);
    const rows = z.array(customerReturnCustomerHistoryItemSchema).max(input.pageSize + 1)
      .parse(await this.dependencies.ownership.listReturns(this.principal, input));
    if (rows.some((row, index) => (input.beforeAuthorizationId !== undefined && row.authorizationId >= input.beforeAuthorizationId)
      || (index > 0 && row.authorizationId >= rows[index - 1].authorizationId))) throw customerReturnUnavailable();
    const page = rows.slice(0, input.pageSize);
    return customerReturnCustomerHistorySchema.parse({ returns: page,
      nextBeforeAuthorizationId: rows.length > input.pageSize ? page[page.length - 1].authorizationId : null,
    });
  }

  /** One durable customer command; the normal backend worker owns continuation. */
  async queueLabels(omsOrderId: number, raw: unknown) {
    const input = parseInput(customerReturnCustomerSubmitInputSchema, raw);
    const order = await this.ownedOrder(parseInput(id, omsOrderId));
    const saved = await this.workflowStore().enqueue({ request: { ...input, channelId: this.principal.channelId, orderReference: order.externalOrderNumber },
      scope: this.scope(order), actor: this.actor, now: this.workflowNow() });
    return this.presentWorkflow(saved, { omsOrderId: order.omsOrderId, requestKey: input.idempotencyKey });
  }
  async orderWorkflow(rawOrderId: number) {
    const omsOrderId = parseInput(id, rawOrderId);
    await this.ownedOrder(omsOrderId);
    const saved = await this.workflowStore().readOwnedOrder(this.principal, omsOrderId);
    if (!saved) throw new CustomerReturnIntakeError("RETURN_WORKFLOW_NOT_FOUND", "The saved label request is unavailable.", 404);
    const { channelId: _channel, orderReference: _reference, ...input } = saved.request;
    return customerReturnWorkflowResumeSchema.parse({ workflow: await this.presentWorkflow(saved, { omsOrderId }), input });
  }
  async workflowStatus(rawKey: string) {
    const key = parseInput(z.string().uuid(), rawKey);
    const saved = await this.workflowStore().readOwned(this.principal, key);
    if (!saved) throw new CustomerReturnIntakeError("RETURN_WORKFLOW_NOT_FOUND", "The saved label request is unavailable.", 404);
    return this.presentWorkflow(saved, { requestKey: key });
  }
  async authorizationWorkflow(rawAuthorizationId: number) {
    const authorizationId = parseInput(id, rawAuthorizationId);
    await this.ownedAuthorization(authorizationId);
    const saved = await this.workflowStore().readOwnedAuthorization(this.principal, authorizationId);
    if (!saved) throw new CustomerReturnIntakeError("RETURN_WORKFLOW_NOT_FOUND", "The saved label request is unavailable.", 404);
    return this.presentWorkflow(saved, { authorizationId });
  }
  async retryWorkflow(rawKey: string) {
    const key = parseInput(z.string().uuid(), rawKey);
    const saved = await this.workflowStore().retryOwned(this.principal, key, this.workflowNow());
    if (!saved) throw new CustomerReturnIntakeError("RETURN_WORKFLOW_NOT_FOUND", "The saved label request is unavailable.", 404);
    return this.presentWorkflow(saved, { requestKey: key });
  }
  async queueExistingLabels(rawAuthorizationId: number) {
    const authorizationId = parseInput(id, rawAuthorizationId);
    const owned = await this.ownedAuthorization(authorizationId);
    const original = await this.workflowStore().acceptedRequest(this.principal, authorizationId);
    if (!original || original.scope.omsOrderId !== owned.omsOrderId) throw customerReturnUnavailable();
    const saved = await this.workflowStore().enqueue({ ...original, authorizationId, actor: this.actor, now: this.workflowNow() });
    const retried = await this.workflowStore().retryOwned(this.principal, saved.request.idempotencyKey, this.workflowNow());
    return this.presentWorkflow(retried ?? saved, { omsOrderId: owned.omsOrderId, requestKey: saved.request.idempotencyKey, authorizationId });
  }
  private workflowStore(): CustomerReturnWorkflowStore {
    if (!this.dependencies.workflows) throw new CustomerReturnIntakeError("RETURN_WORKFLOW_UNAVAILABLE", "Labels are temporarily unavailable.", 503);
    return this.dependencies.workflows;
  }
  private workflowNow(): Date {
    if (!this.dependencies.now) throw new CustomerReturnIntakeError("RETURN_WORKFLOW_UNAVAILABLE", "Labels are temporarily unavailable.", 503);
    return z.date().parse(this.dependencies.now());
  }
  private async presentWorkflow(record: ReturnWorkflowRecord, expected: { omsOrderId?: number; requestKey?: string; authorizationId?: number } = {}) {
    if (record.scope.channelId !== this.principal.channelId || record.scope.externalCustomerId !== this.principal.externalCustomerId
      || (expected.omsOrderId !== undefined && record.scope.omsOrderId !== expected.omsOrderId)
      || (expected.requestKey !== undefined && record.request.idempotencyKey !== expected.requestKey)
      || (expected.authorizationId !== undefined && record.authorizationId !== null && record.authorizationId !== expected.authorizationId)) throw customerReturnUnavailable();
    const labels = record.authorizationId === null ? null : await this.present(
      await this.dependencies.labels.status(this.principal.channelId, record.authorizationId),
      { omsOrderId: record.scope.omsOrderId, authorizationId: record.authorizationId });
    return customerReturnWorkflowStatusSchema.parse({ requestKey: record.request.idempotencyKey, omsOrderId: record.scope.omsOrderId,
      phase: record.phase, reason: record.reason, labels, updatedAt: record.updatedAt.toISOString() });
  }

  async submit(omsOrderId: number, raw: unknown): Promise<CustomerReturnCustomerLabelStatus> {
    const input = parseInput(customerReturnCustomerSubmitInputSchema, raw);
    const order = await this.ownedOrder(parseInput(id, omsOrderId));
    const result = await this.dependencies.submissions.submitForOrder({
      ...input, channelId: this.principal.channelId, orderReference: order.externalOrderNumber,
    }, this.actor, this.scope(order));
    return this.present(result, { omsOrderId: order.omsOrderId });
  }

  async submissionStatus(idempotencyKey: string): Promise<CustomerReturnCustomerLabelStatus> {
    const key = parseInput(z.string().uuid(), idempotencyKey);
    const command = await this.ownedCommand(key);
    const result = await this.dependencies.submissions.status(this.principal.channelId, key);
    return this.present(result, { omsOrderId: command.omsOrderId, authorizationId: command.authorizationId ?? undefined });
  }

  async resumeSubmission(idempotencyKey: string): Promise<CustomerReturnCustomerLabelStatus> {
    const key = parseInput(z.string().uuid(), idempotencyKey);
    const command = await this.ownedCommand(key);
    const order = await this.ownedOrder(command.omsOrderId);
    const result = await this.dependencies.submissions.resumeForOrder(this.principal.channelId, key, this.actor, this.scope(order));
    return this.present(result, { omsOrderId: command.omsOrderId, authorizationId: command.authorizationId ?? undefined });
  }

  async labelStatus(authorizationId: number): Promise<CustomerReturnCustomerLabelStatus> {
    const authorization = await this.ownedAuthorization(parseInput(id, authorizationId));
    const result = await this.dependencies.labels.status(this.principal.channelId, authorization.authorizationId);
    return this.present(result, authorization);
  }

  async progressLabels(authorizationId: number): Promise<CustomerReturnCustomerLabelStatus> {
    const authorization = await this.ownedAuthorization(parseInput(id, authorizationId));
    const result = await this.dependencies.labels.progress(this.principal.channelId, authorization.authorizationId, this.actor);
    return this.present(result, authorization);
  }

  /** Trusted route downloads this record server-side; never serialize provider URLs to customers. */
  async artifact(authorizationId: number, parcelId: number) {
    const checkedParcel = parseInput(id, parcelId);
    const authorization = await this.ownedAuthorization(parseInput(id, authorizationId));
    return this.dependencies.labels.artifact(this.principal.channelId, authorization.authorizationId, checkedParcel);
  }

  private async ownedOrder(omsOrderId: number) {
    const order = customerReturnOrderAccessResultSchema.parse(await this.dependencies.orderAccess.resolveOwned({ omsOrderId }));
    if (order.channelId !== this.principal.channelId || order.omsOrderId !== omsOrderId) throw customerReturnUnavailable();
    return order;
  }
  private scope(order: z.infer<typeof customerReturnOrderAccessResultSchema>): CustomerReturnCanonicalOrderScope {
    return customerReturnCanonicalOrderScopeSchema.parse({
      channelId: this.principal.channelId, externalCustomerId: this.principal.externalCustomerId,
      omsOrderId: order.omsOrderId, externalOrderId: order.externalOrderId,
    });
  }
  private async ownedCommand(key: string) {
    const raw = await this.dependencies.ownership.readOwnedCommand(this.principal, key);
    if (raw === null) throw customerReturnUnavailable();
    return customerReturnOwnedCommandSchema.parse(raw);
  }
  private async ownedAuthorization(authorizationId: number) {
    const raw = await this.dependencies.ownership.readOwnedAuthorization(this.principal, authorizationId);
    if (raw === null) throw customerReturnUnavailable();
    const result = customerReturnOwnedAuthorizationSchema.parse(raw);
    if (result.authorizationId !== authorizationId) throw customerReturnUnavailable();
    return result;
  }
  private async present(raw: unknown, expected: { omsOrderId: number; authorizationId?: number }): Promise<CustomerReturnCustomerLabelStatus> {
    const status = customerReturnLabelStatusSchema.parse(raw);
    if (status.channelId !== this.principal.channelId
      || (expected.authorizationId !== undefined && status.authorizationId !== expected.authorizationId)) throw customerReturnUnavailable();
    // Reauthorize after orchestration/replay, before any return data leaves this request.
    const owned = await this.ownedAuthorization(status.authorizationId);
    if (owned.omsOrderId !== expected.omsOrderId) throw customerReturnUnavailable();
    return customerReturnCustomerLabelStatusSchema.parse({
      authorizationId: status.authorizationId, authorizationNumber: status.authorizationNumber,
      canProgress: status.canProgress,
      parcels: status.parcels.map(parcel => ({ ...parcel,
        downloadPath: parcel.status === "ready"
          ? `${CUSTOMER_RETURN_CUSTOMER_API}/returns/${status.authorizationId}/parcels/${parcel.parcelId}/download`
          : null,
      })),
    });
  }
}

export function customerReturnUnavailable(): CustomerReturnIntakeError {
  return new CustomerReturnIntakeError("CUSTOMER_RETURN_UNAVAILABLE", "This return is unavailable.", 404);
}
function parseInput<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw new CustomerReturnIntakeError("CUSTOMER_RETURN_INPUT_INVALID", "Check the return details and try again.", 400);
  return result.data;
}
