import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { readIntegerCents } from "@shared/money-read";
import { purchaseApprovalInputSchema } from "@shared/procurement/purchase-approval-command";
import { supplierDispatchConfirmationSchema } from "@shared/procurement/supplier-dispatch";
import {
  apPaymentAllocations as apPaymentAllocationsTable,
  apPayments as apPaymentsTable,
  poEvents as poEventsTable,
  poExceptions as poExceptionsTable,
  purchaseOrderLines as purchaseOrderLinesTable,
  purchaseOrders as purchaseOrdersTable,
  vendorInvoiceLines,
} from "@shared/schema";
import type { PoFinancialStatus, PoPhysicalStatus } from "@shared/schema/procurement.schema";
import { createDrizzleFinancialCommandRepository } from "../../../platform/commands/command-results.repository";
import {
  recomputePoFinancialAggregates,
  recomputePurchaseOrderInvoiceMatchesInTransaction,
} from "../application/ap-ledger.service";
import {
  assertPurchaseOrderCancellationAuthority,
  getPurchaseOrderCancellationPermission,
  PurchaseOrderCancellationAuthorityError,
} from "../domain/purchase-order-cancellation-authority";
import {
  detectMatchMismatch,
  detectPastDue,
  detectQtyVariance,
} from "../application/po-exceptions.service";
import { createPurchaseApprovalCommands } from "../application/purchase-approval.commands";
import { purchaseApprovalLinesFingerprint } from "../application/purchase-approval-review";
import {
  assertPurchaseApprovalPermission,
  buildPurchaseApprovalSnapshot,
  PurchaseApprovalAuthorityError,
  purchaseApprovalSnapshotCovers,
} from "../domain/purchase-order-approval.policy";
import {
  buildPoCloseChange,
  buildPoCloseShortChange,
  buildPoCloseShortLinePatch,
  normalizePoCloseShortReason,
} from "../application/purchase-order-close.service";
import { validateDeliverySchedulePatch } from "../application/purchase-order-delivery-schedule";
import type { PurchaseOrderEntryTransaction } from "../infrastructure/purchase-order-entry.repository";
import {
  buildPhysicalTransitionChange,
  type PoLifecycleCommand,
} from "../application/purchase-order-lifecycle.service";
import { purchaseOrderUpdatedAtMatchesApplicationVersion } from "../application/purchase-order-lifecycle-version";
import type { PurchasingCatalog } from "./purchasing-catalog";
import type { PurchasingLifecycleLocks } from "./purchasing-lifecycle-locks";
import type { PurchasingReceiving } from "./purchasing-receiving";
import {
  ACCEPTABLE_PO_MATCH_VARIANCE_STATUSES,
  ACTIVE_RECEIPT_STATUSES,
  CANCELLABLE_FROM,
  PHYSICAL_LIFECYCLE_EVENTS,
  PurchasingError,
  VOIDABLE_FROM,
  type LifecycleExpectation,
  type LockedSendResult,
  type PoLifecycleCommandInput,
  type PurchasingBaseContext,
} from "./purchasing.types";

export function createPurchasingLifecycleActions(
  ctx: PurchasingBaseContext,
  locks: PurchasingLifecycleLocks,
  deps: {
    persistCompletedVendorPurchaseEvidenceTx: PurchasingCatalog["persistCompletedVendorPurchaseEvidenceTx"];
    createReceiptFromPO: PurchasingReceiving["createReceiptFromPO"];
  },
) {
  const {
    db,
    storage,
    now,
    readApprovalActor,
    readCommandActor,
    reconcileApprovedInvoiceCost,
    lockInventoryCostGraph,
    emitPoEventTx,
    getProcurementSettingsTx,
  } = ctx;
  const {
    observeLifecycleVersion,
    observeLifecycleState,
    lockLifecycleHeader,
    lockLifecycleEconomics,
    getMatchingApprovalTierTx,
    getActiveApprovalTiersTx,
    lifecycleTotalsPatch,
    assertLifecycleReadyToAdvanceTx,
    updateLockedLifecycleHeader,
    approvalCoversLockedEconomics,
    toPurchasingError,
    updatePurchaseOrderStatusWithHistoryTx,
    updatePurchaseOrderLineTx,
    writeLifecycleAuditTx,
    moveLockedPoToPendingApproval,
  } = locks;
  const { persistCompletedVendorPurchaseEvidenceTx, createReceiptFromPO } = deps;

  /**
   * Transition the physical (goods-movement) status of a PO.
   *
   * Validates through purchase-order-lifecycle.service, stamps the appropriate
   * lifecycle timestamp, syncs the legacy `status` column for back-compat,
   * and writes a po_status_history row with old/new physical status.
   *
   * Rule #7: status history and po_events are written in the same transaction
   * so a lifecycle action cannot leave an audit gap.
   */
  async function transitionPhysical(
    poId: number,
    target: PoPhysicalStatus,
    userId?: string,
    notes?: string,
    extraPatch?: Record<string, any>,
    historyFromStatus?: string,
  ): Promise<any> {
    // Supplier dispatch must use the reviewed, explicitly attested send owner.
    if (target === "sent") {
      throw new PurchasingError("Use Record external send with the reviewed PO version to record supplier dispatch.", 400, { code: "PO_EXTERNAL_DISPATCH_CONFIRMATION_REQUIRED" });
    }
    // Every cancellation entry point uses the same authority and line/audit owner.
    const acknowledgementFields = new Set(["vendorAckDate", "vendorRefNumber", "confirmedDeliveryDate"]);
    if (extraPatch && Object.keys(extraPatch).some(key => target !== "acknowledged" || !acknowledgementFields.has(key))) {
      throw new PurchasingError("Physical transitions do not accept lifecycle or unrelated field overrides", 400, { code: "PO_LIFECYCLE_PATCH_UNSUPPORTED" });
    }
    if (target === "cancelled") {
      return cancel(poId, notes ?? "", userId);
    }
    const expectation = await observeLifecycleVersion(poId);
    const eventType = PHYSICAL_LIFECYCLE_EVENTS[target];
    const result = await db.transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
      const po = await lockLifecycleHeader(tx, poId, expectation);
      if (extraPatch?.confirmedDeliveryDate !== undefined) {
        const issues = validateDeliverySchedulePatch(po, {
          confirmedDeliveryDate: extraPatch.confirmedDeliveryDate,
        });
        if (issues.length > 0) {
          const issue = issues[0];
          throw new PurchasingError(issue.message, 400, issue);
        }
      }
      const change = (() => {
        try {
          return buildPhysicalTransitionChange({
            po,
            target,
            userId,
            notes,
            extraPatch,
            historyFromStatus,
          });
        } catch (error) {
          return toPurchasingError(error);
        }
      })();
      const updated = await updatePurchaseOrderStatusWithHistoryTx(
        tx,
        poId,
        change.patch,
        change.history,
      );

      if (eventType) {
        await emitPoEventTx(tx, poId, eventType, userId, {
          from_status: change.history.fromStatus,
          to_status: change.history.toStatus,
          physical_status: target,
        });
      }

      return updated;
    });

    // ── Exception detection hooks (event-driven, Phase 1) ──────────────────
    // Run after the DB write so detection reads fresh data.
    // Non-blocking: detection failures should not roll back the status transition.
    try {
      // Qty variance: detect after goods are received.
      if (target === "received") {
        await detectQtyVariance(poId);
      }
      // Past-due: lazy detection on any physical transition.
      await detectPastDue(poId);
    } catch (detectionErr) {
      // Log but don't throw — detection is best-effort, not transactional.
      console.error("[po-exceptions] detection hook failed in transitionPhysical:", detectionErr);
    }

    return result;
  }

  /** @deprecated Invoice and payment commands exclusively own financial state.
   * Retain the service signature so older callers receive an explicit rejection
   * instead of silently bypassing ledger evidence or stamping false milestones. */
  async function transitionFinancial(
    _poId: number,
    _target: PoFinancialStatus,
    _userId?: string,
    _notes?: string,
    extraPatch?: Record<string, any>,
  ): Promise<never> {
    if (extraPatch && Object.keys(extraPatch).length > 0) {
      throw new PurchasingError("Financial transitions do not accept additional purchase order changes", 400, { code: "PO_LIFECYCLE_PATCH_UNSUPPORTED" });
    }
    throw new PurchasingError("Purchase order financial state is derived from invoice and payment evidence. Update the source invoice or payment instead.", 409, { code: "PO_FINANCIAL_LEDGER_OWNED" });
  }

  /** @deprecated AP ledger owns invoice-derived PO financial aggregates. */
  async function recomputeFinancialAggregates(poId: number): Promise<void> {
    await recomputePoFinancialAggregates(poId, {
      reason: "Compatibility recompute requested through PurchasingService.",
    });
  }

  async function sendWithLockedEconomics(
    poId: number,
    userId: string | undefined,
    expectation: LifecycleExpectation,
    options: {
      allowDraft: boolean;
      soloModeOnly: boolean;
      sentNotes: string;
      recordExternalSend: boolean;
    },
    transaction?: PurchaseOrderEntryTransaction,
  ): Promise<LockedSendResult> {
    return (transaction ?? db).transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
      const economics = await lockLifecycleEconomics(tx, poId, expectation);
      const po = economics.po;
      if (po.status !== "approved" && !(options.allowDraft && po.status === "draft")) {
        throw new PurchasingError(
          `Cannot send PO in '${po.status}' status`,
          409,
          { code: "PO_LIFECYCLE_CONFLICT" },
        );
      }
      if ((po.physicalStatus ?? "draft") !== "draft") {
        throw new PurchasingError(
          `Cannot send PO with physical status '${po.physicalStatus}'`,
          409,
          { code: "PO_LIFECYCLE_PHYSICAL_CONFLICT" },
        );
      }

      await assertLifecycleReadyToAdvanceTx(tx, economics);

      let requireApproval = false;
      if (options.soloModeOnly) {
        const activeTiers = await getActiveApprovalTiersTx(tx);
        if (activeTiers.length > 0) {
          throw new PurchasingError(
            "Approval tiers are configured. Use the individual Submit/Approve/Send steps.",
            400,
          );
        }
      } else {
        const settings = await getProcurementSettingsTx(tx);
        requireApproval = settings.requireApproval;
      }

      const tier = requireApproval
        ? await getMatchingApprovalTierTx(tx, economics.totalCents)
        : null;
      if (tier) {
        if (po.status === "draft") {
          const pendingPo = await moveLockedPoToPendingApproval(tx, economics, tier, userId);
          return { po: pendingPo, status: "pending_approval", pendingApproval: true };
        }
        const approvalEvents = await tx.select({ payloadJson: poEventsTable.payloadJson })
          .from(poEventsTable)
          .where(and(eq(poEventsTable.poId, poId), inArray(poEventsTable.eventType, ["approved", "quantity_amendment_approved", "line_amendment_approved"])))
          .orderBy(desc(poEventsTable.id)).limit(1).for("share");
        const authorityStillCovers = purchaseApprovalSnapshotCovers({
          snapshot: approvalEvents[0]?.payloadJson?.approval_authority, tier,
          totalCents: economics.totalCents, approvedBy: po.approvedBy ?? null,
        });
        if (!approvalCoversLockedEconomics(economics, tier, approvalEvents[0]?.payloadJson?.reviewed_lines_fingerprint) || !authorityStillCovers) {
          const pendingPo = await moveLockedPoToPendingApproval(
            tx,
            economics,
            tier,
            userId,
            true,
          );
          return { po: pendingPo, status: "pending_approval", pendingApproval: true };
        }
      }

      // Preparing documents is not supplier dispatch. A repeated preparation
      // of unchanged approved terms has no lifecycle or audit side effects.
      if (!options.recordExternalSend && po.status === "approved") {
        return { po, status: "approved", pendingApproval: false };
      }
      const dbTimestamp = sql`date_trunc('milliseconds', transaction_timestamp())`;
      const autoApproved = po.status === "draft";
      const approvalNotes = requireApproval
        ? "Auto-approved (no matching tier)"
        : options.soloModeOnly
          ? "Auto-approved (solo mode - no approval tiers)"
          : "Auto-approved (approval not required)";
      const updated = await updateLockedLifecycleHeader(tx, economics, {
        ...lifecycleTotalsPatch(economics),
        status: options.recordExternalSend ? "sent" : "approved",
        physicalStatus: options.recordExternalSend ? "sent" : "draft",
        ...(autoApproved ? {
          approvedBy: userId ?? null,
          approvedAt: dbTimestamp,
          approvalNotes,
          approvalTierId: null,
        } : {}),
        ...(options.recordExternalSend ? {
          sentToVendorAt: dbTimestamp,
          orderDate: po.orderDate ?? dbTimestamp,
        } : {}),
        updatedBy: userId ?? null,
      });

      const histories: Array<{ fromStatus: string | null; toStatus: string; notes?: string }> = [];
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      if (autoApproved) {
        histories.push({ fromStatus: "draft", toStatus: "approved", notes: approvalNotes });
        events.push({
          type: "approved",
          payload: {
            from_status: "draft",
            to_status: "approved",
            auto: true,
            require_approval: requireApproval,
            total_cents: economics.totalCents,
          },
        });
      }
      if (options.recordExternalSend) {
        histories.push({ fromStatus: "approved", toStatus: "sent", notes: options.sentNotes });
        events.push({
          type: "sent_to_vendor",
          payload: {
            method: "operator_recorded",
            delivery_verified: false,
            total_cents: economics.totalCents,
            source_updated_at: po.updatedAt,
          },
        });
      }
      await writeLifecycleAuditTx(tx, poId, histories, events, userId);
      return { po: updated, status: options.recordExternalSend ? "sent" : "approved", pendingApproval: false };
    });
  }

  async function submit(id: number, userId?: string) {
    const expectation = await observeLifecycleState(
      id,
      ["draft"],
      (status) => `Cannot submit PO in '${status}' status`,
    );
    return db.transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
      const economics = await lockLifecycleEconomics(tx, id, expectation);
      await assertLifecycleReadyToAdvanceTx(tx, economics);
      const tier = await getMatchingApprovalTierTx(tx, economics.totalCents);
      if (tier) {
        return moveLockedPoToPendingApproval(tx, economics, tier, userId);
      }

      const dbTimestamp = sql`date_trunc('milliseconds', transaction_timestamp())`;
      const updated = await updateLockedLifecycleHeader(tx, economics, {
        ...lifecycleTotalsPatch(economics),
        status: "approved",
        approvalTierId: null,
        approvedBy: userId ?? null,
        approvedAt: dbTimestamp,
        approvalNotes: "Auto-approved (below approval threshold)",
        updatedBy: userId ?? null,
      });
      await writeLifecycleAuditTx(
        tx,
        id,
        [{ fromStatus: "draft", toStatus: "approved", notes: "Auto-approved (below threshold)" }],
        [{
          type: "approved",
          payload: {
            from_status: "draft",
            to_status: "approved",
            auto: true,
            reason: "below_threshold",
            total_cents: economics.totalCents,
          },
        }],
        userId,
      );
      return updated;
    });
  }

  async function returnToDraft(id: number, userId?: string, notes?: string) {
    const expectation = await observeLifecycleState(
      id,
      ["pending_approval"],
      (status) => `Cannot return PO in '${status}' status to draft`,
    );
    return db.transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
      const economics = await lockLifecycleEconomics(tx, id, expectation);
      const updated = await updateLockedLifecycleHeader(tx, economics, {
        ...lifecycleTotalsPatch(economics),
        status: "draft",
        physicalStatus: "draft",
        approvalTierId: null,
        approvedBy: null,
        approvedAt: null,
        approvalNotes: null,
        updatedBy: userId ?? null,
      });
      await writeLifecycleAuditTx(
        tx,
        id,
        [{
          fromStatus: economics.po.status,
          toStatus: "draft",
          notes: notes || "Returned to draft",
        }],
        [{
          type: "returned_to_draft",
          payload: {
            from_status: economics.po.status,
            to_status: "draft",
            notes: notes ?? null,
            total_cents: economics.totalCents,
          },
        }],
        userId,
      );
      return updated;
    });
  }

  async function approveInTransaction(tx: any, id: number, userId: string | undefined, input: unknown) {
    if (!userId?.trim()) {
      console.warn(JSON.stringify({ event: "procurement.approval.denied", purchaseOrderId: id, code: "PO_APPROVAL_ACTOR_REQUIRED" }));
      throw new PurchasingError("An authenticated user is required to approve this purchase order.", 403, { code: "PO_APPROVAL_ACTOR_REQUIRED" });
    }
    try {
      await lockInventoryCostGraph(tx);
      const actor = assertPurchaseApprovalPermission(await readApprovalActor(tx, userId));
      const parsed = purchaseApprovalInputSchema.safeParse(input);
      if (!parsed.success) throw new PurchasingError("Reload and review the purchase order before approving its current terms.", 400, { code: "PO_APPROVAL_REVIEW_REQUIRED" });
      const { expectedUpdatedAt, expectedTotalCents, expectedLinesFingerprint, notes } = parsed.data;
      const headers = await tx.select({ ...getTableColumns(purchaseOrdersTable) }).from(purchaseOrdersTable)
        .where(eq(purchaseOrdersTable.id, id)).limit(1).for("update");
      const reviewed = headers[0];
      if (!reviewed) throw new PurchasingError("Purchase order not found", 404);
      if (new Date(reviewed.updatedAt).getTime() !== Date.parse(expectedUpdatedAt)) {
        throw new PurchasingError("Purchase order changed since your review. Reload and review the current terms before approving.", 409, { code: "PO_APPROVAL_REVIEW_STALE" });
      }
      if (!["draft", "pending_approval"].includes(reviewed.status)) throw new PurchasingError(`Cannot approve PO in '${reviewed.status}' status`, 409, { code: "PO_APPROVAL_STATUS_CHANGED" });
      const expectation = { status: reviewed.status, updatedAtMs: Date.parse(expectedUpdatedAt) };
      const economics = await lockLifecycleEconomics(tx, id, expectation);
      if (purchaseApprovalLinesFingerprint(economics.lines) !== expectedLinesFingerprint) {
        throw new PurchasingError("Purchase order lines changed since your review. Reload and review the current supplier terms before approving.", 409, { code: "PO_APPROVAL_LINES_REVIEW_STALE" });
      }
      await assertLifecycleReadyToAdvanceTx(tx, economics);
      const settings = await getProcurementSettingsTx(tx);
      const currentTier = settings.requireApproval ? await getMatchingApprovalTierTx(tx, economics.totalCents) : null;
      const approvalAuthority = buildPurchaseApprovalSnapshot({
        actor, requireApproval: settings.requireApproval, tier: currentTier, totalCents: economics.totalCents,
      });
      if (economics.correctedLegacyEconomics || economics.totalCents !== expectedTotalCents
        || readIntegerCents(economics.po.totalCents, "total", true) !== expectedTotalCents) {
        throw new PurchasingError("The saved purchase amounts do not match the reviewed terms. Return the PO to draft, save its corrected terms, and review it again before approval.", 409, { code: "PO_APPROVAL_ECONOMICS_REVIEW_REQUIRED" });
      }
      if (
        economics.po.status === "pending_approval" &&
        currentTier &&
        Number(economics.po.approvalTierId) !== Number(currentTier.id)
      ) {
        throw new PurchasingError(
          "Purchase order economics changed to a different approval tier; submit it again",
          409,
          {
            code: "PO_APPROVAL_TIER_CHANGED",
            previousTierId: economics.po.approvalTierId ?? null,
            currentTierId: currentTier.id,
            totalCents: economics.totalCents,
          },
        );
      }

      const dbTimestamp = sql`date_trunc('milliseconds', transaction_timestamp())`;
      const updated = await updateLockedLifecycleHeader(tx, economics, {
        ...lifecycleTotalsPatch(economics),
        status: "approved",
        approvalTierId: currentTier?.id ?? economics.po.approvalTierId ?? null,
        approvedBy: userId ?? null,
        approvedAt: dbTimestamp,
        approvalNotes: notes ?? null,
        updatedBy: userId ?? null,
      });
      await writeLifecycleAuditTx(
        tx,
        id,
        [{ fromStatus: economics.po.status, toStatus: "approved", notes: notes || "Approved" }],
        [{
          type: "approved",
          payload: {
            from_status: economics.po.status,
            to_status: "approved",
            notes: notes ?? null,
            tier_id: currentTier?.id ?? economics.po.approvalTierId ?? null,
            total_cents: economics.totalCents,
            approval_authority: approvalAuthority,
            reviewed_updated_at: expectedUpdatedAt,
            reviewed_lines_fingerprint: expectedLinesFingerprint,
          },
        }],
        userId,
      );
      return { ...updated, reviewedUpdatedAt: expectedUpdatedAt, reviewedLinesFingerprint: expectedLinesFingerprint };
    } catch (error: unknown) {
      if (error instanceof PurchaseApprovalAuthorityError) {
        console.warn(JSON.stringify({ event: "procurement.approval.denied", purchaseOrderId: id, actorId: userId, ...error.details }));
        throw new PurchasingError(error.message, error.statusCode, error.details);
      }
      console.error(JSON.stringify({ event: "procurement.approval.failed", purchaseOrderId: id, actorId: userId,
        code: error instanceof PurchasingError ? error.details?.code ?? "PO_APPROVAL_REJECTED" : "PO_APPROVAL_TRANSACTION_FAILED" }));
      throw error;
    }
  }

  async function approve(id: number, userId?: string, notes?: string, review?: { expectedUpdatedAt: unknown; expectedTotalCents: unknown; expectedLinesFingerprint: unknown }) {
    return db.transaction((tx: any) => approveInTransaction(tx, id, userId, { ...review, ...(notes === undefined ? {} : { notes }) }));
  }

  const approvalCommands = createPurchaseApprovalCommands({
    authorize: async (actorId) => {
      try { await db.transaction(async (tx: any) => assertPurchaseApprovalPermission(await readApprovalActor(tx, actorId))); }
      catch (error) {
        if (error instanceof PurchaseApprovalAuthorityError) throw new PurchasingError(error.message, error.statusCode, error.details);
        throw error;
      }
    },
    approve: approveInTransaction,
  }, createDrizzleFinancialCommandRepository(db));

  async function send(id: number, userId?: string, confirmation?: unknown) {
    if (!userId?.trim()) throw new PurchasingError("An authenticated operator is required to record supplier dispatch.", 401, { code: "PO_DISPATCH_ACTOR_REQUIRED" });
    const parsedConfirmation = supplierDispatchConfirmationSchema.safeParse(confirmation);
    if (!parsedConfirmation.success) {
      throw new PurchasingError("Confirm that the reviewed PO was already sent outside Echelon before recording dispatch.", 400, { code: "PO_EXTERNAL_DISPATCH_CONFIRMATION_REQUIRED" });
    }
    const expectation = await observeLifecycleState(
      id,
      ["approved"],
      (status) => `Cannot send PO in '${status}' status`,
    );
    // Bind the operator attestation to the displayed PO terms. The same
    // expectation is checked again under the header lock for waiting writers.
    if (expectation.updatedAtMs !== Date.parse(parsedConfirmation.data.expectedUpdatedAt)) {
      throw new PurchasingError("Purchase order changed since your review. Reload and review the supplier document before recording dispatch.", 409, { code: "PO_DISPATCH_REVIEW_STALE" });
    }
    const result = await sendWithLockedEconomics(id, userId, expectation, {
      allowDraft: false,
      soloModeOnly: false,
      sentNotes: "Operator recorded that the PO was sent outside Echelon",
      recordExternalSend: true,
    });
    return result.po;
  }

  /**
   * Legacy preparation entry point for solo mode. Approval makes the supplier
   * document available; recording external dispatch is a separate command.
   */
  async function sendToVendor(id: number, userId?: string) {
    const expectation = await observeLifecycleState(
      id,
      ["draft", "approved"],
      (status) => `Cannot send-to-vendor from '${status}' status. Use individual steps.`,
    );
    const result = await sendWithLockedEconomics(id, userId, expectation, {
      allowDraft: true,
      soloModeOnly: true,
      sentNotes: "Prepared for supplier review",
      recordExternalSend: false,
    });
    return result.po;
  }

  async function acknowledge(id: number, data: { vendorRefNumber?: string; confirmedDeliveryDate?: Date }, userId?: string) {
    const result = await transitionPhysical(id, "acknowledged", userId, "Vendor acknowledged", {
      vendorAckDate: new Date(),
      vendorRefNumber: data.vendorRefNumber,
      confirmedDeliveryDate: data.confirmedDeliveryDate,
    });

    return result;
  }

  async function cancel(id: number, reason: string, userId?: string) {
    if (typeof reason !== "string" || !reason.trim()) throw new PurchasingError("Cancel reason is required", 400);
    if (!userId?.trim()) {
      console.warn(JSON.stringify({ event: "procurement.cancellation.denied", purchaseOrderId: id, code: "PO_CANCEL_ACTOR_REQUIRED" }));
      throw new PurchasingError("An authenticated user is required to cancel this purchase order.", 403, { code: "PO_CANCEL_ACTOR_REQUIRED" });
    }
    reason = reason.trim();
    const expectation = await observeLifecycleVersion(id);

    const result = await db.transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
      const actor = await readCommandActor(tx, userId);
      const po = await lockLifecycleHeader(tx, id, expectation);
      try {
        assertPurchaseOrderCancellationAuthority(po, actor);
      } catch (error) {
        if (error instanceof PurchaseOrderCancellationAuthorityError) {
          console.warn(JSON.stringify({ event: "procurement.cancellation.denied", purchaseOrderId: id, ...error.details }));
          throw new PurchasingError(error.message, error.statusCode, error.details);
        }
        throw error;
      }
      if (!CANCELLABLE_FROM.has(po.status) && !VOIDABLE_FROM.has(po.status)) {
        throw new PurchasingError(`Cannot cancel/void PO in '${po.status}' status`, 400);
      }
      const lines = await tx
        .select()
        .from(purchaseOrderLinesTable)
        .where(eq(purchaseOrderLinesTable.purchaseOrderId, id))
        .orderBy(purchaseOrderLinesTable.id)
        .for("update");
      const clockValue = now();
      if (!(clockValue instanceof Date) || !Number.isFinite(clockValue.getTime())) {
        throw new PurchasingError("Cancellation could not obtain a valid command timestamp", 500, { code: "PO_CANCEL_CLOCK_INVALID" });
      }
      // One immutable command time ties the header, changed lines and both audit
      // records together; do not sample wall time separately at each write.
      const cancelledAt = new Date(clockValue.getTime());
      const permission = getPurchaseOrderCancellationPermission(po);
      const change = (() => {
        try {
          return buildPhysicalTransitionChange({
            po,
            target: "cancelled",
            now: cancelledAt,
            userId,
            notes: reason,
            extraPatch: { cancelReason: reason },
          });
        } catch (error) {
          return toPurchasingError(error);
        }
      })();
      const lineChanges: Array<{
        line_id: number;
        before: { status: string; cancelled_qty: number | null };
        after: { status: string; cancelled_qty: number };
      }> = [];
      for (const line of lines) {
        if (line.status === "open") {
          const updatedLine = await updatePurchaseOrderLineTx(tx, line.id, {
            status: "cancelled",
            cancelledQty: line.orderQty,
          }, cancelledAt);
          if (!updatedLine) throw new PurchasingError("Purchase order line changed during cancellation", 409, { code: "PO_CANCEL_LINE_CONFLICT", lineId: line.id });
          lineChanges.push({
            line_id: line.id,
            before: { status: line.status, cancelled_qty: line.cancelledQty ?? null },
            after: { status: updatedLine.status, cancelled_qty: updatedLine.cancelledQty },
          });
        }
      }

      const updated = await updatePurchaseOrderStatusWithHistoryTx(
        tx,
        id,
        change.patch,
        change.history,
        cancelledAt,
      );
      if (!updated) throw new PurchasingError("Purchase order changed during cancellation", 409, { code: "PO_CANCEL_HEADER_CONFLICT" });
      await emitPoEventTx(tx, id, "cancelled", userId, {
        from_status: change.history.fromStatus,
        to_status: change.history.toStatus,
        physical_status: "cancelled",
        reason,
        required_permission: `${permission.resource}:${permission.action}`,
        before: { status: po.status, physical_status: po.physicalStatus ?? null },
        after: { status: updated.status, physical_status: updated.physicalStatus },
        line_changes: lineChanges,
      }, cancelledAt);
      return updated;
    });

    try {
      await detectPastDue(id);
    } catch (detectionErr) {
      console.error("[po-exceptions] detection hook failed in cancel:", detectionErr);
    }

    return result;
  }

  /** Ordinary close requires complete physical receipts and current invoice matching.
   * Incomplete receipt disposition remains the separate close-short command. */
  async function close(id: number, userId?: string, notes?: string) {
    const expectation = await observeLifecycleState(
      id,
      ["partially_received", "received"],
      (status) => `Cannot close PO in '${status}' status`,
    );

    const outcome = await db.transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
      const po = await lockLifecycleHeader(tx, id, expectation);

      const lines = await tx.select().from(purchaseOrderLinesTable)
        .where(eq(purchaseOrderLinesTable.purchaseOrderId, id))
        .orderBy(purchaseOrderLinesTable.id).for("update");
      // Check the locked physical state and quantities before match recomputation
      // or approved-cost reconciliation can write any financial evidence.
      const change = (() => {
        try {
          return buildPoCloseChange({ po, lines, userId, notes, now: now() });
        } catch (error) {
          return toPurchasingError(error);
        }
      })();
      const closedAt = change.patch.closedAt as Date;

      // Receipts exist by close time, so derive the three-way match from the
      // locked source rows instead of trusting previously persisted statuses.
      const match = await recomputePurchaseOrderInvoiceMatchesInTransaction(
        id,
        tx,
        userId,
        closedAt,
      );
      const varianceInvoiceIds = [...new Set(
        match.results
          .filter((line) => ACCEPTABLE_PO_MATCH_VARIANCE_STATUSES.has(line.matchStatus))
          .map((line) => Number(line.vendorInvoiceId)),
      )].sort((left, right) => left - right);
      const acceptedVarianceInvoiceIds = new Set<number>();
      if (varianceInvoiceIds.length > 0) {
        const resolvedExceptions = await tx
          .select({ payload: poExceptionsTable.payload })
          .from(poExceptionsTable)
          .where(
            and(
              eq(poExceptionsTable.poId, id),
              eq(poExceptionsTable.kind, "match_mismatch"),
              eq(poExceptionsTable.status, "resolved"),
            ),
          );
        for (const exception of resolvedExceptions) {
          const payload = exception.payload as Record<string, unknown> | null;
          const resolvedInvoiceId = Number(payload?.invoiceId);
          if (
            Number.isSafeInteger(resolvedInvoiceId) &&
            varianceInvoiceIds.includes(resolvedInvoiceId) &&
            payload?.sourceVersion === 1 &&
            payload?.sourceFingerprint === match.sourceFingerprint
          ) {
            acceptedVarianceInvoiceIds.add(resolvedInvoiceId);
          }
        }
      }
      const unresolvedLines = match.results.filter((line) =>
        line.matchStatus !== "matched" &&
        !(
          ACCEPTABLE_PO_MATCH_VARIANCE_STATUSES.has(line.matchStatus) &&
          acceptedVarianceInvoiceIds.has(Number(line.vendorInvoiceId))
        ),
      );
      if (unresolvedLines.length > 0 || match.invoicesWithoutMappedLines.length > 0) {
        const blockedInvoiceIds = [...new Set([
          ...unresolvedLines.map((line) => Number(line.vendorInvoiceId)),
          ...match.invoicesWithoutMappedLines,
        ])].sort((left, right) => left - right);
        const statusCounts = unresolvedLines.reduce<Record<string, number>>((counts, line) => {
          counts[line.matchStatus] = (counts[line.matchStatus] ?? 0) + 1;
          return counts;
        }, {});
        if (match.invoicesWithoutMappedLines.length > 0) {
          statusCounts.unmapped_invoice = match.invoicesWithoutMappedLines.length;
        }
        return {
          kind: "blocked" as const,
          poStatus: po.status,
          blockedInvoiceIds,
          invoiceLabels: blockedInvoiceIds.map(
            (invoiceId) => match.invoiceNumbersById.get(invoiceId) ?? `#${invoiceId}`,
          ),
          lineIds: unresolvedLines.map((line) => Number(line.id)),
          statusCounts,
          unresolvedLineCount: unresolvedLines.length,
          unmappedInvoiceCount: match.invoicesWithoutMappedLines.length,
        };
      }

      if (reconcileApprovedInvoiceCost) {
        for (const purchaseOrderLineId of match.purchaseOrderLineIds) {
          await reconcileApprovedInvoiceCost(purchaseOrderLineId, tx, userId);
        }
      }

      const updated = await updatePurchaseOrderStatusWithHistoryTx(
        tx,
        id,
        change.patch,
        change.history,
        closedAt,
      );
      await emitPoEventTx(tx, id, "closed", userId, {
        from_status: change.history.fromStatus,
        to_status: change.history.toStatus,
        notes: notes ?? null,
        accepted_match_variance_invoice_ids: [...acceptedVarianceInvoiceIds].sort(
          (left, right) => left - right,
        ),
        match_source_fingerprint: match.sourceFingerprint,
      }, closedAt);
      await persistCompletedVendorPurchaseEvidenceTx(
        tx,
        id,
        closedAt,
        userId,
      );
      return { kind: "closed" as const, updated };
    });

    if (outcome.kind === "closed") return outcome.updated;

    for (const invoiceId of outcome.blockedInvoiceIds) {
      try {
        await detectMatchMismatch(invoiceId);
      } catch (detectionError) {
        console.error("[po-exceptions] close match detection failed:", detectionError);
      }
    }
    const nextAction = "Correct missing mappings and resolve or accept current variances before closing the PO.";
    const unresolvedParts: string[] = [];
    if (outcome.unresolvedLineCount > 0) {
      unresolvedParts.push(
        `${outcome.unresolvedLineCount} unresolved invoice line${outcome.unresolvedLineCount === 1 ? "" : "s"}`,
      );
    }
    if (outcome.unmappedInvoiceCount > 0) {
      unresolvedParts.push(
        `${outcome.unmappedInvoiceCount} invoice${outcome.unmappedInvoiceCount === 1 ? "" : "s"} without mapped PO lines`,
      );
    }
    throw new PurchasingError(
      `Cannot close PO: invoice${outcome.invoiceLabels.length === 1 ? "" : "s"} ${outcome.invoiceLabels.join(", ")} have ${unresolvedParts.join(" and ")}. ${nextAction}`,
      409,
      {
        code: "PO_CLOSE_3WAY_MATCH_BLOCKED",
        purchaseOrderId: id,
        invoiceIds: outcome.blockedInvoiceIds,
        lineIds: outcome.lineIds,
        statusCounts: outcome.statusCounts,
      },
    );
  }

  async function closeShort(id: number, reason: string, userId?: string) {
    try {
      reason = normalizePoCloseShortReason(reason);
    } catch (error) {
      return toPurchasingError(error);
    }
    const expectation = await observeLifecycleState(
      id,
      ["partially_received"],
      () => "Can only close-short a partially received PO",
    );

    return db.transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
      const po = await lockLifecycleHeader(tx, id, expectation);
      const lines = await tx
        .select()
        .from(purchaseOrderLinesTable)
        .where(eq(purchaseOrderLinesTable.purchaseOrderId, id))
        .orderBy(purchaseOrderLinesTable.id)
        .for("update");
      const change = (() => {
        try {
          return buildPoCloseShortChange({ po, reason, userId, now: now() });
        } catch (error) {
          return toPurchasingError(error);
        }
      })();
      const closedAt = change.patch.closedAt as Date;
      for (const line of lines) {
        const linePatch = buildPoCloseShortLinePatch(line, reason);
        if (linePatch) {
          await updatePurchaseOrderLineTx(tx, line.id, linePatch, closedAt);
        }
      }

      if (reconcileApprovedInvoiceCost) {
        for (const line of lines) {
          await reconcileApprovedInvoiceCost(Number(line.id), tx, userId);
        }
      }

      const updated = await updatePurchaseOrderStatusWithHistoryTx(
        tx,
        id,
        change.patch,
        change.history,
        closedAt,
      );
      await emitPoEventTx(tx, id, "closed_short", userId, {
        from_status: change.history.fromStatus,
        to_status: change.history.toStatus,
        reason,
      }, closedAt);
      await persistCompletedVendorPurchaseEvidenceTx(
        tx,
        id,
        closedAt,
        userId,
      );
      return updated;
    });
  }

  // ── LIFECYCLE COMMAND DISPATCH ─────────────────────────────────

  async function executeLifecycleCommand(
    id: number,
    command: PoLifecycleCommand,
    input: PoLifecycleCommandInput = {},
    userId?: string,
  ) {
    switch (command) {
      case "submit":
        return submit(id, userId);
      case "return_to_draft":
        return returnToDraft(id, userId, input.notes);
      case "approve":
        return approve(id, userId, input.notes, { expectedUpdatedAt: input.expectedUpdatedAt, expectedTotalCents: input.expectedTotalCents, expectedLinesFingerprint: input.expectedLinesFingerprint });
      case "send":
        return send(id, userId, { confirmedSentExternally: input.confirmedSentExternally, expectedUpdatedAt: input.expectedUpdatedAt });
      case "send_to_vendor":
        return sendToVendor(id, userId);
      case "acknowledge":
        return acknowledge(
          id,
          {
            vendorRefNumber: input.vendorRefNumber,
            confirmedDeliveryDate: input.confirmedDeliveryDate,
          },
          userId,
        );
      case "mark_shipped":
        return transitionPhysical(id, "shipped", userId, input.notes);
      case "mark_in_transit":
        return transitionPhysical(id, "in_transit", userId, input.notes);
      case "mark_arrived":
        return transitionPhysical(id, "arrived", userId, input.notes);
      case "create_receipt":
        return createReceiptFromPO(id, userId);
      case "cancel":
        return cancel(id, input.reason ?? "", userId);
      case "close":
        return close(id, userId, input.notes);
      case "close_short":
        return closeShort(id, input.reason ?? "", userId);
      default: {
        const exhaustive: never = command;
        throw new PurchasingError(`Unknown PO lifecycle command '${exhaustive}'`, 400, {
          command: exhaustive,
        });
      }
    }
  }

  return {
    sendWithLockedEconomics,
    transitionPhysical,
    transitionFinancial,
    recomputeFinancialAggregates,
    submit,
    returnToDraft,
    approve,
    approveCommand: approvalCommands.execute,
    send,
    sendToVendor,
    acknowledge,
    cancel,
    close,
    closeShort,
    executeLifecycleCommand,
  };
}

export type PurchasingLifecycleActions = ReturnType<typeof createPurchasingLifecycleActions>;
