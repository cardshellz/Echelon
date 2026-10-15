import { sql, type SQL } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import { shipmentExceptionDecisionSchema, shipmentExceptionHistorySchema, type ShipmentCostException, type ShipmentExceptionContext,
  type ShipmentExceptionRequest } from "@shared/procurement/shipment-cost-exception";
import type { PurchaseApprovalActor } from "../identity/domain/purchase-approval-authority";
import { readPurchaseApproverName } from "../identity/infrastructure/purchase-approval-access.repository";
import { costFingerprint, costInteger } from "../inventory/infrastructure/cost-evidence-values";
import { dateValues } from "./purchase-workspace-read";
import { prepareShipmentCostRevisions } from "./shipment-cost-application.service";
import { buildShipmentCostException, shipmentExceptionFactsSchema, type ShipmentExceptionFacts } from "./shipment-cost-exception.policy";

export interface ShipmentExceptionReader { execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }> }

export async function readShipmentExceptionFacts(tx: ShipmentExceptionReader, lineIds: number[]): Promise<ShipmentExceptionFacts[]> {
  if (!lineIds.length) return [];
  const rows = await tx.execute(sql`SELECT line.id,line.inbound_shipment_id,line.sku,shipment.status AS shipment_status,
      revision.id AS revision_id,revision.contract,application.id AS application_id,application.status AS application_status,
      application.evidence->'result' AS result,decision.decision
    FROM procurement.inbound_shipment_lines line
    JOIN procurement.inbound_shipments shipment ON shipment.id=line.inbound_shipment_id
    LEFT JOIN LATERAL (SELECT id,contract FROM procurement.cost_source_revisions
      WHERE inbound_shipment_line_id=line.id AND component='landed' ORDER BY revision DESC,id DESC LIMIT 1) revision ON true
    LEFT JOIN LATERAL (SELECT id,status,evidence FROM inventory.cost_applications
      WHERE source_revision_id=revision.id ORDER BY id DESC LIMIT 1) application ON true
    LEFT JOIN LATERAL (SELECT jsonb_build_object('id',id,'action',action,'fingerprint',exception_fingerprint,
      'reason',reason,'actorId',actor_id,'actorName',actor_name,'recordedAt',recorded_at) AS decision
      FROM procurement.shipment_cost_exception_decisions WHERE inbound_shipment_line_id=line.id ORDER BY id DESC LIMIT 1) decision ON true
    WHERE line.id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(lineIds)}::jsonb)) ORDER BY line.id`);
  return rows.rows.map(row => shipmentExceptionFactsSchema.parse({
    lineId: costInteger(row.id, "lineId", 1), shipmentId: costInteger(row.inbound_shipment_id, "shipmentId", 1),
    sku: row.sku, shipmentStatus: row.shipment_status,
    revisionId: row.revision_id == null ? null : costInteger(row.revision_id, "revisionId", 1), contract: row.contract,
    applicationId: row.application_id == null ? null : costInteger(row.application_id, "applicationId", 1),
    applicationStatus: row.application_status, result: row.result, decision: row.decision ?? null,
  }));
}

export async function readCurrentShipmentSourceFingerprints(tx: ShipmentExceptionReader, shipmentId: number): Promise<Map<number, string>> {
  const prepared = await prepareShipmentCostRevisions(tx, shipmentId);
  return new Map(prepared.proposals.flatMap(proposal => proposal.input.scope.kind === "shipment_line"
    ? [[proposal.input.scope.inboundShipmentLineId, costFingerprint(proposal)] as const] : []));
}

export async function readShipmentExceptionHistory(tx: ShipmentExceptionReader, lineId: number) {
  const rows = await tx.execute(sql`SELECT id,action,exception_fingerprint,reason,actor_id,actor_name,recorded_at,amount_mills,currency
    FROM procurement.shipment_cost_exception_decisions WHERE inbound_shipment_line_id=${lineId} ORDER BY id DESC LIMIT 20`);
  return shipmentExceptionHistorySchema.parse(rows.rows.map(row => ({
    id: costInteger(row.id, "decisionId", 1), action: row.action, fingerprint: row.exception_fingerprint,
    reason: row.reason, actorId: row.actor_id, actorName: row.actor_name,
    recordedAt: dateValues({ at: row.recorded_at }, ["at"]).at,
    amountMills: costInteger(row.amount_mills, "amountMills"), currency: row.currency,
  })));
}

/** A saved acceptance is valid only while its source and issue evidence still
 * match. Check current sources once per shipment, not once per line. */
export async function readShipmentCostExceptions(tx: ShipmentExceptionReader, lineIds: number[]): Promise<Map<number, ShipmentCostException>> {
  const facts = await readShipmentExceptionFacts(tx, lineIds);
  const reviews = new Map<number, ShipmentCostException>();
  const current = new Map<number, Map<number, string>>();
  for (const fact of facts) {
    const review = buildShipmentCostException(fact);
    if (!review) continue;
    if (review.state === "accepted") {
      if (!current.has(fact.shipmentId)) current.set(fact.shipmentId, await readCurrentShipmentSourceFingerprints(tx, fact.shipmentId));
      const contract = fact.contract as { fingerprint: string };
      if (current.get(fact.shipmentId)!.get(fact.lineId) !== contract.fingerprint) {
        reviews.set(fact.lineId, { ...review, state: "open" });
        continue;
      }
    }
    reviews.set(fact.lineId, review);
  }
  return reviews;
}

export async function persistShipmentExceptionDecision(tx: ShipmentExceptionReader, facts: ShipmentExceptionFacts,
  context: ShipmentExceptionContext, request: ShipmentExceptionRequest, actor: PurchaseApprovalActor, at: Date) {
  const review = context.review!;
  const actorName = await readPurchaseApproverName(tx, actor.userId);
  const { decision: _priorDecision, ...reviewedEvidence } = review;
  const after = { ...reviewedEvidence, state: request.action === "accept" ? "accepted" : "open",
    decision: { action: request.action, actorId: actor.userId, actorName, reason: request.reason, recordedAt: at.toISOString() } };
  // This audit changes the disposition of a review only. It never writes to
  // quantities, cost sources, applications, order costs, payments or journals.
  const evidence = { version: 1, reviewedSourceVersion: context.sourceVersion, approval: actor,
    before: review, after, inventoryQuantityDelta: 0, inventoryCostDeltaMills: 0, orderCostDeltaMills: 0 };
  const rows = await tx.execute(sql`INSERT INTO procurement.shipment_cost_exception_decisions
      (inbound_shipment_id,inbound_shipment_line_id,source_revision_id,application_id,previous_decision_id,
       exception_fingerprint,action,amount_mills,currency,reason,actor_id,actor_name,recorded_at,evidence)
    VALUES (${facts.shipmentId},${facts.lineId},${facts.revisionId},${facts.applicationId},${facts.decision?.id ?? null},
      ${review.fingerprint},${request.action},${review.amountMills},${review.currency},${request.reason},${actor.userId},${actorName},${at},${canonicalJson(evidence)}::jsonb)
    RETURNING id,recorded_at`);
  return shipmentExceptionDecisionSchema.parse({ id: costInteger(rows.rows[0]?.id, "decisionId", 1),
    action: request.action, fingerprint: review.fingerprint, reason: request.reason, actorId: actor.userId, actorName,
    recordedAt: dateValues({ at: rows.rows[0]?.recorded_at }, ["at"]).at });
}
