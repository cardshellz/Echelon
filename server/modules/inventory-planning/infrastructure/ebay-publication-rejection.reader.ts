import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { InventoryAvailabilityTransactionQueryClient as Client } from "../application/inventory-availability-transaction-query.port";
import { quantityPublicationScopeSchema } from "../domain/quantity-publication-admission";
import { isEbayPublicationRequest, isRejectedEbayPublicationReceipt, terminalEbayResponseEvidence,
  type TerminalRequestReceipt } from "../domain/quantity-provider-terminal-response";
import { QUANTITY_PUBLICATION_LOCK_NAMESPACE, quantityPublicationScopeLockKey } from "./quantity-publication-admission.repository";

const inputSchema = z.object({
  scopes: z.array(quantityPublicationScopeSchema).min(1).max(251),
  startedAt: z.string().datetime(),
  groupKey: z.string().min(1).max(255).nullable(),
  offerIds: z.array(z.string().regex(/^[^/?#\s]{1,255}$/)).min(1).max(250),
  marketplaceId: z.string().regex(/^EBAY_[A-Z_]{2,30}$/),
}).strict().superRefine((value, context) => {
  const first = value.scopes[0];
  if (value.scopes.some(scope => scope.providerKey !== "ebay" || scope.providerScopeType !== "account"
    || scope.destinationKind !== first.destinationKind || scope.connectionId !== first.connectionId
    || scope.externalScopeId !== first.externalScopeId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Publication rejection requires one exact eBay account and connection." });
  }
  if ((value.groupKey === null && value.offerIds.length !== 1)
    || (value.groupKey !== null && !value.scopes.some(scope => scope.externalInventoryItemId === `group:${value.groupKey}`))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Publication rejection requires the exact group or single offer scope." });
  }
});

export type EbayPublicationRejectionInput = z.infer<typeof inputSchema>;
export type EbayPublicationRejectedRequest = TerminalRequestReceipt & { attemptId: string; startedAt: string };
export interface EbayPublicationRejectionEvidence {
  hash: string;
  attemptIds: string[];
  requests: EbayPublicationRejectedRequest[];
}
export interface EbayPublicationRejectionRead {
  busy: boolean;
  evidence: EbayPublicationRejectionEvidence | null;
}
export interface EbayPublicationRejectionReader {
  read(input: EbayPublicationRejectionInput, client?: Client): Promise<EbayPublicationRejectionRead>;
}
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const noEvidence = (): EbayPublicationRejectionRead => ({ busy: false, evidence: null });

/** Read-only proof for a saved publish stage. The supplied transaction retains
 * exact scope locks until its owner appends the channels recovery receipt. This
 * never changes inventory evidence, acknowledges quantity, or sends provider I/O. */
export class PostgresEbayPublicationRejectionReader implements EbayPublicationRejectionReader {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async read(raw: EbayPublicationRejectionInput, transactionClient?: Client): Promise<EbayPublicationRejectionRead> {
    const input = inputSchema.parse(raw);
    if (transactionClient) return this.readInsideTransaction(input, transactionClient);
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout='10s'");
      const result = await this.readInsideTransaction(input, client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollback) { discard = true; throw new AggregateError([error, rollback], "Publication rejection proof rollback failed."); }
      throw error;
    } finally { client.release(discard); }
  }

  private async readInsideTransaction(input: EbayPublicationRejectionInput, client: Client): Promise<EbayPublicationRejectionRead> {
    const keys = [...new Set(input.scopes.map(quantityPublicationScopeLockKey))].sort();
    const gate = (await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock_shared($1,0) AS acquired", [QUANTITY_PUBLICATION_LOCK_NAMESPACE])).rows[0];
    if (!gate?.acquired) return { busy: true, evidence: null };
    for (const key of keys) {
      const lock = (await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,918420)) AS acquired", [key])).rows[0];
      if (!lock?.acquired) return { busy: true, evidence: null };
    }
    // Include terminal attempts: a prior recovery may have committed before the
    // listing job saved its own checkpoint. No response is inferred from state.
    const attempts = (await client.query<{ id: string; affected_scope_keys: string[] }>(
      `SELECT a.id::text,a.affected_scope_keys FROM inventory.quantity_publication_attempts a
       WHERE a.scope->>'providerKey'='ebay' AND a.affected_scope_keys && $1::text[]
         AND EXISTS(SELECT 1 FROM inventory.quantity_provider_requests q WHERE q.attempt_id=a.id
           AND q.started_at >= $2::timestamptz AND q.method='POST'
           AND (q.path='/sell/inventory/v1/offer/publish_by_inventory_item_group'
             OR q.path ~ '^/sell/inventory/v1/offer/[^/?#[:space:]]+/publish$'))
       ORDER BY a.id LIMIT 101`, [keys, input.startedAt])).rows;
    if (attempts.length === 0 || attempts.length > 100) return noEvidence();
    const expectedPath = input.groupKey === null
      ? `/sell/inventory/v1/offer/${input.offerIds[0]}/publish`
      : "/sell/inventory/v1/offer/publish_by_inventory_item_group";
    const expectedRequestHash = digest(input.groupKey === null ? null
      : { inventoryItemGroupKey: input.groupKey, marketplaceId: input.marketplaceId });
    const requests: EbayPublicationRejectedRequest[] = [];
    for (const attempt of attempts) {
      if (!Array.isArray(attempt.affected_scope_keys) || attempt.affected_scope_keys.length === 0
        || attempt.affected_scope_keys.some(key => !keys.includes(key))) return noEvidence();
      const rows = (await client.query<TerminalRequestReceipt & { startedAt: string }>(
        `SELECT q.id::text AS "requestId",q.ordinal,q.method,q.path,q.request_hash AS "requestHash",
          to_char(q.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt",
          r.outcome,r.http_status AS "httpStatus",r.response_hash AS "responseHash",COALESCE(r.error_codes,'{}') AS "errorCodes",
          r.request_terminated AS "requestTerminated",
          CASE WHEN r.recorded_at IS NULL THEN NULL ELSE to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "recordedAt"
         FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
         WHERE q.attempt_id=$1 ORDER BY q.ordinal LIMIT 2001`, [attempt.id])).rows;
      if (!terminalEbayResponseEvidence(rows.map(({ startedAt: _startedAt, ...receipt }) => receipt))) return noEvidence();
      const publications = rows.filter(row => isEbayPublicationRequest(row.method, row.path)
        && Date.parse(row.startedAt) >= Date.parse(input.startedAt));
      if (publications.length === 0 || publications.some(row => row.path !== expectedPath || row.requestHash !== expectedRequestHash
        || !isRejectedEbayPublicationReceipt(row))) return noEvidence();
      requests.push(...publications.map(row => ({ ...row, attemptId: attempt.id })));
      if (requests.length > 2000) return noEvidence();
    }
    const evidence = { attemptIds: attempts.map(attempt => attempt.id), requests };
    return { busy: false, evidence: { ...evidence, hash: digest(evidence) } };
  }
}
