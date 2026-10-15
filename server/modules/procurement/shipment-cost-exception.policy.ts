import { z } from "zod";
import { costSourceRevisionSchema, costIssueSchema } from "@shared/procurement/cost-source-contracts";
import { shipmentCostExceptionSchema, shipmentExceptionDecisionSchema,
  type ShipmentCostException } from "@shared/procurement/shipment-cost-exception";
import { costFingerprint } from "../inventory/infrastructure/cost-evidence-values";

export class ShipmentCostExceptionError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 409) { super(message); }
}

export const shipmentExceptionFactsSchema = z.object({
  lineId: z.number().int().positive().safe(), shipmentId: z.number().int().positive().safe(),
  sku: z.string().nullable(), shipmentStatus: z.string(),
  revisionId: z.number().int().positive().safe().nullable(), contract: z.unknown(),
  applicationId: z.number().int().positive().safe().nullable(), applicationStatus: z.string().nullable(),
  result: z.unknown(), decision: shipmentExceptionDecisionSchema.nullable(),
});
export type ShipmentExceptionFacts = z.infer<typeof shipmentExceptionFactsSchema>;
const resultSchema = z.object({
  status: z.literal("review_required"),
  lotsUpdated: z.number().int().nonnegative().safe(),
  cogsRowsUpdated: z.number().int().nonnegative().safe(),
  issues: z.array(costIssueSchema).min(1),
});
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/** Only documented historical gaps can be accepted. Currency, source, graph
 * corruption, and ordinary update failures keep their owning repair workflow. */
export function buildShipmentCostException(facts: ShipmentExceptionFacts): ShipmentCostException | null {
  const source = costSourceRevisionSchema.safeParse(facts.contract);
  const result = resultSchema.safeParse(facts.result);
  if (!source.success || !result.success || facts.applicationStatus !== "review_required"
    || facts.revisionId === null || facts.applicationId === null || facts.shipmentStatus !== "closed") return null;
  const contract = source.data;
  if (contract.component !== "landed" || contract.scope.kind !== "shipment_line"
    || contract.scope.inboundShipmentLineId !== facts.lineId || contract.scope.inboundShipmentId !== facts.shipmentId
    || contract.issue !== null || contract.currency !== "USD" || contract.totalMills === null || contract.totalMills < 0
    || !["estimated", "confirmed"].includes(contract.evidence)) return null;
  const issues = [...result.data.issues].sort((a, b) => compareText(a.code, b.code)
    || (a.unresolvedQuantity?.allocationId ?? 0) - (b.unresolvedQuantity?.allocationId ?? 0) || compareText(a.message, b.message));
  const missingReceipt = issues.every(issue => issue.code === "COST_HISTORICAL_LINEAGE_MISSING" && !issue.unresolvedQuantity);
  const retainedQuantity = issues.every(issue => issue.code === "COST_UNRESOLVED_QUANTITY_RETAINED"
    && issue.unresolvedQuantity?.component === "landed");
  if (!missingReceipt && !retainedQuantity) return null;
  // Missing origins block the entire application. Do not represent a partly
  // applied line as though its whole amount were still unassigned.
  if (missingReceipt && (result.data.lotsUpdated !== 0 || result.data.cogsRowsUpdated !== 0)) return null;
  const allocationIds = issues.map(issue => issue.unresolvedQuantity?.allocationId);
  if (retainedQuantity && new Set(allocationIds).size !== allocationIds.length) return null;
  const retained = missingReceipt ? BigInt(contract.totalMills)
    : issues.reduce((sum, issue) => sum + BigInt(issue.unresolvedQuantity!.amountMills), BigInt(0));
  if (retained > BigInt(contract.totalMills) || retained > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  // Deliberately exclude application id and counts of known rows revalued. An
  // identical retry or later sale cannot silently undo this reviewed decision.
  const fingerprint = costFingerprint({ version: 1, revisionId: facts.revisionId,
    sourceFingerprint: contract.fingerprint, issues, amountMills: Number(retained) });
  return shipmentCostExceptionSchema.parse({
    state: facts.decision?.fingerprint === fingerprint && facts.decision.action === "accept" ? "accepted" : "open",
    fingerprint, kind: missingReceipt ? "missing_receipt_history" : "unexplained_quantity", currency: contract.currency,
    allocatedMills: contract.totalMills, amountMills: Number(retained),
    lotsUpdated: result.data.lotsUpdated, cogsRowsUpdated: result.data.cogsRowsUpdated, issues, decision: facts.decision,
  });
}

export function shipmentExceptionVersion(facts: ShipmentExceptionFacts, currentSourceFingerprint: string | null): string {
  return costFingerprint({ version: 1, facts, currentSourceFingerprint });
}
