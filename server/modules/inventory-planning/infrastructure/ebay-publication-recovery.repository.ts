import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "@shared/utils/canonical-json";
import { ebayPublicationRecoveryPreviewSchema, ebayPublicationRecoveryResultSchema,
  type EbayPublicationRecoveryPreview, type EbayPublicationRecoveryResult } from "@shared/types/ebay-publication-recovery";
import type { EbayPublicationRecoveryCommand, EbayPublicationRecoveryStore } from "../application/ebay-publication-recovery.service";
import { QuantityPublicationAdmissionError, type QuantityPublicationScope } from "../domain/quantity-publication-admission";
import { QUANTITY_PUBLICATION_LOCK_NAMESPACE, quantityPublicationScopeLockKey, retainCatchupScopes } from "./quantity-publication-admission.repository";

const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const OPERATOR_RESUME_COMMAND_CONSTRAINT = "quantity_publication_operator_resumes_idempotency_key_key";
interface AttemptSnapshot {
  id: string;
  state: "running" | "uncertain";
  before_record: string;
  affected_scope_keys: string[];
  skus: string[];
  started_at: Date;
  requests: Array<{ requestId: string; method: string; path: string; httpStatus: number | null;
    responseRecorded: boolean; errorCodes: string[]; outcome: "completed" | "rejected" | "uncertain" | null }>;
  request_evidence: string;
}

/** Inventory owns the fence, immutable decision, and wake-up. No provider I/O.
 * Session owners already hold these exact advisory locks across HTTP, so a live
 * local sender cannot be superseded by this transaction. Unknown remote effects
 * remain explicitly unknown and require an operator's informed authorization. */
export class PostgresEbayPublicationRecoveryRepository implements EbayPublicationRecoveryStore {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async preview(scopes: readonly QuantityPublicationScope[]): Promise<EbayPublicationRecoveryPreview> {
    return this.transaction(async client => {
      const keys = this.keys(scopes);
      const locked = await this.lock(client, keys);
      const attempts = await this.snapshot(client, keys);
      return this.review(keys, attempts, locked);
    });
  }

  async resume(command: EbayPublicationRecoveryCommand): Promise<EbayPublicationRecoveryResult> {
    const keys = this.keys(command.scopes);
    const commandHash = digest({ keys, actor: command.actor, previewHash: command.previewHash,
      acknowledgeUnknownOutcome: command.acknowledgeUnknownOutcome });
    return this.transaction(async client => {
      if (!await this.lock(client, keys)) throw this.failure("EBAY_RECOVERY_BUSY", "An eBay request is still running. Wait for it to finish, then review recovery again.");
      const prior = (await client.query<{ command_hash: string; result_payload: unknown }>(
        "SELECT command_hash,result_payload FROM inventory.quantity_publication_operator_resumes WHERE idempotency_key=$1", [command.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.command_hash !== commandHash) throw this.failure("EBAY_RECOVERY_REPLAY_CONFLICT", "This recovery confirmation was already used for different evidence. Review the current listing again.");
        return ebayPublicationRecoveryResultSchema.parse({ ...ebayPublicationRecoveryResultSchema.parse(prior.result_payload), replayed: true });
      }
      const attempts = await this.snapshot(client, keys);
      const preview = this.review(keys, attempts, true);
      if (!preview.canResume) throw this.failure("EBAY_RECOVERY_SCOPE_CHANGED", "The blocked requests changed or include stock outside this listing. Review recovery again.");
      if (preview.previewHash !== command.previewHash) throw this.failure("EBAY_RECOVERY_PREVIEW_CHANGED", "The recorded eBay response changed after your review. Review the updated details before resuming.");
      const result: EbayPublicationRecoveryResult = { attemptIds: attempts.map(attempt => attempt.id), replayed: false, providerWriteAttempted: false };
      const receipt = (await client.query<{ id: string }>(`INSERT INTO inventory.quantity_publication_operator_resumes
        (idempotency_key,actor,command_hash,preview_hash,scope_keys,review_payload,result_payload,created_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8) RETURNING id::text`,
        [command.idempotencyKey,command.actor,commandHash,preview.previewHash,keys,JSON.stringify(preview),JSON.stringify(result),command.now.toISOString()])).rows[0];
      if (!receipt) throw this.failure("EBAY_RECOVERY_RECEIPT_MISSING", "Recovery could not save its audit record. Nothing was resumed.");
      for (const attempt of attempts) {
        await client.query(`INSERT INTO inventory.quantity_publication_operator_resume_attempts
          (resume_id,attempt_id,before_record,request_evidence) VALUES($1,$2,$3::jsonb,$4::jsonb)`,
          [receipt.id,attempt.id,attempt.before_record,attempt.request_evidence]);
        const updated = await client.query("UPDATE inventory.quantity_publication_attempts SET state='superseded_unknown' WHERE id=$1 AND state IN ('running','uncertain')", [attempt.id]);
        if (updated.rowCount !== 1) throw this.failure("EBAY_RECOVERY_STATE_CHANGED", "The blocked eBay request changed. Review recovery again.");
      }
      // Persist a fresh obligation even if the old owner crashed before retaining
      // catch-up. The canonical worker replans; no historical quantity is copied.
      await retainCatchupScopes(client, command.scopes.filter(scope => scope.productVariantId !== null),
        null, "ebay_operator_resume_unknown_outcome", command.now);
      return result;
    }).catch(error => {
      // Disjoint listing locks do not serialize reuse of one global command key.
      // The transaction has rolled back before translating that exact constraint;
      // other uniqueness failures retain their original diagnostic.
      if (error instanceof Error && "code" in error && error.code === "23505"
        && "constraint" in error && error.constraint === OPERATOR_RESUME_COMMAND_CONSTRAINT) {
        throw this.failure("EBAY_RECOVERY_REPLAY_CONFLICT", "This recovery confirmation was already used for different evidence. Review the current listing again.");
      }
      throw error;
    });
  }

  private keys(scopes: readonly QuantityPublicationScope[]): string[] {
    return [...new Set(scopes.map(quantityPublicationScopeLockKey))].sort();
  }
  private async lock(client: PoolClient, keys: readonly string[]): Promise<boolean> {
    const gate = (await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock_shared($1,0) AS acquired", [QUANTITY_PUBLICATION_LOCK_NAMESPACE])).rows[0];
    if (!gate?.acquired) return false;
    for (const key of keys) {
      if (!(await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,918420)) AS acquired", [key])).rows[0]?.acquired) return false;
    }
    return true;
  }
  private async snapshot(client: PoolClient, keys: readonly string[]): Promise<AttemptSnapshot[]> {
    const attempts = (await client.query<AttemptSnapshot>(`SELECT a.id::text,a.state,to_jsonb(a)::text AS before_record,a.affected_scope_keys,a.started_at,
      ARRAY(SELECT member->>'externalInventoryItemId' FROM jsonb_array_elements(a.affected_scopes) member) AS skus
      FROM inventory.quantity_publication_attempts a WHERE a.state IN ('running','uncertain')
        AND a.scope->>'providerKey'='ebay' AND a.owner_kind IN ('legacy','outbox')
        AND a.affected_scope_keys && $1::text[] ORDER BY a.id LIMIT 101`, [keys])).rows;
    if (attempts.length > 100) throw this.failure("EBAY_RECOVERY_REVIEW_LIMIT", "This listing has more blocked requests than one recovery can review. Ask an inventory administrator to review its publication history.");
    for (const attempt of attempts) {
      const receipts = (await client.query<{ request_id: string; request_record: string; result_record: string | null }>(
        `SELECT q.id::text AS request_id,to_jsonb(q)::text AS request_record,to_jsonb(r)::text AS result_record FROM inventory.quantity_provider_requests q
          LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id WHERE q.attempt_id=$1 ORDER BY q.ordinal LIMIT 2001`, [attempt.id])).rows;
      if (receipts.length > 2000) throw this.failure("EBAY_RECOVERY_REVIEW_LIMIT", "This eBay request has too much history for one recovery review. Ask an inventory administrator to review it.");
      // Preserve database bigint values verbatim in the immutable snapshot.
      // UI fields are parsed separately; identifiers travel as decimal strings.
      attempt.request_evidence = `[${receipts.map(receipt => `{"request_record":${receipt.request_record},"result_record":${receipt.result_record ?? "null"}}`).join(",")}]`;
      attempt.requests = receipts.map(receipt => {
        const request = JSON.parse(receipt.request_record) as Record<string, unknown>;
        const result = receipt.result_record === null ? null : JSON.parse(receipt.result_record) as Record<string, unknown>;
        return {
        requestId: receipt.request_id, method: String(request.method), path: String(request.path),
        httpStatus: result?.http_status === null || result?.http_status === undefined ? null : Number(result.http_status),
        responseRecorded: typeof result?.response_hash === "string",
        errorCodes: (result?.error_codes ?? []) as string[], outcome: (result?.outcome ?? null) as AttemptSnapshot["requests"][number]["outcome"],
      }; });
    }
    return attempts;
  }
  private review(keys: readonly string[], attempts: readonly AttemptSnapshot[], locked: boolean): EbayPublicationRecoveryPreview {
    const requested = new Set(keys);
    const broader = attempts.some(attempt => attempt.affected_scope_keys.some(key => !requested.has(key)));
    return ebayPublicationRecoveryPreviewSchema.parse({
      previewHash: digest({ keys, records: attempts.map(attempt => ({ attempt: attempt.before_record, requests: attempt.request_evidence })) }),
      canResume: locked && !broader && attempts.length > 0,
      blockReason: !locked ? "active_request" : broader ? "broader_scope" : attempts.length === 0 ? "no_pending_attempts" : null,
      attempts: attempts.map(attempt => ({ attemptId: attempt.id, state: attempt.state, skus: attempt.skus,
        startedAt: attempt.started_at.toISOString(), requests: attempt.requests })),
    });
  }
  private failure(code: string, message: string): QuantityPublicationAdmissionError { return new QuantityPublicationAdmissionError(code, message); }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollback) { discard = true; throw new AggregateError([error,rollback], "eBay recovery rollback failed."); }
      throw error;
    } finally { client.release(discard); }
  }
}
