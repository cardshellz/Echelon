import { sql } from "drizzle-orm";
import { shipmentMeasurementContextSchema, shipmentMeasurementPreviewSchema, shipmentMeasurementReviewRequestSchema,
  type ShipmentMeasurementReviewRequest, type ShipmentMeasurementApproval } from "@shared/procurement/shipment-measurement-correction";
import { shipmentCostWorkflowIdSchema, isShipmentCostLinePosted, type ShipmentCostUpdateResult } from "@shared/procurement/shipment-cost-workflow";
import { computeShipmentPhysicalTotals } from "@shared/procurement/shipment-physical-values";
import { costFingerprint, costInteger } from "../inventory/infrastructure/cost-evidence-values";
import { hasQuantityAmendmentAuthority } from "./po-quantity-amendment.policy";
import { buildCostDestinationImpact } from "./cost-change-impact";
import { readPoAmendmentDependencies } from "./po-amendment-dependencies.repository";
import { projectPoAmendmentReturnedCosts } from "./po-amendment-return-impact";
import { readShipmentCostReviewInTransaction } from "./shipment-cost-review.repository";
import type { AmendmentDatabase, AmendmentTransaction } from "./po-quantity-amendment.repository";
import type { ShipmentTrackingService } from "./shipment-tracking.service";
import type { CostRevisionApplicationResult } from "../inventory/application/apply-cost-revision";
import { ShipmentMeasurementCorrectionError, readShipmentMeasurementSource, measurementsOf, saveShipmentMeasurements,
  readShipmentMeasurementApprovals, recordShipmentMeasurementApproval, shipmentDependencyLines } from "./shipment-measurement-correction.repository";

export type ShipmentCostUpdateApplicationResult = ShipmentCostUpdateResult & { costApplications: CostRevisionApplicationResult[] };
type UpdateSavedCosts = (recordedAt: Date) => Promise<ShipmentCostUpdateApplicationResult>;
const integer = (value: unknown) => costInteger(value, "measurement cost impact", -Number.MAX_SAFE_INTEGER);
function blockedReason(status: string) {
  return ["costing", "closed"].includes(status) ? null : "Use Edit shipment for packing changes before costing. Measurement cost corrections are available while costing or after closing.";
}

/** Change only physical inputs, then measure the existing financial owner's
 * writes. Approval reruns that exact path and rejects a changed impact. */
export async function applyShipmentMeasurementCorrection(tx: AmendmentTransaction, shipmentId: number,
  request: ShipmentMeasurementReviewRequest | ShipmentMeasurementApproval, actorId: string, at: Date,
  updateSavedCosts: UpdateSavedCosts, enforcePreview = true) {
  const source = await readShipmentMeasurementSource(tx, shipmentId, actorId);
  if (!hasQuantityAmendmentAuthority(source.actor)) throw new ShipmentMeasurementCorrectionError("A current Administrator with purchasing approval permission must approve measurement corrections.", "SHIPMENT_MEASUREMENTS_ADMIN_REQUIRED", 403);
  const blocked = blockedReason(source.shipment.status);
  if (blocked) throw new ShipmentMeasurementCorrectionError(blocked, "SHIPMENT_MEASUREMENTS_STATUS_INVALID");
  if (source.sourceVersion !== request.sourceVersion) throw new ShipmentMeasurementCorrectionError("The shipment, charges, receiving history or cost balances changed. Reload and review the measurements again.", "SHIPMENT_MEASUREMENTS_STALE");
  const changed = request.lines.some(change => {
    const line = source.lines.find(line => line.id === change.lineId);
    if (!line) throw new ShipmentMeasurementCorrectionError("A corrected line does not belong to this shipment.", "SHIPMENT_MEASUREMENTS_LINE_INVALID", 400);
    return costFingerprint(measurementsOf(line)) !== costFingerprint(change.measurements);
  });
  if (!changed) throw new ShipmentMeasurementCorrectionError("No measurement changes to save. Use Update shipment costs to recalculate the saved values.", "SHIPMENT_MEASUREMENTS_UNCHANGED", 400);
  // All existing materialization/allocation writers use this same injected
  // timestamp. A correction cannot move a row version backwards or reuse one
  // when two approved commands happen within the same clock tick.
  const recordedAt = new Date(Math.max(at.getTime(), source.shipment.updatedAt.getTime() + 1,
    ...source.lines.map(line => line.updatedAt.getTime() + 1)));
  await saveShipmentMeasurements(tx, source, request, recordedAt);
  const result = await updateSavedCosts(recordedAt);
  const after = await readPoAmendmentDependencies(tx, [...new Set(source.lines.map(line => line.purchaseOrderLineId!))]);
  const afterLines = new Map(shipmentDependencyLines(after, shipmentId).map(line => [integer(line.id), line]));
  const beforeSnapshots = new Map(source.dependencies.snapshots.map(row => [integer(row.inbound_shipment_line_id), row]));
  const afterSnapshots = new Map(after.snapshots.map(row => [integer(row.inbound_shipment_line_id), row]));
  const current = await readShipmentCostReviewInTransaction(tx, shipmentId);
  if (!current) throw new ShipmentMeasurementCorrectionError("The saved cost result could not be verified.", "SHIPMENT_MEASUREMENTS_RESULT_MISSING", 500);
  const outcomes = new Map(result.costApplications.map(application => [application.applicationId, application]));
  // Use the current posting status shared with the PO and shipment. Original
  // history issues remain audited after reconciliation, rather than becoming
  // new warnings when the same costs are already posted.
  const applications = current.lines.map(line => {
    const application = line.application ? outcomes.get(line.application.id) : undefined;
    const posted = isShipmentCostLinePosted(line);
    return { purchaseOrderLineId: null, shipmentId, shipmentLineId: line.lineId, component: "landed" as const,
      status: posted ? "applied" as const : "review_required" as const,
      lotsUpdated: application && !application.replayed ? application.lotsUpdated : 0,
      orderCostsUpdated: application && !application.replayed ? application.cogsRowsUpdated : 0,
      orderCostDeltaCents: application && !application.replayed ? application.totalCogsDeltaCents : 0,
      ...(application ? projectPoAmendmentReturnedCosts(application) : {}),
      issues: posted ? [] : [...(line.sourceIssue ? [line.sourceIssue] : []), ...(application?.issues ?? [])].map(issue => ({ code: issue.code, message: issue.message })),
    };
  });
  const chargeTotal = (dependencies: typeof after) => integer(dependencies.costs.filter(cost => integer(cost.inbound_shipment_id) === shipmentId)
    .reduce((sum, cost) => sum + BigInt(integer(cost.actual_cents ?? cost.estimated_cents ?? 0)), BigInt(0)).toString());
  if (chargeTotal(source.dependencies) !== chargeTotal(after)) throw new Error("Measurement correction changed shipment charges");
  const summary = {
    shipmentId, shipmentNumber: source.shipment.shipmentNumber, status: source.shipment.status,
    sourceVersion: source.sourceVersion, reason: request.reason, chargeCents: chargeTotal(after),
    lines: source.lines.map(line => {
      const next = afterLines.get(line.id);
      if (!next || integer(next.qty_shipped) !== line.qtyShipped) throw new Error("Measurement correction changed shipped quantities");
      const measurements = { cartonCount: next.carton_count == null ? null : integer(next.carton_count), dimensionBasis: next.dimension_basis as string | null,
        weightKg: next.weight_kg as string | null, lengthCm: next.length_cm as string | null, widthCm: next.width_cm as string | null, heightCm: next.height_cm as string | null };
      return { lineId: line.id, sku: line.sku, purchaseOrderId: line.purchaseOrderId, shippedPieces: line.qtyShipped,
        before: measurementsOf(line), after: measurements,
        physicalTotals: { before: computeShipmentPhysicalTotals(line), after: computeShipmentPhysicalTotals({ ...measurements, qtyShipped: line.qtyShipped }) },
        allocatedCents: { before: line.allocatedCostCents, after: next.allocated_cost_cents == null ? null : integer(next.allocated_cost_cents) },
        landedTotalCents: {
          before: beforeSnapshots.get(line.id)?.total_landed_cost_cents == null ? null : integer(beforeSnapshots.get(line.id)!.total_landed_cost_cents),
          after: afterSnapshots.get(line.id)?.total_landed_cost_cents == null ? null : integer(afterSnapshots.get(line.id)!.total_landed_cost_cents),
        },
      };
    }), impact: { ...buildCostDestinationImpact(source.dependencies, after), applications },
  };
  const preview = shipmentMeasurementPreviewSchema.parse({ ...summary, previewVersion: costFingerprint(summary) });
  if (enforcePreview && (!("previewVersion" in request) || preview.previewVersion !== request.previewVersion))
    throw new ShipmentMeasurementCorrectionError("The cost impact changed. Review the measurements and before-and-after costs again.", "SHIPMENT_MEASUREMENTS_STALE");
  const approval = await recordShipmentMeasurementApproval(tx, source, preview, actorId, recordedAt);
  return { ...result, status: current.lines.every(isShipmentCostLinePosted) ? "applied" as const : "review_required" as const, measurementCorrection: approval };
}

export function createShipmentMeasurementCorrectionService(database: AmendmentDatabase,
  owner: Pick<ShipmentTrackingService, "updateCostsInTransaction">, clock: () => Date) {
  return {
    async context(id: number, actorId: string) {
      const shipmentId = shipmentCostWorkflowIdSchema.parse(id);
      return database.transaction(async tx => {
        const source = await readShipmentMeasurementSource(tx, shipmentId, actorId);
        return shipmentMeasurementContextSchema.parse({ shipmentId, shipmentNumber: source.shipment.shipmentNumber,
          status: source.shipment.status, sourceVersion: source.sourceVersion, canApprove: hasQuantityAmendmentAuthority(source.actor),
          blockedReason: blockedReason(source.shipment.status), lines: source.lines.map(line => ({ lineId: line.id, sku: line.sku,
            purchaseOrderId: line.purchaseOrderId, shippedPieces: line.qtyShipped, measurements: measurementsOf(line) })),
          approvals: await readShipmentMeasurementApprovals(tx, shipmentId) });
      });
    },
    async preview(id: number, body: unknown, actorId: string) {
      const shipmentId = shipmentCostWorkflowIdSchema.parse(id);
      const parsed = shipmentMeasurementReviewRequestSchema.safeParse(body);
      if (!parsed.success) throw new ShipmentMeasurementCorrectionError("Check the measurements and include a reason of at least 10 characters.", "SHIPMENT_MEASUREMENTS_INPUT_INVALID", 400);
      return database.transaction(async tx => {
        await tx.execute(sql`SAVEPOINT shipment_measurement_preview`);
        try {
          const at = clock();
          return (await applyShipmentMeasurementCorrection(tx, shipmentId, parsed.data, actorId, at,
            recordedAt => owner.updateCostsInTransaction(tx, shipmentId, {}, actorId, recordedAt, { historicalReconciliation: "preserve" }), false)).measurementCorrection.preview;
        } finally {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT shipment_measurement_preview`);
          await tx.execute(sql`RELEASE SAVEPOINT shipment_measurement_preview`);
        }
      });
    },
  };
}
