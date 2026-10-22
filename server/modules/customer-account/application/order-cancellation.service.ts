import { createHash } from "node:crypto";
import { z } from "zod";
import {
  customerOrderCancellationInputSchema,
  customerOrderCancellationReviewSchema,
  customerOrderCancellationSchema,
  type CustomerOrderCancellation,
  type CustomerOrderCancellationInput,
  type CustomerOrderCancellationReview,
} from "@shared/customer-account/order-cancellation";
import type {
  OrderEditRecord,
  OrderEditReleaseProof,
  OrderEditStore,
  OrderEditWarehouse,
} from "../../order-edits/application/order-edit-store";
import {
  OrderEditProviderError,
  type OrderEditProvider,
} from "../../order-edits/application/order-edit-provider";
import { assertOrderEditIdentity } from "../../order-edits/application/order-edit-identity";
import {
  orderCancellationEligibilityReasons,
  orderCancellationLineEvidence,
} from "../../order-edits/domain/order-cancellation-eligibility";
import { OrderEditError } from "../../order-edits/domain/order-edit-error";
import { matchesOrderCancellationSettlement } from "../../order-edits/domain/order-edit-financials";
import {
  cancellationPaymentsSettled,
  type OrderCancellationProvider,
  type OrderCancellationRewards,
} from "./order-cancellation.ports";

const terminal = new Set(["completed", "recovered", "failed", "expired"]);
// Required by the legacy shared-operation document. Cancellation has no quote
// or payment deadline; this compatibility field never schedules a payment.
const UNUSED_CANCELLATION_PAYMENT_WINDOW_MINUTES = 1;
type CancellationRecord = OrderEditRecord & {
  kind: "cancel_order";
  cancellation: NonNullable<OrderEditRecord["cancellation"]>;
};

/** Customer cancellation is a distinct strategy over the existing durable
 * order-mutation store/lock/hold/audit. Only submit() may call orderCancel;
 * reconciliation observes the same request and uses canonical settlement. */
export class OrderCancellationService {
  constructor(
    private readonly dependencies: {
      store: OrderEditStore;
      provider: Pick<OrderEditProvider, "readOrder"> &
        OrderCancellationProvider;
      warehouse: OrderEditWarehouse;
      rewards: OrderCancellationRewards;
      clock: () => Date;
      uuid: () => string;
      report: (event: {
        operationId: string;
        code: string;
        phase: string;
        occurredAt: string;
      }) => void;
    },
  ) {}

  async review(
    connectionId: number,
    omsOrderId: number,
  ): Promise<CustomerOrderCancellationReview> {
    const { store, provider, warehouse, rewards } = this.dependencies;
    const reference = await store.orderReference(connectionId, omsOrderId);
    const snapshot = await provider.readOrder(
      connectionId,
      reference.externalOrderId,
    );
    assertOrderEditIdentity(reference, snapshot);
    const settings = await store.settings(connectionId);
    const inspection = await warehouse.inspect(omsOrderId);
    const reasons = orderCancellationEligibilityReasons({
      snapshot,
      warehouseReasons: inspection.cancellationReasons ?? inspection.reasons,
      activeOperationId: reference.activeOperationId,
      enabled: settings.enabled,
    });
    const rewardReview = snapshot.customerId
      ? await rewards.reviewCancellation({
          customerId: snapshot.customerId,
          orderId: snapshot.orderId,
        })
      : {
          fingerprint: createHash("sha256").update("no-customer").digest("hex"),
          returnedPoints: "0.00",
          deductedEarnedPoints: "0.00",
          settled: false,
        };
    return customerOrderCancellationReviewSchema.parse({
      connectionId,
      omsOrderId,
      orderNumber: snapshot.name,
      currency: snapshot.currency,
      revision: createHash("sha256")
        .update(
          JSON.stringify({
            orderRevision: snapshot.fingerprint,
            refundCents: snapshot.netPaidCents,
            returnedPoints: rewardReview.returnedPoints,
            deductedEarnedPoints: rewardReview.deductedEarnedPoints,
            rewardsFingerprint: rewardReview.fingerprint,
          }),
        )
        .digest("hex"),
      orderRevision: snapshot.fingerprint,
      refundCents: snapshot.netPaidCents,
      rewards: rewardReview,
      eligibility: { allowed: reasons.length === 0, reasons },
    });
  }

  async submit(
    raw: CustomerOrderCancellationInput,
    actorId: string,
  ): Promise<CustomerOrderCancellation> {
    const input = customerOrderCancellationInputSchema.parse(raw);
    const { store, provider, warehouse, clock, uuid } = this.dependencies;
    const requestHash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    return store.withOrderLock(input.omsOrderId, async () => {
      const previous = await store.findByRequestKey(input.requestKey);
      if (previous) {
        const existing = this.record(previous);
        if (
          existing.requestHash !== requestHash ||
          existing.actorId !== actorId
        )
          throw unavailable();
        return this.present(existing); // A repeated POST never repeats orderCancel.
      }
      const review = await this.review(input.connectionId, input.omsOrderId);
      if (!review.eligibility.allowed)
        throw new OrderEditError(
          "ORDER_CANCELLATION_UNAVAILABLE",
          "This order can’t be cancelled online. Contact us for help.",
        );
      if (review.revision !== input.expectedRevision)
        throw new OrderEditError(
          "ORDER_CANCELLATION_REVIEW_CHANGED",
          "The order changed. Review the cancellation again.",
        );
      const reference = await store.orderReference(
        input.connectionId,
        input.omsOrderId,
      );
      const baseline = await provider.readOrder(
        input.connectionId,
        reference.externalOrderId,
      );
      assertOrderEditIdentity(reference, baseline);
      if (!baseline.customerId) throw unavailable();
      if (baseline.fingerprint !== review.orderRevision)
        throw new OrderEditError(
          "ORDER_CANCELLATION_REVIEW_CHANGED",
          "The order changed. Review the cancellation again.",
        );
      const now = clock().toISOString();
      let record: CancellationRecord = {
        kind: "cancel_order",
        cancellation: {
          stage: "acquiring",
          jobId: null,
          refundCents: review.refundCents,
          rewards: review.rewards,
        },
        id: uuid(),
        omsOrderId: input.omsOrderId,
        connectionId: input.connectionId,
        requestKey: input.requestKey,
        requestHash,
        actorId,
        status: "committing",
        version: 0,
        createdAt: now,
        updatedAt: now,
        // The shared persisted input certifies which purchased lines are being
        // cancelled; no edit quote is created and editCommit is never invoked.
        input: {
          ...input,
          changes: orderCancellationLineEvidence(baseline),
          additions: [],
        },
        baseline,
        quote: null,
        paymentWindowMinutes: UNUSED_CANCELLATION_PAYMENT_WINDOW_MINUTES,
        quoteDeadline: now,
        paymentDeadline: null,
        commitKey: null,
        commitStartedAt: null,
        refundIntent: null,
        refundStartedAt: null,
        lastSnapshot: null,
        recoveryStartedAt: null,
        error: null,
      };
      await store.create(record);
      try {
        await warehouse.acquire(input.omsOrderId, record.id);
        const fresh = await provider.readOrder(
          input.connectionId,
          baseline.orderId,
        );
        assertOrderEditIdentity(reference, fresh);
        if (fresh.fingerprint !== baseline.fingerprint)
          throw new OrderEditError(
            "ORDER_CANCELLATION_REVIEW_CHANGED",
            "The order changed. Review the cancellation again.",
          );
        const freshRewards = await this.dependencies.rewards.reviewCancellation(
          { customerId: baseline.customerId!, orderId: baseline.orderId },
        );
        if (
          freshRewards.fingerprint !== review.rewards.fingerprint ||
          freshRewards.returnedPoints !== review.rewards.returnedPoints ||
          freshRewards.deductedEarnedPoints !==
            review.rewards.deductedEarnedPoints
        )
          throw new OrderEditError(
            "ORDER_CANCELLATION_REVIEW_CHANGED",
            "The rewards changed. Review the cancellation again.",
          );
        await warehouse.assertHeld(input.omsOrderId, record.id);
      } catch (error) {
        record = await this.update(
          record,
          { error: this.failure(error) },
          actorId,
          "cancellation_not_submitted",
        );
        return this.present(await this.releaseNotSubmitted(record, actorId));
      }
      record = await this.update(
        record,
        {
          commitKey: input.requestKey,
          commitStartedAt: clock().toISOString(),
          cancellation: { ...record.cancellation, stage: "submitting" },
        },
        actorId,
        "cancellation_submission_intent",
      );
      try {
        const result = await provider.cancelOrder(
          input.connectionId,
          baseline.orderId,
          record.id,
        );
        record = await this.update(
          record,
          {
            cancellation: {
              ...record.cancellation,
              stage: "accepted",
              jobId: result.jobId,
            },
            error: null,
          },
          actorId,
          "cancellation_accepted",
        );
      } catch (error) {
        let rejectedUnchanged = false;
        if (
          error instanceof OrderEditProviderError &&
          error.outcome === "rejected"
        ) {
          try {
            const observed = await provider.readOrder(
              input.connectionId,
              baseline.orderId,
            );
            rejectedUnchanged =
              !observed.cancelled &&
              observed.fingerprint === baseline.fingerprint;
          } catch {
            this.dependencies.report({
              operationId: record.id,
              code: "ORDER_CANCELLATION_REJECTION_READBACK_FAILED",
              phase: "submission",
              occurredAt: clock().toISOString(),
            });
          }
        }
        if (rejectedUnchanged) {
          record = await this.update(
            record,
            {
              commitKey: null,
              commitStartedAt: null,
              cancellation: { ...record.cancellation, stage: "acquiring" },
              error: this.failure(error),
            },
            actorId,
            "cancellation_rejected",
          );
          return this.present(await this.releaseNotSubmitted(record, actorId));
        }
        // A timeout, unknown HTTP result or invalid body can hide acceptance.
        // Keep ownership and recover by observation; never resend cancellation.
        record = await this.update(
          record,
          {
            cancellation: { ...record.cancellation, stage: "uncertain" },
            error: this.failure(error),
          },
          actorId,
          "cancellation_requires_readback",
        );
      }
      return this.present(record);
    });
  }

  async get(
    connectionId: number,
    omsOrderId: number,
    requestKey: string,
    actorId: string,
  ): Promise<CustomerOrderCancellation> {
    z.string().uuid().parse(requestKey);
    const value = await this.dependencies.store.findByRequestKey(requestKey);
    if (
      !value ||
      value.connectionId !== connectionId ||
      value.omsOrderId !== omsOrderId ||
      value.actorId !== actorId
    )
      throw unavailable();
    return this.present(this.record(value));
  }

  /** Staff permission/origin checks belong to the existing order-operation
   * routes. This read exposes the saved cancellation, never a new command. */
  async staffGet(id: string): Promise<CustomerOrderCancellation> {
    return this.present(
      this.record(
        await this.dependencies.store.get(z.string().uuid().parse(id)),
      ),
    );
  }

  async reconcile(id: string, staffActorId?: string): Promise<void> {
    const { store, provider, warehouse, rewards } = this.dependencies;
    const initial = this.record(await store.get(z.string().uuid().parse(id)));
    await store.withOrderLock(initial.omsOrderId, async () => {
      let record = this.record(await store.get(id));
      if (terminal.has(record.status)) return;
      if (staffActorId)
        record = await this.update(
          record,
          {},
          staffActorId,
          "cancellation_staff_recheck",
        );
      if (!record.commitStartedAt) {
        await this.releaseNotSubmitted(record, null);
        return;
      }
      try {
        const reference = await store.orderReference(
          record.connectionId,
          record.omsOrderId,
        );
        const snapshot = await provider.readOrder(
          record.connectionId,
          record.baseline.orderId,
        );
        assertOrderEditIdentity(reference, snapshot);
        if (snapshot.customerId !== record.baseline.customerId)
          throw new OrderEditError(
            "ORDER_CANCELLATION_CUSTOMER_CHANGED",
            "The order owner changed. Contact us to check this cancellation.",
          );
        const job = record.cancellation.jobId
          ? await provider.cancellationJob(
              record.connectionId,
              record.cancellation.jobId,
            )
          : null;
        if (job?.orderId && job.orderId !== snapshot.orderId)
          throw new OrderEditError(
            "ORDER_CANCELLATION_JOB_MISMATCH",
            "The cancellation job needs staff verification.",
          );
        if (job?.failed) {
          if (
            !record.lastSnapshot?.cancelled &&
            !snapshot.cancelled &&
            snapshot.fingerprint === record.baseline.fingerprint
          ) {
            record = await this.update(
              record,
              {
                commitKey: null,
                commitStartedAt: null,
                cancellation: {
                  ...record.cancellation,
                  stage: "acquiring",
                  jobId: null,
                },
                error: {
                  code: "ORDER_CANCELLATION_REJECTED",
                  message:
                    "Shopify could not cancel this order. Contact us for help.",
                },
              },
              staffActorId ?? null,
              "cancellation_job_rejected",
            );
            await this.releaseNotSubmitted(record, staffActorId ?? null);
            return;
          }
          throw new OrderEditError(
            "ORDER_CANCELLATION_JOB_CONFLICT",
            "Shopify could not finish the cancellation. Contact us to verify the order and refund.",
          );
        }
        if (!snapshot.cancelled) {
          await this.update(
            record,
            {
              error:
                record.cancellation.stage === "uncertain"
                  ? {
                      code: "ORDER_CANCELLATION_RESULT_UNCERTAIN",
                      message:
                        "We’re verifying your cancellation request. Contact us if this does not update.",
                    }
                  : null,
            },
            null,
            "cancellation_pending",
          );
          return;
        }
        record = await this.update(
          record,
          { status: "refunding", lastSnapshot: snapshot, error: null },
          null,
          "cancellation_observed",
        );
        if (!cancellationPaymentsSettled(snapshot)) return;
        if (
          !matchesOrderCancellationSettlement(
            record.baseline,
            snapshot,
            record.cancellation.refundCents,
          )
        )
          throw new OrderEditError(
            "ORDER_CANCELLATION_REFUND_CHANGED",
            "The payment history changed. Contact us to verify the cancellation refund.",
          );
        if (job && (!job.done || job.orderId !== snapshot.orderId)) return;
        if (!snapshot.customerId) throw unavailable();
        const settledRewards = record.cancellation.rewards.settled
          ? record.cancellation.rewards
          : await rewards.settleCancellation({
              operationId: record.id,
              customerId: snapshot.customerId,
              orderId: snapshot.orderId,
            });
        if (!settledRewards.settled)
          throw new OrderEditError(
            "ORDER_CANCELLATION_REWARDS_PENDING",
            "Your cancellation is saved. Rewards reconciliation is still in progress.",
          );
        if (
          settledRewards.fingerprint !==
            record.cancellation.rewards.fingerprint ||
          settledRewards.returnedPoints !==
            record.cancellation.rewards.returnedPoints ||
          settledRewards.deductedEarnedPoints !==
            record.cancellation.rewards.deductedEarnedPoints
        )
          throw new OrderEditError(
            "ORDER_CANCELLATION_REWARDS_CHANGED",
            "Your cancellation is saved. Contact us to verify its rewards.",
          );
        record = await this.update(
          record,
          {
            status: "synchronizing",
            cancellation: {
              ...record.cancellation,
              stage: "settling",
              rewards: settledRewards,
            },
            error: null,
          },
          null,
          "cancellation_settled",
        );
        if (!warehouse.cancellationReleaseProof)
          throw new OrderEditError(
            "ORDER_CANCELLATION_RELEASE_UNAVAILABLE",
            "Your cancellation is saved. We’re checking the warehouse update.",
          );
        const proof = await warehouse.cancellationReleaseProof(
          record.omsOrderId,
          record.id,
        );
        await this.update(
          record,
          { status: "completed", error: null },
          null,
          "cancellation_completed",
          proof,
        );
      } catch (error) {
        const reviewRequired =
          (error instanceof OrderEditProviderError &&
            error.outcome === "rejected" &&
            /^(REWARD_|ORDER_EDIT_CODE_)/.test(error.code)) ||
          (error instanceof OrderEditError &&
            [
              "ORDER_CANCELLATION_CUSTOMER_CHANGED",
              "ORDER_EDIT_IDENTITY_CHANGED",
              "ORDER_CANCELLATION_REWARDS_CHANGED",
              "ORDER_CANCELLATION_JOB_MISMATCH",
              "ORDER_CANCELLATION_JOB_CONFLICT",
              "ORDER_CANCELLATION_REFUND_CHANGED",
            ].includes(error.code));
        await this.update(
          record,
          {
            ...(reviewRequired ? { status: "review_required" as const } : {}),
            error: this.failure(error),
          },
          null,
          "cancellation_reconciliation_pending",
        );
      }
    });
  }

  private async releaseNotSubmitted(
    record: CancellationRecord,
    actorId: string | null,
  ): Promise<CancellationRecord> {
    try {
      const proof = await this.dependencies.warehouse.releaseUnsubmitted(
        record.omsOrderId,
        record.id,
      );
      return this.update(
        record,
        { status: "expired" },
        actorId,
        "cancellation_unsubmitted_released",
        proof,
      );
    } catch (error) {
      this.dependencies.report({
        operationId: record.id,
        code: this.failure(error).code,
        phase: "unsubmitted_hold_release",
        occurredAt: this.dependencies.clock().toISOString(),
      });
      return this.update(
        record,
        {
          error: {
            code: "ORDER_CANCELLATION_CLEANUP_PENDING",
            message:
              "Your cancellation was not submitted. We’re releasing the temporary hold.",
          },
        },
        actorId,
        "cancellation_cleanup_pending",
      );
    }
  }
  private record(value: OrderEditRecord): CancellationRecord {
    if (value.kind !== "cancel_order" || !value.cancellation)
      throw unavailable();
    return value as CancellationRecord;
  }
  private async update(
    record: CancellationRecord,
    patch: Partial<CancellationRecord>,
    actorId: string | null,
    action: string,
    proof?: OrderEditReleaseProof,
  ): Promise<CancellationRecord> {
    const next = {
      ...record,
      ...patch,
      version: record.version + 1,
      updatedAt: this.dependencies.clock().toISOString(),
    };
    await this.dependencies.store.save(
      next,
      record.version,
      actorId,
      action,
      proof,
    );
    if (next.error)
      this.dependencies.report({
        operationId: next.id,
        code: next.error.code,
        phase: action,
        occurredAt: next.updatedAt,
      });
    return next;
  }
  private failure(error: unknown): { code: string; message: string } {
    return error instanceof OrderEditError ||
      error instanceof OrderEditProviderError
      ? { code: error.code, message: error.message }
      : {
          code: "ORDER_CANCELLATION_CHECK_FAILED",
          message:
            "We couldn’t refresh the cancellation status. Please try again.",
        };
  }
  private present(record: CancellationRecord): CustomerOrderCancellation {
    const status =
      record.status === "completed"
        ? "completed"
        : record.status === "expired"
          ? "not_submitted"
          : record.status === "review_required"
            ? "review_required"
            : record.status === "synchronizing"
              ? "synchronizing"
              : record.status === "refunding"
                ? "refunding"
                : record.cancellation.stage === "acquiring"
                  ? "submitting"
                  : "pending";
    return customerOrderCancellationSchema.parse({
      operationId: record.id,
      requestKey: record.requestKey,
      omsOrderId: record.omsOrderId,
      orderNumber: record.baseline.name,
      currency: record.baseline.currency,
      status,
      refundCents: record.cancellation.refundCents,
      refundStatus:
        status === "not_submitted"
          ? "not_submitted"
          : record.lastSnapshot &&
              cancellationPaymentsSettled(record.lastSnapshot) &&
              matchesOrderCancellationSettlement(
                record.baseline,
                record.lastSnapshot,
                record.cancellation.refundCents,
              )
            ? "completed"
            : "pending",
      rewards: record.cancellation.rewards,
      error: record.error
        ? {
            ...record.error,
            retryable: ![
              "completed",
              "not_submitted",
              "review_required",
            ].includes(status),
          }
        : null,
    });
  }
}
function unavailable(): OrderEditError {
  return new OrderEditError(
    "ORDER_CANCELLATION_UNAVAILABLE",
    "This cancellation is unavailable in your account.",
    404,
  );
}
