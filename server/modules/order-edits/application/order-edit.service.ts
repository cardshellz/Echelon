import { createHash } from "node:crypto";
import { presentOrderEditSettlement } from "../domain/order-edit-financials";
import {
  unchangedFulfilledOrderEdit,
  unchangedOrderEditSnapshot,
} from "./order-edit-evidence";
import {
  orderEditOperationSchema,
  orderEditOrderSchema,
  orderEditQuoteInputSchema,
  orderEditSettingsInputSchema,
} from "@shared/order-edits/order-edit.contract";
import type {
  OrderEditOperation,
  OrderEditQuoteInput,
  OrderEditSettingsInput,
} from "@shared/order-edits/order-edit.contract";
import type {
  OrderEditProvider,
  OrderEditSnapshot,
} from "./order-edit-provider";
import {
  OrderEditCommitNotSentError,
  OrderEditProviderError,
} from "./order-edit-provider";
import type {
  OrderEditRecord,
  OrderEditReleaseProof,
  OrderEditStore,
  OrderEditWarehouse,
} from "./order-edit-store";
import { OrderEditError } from "../domain/order-edit-error";

const terminal = new Set(["completed", "recovered", "failed", "expired"]);
// Bound each scheduler pass so one store cannot monopolize the worker.
const RECONCILIATION_BATCH_SIZE = 25;
const MILLISECONDS_PER_MINUTE = 60_000;
const retryableProviderReadback = new Set([
  "SHOPIFY_UNAVAILABLE",
  "SHOPIFY_HTTP_ERROR",
  "SHOPIFY_GRAPHQL_ERROR",
  "SHOPIFY_RESPONSE_INVALID",
]);
const unresolvedPayment = (snapshot: OrderEditSnapshot) =>
  snapshot.transactions.some(
    (transaction) =>
      ["SALE", "CAPTURE", "AUTHORIZATION", "REFUND"].includes(
        transaction.kind,
      ) && !["SUCCESS", "FAILURE", "ERROR"].includes(transaction.status),
  );
export class OrderEditService {
  constructor(
    private readonly store: OrderEditStore,
    private readonly provider: OrderEditProvider,
    private readonly warehouse: OrderEditWarehouse,
    private readonly clock: () => Date,
    private readonly uuid: () => string,
    private readonly report: (event: {
      operationId: string;
      code: string;
    }) => void,
  ) {}

  async state() {
    return {
      connections: await this.store.connections(),
      customerAccess: false as const,
    };
  }
  async settings(
    connectionId: number,
    input: OrderEditSettingsInput,
    actorId: string,
  ) {
    return this.store.saveSettings(
      connectionId,
      orderEditSettingsInputSchema.parse(input),
      actorId,
      this.clock(),
    );
  }
  async orders(connectionId: number, search: string) {
    const orders = await this.store.findOrders(connectionId, search);
    return {
      orders: orders.map(
        ({
          omsOrderId,
          orderNumber,
          customerName,
          customerEmail,
          activeOperationId,
        }) => ({
          omsOrderId,
          orderNumber,
          customerName,
          customerEmail,
          activeOperationId,
        }),
      ),
    };
  }
  async variants(connectionId: number, search: string) {
    await this.store.settings(connectionId);
    return {
      variants: (await this.provider.searchVariants(connectionId, search)).map(
        (variant) => ({
          variantId: variant.id,
          title: variant.title,
          variantTitle: null,
          sku: variant.sku,
          priceCents: variant.priceCents,
          available: variant.available,
        }),
      ),
    };
  }
  async order(connectionId: number, omsOrderId: number) {
    const reference = await this.store.orderReference(connectionId, omsOrderId);
    const snapshot = await this.provider.readOrder(
      connectionId,
      reference.externalOrderId,
    );
    this.assertIdentity(reference, snapshot);
    const warehouse = await this.warehouse.inspect(omsOrderId);
    const reasons = [...warehouse.reasons, ...this.orderReasons(snapshot)];
    return orderEditOrderSchema.parse({
      omsOrderId,
      connectionId,
      orderNumber: snapshot.name,
      customerName: reference.customerName,
      customerEmail: reference.customerEmail,
      activeOperationId: reference.activeOperationId,
      currency: snapshot.currency,
      revision: snapshot.fingerprint,
      eligibility: {
        editable: warehouse.editable && reasons.length === 0,
        reasons,
      },
      lines: snapshot.lines.map((line) => ({
        lineItemId: line.id,
        variantId: line.variantId,
        title: line.title,
        variantTitle: line.variantTitle,
        sku: line.sku,
        quantity: line.quantity,
        unitPriceCents: line.discountedUnitPriceCents,
        totalCents:
          snapshot.financials?.lines.find((entry) => entry.id === line.id)
            ?.netCents ?? line.totalCents,
      })),
      totalCents: snapshot.totalCents,
      financials: snapshot.financials,
      settlement: presentOrderEditSettlement(snapshot),
      financialStatus: snapshot.fullyPaid ? "Paid" : "Payment outstanding",
      warehouseStatus: warehouse.editable
        ? "Not yet picking"
        : "Editing unavailable",
    });
  }
  async quote(
    raw: OrderEditQuoteInput,
    actorId: string,
  ): Promise<OrderEditOperation> {
    const input = orderEditQuoteInputSchema.parse(raw);
    const requestHash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    return this.store.withOrderLock(input.omsOrderId, async () => {
      const replay = await this.store.findByRequestKey(input.requestKey);
      if (replay) {
        if (replay.requestHash !== requestHash || replay.actorId !== actorId)
          throw new OrderEditError(
            "ORDER_EDIT_KEY_REUSED",
            "This request key belongs to a different edit.",
          );
        return this.present(replay);
      }
      const settings = await this.store.settings(input.connectionId);
      if (!settings.enabled || settings.paymentWindowMinutes === null)
        throw new OrderEditError(
          "ORDER_EDIT_DISABLED",
          "Save and enable the private order editor settings first.",
        );
      const reference = await this.store.orderReference(
        input.connectionId,
        input.omsOrderId,
      );
      const baseline = await this.provider.readOrder(
        input.connectionId,
        reference.externalOrderId,
      );
      this.assertIdentity(reference, baseline);
      if (baseline.fingerprint !== input.expectedRevision)
        throw new OrderEditError(
          "ORDER_EDIT_STALE_ORDER",
          "This order changed. Reload it before editing.",
        );
      const reasons = this.orderReasons(baseline);
      if (reasons.length)
        throw new OrderEditError("ORDER_EDIT_INELIGIBLE", reasons.join(" "));
      const now = this.clock();
      let record: OrderEditRecord = {
        id: this.uuid(),
        omsOrderId: input.omsOrderId,
        connectionId: input.connectionId,
        requestKey: input.requestKey,
        requestHash,
        actorId,
        status: "preparing",
        version: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        input,
        baseline,
        quote: null,
        paymentWindowMinutes: settings.paymentWindowMinutes,
        quoteDeadline: new Date(
          now.getTime() +
            settings.paymentWindowMinutes * MILLISECONDS_PER_MINUTE,
        ).toISOString(),
        paymentDeadline: null,
        commitKey: null,
        commitStartedAt: null,
        refundIntent: null,
        refundStartedAt: null,
        lastSnapshot: null,
        recoveryStartedAt: null,
        error: null,
      };
      await this.store.create(record);
      try {
        // Staging only calculates an uncommitted Shopify edit. It does not
        // change the order or move money, so it can overlap hold acquisition.
        // Await BOTH outcomes before releasing the order lock or exposing a
        // quote: a late hold must never outlive a failed preparation request.
        const [hold, preparation] = await Promise.allSettled([
          this.warehouse.acquire(record.omsOrderId, record.id),
          this.provider.quote(
            record.connectionId,
            baseline,
            { changes: input.changes, additions: input.additions },
            record.id,
          ),
        ]);
        if (hold.status === "rejected") {
          // Hold failure determines the persisted outcome. Keep the independent
          // preview failure observable as well when both branches fail.
          if (preparation.status === "rejected")
            this.report({
              operationId: record.id,
              code: this.failure(preparation.reason).code,
            });
          throw hold.reason;
        }
        if (preparation.status === "rejected") throw preparation.reason;
        const quote = preparation.value;
        if (
          quote.operationId !== record.id ||
          quote.orderId !== baseline.orderId ||
          quote.connectionId !== record.connectionId ||
          quote.baselineFingerprint !== baseline.fingerprint
        )
          throw new OrderEditError(
            "ORDER_EDIT_QUOTE_IDENTITY_INVALID",
            "The order edit quote did not match the requested order.",
          );
        record = await this.update(
          record,
          { status: "ready", quote },
          actorId,
          "quoted",
        );
      } catch (error) {
        record = await this.update(
          record,
          { status: "review_required", error: this.failure(error) },
          actorId,
          "quote_failed_held",
        );
      }
      return this.present(record);
    });
  }
  async get(id: string) {
    return this.present(await this.store.get(id));
  }
  async commit(id: string, key: string, actorId: string) {
    return this.locked(id, async (initial) => {
      let record = initial;
      if (record.commitKey && record.commitKey !== key)
        throw new OrderEditError(
          "ORDER_EDIT_COMMIT_KEY_REUSED",
          "Use the original confirmation request to check this edit.",
        );
      if (record.status !== "ready") return this.present(record);
      if (!record.quote)
        throw new OrderEditError(
          "ORDER_EDIT_QUOTE_MISSING",
          "This edit does not have a verified quote.",
        );
      if (this.clock().getTime() >= Date.parse(record.quoteDeadline))
        return this.abandonLocked(record, actorId);
      const settings = await this.store.settings(record.connectionId);
      if (!settings.enabled)
        throw new OrderEditError(
          "ORDER_EDIT_DISABLED",
          "The private order editor is disabled.",
        );
      await this.warehouse.assertHeld(record.omsOrderId, record.id);
      const fresh = await this.provider.readOrder(
        record.connectionId,
        record.baseline.orderId,
      );
      if (fresh.fingerprint !== record.baseline.fingerprint)
        throw new OrderEditError(
          "ORDER_EDIT_STALE_QUOTE",
          "The order changed after review. Do not apply this quote.",
        );
      const now = this.clock();
      record = await this.update(
        record,
        {
          status: "committing",
          commitKey: key,
          commitStartedAt: now.toISOString(),
          paymentDeadline: new Date(
            now.getTime() +
              record.paymentWindowMinutes * MILLISECONDS_PER_MINUTE,
          ).toISOString(),
        },
        actorId,
        "commit_intent",
      );
      try {
        const snapshot = await this.provider.commit(
          record.connectionId,
          record.quote!,
          record.id,
        );
        record = await this.update(
          record,
          { lastSnapshot: snapshot },
          actorId,
          "commit_observed",
        );
      } catch (error) {
        if (error instanceof OrderEditCommitNotSentError) {
          // Only the provider's explicit pre-send boundary permits removing
          // commit intent. The immutable commit_intent event remains evidence
          // of the attempt; cancellation must still verify the original order.
          record = await this.update(
            record,
            {
              status: "review_required",
              commitKey: null,
              commitStartedAt: null,
              paymentDeadline: null,
              error: this.failure(error),
            },
            actorId,
            "commit_not_submitted",
          );
          return this.present(record);
        }
        record = await this.update(
          record,
          { error: this.failure(error) },
          actorId,
          "commit_requires_readback",
        );
        return this.present(record);
      }
      return this.present(await this.progress(record, actorId));
    });
  }
  async reconcile(id: string, actorId: string | null = null) {
    return this.locked(id, async (record) =>
      this.present(await this.progress(record, actorId)),
    );
  }
  async abandon(id: string, actorId: string) {
    return this.locked(id, (record) => this.abandonLocked(record, actorId));
  }
  async sweep() {
    for (const id of await this.store.pending(
      RECONCILIATION_BATCH_SIZE,
      this.clock(),
    )) {
      try {
        await this.reconcile(id);
      } catch (error) {
        const known = this.failure(error);
        this.report({ operationId: id, code: known.code });
      }
    }
  }
  private async progress(
    initial: OrderEditRecord,
    actorId: string | null,
  ): Promise<OrderEditRecord> {
    let record = initial;
    if (terminal.has(record.status)) return record;
    if (!record.commitStartedAt) {
      if (this.clock().getTime() >= Date.parse(record.quoteDeadline)) {
        await this.abandonLocked(record, actorId);
        return this.store.get(record.id);
      }
      return record;
    }
    if (!record.quote)
      return this.review(
        record,
        actorId,
        new OrderEditError(
          "ORDER_EDIT_QUOTE_MISSING",
          "The saved quote requires staff review.",
        ),
      );
    const quote = record.quote;
    try {
      // Provider release can succeed before the local final transaction fails.
      // Reacquire with the original persisted ownership before retrying release.
      if (record.status === "synchronizing" || record.status === "recovering")
        await this.warehouse.acquire(record.omsOrderId, record.id);
      await this.warehouse.assertHeld(record.omsOrderId, record.id);
      if (record.recoveryStartedAt) {
        // No blind compensation retry after a crash or timeout. Verify the original contents instead.
        const recovery = await this.provider.reconcileRecovery(
          record.connectionId,
          record.baseline,
          record.id,
          record.quote ?? undefined,
        );
        if (recovery.status !== "restored")
          return this.review(
            record,
            actorId,
            new OrderEditError(
              "ORDER_EDIT_RECOVERY_UNCERTAIN",
              "Recovery needs verification. The order remains held.",
            ),
          );
        record = await this.update(
          record,
          { lastSnapshot: recovery.snapshot },
          actorId,
          "recovery_observed",
        );
        const proof = await this.warehouse.reconcileAndRelease(
          record.omsOrderId,
          record.id,
          recovery.snapshot,
        );
        return this.update(
          record,
          { status: "recovered", lastSnapshot: recovery.snapshot, error: null },
          actorId,
          "recovery_completed",
          proof,
        );
      }
      const observed = await this.provider.reconcileCommit(
        record.connectionId,
        record.baseline,
        quote,
        record.id,
      );
      if (observed.status !== "applied")
        return this.review(
          record,
          actorId,
          new OrderEditError(
            "ORDER_EDIT_COMMIT_UNCERTAIN",
            "The submitted edit could not be confirmed. The order remains held.",
          ),
        );
      const snapshot = observed.snapshot;
      record = await this.update(
        record,
        { lastSnapshot: snapshot, error: null },
        actorId,
        "provider_observed",
      );
      if (snapshot.totalCents !== quote.totalCents)
        return this.review(
          record,
          actorId,
          new OrderEditError(
            "ORDER_EDIT_TOTAL_CHANGED",
            "The order total changed after confirmation.",
          ),
        );
      // Even if the balance is now zero, reconcile OUR persisted refund before
      // releasing. An unrelated refund is not proof this command succeeded.
      if (record.refundIntent) return await this.settleRefund(record, actorId);
      if (unresolvedPayment(snapshot)) {
        if (
          snapshot.transactions.some(
            (transaction) => transaction.status === "UNKNOWN",
          )
        )
          return this.review(
            record,
            actorId,
            new OrderEditError(
              "ORDER_EDIT_PAYMENT_UNCERTAIN",
              "A payment has an uncertain outcome. The order remains held for staff review.",
            ),
          );
        return this.update(
          record,
          {
            status: "awaiting_payment",
            error: {
              code: "ORDER_EDIT_PAYMENT_PENDING",
              message:
                "A payment or refund is still processing. The order remains held and its status will be checked again.",
            },
          },
          actorId,
          "payment_processing",
        );
      }
      if (snapshot.outstandingCents > 0) {
        if (snapshot.netPaidCents !== record.baseline.netPaidCents)
          return this.review(
            record,
            actorId,
            new OrderEditError(
              "ORDER_EDIT_PARTIAL_PAYMENT",
              "An additional partial payment was received. Staff review is required.",
            ),
          );
        if (
          record.paymentDeadline &&
          this.clock().getTime() >= Date.parse(record.paymentDeadline)
        ) {
          record = await this.update(
            record,
            {
              status: "recovering",
              recoveryStartedAt: this.clock().toISOString(),
            },
            actorId,
            "recovery_intent",
          );
          const recovered = await this.provider.recoverUnpaid(
            record.connectionId,
            record.baseline,
            quote,
            record.id,
          );
          const recovery = await this.provider.reconcileRecovery(
            record.connectionId,
            record.baseline,
            record.id,
            quote,
          );
          if (
            recovery.status !== "restored" ||
            recovered.netPaidCents !== record.baseline.netPaidCents ||
            !recovered.fullyPaid ||
            unresolvedPayment(recovered)
          )
            return this.review(
              record,
              actorId,
              new OrderEditError(
                "ORDER_EDIT_LATE_PAYMENT",
                "Payment changed during recovery. The order remains held.",
              ),
            );
          record = await this.update(
            record,
            { lastSnapshot: recovery.snapshot },
            actorId,
            "recovery_observed",
          );
          const proof = await this.warehouse.reconcileAndRelease(
            record.omsOrderId,
            record.id,
            recovery.snapshot,
          );
          return this.update(
            record,
            { status: "recovered", error: null },
            actorId,
            "recovery_completed",
            proof,
          );
        }
        return this.update(
          record,
          { status: "awaiting_payment" },
          actorId,
          "awaiting_payment",
        );
      }
      const refundDue = snapshot.netPaidCents - snapshot.totalCents;
      if (refundDue > 0) {
        const expectedRefund = record.baseline.netPaidCents - quote.totalCents;
        if (refundDue !== expectedRefund)
          return this.review(
            record,
            actorId,
            new OrderEditError(
              "ORDER_EDIT_REFUND_CHANGED",
              "The refundable balance differs from the confirmed edit.",
            ),
          );
        if (!record.refundIntent) {
          const intent = await this.provider.prepareRefund(
            record.connectionId,
            snapshot,
            record.id,
            this.uuid(),
          );
          if (
            intent.amountCents !== expectedRefund ||
            intent.operationId !== record.id
          )
            throw new OrderEditError(
              "ORDER_EDIT_REFUND_INTENT_INVALID",
              "The refund differs from the confirmed amount.",
            );
          record = await this.update(
            record,
            {
              status: "refunding",
              refundIntent: intent,
              refundStartedAt: this.clock().toISOString(),
            },
            actorId,
            "refund_intent",
          );
        }
        return await this.settleRefund(record, actorId);
      } else if (
        snapshot.fullyPaid &&
        snapshot.netPaidCents === snapshot.totalCents
      ) {
        record = await this.update(
          record,
          { status: "synchronizing" },
          actorId,
          "payment_confirmed",
        );
      } else
        return this.review(
          record,
          actorId,
          new OrderEditError(
            "ORDER_EDIT_PAYMENT_UNVERIFIED",
            "The order payment could not be verified.",
          ),
        );
      const proof = await this.warehouse.reconcileAndRelease(
        record.omsOrderId,
        record.id,
        record.lastSnapshot!,
      );
      return this.update(
        record,
        { status: "completed", error: null },
        actorId,
        "completed",
        proof,
      );
    } catch (error) {
      if (record.status === "synchronizing" || record.status === "recovering")
        return this.update(
          record,
          { error: this.failure(error) },
          actorId,
          "synchronization_pending",
        );
      if (
        error instanceof OrderEditProviderError &&
        retryableProviderReadback.has(error.code)
      )
        return this.update(
          record,
          { error: this.failure(error) },
          actorId,
          record.status === "refunding"
            ? "refund_readback_pending"
            : "provider_readback_pending",
        );
      return this.review(record, actorId, error);
    }
  }
  private async settleRefund(
    initial: OrderEditRecord,
    actorId: string | null,
  ): Promise<OrderEditRecord> {
    let record = initial;
    if (!record.refundIntent || !record.refundStartedAt || !record.quote)
      throw new OrderEditError(
        "ORDER_EDIT_REFUND_INTENT_MISSING",
        "The saved refund intent requires staff review.",
      );
    const result = await this.provider.refund(
      record.connectionId,
      record.refundIntent,
      record.refundStartedAt,
    );
    if (result.status !== "succeeded")
      return this.update(
        record,
        { status: "refunding" },
        actorId,
        "refund_pending",
      );
    const observed = await this.provider.reconcileCommit(
      record.connectionId,
      record.baseline,
      record.quote,
      record.id,
    );
    const refunded = observed.snapshot;
    if (
      observed.status !== "applied" ||
      refunded.netPaidCents < refunded.totalCents
    )
      return this.review(
        record,
        actorId,
        new OrderEditError(
          "ORDER_EDIT_REFUND_UNVERIFIED",
          "The refund has not yet been fully confirmed.",
        ),
      );
    if (
      refunded.netPaidCents !== refunded.totalCents ||
      !refunded.fullyPaid ||
      unresolvedPayment(refunded)
    )
      return this.update(
        record,
        {
          status: "refunding",
          error: {
            code: "ORDER_EDIT_REFUND_PENDING",
            message:
              "The refund succeeded; waiting for the settled order balance before fulfillment resumes.",
          },
        },
        actorId,
        "refund_balance_pending",
      );
    record = await this.update(
      record,
      { lastSnapshot: refunded, status: "synchronizing" },
      actorId,
      "refund_confirmed",
    );
    try {
      const proof = await this.warehouse.reconcileAndRelease(
        record.omsOrderId,
        record.id,
        refunded,
      );
      return await this.update(
        record,
        { status: "completed", error: null },
        actorId,
        "completed",
        proof,
      );
    } catch (error) {
      return this.update(
        record,
        { error: this.failure(error) },
        actorId,
        "synchronization_pending",
      );
    }
  }
  private async abandonLocked(
    record: OrderEditRecord,
    actorId: string | null,
  ): Promise<OrderEditOperation> {
    if (
      record.commitStartedAt ||
      record.commitKey ||
      record.refundIntent ||
      record.refundStartedAt ||
      record.recoveryStartedAt
    )
      throw new OrderEditError(
        "ORDER_EDIT_ALREADY_SUBMITTED",
        "This edit has already been submitted. Check its status.",
      );
    if (terminal.has(record.status)) return this.present(record);
    const current = await this.provider.readOrder(
      record.connectionId,
      record.baseline.orderId,
    );
    const fulfilled = unchangedFulfilledOrderEdit(current, record.baseline);
    if (!fulfilled && !unchangedOrderEditSnapshot(current, record.baseline))
      return this.present(
        await this.review(
          record,
          actorId,
          new OrderEditError(
            "ORDER_EDIT_ABANDON_CONFLICT",
            "The order's items, payment, or fulfillment changed. Cancellation needs verification before its edit hold can be cleared.",
          ),
        ),
      );
    const proof = fulfilled
      ? await this.warehouse.releaseFulfilledUnsubmitted(
          record.omsOrderId,
          record.id,
        )
      : await this.warehouse.releaseUnchanged(record.omsOrderId, record.id);
    return this.present(
      await this.update(
        record,
        { status: "expired", error: null, lastSnapshot: current },
        actorId,
        fulfilled
          ? "uncommitted_edit_abandoned_after_fulfillment"
          : "uncommitted_edit_abandoned",
        proof,
      ),
    );
  }
  private async locked<T>(
    id: string,
    work: (record: OrderEditRecord) => Promise<T>,
  ) {
    const record = await this.store.get(id);
    return this.store.withOrderLock(record.omsOrderId, async () =>
      work(await this.store.get(id)),
    );
  }
  private async update(
    record: OrderEditRecord,
    patch: Partial<OrderEditRecord>,
    actorId: string | null,
    action: string,
    releaseProof?: OrderEditReleaseProof,
  ) {
    const next = {
      ...record,
      ...patch,
      version: record.version + 1,
      updatedAt: this.clock().toISOString(),
    };
    await this.store.save(next, record.version, actorId, action, releaseProof);
    return next;
  }
  private async review(
    record: OrderEditRecord,
    actorId: string | null,
    error: unknown,
  ) {
    const failure = this.failure(error);
    this.report({ operationId: record.id, code: failure.code });
    return this.update(
      record,
      { status: "review_required", error: failure },
      actorId,
      "review_required",
    );
  }
  private failure(error: unknown) {
    return error instanceof OrderEditError ||
      error instanceof OrderEditProviderError
      ? { code: error.code, message: error.message }
      : {
          code: "ORDER_EDIT_UNAVAILABLE",
          message:
            "This order edit needs verification. Check its status before trying again.",
        };
  }
  private orderReasons(snapshot: OrderEditSnapshot) {
    const reasons = [...snapshot.editableErrors];
    if (
      snapshot.evidence.countryCode !== "US" ||
      snapshot.lines.some((line) => line.quantity > 0 && line.unsupported)
    ) {
      reasons.push(
        "This pilot supports US physical-product orders with supported item pricing.",
      );
    }
    if (snapshot.refunds.length > 0)
      reasons.push(
        "Orders with previous refunds require staff review before editing.",
      );
    if (!snapshot.editable || snapshot.cancelled || snapshot.closed)
      reasons.push("Shopify does not allow editing this order.");
    if (
      !snapshot.fullyPaid ||
      snapshot.outstandingCents !== 0 ||
      snapshot.netPaidCents !== snapshot.totalCents ||
      snapshot.capturableCents !== 0 ||
      unresolvedPayment(snapshot)
    )
      reasons.push(
        "The original order must be fully paid with no payment or refund still processing.",
      );
    if (
      snapshot.lines.some((line) => line.quantity !== line.unfulfilledQuantity)
    )
      reasons.push("Picking or fulfillment has already started.");
    return reasons;
  }
  private assertIdentity(
    reference: {
      connectionId: number;
      channelId: number;
      externalOrderId: string;
      externalCustomerId: string | null;
    },
    snapshot: OrderEditSnapshot,
  ) {
    const externalId = reference.externalOrderId.split("/").at(-1);
    const customerId = reference.externalCustomerId?.split("/").at(-1) ?? null;
    if (
      snapshot.connectionId !== reference.connectionId ||
      snapshot.channelId !== reference.channelId ||
      snapshot.orderId !== `gid://shopify/Order/${externalId}` ||
      (snapshot.customerId?.split("/").at(-1) ?? null) !== customerId
    )
      throw new OrderEditError(
        "ORDER_EDIT_IDENTITY_CHANGED",
        "The Shopify order identity does not match Echelon.",
      );
  }
  private present(record: OrderEditRecord): OrderEditOperation {
    const snapshot = record.lastSnapshot ?? record.baseline;
    const quote = record.quote;
    const useCurrent = terminal.has(record.status);
    const presentedTotal = useCurrent
      ? snapshot.totalCents
      : (quote?.totalCents ?? snapshot.totalCents);
    const presentedPaid = useCurrent
      ? snapshot.netPaidCents
      : record.baseline.netPaidCents;
    return orderEditOperationSchema.parse({
      operationId: record.id,
      orderNumber: record.baseline.name,
      currency: record.baseline.currency,
      previousTotalCents: record.baseline.totalCents,
      updatedTotalCents: presentedTotal,
      quoteAvailable: quote !== null,
      shippingRepricing: quote?.shippingRepricing ?? null,
      balanceDueCents: Math.max(0, presentedTotal - presentedPaid),
      refundDueCents: Math.max(0, presentedPaid - presentedTotal),
      financials: {
        before: record.baseline.financials ?? null,
        quoted: quote?.financials ?? null,
        current: snapshot.financials ?? null,
      },
      settlement: presentOrderEditSettlement(snapshot),
      lines:
        quote && !useCurrent
          ? quote.lines.map((line) => ({
              id: line.calculatedLineId,
              title: line.title,
              variantTitle: line.variantTitle,
              quantity: line.quantity,
              totalCents:
                quote.financials?.lines.find(
                  (entry) => entry.id === line.calculatedLineId,
                )?.netCents ?? line.totalCents,
            }))
          : snapshot.lines.map((line) => ({
              id: line.id,
              title: line.title,
              variantTitle: line.variantTitle,
              quantity: line.quantity,
              totalCents:
                snapshot.financials?.lines.find((entry) => entry.id === line.id)
                  ?.netCents ?? line.totalCents,
            })),
      warnings: [
        "Private staff testing. Customer access is disabled.",
        quote?.shippingRepricing
          ? "Shipping is recalculated for the revised items using current checkout rates and eligible shipping benefits."
          : "This saved edit predates shipping recalculation. Start a new edit to recheck shipping.",
      ],
      canAbandon:
        !record.commitStartedAt &&
        !record.commitKey &&
        !record.refundIntent &&
        !record.refundStartedAt &&
        !record.recoveryStartedAt &&
        !terminal.has(record.status),
      status: record.status,
      expiresAt: record.commitStartedAt
        ? record.paymentDeadline
        : record.quoteDeadline,
      paymentDeadline: record.paymentDeadline,
      paymentUrl:
        record.status === "awaiting_payment" &&
        !unresolvedPayment(snapshot) &&
        record.paymentDeadline !== null &&
        this.clock().getTime() < Date.parse(record.paymentDeadline)
          ? snapshot.paymentUrl
          : null,
      error: record.error,
    });
  }
}
