import { recordCostRevision } from "./cost-source-revision.repository";
import type { CostIssue } from "@shared/procurement/cost-source-contracts";
import { costInteger, lockInventoryCostGraph, type CostEvidenceTransaction, type RecordedCostRevision } from "../inventory/infrastructure/cost-evidence.repository";
import { applyCostRevision, type CostApplicationOptions, type CostComponentWriter } from "../inventory/application/apply-cost-revision";
import type { ShipmentCostProposal } from "./shipment-cost-source-identity";
import { buildShipmentCostRevisionProposals, type ShipmentRevisionOptions } from "./shipment-cost-revision-proposals";
import { readShipmentCostRevisionEvidence, shipmentCostReadBatches } from "./shipment-cost-revision-read.repository";

type ShipmentRevisionProposal = ShipmentCostProposal;

export async function prepareShipmentCostRevisions(tx: CostEvidenceTransaction, shipmentId: number, options: ShipmentRevisionOptions = {}): Promise<{ proposals: ShipmentRevisionProposal[]; issues: CostIssue[] }> {
  costInteger(shipmentId, "shipmentId", 1);
  const evidence = await readShipmentCostRevisionEvidence(tx, [shipmentId]);
  return buildShipmentCostRevisionProposals(shipmentId, evidence.get(shipmentId)!, options);
}

/** Callers retain their existing read snapshot; no cross-request cache or writes. */
export async function prepareShipmentCostRevisionBatch(tx: CostEvidenceTransaction, shipmentIds: readonly number[]): Promise<Map<number, { proposals: ShipmentRevisionProposal[]; issues: CostIssue[] }>> {
  const result = new Map<number, { proposals: ShipmentRevisionProposal[]; issues: CostIssue[] }>();
  for (const ids of shipmentCostReadBatches(shipmentIds)) {
    const evidence = await readShipmentCostRevisionEvidence(tx, ids);
    for (const id of ids) result.set(id, buildShipmentCostRevisionProposals(id, evidence.get(id)!));
  }
  return result;
}

export async function recordShipmentCostRevisions(tx: CostEvidenceTransaction, shipmentId: number, actorId: string, now: Date, options: ShipmentRevisionOptions = {}): Promise<{ revisions: RecordedCostRevision[]; issues: CostIssue[] }> {
  await lockInventoryCostGraph(tx);
  const { proposals, issues } = await prepareShipmentCostRevisions(tx, shipmentId, options);
  const revisions: RecordedCostRevision[] = [];
  for (const proposal of proposals) revisions.push(await recordCostRevision(tx, proposal.input, actorId, now, proposal.sourceEvidence));
  return { revisions, issues };
}

export async function applyShipmentCostRevisions(tx: CostEvidenceTransaction, shipmentId: number, writer: CostComponentWriter, actorId: string, now: Date, options: CostApplicationOptions = {}) {
  const { revisions, issues } = await recordShipmentCostRevisions(tx, shipmentId, actorId, now);
  const applications = [];
  for (const revision of revisions) applications.push(await applyCostRevision(tx, revision, writer, actorId, now, options));
  return {
    updated: applications.filter((application) => !application.replayed).reduce((sum, application) => sum + application.lotsUpdated, 0),
    total: applications.reduce((sum, application) => sum + application.lotsUpdated, 0),
    status: issues.length > 0 || applications.some((application) => application.status === "review_required") ? "review_required" as const : "applied" as const,
    skipped: [...issues.map((issue) => ({ applicationId: null, reason: issue.code, message: issue.message })),
      ...applications.flatMap((application) => application.issues.map((issue) => ({ applicationId: application.applicationId, reason: issue.code, message: issue.message })))],
    costApplications: applications,
  };
}
