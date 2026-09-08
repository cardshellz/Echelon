import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { pendingQuantityPublicationRecoveryRequestSchema, pendingQuantityPublicationRecoverySchema,
  quantityPublicationRecoveryResultSchema, quantityPublicationRecoverySchema,
  type PendingQuantityPublicationRecovery, type QuantityPublicationRecoveryResult } from "@shared/types/inventory-publication-recovery";
import type { QuantityPublicationRecoveryCommand, QuantityPublicationRecoveryStore } from "../application/quantity-publication-recovery.service";
import { InventoryCutoverCommitError } from "../application/inventory-cutover-commit.service";
import { quantityPublicationDrainProofSchema } from "../domain/quantity-publication-admission";
import { attestQuantityPublicationAttemptInsideTransaction, captureQuantityPublicationDrainInsideTransaction } from "./quantity-publication-admission.repository";

const commandActorClockSchema = z.object({ actor: z.string().trim().min(1).max(100), now: z.date() }).strict();

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
      return pendingQuantityPublicationRecoverySchema.parse({ activationRunId: proof.activationRunId, gateEpoch: proof.gateEpoch,
        suppressed: proof.suppressed, capturedAt, basis: "recorded_attempt_history", providerWriteAttempted: false,
        pendingCatchupCount: proof.pendingCatchupCount, unresolvedAttempts: proof.unresolvedAttempts.map(attempt => ({
          attemptId: attempt.attemptId, owner: attempt.owner, state: attempt.state, outboxId: attempt.outboxId,
          destinationKind: attempt.scope.destinationKind, connectionId: attempt.scope.connectionId, providerKey: attempt.scope.providerKey,
          providerScopeType: attempt.scope.providerScopeType, externalScopeId: attempt.scope.externalScopeId,
          externalInventoryItemId: attempt.scope.externalInventoryItemId,
        })) });
    });
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
