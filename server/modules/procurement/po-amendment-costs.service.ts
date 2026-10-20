import { projectPoAmendmentReturnedCosts } from "./po-amendment-return-impact";
import type { PoAmendmentImpact } from "@shared/procurement/po-amendment-impact";
import { COGSService } from "../inventory/cogs.service";
import { reconcilePurchaseCostEvidence } from "./purchase-cost-application.service";
import { readPoAmendmentDependencies } from "./po-amendment-dependencies.repository";
import { buildPoAmendmentImpact } from "./po-amendment-impact.policy";
import type { AmendmentPlan } from "./po-quantity-amendment.policy";
import type {
  AmendmentTransaction,
  readQuantityAmendmentSource,
} from "./po-quantity-amendment.repository";
import type { ShipmentTrackingService } from "./shipment-tracking.service";
import { readPurchaseCostStatus } from "./purchase-cost-status.repository";
import { readShipmentCostReviewInTransaction } from "./shipment-cost-review.repository";
import { isShipmentCostLinePosted } from "@shared/procurement/shipment-cost-workflow";
import {
  CostEvidenceError,
  costInteger,
} from "../inventory/infrastructure/cost-evidence-values";

export type PoAmendmentShipmentOwner = Pick<
  ShipmentTrackingService,
  "refreshQuantityAllocationInTransaction"
>;

/** Reuse the same source decisions and posting owners as receipt and supplier
 * review. A PO edit cannot replace confirmed invoice economics or rewrite a sale. */
export async function refreshPoAmendmentCosts(
  tx: AmendmentTransaction,
  source: Awaited<ReturnType<typeof readQuantityAmendmentSource>>,
  plan: AmendmentPlan,
  shipments: PoAmendmentShipmentOwner,
  actorId: string,
  at: Date,
) {
  const writer = new COGSService(tx);
  const applications: PoAmendmentImpact["applications"] = [];
  const changedProducts = plan.preview.lines
    .filter((line) => line.before.lineType === "product")
    .map((line) => line.before.id);
  for (const lineId of changedProducts) {
    const result = await reconcilePurchaseCostEvidence(
      tx,
      lineId,
      writer,
      actorId,
      at,
    );
    result.costApplications.forEach((application, index) =>
      applications.push({
        purchaseOrderLineId: lineId,
        shipmentId: null,
        component: result.costSources[index].contract.component,
        status: application.status,
        lotsUpdated: application.replayed ? 0 : application.lotsUpdated,
        orderCostsUpdated: application.replayed
          ? 0
          : application.cogsRowsUpdated,
        orderCostDeltaCents: application.replayed
          ? 0
          : application.totalCogsDeltaCents,
        ...projectPoAmendmentReturnedCosts(application),
        issues: application.issues,
      }),
    );
  }
  const affectedShipmentIds = new Set(
    source.dependencies.shipmentLines
      .filter(
        (line) =>
          line.purchase_order_line_id != null &&
          changedProducts.includes(
            costInteger(line.purchase_order_line_id, "purchaseOrderLineId", 1),
          ),
      )
      .map((line) => costInteger(line.inbound_shipment_id, "shipmentId", 1)),
  );
  for (const shipmentId of [...affectedShipmentIds].sort((a, b) => a - b)) {
    const result = await shipments.refreshQuantityAllocationInTransaction(
      tx,
      shipmentId,
      actorId,
      at,
    );
    if (!result.costApplications.length) {
      applications.push({
        purchaseOrderLineId: null,
        shipmentId,
        shipmentLineId: null,
        component: "landed",
        status: "pending_finalization",
        lotsUpdated: 0,
        orderCostsUpdated: 0,
        orderCostDeltaCents: 0,
        issues: [
          {
            code: "SHIPMENT_COST_FINALIZATION_PENDING",
            message:
              "The shipment allocation is current. Finish shipment costing when its charges are ready.",
          },
        ],
      });
      continue;
    }
    const current = await readShipmentCostReviewInTransaction(tx, shipmentId);
    if (!current)
      throw new CostEvidenceError(
        "PO_AMENDMENT_COST_RESULT_MISSING",
        "The updated shipment cost review could not be read.",
      );
    const outcomes = new Map(
      result.costApplications.map((application) => [
        application.applicationId,
        application,
      ]),
    );
    for (const line of current.lines) {
      const application = line.application && outcomes.get(line.application.id);
      if (!application)
        throw new CostEvidenceError(
          "PO_AMENDMENT_COST_RESULT_MISSING",
          "A shipment line has no complete cost update result.",
        );
      const posted = isShipmentCostLinePosted(line);
      applications.push({
        purchaseOrderLineId: null,
        shipmentId,
        shipmentLineId: line.lineId,
        component: "landed",
        status: posted ? "applied" : "review_required",
        lotsUpdated: application.replayed ? 0 : application.lotsUpdated,
        orderCostsUpdated: application.replayed
          ? 0
          : application.cogsRowsUpdated,
        orderCostDeltaCents: application.replayed
          ? 0
          : application.totalCogsDeltaCents,
        ...projectPoAmendmentReturnedCosts(application),
        issues: posted
          ? []
          : [
              ...(line.sourceIssue ? [line.sourceIssue] : []),
              ...application.issues,
            ],
      });
    }
  }
  // The historical application retains its original issues after an approved
  // reconciliation. Use the same current status as PO, receipt and dashboard
  // readers; raw application flags must never reopen an already posted cost.
  const supplierStatus = await readPurchaseCostStatus(tx, changedProducts);
  for (const application of applications.filter(
    (row) => row.purchaseOrderLineId !== null,
  )) {
    const current = supplierStatus.lines
      .find(
        (line) => line.purchaseOrderLineId === application.purchaseOrderLineId,
      )
      ?.components.find(
        (component) => component.component === application.component,
      );
    if (!current)
      throw new CostEvidenceError(
        "PO_AMENDMENT_COST_RESULT_MISSING",
        "A supplier cost component has no complete update result.",
      );
    application.status =
      current.status === "applied" ? "applied" : "review_required";
    application.issues =
      current.issues.length || current.status === "applied"
        ? current.issues
        : [
            {
              code: "PO_AMENDMENT_COST_PENDING",
              message:
                "The supplier cost has not been posted. Open its cost review to complete the recorded evidence.",
            },
          ];
  }
  const after = await readPoAmendmentDependencies(
    tx,
    source.facts.lines
      .filter((line) => line.lineType === "product")
      .map((line) => line.id),
  );
  return buildPoAmendmentImpact(plan, source.dependencies, after, applications);
}
