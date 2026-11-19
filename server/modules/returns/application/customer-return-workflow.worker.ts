import { customerReturnWorkflowWorking } from "@shared/returns/customer-return-workflow.contract";
import { customerReturnLabelStatusSchema, type CustomerReturnLabelStatus } from "@shared/returns/customer-return-label.contract";
import { CustomerReturnSubmissionProcessingError, type CustomerReturnSubmissionService } from "./customer-return-submission.service";
import type { CustomerReturnLabelsService } from "./customer-return-labels.service";
import { CustomerReturnIntakeError } from "./customer-return-intake.ports";
import { returnWorkflowRecordSchema, type CustomerReturnWorkflowStore, type ReturnWorkflowRecord, type ReturnWorkflowTransition } from "./customer-return-workflow.ports";

export const RETURN_WORKFLOW_MAX_FAILURES = 6;
export const RETURN_WORKFLOW_WAIT_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const CONCURRENCY = 2;
export type ReturnWorkflowReport = (event: { event: string; requestKey?: string; channelId?: number; omsOrderId?: number; phase?: string; code?: string }) => void;

/** Owns continuation after one explicit customer request. Provider purchases and
 * reconciliation remain exclusively in CustomerReturnLabelsService. */
export class CustomerReturnWorkflowWorker {
  constructor(private readonly dependencies: {
    store: CustomerReturnWorkflowStore;
    submissions: Pick<CustomerReturnSubmissionService, "submitForOrder">;
    labels: Pick<CustomerReturnLabelsService, "status" | "progress" | "retryRejected">;
    now(): Date;
    newToken(): string;
    report: ReturnWorkflowReport;
  }) {}

  async run(): Promise<void> {
    const records = await this.dependencies.store.claim(CONCURRENCY, this.dependencies.newToken(), this.dependencies.now());
    await Promise.all(records.map(record => {
      const checked = returnWorkflowRecordSchema.parse(record);
      if (!checked.leaseToken || !customerReturnWorkflowWorking(checked.phase))
        throw new CustomerReturnIntakeError("RETURN_WORKFLOW_LEASE_INVALID", "The workflow lease is invalid.");
      return this.process(checked);
    }));
  }

  private async process(record: ReturnWorkflowRecord): Promise<void> {
    let transition: ReturnWorkflowTransition;
    try {
      let status: CustomerReturnLabelStatus;
      if (record.authorizationId === null) {
        status = customerReturnLabelStatusSchema.parse(await this.dependencies.submissions.submitForOrder(record.request, record.actor, record.scope));
      } else {
        status = customerReturnLabelStatusSchema.parse(await this.dependencies.labels.status(record.scope.channelId, record.authorizationId));
        this.assertIdentity(record, status);
        const failed = status.parcels.some(parcel => parcel.status === "failed");
        const uncertain = status.parcels.some(parcel => parcel.status === "processing" || parcel.status === "needs_review");
        if (uncertain && status.canProgress) {
          status = customerReturnLabelStatusSchema.parse(await this.dependencies.labels.progress(status.channelId, status.authorizationId, record.actor));
        } else if (failed && record.explicitRetry) {
          status = customerReturnLabelStatusSchema.parse(await this.dependencies.labels.retryRejected(status.channelId, status.authorizationId, record.actor));
        } else if (!failed && status.canProgress) {
          status = customerReturnLabelStatusSchema.parse(await this.dependencies.labels.progress(status.channelId, status.authorizationId, record.actor));
        }
      }
      this.assertIdentity(record, status);
      transition = this.decide(record, status);
    } catch (error) {
      transition = this.failure(record, error);
    }
    const now = this.dependencies.now();
    const settled = await this.dependencies.store.settle(record, transition, now);
    this.dependencies.report({ event: "customer_return_workflow_step", requestKey: record.request.idempotencyKey,
      channelId: record.scope.channelId, omsOrderId: record.scope.omsOrderId,
      phase: settled ? transition.phase : "superseded", ...(transition.errorCode ? { code: transition.errorCode } : {}) });
  }

  private assertIdentity(record: ReturnWorkflowRecord, status: CustomerReturnLabelStatus): void {
    if (status.channelId !== record.scope.channelId
      || (record.authorizationId !== null && status.authorizationId !== record.authorizationId)
      || status.parcels.length !== record.request.parcels.length
      || new Set(status.parcels.map(parcel => parcel.parcelId)).size !== status.parcels.length
      || new Set(status.parcels.map(parcel => parcel.number)).size !== status.parcels.length
      || status.parcels.some(parcel => parcel.number < 1 || parcel.number > status.parcels.length)) {
      throw new CustomerReturnIntakeError("RETURN_WORKFLOW_IDENTITY_CHANGED", "The saved return identity needs administrator review.");
    }
  }

  private decide(record: ReturnWorkflowRecord, status: CustomerReturnLabelStatus): ReturnWorkflowTransition {
    const now = this.dependencies.now();
    const base = { authorizationId: status.authorizationId, failures: 0, nextRunAt: now, errorCode: null };
    if (status.parcels.every(parcel => parcel.status === "ready")) return { ...base, phase: "ready", reason: null };
    if (status.parcels.some(parcel => parcel.status === "processing" || parcel.status === "needs_review")) {
      const failures = record.failures + 1;
      return { ...base, failures, phase: failures >= RETURN_WORKFLOW_MAX_FAILURES ? "needs_help" : "labels",
        reason: failures >= RETURN_WORKFLOW_MAX_FAILURES ? "RETURN_LABEL_RECONCILIATION_REQUIRED" : null,
        nextRunAt: new Date(now.getTime() + Math.min(MAX_BACKOFF_MS, RETURN_WORKFLOW_WAIT_MS * 2 ** (failures - 1))),
        errorCode: "RETURN_LABEL_OUTCOME_UNKNOWN" };
    }
    if (status.parcels.some(parcel => parcel.status === "failed")) return { ...base, phase: "retryable_failure", reason: "RETURN_SHIPPING_UNAVAILABLE", errorCode: "RETURN_LABEL_REJECTED" };
    return { ...base, phase: "labels", reason: null };
  }

  private failure(record: ReturnWorkflowRecord, error: unknown): ReturnWorkflowTransition {
    const now = this.dependencies.now();
    const known = error instanceof CustomerReturnIntakeError;
    const code = error instanceof CustomerReturnSubmissionProcessingError && error.failure ? error.failure.code : known ? error.reasonCode ?? error.code : "RETURN_WORKFLOW_UNEXPECTED_FAILURE";
    const failures = Math.min(RETURN_WORKFLOW_MAX_FAILURES, record.failures + 1);
    const base = { authorizationId: record.authorizationId, failures,
      nextRunAt: new Date(now.getTime() + Math.min(MAX_BACKOFF_MS, RETURN_WORKFLOW_WAIT_MS * 2 ** (failures - 1))), errorCode: code };
    if (known && error.code === "RETURN_LABEL_SUBMISSION_REJECTED" && record.authorizationId === null)
      return { ...base, phase: "needs_input", reason: "RETURN_DETAILS_CHANGED" };
    const nonTransientDatabaseFailure = /^[A-Z0-9]{5}$/.test(code) && !/^(08|40|53|55|57)/.test(code);
    if (nonTransientDatabaseFailure || code === "RETURN_WORKFLOW_IDENTITY_CHANGED" || code === "RETURN_LABEL_RETRIES_EXHAUSTED")
      return { ...base, phase: "needs_help", reason: "RETURN_WORKFLOW_NEEDS_HELP" };
    if (known && error.status < 500 && error.code !== "RETURN_LABEL_SUBMISSION_PROCESSING")
      return { ...base, phase: "needs_help", reason: "RETURN_SHIPPING_UNAVAILABLE" };
    return { ...base, phase: failures >= RETURN_WORKFLOW_MAX_FAILURES ? "retryable_failure" : record.authorizationId === null ? "preparing" : "labels",
      reason: failures >= RETURN_WORKFLOW_MAX_FAILURES ? "RETURN_WORKFLOW_TEMPORARY_FAILURE" : null };
  }
}
