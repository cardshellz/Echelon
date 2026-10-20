import { sql } from "drizzle-orm";
import { z } from "zod";
import { Decimal } from "decimal.js";
import {
  quantityCorrectionId,
  quantityCorrectionInputSchema,
  quantityCorrectionApprovalSchema,
  quantityCorrectionContextSchema,
  quantityCorrectionOptionsSchema,
  quantityCorrectionPreviewSchema,
  quantityCorrectionSummarySchema,
  shipmentQuantityEditInputSchema,
  shipmentQuantityEditApprovalSchema,
  type QuantityCorrectionPurpose,
  type QuantityCorrectionInput,
  type QuantityCorrectionSummary,
} from "@shared/procurement/receipt-shipment-quantity-correction";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import {
  FinancialCommandError,
  runTransactionalFinancialCommand,
  type FinancialCommandDescriptor,
} from "../../platform/commands/transactional-command.service";
import { readPurchaseApproverName } from "../identity/infrastructure/purchase-approval-access.repository";
import { COGSService } from "../inventory/cogs.service";
import { applyCostRevision } from "../inventory/application/apply-cost-revision";
import {
  costFingerprint,
  costInteger,
  CostEvidenceError,
} from "../inventory/infrastructure/cost-evidence.repository";
import {
  hasReconciliationRoots,
  readReconciliationLedger,
  readReconciliationRecords,
  recordReconciliationApproval,
} from "../inventory/infrastructure/cost-reconciliation.repository";
import {
  reconciliationBlocker,
  reconciliationEligibility,
  reconciliationState,
} from "../inventory/domain/cost-reconciliation";
import { hasQuantityAmendmentAuthority } from "./po-quantity-amendment.policy";
import {
  QuantityCorrectionError,
  correctionInteger as integer,
  planQuantityCorrection,
} from "./domain/receipt-shipment-quantity-correction";
import {
  readQuantityCorrectionSource,
  resolveReceiptShipmentLine,
  readQuantityCorrectionOptions,
  persistQuantityCorrection,
  recordQuantityCorrectionResult,
  type QuantityCorrectionSource,
} from "./receipt-shipment-quantity-correction.repository";
import { reconcilePurchaseCostEvidence } from "./purchase-cost-application.service";
import { recomputePurchaseOrderInvoiceMatchesInTransaction } from "./ap-ledger.service";
import { replacePurchaseOrderMatchExceptions } from "./purchase-order-match-exceptions.repository";
import { recordShipmentCostRevisions } from "./shipment-cost-application.service";
import {
  ShipmentTrackingError,
  type ShipmentTrackingService,
} from "./shipment-tracking.service";
import type {
  AmendmentDatabase,
  AmendmentTransaction,
} from "./po-quantity-amendment.repository";
import { computeShipmentLinePhysicalTotals } from "./shipment-line-physical-values";
import { assertReceivingQuarantineLineEditable } from "./receiving-quarantine.repository";
import { ReceivingQuarantineError } from "./domain/receiving-quarantine";

export function quantityCorrectionScope(
  lineId: number,
  purpose: QuantityCorrectionPurpose = "receipt",
) {
  quantityCorrectionId.parse(lineId);
  return {
    method: "POST",
    routeTemplate:
      purpose === "shipment"
        ? "/api/shipment-lines/:id/shipment-edit"
        : "/api/shipment-lines/:id/quantity-correction",
    resourceKey: `shipment_line:${lineId}`,
    commandName:
      purpose === "shipment"
        ? "procurement.shipment.quantity_edit"
        : "procurement.receipt_shipment.quantity_correct",
  };
}
function context(source: QuantityCorrectionSource) {
  const { shipment, shipmentLines, po, poLines } = source.evidence;
  const line = shipmentLines.find(
    (row) => row.id === source.facts.shipmentLineId,
  )!;
  const poLine = poLines.find((row) => row.id === line.purchase_order_line_id)!;
  const canApprove = hasQuantityAmendmentAuthority(source.actor);
  return quantityCorrectionContextSchema.parse({
    shipmentLineId: line.id,
    shipmentId: shipment.id,
    shipmentNumber: shipment.shipment_number,
    shipmentStatus: shipment.status,
    sku: String(line.sku ?? poLine.sku ?? ""),
    productName: String(line.product_name ?? poLine.product_name ?? ""),
    purchaseOrderId: po.id,
    purchaseOrderNumber: po.po_number,
    orderedPieces: source.facts.orderPieces,
    shippedPieces: source.facts.shippedPieces,
    receipts: source.facts.receipts.map((receipt) => ({
      receiptId: receipt.receiptId,
      receiptNumber: receipt.receiptNumber,
      receiptLineId: receipt.id,
      receivedUnits: receipt.receivedUnits,
      receivedPieces: receipt.receivedPieces,
      piecesPerUnit: receipt.piecesPerUnit,
      unitWasRecorded: receipt.unitWasRecorded,
    })),
    pendingReceipts: source.facts.pendingReceipts ?? [],
    receivingLinks: [
      ...new Map(
        source.evidence.receiptRows.map((row) => [
          row.receiving_order_id,
          {
            receiptId: integer(row.receiving_order_id, "receipt", 1),
            receiptNumber: String(row.receipt_number),
          },
        ]),
      ).values(),
    ],
    sourceVersion: source.sourceVersion,
    canApprove,
    blockedReason: canApprove
      ? source.blockedReason
      : "An active Administrator with purchasing approval permission must approve this correction.",
    history: source.history,
  });
}
function assertReview(source: QuantityCorrectionSource, version: string) {
  const current = context(source);
  if (!current.canApprove)
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_ADMIN",
      current.blockedReason!,
      403,
    );
  if (source.sourceVersion !== version)
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_STALE",
      "The receipt, shipment or costs changed. Reload and review a fresh before and after.",
    );
  if (current.blockedReason)
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_BLOCKED",
      current.blockedReason,
    );
}
function sumMoney(
  rows: Record<string, unknown>[],
  select: (row: Record<string, unknown>) => unknown,
): number {
  return costInteger(
    rows
      .reduce(
        (sum, row) =>
          sum +
          BigInt(
            costInteger(select(row), "charge amount", -Number.MAX_SAFE_INTEGER),
          ),
        BigInt(0),
      )
      .toString(),
    "charge total",
    -Number.MAX_SAFE_INTEGER,
  );
}
function unitCharge(cents: number, pieces: number): string {
  return new Decimal(String(cents)).div(100).div(pieces).toFixed(6);
}
async function reviewHistoricalCost(
  tx: AmendmentTransaction,
  source: QuantityCorrectionSource,
  input: QuantityCorrectionInput,
  actorId: string,
  actorName: string,
  now: Date,
  writer: COGSService,
  before: Awaited<ReturnType<typeof readReconciliationLedger>>,
) {
  const shipmentId = integer(source.evidence.shipment.id, "shipment", 1);
  const lineId = source.facts.shipmentLineId;
  const beforeMills = costInteger(
    (
      BigInt(before.balances.historical_cogs) +
      BigInt(before.balances.inventory_variance)
    ).toString(),
    "historical cost",
  );
  const unchanged = {
    eligible: false,
    requiresDecision: false,
    blockedReason: null as string | null,
    beforeMills,
    afterMills: beforeMills,
    destination: before.approval?.destination ?? null,
  };
  // Open shipments have a new allocation, not a finalized cost revision. Never
  // post an old snapshot while presenting it as the corrected cost.
  if (!["costing", "closed"].includes(String(source.evidence.shipment.status)))
    return {
      historical: unchanged,
      application: null,
      initialApplicationId: null,
    };
  const recorded = await recordShipmentCostRevisions(
    tx,
    shipmentId,
    actorId,
    now,
    { inboundShipmentLineId: lineId },
  );
  const revision = recorded.revisions[0];
  if (!revision)
    return {
      historical: unchanged,
      application: null,
      initialApplicationId: null,
    };
  let application = await applyCostRevision(tx, revision, writer, actorId, now);
  const initialApplicationId = application.applicationId;
  const records = await readReconciliationRecords(
    tx,
    revision.contract,
    application.issues,
  );
  const eligible = reconciliationEligibility(
    revision.contract,
    application.issues,
    records,
  );
  const blocker = application.issues.length
    ? reconciliationBlocker(
        revision.contract,
        application.issues,
        records,
        await hasReconciliationRoots(tx, revision.contract),
      )
    : null;
  const destination =
    input.historicalCostDestination ??
    (beforeMills > 0 ? before.approval?.destination : null);
  if (eligible && !blocker && destination) {
    // This explicit approval belongs only to the selected shipment line. Other
    // lines and supplier cost evidence cannot be swept into its disposition.
    await recordReconciliationApproval(tx, {
      lineId,
      revisionId: revision.id,
      applicationId: application.applicationId,
      fingerprint: eligible.identity,
      destination,
      actorId,
      actorName,
      reason: input.reason,
      now,
      evidence: {
        kind: "receipt_shipment_quantity_correction",
        sourceVersion: source.sourceVersion,
        authority: source.actor,
        input,
        records,
        source: revision.contract,
      },
    });
    application = await applyCostRevision(tx, revision, writer, actorId, now);
  }
  const after = await readReconciliationLedger(tx, lineId);
  const state = reconciliationState(eligible, after);
  const posted = eligible !== null && state.status === "posted";
  return {
    historical: {
      eligible: eligible !== null && blocker === null,
      requiresDecision: eligible !== null && blocker === null && !posted,
      blockedReason: blocker,
      beforeMills,
      afterMills: costInteger(
        (
          BigInt(after.balances.historical_cogs) +
          BigInt(after.balances.inventory_variance)
        ).toString(),
        "historical cost",
      ),
      destination: after.approval?.destination ?? null,
    },
    application: posted
      ? { ...application, status: "applied" as const, issues: [] }
      : application,
    initialApplicationId,
  };
}

/** The preview executes the same owners in a savepoint and rolls them back.
 * The approval repeats this under source locks and compares the complete impact. */
async function executeCorrection(
  tx: AmendmentTransaction,
  source: QuantityCorrectionSource,
  input: QuantityCorrectionInput,
  actorId: string,
  actorName: string,
  now: Date,
  shipments: Pick<
    ShipmentTrackingService,
    "updateCostsInTransaction" | "refreshQuantityAllocationInTransaction"
  >,
  purpose: QuantityCorrectionPurpose,
) {
  const plan = planQuantityCorrection(source.facts, input, purpose);
  for (const receipt of plan.pendingReceipts) {
    if (receipt.expectedUnits === receipt.afterExpectedUnits) continue;
    try {
      await assertReceivingQuarantineLineEditable(tx, receipt.receiptLineId, [
        "expectedQty",
      ]);
    } catch (error) {
      if (error instanceof ReceivingQuarantineError)
        throw new QuantityCorrectionError(
          error.code,
          `${receipt.receiptNumber}: ${error.message}`,
          error.statusCode,
        );
      throw error;
    }
  }
  const target = source.evidence.shipmentLines.find(
    (line) => line.id === source.facts.shipmentLineId,
  )!;
  // Pieces change physical totals only when measurements were recorded per piece.
  // Carton measurements describe the same cartons after a piece-count correction.
  const pieceDimensions =
    target.dimension_basis === "piece" ||
    (target.dimension_basis == null && target.carton_count == null);
  const physicalTotals = pieceDimensions
    ? computeShipmentLinePhysicalTotals({
        qtyShipped: plan.shippedPieces,
        cartonCount:
          target.carton_count == null
            ? null
            : integer(target.carton_count, "cartons"),
        dimensionBasis: "piece",
        weightKg: target.weight_kg == null ? null : String(target.weight_kg),
        lengthCm: target.length_cm == null ? null : String(target.length_cm),
        widthCm: target.width_cm == null ? null : String(target.width_cm),
        heightCm: target.height_cm == null ? null : String(target.height_cm),
      })
    : undefined;
  const originalLedger = await readReconciliationLedger(
    tx,
    source.facts.shipmentLineId,
  );
  const amendmentId = await persistQuantityCorrection(
    tx,
    source,
    plan,
    input,
    actorId,
    actorName,
    now,
    purpose,
    physicalTotals,
  );
  const writer = new COGSService(tx);
  const poLineId = integer(target.purchase_order_line_id, "PO line", 1);
  const shipmentId = integer(source.evidence.shipment.id, "shipment", 1);
  const costResults: QuantityCorrectionSummary["costResults"] = [];
  const appliedResults = new Map<
    number,
    QuantityCorrectionSummary["costResults"][number]
  >();
  const purchase = await reconcilePurchaseCostEvidence(
    tx,
    poLineId,
    writer,
    actorId,
    now,
  );
  purchase.costApplications.forEach((application, index) =>
    costResults.push({
      component: purchase.costSources[index].contract.component,
      shipmentId: null,
      status: application.status,
      lotsUpdated: application.replayed ? 0 : application.lotsUpdated,
      orderCostsUpdated: application.replayed ? 0 : application.cogsRowsUpdated,
      orderCostDeltaCents: application.replayed
        ? 0
        : application.totalCogsDeltaCents,
      issues: application.issues,
    }),
  );
  const shipmentIds = new Set([shipmentId]);
  // Purchase interval shifts were handled by the supplier-cost owner above.
  // Only changed shipment intervals or unit meanings affect another shipment.
  for (const origin of plan.origins) {
    const before = source.facts.origins.find(
      (row) => row.inventoryLotId === origin.inventoryLotId,
    )!;
    if (
      (before.piecesPerUnit === origin.piecesPerUnit &&
        before.shipmentStart === origin.shipmentStart) ||
      origin.shipmentLineId === null
    )
      continue;
    const related = source.evidence.relatedLines.find(
      (line) => line.id === origin.shipmentLineId,
    );
    if (related)
      shipmentIds.add(
        integer(related.inbound_shipment_id, "related shipment", 1),
      );
  }
  for (const id of [...shipmentIds].sort((a, b) => a - b)) {
    const updated = await shipments.refreshQuantityAllocationInTransaction(
      tx,
      id,
      actorId,
      now,
    );
    for (const application of updated.costApplications) {
      const result: QuantityCorrectionSummary["costResults"][number] = {
        component: "landed",
        shipmentId: id,
        status: application.status,
        lotsUpdated: application.replayed ? 0 : application.lotsUpdated,
        orderCostsUpdated: application.replayed
          ? 0
          : application.cogsRowsUpdated,
        orderCostDeltaCents: application.replayed
          ? 0
          : application.totalCogsDeltaCents,
        issues: application.issues,
      };
      costResults.push(result);
      appliedResults.set(application.applicationId, result);
    }
    if (updated.costApplications.length === 0)
      costResults.push({
        component: "landed",
        shipmentId: id,
        status: "review_required",
        lotsUpdated: 0,
        orderCostsUpdated: 0,
        orderCostDeltaCents: 0,
        issues: [
          {
            code: "SHIPMENT_COST_FINALIZATION_PENDING",
            message:
              "Quantities and charge allocations are updated. Finish shipment costing to post its inventory costs.",
          },
        ],
      });
  }
  const historical = await reviewHistoricalCost(
    tx,
    source,
    input,
    actorId,
    actorName,
    now,
    writer,
    originalLedger,
  );
  if (historical.application?.status === "applied") {
    const result = appliedResults.get(historical.initialApplicationId!);
    if (result) {
      result.status = "applied";
      result.issues = [];
    }
  }
  const poId = integer(source.evidence.po.id, "PO", 1);
  const match = await recomputePurchaseOrderInvoiceMatchesInTransaction(
    poId,
    tx,
    actorId,
    now,
  );
  await replacePurchaseOrderMatchExceptions({
    tx,
    purchaseOrderId: poId,
    exceptions: source.evidence.exceptions,
    match,
    actorId,
    at: now,
    supersessionNote:
      purpose === "shipment"
        ? "Superseded by an approved shipment edit."
        : "Superseded by an approved receipt and shipment quantity correction.",
    messagePrefix:
      purpose === "shipment"
        ? "Corrected shipment quantities"
        : "Corrected receipt and shipment quantities",
  });
  const afterLine = (
    await tx.execute(
      sql`SELECT allocated_cost_cents FROM procurement.inbound_shipment_lines WHERE id=${source.facts.shipmentLineId}`,
    )
  ).rows[0];
  const beforeCharge = sumMoney(
    source.evidence.costs,
    (row) => row.actual_cents ?? row.estimated_cents ?? 0,
  );
  const currentCharges = (
    await tx.execute(
      sql`SELECT * FROM procurement.inbound_freight_costs WHERE inbound_shipment_id=${shipmentId} ORDER BY id`,
    )
  ).rows;
  const afterCharge = sumMoney(
    currentCharges,
    (row) => row.actual_cents ?? row.estimated_cents ?? 0,
  );
  if (beforeCharge !== afterCharge)
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_CHARGE_CHANGED",
      "The supplier charge changed during correction. Nothing was saved.",
    );
  const allocatedBefore = costInteger(
    target.allocated_cost_cents ?? 0,
    "allocated charge",
    -Number.MAX_SAFE_INTEGER,
  );
  const allocatedAfter = costInteger(
    afterLine.allocated_cost_cents ?? 0,
    "allocated charge",
    -Number.MAX_SAFE_INTEGER,
  );
  const oldSnapshot = source.evidence.snapshots.find(
    (row) => row.inbound_shipment_line_id === source.facts.shipmentLineId,
  );
  const newSnapshot = (
    await tx.execute(
      sql`SELECT total_landed_cost_cents FROM procurement.landed_cost_snapshots WHERE inbound_shipment_line_id=${source.facts.shipmentLineId}`,
    )
  ).rows[0];
  const landedBefore =
    oldSnapshot?.total_landed_cost_cents == null
      ? null
      : costInteger(oldSnapshot.total_landed_cost_cents, "landed total");
  const landedAfter =
    !["costing", "closed"].includes(String(source.evidence.shipment.status)) ||
    newSnapshot?.total_landed_cost_cents == null
      ? null
      : costInteger(newSnapshot.total_landed_cost_cents, "landed total");
  const summary = quantityCorrectionSummarySchema.parse({
    purpose,
    pendingReceipts: plan.pendingReceipts,
    physicalTotals: {
      netWeightKg: {
        before:
          target.total_weight_kg == null
            ? null
            : String(target.total_weight_kg),
        after:
          physicalTotals?.totalWeightKg ??
          (target.total_weight_kg == null
            ? null
            : String(target.total_weight_kg)),
      },
      volumeCbm: {
        before:
          target.total_volume_cbm == null
            ? null
            : String(target.total_volume_cbm),
        after:
          physicalTotals?.totalVolumeCbm ??
          (target.total_volume_cbm == null
            ? null
            : String(target.total_volume_cbm)),
      },
    },
    shipmentPieces: {
      before: source.facts.shippedPieces,
      after: plan.shippedPieces,
    },
    receipts: plan.receipts.map((receipt) => ({
      receiptId: receipt.receiptId,
      receiptNumber: receipt.receiptNumber,
      receiptLineId: receipt.id,
      receivedUnits: receipt.receivedUnits,
      receivedPieces: receipt.receivedPieces,
      piecesPerUnit: receipt.piecesPerUnit,
      unitWasRecorded: receipt.unitWasRecorded,
      afterPieces: receipt.afterPieces,
      afterPiecesPerUnit: receipt.afterPiecesPerUnit,
    })),
    poReceivedPieces: {
      before: source.facts.poReceivedPieces,
      after: plan.poReceivedPieces,
    },
    poRemainingPieces: {
      before: Math.max(
        0,
        source.facts.orderPieces -
          source.facts.cancelledPieces -
          source.facts.poReceivedPieces,
      ),
      after: Math.max(
        0,
        source.facts.orderPieces -
          source.facts.cancelledPieces -
          plan.poReceivedPieces,
      ),
    },
    shipmentChargeCents: { before: beforeCharge, after: afterCharge },
    allocatedChargeCents: { before: allocatedBefore, after: allocatedAfter },
    chargePerPiece: {
      before: unitCharge(allocatedBefore, source.facts.shippedPieces),
      after: unitCharge(allocatedAfter, plan.shippedPieces),
    },
    landedCostCents: { before: landedBefore, after: landedAfter },
    landedCostPerPiece: {
      before:
        landedBefore === null
          ? null
          : unitCharge(landedBefore, source.facts.shippedPieces),
      after:
        landedAfter === null
          ? null
          : unitCharge(landedAfter, plan.shippedPieces),
    },
    stockUnitChange: 0,
    costResults,
    historicalCost: historical.historical,
  });
  await recordQuantityCorrectionResult(
    tx,
    source,
    amendmentId,
    summary,
    actorId,
    now,
  );
  return summary;
}
export function createReceiptShipmentQuantityCorrectionService(
  database: AmendmentDatabase,
  shipments: Pick<
    ShipmentTrackingService,
    "updateCostsInTransaction" | "refreshQuantityAllocationInTransaction"
  >,
  clock: () => Date,
  purpose: QuantityCorrectionPurpose = "receipt",
) {
  const repository = createDrizzleFinancialCommandRepository(database);
  const readSource = (tx: AmendmentTransaction, id: number, actorId: string) =>
    readQuantityCorrectionSource(tx, id, actorId, purpose);
  const preserveReceipts = (
    input: Omit<QuantityCorrectionInput, "receipts"> & {
      receipts?: QuantityCorrectionInput["receipts"];
    },
    source: QuantityCorrectionSource,
  ): QuantityCorrectionInput => ({
    ...input,
    receipts:
      purpose === "shipment"
        ? source.facts.receipts.map((row) => ({
            receiptLineId: row.id,
            receivedPieces: row.receivedPieces,
          }))
        : input.receipts!,
  });
  return {
    context: (id: number, actorId: string) =>
      database.transaction(async (tx) =>
        context(await readSource(tx, quantityCorrectionId.parse(id), actorId)),
      ),
    receiptContext: (id: number, actorId: string) =>
      database.transaction(async (tx) =>
        context(
          await readSource(
            tx,
            await resolveReceiptShipmentLine(
              tx,
              quantityCorrectionId.parse(id),
            ),
            actorId,
          ),
        ),
      ),
    options: (id: number) =>
      database.transaction(async (tx) =>
        quantityCorrectionOptionsSchema.parse(
          await readQuantityCorrectionOptions(
            tx,
            quantityCorrectionId.parse(id),
          ),
        ),
      ),
    async preview(id: number, raw: unknown, actorId: string) {
      const request = (
        purpose === "shipment"
          ? shipmentQuantityEditInputSchema
          : quantityCorrectionInputSchema
      ).parse(raw);
      return database.transaction(async (tx) => {
        const source = await readSource(
          tx,
          quantityCorrectionId.parse(id),
          actorId,
        );
        const input = preserveReceipts(request, source);
        assertReview(source, input.sourceVersion);
        await tx.execute(sql`SAVEPOINT receipt_quantity_preview`);
        try {
          const summary = await executeCorrection(
            tx,
            source,
            input,
            actorId,
            await readPurchaseApproverName(tx, actorId),
            z.date().parse(clock()),
            shipments,
            purpose,
          );
          return quantityCorrectionPreviewSchema.parse({
            sourceVersion: input.sourceVersion,
            summary,
            previewVersion: costFingerprint({ input, summary }),
          });
        } finally {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT receipt_quantity_preview`);
          await tx.execute(sql`RELEASE SAVEPOINT receipt_quantity_preview`);
        }
      });
    },
    async approve(
      id: number,
      raw: unknown,
      actorId: string,
      descriptor: FinancialCommandDescriptor,
    ) {
      const lineId = quantityCorrectionId.parse(id),
        input = (
          purpose === "shipment"
            ? shipmentQuantityEditApprovalSchema
            : quantityCorrectionApprovalSchema
        ).parse(raw),
        scope = quantityCorrectionScope(lineId, purpose);
      if (
        descriptor.actorId !== actorId ||
        descriptor.actorType !== "user" ||
        Object.entries(scope).some(
          ([key, value]) =>
            descriptor[key as keyof FinancialCommandDescriptor] !== value,
        )
      )
        throw new FinancialCommandError(
          "The approval does not match this administrator and shipment.",
          403,
          "QUANTITY_CORRECTION_SCOPE",
        );
      return runTransactionalFinancialCommand({
        repository,
        descriptor,
        classifyFailure(error) {
          if (
            error instanceof QuantityCorrectionError ||
            error instanceof CostEvidenceError ||
            error instanceof ShipmentTrackingError
          )
            return {
              kind: "rejected",
              httpStatus:
                error instanceof CostEvidenceError ? 409 : error.statusCode,
              errorCode:
                error instanceof ShipmentTrackingError
                  ? String(error.details?.code ?? "QUANTITY_CORRECTION_COST")
                  : error.code,
              errorMessage: error.message,
              body: {
                error: error.message,
                code:
                  error instanceof ShipmentTrackingError
                    ? "QUANTITY_CORRECTION_COST"
                    : error.code,
              },
            };
          return {
            kind: "retryable",
            errorCode: "QUANTITY_CORRECTION_RETRY",
            errorMessage:
              "The correction was not confirmed. Retry the same approval.",
          };
        },
        work: async (tx) => {
          const source = await readSource(tx, lineId, actorId);
          assertReview(source, input.sourceVersion);
          const { previewVersion, ...request } = input;
          const review = preserveReceipts(request, source);
          const summary = await executeCorrection(
            tx,
            source,
            review,
            actorId,
            await readPurchaseApproverName(tx, actorId),
            z.date().parse(clock()),
            shipments,
            purpose,
          );
          if (summary.historicalCost.requiresDecision)
            throw new QuantityCorrectionError(
              "QUANTITY_CORRECTION_DESTINATION_REQUIRED",
              "Choose where the historical cost belongs and review its impact before approving.",
            );
          if (costFingerprint({ input: review, summary }) !== previewVersion)
            throw new QuantityCorrectionError(
              "QUANTITY_CORRECTION_PREVIEW_CHANGED",
              "The cost impact changed. Review a fresh before and after; nothing was saved.",
            );
          return {
            httpStatus: 200,
            resultType: "shipment_line",
            resultId: lineId,
            body: context(await readSource(tx, lineId, actorId)),
          };
        },
      });
    },
  };
}
