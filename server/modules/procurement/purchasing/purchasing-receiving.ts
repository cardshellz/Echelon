import { sql } from "drizzle-orm";
import type { PurchaseOrderLine } from "@shared/schema/procurement.schema";
import {
  shipmentReceiptPlanRequestSchema,
  type ShipmentReceiptPlanRequest,
  type ShipmentReceiptUnitSelection,
} from "@shared/procurement/shipment-receipt-plan";
import { canonicalJson } from "@shared/utils/canonical-json";
import { centsToMills, millsToCents } from "@shared/utils/money";
import { insertAuditEventDrizzle } from "../../../infrastructure/transactional-audit";
import { captureDocumentNumberTime } from "../../../platform/document-numbering/document-number";
import { PoDirectCustodySourceError } from "../domain/po-direct-receipt-custody";
import {
  summarizeShipmentReceiptCustodyCoverage,
  type ShipmentReceiptCustodyCoverage,
} from "../domain/shipment-receipt-custody";
import { readPoDirectCustodySources } from "../infrastructure/po-direct-receipt-custody.repository";
import { detectQtyVariance } from "../application/po-exceptions.service";
import {
  findOpenPoLineByProduct as findOpenPoLineByProductWithStorage,
  reconcilePurchaseOrderReceipt,
  type ReceiptReconciliationResult,
  type ReceivingReconciliationLine,
} from "../application/purchase-order-receipt-reconciliation.service";
import { RECEIVABLE_SHIPMENT_STATUSES } from "../domain/receiving-close-integrity.domain";
import {
  readPrimaryReceivingLocations,
  type ReceivingIntegrityTransaction,
} from "../infrastructure/receiving-close-integrity.repository";
import { readReceiptCustodyPresence } from "../infrastructure/receiving-quarantine.repository";
import { ShipmentReceiptCoverageError } from "../application/receiving-shipment-coverage";
import {
  planReceiptUnits,
  ReceivingUnitError,
  type ReceiptUnitPlan,
  type ReceiptVariant,
} from "../application/receiving-unit-contract";
import { ReceivingUnitSnapshotError } from "../application/receiving-unit-snapshot";
import { readShipmentReceiptCustodyCoverage } from "../infrastructure/shipment-receipt-custody.repository";
import { shipmentReceiptSourceVersion } from "../application/shipment-receipt-source-version";
import type { PurchasingCosting } from "./purchasing-costing";
import {
  ACTIVE_RECEIPT_STATUSES,
  parsePositiveInteger,
  PurchasingError,
  type PurchasingBaseContext,
} from "./purchasing.types";
import { logger } from "../../../platform/observability/logger";

export type ShipmentReceiptExistingState =
  | { kind: "none" }
  | { kind: "active"; receipt: any }
  | { kind: "empty_active"; receipt: any; lineCount: 0 }
  | { kind: "zero_post_closed"; receipt: any; summary: ShipmentReceiptPostingSummary }
  | { kind: "closed"; receipt: any };

export type ShipmentReceiveOption = {
  shipmentId: number;
  shipmentNumber: string | null;
  status: string | null;
  purchaseOrderId: number;
  lineCount: number;
  qtyShipped: number;
  receivedBaseQty: number | null;
  custodyBaseQty: number | null;
  excessBaseQty: number | null;
  heldBaseQty: number | null;
  returnedBaseQty: number | null;
  custodyReceiptIds: number[];
  remainingBaseQty: number | null;
  missingPurchaseOrderLineCount: number;
  receivable: boolean;
  action: "create_receipt" | "open_existing_receipt" | "repair_empty_receipt" | "void_zero_post_receipt" | "blocked";
  reason: string | null;
  freightWillCarry: boolean;
  estimatedTotalCostCents: number | null;
  actualTotalCostCents: number | null;
  existingReceiptId: number | null;
  existingReceiptStatus: string | null;
  existingReceiptLineCount: number | null;
};

export type ShipmentReceiptPostingSummary = {
  lineCount: number;
  expectedQty: number;
  receivedQty: number;
  poReceiptCount: number;
  inventoryLotCount: number;
  inventoryTransactionCount: number;
  postingStateKnown: boolean;
};

export type ShipmentReceiptCoverageSummary = {
  totalExpectedBaseQty: number;
  totalReceivedBaseQty: number;
  totalCustodyBaseQty: number;
  totalExcessBaseQty: number;
  totalHeldBaseQty: number;
  totalReturnedBaseQty: number;
  custodyReceiptIds: number[];
  totalRemainingBaseQty: number;
  remainingLines: any[];
};

export type ShipmentReceiptPackResolutionLine = {
  shipmentLineId: number | null;
  purchaseOrderId: number | null;
  purchaseOrderLineId: number | null;
  sku: string | null;
  productId: number | null;
  productName: string | null;
  qtyShipped: number | null;
  cartonCount: number | null;
  unitsPerCarton: number | null;
  status: "resolved" | "missing_product" | "missing_variant" | "invalid_po_line" | "invalid_quantity" | "missing_piece_variant" | "unit_mismatch" | "selection_required";
  blocking: boolean;
  issue: string | null;
  receivePlan: ReceiptUnitPlan | null;
  matchedVariant: { id: number; sku: string | null; name: string | null; unitsPerVariant: number } | null;
  activeVariants: Array<{ id: number; sku: string | null; name: string | null; unitsPerVariant: number }>;
};

export function createPurchasingReceiving(
  ctx: PurchasingBaseContext,
  costing: Pick<PurchasingCosting, "recalculateTotals">,
) {
  const { db, storage, now, lockInventoryCostGraph } = ctx;
  const { recalculateTotals } = costing;

  async function createReceiptFromPO(purchaseOrderId: number, userId?: string) {
    try {
      return await db.transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
        if (typeof tx.execute === "function") {
          await tx.execute(sql`
            SELECT pg_advisory_xact_lock(
              hashtext('procurement.create_receipt_from_po'),
              ${purchaseOrderId}
            )
          `);
          await tx.execute(sql`
            SELECT id
            FROM procurement.purchase_orders
            WHERE id = ${purchaseOrderId}
            FOR UPDATE
          `);
        }
        return await createReceiptFromPOUnlocked(purchaseOrderId, userId, tx);
      });
    } catch (error: any) {
      if (error?.code === "23505" || error?.cause?.code === "23505") {
        const conflictReceipt = await getReusableReceiptForPO(purchaseOrderId);
        if (conflictReceipt) {
          return { ...conflictReceipt, reusedExisting: true };
        }
        throw new PurchasingError("Receipt creation conflicted with another active receipt", 409, {
          purchaseOrderId,
        });
      }
      if (error instanceof PoDirectCustodySourceError || error instanceof ShipmentReceiptCoverageError) {
        logger.warn("procurement.receiving.custody_admission_rejected", { event: "procurement.receiving.custody_admission_rejected", command: "create_po_receipt", actorId: userId ?? null, purchaseOrderId, code: error.details.code });
        // Lifecycle HTTP commands forward the purchasing owner's typed error.
        throw new PurchasingError(error.message, error.statusCode, error.details);
      }
      throw error;
    }
  }

  async function getReusableReceiptForPO(purchaseOrderId: number, executor?: any) {
    const existingReceipts =
      typeof storage.getReceivingOrdersForPurchaseOrder === "function"
        ? await storage.getReceivingOrdersForPurchaseOrder(purchaseOrderId, executor)
        : [];

    return existingReceipts.find((receipt: any) =>
      ["draft", "open", "receiving", "verified"].includes(receipt.status),
    );
  }

  function isReceivablePurchaseProductLine(line: Pick<PurchaseOrderLine, "status" | "orderQty" | "receivedQty" | "cancelledQty">
    & { lineType?: PurchaseOrderLine["lineType"] }): boolean {
    return (line.lineType ?? "product") === "product"
      && (line.status === "open" || line.status === "partially_received")
      && line.orderQty - (line.receivedQty || 0) - (line.cancelledQty || 0) > 0;
  }

  async function createReceiptFromPOUnlocked(purchaseOrderId: number, userId: string | undefined, executor: any) {
    const po = await storage.getPurchaseOrderById(purchaseOrderId, executor);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    const openStatuses = ["sent", "acknowledged", "partially_received"];
    if (!openStatuses.includes(po.status)) {
      throw new PurchasingError(`Cannot create receipt for PO in '${po.status}' status`, 400);
    }

    const reusableReceipt = await getReusableReceiptForPO(purchaseOrderId, executor);
    if (reusableReceipt) {
      return { ...reusableReceipt, reusedExisting: true };
    }

    await executor.execute(sql`SELECT id FROM procurement.purchase_order_lines WHERE purchase_order_id = ${purchaseOrderId} ORDER BY id FOR UPDATE`);
    const lines = await storage.getPurchaseOrderLines(purchaseOrderId, executor);
    const candidateLines = lines.filter(isReceivablePurchaseProductLine);
    const custodySources = await readPoDirectCustodySources(executor, purchaseOrderId);
    const receivableLines = candidateLines.filter((line: any) => !custodySources.has(line.id));

    if (receivableLines.length === 0) {
      const blocked = new Map<number, readonly number[]>(candidateLines.filter((line: any) => custodySources.has(line.id))
        .map((line: any) => [line.id, custodySources.get(line.id)!]));
      if (blocked.size > 0) throw new PoDirectCustodySourceError(purchaseOrderId, blocked);
      throw new PurchasingError("No receivable lines on this PO", 400);
    }

    const receiptPlans = new Map<number, ReceiptUnitPlan>();
    for (const productId of [...new Set(receivableLines.map((line: any) => line.productId))].sort((a: any, b: any) => a - b)) {
      await executor.execute(sql`SELECT id FROM catalog.product_variants WHERE product_id = ${productId} ORDER BY id FOR SHARE`);
    }
    for (const poLine of receivableLines) {
      receiptPlans.set(poLine.id, await resolveReceiptPlan(poLine,
        poLine.orderQty - (poLine.receivedQty || 0) - (poLine.cancelledQty || 0), null, executor));
    }

    // Create receiving order
    const receiptNumber = await storage.generateReceiptNumber(executor, now());
    const receivingOrder = await storage.createReceivingOrder({
      receiptNumber,
      poNumber: po.poNumber,
      purchaseOrderId: po.id,
      sourceType: "po",
      vendorId: po.vendorId,
      warehouseId: po.warehouseId,
      status: "draft",
      expectedDate: po.expectedDeliveryDate || po.confirmedDeliveryDate,
      createdBy: userId,
    }, executor);

    const productLocationMap = await readPrimaryReceivingLocations(executor, po.warehouseId, [...receiptPlans.values()].map((plan) => plan.productVariantId));

    // Create receiving lines from PO lines.
    //
    // Stamp BOTH cents and mills on the new receiving_line so receive-time
    // precision matches the PO line. Mills is authoritative when present;
    // otherwise we derive mills from cents via centsToMills (no rounding).
    // Keeps receiving_lines consistent with the (post-0562) contract in
    // receiving.service.ts: mills is the source of truth, cents mirrors.
    const receivingLineData = receivableLines.map((poLine: any) => {
      const plan = receiptPlans.get(poLine.id)!;
      const resolvedVariantId = plan.productVariantId;
      const autoLocationId = (resolvedVariantId && productLocationMap.get(resolvedVariantId)) || null;
      const hasPoMills =
        typeof poLine.unitCostMills === "number" &&
        Number.isInteger(poLine.unitCostMills) &&
        poLine.unitCostMills >= 0;
      const unitCostMills = hasPoMills
        ? (poLine.unitCostMills as number)
        : (typeof poLine.unitCostCents === "number" && poLine.unitCostCents >= 0
            ? centsToMills(poLine.unitCostCents)
            : null);
      const unitCost = hasPoMills
        ? millsToCents(poLine.unitCostMills as number)
        : (typeof poLine.unitCostCents === "number" ? poLine.unitCostCents : null);
      return {
        receivingOrderId: receivingOrder.id,
        productVariantId: resolvedVariantId,
        productId: poLine.productId,
        sku: poLine.sku,
        productName: poLine.productName,
        expectedQty: plan.expectedQty,
        unitsPerVariantSnapshot: plan.unitsPerVariant,
        receivedQty: 0,
        damagedQty: 0,
        purchaseOrderLineId: poLine.id,
        unitCost,
        unitCostMills,
        costSourceKind: "purchase_order_line",
        putawayLocationId: autoLocationId,
        status: "pending",
      };
    });

    await storage.bulkCreateReceivingLines(receivingLineData, executor);
    return receivingOrder;
  }

  async function resolveReceiptPlan(poLine: any, baseQty: number, shipmentLine: any | null, executor?: any, selection?: ShipmentReceiptUnitSelection): Promise<ReceiptUnitPlan> {
    const productId = parsePositiveInteger(poLine.productId);
    if (!productId) throw new PurchasingError("The source PO line needs a product before receiving.", 409, { code: "RECEIVING_PRODUCT_REQUIRED", purchaseOrderLineId: poLine.id });
    if (!storage.getProductVariantsByProductId) throw new PurchasingError("Receipt catalog lookup is unavailable.", 503, { code: "RECEIVING_CATALOG_UNAVAILABLE" });
    const variants = await storage.getProductVariantsByProductId(productId, executor);
    return receiptPlanFromVariants(poLine, baseQty, shipmentLine, variants, selection);
  }

  function receiptPlanFromVariants(poLine: any, baseQty: number, shipmentLine: any | null, variants: ReceiptVariant[], selection?: ShipmentReceiptUnitSelection): ReceiptUnitPlan {
    if (selection && (selection.shipmentLineId !== shipmentLine?.id || selection.expectedBaseQty !== baseQty)) {
      throw new ReceivingUnitError("The remaining shipment pieces changed. Refresh and review the receiving count before continuing.", 409,
        { code: "SHIPMENT_RECEIPT_COVERAGE_CHANGED", shipmentLineId: shipmentLine?.id });
    }
    const preferredVariantId = parsePositiveInteger(shipmentLine?.productVariantId ?? poLine.expectedReceiveVariantId ?? poLine.productVariantId);
    const recordedPreferredUnits = shipmentLine?.unitsPerVariantSnapshot
      ?? (preferredVariantId !== null && preferredVariantId === poLine.expectedReceiveVariantId ? poLine.expectedReceiveUnitsPerVariant : null);
    return planReceiptUnits({ baseQty, productId: poLine.productId, preferredVariantId, recordedPreferredUnits, variants, selection,
      requireConfiguredUnit: shipmentLine !== null });
  }

  function scopedReceiptUnitSelections(selections: readonly ShipmentReceiptUnitSelection[], remainingLines: readonly { id: number }[]): Map<number, ShipmentReceiptUnitSelection> {
    const ids = new Set(remainingLines.map(line => line.id));
    if (selections.some(selection => !ids.has(selection.shipmentLineId))) {
      throw new PurchasingError("A receiving configuration belongs to another shipment, PO, or a line with no remaining pieces. Refresh the receipt check.", 409,
        { code: "SHIPMENT_RECEIPT_SELECTION_SCOPE_CHANGED" });
    }
    return new Map(selections.map(selection => [selection.shipmentLineId, selection]));
  }

  function activeReceiptStatus(status: unknown): boolean {
    return ACTIVE_RECEIPT_STATUSES.has(String(status ?? ""));
  }

  async function getShipmentReceiptPostingSummary(receivingOrderId: number, executor: any = db): Promise<ShipmentReceiptPostingSummary> {
    const fallback: ShipmentReceiptPostingSummary = {
      lineCount: 0,
      expectedQty: 0,
      receivedQty: 0,
      poReceiptCount: 0,
      inventoryLotCount: 0,
      inventoryTransactionCount: 0,
      postingStateKnown: false,
    };

    try {
      const result = await executor.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM procurement.receiving_lines WHERE receiving_order_id = ${receivingOrderId}) AS line_count,
          (SELECT COALESCE(SUM(expected_qty), 0)::int FROM procurement.receiving_lines WHERE receiving_order_id = ${receivingOrderId}) AS expected_qty,
          (SELECT COALESCE(SUM(received_qty), 0)::int FROM procurement.receiving_lines WHERE receiving_order_id = ${receivingOrderId}) AS received_qty,
          (SELECT COUNT(*)::int FROM procurement.po_receipts WHERE receiving_order_id = ${receivingOrderId}) AS po_receipt_count,
          (SELECT COUNT(*)::int FROM inventory.inventory_lots WHERE receiving_order_id = ${receivingOrderId}) AS inventory_lot_count,
          (
            SELECT COUNT(*)::int
            FROM inventory.inventory_transactions
            WHERE receiving_order_id = ${receivingOrderId}
              AND voided_at IS NULL
          ) AS inventory_transaction_count
      `);
      const row = result?.rows?.[0];
      if (!row) return fallback;
      return {
        lineCount: Number(row.line_count ?? 0),
        expectedQty: Number(row.expected_qty ?? 0),
        receivedQty: Number(row.received_qty ?? 0),
        poReceiptCount: Number(row.po_receipt_count ?? 0),
        inventoryLotCount: Number(row.inventory_lot_count ?? 0),
        inventoryTransactionCount: Number(row.inventory_transaction_count ?? 0),
        postingStateKnown: true,
      };
    } catch (error) {
      logger.warn("procurement.purchasing_receiving", { message: "[Procurement] Failed to inspect shipment receipt posting summary", receivingOrderId, error: error instanceof Error ? error.message : String(error) });
      return fallback;
    }
  }

  function isZeroPostClosedShipmentReceipt(summary: ShipmentReceiptPostingSummary): boolean {
    return summary.postingStateKnown &&
      summary.lineCount > 0 &&
      summary.receivedQty === 0 &&
      summary.poReceiptCount === 0 &&
      summary.inventoryLotCount === 0 &&
      summary.inventoryTransactionCount === 0;
  }

  async function getShipmentReceiptCoverage(purchaseOrderId: number, inboundShipmentId: number, shipmentLines: any[], executor: any = db): Promise<ShipmentReceiptCustodyCoverage> {
    return readShipmentReceiptCustodyCoverage(executor, { purchaseOrderId, inboundShipmentId, shipmentLines });
  }

  function adjustShipmentLineToRemainingBaseQty(line: any, remainingBaseQty: number): any {
    const adjusted = { ...line, qtyShipped: remainingBaseQty, qty_shipped: remainingBaseQty };
    // A remaining piece quantity cannot establish how many cartons remain.
    adjusted.cartonCount = remainingBaseQty === Number(line.qtyShipped) ? line.cartonCount : null;
    adjusted.carton_count = adjusted.cartonCount;
    return adjusted;
  }

  function summarizeShipmentReceiptCoverage(
    shipmentLines: any[],
    evidence: ShipmentReceiptCustodyCoverage,
  ): ShipmentReceiptCoverageSummary {
    const { remainingBaseQtyByLine, ...summary } = summarizeShipmentReceiptCustodyCoverage(shipmentLines, evidence);
    return { ...summary, remainingLines: shipmentLines.filter(line => (remainingBaseQtyByLine.get(line.id) ?? 0) > 0)
      .map(line => adjustShipmentLineToRemainingBaseQty(line, remainingBaseQtyByLine.get(line.id)!)) };
  }

  function shipmentCustodyCoverageMessage(coverage: ShipmentReceiptCoverageSummary): string {
    return coverage.totalHeldBaseQty > 0
      ? "All remaining shipped pieces are already in quarantine. Resolve held goods from their original receipt."
      : "All shipped pieces are already received or recorded as returned. Returned goods do not become a new arrival on this shipment.";
  }

  function variantIsActive(variant: any): boolean {
    return variant?.isActive !== false && variant?.is_active !== false;
  }

  function variantUnitsPerVariant(variant: any): number {
    const units = Number(variant?.unitsPerVariant ?? variant?.units_per_variant);
    return Number.isInteger(units) && units > 0 && units <= 2_147_483_647 ? units : 0;
  }

  function summarizeActiveVariants(variants: any[]): ShipmentReceiptPackResolutionLine["activeVariants"] {
    return variants
      .filter((variant) => parsePositiveInteger(variant?.id) && variantIsActive(variant) && variantUnitsPerVariant(variant) > 0)
      .map((variant) => ({
        id: parsePositiveInteger(variant.id) as number,
        sku: variant.sku ?? null,
        name: variant.name ?? null,
        unitsPerVariant: variantUnitsPerVariant(variant),
      }))
      .sort((a, b) => b.unitsPerVariant - a.unitsPerVariant || a.id - b.id);
  }

  function emptyShipmentReceiptError(
    receipt: any,
    purchaseOrderId: number,
    inboundShipmentId: number,
  ): PurchasingError {
    return new PurchasingError(
      "An empty draft receipt already exists for this shipment and PO. Clean up that draft receipt, then receive the shipment again.",
      409,
      {
        code: "EMPTY_SHIPMENT_RECEIPT",
        receivingOrderId: receipt?.id ?? null,
        purchaseOrderId,
        inboundShipmentId,
      },
    );
  }

  async function getReceiptForShipmentPo(
    purchaseOrderId: number,
    inboundShipmentId: number,
    executor?: any,
  ): Promise<ShipmentReceiptExistingState> {
    const receipts =
      typeof storage.getReceivingOrdersForPurchaseOrder === "function"
        ? await storage.getReceivingOrdersForPurchaseOrder(purchaseOrderId, executor)
        : [];
    const matchingReceipts = receipts.filter(
      (candidate: any) =>
        Number(candidate.inboundShipmentId) === inboundShipmentId &&
        candidate.status !== "cancelled",
    );
    if (matchingReceipts.length === 0) return { kind: "none" };

    const activeReceipt = matchingReceipts.find((candidate: any) => activeReceiptStatus(candidate.status));
    if (activeReceipt) {
      if (typeof storage.getReceivingLines === "function") {
        const lines = await storage.getReceivingLines(activeReceipt.id, executor);
        if (lines.length === 0 && !await readReceiptCustodyPresence(executor ?? db, activeReceipt.id)) {
          return { kind: "empty_active", receipt: activeReceipt, lineCount: 0 };
        }
      }
      return { kind: "active", receipt: activeReceipt };
    }

    for (const receipt of matchingReceipts) {
      const summary = await getShipmentReceiptPostingSummary(receipt.id, executor);
      if (isZeroPostClosedShipmentReceipt(summary) && !await readReceiptCustodyPresence(executor ?? db, receipt.id)) {
        return { kind: "zero_post_closed", receipt, summary };
      }
    }

    return { kind: "closed", receipt: matchingReceipts[0] };
  }

  async function inspectShipmentReceiptCoverage(
    purchaseOrderId: number,
    inboundShipmentId: number,
    shipmentLines: any[],
    existing: ShipmentReceiptExistingState,
  ): Promise<{ coverage: ShipmentReceiptCoverageSummary | null; coverageIssue: string | null }> {
    // A failed preview must not hide an existing receipt. The option builder
    // still permits opening that record, while close rechecks physical custody.
    try {
      const received = await getShipmentReceiptCoverage(purchaseOrderId, inboundShipmentId, shipmentLines);
      return { coverage: summarizeShipmentReceiptCoverage(shipmentLines, received), coverageIssue: null };
    } catch (error) {
      if (!(error instanceof ShipmentReceiptCoverageError) && !(error instanceof ReceivingUnitSnapshotError)) throw error;
      // A single history problem blocks only this creation option. Unexpected
      // infrastructure failures still propagate rather than appearing as data.
      return { coverage: null, coverageIssue: error.message };
    }
  }

  function buildShipmentReceiveOption(params: {
    shipment: any | null;
    purchaseOrderId: number;
    inboundShipmentId: number;
    shipmentLines: any[];
    existing: ShipmentReceiptExistingState;
    coverage: ShipmentReceiptCoverageSummary | null;
    coverageIssue?: string | null;
  }): ShipmentReceiveOption {
    const { shipment, purchaseOrderId, inboundShipmentId, shipmentLines, existing, coverage, coverageIssue } = params;
    const status = shipment?.status ?? null;
    const missingPurchaseOrderLineCount = shipmentLines.filter((line: any) => !line.purchaseOrderLineId).length;
    const shipmentIsReceivable = status ? RECEIVABLE_SHIPMENT_STATUSES.has(status) : false;
    const lineCount = shipmentLines.length;
    const qtyShipped = shipmentLines.reduce((sum, line: any) => sum + (Number(line.qtyShipped) || 0), 0);

    let action: ShipmentReceiveOption["action"] = "create_receipt";
    let reason: string | null = null;
    let receivable = true;

    if (existing.kind === "active") {
      action = "open_existing_receipt";
      reason = "A receipt is already open for this shipment and PO.";
    } else if (existing.kind === "empty_active") {
      receivable = false;
      action = "repair_empty_receipt";
      reason = "A draft shipment receipt exists but has no lines. Clean it up, then receive this shipment again so the pack checks can run.";
    } else if (existing.kind === "zero_post_closed") {
      receivable = false;
      action = "void_zero_post_receipt";
      reason = "A closed receipt exists for this shipment and PO, but it posted zero received quantity. Void that zero-post receipt, then receive this shipment again.";
    } else if (!shipment) {
      receivable = false;
      action = "blocked";
      reason = `Shipment ${inboundShipmentId} was referenced by PO lines but no shipment row was found.`;
    } else if (!shipmentIsReceivable) {
      receivable = false;
      action = "blocked";
      reason = `Shipment is ${String(status).replace(/_/g, " ")}, so it is not physically receivable yet.`;
    } else if (lineCount === 0) {
      receivable = false;
      action = "blocked";
      reason = "Shipment has no positive-quantity lines for this PO.";
    } else if (missingPurchaseOrderLineCount > 0) {
      receivable = false;
      action = "blocked";
      reason = `${missingPurchaseOrderLineCount} shipment line(s) are missing PO line links.`;
    } else if (coverage === null) {
      receivable = false;
      action = "blocked";
      reason = coverageIssue ?? "Receipt quantity coverage is unavailable. Review the original receipts before creating another receipt.";
    } else if (coverage.totalRemainingBaseQty <= 0) {
      receivable = false;
      action = "blocked";
      reason = coverage.totalCustodyBaseQty > 0 ? shipmentCustodyCoverageMessage(coverage)
        : "This shipment has already been received for this PO.";
    } else if (existing.kind === "closed") {
      reason = coverage.totalCustodyBaseQty > 0
        ? `${coverage.totalReceivedBaseQty} pieces were accepted; ${coverage.totalCustodyBaseQty} are recorded in quarantine custody or returns. ${coverage.totalRemainingBaseQty} shipped pieces remain to receive.`
        : `A prior shipment receipt was short; ${coverage.totalRemainingBaseQty} of ${coverage.totalExpectedBaseQty} shipped base units remain to receive.`;
    }

    const existingReceipt = existing.kind === "none" ? null : existing.receipt;
    const existingReceiptLineCount =
      existing.kind === "empty_active" ? existing.lineCount :
      existing.kind === "zero_post_closed" ? existing.summary.lineCount :
      null;
    return {
      shipmentId: inboundShipmentId,
      shipmentNumber: shipment?.shipmentNumber ?? null,
      status,
      purchaseOrderId,
      lineCount,
      qtyShipped,
      receivedBaseQty: coverage?.totalReceivedBaseQty ?? null,
      custodyBaseQty: coverage?.totalCustodyBaseQty ?? null,
      excessBaseQty: coverage?.totalExcessBaseQty ?? null,
      heldBaseQty: coverage?.totalHeldBaseQty ?? null,
      returnedBaseQty: coverage?.totalReturnedBaseQty ?? null,
      custodyReceiptIds: coverage?.custodyReceiptIds ?? [],
      remainingBaseQty: coverage?.totalRemainingBaseQty ?? null,
      missingPurchaseOrderLineCount,
      receivable,
      action,
      reason,
      freightWillCarry: receivable && action !== "blocked",
      estimatedTotalCostCents: shipment?.estimatedTotalCostCents ?? null,
      actualTotalCostCents: shipment?.actualTotalCostCents ?? null,
      existingReceiptId: existingReceipt?.id ?? null,
      existingReceiptStatus: existingReceipt?.status ?? null,
      existingReceiptLineCount,
    };
  }

  async function getPurchaseOrderReceiveOptions(purchaseOrderId: number) {
    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    const shipmentLines = await storage.getInboundShipmentLinesByPo(purchaseOrderId);
    const positiveShipmentLines = shipmentLines.filter((line: any) => Number(line.qtyShipped) > 0);
    const linesByShipment = new Map<number, any[]>();
    for (const line of positiveShipmentLines) {
      const shipmentId = parsePositiveInteger(line.inboundShipmentId);
      if (!shipmentId) continue;
      const lines = linesByShipment.get(shipmentId) ?? [];
      lines.push(line);
      linesByShipment.set(shipmentId, lines);
    }

    const shipmentOptions: ShipmentReceiveOption[] = [];
    for (const [shipmentId, lines] of linesByShipment) {
      const [shipment, existing] = await Promise.all([
        storage.getInboundShipmentById(shipmentId),
        getReceiptForShipmentPo(purchaseOrderId, shipmentId),
      ]);
      const { coverage, coverageIssue } = await inspectShipmentReceiptCoverage(purchaseOrderId, shipmentId, lines, existing);
      shipmentOptions.push(buildShipmentReceiveOption({
        shipment,
        purchaseOrderId,
        inboundShipmentId: shipmentId,
        shipmentLines: lines,
        existing,
        coverage,
        coverageIssue,
      }));
    }

    shipmentOptions.sort((a, b) => {
      const rank = Number(b.receivable) - Number(a.receivable);
      if (rank !== 0) return rank;
      return b.shipmentId - a.shipmentId;
    });

    const poDirectStatusAllowed = ["sent", "acknowledged", "partially_received"].includes(po.status);
    let directCustodySources = new Map<number, number[]>();
    let directEvidenceIssue: PoDirectCustodySourceError | null = null;
    try {
      directCustodySources = await readPoDirectCustodySources(db, purchaseOrderId);
    } catch (error) {
      if (!(error instanceof PoDirectCustodySourceError)) throw error;
      // Unprovable direct-source history blocks that creation path; it must not
      // hide independently actionable shipment or existing-receipt navigation.
      directEvidenceIssue = error;
    }
    const directPurchaseLines = directCustodySources.size > 0 ? await storage.getPurchaseOrderLines(purchaseOrderId) : [];
    const blockedDirectLines = directPurchaseLines.filter((line: any) => isReceivablePurchaseProductLine(line) && directCustodySources.has(line.id));
    const blockedDirectLineLabels = blockedDirectLines.map((line: any) => line.sku
      ? `${line.sku} (line ${line.lineNumber ?? line.id})` : `purchase line ${line.lineNumber ?? line.id}`);
    const blockedDirectSources = new Map<number, readonly number[]>(blockedDirectLines.map((line: any) => [line.id, directCustodySources.get(line.id)!]));
    const directSourceIssue = directEvidenceIssue ?? (blockedDirectSources.size > 0 ? new PoDirectCustodySourceError(purchaseOrderId, blockedDirectSources) : null);
    const poDirectAllowed = poDirectStatusAllowed && directEvidenceIssue === null && (directCustodySources.size === 0
      || directPurchaseLines.some((line: any) => isReceivablePurchaseProductLine(line) && !directCustodySources.has(line.id)));
    const linkedShipmentCount = shipmentOptions.length;
    return {
      purchaseOrderId,
      poNumber: po.poNumber,
      status: po.status,
      physicalStatus: po.physicalStatus ?? null,
      shipmentOptions,
      poDirect: {
        allowed: poDirectAllowed,
        reason: poDirectAllowed ? null : !poDirectStatusAllowed ? `Cannot create receipt for PO in '${po.status}' status`
          : directSourceIssue?.message ?? "No receivable lines on this PO",
        blockedPurchaseOrderLineIds: directSourceIssue?.details.purchaseOrderLineIds ?? [],
        custodyReceiptIds: directSourceIssue?.details.custodyReceiptIds ?? [],
        warning: directEvidenceIssue ? directEvidenceIssue.message : directSourceIssue
          ? `PO-direct receiving excludes ${blockedDirectLineLabels.join(", ")} because these lines have quarantine history. Use their shipment or original quarantine receipt.${poDirectAllowed ? " Unrelated eligible lines remain available for PO-direct receiving." : ""}`
          : linkedShipmentCount > 0
          ? "PO-direct receiving does not attach shipment freight to the received lots."
          : "No inbound shipment exists for this PO. PO-direct receiving is appropriate for no-freight or domestic receipts.",
      },
    };
  }

  // Shipment-scoped receive options: one option per PO with positive lines on
  // this shipment. Powers the multi-PO receive picker on the shipment page and
  // the post-close "receive next PO" chaining. Reuses the exact per-(shipment,
  // PO) state machine the PO page uses (buildShipmentReceiveOption), so both
  // surfaces always agree on receivability.
  async function getShipmentPoReceiveOptions(inboundShipmentId: number) {
    const shipment = await storage.getInboundShipmentById(inboundShipmentId);
    if (!shipment) throw new PurchasingError("Inbound shipment not found", 404);

    const shipmentLines = await storage.getInboundShipmentLines(inboundShipmentId);
    const positiveLines = shipmentLines.filter((line: any) => Number(line.qtyShipped) > 0);
    const linesByPo = new Map<number, any[]>();
    let unlinkedLineCount = 0;
    for (const line of positiveLines) {
      const poId = parsePositiveInteger(line.purchaseOrderId);
      if (!poId) {
        unlinkedLineCount++;
        continue;
      }
      const lines = linesByPo.get(poId) ?? [];
      lines.push(line);
      linesByPo.set(poId, lines);
    }

    const purchaseOrders: Array<ShipmentReceiveOption & { poNumber: string | null; poStatus: string | null }> = [];
    for (const [poId, lines] of linesByPo) {
      const [po, existing] = await Promise.all([
        storage.getPurchaseOrderById(poId),
        getReceiptForShipmentPo(poId, inboundShipmentId),
      ]);
      const { coverage, coverageIssue } = await inspectShipmentReceiptCoverage(poId, inboundShipmentId, lines, existing);
      const option = buildShipmentReceiveOption({
        shipment,
        purchaseOrderId: poId,
        inboundShipmentId,
        shipmentLines: lines,
        existing,
        coverage,
        coverageIssue,
      });
      purchaseOrders.push({
        ...option,
        poNumber: (po as any)?.poNumber ?? null,
        poStatus: (po as any)?.status ?? null,
      });
    }

    purchaseOrders.sort((a, b) => {
      const rank = Number(b.receivable) - Number(a.receivable);
      if (rank !== 0) return rank;
      return a.purchaseOrderId - b.purchaseOrderId;
    });

    return {
      shipmentId: inboundShipmentId,
      shipmentNumber: (shipment as any)?.shipmentNumber ?? null,
      status: (shipment as any)?.status ?? null,
      unlinkedLineCount,
      purchaseOrders,
    };
  }

  async function getShipmentReceiptPackResolution(
    inboundShipmentId: number,
    options: ShipmentReceiptPlanRequest = {},
  ) {
    options = shipmentReceiptPlanRequestSchema.parse(options);
    const shipment = await storage.getInboundShipmentById(inboundShipmentId);
    if (!shipment) throw new PurchasingError("Inbound shipment not found", 404);

    const shipmentLines = await storage.getInboundShipmentLines(inboundShipmentId);
    const linkedShipmentLines = shipmentLines.filter(
      (sl: any) => Number(sl.qtyShipped) > 0 && sl.purchaseOrderId && sl.purchaseOrderLineId,
    );
    const poIds = Array.from(
      new Set(linkedShipmentLines.map((sl: any) => Number(sl.purchaseOrderId)).filter((id: number) => Number.isInteger(id) && id > 0)),
    ).sort((a, b) => a - b);
    const requestedPoId = parsePositiveInteger(options.purchaseOrderId);
    if (!requestedPoId && poIds.length !== 1) {
      throw new PurchasingError(
        "This shipment's lines span multiple POs; choose which PO to receive.",
        409,
        { purchaseOrderIds: poIds },
      );
    }
    const purchaseOrderId = requestedPoId ?? (poIds[0] as number | undefined);
    if (!purchaseOrderId || !poIds.includes(purchaseOrderId)) {
      throw new PurchasingError(
        `Shipment ${inboundShipmentId} has no receivable lines for PO ${purchaseOrderId ?? "unknown"}.`,
        404,
        { purchaseOrderIds: poIds },
      );
    }

    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new PurchasingError("Linked purchase order not found", 404);

    const poLines = await storage.getPurchaseOrderLines(purchaseOrderId);
    const poLineById = new Map<number, any>(poLines.map((line: any) => [line.id, line]));
    const scopedShipmentLines = linkedShipmentLines.filter((sl: any) => Number(sl.purchaseOrderId) === purchaseOrderId);
    const received = await getShipmentReceiptCoverage(purchaseOrderId, inboundShipmentId, scopedShipmentLines);
    const coverage = summarizeShipmentReceiptCoverage(scopedShipmentLines, received);
    const receivableShipmentLines = coverage.remainingLines;
    const selections = scopedReceiptUnitSelections(options.receiptUnitSelections ?? [], receivableShipmentLines);

    const productIds = new Set<number>();
    for (const sl of receivableShipmentLines) {
      const poLine = poLineById.get(sl.purchaseOrderLineId);
      const productId = parsePositiveInteger(poLine?.productId);
      if (productId) productIds.add(productId);
    }

    if (!storage.getProductVariantsByProductId) throw new PurchasingError("Receipt catalog lookup is unavailable.", 503, { code: "RECEIVING_CATALOG_UNAVAILABLE" });
    const variantsByProductId = new Map<number, ReceiptVariant[]>();
    for (const productId of productIds) {
      variantsByProductId.set(productId, await storage.getProductVariantsByProductId(productId));
    }
    const lines: ShipmentReceiptPackResolutionLine[] = receivableShipmentLines.map((sl: any) => {
      const poLine = poLineById.get(sl.purchaseOrderLineId);
      const productId = parsePositiveInteger(poLine?.productId);
      const variants = productId ? variantsByProductId.get(productId) ?? [] : [];
      const activeVariants = summarizeActiveVariants(variants.filter(variant => variant.productId === productId));
      let receivePlan: ReceiptUnitPlan | null = null;
      let status: ShipmentReceiptPackResolutionLine["status"] = "resolved";
      let issue: string | null = null;
      if (!poLine) { status = "invalid_po_line"; issue = "Shipment source PO line was not found."; }
      else if (!productId) { status = "missing_product"; issue = "The source PO line needs a product before receiving."; }
      else {
        try {
          receivePlan = receiptPlanFromVariants(poLine, sl.qtyShipped, sl, variants, selections.get(sl.id));
          if (receivePlan.countsAsPieces && (receivePlan.preferredUnitsPerVariant ?? 1) > 1) {
            issue = `${sl.qtyShipped} pieces do not fill whole packs of ${receivePlan.preferredUnitsPerVariant}. This receipt will be counted in pieces; recorded cartons remain packing information.`;
          }
        } catch (error) {
          if (!(error instanceof ReceivingUnitError)) throw error;
          status = error.details.code === "RECEIVING_PIECE_VARIANT_REQUIRED" ? "missing_piece_variant"
            : error.details.code === "RECEIVING_VARIANT_SELECTION_REQUIRED" ? "selection_required"
            : error.details.code === "RECEIVING_UNIT_SOURCE_CHANGED" ? "unit_mismatch"
            : ["INVALID_RECEIVING_UNIT_QUANTITY", "SHIPMENT_RECEIPT_COVERAGE_CHANGED", "RECEIVING_UNIT_SELECTION_INEXACT"].includes(String(error.details.code)) ? "invalid_quantity" : "missing_variant";
          issue = error.message;
        }
      }
      return {
        shipmentLineId: parsePositiveInteger(sl.id), purchaseOrderId: parsePositiveInteger(sl.purchaseOrderId),
        purchaseOrderLineId: parsePositiveInteger(sl.purchaseOrderLineId), sku: poLine?.sku ?? sl.sku ?? null,
        productId, productName: poLine?.productName ?? null, qtyShipped: parsePositiveInteger(sl.qtyShipped),
        cartonCount: parsePositiveInteger(sl.cartonCount), unitsPerCarton: null,
        status, blocking: receivePlan === null, issue, receivePlan,
        matchedVariant: activeVariants.find((variant) => variant.id === receivePlan?.productVariantId) ?? null,
        activeVariants,
      };
    });

    const blockingLines = lines.filter((line) => line.blocking);
    const shipmentIsReceivable = RECEIVABLE_SHIPMENT_STATUSES.has((shipment as any).status);
    return {
      shipmentId: inboundShipmentId,
      shipmentNumber: shipment.shipmentNumber ?? shipment.shipment_number ?? null,
      status: shipment.status ?? null,
      purchaseOrderId,
      poNumber: po.poNumber ?? po.po_number ?? null,
      receiptUnitSelections: options.receiptUnitSelections ?? [],
      qtyShipped: coverage.totalExpectedBaseQty,
      receivedBaseQty: coverage.totalReceivedBaseQty,
      remainingBaseQty: coverage.totalRemainingBaseQty,
      custodyBaseQty: coverage.totalCustodyBaseQty,
      excessBaseQty: coverage.totalExcessBaseQty,
      heldBaseQty: coverage.totalHeldBaseQty,
      returnedBaseQty: coverage.totalReturnedBaseQty,
      custodyReceiptIds: coverage.custodyReceiptIds,
      canCreateReceipt: shipmentIsReceivable && lines.length > 0 && blockingLines.length === 0,
      unresolvedCount: blockingLines.length,
      lineCount: lines.length,
      issue: shipmentIsReceivable
        ? (lines.length === 0 ? coverage.totalCustodyBaseQty > 0 ? shipmentCustodyCoverageMessage(coverage)
          : "Shipment has no remaining quantity linked to this PO." : null)
        : `Cannot receive a shipment in '${(shipment as any).status}' status.`,
      lines,
    };
  }

  /**
   * Create a receiving order against an inbound SHIPMENT (the freight-bearing
   * leg). Mirrors createReceiptFromPO's line-building, but:
   *   - Expected qty comes from each shipment line's qtyShipped (the goods on
   *     THIS container), not the PO line's full orderQty;
   *   - stamps inbound_shipment_id + source_type='shipment' on the order, so the
   *     lots created at close inherit the shipment link + go provisional, and the
   *     shipment's finalized landed cost attaches to exactly these lots.
   * Cost is still stamped from the PO line (the AP source of truth).
   *
   * NOTE: cost stamping mirrors createReceiptFromPO. Shipment lines already
   * carry the resolved receive variant.
   */
  async function createReceiptFromShipment(
    inboundShipmentId: number,
    userId?: string,
    options: ShipmentReceiptPlanRequest = {},
  ) {
    options = shipmentReceiptPlanRequestSchema.parse(options);
    const shipment = await storage.getInboundShipmentById(inboundShipmentId);
    if (!shipment) throw new PurchasingError("Inbound shipment not found", 404);

    // Goods must be physically here (or being costed/closed) to receive them.
    if (!RECEIVABLE_SHIPMENT_STATUSES.has((shipment as any).status)) {
      throw new PurchasingError(`Cannot receive a shipment in '${(shipment as any).status}' status`, 400);
    }

    const shipmentLines = await storage.getInboundShipmentLines(inboundShipmentId);
    const preparedShipmentVersion = shipmentReceiptSourceVersion(shipment, shipmentLines);
    const linkedShipmentLines = shipmentLines.filter(
      (sl: any) => Number(sl.qtyShipped) > 0 && sl.purchaseOrderId && sl.purchaseOrderLineId,
    );
    if (linkedShipmentLines.length === 0) {
      throw new PurchasingError("Shipment has no receivable lines", 400);
    }

    const poIds = Array.from(
      new Set(linkedShipmentLines.map((sl: any) => Number(sl.purchaseOrderId)).filter((id: number) => Number.isInteger(id) && id > 0)),
    ).sort((a, b) => a - b);
    const requestedPoId = parsePositiveInteger(options.purchaseOrderId);
    if (!requestedPoId && poIds.length !== 1) {
      throw new PurchasingError(
        "This shipment's lines span multiple POs; choose which PO to receive.",
        409,
        { purchaseOrderIds: poIds },
      );
    }
    const purchaseOrderId = requestedPoId ?? (poIds[0] as number);
    if (!poIds.includes(purchaseOrderId)) {
      throw new PurchasingError(
        `Shipment ${inboundShipmentId} has no receivable lines for PO ${purchaseOrderId}.`,
        404,
        { purchaseOrderIds: poIds },
      );
    }

    const receivableShipmentLines = linkedShipmentLines.filter(
      (sl: any) => Number(sl.purchaseOrderId) === purchaseOrderId,
    );
    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new PurchasingError("Linked purchase order not found", 404);

    const existingReceipt = await getReceiptForShipmentPo(purchaseOrderId, inboundShipmentId);
    if (existingReceipt.kind === "active") return { ...existingReceipt.receipt, reusedExisting: true };
    if (existingReceipt.kind === "empty_active") {
      throw emptyShipmentReceiptError(existingReceipt.receipt, purchaseOrderId, inboundShipmentId);
    }
    if (existingReceipt.kind === "zero_post_closed") {
      throw new PurchasingError(
        "A closed zero-post receipt already exists for this shipment and PO. Void that receipt, then receive the shipment again.",
        409,
        {
          code: "ZERO_POST_SHIPMENT_RECEIPT",
          receivingOrderId: existingReceipt.receipt.id,
          purchaseOrderId,
          inboundShipmentId,
        },
      );
    }
    const receivedBaseQtyByLine = await getShipmentReceiptCoverage(
      purchaseOrderId,
      inboundShipmentId,
      receivableShipmentLines,
    );
    const coverage = summarizeShipmentReceiptCoverage(receivableShipmentLines, receivedBaseQtyByLine);
    const receiptShipmentLines = coverage.remainingLines;
    if (existingReceipt.kind === "closed" && coverage.totalRemainingBaseQty <= 0) {
      throw new PurchasingError(
        coverage.totalCustodyBaseQty > 0 ? shipmentCustodyCoverageMessage(coverage) : "This shipment has already been received for this PO.",
        409,
        { receivingOrderId: existingReceipt.receipt.id, purchaseOrderId, inboundShipmentId,
          ...(coverage.totalCustodyBaseQty > 0 ? { code: "SHIPMENT_RECEIPT_CUSTODY_ACCOUNTED",
            custodyBaseQty: coverage.totalCustodyBaseQty, custodyReceiptIds: coverage.custodyReceiptIds } : {}) },
      );
    }
    if (receiptShipmentLines.length === 0) {
      throw new PurchasingError(
        "This shipment has no remaining quantity to receive for this PO.",
        409,
        {
          code: "SHIPMENT_ALREADY_FULLY_RECEIVED",
          purchaseOrderId,
          inboundShipmentId,
          receivedBaseQty: coverage.totalReceivedBaseQty,
          expectedBaseQty: coverage.totalExpectedBaseQty,
        },
      );
    }

    const poLines = await storage.getPurchaseOrderLines(purchaseOrderId);
    const poLineById = new Map<number, any>(poLines.map((l: any) => [l.id, l]));
    const invalidLinkedLine = receivableShipmentLines.find((sl: any) => {
      const poLine = poLineById.get(sl.purchaseOrderLineId);
      const linePurchaseOrderId = parsePositiveInteger(poLine?.purchaseOrderId);
      return !poLine || (linePurchaseOrderId !== null && linePurchaseOrderId !== purchaseOrderId);
    });
    if (invalidLinkedLine) {
      throw new PurchasingError(
        "Shipment line PO links are inconsistent; receiving is blocked until the line links are repaired.",
        409,
        {
          inboundShipmentId,
          inboundShipmentLineId: invalidLinkedLine.id,
          purchaseOrderId,
          purchaseOrderLineId: invalidLinkedLine.purchaseOrderLineId ?? null,
        },
      );
    }

    const receiptPlans = new Map<number, ReceiptUnitPlan>();
    const selections = scopedReceiptUnitSelections(options.receiptUnitSelections ?? [], receiptShipmentLines);
    if (selections.size > 0 && (typeof userId !== "string" || !userId.trim())) throw new PurchasingError("Sign in before choosing a receipt's receiving configuration.", 401,
      { code: "RECEIVING_ACTOR_REQUIRED" });
    for (const sl of receiptShipmentLines) {
      const poLine = poLineById.get(sl.purchaseOrderLineId);
      receiptPlans.set(sl.id, await resolveReceiptPlan(poLine, sl.qtyShipped, sl, undefined, selections.get(sl.id)));
    }

    // Receipt units come from the selected catalog variant, never carton ratios.
    const receivingLineData = receiptShipmentLines.map((sl: any) => {
      const poLine = poLineById.get(sl.purchaseOrderLineId);
      const productId = parsePositiveInteger(poLine?.productId);
      const plan = receiptPlans.get(sl.id)!;
      const resolvedVariantId = plan.productVariantId;
      const hasPoMills =
        typeof poLine?.unitCostMills === "number" &&
        Number.isInteger(poLine.unitCostMills) &&
        poLine.unitCostMills >= 0;
      const unitCostMills = hasPoMills
        ? (poLine.unitCostMills as number)
        : (typeof poLine?.unitCostCents === "number" && poLine.unitCostCents >= 0
            ? centsToMills(poLine.unitCostCents)
            : null);
      const unitCost = hasPoMills
        ? millsToCents(poLine.unitCostMills as number)
        : (typeof poLine?.unitCostCents === "number" ? poLine.unitCostCents : null);
      return {
        productVariantId: resolvedVariantId,
        productId,
        sku: plan.selectedVariantSku ?? poLine?.sku ?? sl.sku,
        productName: poLine?.productName,
        expectedQty: plan.expectedQty,
        unitsPerVariantSnapshot: plan.unitsPerVariant,
        inboundShipmentLineId: sl.id,
        receivedQty: 0,
        damagedQty: 0,
        purchaseOrderLineId: sl.purchaseOrderLineId,
        unitCost,
        unitCostMills,
        costSourceKind: "purchase_order_line",
        putawayLocationId: null,
        status: "pending",
      };
    });

    if (receivingLineData.length === 0) {
      throw new PurchasingError("Shipment has no receivable lines for this PO.", 400, {
        purchaseOrderId,
        inboundShipmentId,
      });
    }

    const expectedLineCount = receivingLineData.length;
    const expectedTotalUnits = receivingLineData.reduce(
      (sum: number, line: any) => sum + (Number(line.expectedQty) || 0),
      0,
    );

    try {
      return await db.transaction(async (tx: any) => {
      await lockInventoryCostGraph(tx);
        // Shipment line commands and close take this same parent lock first.
        // Preparation above may have raced an edit; compare its raw source
        // snapshot under the lock before writing any receiving records.
        const shipmentLock = await tx.execute(sql`
          SELECT id FROM procurement.inbound_shipments
          WHERE id = ${inboundShipmentId}
          FOR UPDATE
        `);
        if (!shipmentLock.rows?.some((row: any) => Number(row.id) === inboundShipmentId)) {
          throw new PurchasingError("Inbound shipment not found", 404);
        }
        const lockedShipment = await storage.getInboundShipmentById(inboundShipmentId, tx);
        if (!lockedShipment) throw new PurchasingError("Inbound shipment not found", 404);
        const lockedShipmentLines = await storage.getInboundShipmentLines(inboundShipmentId, tx);
        if (shipmentReceiptSourceVersion(lockedShipment, lockedShipmentLines) !== preparedShipmentVersion) {
          throw new PurchasingError(
            "Shipment details changed while the receipt was being prepared. Refresh the shipment, review its current quantities, and create the receipt again.",
            409,
            { code: "SHIPMENT_RECEIPT_SOURCE_CHANGED", inboundShipmentId },
          );
        }
        if (!RECEIVABLE_SHIPMENT_STATUSES.has(lockedShipment.status)) {
          throw new PurchasingError(`Cannot receive a shipment in '${lockedShipment.status}' status`, 409);
        }
        if (typeof tx.execute === "function") {
          await tx.execute(sql`
            SELECT pg_advisory_xact_lock(
              hashtext('procurement.create_receipt_from_shipment'),
              ${inboundShipmentId}
            )
          `);
        }

        const sourceReceiptLineIds = sql.join(receivableShipmentLines.map((line: any) => sql`${line.id}`), sql`, `);
        const sourceReceiptPoLineIds = sql.join([...new Set(receivableShipmentLines.map((line: any) => line.purchaseOrderLineId))].map((id) => sql`${id}`), sql`, `);
        // Lock every receipt the coverage resolver can accept, including a
        // legacy header whose PO is proven by its child line and posting.
        await tx.execute(sql`
          SELECT ro.id FROM procurement.receiving_orders ro
          WHERE (ro.inbound_shipment_id = ${inboundShipmentId} AND (ro.purchase_order_id = ${purchaseOrderId}
            OR EXISTS (SELECT 1 FROM procurement.receiving_lines rl WHERE rl.receiving_order_id = ro.id AND rl.purchase_order_line_id = ANY(ARRAY[${sourceReceiptPoLineIds}]::integer[]))))
            OR EXISTS (SELECT 1 FROM procurement.receiving_lines rl WHERE rl.receiving_order_id = ro.id AND rl.inbound_shipment_line_id = ANY(ARRAY[${sourceReceiptLineIds}]::integer[]))
          ORDER BY ro.id FOR UPDATE OF ro
        `);
        await tx.execute(sql`SELECT id FROM procurement.purchase_orders WHERE id = ${purchaseOrderId} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM procurement.purchase_order_lines WHERE purchase_order_id = ${purchaseOrderId} ORDER BY id FOR UPDATE`);
        const lockedExistingReceipt = await getReceiptForShipmentPo(purchaseOrderId, inboundShipmentId, tx);
        if (lockedExistingReceipt.kind === "active") {
          return { ...lockedExistingReceipt.receipt, reusedExisting: true };
        }
        if (lockedExistingReceipt.kind === "empty_active") {
          throw emptyShipmentReceiptError(lockedExistingReceipt.receipt, purchaseOrderId, inboundShipmentId);
        }
        if (lockedExistingReceipt.kind === "zero_post_closed") {
          throw new PurchasingError(
            "A closed zero-post receipt already exists for this shipment and PO. Void that receipt, then receive the shipment again.",
            409,
            {
              code: "ZERO_POST_SHIPMENT_RECEIPT",
              receivingOrderId: lockedExistingReceipt.receipt.id,
              purchaseOrderId,
              inboundShipmentId,
            },
          );
        }

        const lockedScope = lockedShipmentLines.filter((line: any) => Number(line.purchaseOrderId) === purchaseOrderId && line.qtyShipped > 0 && line.purchaseOrderLineId);
        const lockedReceived = await getShipmentReceiptCoverage(purchaseOrderId, inboundShipmentId, lockedScope, tx);
        const lockedCoverage = summarizeShipmentReceiptCoverage(lockedScope, lockedReceived);
        const coverageVersion = (value: ShipmentReceiptCoverageSummary) => canonicalJson({ ...value, remainingLines: [...value.remainingLines].sort((a, b) => a.id - b.id) });
        if (coverageVersion(lockedCoverage) !== coverageVersion(coverage)) {
          throw new PurchasingError("Receipt coverage changed during preparation. Refresh and review the remaining quantities.", 409, { code: "SHIPMENT_RECEIPT_COVERAGE_CHANGED", inboundShipmentId, purchaseOrderId });
        }
        const lockedPo = await storage.getPurchaseOrderById(purchaseOrderId, tx);
        if (!lockedPo || canonicalJson(lockedPo) !== canonicalJson(po)) {
          throw new PurchasingError("The purchase header changed during receipt preparation. Review the current supplier and destination.", 409, { code: "RECEIVING_PO_SOURCE_CHANGED", purchaseOrderId });
        }
        const lockedPoLines = await storage.getPurchaseOrderLines(purchaseOrderId, tx);
        const sourceLineIds = new Set(receiptShipmentLines.map((line: any) => line.purchaseOrderLineId));
        const sourceVersion = (sourceLines: any[]) => canonicalJson(sourceLines.filter((line: any) => sourceLineIds.has(line.id)).sort((a: any, b: any) => a.id - b.id));
        if (sourceVersion(lockedPoLines) !== sourceVersion(poLines)) {
          throw new PurchasingError("The purchase source changed during receipt preparation. Refresh and review the source.", 409, { code: "RECEIVING_PO_SOURCE_CHANGED", purchaseOrderId });
        }
        const productIdsToLock = [...new Set(receiptShipmentLines.map((line: any) => poLineById.get(line.purchaseOrderLineId).productId))].sort((a: any, b: any) => a - b);
        for (const productId of productIdsToLock) {
          await tx.execute(sql`SELECT id FROM catalog.product_variants WHERE product_id = ${productId} ORDER BY id FOR SHARE`);
        }
        for (const line of receiptShipmentLines) {
          const currentPlan = await resolveReceiptPlan(poLineById.get(line.purchaseOrderLineId), line.qtyShipped, line, tx, selections.get(line.id));
          if (canonicalJson(currentPlan) !== canonicalJson(receiptPlans.get(line.id))) {
            throw new PurchasingError("The catalog receive unit changed during preparation. Review the current receive units.", 409, { code: "RECEIVING_UNIT_SOURCE_CHANGED", shipmentLineId: line.id });
          }
        }

        const receiptCreatedAt = now();
        const receiptNumber = await storage.generateReceiptNumber(tx, receiptCreatedAt);
        const receivingOrder = await storage.createReceivingOrder({
          receiptNumber,
          poNumber: po.poNumber,
          purchaseOrderId: po.id,
          inboundShipmentId,
          sourceType: "shipment",
          vendorId: po.vendorId,
          warehouseId: po.warehouseId,
          status: "draft",
          expectedDate: po.expectedDeliveryDate || po.confirmedDeliveryDate,
          expectedLineCount,
          expectedTotalUnits,
          createdBy: userId,
        }, tx);

        const lockedLocations = await readPrimaryReceivingLocations(tx, po.warehouseId, [...receiptPlans.values()].map((plan) => plan.productVariantId));
        const receivingLinesToCreate = receivingLineData.map((line: any) => ({
          ...line,
          receivingOrderId: receivingOrder.id,
          putawayLocationId: lockedLocations.get(line.productVariantId) ?? null,
        }));
        await storage.bulkCreateReceivingLines(receivingLinesToCreate as any, tx);
        if (selections.size > 0) {
          await insertAuditEventDrizzle(tx, { timestamp: receiptCreatedAt, level: "AUDIT", actor: userId!,
            action: "procurement.shipment_receipt.receiving_configuration_selected", target: `receipt:${receivingOrder.id}`,
            changes: { before: receiptShipmentLines.map((line: any) => ({ shipmentLineId: line.id,
              productVariantId: line.productVariantId ?? poLineById.get(line.purchaseOrderLineId)?.expectedReceiveVariantId ?? null,
              unitsPerVariant: line.unitsPerVariantSnapshot ?? poLineById.get(line.purchaseOrderLineId)?.expectedReceiveUnitsPerVariant ?? null,
              expectedBaseQty: line.qtyShipped })),
              after: receivingLinesToCreate.map((line: any) => ({ shipmentLineId: line.inboundShipmentLineId,
                productVariantId: line.productVariantId, unitsPerVariant: line.unitsPerVariantSnapshot, expectedQty: line.expectedQty,
                expectedBaseQty: line.expectedQty * line.unitsPerVariantSnapshot })) },
            context: { inboundShipmentId, purchaseOrderId, receivingOrderId: receivingOrder.id } });
        }
        return receivingOrder;
      });
    } catch (error: any) {
      if (error?.code === "23505" || error?.cause?.code === "23505") {
        const conflict = await getReceiptForShipmentPo(purchaseOrderId, inboundShipmentId);
        if (conflict.kind === "active") return { ...conflict.receipt, reusedExisting: true };
        if (conflict.kind === "empty_active") {
          throw emptyShipmentReceiptError(conflict.receipt, purchaseOrderId, inboundShipmentId);
        }
        if (conflict.kind === "zero_post_closed") {
          throw new PurchasingError(
            "A closed zero-post receipt already exists for this shipment and PO. Void that receipt, then receive the shipment again.",
            409,
            {
              code: "ZERO_POST_SHIPMENT_RECEIPT",
              receivingOrderId: conflict.receipt.id,
              purchaseOrderId,
              inboundShipmentId,
            },
          );
        }
        if (conflict.kind === "closed") {
          throw new PurchasingError(
            "This shipment has already been received for this PO.",
            409,
            { receivingOrderId: conflict.receipt.id, purchaseOrderId, inboundShipmentId },
          );
        }
        throw new PurchasingError("Shipment receipt creation conflicted with another active receipt", 409, {
          purchaseOrderId,
          inboundShipmentId,
        });
      }
      throw error;
    }
  }

  /**
   * Called by ReceivingService when a receiving order linked to a PO is closed.
   * Updates PO line received quantities and auto-transitions PO status.
   */
  /**
   * Find an open product PO line on the given PO that matches a product ID.
   * Returns the single matching line, or null if there are zero or multiple
   * matches (ambiguous — caller should leave unlinked and warn).
   *
   * "Open" means the line is not cancelled/received/closed and has remaining
   * quantity (orderQty > receivedQty + cancelledQty).
   */
  async function findOpenPoLineByProduct(
    poId: number,
    productId: number,
  ): Promise<any | null> {
    return findOpenPoLineByProductWithStorage(storage, poId, productId);
  }

  async function onReceivingOrderClosed(
    receivingOrderId: number,
    receivingLines: ReceivingReconciliationLine[],
    userId?: string | null,
  ) {
    const result = await db.transaction((tx: any) => onReceivingOrderClosedInTransaction(
      receivingOrderId, receivingLines, userId, tx, now()));
    await afterReceivingOrderClosed(result);
    return result;
  }

  // The physical receiving owner supplies its transaction so PO counters,
  // original receipt evidence, inventory and the close share one commit.
  async function onReceivingOrderClosedInTransaction(
    receivingOrderId: number,
    receivingLines: ReceivingReconciliationLine[],
    userId: string | null | undefined,
    tx: ReceivingIntegrityTransaction,
    recordedAt: Date,
  ): Promise<ReceiptReconciliationResult> {
      await lockInventoryCostGraph(tx);
      const receivingOrder = await storage.getReceivingOrderById(receivingOrderId, tx);
      let purchaseOrderId = parsePositiveInteger(receivingOrder?.purchaseOrderId);
      if (!purchaseOrderId) {
        const linkedLineId = receivingLines
          .map((line) => parsePositiveInteger(line.purchaseOrderLineId))
          .find((lineId): lineId is number => lineId !== null);
        if (linkedLineId) {
          const linkedPoLine = await storage.getPurchaseOrderLineById(linkedLineId, tx);
          purchaseOrderId = parsePositiveInteger(linkedPoLine?.purchaseOrderId);
        }
      }
      if (purchaseOrderId && typeof tx.execute === "function") {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtext('procurement.reconcile_po_receipt'),
            ${purchaseOrderId}
          )
        `);
        await tx.execute(sql`
          SELECT id
          FROM procurement.purchase_orders
          WHERE id = ${purchaseOrderId}
          FOR UPDATE
        `);
      }

      const reconciliation = await reconcilePurchaseOrderReceipt({
        storage,
        receivingOrderId,
        receivingLines,
        recalculateTotals: async (poId, executor) => {
          await recalculateTotals(poId, userId ?? undefined, executor);
        },
        executor: tx,
        changedBy: userId ?? undefined,
        now: () => recordedAt,
      });

      const expectedReceiptLines = receivingLines.filter(
        (line) => (Number(line.receivedQty) || 0) > 0 || (Number(line.damagedQty) || 0) > 0,
      ).length;
      const reconciledLines = reconciliation.appliedLines + reconciliation.existingReceiptLines;
      if (
        reconciliation.skippedLines > 0 ||
        reconciliation.issues.length > 0 ||
        reconciledLines < expectedReceiptLines
      ) {
        throw new PurchasingError("PO receipt reconciliation is incomplete", 409, {
          receivingOrderId,
          purchaseOrderId: reconciliation.purchaseOrderId,
          expectedReceiptLines,
          reconciledLines,
          reconciliation,
        });
      }

      return reconciliation;
  }

  async function afterReceivingOrderClosed(result: ReceiptReconciliationResult): Promise<void> {
    if (result.purchaseOrderId && result.poStatusUpdate?.legacyStatus === "received") {
      try {
        await detectQtyVariance(result.purchaseOrderId);
      } catch (error) {
        logger.error("procurement.purchasing_receiving", { message: "[po-exceptions] qty variance detection failed after receiving close:", error: error });
      }
    }
  }

  return {
    createReceiptFromPO,
    createReceiptFromShipment,
    getShipmentReceiptPackResolution,
    getPurchaseOrderReceiveOptions,
    getShipmentPoReceiveOptions,
    findOpenPoLineByProduct,
    onReceivingOrderClosed,
    onReceivingOrderClosedInTransaction,
    afterReceivingOrderClosed,
  };
}

export type PurchasingReceiving = ReturnType<typeof createPurchasingReceiving>;
