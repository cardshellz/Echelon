import type { PoolClient } from "pg";
import { openingSourceSchema } from "@shared/types/inventory-cutover-opening";
import { historyDecisionSchema, historyRetirementResultSchema, historyReviewSchema, retireHistoryRequestSchema,
  retiredHistoryEvidenceSchema, type RetiredHistoryEvidence } from "@shared/types/inventory-cutover-history";
import { cutoverHistoryFactsSchema } from "../domain/inventory-cutover-history-proposal";
import { assertHistoryRetirementApproved, CutoverHistoryError, historySourceHashes, reviewHistoricalWork } from "../domain/inventory-cutover-history-retirement";
import { reconstructionHash } from "../domain/inventory-cutover-reconstruction";

export interface HistoryAuditRow {
  id: string; authority_revision: string; configuration_run_id: string | null;
  review_hash: string; request_hash: string; result_hash: string;
  source_payload: unknown; facts_payload: unknown; review_payload: unknown;
  request_payload: unknown; result_payload: unknown; idempotency_key: string;
  actor: string; reason: string; occurred_at: Date; entries: unknown;
}
const MAX_BATCHES = 100;
const AUDIT_QUERY = `SELECT b.id::text,b.authority_revision::text,b.configuration_run_id::text,
  b.review_hash,b.request_hash,b.result_hash,b.source_payload,b.facts_payload,b.review_payload,
  b.request_payload,b.result_payload,b.idempotency_key,b.actor,b.reason,b.occurred_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',r.kind,'id',r.source_id::text,
    'decision',r.decision_payload,'sourceItemsHash',r.source_items_hash) ORDER BY r.kind,r.source_id)
    FROM inventory.cutover_history_retirements r WHERE r.batch_id=b.id),'[]'::jsonb) AS entries
  FROM inventory.cutover_history_batches b`;

export async function readHistoryAuditRows(client: Pick<PoolClient,"query">, key?: string): Promise<HistoryAuditRow[]> {
  const rows = (await client.query<HistoryAuditRow>(`${AUDIT_QUERY}
    ${key === undefined ? "" : "WHERE b.idempotency_key=$1"} ORDER BY b.id LIMIT ${MAX_BATCHES + 1}`,
    key === undefined ? [] : [key])).rows;
  if (rows.length > MAX_BATCHES) throw new CutoverHistoryError("HISTORY_AUDIT_LIMIT", "Complete history audit exceeds its bounded census.", 422);
  return rows;
}

/** Rebuild the decision from the original complete capture; never trust a
 * manually supplied marker or a partial/forged audit as permission to filter. */
export function validateHistoryAudit(row: HistoryAuditRow) {
  try {
    const source = openingSourceSchema.parse(row.source_payload);
    const facts = cutoverHistoryFactsSchema.parse(row.facts_payload);
    const review = historyReviewSchema.parse(row.review_payload);
    const request = retireHistoryRequestSchema.parse(row.request_payload);
    const result = historyRetirementResultSchema.parse(row.result_payload);
    const expectedReview = reviewHistoricalWork(source, facts);
    assertHistoryRetirementApproved(expectedReview, request);
    const expectedRequestHash = reconstructionHash({ contractVersion: "inventory_cutover_history_retire_v1", actor: row.actor, ...request });
    if (reconstructionHash(review) !== reconstructionHash(expectedReview) || review.reviewHash !== row.review_hash
      || row.request_hash !== expectedRequestHash || row.result_hash !== reconstructionHash(result)
      || row.authority_revision !== review.authorityRevision || row.configuration_run_id !== review.configurationRunId
      || row.idempotency_key !== request.idempotencyKey || row.reason !== request.reason
      || result.batchId !== row.id || result.reviewHash !== review.reviewHash || result.actor !== row.actor
      || result.reason !== row.reason || result.occurredAt !== row.occurred_at.toISOString() || result.alreadyApplied
      || result.retiredReceipts !== review.decisions.filter(d => d.kind === "receipt").length
      || result.retiredShipments !== review.decisions.filter(d => d.kind === "shipment").length
      || result.quarantinedReceipts !== review.unresolvedReceiptIds.length) throw new Error("audit binding mismatch");
    if (!Array.isArray(row.entries) || row.entries.length !== review.decisions.length) throw new Error("audit membership incomplete");
    const decisions = new Map(review.decisions.map(d => [`${d.kind}:${d.id}`,d]));
    const sourceHashes = historySourceHashes(source.evidence);
    const emptySourcesHash = reconstructionHash([]);
    const retired: RetiredHistoryEvidence[] = row.entries.map(entry => {
      if (!entry || typeof entry !== "object") throw new Error("invalid audit entry");
      const decision = historyDecisionSchema.parse(entry.decision);
      const key = `${entry.kind}:${entry.id}`;
      const expected = decisions.get(key);
      if (!expected || reconstructionHash(expected) !== reconstructionHash(decision)) throw new Error("audit entry differs");
      decisions.delete(key);
      const sourceHash = decision.kind === "receipt" ? emptySourcesHash : sourceHashes.get(Number(decision.id))?.hash ?? emptySourcesHash;
      if (entry.sourceItemsHash !== sourceHash) throw new Error("audit source hash differs");
      return retiredHistoryEvidenceSchema.parse({ ...decision, batchId: row.id, reviewHash: review.reviewHash,
        sourceItemsHash: entry.sourceItemsHash });
    });
    return { result, requestHash: expectedRequestHash, retired };
  } catch (cause) {
    throw new CutoverHistoryError("HISTORY_AUDIT_INVALID", "Historical retirement audit failed integrity validation.", 500,
      { batchId: row.id, cause: cause instanceof Error ? cause.name : "UnknownError" });
  }
}

export async function readRetiredCutoverHistory(client: Pick<PoolClient,"query">): Promise<RetiredHistoryEvidence[]> {
  return (await readHistoryAuditRows(client)).flatMap(row => validateHistoryAudit(row).retired);
}
