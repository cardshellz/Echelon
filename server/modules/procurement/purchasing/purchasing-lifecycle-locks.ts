import { and, desc, eq, getTableColumns, inArray, lte, ne, sql } from "drizzle-orm";
import { readIntegerCents } from "@shared/money-read";
import {
  poApprovalTiers as poApprovalTiersTable,
  poStatusHistory as poStatusHistoryTable,
  purchaseOrderLines as purchaseOrderLinesTable,
  purchaseOrders as purchaseOrdersTable,
  vendorProducts as vendorProductsTable,
} from "@shared/schema";
import { purchaseApprovalLinesFingerprint } from "../application/purchase-approval-review";
import {
  assertUniqueHighestApprovalTier,
  PurchaseApprovalAuthorityError,
} from "../domain/purchase-order-approval.policy";
import { PoLifecycleError } from "../application/purchase-order-lifecycle.service";
import {
  millisecondTransactionTimestamp,
  nextPurchaseOrderUpdatedAt,
  purchaseOrderUpdatedAtMatchesApplicationVersion,
} from "../application/purchase-order-lifecycle-version";
import { checkReceiveConfigurationReadyToLeaveDraft } from "../application/receive-configuration-policy";
import { assessSupplierQuoteValidity } from "../application/supplier-quote-validity";
import type { PurchasingCosting } from "./purchasing-costing";
import {
  isValidIsoDateOnly,
  MAX_QUOTE_CLOCK_SKEW_MS,
  PurchasingError,
  requireUsdPurchaseOrderCurrency,
  safeIntegerMoney,
  storedMoneyAsBigInt,
  type LifecycleExpectation,
  type LifecycleQuoteClock,
  type LockedLifecycleEconomics,
  type PurchasingBaseContext,
} from "./purchasing.types";

export function createPurchasingLifecycleLocks(
  ctx: PurchasingBaseContext,
  costing: Pick<PurchasingCosting, "calculateLineCosts">,
) {
  const { storage, emitPoEventTx } = ctx;
  const { calculateLineCosts } = costing;

  async function observeLifecycleVersion(id: number): Promise<LifecycleExpectation> {
    const observed = await storage.getPurchaseOrderById(id);
    if (!observed) throw new PurchasingError("Purchase order not found", 404);
    const updatedAtMs = observed.updatedAt == null
      ? null
      : new Date(observed.updatedAt).getTime();
    return {
      status: observed.status,
      updatedAtMs: Number.isNaN(updatedAtMs) ? null : updatedAtMs,
    };
  }

  async function observeLifecycleState(
    id: number,
    allowedStatuses: readonly string[],
    invalidMessage: (status: string) => string,
  ): Promise<LifecycleExpectation> {
    const expectation = await observeLifecycleVersion(id);
    if (!allowedStatuses.includes(expectation.status)) {
      throw new PurchasingError(invalidMessage(expectation.status), 400);
    }
    return expectation;
  }

  function assertLifecycleExpectation(po: any, expectation: LifecycleExpectation): void {
    const lockedUpdatedAtMs = po.updatedAt == null ? null : new Date(po.updatedAt).getTime();
    const timestampChanged =
      expectation.updatedAtMs !== null &&
      (Number.isNaN(lockedUpdatedAtMs) || lockedUpdatedAtMs !== expectation.updatedAtMs);
    if (po.status !== expectation.status || timestampChanged) {
      throw new PurchasingError(
        "Purchase order changed while the lifecycle action was waiting for its lock",
        409,
        {
          code: "PO_LIFECYCLE_CONFLICT",
          expectedStatus: expectation.status,
          currentStatus: po.status,
        },
      );
    }
  }

  async function lockLifecycleHeader(
    tx: any,
    id: number,
    expectation: LifecycleExpectation,
  ): Promise<any> {
    const headerRows = await tx
      .select({ ...getTableColumns(purchaseOrdersTable) })
      .from(purchaseOrdersTable)
      .where(eq(purchaseOrdersTable.id, id))
      .limit(1)
      .for("update");
    const po = headerRows[0];
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertLifecycleExpectation(po, expectation);
    return po;
  }

  async function lockLifecycleEconomics(
    tx: any,
    id: number,
    expectation: LifecycleExpectation,
  ): Promise<LockedLifecycleEconomics> {
    const po = await lockLifecycleHeader(tx, id, expectation);

    // Header-first lock ordering matches the hardened line commands. Lock each
    // active line as well: catalog SKU synchronization locks lines directly,
    // so the header alone does not establish a stable supplier-term snapshot.
    const lines = await tx
      .select({
        ...getTableColumns(purchaseOrderLinesTable),
        // Keep calendar-date comparisons in the database session's timezone.
        // Deriving this from the JavaScript Date's UTC representation can move
        // a near-midnight quote onto the wrong day.
        quotedAtDate: sql<string | null>`${purchaseOrderLinesTable.quotedAt}::date::text`,
      })
      .from(purchaseOrderLinesTable)
      .where(and(
        eq(purchaseOrderLinesTable.purchaseOrderId, id),
        ne(purchaseOrderLinesTable.status, "cancelled"),
      ))
      .orderBy(purchaseOrderLinesTable.id)
      .for("update");

    if (!lines.some((line: any) => Number(line.orderQty) > 0)) {
      throw new PurchasingError("PO must have at least one line with quantity > 0", 400);
    }

    let subtotal = BigInt(0);
    let receivedLineCount = 0;
    let newestLineUpdatedAtMs: number | null = null;
    let correctedLegacyEconomics = false;
    const explicitQuoteBases = new Set(["per_piece", "per_purchase_uom", "extended_total"]);

    for (const line of lines) {
      let trustedLineTotal = storedMoneyAsBigInt(line.lineTotalCents, "line_total_cents");

      // Explicit quote rows are protected by the quote-pricing database
      // identity constraint, including sub-cent remainder math. Re-deriving
      // those rows from rounded cents would destroy that precision. Legacy
      // rows have no such invariant, so repair their derived cent fields while
      // holding the row lock and use the repaired amount in the decision.
      if (!explicitQuoteBases.has(String(line.pricingBasis ?? "legacy_unknown"))) {
        const costs = calculateLineCosts(line);
        for (const [field, value] of Object.entries({
          line_total_cents: costs.lineTotalCents,
          discount_cents: costs.discountCents,
          tax_cents: costs.taxCents,
        })) {
          if (!Number.isSafeInteger(value)) {
            throw new PurchasingError(`Stored line cannot produce a safe ${field}`, 409, {
              code: "PO_LIFECYCLE_LINE_MONEY_INVALID",
              lineId: line.id,
              field,
            });
          }
        }
        trustedLineTotal = BigInt(costs.lineTotalCents);
        if (
          readIntegerCents(line.lineTotalCents, "line total", true) !== costs.lineTotalCents ||
          readIntegerCents(line.discountCents ?? 0, "computed amount", true) !== costs.discountCents ||
          readIntegerCents(line.taxCents ?? 0, "computed amount", true) !== costs.taxCents
        ) {
          const repaired = await tx
            .update(purchaseOrderLinesTable)
            .set({
              lineTotalCents: costs.lineTotalCents,
              discountCents: costs.discountCents,
              taxCents: costs.taxCents,
              updatedAt: sql`date_trunc('milliseconds', transaction_timestamp())`,
            })
            .where(and(
              eq(purchaseOrderLinesTable.id, line.id),
              eq(purchaseOrderLinesTable.purchaseOrderId, id),
              ne(purchaseOrderLinesTable.status, "cancelled"),
            ))
            .returning({ id: purchaseOrderLinesTable.id });
          if (!repaired[0]) {
            throw new PurchasingError("A purchase order line changed during lifecycle validation", 409, {
              code: "PO_LIFECYCLE_LINE_CONFLICT",
              lineId: line.id,
            });
          }
          correctedLegacyEconomics = true;
        }
      }

      subtotal += trustedLineTotal;
      if (line.status === "received") receivedLineCount++;
      if (line.updatedAt != null) {
        const lineUpdatedAtMs = new Date(line.updatedAt).getTime();
        if (!Number.isNaN(lineUpdatedAtMs)) {
          newestLineUpdatedAtMs = newestLineUpdatedAtMs === null
            ? lineUpdatedAtMs
            : Math.max(newestLineUpdatedAtMs, lineUpdatedAtMs);
        }
      }
    }

    const total =
      subtotal -
      storedMoneyAsBigInt(po.discountCents, "discount_cents") +
      storedMoneyAsBigInt(po.taxCents, "tax_cents") +
      storedMoneyAsBigInt(po.shippingCostCents, "shipping_cost_cents");

    return {
      po,
      lines,
      subtotalCents: safeIntegerMoney(subtotal, "subtotal_cents"),
      totalCents: safeIntegerMoney(total, "total_cents"),
      lineCount: lines.length,
      receivedLineCount,
      newestLineUpdatedAtMs,
      correctedLegacyEconomics,
    };
  }

  async function getMatchingApprovalTierTx(tx: any, totalCents: number): Promise<any | null> {
    const rows = await tx
      .select()
      .from(poApprovalTiersTable)
      .where(and(
        lte(poApprovalTiersTable.thresholdCents, totalCents),
        eq(poApprovalTiersTable.active, 1),
      ))
      .orderBy(desc(poApprovalTiersTable.thresholdCents), poApprovalTiersTable.id)
      .limit(2)
      .for("share");
    try {
      assertUniqueHighestApprovalTier(rows);
    } catch (error) {
      if (error instanceof PurchaseApprovalAuthorityError) throw new PurchasingError(error.message, error.statusCode, error.details);
      throw error;
    }
    return rows[0] ?? null;
  }

  async function getActiveApprovalTiersTx(tx: any): Promise<any[]> {
    return await tx
      .select()
      .from(poApprovalTiersTable)
      .where(eq(poApprovalTiersTable.active, 1))
      .orderBy(poApprovalTiersTable.id)
      .for("share");
  }

  function lifecycleTotalsPatch(economics: LockedLifecycleEconomics) {
    return {
      subtotalCents: economics.subtotalCents,
      totalCents: economics.totalCents,
      lineCount: economics.lineCount,
      receivedLineCount: economics.receivedLineCount,
    };
  }

  async function getLifecycleQuoteClockTx(tx: any): Promise<LifecycleQuoteClock> {
    const result = await tx.execute(sql`
      SELECT
        transaction_timestamp() AS quote_evaluated_at,
        current_date::text AS quote_current_date
    `);
    const row = result.rows?.[0];
    const evaluatedAt = row?.quote_evaluated_at instanceof Date
      ? row.quote_evaluated_at
      : new Date(String(row?.quote_evaluated_at ?? ""));
    const currentDate = String(row?.quote_current_date ?? "");
    if (
      Number.isNaN(evaluatedAt.getTime()) ||
      !isValidIsoDateOnly(currentDate)
    ) {
      throw new PurchasingError("Database quote-validation clock is unavailable", 500, {
        code: "PO_QUOTE_CLOCK_UNAVAILABLE",
      });
    }
    return { evaluatedAt, currentDate };
  }

  function lifecycleQuoteError(
    line: any,
    status: "invalid" | "future" | "expired" | "stale",
    currentDate: string,
  ): PurchasingError {
    const messages = {
      invalid: "A purchase-order line has invalid quote dates",
      future: "A purchase-order line quote is dated in the future",
      expired: "A purchase-order line quote has expired",
      stale: "A purchase-order line quote is stale and has no explicit validity date",
    } as const;
    return new PurchasingError(messages[status], 409, {
      code: `PO_LINE_QUOTE_${status.toUpperCase()}`,
      lineId: line.id,
      lineNumber: line.lineNumber ?? null,
      pricingSource: line.pricingSource ?? null,
      pricingBasis: line.pricingBasis ?? null,
      quotedAt: line.quotedAt ?? null,
      quoteValidUntil: line.quoteValidUntil ?? null,
      currentDate,
    });
  }

  /**
   * A purchase order may not leave draft while any open product line still has
   * no receive configuration. That configuration decides whether an eventual
   * shipment is counted as packs or as loose pieces, so the question has to be
   * answered before the order reaches a vendor — including on orders drafted
   * before the choice was mandatory.
   *
   * Lines are already locked by lockLifecycleEconomics, so this snapshot cannot
   * race a concurrent line edit.
   */
  function assertReceiveConfigurationReady(economics: LockedLifecycleEconomics): void {
    const violation = checkReceiveConfigurationReadyToLeaveDraft(economics.lines as any[]);
    if (!violation) return;
    throw new PurchasingError(violation.message, violation.status, {
      code: violation.code,
      ...violation.context,
    });
  }

  /**
   * The single readiness gate every transition out of draft passes through
   * (submit, approve, send). Both the quote basis and the receive
   * configuration must be settled before a purchase order can advance, so
   * they are asserted together here rather than at each call site, where a
   * future transition could forget one.
   */
  async function assertLifecycleReadyToAdvanceTx(
    tx: any,
    economics: LockedLifecycleEconomics,
  ): Promise<void> {
    assertReceiveConfigurationReady(economics);
    const unreviewedLegacyProduct = economics.lines.find((line: any) =>
      (line.lineType ?? "product") === "product" &&
      (line.pricingBasis ?? "legacy_unknown") === "legacy_unknown",
    );
    if (unreviewedLegacyProduct) {
      throw new PurchasingError(
        "A legacy product line must be reviewed and given an explicit vendor quote basis before submission or sending",
        409,
        {
          code: "PO_LINE_QUOTE_REVIEW_REQUIRED",
          lineId: unreviewedLegacyProduct.id,
          lineNumber: unreviewedLegacyProduct.lineNumber ?? null,
          pricingSource: unreviewedLegacyProduct.pricingSource ?? "legacy",
          pricingBasis: unreviewedLegacyProduct.pricingBasis ?? "legacy_unknown",
        },
      );
    }

    const datedOrTrustedLines = economics.lines.filter((line: any) =>
      line.pricingSource === "vendor_catalog" ||
      line.pricingSource === "recommendation" ||
      line.quotedAt != null ||
      line.quoteValidUntil != null,
    );
    if (datedOrTrustedLines.length === 0) return;

    const clock = await getLifecycleQuoteClockTx(tx);
    for (const line of datedOrTrustedLines) {
      const validUntil = line.quoteValidUntil == null
        ? null
        : String(line.quoteValidUntil).slice(0, 10);
      if (validUntil !== null && !isValidIsoDateOnly(validUntil)) {
        throw lifecycleQuoteError(line, "invalid", clock.currentDate);
      }
      if (validUntil !== null && validUntil < clock.currentDate) {
        throw lifecycleQuoteError(line, "expired", clock.currentDate);
      }

      // Manual quotes may intentionally omit a quote date. A stated date,
      // and every trusted catalog/recommendation snapshot, must still be
      // current at the moment approval or sending commits.
      if (line.quotedAt == null) {
        if (line.pricingSource === "vendor_catalog" || line.pricingSource === "recommendation") {
          throw lifecycleQuoteError(line, "invalid", clock.currentDate);
        }
        continue;
      }
      const validity = assessSupplierQuoteValidity({
        quotedAt: line.quotedAt,
        quotedAtDate: line.quotedAtDate ?? null,
        quoteValidUntil: validUntil,
        asOf: clock.evaluatedAt,
        currentDate: clock.currentDate,
      });
      if (validity.status === "invalid" || validity.status === "future" || validity.status === "expired" || validity.status === "stale") {
        throw lifecycleQuoteError(line, validity.status, clock.currentDate);
      }
    }

    const trustedLines = datedOrTrustedLines.filter((line: any) =>
      line.pricingSource === "vendor_catalog" || line.pricingSource === "recommendation",
    );
    if (trustedLines.length === 0) return;
    const vendorProductIds = [...new Set(trustedLines.map((line: any) => Number(line.vendorProductId)))]
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .sort((left, right) => left - right);
    if (vendorProductIds.length !== new Set(trustedLines.map((line: any) => Number(line.vendorProductId))).size) {
      throw new PurchasingError("A trusted purchase-order line is missing vendor catalog provenance", 409, {
        code: "PO_LINE_VENDOR_CATALOG_PROVENANCE_INVALID",
      });
    }
    const catalogRows = await tx
      .select()
      .from(vendorProductsTable)
      .where(inArray(vendorProductsTable.id, vendorProductIds))
      .orderBy(vendorProductsTable.id)
      .for("share");
    const catalogById = new Map<number, any>(
      catalogRows.map((row: any) => [Number(row.id), row]),
    );
    for (const line of trustedLines) {
      const vendorProduct = catalogById.get(Number(line.vendorProductId));
      if (
        !vendorProduct ||
        Number(vendorProduct.isActive ?? 0) !== 1 ||
        Number(vendorProduct.vendorId) !== Number(economics.po.vendorId) ||
        Number(vendorProduct.productId) !== Number(line.productId)
      ) {
        throw new PurchasingError(
          "A trusted vendor catalog mapping is no longer active for this PO vendor and product",
          409,
          {
            code: "PO_LINE_VENDOR_CATALOG_PROVENANCE_INACTIVE",
            lineId: line.id,
            vendorProductId: line.vendorProductId ?? null,
          },
        );
      }
    }
  }

  async function updateLockedLifecycleHeader(
    tx: any,
    economics: LockedLifecycleEconomics,
    patch: Record<string, unknown>,
  ): Promise<any> {
    const po = economics.po;
    const conditions = [
      eq(purchaseOrdersTable.id, po.id),
      eq(purchaseOrdersTable.status, po.status),
    ];
    if (po.physicalStatus != null) {
      conditions.push(eq(purchaseOrdersTable.physicalStatus, po.physicalStatus));
    }
    if (po.updatedAt != null) {
      conditions.push(purchaseOrderUpdatedAtMatchesApplicationVersion(po.updatedAt));
    }
    const rows = await tx
      .update(purchaseOrdersTable)
      .set({
        ...patch,
        updatedAt: po.updatedAt == null
          ? millisecondTransactionTimestamp()
          : nextPurchaseOrderUpdatedAt(po.updatedAt),
      })
      .where(and(...conditions))
      .returning();
    if (!rows[0]) {
      throw new PurchasingError("Purchase order changed during the lifecycle transition", 409, {
        code: "PO_LIFECYCLE_CONFLICT",
      });
    }
    return rows[0];
  }

  function approvalCoversLockedEconomics(
    economics: LockedLifecycleEconomics,
    tier: any,
    reviewedLinesFingerprint: unknown,
  ): boolean {
    const approvedAtMs = economics.po.approvedAt == null
      ? Number.NaN
      : new Date(economics.po.approvedAt).getTime();
    if (
      Number.isNaN(approvedAtMs) ||
      Number(economics.po.approvalTierId) !== Number(tier.id) ||
      economics.correctedLegacyEconomics
    ) {
      return false;
    }
    // New explicit approvals bind the exact persisted supplier terms, including
    // catalog SKU changes whose timestamp can predate the approval transaction.
    // Historical and amendment approvals without this evidence retain their
    // existing amount, authority and timestamp checks; no evidence is backfilled.
    if (reviewedLinesFingerprint !== undefined &&
        reviewedLinesFingerprint !== purchaseApprovalLinesFingerprint(economics.lines)) {
      return false;
    }
    return economics.newestLineUpdatedAtMs === null || economics.newestLineUpdatedAtMs <= approvedAtMs;
  }

  function toPurchasingError(error: unknown): never {
    if (error instanceof PoLifecycleError) {
      throw new PurchasingError(error.message, error.statusCode, error.details);
    }
    throw error;
  }

  async function updatePurchaseOrderStatusWithHistoryTx(
    tx: any,
    id: number,
    updates: Record<string, unknown>,
    historyData: {
      fromStatus?: string;
      toStatus?: string;
      changedBy?: string;
      notes?: string;
    },
    at?: Date,
  ): Promise<any | null> {
    if (!historyData?.toStatus) {
      throw new Error("updatePurchaseOrderStatusWithHistoryTx requires historyData.toStatus");
    }

    const result = await tx.update(purchaseOrdersTable)
      .set({ ...updates, updatedAt: at ?? new Date() })
      .where(eq(purchaseOrdersTable.id, id))
      .returning();

    const updatedPo = result[0] || null;
    if (updatedPo) {
      await tx.insert(poStatusHistoryTable).values({
        ...historyData,
        purchaseOrderId: id,
        ...(at ? { changedAt: at } : {}),
      });
    }
    return updatedPo;
  }

  async function updatePurchaseOrderLineTx(
    tx: any,
    id: number,
    updates: Record<string, unknown>,
    at?: Date,
  ): Promise<any | null> {
    const result = await tx.update(purchaseOrderLinesTable)
      .set({ ...updates, updatedAt: at ?? new Date() })
      .where(eq(purchaseOrderLinesTable.id, id))
      .returning();
    return result[0] || null;
  }

  async function writeLifecycleAuditTx(
    tx: any,
    purchaseOrderId: number,
    histories: Array<{
      fromStatus: string | null;
      toStatus: string;
      changedBy?: string;
      notes?: string;
    }>,
    events: Array<{ type: string; payload: Record<string, unknown> }>,
    userId?: string,
  ): Promise<void> {
    for (const history of histories) {
      await tx.insert(poStatusHistoryTable).values({
        purchaseOrderId,
        ...history,
        changedBy: history.changedBy ?? userId ?? null,
      });
    }
    for (const event of events) {
      await emitPoEventTx(tx, purchaseOrderId, event.type, userId, event.payload);
    }
  }

  async function moveLockedPoToPendingApproval(
    tx: any,
    economics: LockedLifecycleEconomics,
    tier: any,
    userId?: string,
    approvalInvalidated = false,
  ): Promise<any> {
    const fromStatus = economics.po.status;
    const updated = await updateLockedLifecycleHeader(tx, economics, {
      ...lifecycleTotalsPatch(economics),
      status: "pending_approval",
      physicalStatus: "draft",
      approvalTierId: tier.id,
      approvedBy: null,
      approvedAt: null,
      approvalNotes: null,
      updatedBy: userId ?? null,
    });
    await writeLifecycleAuditTx(
      tx,
      economics.po.id,
      [{
        fromStatus,
        toStatus: "pending_approval",
        notes: approvalInvalidated
          ? `Approval invalidated by changed economics; ${tier.tierName} approval is required`
          : `Approval required: ${tier.tierName}`,
      }],
      [{
        type: "submitted",
        payload: {
          from_status: fromStatus,
          to_status: "pending_approval",
          tier_id: tier.id,
          tier_name: tier.tierName,
          total_cents: economics.totalCents,
          approval_invalidated: approvalInvalidated,
        },
      }],
      userId,
    );
    return updated;
  }

  return {
    observeLifecycleVersion,
    observeLifecycleState,
    assertLifecycleExpectation,
    lockLifecycleHeader,
    lockLifecycleEconomics,
    getMatchingApprovalTierTx,
    getActiveApprovalTiersTx,
    lifecycleTotalsPatch,
    getLifecycleQuoteClockTx,
    lifecycleQuoteError,
    assertReceiveConfigurationReady,
    assertLifecycleReadyToAdvanceTx,
    updateLockedLifecycleHeader,
    approvalCoversLockedEconomics,
    toPurchasingError,
    updatePurchaseOrderStatusWithHistoryTx,
    updatePurchaseOrderLineTx,
    writeLifecycleAuditTx,
    moveLockedPoToPendingApproval,
  };
}

export type PurchasingLifecycleLocks = ReturnType<typeof createPurchasingLifecycleLocks>;
