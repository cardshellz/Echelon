import type { Pool } from "pg";
import { z } from "zod";
import {
  quantityPublicationScopeSchema,
  QuantityPublicationAdmissionError,
  type QuantityPublicationScope,
} from "../domain/quantity-publication-admission";
import { terminalEbayResponseEvidence } from "../domain/quantity-provider-terminal-response";
import {
  QUANTITY_PUBLICATION_LOCK_NAMESPACE,
  quantityPublicationScopeLockKey,
} from "./quantity-publication-admission.repository";

/** Inventory owns request fences and their audit trail. No provider writes, quantity
 * acknowledgement, activation, operator impersonation, or age-based clearing. */
export class PostgresQuantityProviderResponseRecovery {
  private dueCursor = "0";
  constructor(
    private readonly pool: Pick<Pool, "connect">,
    private readonly now: () => Date,
  ) {}

  async reconcile(
    scopes?: readonly QuantityPublicationScope[],
    limit = 25,
  ): Promise<{ resolved: string[]; unresolved: string[]; busy: boolean }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid response recovery limit.");
    const keys = scopes?.map((scope) =>
      quantityPublicationScopeLockKey(
        quantityPublicationScopeSchema.parse(scope),
      ),
    );
    if (keys && (keys.length === 0 || keys.length > 251))
      throw new Error("An exact bounded recovery scope is required.");
    const timestamp = this.now();
    if (!Number.isFinite(timestamp.getTime()))
      throw new Error("Invalid response recovery clock.");
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      // Share the publication gate and exclusively fence each affected scope.
      // Unrelated publishers keep running; TRY-only scope locks prove that no
      // owner of this exact stock is still active without waiting in reverse order.
      const acquired = (
        await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_xact_lock_shared($1,0) AS acquired",
          [QUANTITY_PUBLICATION_LOCK_NAMESPACE],
        )
      ).rows[0]?.acquired;
      if (!acquired) {
        await client.query("COMMIT");
        return { resolved: [], unresolved: [], busy: true };
      }
      const attempts = (
        await client.query<{
          id: string;
          before_record: unknown;
          affected_scope_keys: unknown;
        }>(
          `SELECT a.id::text,to_jsonb(a) AS before_record,a.affected_scope_keys
        FROM inventory.quantity_publication_attempts a
        WHERE a.state IN ('running','uncertain') AND a.owner_kind IN ('legacy','outbox') AND a.scope->>'providerKey'='ebay'
          AND ($1::text[] IS NULL OR a.affected_scope_keys && $1::text[])
          AND ($1::text[] IS NOT NULL OR a.id>$3::bigint)
          AND ($1::text[] IS NOT NULL OR EXISTS(SELECT 1 FROM inventory.quantity_publication_catchup c
            WHERE c.completed_revision<c.revision AND a.affected_scope_keys @> ARRAY[c.scope_key]))
        ORDER BY a.id LIMIT $2 FOR UPDATE OF a SKIP LOCKED`,
          [keys ?? null, limit, this.dueCursor],
        )
      ).rows;
      const resolved: string[] = [],
        unresolved: string[] = [];
      let busy = false;
      for (const attempt of attempts) {
        const ownedKeys = z
          .array(z.string().min(1))
          .min(1)
          .max(251)
          .safeParse(attempt.affected_scope_keys);
        if (!ownedKeys.success) {
          unresolved.push(attempt.id);
          continue;
        }
        let acquiredAll = true;
        for (const scopeKey of [...new Set(ownedKeys.data)].sort()) {
          const locked = (
            await client.query<{ acquired: boolean }>(
              "SELECT pg_try_advisory_xact_lock(hashtextextended($1,918420)) AS acquired",
              [scopeKey],
            )
          ).rows[0]?.acquired;
          if (!locked) {
            acquiredAll = false;
            busy = true;
            break;
          }
        }
        if (!acquiredAll) continue;
        const receipts = (
          await client.query(
            `SELECT q.id::text AS "requestId",q.ordinal,q.method,q.path,q.request_hash AS "requestHash",
          r.outcome,r.http_status AS "httpStatus",r.response_hash AS "responseHash",COALESCE(r.error_codes,'{}') AS "errorCodes",
          CASE WHEN r.recorded_at IS NULL THEN NULL ELSE to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "recordedAt"
          FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
          WHERE q.attempt_id=$1 ORDER BY q.ordinal`,
            [attempt.id],
          )
        ).rows;
        const evidence = terminalEbayResponseEvidence(receipts);
        if (!evidence) {
          unresolved.push(attempt.id);
          continue;
        }
        await client.query(
          `INSERT INTO inventory.quantity_publication_response_recoveries
          (attempt_id,evidence_hash,request_receipts,before_record,created_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)`,
          [
            attempt.id,
            evidence.hash,
            JSON.stringify(evidence.receipts),
            JSON.stringify(attempt.before_record),
            timestamp.toISOString(),
          ],
        );
        await client.query(
          `UPDATE inventory.quantity_publication_attempts SET state='resolved',completed_at=$2,
          outcome_hash=$3,resolution_basis='provider_response_terminal' WHERE id=$1 AND state IN ('running','uncertain')`,
          [attempt.id, timestamp.toISOString(), evidence.hash],
        );
        // Historical delivery is still unknown. A newer admitted publication must
        // prove completion; don't complete catch-up or replay stored quantities.
        await client.query(
          `UPDATE inventory.quantity_publication_catchup SET next_attempt_at=$2,updated_at=$2
          WHERE completed_revision<revision AND scope_key IN (SELECT unnest(affected_scope_keys) FROM inventory.quantity_publication_attempts WHERE id=$1)`,
          [attempt.id, timestamp.toISOString()],
        );
        resolved.push(attempt.id);
      }
      await client.query("COMMIT");
      // Explicit bounded round-robin selection: unprovable requests cannot starve
      // later recoverable work. Restarting repeats evidence checks without effects.
      if (!keys) this.dueCursor = attempts.at(-1)?.id ?? "0";
      return { resolved, unresolved, busy };
    } catch (error) {
      let cause = error;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discard = true;
        cause = new AggregateError(
          [error, rollbackError],
          "Provider response recovery rollback failed.",
        );
      }
      const failure = new QuantityPublicationAdmissionError(
        "PUBLICATION_RESPONSE_RECOVERY_FAILED",
        "Saved request-evidence recovery could not commit. It will be checked again.",
      );
      console.error(
        JSON.stringify({
          operation: "quantity_provider_response_recovery",
          code: failure.code,
          at: timestamp.toISOString(),
          sqlState:
            error instanceof Error && "code" in error ? error.code : null,
        }),
      );
      throw Object.assign(failure, { cause });
    } finally {
      client.release(discard);
    }
  }
}
