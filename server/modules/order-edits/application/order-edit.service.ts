import {
  assertOrderEditIdentity,
  orderEditEligibilityReasons,
  orderEditHasUnresolvedPayment,
} from "./order-edit-identity";
import type { OrderEditPreviewService } from "./order-edit-preview.service";
import type { OrderEditCatalog } from "./order-edit-catalog";
import { orderEditCatalogVariantsInputSchema } from "@shared/order-edits/order-edit-catalog";
import type {
  OrderEditCatalogCategoriesInput,
  OrderEditCatalogProductsInput,
  OrderEditCatalogVariantsInput,
  OrderEditCatalogMode,
} from "@shared/order-edits/order-edit-catalog";
import type {
  OrderEditPreviewScope,
  OrderEditPreviewInput,
} from "@shared/order-edits/order-edit-preview";
import { createHash } from "node:crypto";
import { presentOrderEditSettlement, presentOrderEditFinancialStatus } from "../domain/order-edit-financials";
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
import { sameOrderEditPlan } from "../domain/order-edit-plan-identity";
import { orderEditHasSubmissionEvidence } from "./order-edit-submission";
import type { OrderEditCodeRedemptions } from "./order-edit-code-redemptions";
import { requiresOrderEditCodeReceipt } from "../domain/order-edit-coupon-boundary";
import { presentOrderEditCodeBreakdown, snapshotProductPrices, quoteProductPrices } from "./order-edit-code-presentation";
import {
  orderEditActorFingerprint,
  orderEditDiagnosticError,
  type OrderEditDiagnosticEvent,
} from "./order-edit-diagnostics";
import type { OrderCancellationService } from "../../customer-account/application/order-cancellation.service";
import { orderCancellationEligibilityReasons } from "../domain/order-cancellation-eligibility";
import { presentCustomerOrderLifecycle } from "@shared/customer-account/order-fulfillment";
import { customerAccountOrderDetailsSchema } from "@shared/customer-account/customer-account-orders";
import { orderAddressEligibility } from "../domain/order-address-eligibility";

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
export class OrderEditService {
  constructor(
    private readonly store: OrderEditStore,
    private readonly provider: OrderEditProvider,
    private readonly warehouse: OrderEditWarehouse,
    private readonly clock: () => Date,
    private readonly uuid: () => string,
    private readonly report: (event: OrderEditDiagnosticEvent) => void,
    private readonly previews?: OrderEditPreviewService,
    private readonly catalog?: OrderEditCatalog,
    private readonly codeRedemptions?: OrderEditCodeRedemptions,
    readonly cancellations?: OrderCancellationService,
  ) {}

  async warmPreview(input: OrderEditPreviewScope, actorId: string) {
    if (!this.previews)
      throw new OrderEditError(
        "ORDER_EDIT_PREVIEW_UNAVAILABLE",
        "Background preview is unavailable. Review can still verify changes.",
        503,
      );
    return this.previews.warm(input, actorId);
  }
  async preview(input: OrderEditPreviewInput, actorId: string) {
    if (!this.previews)
      throw new OrderEditError(
        "ORDER_EDIT_PREVIEW_UNAVAILABLE",
        "Background preview is unavailable. Review can still verify changes.",
        503,
      );
    return this.previews.preview(input, actorId);
  }
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
  async catalogCategories(
    connectionId: number,
    input: OrderEditCatalogCategoriesInput,
  ) {
    await this.store.settings(connectionId);
    return this.requireCatalog().categories(connectionId, input);
  }
  async catalogProducts(
    connectionId: number,
    input: OrderEditCatalogProductsInput,
    mode: OrderEditCatalogMode = "editable",
  ) {
    await this.store.settings(connectionId);
    return this.requireCatalog().products(connectionId, input, mode);
  }
  async catalogVariants(
    connectionId: number,
    input: OrderEditCatalogVariantsInput,
    actorId?: string,
    mode: OrderEditCatalogMode = "editable",
  ) {
    const settings = await this.store.settings(connectionId);
    const parsed = orderEditCatalogVariantsInputSchema.parse(input);
    if (parsed.omsOrderId === null)
      return this.requireCatalog().productVariants(
        connectionId,
        parsed,
        undefined,
        mode,
      );
    if (!settings.enabled || settings.paymentWindowMinutes === null || !actorId)
      throw new OrderEditError(
        "ORDER_EDIT_CATALOG_UNAVAILABLE",
        "Customer pricing is unavailable for this order.",
        409,
      );
    const scope = {
      connectionId,
      omsOrderId: parsed.omsOrderId,
      expectedRevision: parsed.expectedRevision!,
    };
    let snapshot: OrderEditSnapshot;
    if (this.previews)
      snapshot = await this.previews.catalogSnapshot(scope, actorId);
    else {
      const reference = await this.store.orderReference(
        connectionId,
        parsed.omsOrderId,
      );
      if (reference.activeOperationId)
        throw new OrderEditError(
          "ORDER_EDIT_ALREADY_ACTIVE",
          "Close or resume the current edit before browsing products.",
          409,
        );
      snapshot = await this.provider.readOrder(
        connectionId,
        reference.externalOrderId,
      );
      assertOrderEditIdentity(reference, snapshot);
      if (snapshot.fingerprint !== parsed.expectedRevision)
        throw new OrderEditError(
          "ORDER_EDIT_ORDER_CHANGED",
          "The order changed. Refresh it before browsing products.",
          409,
        );
    }
    return this.requireCatalog().productVariants(
      connectionId,
      parsed,
      {
        connectionId: snapshot.connectionId,
        customerId: snapshot.customerId,
        memberPlan: snapshot.memberPlan,
        memberPricingEnabled: snapshot.memberPricingEnabled,
      },
      mode,
    );
  }
  private requireCatalog(): OrderEditCatalog {
    if (!this.catalog)
      throw new OrderEditError(
        "ORDER_EDIT_CATALOG_UNAVAILABLE",
        "Product browsing is unavailable. Try again.",
        503,
      );
    return this.catalog;
  }
  async order(
    connectionId: number,
    omsOrderId: number,
    codeEntryVersion?: "v1",
    actorId?: string,
  ) {
    const reference = await this.store.orderReference(connectionId, omsOrderId);
    const snapshot = await this.provider.readOrder(
      connectionId,
      reference.externalOrderId,
    );
    assertOrderEditIdentity(reference, snapshot);
    const active =
      reference.activeOperationId
        ? await this.store.get(reference.activeOperationId)
        : null;
    // Only the authenticated owner can treat this operation's hold as its own.
    // Other holds and all picking/shipping blockers remain in the inspection.
    const ownedOperationId =
      active &&
      active.actorId === actorId &&
      active.omsOrderId === omsOrderId &&
      active.connectionId === connectionId &&
      !terminal.has(active.status)
        ? active.id
        : undefined;
    if (ownedOperationId) assertOrderEditIdentity(reference, active!.baseline);
    const warehouse = await this.warehouse.inspect(
      omsOrderId,
      ownedOperationId,
    );
    const reasons = [
      ...warehouse.reasons,
      ...orderEditEligibilityReasons(snapshot),
    ];
    const cancellationEnabled = this.cancellations ? (await this.store.settings(connectionId)).enabled : false;
    const fulfillment = warehouse.fulfillment && presentCustomerOrderLifecycle(warehouse.fulfillment, snapshot.cancelled);
    const cancellationReasons = orderCancellationEligibilityReasons({ snapshot, warehouseReasons: warehouse.cancellationReasons ?? warehouse.reasons,
      activeOperationId: reference.activeOperationId, activeOperationStatus: active?.status, enabled: cancellationEnabled });
    const addressEligibility = orderAddressEligibility({ editEligible: warehouse.editable && reasons.length === 0,
      editReasons: reasons, activeOperationId: reference.activeOperationId, activeOperationStatus: active?.status });
    return orderEditOrderSchema.parse({
      ...(codeEntryVersion === "v1"
        ? {
            codeEntryAvailable: true,
            appliedCodes: snapshot.codePricing?.applications ?? [],
          }
        : {}),
      omsOrderId,
      connectionId,
      orderNumber: snapshot.name,
      customerName: reference.customerName,
      customerEmail: reference.customerEmail,
      activeOperationId: reference.activeOperationId,
      ...(active ? { activeOperationKind: active.kind ?? "edit", activeOperationStatus: active.status } : {}),
      addressEligibility,
      cancellation: {
        canReview: cancellationReasons.length === 0,
        reasons: cancellationReasons,
        requestKey: active?.kind === "cancel_order" && active.actorId === actorId ? active.requestKey : null,
      },
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
      financials: presentOrderEditCodeBreakdown(
        snapshot.financials,
        snapshot.codePricing,
        snapshotProductPrices(snapshot),
      ),
      settlement: presentOrderEditSettlement(snapshot),
      financialStatus: presentOrderEditFinancialStatus(snapshot),
      warehouseStatus: fulfillment?.label ?? "Status unavailable",
      ...(fulfillment ? { fulfillment } : {}),
    });
  }
  /** Query-only account reads deliberately do not resolve OMS, inspect warehouse
   * eligibility, prepare calculated orders, or create an operation/hold. */
  async orderSummaries(connectionId: number, externalOrderIds: readonly string[]) {
    if (!this.provider.readOrderSummaries)
      throw new OrderEditError("CUSTOMER_ACCOUNT_HISTORY_UNAVAILABLE", "Order history is temporarily unavailable. Please try again.", 503);
    return this.provider.readOrderSummaries(connectionId, externalOrderIds);
  }
  async customerOrderDetails(connectionId: number, externalOrderId: string, expectedCustomerId: string) {
    if (!/^gid:\/\/shopify\/Customer\/[1-9]\d*$/.test(expectedCustomerId))
      throw new OrderEditError("CUSTOMER_ACCOUNT_ORDER_UNAVAILABLE", "This order is unavailable.", 404);
    let snapshot: OrderEditSnapshot;
    try { snapshot = await this.provider.readOrder(connectionId, externalOrderId, expectedCustomerId); }
    catch (cause) {
      if (cause instanceof OrderEditProviderError && ["ORDER_NOT_FOUND", "CUSTOMER_ACCOUNT_ORDER_UNAVAILABLE"].includes(cause.code))
        throw new OrderEditError("CUSTOMER_ACCOUNT_ORDER_UNAVAILABLE", "This order is unavailable.", 404);
      throw cause;
    }
    if (snapshot.connectionId !== connectionId || snapshot.orderId !== `gid://shopify/Order/${externalOrderId}` || snapshot.customerId !== expectedCustomerId)
      throw new OrderEditError("CUSTOMER_ACCOUNT_ORDER_UNAVAILABLE", "This order is unavailable.", 404);
    return customerAccountOrderDetailsSchema.parse({
      externalOrderId, orderReference: snapshot.name, currency: snapshot.currency, totalCents: snapshot.totalCents,
      lines: snapshot.lines.map(line => ({ lineItemId: line.id, variantId: line.variantId, title: line.title,
        variantTitle: line.variantTitle, sku: line.sku, quantity: line.quantity, unitPriceCents: line.discountedUnitPriceCents,
        totalCents: snapshot.financials?.lines.find(entry => entry.id === line.id)?.netCents ?? line.totalCents })),
      financials: presentOrderEditCodeBreakdown(snapshot.financials, snapshot.codePricing, snapshotProductPrices(snapshot)),
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
      assertOrderEditIdentity(reference, baseline);
      if (baseline.fingerprint !== input.expectedRevision)
        throw new OrderEditError(
          "ORDER_EDIT_STALE_ORDER",
          "This order changed. Reload it before editing.",
        );
      const reasons = orderEditEligibilityReasons(baseline);
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
      return this.prepareQuote(record, actorId);
    });
  }
  /** Recalculate an owned, unsubmitted attempt in place. Never submit an order or payment. */
  async resume(id: string, actorId: string): Promise<OrderEditOperation> {
    return this.locked(id, async (record) => {
      const reference = await this.store.orderReference(
        record.connectionId,
        record.omsOrderId,
      );
      if (
        record.actorId !== actorId ||
        reference.activeOperationId !== record.id ||
        terminal.has(record.status)
      )
        throw new OrderEditError(
          "ORDER_EDIT_RESUME_UNAVAILABLE",
          "This saved edit is no longer available. Reload your order.",
          409,
        );
      // Unknown/submitted outcomes must use reconciliation, never preparation.
      if (orderEditHasSubmissionEvidence(record))
        return this.present(record, "v1");
      // Also clears legacy quote-time holds and a submission interrupted before
      // its durable Shopify command intent. Reopening never acquires a hold.
      record = await this.releaseUnsubmitted(record, actorId);
      if (record.error?.code === "ORDER_EDIT_HOLD_RELEASE_PENDING")
        return this.present(record, "v1");
      if (!["preparing", "ready", "review_required"].includes(record.status))
        return this.present(record, "v1");
      if (
        record.status === "ready" &&
        record.quote &&
        !record.error &&
        Date.parse(record.quoteDeadline) > this.clock().getTime()
      )
        return this.present(record, "v1");
      const settings = await this.store.settings(record.connectionId);
      if (!settings.enabled || settings.paymentWindowMinutes === null)
        throw new OrderEditError(
          "ORDER_EDIT_DISABLED",
          "Order editing is temporarily unavailable.",
        );
      const current = await this.provider.readOrder(
        record.connectionId,
        record.baseline.orderId,
      );
      assertOrderEditIdentity(reference, current);
      assertOrderEditIdentity(reference, record.baseline);
      if (current.fingerprint !== record.baseline.fingerprint)
        return this.present(
          await this.review(
            record,
            actorId,
            new OrderEditError(
              "ORDER_EDIT_STALE_ORDER",
              "Your order changed since this edit was saved. Cancel this edit and reload the order.",
            ),
          ),
          "v1",
        );
      const reasons = orderEditEligibilityReasons(current);
      if (reasons.length)
        return this.present(
          await this.review(
            record,
            actorId,
            new OrderEditError("ORDER_EDIT_INELIGIBLE", reasons.join(" ")),
          ),
          "v1",
        );
      const preparing = await this.update(
        record,
        {
          status: "preparing",
          quote: null,
          error: null,
          paymentWindowMinutes: settings.paymentWindowMinutes,
          quoteDeadline: new Date(
            this.clock().getTime() +
              settings.paymentWindowMinutes * MILLISECONDS_PER_MINUTE,
          ).toISOString(),
        },
        actorId,
        "quote_preparation_resumed",
      );
      return this.prepareQuote(preparing, actorId, "v1");
    }).catch((error: unknown) => {
      this.report({
        operationId: id,
        code: this.failure(error).code,
        phase: "resume",
        actorFingerprint: orderEditActorFingerprint(actorId),
        occurredAt: this.clock().toISOString(),
        error: orderEditDiagnosticError(error),
      });
      throw error;
    });
  }
  private async prepareQuote(
    initial: OrderEditRecord,
    actorId: string,
    codeEntryVersion?: "v1",
  ): Promise<OrderEditOperation> {
    let record = initial;
    const { input, baseline } = record;
    let phase = "preparation";
    const reportFailure = (failedPhase: string, error: unknown) =>
      this.report({
        operationId: record.id,
        code: this.failure(error).code,
        phase: failedPhase,
        omsOrderId: record.omsOrderId,
        connectionId: record.connectionId,
        actorFingerprint: orderEditActorFingerprint(actorId),
        occurredAt: this.clock().toISOString(),
        error: orderEditDiagnosticError(error),
      });
    try {
      phase = "warehouse_inspection";
      const warehouse = await this.warehouse.inspect(record.omsOrderId);
      if (!warehouse.editable)
        throw new OrderEditError(
          "ORDER_EDIT_PICKING_CUTOFF",
          warehouse.reasons.join(" "),
        );
      phase = "shopify_quote";
      // A quote is only a draft. Fulfillment remains free to proceed; submission
      // must acquire ownership and revalidate the quote before any order write.
      const quote = await this.provider.quote(
        record.connectionId,
        baseline,
        {
          changes: input.changes,
          additions: input.additions,
          ...(input.discountCodes !== undefined
            ? { discountCodes: input.discountCodes }
            : {}),
        },
        record.id,
      );
      phase = "quote_identity";
      if (
        quote.operationId !== record.id ||
        quote.orderId !== baseline.orderId ||
        quote.connectionId !== record.connectionId ||
        quote.baselineFingerprint !== baseline.fingerprint ||
        !sameOrderEditPlan(quote.plan, input) ||
        (input.discountCodes?.length && !quote.codePricing)
      )
        throw new OrderEditError(
          "ORDER_EDIT_QUOTE_IDENTITY_INVALID",
          "The order edit quote did not match the requested order.",
        );
      phase = "quote_persist";
      record = await this.update(
        record,
        { status: "ready", quote },
        actorId,
        "quoted",
      );
    } catch (error) {
      if (phase !== "preparation") reportFailure(phase, error);
      const failure = this.failure(error);
      record = await this.update(
        record,
        {
          status: "review_required",
          error:
            failure.code === "ORDER_EDIT_UNAVAILABLE"
              ? {
                  ...failure,
                  message:
                    "We couldn't verify your changes. No order changes were applied. Cancel this attempt and try again.",
                }
              : failure,
        },
        actorId,
        "quote_failed",
      );
    }
    return this.present(record, codeEntryVersion);
  }
  async get(id: string, codeEntryVersion?: "v1") {
    const record = await this.store.get(id);
    this.requireEdit(record);
    return this.present(record, codeEntryVersion);
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
      // Persist approval before acquisition. If this process stops before the
      // financial intent below, the worker can prove that no command was sent.
      record = await this.update(
        record,
        { status: "committing", error: null },
        actorId,
        "submission_started",
      );
      let submissionPhase = "warehouse_acquisition";
      try {
        await this.warehouse.acquire(record.omsOrderId, record.id);
        submissionPhase = "shopify_revalidation";
        const fresh = await this.provider.readOrder(
          record.connectionId,
          record.baseline.orderId,
        );
        if (fresh.fingerprint !== record.baseline.fingerprint)
          throw new OrderEditError(
            "ORDER_EDIT_STALE_QUOTE",
            "The order changed after review. Do not apply this quote.",
          );
      } catch (error) {
        this.reportSubmissionFailure(record, actorId, submissionPhase, error);
        record = await this.review(record, actorId, error);
        return this.present(await this.releaseUnsubmitted(record, actorId));
      }
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
          () => this.codes(record, "reserve"),
        );
        record = await this.update(
          record,
          { lastSnapshot: snapshot },
          actorId,
          "commit_observed",
        );
      } catch (error) {
        this.reportSubmissionFailure(record, actorId, "shopify_commit", error);
        if (error instanceof OrderEditCommitNotSentError) {
          // Only the provider's explicit pre-send boundary permits removing
          // commit intent. Audit both the attempt and proof of no submission.
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
          return this.present(await this.releaseUnsubmitted(record, actorId));
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
        const record = await this.store.get(id);
        if (record.kind === "cancel_order") {
          if (!this.cancellations) throw new OrderEditError("ORDER_CANCELLATION_UNAVAILABLE", "Cancellation reconciliation is unavailable.");
          await this.cancellations.reconcile(id);
        } else await this.reconcile(id);
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
    if (!orderEditHasSubmissionEvidence(record)) {
      record = await this.releaseUnsubmitted(record, actorId);
      if (record.error?.code === "ORDER_EDIT_HOLD_RELEASE_PENDING")
        return record;
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
        await this.codes(record, "release");
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
      if (orderEditHasUnresolvedPayment(snapshot)) {
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
            orderEditHasUnresolvedPayment(recovered)
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
          await this.codes(record, "release");
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
      await this.codes(record, "finalize");
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
      orderEditHasUnresolvedPayment(refunded)
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
      await this.codes(record, "finalize");
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
    if (orderEditHasSubmissionEvidence(record))
      throw new OrderEditError(
        "ORDER_EDIT_ALREADY_SUBMITTED",
        "This edit has already been submitted. Check its status.",
      );
    if (terminal.has(record.status)) return this.present(record);
    // Drafts have no authority over order contents. Picking, fulfillment, or an
    // unrelated order update must not prevent discarding an unsubmitted draft.
    await this.codes(record, "release");
    const proof = await this.warehouse.releaseUnsubmitted(
      record.omsOrderId,
      record.id,
    );
    return this.present(
      await this.update(
        record,
        { status: "expired", error: null },
        actorId,
        "uncommitted_edit_abandoned",
        proof,
      ),
    );
  }
  private async releaseUnsubmitted(
    record: OrderEditRecord,
    actorId: string | null,
  ): Promise<OrderEditRecord> {
    if (orderEditHasSubmissionEvidence(record))
      throw new OrderEditError(
        "ORDER_EDIT_ALREADY_SUBMITTED",
        "This edit has already been submitted. Check its status.",
      );
    try {
      const proof = await this.warehouse.releaseUnsubmitted(
        record.omsOrderId,
        record.id,
      );
      if (
        proof.wmsOrderIds.length ||
        proof.shipmentIds.length ||
        record.status === "committing"
      )
        record = await this.update(
          record,
          {
            // A crash before sending must not resume the approved submission automatically.
            ...(record.status === "committing"
              ? {
                  status: "review_required" as const,
                  error: {
                    code: "ORDER_EDIT_SUBMISSION_INTERRUPTED",
                    message:
                      "Your changes were not submitted. Please try again.",
                  },
                }
              : {}),
          },
          actorId,
          "unsubmitted_hold_released",
          proof,
        );
      // Legacy reservation cleanup has no authority over fulfillment when no
      // order command was sent. Release warehouse ownership first; a reservation
      // outage remains retryable without holding the customer's original order.
      await this.codes(record, "release");
      if (record.error?.code === "ORDER_EDIT_HOLD_RELEASE_PENDING")
        record = await this.update(
          record,
          { error: null },
          actorId,
          "unsubmitted_cleanup_completed",
        );
      return record;
    } catch (error) {
      // Keep a durable retryable state. The worker selects unsubmitted ownership
      // even in review_required, unlike the previous quote-time hold lifecycle.
      this.reportSubmissionFailure(
        record,
        actorId,
        "unsubmitted_hold_release",
        error,
      );
      return this.review(
        record,
        actorId,
        new OrderEditError(
          "ORDER_EDIT_HOLD_RELEASE_PENDING",
          "Your changes were not submitted. We are finishing cleanup; please try again shortly.",
        ),
      );
    }
  }
  private async locked<T>(
    id: string,
    work: (record: OrderEditRecord) => Promise<T>,
  ) {
    const record = await this.store.get(id);
    this.requireEdit(record);
    return this.store.withOrderLock(record.omsOrderId, async () =>
      work(await this.store.get(id)),
    );
  }
  private requireEdit(record: OrderEditRecord): void {
    if (record.kind === "cancel_order") throw new OrderEditError("ORDER_CANCELLATION_SEPARATE_FLOW", "Open Manage order to check this cancellation.");
  }
  private reportSubmissionFailure(
    record: OrderEditRecord,
    actorId: string | null,
    phase: string,
    error: unknown,
  ): void {
    this.report({
      operationId: record.id,
      code: this.failure(error).code,
      phase,
      omsOrderId: record.omsOrderId,
      connectionId: record.connectionId,
      ...(actorId
        ? { actorFingerprint: orderEditActorFingerprint(actorId) }
        : {}),
      occurredAt: this.clock().toISOString(),
      error: orderEditDiagnosticError(error),
    });
  }
  private async codes(
    record: OrderEditRecord,
    action: "reserve" | "finalize" | "release",
  ): Promise<void> {
    if (!requiresOrderEditCodeReceipt(record.quote?.codePricing)) return;
    if (!this.codeRedemptions?.available())
      throw new OrderEditError(
        "ORDER_EDIT_CODES_UNAVAILABLE",
        "The code redemption service is unavailable. The order remains held until its code result is verified.",
        503,
      );
    await this.codeRedemptions[action](record.id);
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
  private present(
    record: OrderEditRecord,
    codeEntryVersion?: "v1",
  ): OrderEditOperation {
    const snapshot = record.lastSnapshot ?? record.baseline;
    const quote = record.quote;
    const useCurrent = terminal.has(record.status);
    const presentedTotal = useCurrent
      ? snapshot.totalCents
      : (quote?.totalCents ?? snapshot.totalCents);
    // Once submission starts, payment/refund observations are authoritative
    // even while fulfillment synchronization still prevents terminal closure.
    const presentedPaid =
      useCurrent || record.commitStartedAt !== null
        ? snapshot.netPaidCents
        : record.baseline.netPaidCents;
    const originalVariants = new Set(
      record.baseline.lines
        .filter((line) => line.quantity > 0 && line.variantId !== null)
        .map((line) => line.variantId),
    );
    return orderEditOperationSchema.parse({
      ...(record.input.discountCodes !== undefined || codeEntryVersion === "v1"
        ? {
            codeEntryAvailable: true,
            appliedCodes: quote?.codePricing?.applications ?? [],
            requestedPlan: {
              changes: record.input.changes,
              additions: record.input.additions,
              discountCodes: record.input.discountCodes ?? [],
            },
            expectedRevision: record.input.expectedRevision,
          }
        : {}),
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
        before:
          presentOrderEditCodeBreakdown(
            record.baseline.financials,
            record.baseline.codePricing,
            snapshotProductPrices(record.baseline),
          ) ?? null,
        quoted:
          presentOrderEditCodeBreakdown(
            quote?.financials,
            quote?.codePricing,
            quoteProductPrices(quote),
          ) ?? null,
        current:
          presentOrderEditCodeBreakdown(
            snapshot.financials,
            snapshot.codePricing,
            snapshotProductPrices(snapshot),
          ) ?? null,
      },
      settlement: presentOrderEditSettlement(snapshot),
      lines:
        quote && !useCurrent
          ? quote.lines.map((line) => ({
              id: line.calculatedLineId,
              variantId: line.variantId,
              added:
                line.variantId !== null &&
                !originalVariants.has(line.variantId),
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
              variantId: line.variantId,
              added:
                line.variantId !== null &&
                !originalVariants.has(line.variantId),
              title: line.title,
              variantTitle: line.variantTitle,
              quantity: line.quantity,
              totalCents:
                snapshot.financials?.lines.find((entry) => entry.id === line.id)
                  ?.netCents ?? line.totalCents,
            })),
      warnings: [
        "Private staff testing. Customer access is disabled.",
        ...(quote
          ? [
              quote.shippingRepricing
                ? "Shipping is recalculated for the revised items using current checkout rates and eligible shipping benefits."
                : "This saved edit predates shipping recalculation. Start a new edit to recheck shipping.",
            ]
          : []),
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
        !orderEditHasUnresolvedPayment(snapshot) &&
        record.paymentDeadline !== null &&
        this.clock().getTime() < Date.parse(record.paymentDeadline)
          ? snapshot.paymentUrl
          : null,
      error: record.error,
    });
  }
}
