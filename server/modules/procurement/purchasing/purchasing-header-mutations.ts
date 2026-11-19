import { and, eq, ne } from "drizzle-orm";
import { readIntegerCents } from "@shared/money-read";
import {
  poStatusHistory as poStatusHistoryTable,
  purchaseOrderLines as purchaseOrderLinesTable,
  purchaseOrders as purchaseOrdersTable,
  purchasingRecommendationPoHandoffs as purchasingRecommendationPoHandoffsTable,
} from "@shared/schema";
import type { FinancialCommandDescriptor } from "../../../platform/commands/transactional-command.service";
import { captureDocumentNumberTime } from "../../../platform/document-numbering/document-number";
import { hasPoInvoiceHistory, readPoInvoiceHistory } from "../po-invoice-history.repository";
import {
  deliveryDateIso,
  sameDeliveryDate,
  validateDeliverySchedulePatch,
  type DeliverySchedulePatch,
} from "../purchase-order-delivery-schedule";
import {
  buildPurchaseOrderDraftHeaderChange,
  purchaseOrderDraftHeaderPatchSchema,
} from "../purchase-order-draft-header";
import {
  PURCHASE_ORDER_HISTORY_DELETE_MESSAGE,
  retainedPurchaseOrderHistoryKinds,
} from "../purchase-order-history.policy";
import {
  isPurchaseOrderHistoryConstraintViolation,
  readPurchaseOrderHistoryPresence,
} from "../purchase-order-history.repository";
import {
  millisecondTransactionTimestamp,
  nextPurchaseOrderUpdatedAt,
  purchaseOrderUpdatedAtMatchesApplicationVersion,
} from "../purchase-order-lifecycle-version";
import {
  createPurchaseOrderLineCommands,
  PurchaseOrderLineCommandError,
} from "../purchase-order-line-commands";
import type { PurchasingCatalog } from "./purchasing-catalog";
import type { PurchasingLifecycleLocks } from "./purchasing-lifecycle-locks";
import {
  EDITABLE_STATUSES,
  isPoNumberUniqueViolation,
  PG_INTEGER_MAX,
  PO_NUMBER_ALLOCATION_ATTEMPTS,
  PurchasingError,
  requireUsdPurchaseOrderCurrency,
  safeIntegerMoney,
  storedMoneyAsBigInt,
  TERMINAL_DELIVERY_SCHEDULE_STATUSES,
  type PurchasingBaseContext,
} from "./purchasing.types";

export function createPurchasingHeaderMutations(
  ctx: PurchasingBaseContext,
  deps: {
    persistPurchaseOrderCatalogWritesTx: PurchasingCatalog["persistPurchaseOrderCatalogWritesTx"];
    observeLifecycleState: PurchasingLifecycleLocks["observeLifecycleState"];
    lockLifecycleHeader: PurchasingLifecycleLocks["lockLifecycleHeader"];
  },
) {
  const { db, storage, now, lockInventoryCostGraph, emitPoEventTx } = ctx;
  const { persistPurchaseOrderCatalogWritesTx, observeLifecycleState, lockLifecycleHeader } = deps;

  const lineCommands = createPurchaseOrderLineCommands(db, {
    persistCatalogWrites: async (tx, vendorId, lines, userId) => {
      try {
        return await persistPurchaseOrderCatalogWritesTx(tx, vendorId, lines, userId);
      } catch (error: any) {
        if (error instanceof PurchasingError) {
          throw new PurchaseOrderLineCommandError(
            error.message,
            error.statusCode,
            error.details,
          );
        }
        throw error;
      }
    },
  });

  async function runLineCommand<T>(command: () => Promise<T>): Promise<T> {
    try {
      return await command();
    } catch (error: any) {
      if (error instanceof PurchaseOrderLineCommandError) {
        throw new PurchasingError(error.message, error.statusCode, error.details);
      }
      throw error;
    }
  }

  const hardenedAddLine = (
    purchaseOrderId: number,
    input: unknown,
    userId?: string,
  ) => runLineCommand(() => lineCommands.addLine(purchaseOrderId, input, userId));

  const hardenedAddBulkLines = (
    purchaseOrderId: number,
    input: unknown,
    userId?: string,
  ) => runLineCommand(() => lineCommands.addBulkLines(purchaseOrderId, input, userId));

  const hardenedUpdateLine = (
    lineId: number,
    input: unknown,
    userId?: string,
  ) => runLineCommand(() => lineCommands.updateLine(lineId, input, userId));

  const hardenedCancelLine = (
    lineId: number,
    input: unknown,
    userId?: string,
  ) => runLineCommand(() => lineCommands.cancelLine(lineId, input, userId));

  const hardenedAddLineCommand = (
    purchaseOrderId: number,
    input: unknown,
    userId: string | undefined,
    descriptor: FinancialCommandDescriptor,
  ) => runLineCommand(() => lineCommands.addLineCommand(
    purchaseOrderId,
    input,
    userId,
    descriptor,
  ));

  const hardenedAddBulkLinesCommand = (
    purchaseOrderId: number,
    input: unknown,
    userId: string | undefined,
    descriptor: FinancialCommandDescriptor,
  ) => runLineCommand(() => lineCommands.addBulkLinesCommand(
    purchaseOrderId,
    input,
    userId,
    descriptor,
  ));

  const hardenedUpdateLineCommand = (
    lineId: number,
    input: unknown,
    userId: string | undefined,
    descriptor: FinancialCommandDescriptor,
  ) => runLineCommand(() => lineCommands.updateLineCommand(lineId, input, userId, descriptor));

  const hardenedCancelLineCommand = (
    lineId: number,
    input: unknown,
    userId: string | undefined,
    descriptor: FinancialCommandDescriptor,
  ) => runLineCommand(() => lineCommands.cancelLineCommand(lineId, input, userId, descriptor));

  async function createPO(data: {
    vendorId: number;
    warehouseId?: number;
    poType?: string;
    priority?: string;
    expectedDeliveryDate?: Date;
    shipToAddress?: string;
    shippingMethod?: string;
    incoterms?: string;
    freightTerms?: string;
    vendorNotes?: string;
    internalNotes?: string;
    source?: "manual" | "auto_draft" | "reorder";
    createdBy?: string;
  }) {
    const recordedAt = captureDocumentNumberTime(now());
    let lastConflictingPoNumber: string | null = null;
    for (let attempt = 1; attempt <= PO_NUMBER_ALLOCATION_ATTEMPTS; attempt++) {
      let poNumber: string | null = null;
      try {
        return await db.transaction(async (tx: any) => {
          await lockInventoryCostGraph(tx);
          const vendor = await storage.getVendorById(data.vendorId, tx);
          if (!vendor) throw new PurchasingError("Vendor not found", 404);
          const currency = requireUsdPurchaseOrderCurrency(vendor.currency);
          poNumber = await storage.generatePoNumber(tx, recordedAt);
          return storage.createPurchaseOrder({
            poNumber,
            vendorId: data.vendorId,
            warehouseId: data.warehouseId,
            status: "draft",
            poType: data.poType || "standard",
            priority: data.priority || "normal",
            expectedDeliveryDate: data.expectedDeliveryDate,
            shipToAddress: data.shipToAddress,
            shippingMethod: data.shippingMethod,
            incoterms: data.incoterms,
            freightTerms: data.freightTerms,
            vendorNotes: data.vendorNotes,
            internalNotes: data.internalNotes,
            source: data.source ?? "manual",
            currency,
            paymentTermsDays: vendor.paymentTermsDays,
            paymentTermsType: vendor.paymentTermsType,
            shipFromAddress: vendor.shipFromAddress,
            createdBy: data.createdBy,
            updatedBy: data.createdBy,
            createdAt: recordedAt,
            updatedAt: recordedAt,
          }, {
            fromStatus: null,
            toStatus: "draft",
            changedBy: data.createdBy,
            notes: "PO created",
            changedAt: recordedAt,
          }, tx);
        });
      } catch (error: any) {
        if (!isPoNumberUniqueViolation(error)) throw error;
        lastConflictingPoNumber = poNumber;
        if (attempt < PO_NUMBER_ALLOCATION_ATTEMPTS) continue;
      }
    }

    throw new PurchasingError(
      "Could not allocate a unique PO number after concurrent create attempts",
      409,
      {
        code: "PO_NUMBER_ALLOCATION_EXHAUSTED",
        attempts: PO_NUMBER_ALLOCATION_ATTEMPTS,
        lastPoNumber: lastConflictingPoNumber,
      },
    );
  }

  async function lockCleanDraftHeaderForMutation(
    tx: any,
    id: number,
  ): Promise<any> {
    const locked = await tx
      .select()
      .from(purchaseOrdersTable)
      .where(eq(purchaseOrdersTable.id, id))
      .limit(1)
      .for("update");
    const po = locked[0];
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    const physicalStatus = po.physicalStatus ?? po.status;
    if (
      po.status !== "draft" ||
      physicalStatus !== "draft"
    ) {
      throw new PurchasingError(`Cannot edit PO in '${po.status}' status`, 400, {
        code: "PO_NOT_EDITABLE",
        status: po.status,
        physicalStatus,
      });
    }
    if (hasPoInvoiceHistory(await readPoInvoiceHistory(tx, id))) {
      throw new PurchasingError("Cannot edit a draft after financial activity exists", 409, {
        code: "PO_DRAFT_HAS_FINANCIAL_ACTIVITY",
      });
    }

    const recommendationHandoffs = await tx
      .select({ id: purchasingRecommendationPoHandoffsTable.id })
      .from(purchasingRecommendationPoHandoffsTable)
      .where(eq(purchasingRecommendationPoHandoffsTable.purchaseOrderId, id))
      .limit(1);
    if (recommendationHandoffs[0]) {
      throw new PurchasingError(
        "Cannot edit the header of a recommendation-created PO; cancel it and accept a new recommendation",
        409,
        {
          code: "RECOMMENDATION_PO_HEADER_AMEND_BLOCKED",
          handoffId: recommendationHandoffs[0].id,
        },
      );
    }

    return po;
  }

  function cleanDraftHeaderCasConditions(po: any): any[] {
    const conditions = [
      eq(purchaseOrdersTable.id, po.id),
      eq(purchaseOrdersTable.status, "draft"),
      eq(purchaseOrdersTable.physicalStatus, "draft"),
    ];
    if (po.updatedAt != null) {
      conditions.push(purchaseOrderUpdatedAtMatchesApplicationVersion(po.updatedAt));
    }
    return conditions;
  }

  async function updatePO(
    id: number,
    requested: unknown,
    userId?: string,
  ) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new PurchasingError("Purchase order id must be a positive integer", 400, {
        code: "INVALID_PURCHASE_ORDER_ID",
      });
    }
    const parsed = purchaseOrderDraftHeaderPatchSchema.safeParse(requested);
    if (!parsed.success) {
      throw new PurchasingError("Invalid draft purchase order header update", 400, {
        code: "INVALID_PO_DRAFT_HEADER_PATCH",
        issues: parsed.error.issues,
      });
    }

    return db.transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
      const po = await lockCleanDraftHeaderForMutation(tx, id);

      const change = buildPurchaseOrderDraftHeaderChange(po, parsed.data);
      if (change.changedFields.length === 0) return po;

      const result = await tx
        .update(purchaseOrdersTable)
        .set({
          ...change.patch,
          ...(userId ? { updatedBy: userId } : {}),
          updatedAt: po.updatedAt == null
            ? millisecondTransactionTimestamp()
            : nextPurchaseOrderUpdatedAt(po.updatedAt),
        })
        .where(and(...cleanDraftHeaderCasConditions(po)))
        .returning();
      const updated = result[0];
      if (!updated) {
        throw new PurchasingError("Purchase order changed while the edit was being applied", 409, {
          code: "PO_DRAFT_EDIT_CONFLICT",
        });
      }

      await emitPoEventTx(tx, id, "edited", userId, {
        changed_fields: change.changedFields,
        before: change.before,
        after: change.after,
      });
      return updated;
    });
  }

  async function updateDeliverySchedule(
    id: number,
    input: DeliverySchedulePatch & { notes?: string },
    userId?: string,
  ) {
    if (!Number.isSafeInteger(id) || id <= 0 || id > PG_INTEGER_MAX) {
      throw new PurchasingError("Purchase order id must be a positive integer", 400, {
        code: "INVALID_PURCHASE_ORDER_ID",
      });
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new PurchasingError("Delivery schedule update is required", 400, {
        code: "DELIVERY_SCHEDULE_INVALID_PATCH",
      });
    }
    const hasExpected = input.expectedDeliveryDate !== undefined;
    const hasConfirmed = input.confirmedDeliveryDate !== undefined;
    if (!hasExpected && !hasConfirmed) {
      throw new PurchasingError("At least one delivery schedule date is required", 400, {
        code: "DELIVERY_SCHEDULE_EMPTY_PATCH",
      });
    }

    return db.transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
      const locked = await tx
        .select()
        .from(purchaseOrdersTable)
        .where(eq(purchaseOrdersTable.id, id))
        .limit(1)
        .for("update");
      const po = locked[0];
      if (!po) throw new PurchasingError("Purchase order not found", 404);

      const physicalStatus = po.physicalStatus ?? po.status;
      if (
        TERMINAL_DELIVERY_SCHEDULE_STATUSES.has(po.status) ||
        TERMINAL_DELIVERY_SCHEDULE_STATUSES.has(physicalStatus)
      ) {
        throw new PurchasingError("Cannot update the delivery schedule on a terminal PO", 400, {
          code: "DELIVERY_SCHEDULE_TERMINAL_PO",
          status: po.status,
          physicalStatus,
        });
      }

      const issues = validateDeliverySchedulePatch(po, input);
      if (issues.length > 0) {
        const issue = issues[0];
        throw new PurchasingError(issue.message, 400, issue);
      }

      const patch: Record<string, Date | null> = {};
      const changes: string[] = [];
      if (hasExpected && !sameDeliveryDate(po.expectedDeliveryDate, input.expectedDeliveryDate)) {
        patch.expectedDeliveryDate = input.expectedDeliveryDate ?? null;
        changes.push("requested delivery date");
      }
      if (hasConfirmed && !sameDeliveryDate(po.confirmedDeliveryDate, input.confirmedDeliveryDate)) {
        patch.confirmedDeliveryDate = input.confirmedDeliveryDate ?? null;
        changes.push("vendor confirmed delivery date");
      }
      if (changes.length === 0) return po;

      const before = {
        expected_delivery_date: deliveryDateIso(po.expectedDeliveryDate),
        confirmed_delivery_date: deliveryDateIso(po.confirmedDeliveryDate),
      };
      const after = {
        expected_delivery_date: hasExpected
          ? deliveryDateIso(input.expectedDeliveryDate)
          : before.expected_delivery_date,
        confirmed_delivery_date: hasConfirmed
          ? deliveryDateIso(input.confirmedDeliveryDate)
          : before.confirmed_delivery_date,
      };
      const notes = input.notes?.trim() || `Updated ${changes.join(" and ")}`;
      const conditions = [
        eq(purchaseOrdersTable.id, id),
        eq(purchaseOrdersTable.status, po.status),
      ];
      if (po.physicalStatus != null) {
        conditions.push(eq(purchaseOrdersTable.physicalStatus, po.physicalStatus));
      }
      if (po.updatedAt != null) {
        conditions.push(purchaseOrderUpdatedAtMatchesApplicationVersion(po.updatedAt));
      }
      const updatedRows = await tx
        .update(purchaseOrdersTable)
        .set({
          ...patch,
          ...(userId ? { updatedBy: userId } : {}),
          updatedAt: po.updatedAt == null
            ? millisecondTransactionTimestamp()
            : nextPurchaseOrderUpdatedAt(po.updatedAt),
        })
        .where(and(...conditions))
        .returning();
      const updated = updatedRows[0];
      if (!updated) {
        throw new PurchasingError(
          "Purchase order changed while the delivery schedule update was being applied",
          409,
          { code: "PO_DELIVERY_SCHEDULE_CONFLICT" },
        );
      }

      await tx.insert(poStatusHistoryTable).values({
        purchaseOrderId: id,
        fromStatus: po.status,
        toStatus: po.status,
        changedBy: userId,
        notes,
      });
      await emitPoEventTx(tx, id, "delivery_schedule_updated", userId, {
        before,
        after,
        notes,
      });
      return updated;
    });
  }

  async function deletePO(id: number) {
    if (!Number.isSafeInteger(id) || id <= 0 || id > PG_INTEGER_MAX) {
      throw new PurchasingError("Purchase order id must be a positive integer", 400, { code: "INVALID_PURCHASE_ORDER_ID" });
    }
    const expectation = await observeLifecycleState(id, ["draft"], () => "Can only delete POs in draft status");
    try {
      return await db.transaction(async (tx: any) => {
        await lockInventoryCostGraph(tx);
        await lockLifecycleHeader(tx, id, expectation);
        const historyKinds = retainedPurchaseOrderHistoryKinds(await readPurchaseOrderHistoryPresence(tx, id));
        if (historyKinds.length > 0) {
          throw new PurchasingError(PURCHASE_ORDER_HISTORY_DELETE_MESSAGE, 409, { code: "PO_HISTORY_DELETE_BLOCKED", historyKinds });
        }
        const [handoff] = await tx.select({ id: purchasingRecommendationPoHandoffsTable.id })
          .from(purchasingRecommendationPoHandoffsTable)
          .where(eq(purchasingRecommendationPoHandoffsTable.purchaseOrderId, id))
          .limit(1).for("share");
        if (handoff) {
          throw new PurchasingError("Cannot delete a recommendation-created PO; cancel it to preserve the handoff audit trail", 409,
            { code: "RECOMMENDATION_PO_DELETE_BLOCKED", handoffId: handoff.id });
        }
        const deleted = await storage.deletePurchaseOrder(id, tx);
        if (!deleted) throw new PurchasingError("Purchase order changed before deletion", 409, { code: "PO_LIFECYCLE_CONFLICT" });
        return true;
      });
    } catch (error) {
      if (isPurchaseOrderHistoryConstraintViolation(error)) {
        throw new PurchasingError(PURCHASE_ORDER_HISTORY_DELETE_MESSAGE, 409, { code: "PO_HISTORY_DELETE_BLOCKED" });
      }
      throw error;
    }
  }

  // ── INCOTERMS & HEADER CHARGES ────────────────────────────────────
  // Incoterms and header charges are approval inputs. They may only change on
  // a financially clean draft, and the totals + audit event must commit with
  // the edit so an approved amount can never be altered through this endpoint.

  async function updateIncotermsAndCharges(
      id: number,
      updates: {
        incoterms?: string | null;
        discountCents?: number;
        taxCents?: number;
        shippingCostCents?: number;
        overReceiptTolerancePct?: number;
      },
      userId?: string,
    ) {
      if (!Number.isSafeInteger(id) || id <= 0 || id > PG_INTEGER_MAX) {
        throw new PurchasingError("Purchase order id must be a positive integer", 400, {
          code: "INVALID_PURCHASE_ORDER_ID",
        });
      }
      if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
        throw new PurchasingError("Incoterms or header charges update is required", 400, {
          code: "INVALID_PO_HEADER_CHARGES_PATCH",
        });
      }

      const suppliedFields = [
        "incoterms",
        "discountCents",
        "taxCents",
        "shippingCostCents",
        "overReceiptTolerancePct",
      ].filter((field) => (updates as Record<string, unknown>)[field] !== undefined);
      if (suppliedFields.length === 0) {
        throw new PurchasingError("At least one incoterm or header charge field is required", 400, {
          code: "INVALID_PO_HEADER_CHARGES_PATCH",
        });
      }

      let normalizedIncoterms: string | null | undefined;
      if (updates.incoterms !== undefined) {
        if (updates.incoterms !== null && typeof updates.incoterms !== "string") {
          throw new PurchasingError("incoterms must be a string or null", 400, {
            code: "INVALID_PO_HEADER_CHARGES_PATCH",
            field: "incoterms",
          });
        }
        normalizedIncoterms = typeof updates.incoterms === "string"
          ? updates.incoterms.trim() || null
          : null;
        if (normalizedIncoterms != null && normalizedIncoterms.length > 10) {
          throw new PurchasingError("incoterms must be at most 10 characters", 400, {
            code: "INVALID_PO_HEADER_CHARGES_PATCH",
            field: "incoterms",
          });
        }
      }
      for (const field of ["discountCents", "taxCents", "shippingCostCents"] as const) {
        const value = updates[field];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
          throw new PurchasingError(`${field} must be a non-negative integer number of cents`, 400, {
            code: "INVALID_PO_HEADER_CHARGES_PATCH",
            field,
          });
        }
      }
      if (
        updates.overReceiptTolerancePct !== undefined &&
        (
          !Number.isFinite(updates.overReceiptTolerancePct) ||
          updates.overReceiptTolerancePct < 0 ||
          updates.overReceiptTolerancePct > 100 ||
          Math.round(updates.overReceiptTolerancePct * 100) / 100 !==
            updates.overReceiptTolerancePct
        )
      ) {
        throw new PurchasingError(
          "overReceiptTolerancePct must be between 0 and 100 with at most two decimal places",
          400,
          {
            code: "INVALID_PO_HEADER_CHARGES_PATCH",
            field: "overReceiptTolerancePct",
          },
        );
      }

      return db.transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
        const po = await lockCleanDraftHeaderForMutation(tx, id);
        const patch: Record<string, unknown> = {};
        const changedFields: string[] = [];
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        const track = (
          column: string,
          auditField: string,
          current: unknown,
          requested: unknown,
          stored: unknown = requested,
        ) => {
          if (requested === undefined || requested === current) return;
          changedFields.push(auditField);
          before[auditField] = current ?? null;
          after[auditField] = requested ?? null;
          patch[column] = stored;
        };

        track("incoterms", "incoterms", po.incoterms ?? null, normalizedIncoterms);
        track(
          "discountCents",
          "discount_cents",
          readIntegerCents(po.discountCents ?? 0, "computed amount", true),
          updates.discountCents,
        );
        track("taxCents", "tax_cents", readIntegerCents(po.taxCents ?? 0, "computed amount", true), updates.taxCents);
        track(
          "shippingCostCents",
          "shipping_cost_cents",
          readIntegerCents(po.shippingCostCents ?? 0, "computed amount", true),
          updates.shippingCostCents,
        );
        track(
          "overReceiptTolerancePct",
          "over_receipt_tolerance_pct",
          Number(po.overReceiptTolerancePct ?? 0),
          updates.overReceiptTolerancePct,
          updates.overReceiptTolerancePct === undefined
            ? undefined
            : String(updates.overReceiptTolerancePct),
        );
        if (changedFields.length === 0) return po;

        const lines = await tx
          .select()
          .from(purchaseOrderLinesTable)
          .where(and(
            eq(purchaseOrderLinesTable.purchaseOrderId, id),
            ne(purchaseOrderLinesTable.status, "cancelled"),
          ))
          .orderBy(purchaseOrderLinesTable.id)
          .for("update");
        let subtotal = BigInt(0);
        let receivedLineCount = 0;
        for (const line of lines) {
          subtotal += storedMoneyAsBigInt(line.lineTotalCents, "line_total_cents");
          if (line.status === "received") receivedLineCount++;
        }

        const discountCents = updates.discountCents === undefined
          ? storedMoneyAsBigInt(po.discountCents, "discount_cents")
          : BigInt(updates.discountCents);
        const taxCents = updates.taxCents === undefined
          ? storedMoneyAsBigInt(po.taxCents, "tax_cents")
          : BigInt(updates.taxCents);
        const shippingCostCents = updates.shippingCostCents === undefined
          ? storedMoneyAsBigInt(po.shippingCostCents, "shipping_cost_cents")
          : BigInt(updates.shippingCostCents);
        const computedTotal = subtotal - discountCents + taxCents + shippingCostCents;
        if (computedTotal < BigInt(0)) {
          throw new PurchasingError(
            "Header discount cannot make the purchase order total negative",
            400,
            {
              code: "PO_TOTAL_NEGATIVE",
              subtotalCents: safeIntegerMoney(subtotal, "subtotal_cents"),
              discountCents: safeIntegerMoney(discountCents, "discount_cents"),
              taxCents: safeIntegerMoney(taxCents, "tax_cents"),
              shippingCostCents: safeIntegerMoney(shippingCostCents, "shipping_cost_cents"),
            },
          );
        }
        const subtotalCents = safeIntegerMoney(subtotal, "subtotal_cents");
        const totalCents = safeIntegerMoney(computedTotal, "total_cents");
        before.subtotal_cents = readIntegerCents(po.subtotalCents ?? 0, "subtotal", true);
        before.total_cents = readIntegerCents(po.totalCents ?? 0, "total", true);
        after.subtotal_cents = subtotalCents;
        after.total_cents = totalCents;

        const updatedRows = await tx
          .update(purchaseOrdersTable)
          .set({
            ...patch,
            subtotalCents,
            totalCents,
            lineCount: lines.length,
            receivedLineCount,
            ...(userId ? { updatedBy: userId } : {}),
            updatedAt: po.updatedAt == null
              ? millisecondTransactionTimestamp()
              : nextPurchaseOrderUpdatedAt(po.updatedAt),
          })
          .where(and(...cleanDraftHeaderCasConditions(po)))
          .returning();
        const updated = updatedRows[0];
        if (!updated) {
          throw new PurchasingError("Purchase order changed while header charges were being applied", 409, {
            code: "PO_DRAFT_EDIT_CONFLICT",
          });
        }

        await emitPoEventTx(tx, id, "incoterms_charges_updated", userId, {
          changed_fields: changedFields,
          before,
          after,
        });
        return updated;
      });
  }

  return {
    hardenedAddLine,
    hardenedAddLineCommand,
    hardenedAddBulkLines,
    hardenedAddBulkLinesCommand,
    hardenedUpdateLine,
    hardenedUpdateLineCommand,
    hardenedCancelLine,
    hardenedCancelLineCommand,
    createPO,
    updatePO,
    updateDeliverySchedule,
    deletePO,
    updateIncotermsAndCharges,
  };
}
