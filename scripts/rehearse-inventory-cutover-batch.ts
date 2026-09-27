/** Offline rehearsal. Never imports a database/provider or emits an apply request. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { openingSourceSchema } from "../shared/types/inventory-cutover-opening";
import { claimSupplySnapshotSchema } from "../shared/types/inventory-availability-planner";
import { cutoverHistoryFactsSchema, proposeHistoricalWork } from "../server/modules/inventory-planning/domain/inventory-cutover-history-proposal";
import { reconstructionEvidenceHash, reconstructionHash } from "../server/modules/inventory-planning/domain/inventory-cutover-reconstruction";
import { planFreshCutoverClaims } from "../server/modules/inventory-planning/domain/inventory-cutover-reconstruction-planning";
import { parseClaimSupplySnapshot } from "../server/modules/inventory-planning/domain/inventory-availability-planner";
import { proposeRecordedBinOpening } from "./propose-inventory-cutover-bin-opening";

export const cutoverBatchCaptureSchema = z.object({
  contractVersion: z.literal("inventory_cutover_batch_capture_v1"),
  productionWrites: z.literal(false), deployedCommit: z.string().regex(/^[a-f0-9]{40}$/),
  source: openingSourceSchema, history: cutoverHistoryFactsSchema, supply: claimSupplySnapshotSchema,
}).strict();
export type CutoverBatchCapture = z.infer<typeof cutoverBatchCaptureSchema>;

/** Separates real readiness from an explicitly conditional scenario. Displaced
 * history is retained verbatim; current owners and physical packages are never
 * removed. The existing evaluator and shared whole-basket planner are reused. */
export function rehearseCutoverBatch(raw: CutoverBatchCapture) {
  const capture = cutoverBatchCaptureSchema.parse(raw);
  const supply = parseClaimSupplySnapshot(capture.supply);
  assert.equal(capture.source.capturedAt, supply.capturedAt, "BATCH_CAPTURE_TIME_MISMATCH");
  const levels = new Map(capture.source.evidence.levels.map(level => [level.id, level]));
  for (const position of supply.inventoryPositions) {
    const source = levels.get(position.inventoryLevelId);
    assert.ok(source, "BATCH_SUPPLY_POSITION_MISSING");
    const { id, warehouseId: _warehouseId, ...counters } = source;
    assert.equal(reconstructionHash(position), reconstructionHash({ inventoryLevelId: id, ...counters }), "BATCH_SUPPLY_POSITION_CHANGED");
  }
  const actualOpening = proposeRecordedBinOpening(capture.source);
  const history = proposeHistoricalWork(capture.source, capture.history);
  const base = {
    contractVersion: "inventory_cutover_batch_rehearsal_v1" as const,
    executable: false as const, productionReady: false as const, productionWrites: false as const,
    status: "approval_and_admitted_disposition_required" as const,
    sourceEvidenceHash: capture.source.evidenceHash, captureHash: reconstructionHash(capture),
    actualOpening, history,
    assumptions: ["All listed historical processing-only dispositions, including unresolved channel quarantine, receive explicit approval",
      "An audited admitted command durably prevents these exact old jobs from replaying before cutover",
      "The owner-accepted recorded bins and explicit legacy counter retirement receive final approval",
      "No current order, physical package, original cost, or provider-owned label is changed by the disposition"],
  };
  if (history.blockers.length || !actualOpening.candidate) return { ...base, conditional: null };
  const receiptIds = new Set(history.decisions.filter(row => row.kind === "receipt").map(row => row.id));
  const shipmentIds = new Set(history.decisions.filter(row => row.kind === "shipment").map(row => Number(row.id)));
  const sourceIds = new Set(history.decisions.flatMap(row => row.sourceItemIds));
  const retainedHistory = {
    sourceItems: capture.source.evidence.sourceItems.filter(row => sourceIds.has(row.id)),
    reviewEvidence: capture.source.evidence.shipmentReviewEvidence.filter(row =>
      row.kind === "channel_fulfillment_receipt" && receiptIds.has(row.id)
      || row.kind === "outbound_shipment_review" && shipmentIds.has(Number(row.id))),
  };
  assert.equal(retainedHistory.sourceItems.length, sourceIds.size, "BATCH_SOURCE_COVERAGE_MISMATCH");
  const retainedReviews = new Set(retainedHistory.reviewEvidence);
  // Only the hypothetical scenario removes obsolete work from the *active*
  // census. No production reader/evaluator or original capture is altered.
  const evidence = {
    ...capture.source.evidence,
    sourceItems: capture.source.evidence.sourceItems.filter(row => !sourceIds.has(row.id)),
    shipmentReviewEvidence: capture.source.evidence.shipmentReviewEvidence.filter(row => !retainedReviews.has(row)),
  };
  const scenarioSource = { ...capture.source, evidence, evidenceHash: reconstructionEvidenceHash(evidence) };
  const opening = proposeRecordedBinOpening(scenarioSource);
  let planning: ReturnType<typeof planFreshCutoverClaims> | null = null;
  let planningFailure: { code: string; context: unknown } | null = null;
  if (opening.assessment?.ready && opening.candidate) {
    try { planning = planFreshCutoverClaims(supply, opening.assessment.plan, opening.candidate); }
    catch (error) {
      // Expected operational blockers are evidence, not an empty success. Bugs
      // and schema failures are allowed to fail the tool rather than concealed.
      if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") throw error;
      planningFailure = { code: error.code, context: "context" in error ? error.context : null };
    }
  }
  const shorts = planning?.orders.flatMap(row => row.plan.lines.filter(line => line.shortfallQty !== "0")
    .map(line => ({ orderId: row.order.orderId, warehouseId: row.order.warehouseId, ...line }))) ?? [];
  return {
    ...base, conditional: {
      label: "HYPOTHETICAL ONLY: after all proposed dispositions are approved, implemented and applied",
      sourceEvidenceHash: scenarioSource.evidenceHash, retainedHistoryHash: reconstructionHash(retainedHistory), retainedHistory,
      opening, planning, planningFailure, shortfalls: shorts
    }
  };
}

function main(args: readonly string[]) {
  const [captureFile, expectedHash, outputFile, extra] = args;
  assert.ok(captureFile && /^[a-f0-9]{64}$/.test(expectedHash ?? "") && outputFile && !extra,
    "Usage: rehearse-inventory-cutover-batch <capture> <sha256> <new-output-file>");
  const bytes = readFileSync(resolve(captureFile));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash, "BATCH_FILE_HASH_MISMATCH");
  const result = rehearseCutoverBatch(cutoverBatchCaptureSchema.parse(JSON.parse(bytes.toString("utf8"))));
  const output = JSON.stringify(result, null, 2) + "\n";
  writeFileSync(resolve(outputFile), output, { flag: "wx" });
  console.log(JSON.stringify({
    file: resolve(outputFile), sha256: createHash("sha256").update(output).digest("hex"),
    executable: result.executable, productionReady: result.productionReady, productionWrites: false,
    groups: result.history.groups, historyBlockers: result.history.blockers,
    currentStockLines: result.history.preservedCurrentOrderItemIds.length,
    conditionalOpeningBlockers: result.conditional?.opening.blockers,
    conditionalPlannedOrders: result.conditional?.planning?.orders.length,
    conditionalPlanningFailure: result.conditional?.planningFailure,
    conditionalShortfalls: result.conditional?.shortfalls
  }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(JSON.stringify({
      code: "CUTOVER_BATCH_REHEARSAL_FAILED",
      message: error instanceof Error ? error.message : "Unknown error"
    })); process.exitCode = 1;
  }
}
