import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { openingSourceSchema, type OpeningSource } from "@shared/types/inventory-cutover-opening";
import { historyRetirementResultSchema, retireHistoryRequestSchema } from "@shared/types/inventory-cutover-history";
import type { CutoverHistoryStore, RetireHistoryCommand } from "../application/inventory-cutover-history.service";
import { activeCutoverHistory, assertHistoryRetirementApproved, CutoverHistoryError, historySourceHashes, reviewHistoricalWork } from "../domain/inventory-cutover-history-retirement";
import { planCutoverReconstruction, reconstructionEvidenceHash, reconstructionHash } from "../domain/inventory-cutover-reconstruction";
import { PostgresInventoryCutoverReconstructionRepository } from "./inventory-cutover-reconstruction.repository";
import { readCutoverHistoryFacts } from "./inventory-cutover-history.reader";
import { readHistoryAuditRows, validateHistoryAudit } from "./inventory-cutover-history-audit.reader";
import { lockHistoryFacts } from "./inventory-cutover-history-locks";
import { inInventoryCutoverTransaction, lockInventoryCutoverCommandInsideTransaction } from "./inventory-cutover-commit.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { loadLatestCutoverOpening } from "./inventory-cutover-opening.reader";

/** Explicit retirement of processing work, NOT stock correction or activation.
 * One admitted transaction writes only the two new immutable audit tables.
 * No provider calls, inventory posts or mutations of original history. */
export class PostgresInventoryCutoverHistoryRepository implements CutoverHistoryStore {
  constructor(private readonly pool: Pick<Pool,"connect">) {}

  async review() {
    return inInventoryCutoverTransaction(this.pool,"read_only_review",async client => {
      const { source, facts } = await this.capture(client, false);
      return reviewHistoricalWork(source, facts);
    });
  }

  async retire(command: RetireHistoryCommand) {
    const { actor, requestHash, ...raw } = command;
    const request = retireHistoryRequestSchema.parse(raw);
    if (!z.string().trim().min(1).max(100).safeParse(actor).success || actor !== actor.trim()
      || requestHash !== reconstructionHash({ contractVersion: "inventory_cutover_history_retire_v1", actor, ...request })) {
      throw new CutoverHistoryError("HISTORY_COMMAND_INVALID", "Authenticated history command does not match its complete intent.", 400);
    }
    return inInventoryCutoverTransaction(this.pool,"admitted_commit",async client => {
      await lockInventoryCutoverCommandInsideTransaction(client, `history:${request.idempotencyKey}`);
      const prior = await readHistoryAuditRows(client,request.idempotencyKey);
      if (prior.length) {
        const saved = validateHistoryAudit(prior[0]);
        if (saved.requestHash !== requestHash) throw new CutoverHistoryError("HISTORY_IDEMPOTENCY_CONFLICT", "This key belongs to different reviewed facts, intent or actor.");
        return { ...saved.result, alreadyApplied: true };
      }
      const fence = await acquireInventoryCutoverFenceInsideTransaction(client, {
        expectedAuthority: "legacy", expectedConfigurationRunId: request.expectedConfigurationRunId });
      if (fence.authorityRevision !== request.expectedAuthorityRevision) throw new CutoverHistoryError("HISTORY_REVIEW_CHANGED", "Runtime authority changed after review.");
      const { source, facts } = await this.capture(client, true);
      const review = reviewHistoricalWork(source,facts);
      assertHistoryRetirementApproved(review,request);
      const batchId = (await client.query<{ id: string }>(`SELECT nextval(pg_get_serial_sequence('inventory.cutover_history_batches','id'))::text AS id`)).rows[0]?.id;
      const result = historyRetirementResultSchema.parse({ batchId, reviewHash: review.reviewHash,
        retiredReceipts: review.decisions.filter(row => row.kind === "receipt").length,
        retiredShipments: review.decisions.filter(row => row.kind === "shipment").length,
        quarantinedReceipts: review.unresolvedReceiptIds.length,
        actor, reason: request.reason, occurredAt: source.capturedAt, alreadyApplied: false,
        inventoryChanged: false, authorityChanged: false });
      const inserted = await client.query(`INSERT INTO inventory.cutover_history_batches
        (id,authority_revision,configuration_run_id,review_hash,request_hash,result_hash,source_payload,
         facts_payload,review_payload,request_payload,result_payload,idempotency_key,actor,reason)
        OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14)`,
        [batchId,source.authorityRevision,source.configurationRunId,review.reviewHash,requestHash,reconstructionHash(result),
          JSON.stringify(source),JSON.stringify(facts),JSON.stringify(review),JSON.stringify(request),JSON.stringify(result),request.idempotencyKey,actor,request.reason]);
      if (inserted.rowCount !== 1) throw new CutoverHistoryError("HISTORY_AUDIT_INCOMPLETE", "Retirement audit was not persisted exactly once.", 500);
      const sourceHashes = historySourceHashes(source.evidence);
      const emptySourcesHash = reconstructionHash([]);
      const entries = review.decisions.map(decision => ({ kind: decision.kind,
        receipt_id: decision.kind === "receipt" ? decision.id : null,
        shipment_id: decision.kind === "shipment" ? Number(decision.id) : null,
        decision_payload: decision, source_items_hash: decision.kind === "receipt" ? emptySourcesHash
          : sourceHashes.get(Number(decision.id))?.hash ?? emptySourcesHash }));
      const savedEntries = await client.query(`INSERT INTO inventory.cutover_history_retirements
        (batch_id,kind,receipt_id,shipment_id,decision_payload,source_items_hash)
        SELECT $1::bigint,kind,receipt_id,shipment_id,decision_payload,source_items_hash FROM jsonb_to_recordset($2::jsonb)
          AS entry(kind text,receipt_id bigint,shipment_id integer,decision_payload jsonb,source_items_hash text)`, [batchId,JSON.stringify(entries)]);
      if (savedEntries.rowCount !== entries.length) throw new CutoverHistoryError("HISTORY_AUDIT_INCOMPLETE", "Retirement membership is incomplete.", 500);
      // Force deferred completeness now so an incomplete batch never appears as
      // a successful response even inside this transaction.
      await client.query("SET CONSTRAINTS inventory.cutover_history_batch_complete IMMEDIATE");
      const readback = await readHistoryAuditRows(client,request.idempotencyKey);
      if (readback.length !== 1) throw new CutoverHistoryError("HISTORY_AUDIT_INCOMPLETE", "Retirement readback is missing.", 500);
      return validateHistoryAudit(readback[0]).result;
    });
  }

  private async capture(client: PoolClient, admitted: boolean) {
    const rows = (await client.query(`SELECT authority.authority AS "runtimeAuthority",authority.revision::text AS "authorityRevision",
      (SELECT max(activation_run_id)::text FROM inventory.availability_activation_freezes WHERE released_at IS NULL) AS "configurationRunId",
      (SELECT count(*)::integer FROM inventory.availability_activation_freezes WHERE released_at IS NULL) AS "freezeCount",
      transaction_timestamp() AS "capturedAt" FROM inventory.availability_runtime_authority authority WHERE singleton_key=true`)).rows;
    if (rows.length !== 1 || rows[0].freezeCount > 1) throw new CutoverHistoryError("HISTORY_AUTHORITY_INVALID", "Runtime authority/configuration is ambiguous.", 500);
    const authority = rows[0];
    const evidence = await new PostgresInventoryCutoverReconstructionRepository().capture(client);
    const source: OpeningSource = openingSourceSchema.parse({ contractVersion: "inventory_cutover_opening_source_v1",
      runtimeAuthority: authority.runtimeAuthority, authorityRevision: authority.authorityRevision,
      configurationRunId: authority.configurationRunId, capturedAt: authority.capturedAt.toISOString(),
      evidenceHash: reconstructionEvidenceHash(evidence), evidence, labels: [], latestVerification: (await loadLatestCutoverOpening(client))?.saved ?? null });
    const blockers = planCutoverReconstruction(activeCutoverHistory(evidence)).blockers;
    if (admitted) await lockHistoryFacts(client,source,blockers);
    const facts = await readCutoverHistoryFacts(client,source,blockers);
    return { source, facts };
  }
}
