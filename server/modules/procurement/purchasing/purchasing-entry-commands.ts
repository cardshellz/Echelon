import { and, eq, inArray, sql } from "drizzle-orm";
import { readIntegerCents, readIntegerMills } from "@shared/money-read";
import type {
  PurchaseOrderEntryAction,
  PurchaseOrderEntryCommand,
} from "@shared/procurement/purchase-order-entry-command";
import {
  inboundShipmentLines,
  poStatusHistory as poStatusHistoryTable,
  purchaseOrderLines as purchaseOrderLinesTable,
  purchaseOrders as purchaseOrdersTable,
  purchasingRecommendationPoHandoffs as purchasingRecommendationPoHandoffsTable,
  vendorInvoiceLines,
} from "@shared/schema";
import type { PoLineType } from "@shared/schema/procurement.schema";
import {
  normalizePoLinePricing,
  type PoLinePricingInput,
} from "@shared/utils/po-line-pricing";
import { readCommandAuthorityActor } from "../../identity";
import { captureDocumentNumberTime } from "../../../platform/document-numbering/document-number";
import { assertPurchaseOrderEntryAuthority } from "../domain/purchase-order-entry";
import { hasPoInvoiceHistory, readPoInvoiceHistory } from "../infrastructure/po-invoice-history.repository";
import {
  assertNoLegacyPurchaseOrderEntry,
  type PurchaseOrderEntryTransaction,
} from "../infrastructure/purchase-order-entry.repository";
import { executePurchaseOrderEntry } from "../application/purchase-order-entry.service";
import {
  millisecondTransactionTimestamp,
  purchaseOrderUpdatedAtMatchesApplicationVersion,
} from "../application/purchase-order-lifecycle-version";
import {
  vendorCatalogPricingMatches,
  vendorCatalogQuoteUsability,
} from "../application/purchase-order-line-commands";
import type { PurchasingCatalog } from "./purchasing-catalog";
import type { PurchasingEntryValidation } from "./purchasing-entry-validation";
import type { PurchasingLifecycleActions } from "./purchasing-lifecycle-actions";
import type { PurchasingLifecycleLocks } from "./purchasing-lifecycle-locks";
import {
  auditDate,
  EDITABLE_STATUSES,
  isPoNumberUniqueViolation,
  isValidIsoDateOnly,
  MAX_QUOTE_CLOCK_SKEW_MS,
  PG_INTEGER_MAX,
  PO_NUMBER_ALLOCATION_ATTEMPTS,
  PurchasingError,
  requireUsdPurchaseOrderCurrency,
  safeIntegerMoney,
  signedCentsToMills,
  signedMillsToCents,
  storedMoneyAsBigInt,
  type CreatePurchaseOrderInternalOptions,
  type CreatePurchaseOrderWithLinesInput,
  type PurchaseOrderLineInput,
  type PurchasingBaseContext,
  type SendPurchaseOrderResult,
  type UpdateDraftPurchaseOrderWithLinesInput,
} from "./purchasing.types";

export function createPurchasingEntryCommands(
  ctx: PurchasingBaseContext,
  validation: PurchasingEntryValidation,
  deps: {
    persistPurchaseOrderCatalogWritesTx: PurchasingCatalog["persistPurchaseOrderCatalogWritesTx"];
    observeLifecycleState: PurchasingLifecycleLocks["observeLifecycleState"];
    sendWithLockedEconomics: PurchasingLifecycleActions["sendWithLockedEconomics"];
  },
) {
  const { db, storage, now, lockInventoryCostGraph, emitPoEventTx } = ctx;
  const {
    validateCreateWithLinesInput,
    resolvePurchaseOrderLines,
    lockAndValidatePurchaseOrderReferences,
    assertNoDraftLineDownstreamLinks,
    buildPurchaseOrderLineValues,
    receiveConfigurationNormalizations,
    applyPurchaseOrderParentLineLinks,
    snapshotDraftHeader,
    snapshotDraftLine,
  } = validation;
  const {
    persistPurchaseOrderCatalogWritesTx,
    observeLifecycleState,
    sendWithLockedEconomics,
  } = deps;

  async function createPurchaseOrderWithLines(
    input: CreatePurchaseOrderWithLinesInput,
    userId?: string,
    internalOptions?: CreatePurchaseOrderInternalOptions,
  ): Promise<any> {
    validateCreateWithLinesInput(input);

    const vendor = await storage.getVendorById(input.vendorId, internalOptions?.transaction);
    if (!vendor) throw new PurchasingError("Vendor not found", 404);
    requireUsdPurchaseOrderCurrency(vendor.currency);
    const resolvedLines = await resolvePurchaseOrderLines(input, internalOptions?.transaction);

    const subtotalCentsBigInt = resolvedLines.reduce(
      (sum, r) => sum + BigInt(r.costs.lineTotalCents),
      BigInt(0),
    );
    const subtotalCents = safeIntegerMoney(subtotalCentsBigInt, "subtotal_cents");

    // Single transaction: header + lines + status history + po_events['created'].
    // Take the graph lock before the shared number lock, retaining both through
    // insertion. The bounded retry still handles legacy/manual conflicting writers.
    const recordedAt = captureDocumentNumberTime(now());
    let attemptedPoNumber: string | null = null;
    const createAttempt = async () => (internalOptions?.transaction ?? db).transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
      const poNumber = await storage.generatePoNumber(tx, recordedAt);
      attemptedPoNumber = poNumber;
      await persistPurchaseOrderCatalogWritesTx(
        tx,
        input.vendorId,
        resolvedLines.map((resolved) => resolved.line),
        userId,
      );
      // Close the catalog-price TOCTOU window before any PO rows are written.
      const lockedVendor = await lockAndValidatePurchaseOrderReferences(
        tx,
        input.vendorId,
        resolvedLines,
      );
      const [header] = await tx
        .insert(purchaseOrdersTable)
        .values({
          poNumber,
          vendorId: input.vendorId,
          warehouseId: input.warehouseId ?? null,
          status: "draft",
          poType: input.poType ?? "standard",
          priority: input.priority ?? "normal",
          expectedDeliveryDate: input.expectedDeliveryDate ?? null,
          incoterms: input.incoterms ?? null,
          vendorNotes: input.vendorNotes ?? null,
          internalNotes: input.internalNotes ?? null,
          currency: requireUsdPurchaseOrderCurrency(lockedVendor.currency),
          paymentTermsDays: lockedVendor.paymentTermsDays,
          paymentTermsType: lockedVendor.paymentTermsType,
          shipFromAddress: lockedVendor.shipFromAddress,
          subtotalCents,
          totalCents: subtotalCents, // no header discount/tax/shipping on inline create
          lineCount: resolvedLines.length,
          createdBy: userId ?? null,
          updatedBy: userId ?? null,
          createdAt: millisecondTransactionTimestamp(),
          updatedAt: millisecondTransactionTimestamp(),
        })
        .returning();

      const lineRows = resolvedLines.map((resolved, index) =>
        buildPurchaseOrderLineValues(header.id, resolved, index + 1),
      );
      const insertedLines = await tx
        .insert(purchaseOrderLinesTable)
        .values(lineRows.map(row => ({ ...row, receiptCostingEnabled: 1 })))
        .returning({
          id: purchaseOrderLinesTable.id,
          lineNumber: purchaseOrderLinesTable.lineNumber,
        });

      await applyPurchaseOrderParentLineLinks(tx, resolvedLines, insertedLines);

      // Status history: creation row (from NULL -> 'draft').
      await tx.insert(poStatusHistoryTable).values({
        purchaseOrderId: header.id,
        fromStatus: null,
        toStatus: "draft",
        changedBy: userId ?? null,
        notes: "PO created (inline)",
      });

      // Event stream.
      const receiveNormalizations = receiveConfigurationNormalizations(resolvedLines);
      await emitPoEventTx(tx, header.id, "created", userId, {
        source: internalOptions?.source ?? "inline_editor",
        line_count: resolvedLines.length,
        subtotal_cents: subtotalCents,
        ...(receiveNormalizations.length > 0
          ? { receive_configuration_normalizations: receiveNormalizations }
          : {}),
      });

      if (internalOptions?.additionalEvent) {
        await emitPoEventTx(
          tx,
          header.id,
          internalOptions.additionalEvent.eventType,
          userId,
          internalOptions.additionalEvent.payload,
        );
      }

      return header;
    });

    let lastConflictingPoNumber: string | null = null;
    for (let attempt = 1; attempt <= PO_NUMBER_ALLOCATION_ATTEMPTS; attempt++) {
      try {
        return await createAttempt();
      } catch (error: any) {
        if (!isPoNumberUniqueViolation(error)) throw error;
        lastConflictingPoNumber = attemptedPoNumber;
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

  // ── DRAFT FULL-REPLACEMENT FLOW ─────────────────────────────────────────
  //
  // Locks the draft header and lines, checks an optimistic version, preserves
  // retained line ids, cancels removed lines, inserts only new lines, and
  // records the complete before/after state in one transaction.

  async function updateDraftPurchaseOrderWithLines(
    id: number,
    input: UpdateDraftPurchaseOrderWithLinesInput,
    userId?: string,
    transaction?: PurchaseOrderEntryTransaction,
  ): Promise<{ po: any; lines: any[] }> {
    if (!Number.isSafeInteger(id) || id <= 0 || id > PG_INTEGER_MAX) {
      throw new PurchasingError("Purchase order id must be a positive integer", 400, {
        code: "INVALID_PURCHASE_ORDER_ID",
      });
    }
    if (!input || typeof input !== "object") {
      throw new PurchasingError("Request body is required", 400);
    }
    if (
      !(input.expectedUpdatedAt instanceof Date) ||
      Number.isNaN(input.expectedUpdatedAt.getTime())
    ) {
      throw new PurchasingError("expected_updated_at must be a valid date", 400, {
        code: "PO_DRAFT_EXPECTED_VERSION_REQUIRED",
      });
    }
    validateCreateWithLinesInput(input, { allowExistingLineIds: true });

    const vendor = await storage.getVendorById(input.vendorId, transaction);
    if (!vendor) throw new PurchasingError("Vendor not found", 404);
    const resolvedLines = await resolvePurchaseOrderLines(input, transaction);
    const subtotalCents = safeIntegerMoney(
      resolvedLines.reduce(
        (sum, resolved) => sum + BigInt(resolved.costs.lineTotalCents),
        BigInt(0),
      ),
      "subtotal_cents",
    );

    return (transaction ?? db).transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
      const lockedHeaders = await tx
        .select()
        .from(purchaseOrdersTable)
        .where(eq(purchaseOrdersTable.id, id))
        .limit(1)
        .for("update");
      const currentPo = lockedHeaders[0];
      if (!currentPo) throw new PurchasingError("Purchase order not found", 404);

      const recommendationHandoffs = await tx
        .select({ id: purchasingRecommendationPoHandoffsTable.id })
        .from(purchasingRecommendationPoHandoffsTable)
        .where(eq(purchasingRecommendationPoHandoffsTable.purchaseOrderId, id))
        .limit(1);
      if (recommendationHandoffs[0]) {
        throw new PurchasingError(
          "Cannot replace lines on a recommendation-created PO; cancel it and accept a new recommendation",
          409,
          {
            code: "RECOMMENDATION_PO_LINE_AMEND_BLOCKED",
            handoffId: recommendationHandoffs[0].id,
          },
        );
      }

      const physicalStatus = currentPo.physicalStatus ?? currentPo.status;
      if (
        currentPo.status !== "draft" ||
        physicalStatus !== "draft"
      ) {
        throw new PurchasingError(`Cannot edit PO in '${currentPo.status}' status`, 400, {
          code: "PO_NOT_EDITABLE",
          status: currentPo.status,
          physicalStatus,
        });
      }
      if (hasPoInvoiceHistory(await readPoInvoiceHistory(tx, id))) {
        throw new PurchasingError("Cannot replace lines after financial activity exists", 409, {
          code: "PO_DRAFT_HAS_FINANCIAL_ACTIVITY",
        });
      }

      const currentUpdatedAt = new Date(currentPo.updatedAt);
      if (
        Number.isNaN(currentUpdatedAt.getTime()) ||
        currentUpdatedAt.getTime() !== input.expectedUpdatedAt.getTime()
      ) {
        throw new PurchasingError("This draft changed after it was loaded", 409, {
          code: "PO_DRAFT_EDIT_STALE",
          expected_updated_at: input.expectedUpdatedAt.toISOString(),
          current_updated_at: auditDate(currentPo.updatedAt),
        });
      }

      const existingLines = await tx
        .select()
        .from(purchaseOrderLinesTable)
        .where(eq(purchaseOrderLinesTable.purchaseOrderId, id))
        .for("update");
      const activeExistingLines = existingLines.filter((line: any) => line.status !== "cancelled");
      const activeById = new Map<number, any>(
        activeExistingLines.map((line: any) => [Number(line.id), line]),
      );

      const nonEditableLine = activeExistingLines.find((line: any) =>
        (line.status ?? "open") !== "open" ||
        Number(line.receivedQty ?? 0) !== 0 ||
        Number(line.damagedQty ?? 0) !== 0 ||
        Number(line.returnedQty ?? 0) !== 0 ||
        Number(line.cancelledQty ?? 0) !== 0,
      );
      if (nonEditableLine) {
        throw new PurchasingError("Cannot replace draft lines after inventory activity exists", 409, {
          code: "PO_DRAFT_LINE_HAS_ACTIVITY",
          line_id: nonEditableLine.id,
          line_status: nonEditableLine.status,
        });
      }

      for (const resolved of resolvedLines) {
        const lineId = resolved.line.lineId;
        if (lineId !== undefined && !activeById.has(lineId)) {
          throw new PurchasingError(`Line ${lineId} is not an active line on this PO`, 409, {
            code: "PO_DRAFT_LINE_OWNERSHIP",
            line_id: lineId,
            purchase_order_id: id,
          });
        }
      }

      await assertNoDraftLineDownstreamLinks(
        tx,
        activeExistingLines.map((line: any) => Number(line.id)),
      );
      await persistPurchaseOrderCatalogWritesTx(
        tx,
        input.vendorId,
        resolvedLines.map((resolved) => resolved.line),
        userId,
      );
      const lockedVendor = await lockAndValidatePurchaseOrderReferences(
        tx,
        input.vendorId,
        resolvedLines,
      );

      const latestStoredTimestamp = [currentPo, ...activeExistingLines].reduce(
        (latest, row: any) => {
          const value = new Date(row.updatedAt).getTime();
          return Number.isNaN(value) ? latest : Math.max(latest, value);
        },
        currentUpdatedAt.getTime(),
      );
      const changedAt = new Date(
        Math.max(now().getTime(), latestStoredTimestamp + 1),
      );
      const beforeHeader = snapshotDraftHeader(currentPo);
      const beforeLines = activeExistingLines
        .slice()
        .sort((a: any, b: any) => Number(a.lineNumber) - Number(b.lineNumber))
        .map(snapshotDraftLine);
      const retainedLineIds = new Set(
        resolvedLines
          .map((resolved) => resolved.line.lineId)
          .filter((lineId): lineId is number => lineId !== undefined),
      );
      const cancelledLineIds: number[] = [];

      for (const existingLine of activeExistingLines) {
        if (retainedLineIds.has(existingLine.id)) continue;
        const cancelled = await tx
          .update(purchaseOrderLinesTable)
          .set({
            status: "cancelled",
            cancelledQty: existingLine.orderQty,
            parentLineId: null,
            updatedAt: changedAt,
          })
          .where(and(
            eq(purchaseOrderLinesTable.id, existingLine.id),
            eq(purchaseOrderLinesTable.purchaseOrderId, id),
            eq(purchaseOrderLinesTable.status, "open"),
          ))
          .returning({ id: purchaseOrderLinesTable.id });
        if (!cancelled[0]) {
          throw new PurchasingError("A draft line changed while the edit was being applied", 409, {
            code: "PO_DRAFT_EDIT_CONFLICT",
            line_id: existingLine.id,
          });
        }
        cancelledLineIds.push(existingLine.id);
      }

      // Retained line numbers may swap. Stage them at unique negative ids so
      // the active (PO, line_number) unique index cannot see a transient
      // duplicate while the final 1..N sequence is written.
      if (retainedLineIds.size > 0) {
        await tx
          .update(purchaseOrderLinesTable)
          .set({
            lineNumber: sql`-${purchaseOrderLinesTable.id}`,
            updatedAt: changedAt,
          })
          .where(and(
            eq(purchaseOrderLinesTable.purchaseOrderId, id),
            inArray(purchaseOrderLinesTable.id, [...retainedLineIds]),
            eq(purchaseOrderLinesTable.status, "open"),
          ));
      }

      const persistedLines: any[] = [];
      const addedLineIds: number[] = [];
      for (let index = 0; index < resolvedLines.length; index++) {
        const resolved = resolvedLines[index];
        const values = buildPurchaseOrderLineValues(id, resolved, index + 1);
        let persisted: any;
        if (resolved.line.lineId !== undefined) {
          const updatedRows = await tx
            .update(purchaseOrderLinesTable)
            .set({ ...values, updatedAt: changedAt })
            .where(and(
              eq(purchaseOrderLinesTable.id, resolved.line.lineId),
              eq(purchaseOrderLinesTable.purchaseOrderId, id),
              eq(purchaseOrderLinesTable.status, "open"),
            ))
            .returning();
          persisted = updatedRows[0];
          if (!persisted) {
            throw new PurchasingError("A draft line changed while the edit was being applied", 409, {
              code: "PO_DRAFT_EDIT_CONFLICT",
              line_id: resolved.line.lineId,
            });
          }
        } else {
          const insertedRows = await tx
            .insert(purchaseOrderLinesTable)
            .values({ ...values, receiptCostingEnabled: 1, createdAt: changedAt, updatedAt: changedAt })
            .returning();
          persisted = insertedRows[0];
          if (!persisted) {
            throw new PurchasingError("Failed to insert a draft line", 500, {
              code: "PO_DRAFT_LINE_INSERT_FAILED",
              line_number: index + 1,
            });
          }
          addedLineIds.push(persisted.id);
        }
        persistedLines.push(persisted);
      }

      await applyPurchaseOrderParentLineLinks(tx, resolvedLines, persistedLines, changedAt);

      const discountCents = storedMoneyAsBigInt(currentPo.discountCents, "discount_cents");
      const taxCents = storedMoneyAsBigInt(currentPo.taxCents, "tax_cents");
      const shippingCostCents = storedMoneyAsBigInt(
        currentPo.shippingCostCents,
        "shipping_cost_cents",
      );
      const totalCents = safeIntegerMoney(
        BigInt(subtotalCents) - discountCents + taxCents + shippingCostCents,
        "total_cents",
      );
      const vendorChanged = Number(currentPo.vendorId) !== input.vendorId;
      const headerPatch = {
        vendorId: input.vendorId,
        warehouseId: input.warehouseId === undefined ? currentPo.warehouseId : input.warehouseId,
        poType: input.poType ?? currentPo.poType ?? "standard",
        priority: input.priority ?? currentPo.priority ?? "normal",
        expectedDeliveryDate: input.expectedDeliveryDate ?? null,
        incoterms: input.incoterms ?? null,
        vendorNotes: input.vendorNotes ?? null,
        internalNotes: input.internalNotes ?? null,
        currency: requireUsdPurchaseOrderCurrency(
          vendorChanged ? lockedVendor.currency : currentPo.currency,
        ),
        paymentTermsDays: vendorChanged ? lockedVendor.paymentTermsDays : currentPo.paymentTermsDays,
        paymentTermsType: vendorChanged ? lockedVendor.paymentTermsType : currentPo.paymentTermsType,
        shipFromAddress: vendorChanged ? lockedVendor.shipFromAddress : currentPo.shipFromAddress,
        subtotalCents,
        totalCents,
        lineCount: persistedLines.length,
        receivedLineCount: 0,
        updatedBy: userId ?? null,
        updatedAt: changedAt,
      };
      const updatedHeaders = await tx
        .update(purchaseOrdersTable)
        .set(headerPatch)
        .where(and(
          eq(purchaseOrdersTable.id, id),
          eq(purchaseOrdersTable.status, "draft"),
          eq(purchaseOrdersTable.physicalStatus, "draft"),
          purchaseOrderUpdatedAtMatchesApplicationVersion(currentPo.updatedAt),
        ))
        .returning();
      const updatedPo = updatedHeaders[0];
      if (!updatedPo) {
        throw new PurchasingError("Purchase order changed while the edit was being applied", 409, {
          code: "PO_DRAFT_EDIT_CONFLICT",
        });
      }

      const receiveNormalizations = receiveConfigurationNormalizations(resolvedLines);
      await emitPoEventTx(tx, id, "edited", userId, {
        source: "inline_editor",
        expected_updated_at: input.expectedUpdatedAt.toISOString(),
        added_line_ids: addedLineIds,
        cancelled_line_ids: cancelledLineIds,
        ...(receiveNormalizations.length > 0
          ? { receive_configuration_normalizations: receiveNormalizations }
          : {}),
        before: {
          header: beforeHeader,
          lines: beforeLines,
        },
        after: {
          header: snapshotDraftHeader(updatedPo),
          lines: persistedLines.map(snapshotDraftLine),
        },
      });

      return {
        po: updatedPo,
        lines: persistedLines.map((line, index) => ({
          ...line,
          clientId: resolvedLines[index].line.clientId,
        })),
      };
    });
  }

  async function sendPurchaseOrder(poId: number, userId?: string): Promise<SendPurchaseOrderResult> {
    const expectation = await observeLifecycleState(
      poId, ["draft", "approved"],
      (status) => `Cannot prepare PO in '${status}' status (must be draft or approved)`,
    );
    const result = await sendWithLockedEconomics(poId, userId, expectation, {
      allowDraft: true,
      soloModeOnly: false,
      sentNotes: "Prepared for supplier review",
      recordExternalSend: false,
    });
    if (result.status === "sent") throw new Error("PO preparation unexpectedly recorded dispatch");
    return { po: result.po, status: result.status, pdf: null,
      pendingApproval: result.pendingApproval, dispatchRecorded: false };
  }

  // ── DUPLICATE (Spec A) ──────────────────────────────────────────────────
  //
  // Duplicate an existing PO's lines into a fresh draft. Per spec §11.4 the
  // A current, usable catalog quote is preferred. Only a same-vendor copy may
  // fall back to source product economics, and explicit quotes become manual.

  function requiredDuplicateStoredInteger(
    value: unknown,
    field: string,
    src: any,
  ): number {
    if (value === null || value === undefined || !Number.isSafeInteger(Number(value))) {
      throw new PurchasingError(
        `Source PO line ${src.id} has invalid ${field} quote provenance`,
        409,
        {
          code: "PO_DUPLICATE_SOURCE_PRICING_INVALID",
          sourceLineId: src.id,
          field,
        },
      );
    }
    return Number(value);
  }

  function duplicateSourcePricing(src: any): PoLinePricingInput | null {
    let pricing: PoLinePricingInput | null = null;
    switch (src.pricingBasis) {
      case "per_piece":
        pricing = {
          basis: "per_piece",
          quantityPieces: requiredDuplicateStoredInteger(src.orderQty, "order_qty", src),
          unitCostMills: requiredDuplicateStoredInteger(
            src.quotedUnitCostMills,
            "quoted_unit_cost_mills",
            src,
          ),
        };
        break;
      case "per_purchase_uom":
        pricing = {
          basis: "per_purchase_uom",
          purchaseUom: String(src.purchaseUom ?? ""),
          uomQuantity: requiredDuplicateStoredInteger(
            src.purchaseUomQuantity,
            "purchase_uom_quantity",
            src,
          ),
          piecesPerUom: requiredDuplicateStoredInteger(
            src.piecesPerPurchaseUom,
            "pieces_per_purchase_uom",
            src,
          ),
          quotedCostMillsPerUom: requiredDuplicateStoredInteger(
            src.quotedUnitCostMills,
            "quoted_unit_cost_mills",
            src,
          ),
        };
        break;
      case "extended_total":
        pricing = {
          basis: "extended_total",
          quantityPieces: requiredDuplicateStoredInteger(src.orderQty, "order_qty", src),
          quotedTotalCents: requiredDuplicateStoredInteger(
            src.quotedTotalCents,
            "quoted_total_cents",
            src,
          ),
        };
        break;
      default:
        return null;
    }

    try {
      const normalized = normalizePoLinePricing(pricing);
      if (normalized.orderQty !== Number(src.orderQty)) {
        throw new RangeError("stored quote quantity does not equal order_qty");
      }
    } catch (error: any) {
      throw new PurchasingError(
        `Source PO line ${src.id} has invalid stored quote provenance and cannot be duplicated safely`,
        409,
        {
          code: "PO_DUPLICATE_SOURCE_PRICING_INVALID",
          sourceLineId: src.id,
          pricingBasis: src.pricingBasis,
          reason: error?.message ?? "invalid stored quote",
        },
      );
    }
    return pricing;
  }

  function duplicateManualQuoteDate(value: unknown, src: any): Date | null {
    if (value === null || value === undefined) return null;
    const parsed = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(parsed.getTime())) {
      throw new PurchasingError(
        `Source PO line ${src.id} has an invalid quoted_at value`,
        409,
        { code: "PO_DUPLICATE_SOURCE_QUOTE_DATE_INVALID", sourceLineId: src.id },
      );
    }
    return parsed;
  }

  function duplicateManualValidUntil(value: unknown, src: any): string | null {
    if (value === null || value === undefined) return null;
    const dateOnly = value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).slice(0, 10);
    if (!isValidIsoDateOnly(dateOnly)) {
      throw new PurchasingError(
        `Source PO line ${src.id} has an invalid quote_valid_until value`,
        409,
        { code: "PO_DUPLICATE_SOURCE_QUOTE_DATE_INVALID", sourceLineId: src.id },
      );
    }
    return dateOnly;
  }

  function duplicateCatalogPricing(
    vendorProduct: any,
    orderQty: number,
  ): PoLinePricingInput | null {
    if (Number(vendorProduct?.isActive) !== 1) return null;
    if (!vendorCatalogQuoteUsability(vendorProduct, now()).usable) return null;

    let pricing: PoLinePricingInput | null = null;
    if (vendorProduct.pricingBasis === "per_piece") {
      if (vendorProduct.quotedUnitCostMills == null) return null;
      pricing = {
        basis: "per_piece",
        quantityPieces: orderQty,
        unitCostMills: readIntegerMills(vendorProduct.quotedUnitCostMills, "unit cost", true),
      };
    } else if (vendorProduct.pricingBasis === "per_purchase_uom") {
      if (vendorProduct.quotedUnitCostMills == null) return null;
      const piecesPerUom = Number(vendorProduct.piecesPerPurchaseUom);
      if (
        !Number.isSafeInteger(piecesPerUom) ||
        piecesPerUom <= 0 ||
        orderQty % piecesPerUom !== 0
      ) {
        return null;
      }
      pricing = {
        basis: "per_purchase_uom",
        purchaseUom: String(vendorProduct.purchaseUom ?? ""),
        uomQuantity: orderQty / piecesPerUom,
        piecesPerUom,
        quotedCostMillsPerUom: readIntegerMills(vendorProduct.quotedUnitCostMills, "quoted cost mills per uom", true),
      };
    } else {
      return null;
    }

    try {
      const normalized = normalizePoLinePricing(pricing);
      return normalized.orderQty === orderQty &&
        vendorCatalogPricingMatches(vendorProduct, pricing)
        ? pricing
        : null;
    } catch {
      return null;
    }
  }

  async function findDuplicateCatalogQuote(
    targetVendorId: number,
    src: any,
    transaction?: PurchaseOrderEntryTransaction,
  ): Promise<{ vendorProduct: any; pricing: PoLinePricingInput } | null> {
    const productId = Number(src.productId);
    const receiveVariantId = src.expectedReceiveVariantId ?? src.productVariantId ?? null;
    const catalogRows = await storage.getVendorProducts({
      vendorId: targetVendorId,
      productId,
      isActive: 1,
    }, transaction) ?? [];

    const candidates = catalogRows
      .filter((row: any) =>
        Number(row.vendorId) === targetVendorId &&
        Number(row.productId) === productId &&
        Number(row.isActive) === 1 &&
        (
          row.productVariantId == null ||
          Number(row.productVariantId) === Number(receiveVariantId)
        ),
      )
      .sort((left: any, right: any) => {
        const leftExact = left.productVariantId != null ? 1 : 0;
        const rightExact = right.productVariantId != null ? 1 : 0;
        if (leftExact !== rightExact) return rightExact - leftExact;
        const preferred = Number(right.isPreferred ?? 0) - Number(left.isPreferred ?? 0);
        if (preferred !== 0) return preferred;
        return Number(left.id) - Number(right.id);
      });

    for (const vendorProduct of candidates) {
      const pricing = duplicateCatalogPricing(vendorProduct, Number(src.orderQty));
      if (pricing) return { vendorProduct, pricing };
    }
    return null;
  }

  function duplicateLegacyCost(src: any): Pick<
    PurchaseOrderLineInput,
    "unitCostMills" | "unitCostCents" | "totalProductCostCents"
  > {
    if (src.lineType === "product" || src.lineType == null) {
      if (src.totalProductCostCents !== null && src.totalProductCostCents !== undefined) {
        const total = readIntegerCents(src.totalProductCostCents, "total", true);
        if (Number.isSafeInteger(total) && total >= 0) {
          return { totalProductCostCents: total };
        }
      }
    }
    if (src.unitCostMills !== null && src.unitCostMills !== undefined) {
      const mills = readIntegerMills(src.unitCostMills, "mills", true);
      if (Number.isSafeInteger(mills)) return { unitCostMills: mills };
    }
    if (src.unitCostCents !== null && src.unitCostCents !== undefined) {
      const cents = readIntegerCents(src.unitCostCents, "cents", true);
      if (Number.isSafeInteger(cents)) return { unitCostCents: cents };
    }
    throw new PurchasingError(
      `Source PO line ${src.id} has invalid legacy economics and cannot be duplicated safely`,
      409,
      { code: "PO_DUPLICATE_SOURCE_LEGACY_PRICE_INVALID", sourceLineId: src.id },
    );
  }

  function duplicateProductPackagingCost(src: any): number {
    const packagingCostCents = readIntegerCents(src.packagingCostCents ?? 0, "packaging cost", true);
    if (!Number.isSafeInteger(packagingCostCents) || packagingCostCents < 0) {
      throw new PurchasingError(
        `Source PO line ${src.id} has invalid packaging economics and cannot be duplicated safely`,
        409,
        {
          code: "PO_DUPLICATE_SOURCE_PACKAGING_INVALID",
          sourceLineId: src.id,
          packagingCostCents: src.packagingCostCents,
        },
      );
    }
    return packagingCostCents;
  }

  async function duplicatePurchaseOrder(
    sourceId: number,
    overrides: { vendorId?: number; expectedDeliveryDate?: Date | null } | undefined,
    userId?: string,
    transaction?: PurchaseOrderEntryTransaction,
  ): Promise<any> {
    const source = await storage.getPurchaseOrderById(sourceId, transaction);
    if (!source) throw new PurchasingError("Source purchase order not found", 404);
    const sourceLines = await storage.getPurchaseOrderLines(sourceId, transaction);
    if (sourceLines.length === 0) {
      throw new PurchasingError("Source PO has no lines to duplicate", 400);
    }

    const targetVendorId = overrides?.vendorId ?? source.vendorId;
    const targetVendorChanged = Number(targetVendorId) !== Number(source.vendorId);

    // Resolve product pricing without changing the stored piece quantity.
    // Catalog provenance is trusted only after the create transaction locks it.
    //
    // Preserve line_type + parent relationships from the source. Since the
    // duplicated PO gets new DB ids, we remap parents via client-side ids.
    // Source line.id → synthesized clientId; child lines reference their
    // parent's synthesized clientId.
    const clientIdBySourceId = new Map<number, string>();
    for (const src of sourceLines) {
      if (src.status === "cancelled") continue;
      clientIdBySourceId.set(src.id, `dup-${src.id}`);
    }

    const dupLines: CreatePurchaseOrderWithLinesInput["lines"] = [];
    for (const src of sourceLines) {
      if (src.status === "cancelled") continue;
      const srcLineType: PoLineType = (src.lineType as PoLineType) ?? "product";

      const parentClientId =
        typeof src.parentLineId === "number"
          ? clientIdBySourceId.get(src.parentLineId) ?? null
          : null;

      const baseLine: PurchaseOrderLineInput = {
        clientId: clientIdBySourceId.get(src.id),
        lineType: srcLineType,
        parentClientId,
        productId: srcLineType === "product" ? Number(src.productId) : null,
        productVariantId: srcLineType === "product"
          ? (src.expectedReceiveVariantId ?? src.productVariantId ?? null)
          : null,
        expectedReceiveVariantId: srcLineType === "product"
          ? (src.expectedReceiveVariantId ?? src.productVariantId ?? null)
          : null,
        expectedReceiveUnitsPerVariant: srcLineType === "product"
          ? (src.expectedReceiveUnitsPerVariant ?? src.unitsPerUom ?? 1)
          : undefined,
        orderQty: src.orderQty,
        description: src.description ?? null,
        vendorSku: src.vendorSku ?? null,
        notes: src.notes ?? null,
      };

      if (srcLineType !== "product") {
        if (targetVendorChanged) {
          throw new PurchasingError(
            `Line ${src.lineNumber ?? src.id} is a ${srcLineType} line and must be reviewed for the target vendor`,
            409,
            {
              code: "PO_DUPLICATE_TARGET_VENDOR_NON_PRODUCT_REVIEW_REQUIRED",
              sourcePoId: source.id,
              sourceLineId: src.id,
              lineType: srcLineType,
              targetVendorId,
            },
          );
        }
        dupLines.push({ ...baseLine, ...duplicateLegacyCost(src) });
        continue;
      }

      const packagingCostCents = duplicateProductPackagingCost(src);
      if (targetVendorChanged && packagingCostCents !== 0) {
        throw new PurchasingError(
          `Product line ${src.lineNumber ?? src.id} has a packaging cost that must be re-entered for the target vendor`,
          409,
          {
            code: "PO_DUPLICATE_TARGET_VENDOR_PACKAGING_REVIEW_REQUIRED",
            sourcePoId: source.id,
            sourceLineId: src.id,
            productId: src.productId,
            targetVendorId,
            packagingCostCents,
          },
        );
      }

      const catalogQuote = await findDuplicateCatalogQuote(targetVendorId, src, transaction);
      if (catalogQuote) {
        dupLines.push({
          ...baseLine,
          pricing: catalogQuote.pricing,
          pricingSource: "vendor_catalog",
          vendorProductId: Number(catalogQuote.vendorProduct.id),
          vendorSku: catalogQuote.vendorProduct.vendorSku ?? null,
          packagingCostCents,
        });
        continue;
      }

      if (targetVendorChanged) {
        throw new PurchasingError(
          `Product line ${src.lineNumber ?? src.id} has no active, usable catalog quote for the target vendor`,
          409,
          {
            code: "PO_DUPLICATE_TARGET_VENDOR_QUOTE_REQUIRED",
            sourcePoId: source.id,
            sourceLineId: src.id,
            productId: src.productId,
            expectedReceiveVariantId:
              src.expectedReceiveVariantId ?? src.productVariantId ?? null,
            targetVendorId,
          },
        );
      }

      const sourcePricing = duplicateSourcePricing(src);
      if (sourcePricing) {
        dupLines.push({
          ...baseLine,
          pricing: sourcePricing,
          pricingSource: "manual",
          vendorProductId: null,
          quoteReference: src.quoteReference ?? null,
          quotedAt: duplicateManualQuoteDate(src.quotedAt, src),
          quoteValidUntil: duplicateManualValidUntil(src.quoteValidUntil, src),
          packagingCostCents,
        });
      } else {
        dupLines.push({
          ...baseLine,
          ...duplicateLegacyCost(src),
          pricingSource: "legacy",
          vendorProductId: null,
          packagingCostCents,
        });
      }
    }

    if (dupLines.length === 0) {
      throw new PurchasingError("Source PO has no active lines to duplicate", 400);
    }

    const created = await createPurchaseOrderWithLines(
      {
        vendorId: targetVendorId,
        warehouseId: source.warehouseId ?? null,
        poType: source.poType ?? "standard",
        priority: source.priority ?? "normal",
        expectedDeliveryDate: overrides?.expectedDeliveryDate ?? null,
        incoterms: targetVendorChanged ? null : (source.incoterms ?? null),
        vendorNotes: targetVendorChanged ? null : (source.vendorNotes ?? null),
        internalNotes: source.internalNotes ?? null,
        lines: dupLines,
      },
      userId,
      {
        transaction,
        additionalEvent: {
          eventType: "duplicated_from",
          payload: {
            source_po_id: source.id,
            source_po_number: source.poNumber,
            line_count: dupLines.length,
          },
        },
      },
    );

    return created;
  }

  async function assertPurchaseEntryAuthority(action: PurchaseOrderEntryAction, actorId: string, key: string): Promise<void> {
    await db.transaction(async (tx: PurchaseOrderEntryTransaction) => {
      assertPurchaseOrderEntryAuthority(await readCommandAuthorityActor(tx, actorId), action);
      await assertNoLegacyPurchaseOrderEntry(tx, key);
    });
  }

  async function executePurchaseEntryInTransaction(tx: PurchaseOrderEntryTransaction, command: PurchaseOrderEntryCommand, actorId: string, key: string) {
    // Match the established owner lock order before acquiring Identity and PO
    // locks. Reentrant nested savepoints remain part of this command's commit.
    await lockInventoryCostGraph(tx);
    return executePurchaseOrderEntry(tx, command, actorId, key, {
      now,
      generatePoNumber: () => storage.generatePoNumber(tx, now()),
      create: (transaction, input, actor) => createPurchaseOrderWithLines(input, actor, { transaction }),
      save: (transaction, id, input, actor) => updateDraftPurchaseOrderWithLines(id, input, actor, transaction),
      duplicate: (transaction, id, overrides, actor) => duplicatePurchaseOrder(id, overrides, actor, transaction),
      async prepare(transaction, id, actor, solo) {
        const [po] = await transaction.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, id)).limit(1).for("update");
        if (!po) throw new PurchasingError("Purchase order not found", 404);
        if (!["draft", "approved"].includes(po.status)) throw new PurchasingError(`Cannot prepare PO in '${po.status}' status (must be draft or approved)`, 400);
        const expectation = { status: po.status, updatedAtMs: po.updatedAt ? po.updatedAt.getTime() : null };
        return sendWithLockedEconomics(id, actor, expectation, { allowDraft: true, soloModeOnly: solo,
          sentNotes: "Prepared for supplier review", recordExternalSend: false }, transaction);
      },
    });
  }

  return {
    createPurchaseOrderWithLines,
    updateDraftPurchaseOrderWithLines,
    sendPurchaseOrder,
    duplicatePurchaseOrder,
    assertPurchaseEntryAuthority,
    executePurchaseEntryInTransaction,
  };
}
