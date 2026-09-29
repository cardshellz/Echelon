import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { pendingQuantityPublicationRecoveryRequestSchema, pendingQuantityPublicationRecoverySchema,
  quantityPublicationRecoveryResultSchema, quantityPublicationRecoverySchema,
  type PendingQuantityPublicationRecovery, type QuantityPublicationRecoveryResult } from "@shared/types/inventory-publication-recovery";
import type { QuantityPublicationRecoveryCommand, QuantityPublicationRecoveryStore } from "../application/quantity-publication-recovery.service";
import { InventoryCutoverCommitError } from "../application/inventory-cutover-commit.service";
import { quantityPublicationDrainProofSchema } from "../domain/quantity-publication-admission";
import { PROVIDER_REQUEST_TIMEOUT_MS } from "../../channels/provider-request-limits";
import { summarizeProviderAnswer, summarizeRequestTermination, type StoredProviderRequestReceipt } from "../domain/quantity-publication-provider-answer";
import { attestQuantityPublicationAttemptInsideTransaction, captureQuantityPublicationDrainInsideTransaction } from "./quantity-publication-admission.repository";

const commandActorClockSchema = z.object({ actor: z.string().trim().min(1).max(100), now: z.date() }).strict();

interface StoredReceiptRow {
  attempt_id: string; request_id: string; ordinal: number; method: string; path: string; started_at: Date;
  outcome: "completed" | "rejected" | "uncertain" | null; http_status: number | null; response_hash: string | null;
  error_codes: string[] | null; recorded_at: Date | null;
}
interface AttemptTimingRow { id: string; started_at: Date }

/** Audits retained terminal evidence under the publication owner's try-lock.
 * Attestation does not acknowledge an outbox quantity or verify provider state.
 */
export class PostgresQuantityPublicationRecoveryRepository implements QuantityPublicationRecoveryStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = defaultPool) {}

  async pending(activationRunId: string | undefined, now: Date): Promise<PendingQuantityPublicationRecovery> {
    const request = pendingQuantityPublicationRecoveryRequestSchema.parse({ activationRunId });
    const capturedAt = z.date().parse(now).toISOString();
    return this.transaction(true, async client => {
      // Aborted runs no longer appear in the open-activation view, but their
      // unresolved publication history must remain reachable after a reload.
      const run = (await client.query<{ id: string }>(`SELECT id::text FROM inventory.availability_activation_runs
        WHERE ($1::bigint IS NULL OR id=$1::bigint) ORDER BY id DESC LIMIT 1`, [request.activationRunId ?? null])).rows[0];
      if (!run) throw new InventoryCutoverCommitError("PUBLICATION_RECOVERY_RUN_UNAVAILABLE", "No matching persisted activation run is available for publication recovery.");
      const proof = quantityPublicationDrainProofSchema.parse(await captureQuantityPublicationDrainInsideTransaction(client, run.id));
      const unresolvedIds = proof.unresolvedAttempts.map(attempt => attempt.attemptId);
      const receipts = await this.storedReceipts(client, unresolvedIds);
      const timings = await this.attemptTimings(client, unresolvedIds);
      return pendingQuantityPublicationRecoverySchema.parse({ activationRunId: proof.activationRunId, gateEpoch: proof.gateEpoch,
        suppressed: proof.suppressed, capturedAt, basis: "recorded_attempt_history", providerWriteAttempted: false,
        pendingCatchupCount: proof.pendingCatchupCount, unresolvedAttempts: proof.unresolvedAttempts.map(attempt => ({
          attemptId: attempt.attemptId, owner: attempt.owner, state: attempt.state, outboxId: attempt.outboxId,
          destinationKind: attempt.scope.destinationKind, connectionId: attempt.scope.connectionId, providerKey: attempt.scope.providerKey,
          providerScopeType: attempt.scope.providerScopeType, externalScopeId: attempt.scope.externalScopeId,
          externalInventoryItemId: attempt.scope.externalInventoryItemId,
          providerAnswer: summarizeProviderAnswer(attempt.state, receipts.get(attempt.attemptId) ?? []),
          requestTermination: this.requestTermination(attempt.attemptId, attempt.state, timings.get(attempt.attemptId), receipts.get(attempt.attemptId) ?? [], now),
        })) });
    });
  }

  /** The immutable receipts each unresolved attempt stored; read only, so the operator sees what the provider answered. */
  private async storedReceipts(client: PoolClient, attemptIds: readonly string[]): Promise<Map<string, StoredProviderRequestReceipt[]>> {
    const receipts = new Map<string, StoredProviderRequestReceipt[]>();
    if (attemptIds.length === 0) return receipts;
    const rows = (await client.query<StoredReceiptRow>(`SELECT q.attempt_id::text AS attempt_id,q.id::text AS request_id,q.ordinal,q.method,q.path,q.started_at,
        r.outcome,r.http_status,r.response_hash,r.error_codes,r.recorded_at
      FROM inventory.quantity_provider_requests q
      LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
      WHERE q.attempt_id=ANY($1::bigint[]) ORDER BY q.attempt_id,q.ordinal`, [attemptIds])).rows;
    for (const row of rows) {
      const list = receipts.get(row.attempt_id) ?? [];
      list.push({ attemptId: row.attempt_id, requestId: row.request_id, ordinal: row.ordinal, method: row.method, path: row.path,
        startedAt: row.started_at, outcome: row.outcome, httpStatus: row.http_status, responseHash: row.response_hash,
        errorCodes: row.error_codes ?? [], recordedAt: row.recorded_at });
      receipts.set(row.attempt_id, list);
    }
    return receipts;
  }

  /** When each unresolved attempt started; with the receipts this bounds its last possible activity. */
  private async attemptTimings(client: PoolClient, attemptIds: readonly string[]): Promise<Map<string, Date>> {
    const timings = new Map<string, Date>();
    if (attemptIds.length === 0) return timings;
    const rows = (await client.query<AttemptTimingRow>(`SELECT id::text,started_at FROM inventory.quantity_publication_attempts
      WHERE id=ANY($1::bigint[])`, [attemptIds])).rows;
    for (const row of rows) timings.set(row.id, row.started_at);
    return timings;
  }

  private requestTermination(attemptId: string, state: "running" | "uncertain", startedAt: Date | undefined,
    receipts: readonly StoredProviderRequestReceipt[], now: Date) {
    // An attempt without a stored start cannot be bounded; it stays a manual decision.
    if (!startedAt) return null;
    return summarizeRequestTermination({ attemptId, state, startedAt, receipts, now, providerRequestTimeoutMs: PROVIDER_REQUEST_TIMEOUT_MS });
  }

  async attest(command: QuantityPublicationRecoveryCommand): Promise<QuantityPublicationRecoveryResult> {
    const { actor, now, ...rawRequest } = command;
    const request = quantityPublicationRecoverySchema.parse(rawRequest);
    const audit = commandActorClockSchema.parse({ actor, now });
    return this.transaction(false, async client => quantityPublicationRecoveryResultSchema.parse({
      ...await attestQuantityPublicationAttemptInsideTransaction(client, { ...request, ...audit }), providerWriteAttempted: false,
    }));
  }

  private async transaction<T>(readOnly: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    // The application's pool has a bounded 10-second acquisition timeout.
    const client = await this.connectionPool.connect();
    let began = false; let discard = false;
    try {
      await client.query(readOnly ? "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY" : "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED");
      began = true;
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
      const result = await work(client);
      await client.query("COMMIT"); began = false;
      return result;
    } catch (error) {
      if (began) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) {
          discard = true;
          throw new AggregateError([error, rollbackError], "Publication recovery and rollback failed; discard the connection.");
        }
      }
      throw error;
    } finally { client.release(discard); }
  }
}
