import { sql } from "drizzle-orm";
import {
  costLinkRepairSummarySchema,
  type CostLinkRepairSummary,
} from "@shared/procurement/cost-link-repair";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  costInteger,
  CostEvidenceError,
  recordReceiptCostOrigin,
  recordLotCostContribution,
  type CostEvidenceTransaction,
} from "../inventory/infrastructure/cost-evidence.repository";
import { restoreHistoricalCostAllocation } from "../inventory/infrastructure/cost-quantity.repository";
import { proposeCostLinks } from "./domain/cost-link-repair";
import {
  costLinkLotSnapshot,
  readCostLinkHistory,
  readCostLinkLotSnapshot,
} from "./cost-link-repair.repository";
import type { QuantityCorrectionSource } from "./receipt-shipment-quantity-correction.repository";
import type { QuantityCorrectionPlan } from "./domain/receipt-shipment-quantity-correction";

export async function prepareCostLinkRepair(
  tx: CostEvidenceTransaction,
  source: QuantityCorrectionSource,
  plan: QuantityCorrectionPlan,
) {
  const history = await readCostLinkHistory(tx, source, plan);
  const proposal = proposeCostLinks(history.history, history.roots);
  const missing = history.roots.filter(
    (root) => !history.history.originLotIds.includes(root.lotId),
  );
  if (!missing.length && !proposal.operations.length)
    throw new CostEvidenceError(
      "COST_LINK_NO_CHANGE",
      "No supported missing transfer or repacking links were found. Existing links need no further approval.",
    );
  return {
    ...history,
    proposal,
    missing,
    before: costLinkLotSnapshot(history.lots, history.orders, proposal.lotIds),
  };
}
type Prepared = Awaited<ReturnType<typeof prepareCostLinkRepair>>;

/** Called inside the quantity command's one transaction, AFTER its receipt unit
 * correction and BEFORE the normal supplier/freight costing owners. This owner
 * restores lineage only; it never books an expense or performs a stock movement. */
export async function restoreCostLinks(
  tx: CostEvidenceTransaction,
  prepared: Prepared,
  source: QuantityCorrectionSource,
  plan: QuantityCorrectionPlan,
  actorId: string,
  now: Date,
) {
  const shipmentLine = source.evidence.shipmentLines.find(
    (row) => row.id === source.facts.shipmentLineId,
  )!;
  for (const receipt of plan.receipts) {
    await tx.execute(sql`UPDATE procurement.receiving_lines SET cost_source_evidence=
      COALESCE(cost_source_evidence,'{}'::jsonb) || ${canonicalJson({ historicalCostLinks: { verifiedSalesOnly: true, evidenceVersion: prepared.evidenceVersion, actorId, recordedAt: now.toISOString() } })}::jsonb
      WHERE id=${receipt.id}`);
  }
  for (const root of prepared.missing) {
    const receipt = plan.receipts.find((row) => row.id === root.receiptLineId)!;
    const saved = source.evidence.receiptRows.find(
      (row) => row.id === receipt.id,
    )!;
    if (
      saved.cost_source_kind != null &&
      saved.cost_source_kind !== "purchase_order_line"
    )
      throw new CostEvidenceError(
        "COST_LINK_SOURCE_CONFLICT",
        "This receipt has a different recorded cost authority.",
      );
    await tx.execute(sql`UPDATE procurement.receiving_lines SET cost_source_kind='purchase_order_line',
      cost_source_evidence=cost_source_evidence || ${canonicalJson({ kind: "administrator_cost_link_repair", evidenceVersion: prepared.evidenceVersion, actorId, recordedAt: now.toISOString() })}::jsonb
      WHERE id=${receipt.id}`);
    await recordReceiptCostOrigin(
      tx,
      {
        inventoryLotId: root.lotId,
        receivingLineId: receipt.id,
        purchaseOrderLineId: costInteger(
          shipmentLine.purchase_order_line_id,
          "PO line",
          1,
        ),
        inboundShipmentLineId: source.facts.shipmentLineId,
        unitsPerVariantSnapshot: receipt.afterPiecesPerUnit,
        receivedVariantQty: receipt.receivedUnits,
      },
      actorId,
      now,
    );
  }
  for (const operation of prepared.proposal.operations) {
    const allocationId = await restoreHistoricalCostAllocation(
      tx,
      operation.sourceLotId,
      operation.sourceUnits,
      operation.key,
      {
        sourceKind: "approved_historical_operation",
        operationKey: operation.key,
        movementIds: operation.movementIds,
        evidenceVersion: prepared.evidenceVersion,
      },
      actorId,
      now,
    );
    const outputQty = costInteger(
      operation.outputs
        .reduce((sum, row) => sum + BigInt(row.units), BigInt(0))
        .toString(),
      "output units",
      1,
    );
    let outputStartQty = 0;
    for (const output of operation.outputs) {
      await recordLotCostContribution(
        tx,
        {
          sourceLotId: operation.sourceLotId,
          outputLotId: output.lotId,
          sourceQty: operation.sourceUnits,
          outputQty,
          outputStartQty,
          costQuantityAllocationId: allocationId,
          operationKey: operation.key,
          operationKind: operation.kind,
        },
        actorId,
        now,
      );
      outputStartQty += output.units;
    }
  }
}

export async function summarizeCostLinkRepair(
  tx: CostEvidenceTransaction,
  prepared: Prepared,
  remainingIssues: string[] = [],
): Promise<CostLinkRepairSummary> {
  const after = await readCostLinkLotSnapshot(tx, prepared.proposal.lotIds);
  return costLinkRepairSummarySchema.parse({
    evidenceVersion: prepared.evidenceVersion,
    originsRestored: prepared.missing.map((root) => {
      const lot = prepared.history.lots.find((row) => row.id === root.lotId)!;
      return { ...root, lotNumber: lot.number, receivedUnits: lot.received };
    }),
    operations: prepared.proposal.operations,
    lots: prepared.before.map((before) => {
      const next = after.find((row) => row.lotId === before.lotId);
      if (
        !next ||
        next.onHandUnits !== before.onHandUnits ||
        next.linkedOrderRows !== before.linkedOrderRows
      )
        throw new CostEvidenceError(
          "COST_LINK_PHYSICAL_CHANGED",
          "The repair unexpectedly changed stock or order records. Nothing was saved.",
        );
      return {
        lotId: before.lotId,
        lotNumber: before.lotNumber,
        sku: before.sku,
        onHandUnits: before.onHandUnits,
        linkedOrderRows: before.linkedOrderRows,
        productMills: { before: before.productMills, after: next.productMills },
        packagingMills: {
          before: before.packagingMills,
          after: next.packagingMills,
        },
        shipmentMills: {
          before: before.shipmentMills,
          after: next.shipmentMills,
        },
        orderCostCents: {
          before: before.orderCostCents,
          after: next.orderCostCents,
        },
      };
    }),
    remainingIssues: [
      ...new Set([...prepared.proposal.remainingIssues, ...remainingIssues]),
    ],
    stockUnitChange: 0,
    newExpensePostings: 0,
  });
}
