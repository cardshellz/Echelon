import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { InventoryAvailabilityTransactionQueryClient as Client } from "../application/inventory-availability-transaction-query.port";
import { quantityPublicationScopeSchema } from "../domain/quantity-publication-admission";
import { isEbayPublicationRequest, isRejectedEbayPublicationReceipt, terminalEbayResponseEvidence,
  type TerminalRequestReceipt } from "../domain/quantity-provider-terminal-response";
import { QUANTITY_PUBLICATION_LOCK_NAMESPACE, quantityPublicationScopeLockKey } from "./quantity-publication-admission.repository";
import { attributeEbayOutboxStockHistory, ebayRequestJournalContractSchema, isCompletedEbayNonPublicationAttempt, legacyEbayPublicationPreflightProofSchema,
  terminalEbayPublicationPreparationEvidence, type EbayNoRequestProof,
  type EbayRequestJournalContract, type LegacyEbayPublicationPreflightProof } from "../domain/ebay-publication-preflight";
import { journalContractNoRequestProof, recoverNoRequestAttemptInsideTransaction } from "./quantity-provider-preflight-recovery.repository";
import { recoverTerminalRequestAttemptInsideTransaction } from "./quantity-provider-response-recovery.repository";

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
  recoverNotSent?(input: EbayPublicationRejectionInput & { legacyPreflightProof?: LegacyEbayPublicationPreflightProof;
    stageJournalContract?: EbayRequestJournalContract },
    client: Client): Promise<EbayPublicationNotSentRead>;
}
export interface EbayPublicationNotSentRead {
  busy: boolean;
  evidence: { hash: string; attemptIds: string[]; proofs: Array<{ attemptId: string; proof: EbayNoRequestProof }>;
    preparations?: Array<{ attemptId: string; contract: EbayRequestJournalContract; requests: TerminalRequestReceipt[]; requestEvidenceHash: string }>;
    stageJournalContract?: EbayRequestJournalContract;
    excludedStockHistory?: ExcludedEbayStockHistory } | null;
}
export interface ExcludedEbayStockHistory {
  count: number;
  preflightNotSentCount: number;
  supersededUnknownCount: number;
  firstAttemptId: string;
  lastAttemptId: string;
  evidenceHash: string;
}
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const noEvidence = (): EbayPublicationRejectionRead => ({ busy: false, evidence: null });
const ATTEMPT_PAGE_SIZE = 100;
const MAX_PUBLICATION_CANDIDATES = 100;
type PreflightAttempt = { id: string; before_record: Record<string, unknown>; affected_scope_keys: string[]; started_at: Date;
  before_record_text: string; outbox_scope_proven: boolean; replacement_receipt_proven: boolean;
  outbox_identity: string | null; replacement_receipt: string | null; has_requests: boolean };

/** Terminal evidence for a saved publish stage. The supplied transaction retains
 * exact scope locks until its owner appends the channels recovery checkpoint.
 * No method acknowledges quantity or sends provider I/O. */
export class PostgresEbayPublicationRejectionReader implements EbayPublicationRejectionReader {
  constructor(private readonly pool: Pick<Pool, "connect">, private readonly clock: () => Date = () => new Date()) {}

  /** The channel owns its publish-stage checkpoint. Recover the inventory
   * attempt in that same transaction so a crash cannot commit half a recovery.
   * A journal contract proves only the exact original mutation identified here;
   * historical callbacks additionally require the channel's immutable event proof. */
  async recoverNotSent(raw: EbayPublicationRejectionInput & { legacyPreflightProof?: LegacyEbayPublicationPreflightProof;
    stageJournalContract?: EbayRequestJournalContract },
    client: Client): Promise<EbayPublicationNotSentRead> {
    const { legacyPreflightProof: historical, stageJournalContract: stageRaw, ...base } = raw;
    const input = inputSchema.parse(base);
    const legacy = historical === undefined ? null : legacyEbayPublicationPreflightProofSchema.parse(historical);
    const stageContract = stageRaw === undefined ? null : ebayRequestJournalContractSchema.parse(stageRaw);
    if (legacy && (legacy.groupKey !== input.groupKey || legacy.marketplaceId !== input.marketplaceId
      || Date.parse(legacy.stageStartedAt) !== Date.parse(input.startedAt))) return { busy: false, evidence: null };
    const timestamp = this.clock();
    if (!Number.isFinite(timestamp.getTime())) throw new Error("Invalid publication preflight recovery clock.");
    const keys = [...new Set(input.scopes.map(quantityPublicationScopeLockKey))].sort();
    const gate = (await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock_shared($1,0) AS acquired", [QUANTITY_PUBLICATION_LOCK_NAMESPACE])).rows[0];
    if (!gate?.acquired) return { busy: true, evidence: null };
    for (const key of keys) {
      const locked = (await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,918420)) AS acquired", [key])).rows[0];
      if (!locked?.acquired) return { busy: true, evidence: null };
    }
    const expectedPath = input.groupKey === null ? `/sell/inventory/v1/offer/${encodeURIComponent(input.offerIds[0])}/publish`
      : "/sell/inventory/v1/offer/publish_by_inventory_item_group";
    const expectedHash = digest(input.groupKey === null ? null : { inventoryItemGroupKey: input.groupKey, marketplaceId: input.marketplaceId });
    if (stageContract && (stageContract.method !== "POST" || stageContract.path !== expectedPath
      || stageContract.requestHash !== expectedHash)) return { busy: false, evidence: null };
    const history = await this.readPreflightCandidates(client, keys, input.startedAt);
    if (!history || (!history.attempts.length && !stageContract)) return { busy: false, evidence: null };
    const { attempts, excludedStockHistory } = history;
    const proofs: Array<{ attemptId: string; proof: EbayNoRequestProof }> = [];
    const preparations: Array<{ attemptId: string; evidence: NonNullable<ReturnType<typeof terminalEbayPublicationPreparationEvidence>> }> = [];
    const legacyCandidates = attempts.filter(attempt => !attempt.before_record.request_journal_contract);
    for (const attempt of attempts) {
      if (!attempt.affected_scope_keys.length || attempt.affected_scope_keys.some(key => !keys.includes(key))) return { busy: false, evidence: null };
      const state = String(attempt.before_record.state);
      const requests = attempt.has_requests ? await this.readRequestReceipts(client, attempt.id) : [];
      const preparation = terminalEbayPublicationPreparationEvidence(attempt.before_record.request_journal_contract,
        { path: expectedPath, requestHash: expectedHash }, requests);
      if (preparation && ["running", "uncertain", "resolved", "rejected", "succeeded"].includes(state)) {
        preparations.push({ attemptId: attempt.id, evidence: preparation });
        continue;
      }
      if (requests.length || !["running", "uncertain", "not_sent"].includes(state)) return { busy: false, evidence: null };
      let proof = journalContractNoRequestProof(attempt);
      if (proof?.source === "request_journal_contract") {
        if (proof.contract.method !== "POST" || proof.contract.path !== expectedPath || proof.contract.requestHash !== expectedHash)
          return { busy: false, evidence: null };
      } else {
        if (!legacy || legacyCandidates.length !== 1 || attempt.before_record.owner_kind !== "legacy"
          || attempt.started_at.getTime() > Date.parse(legacy.failureAt)
          || attempt.affected_scope_keys.length !== keys.length) return { busy: false, evidence: null };
        const actualScopes = z.array(quantityPublicationScopeSchema).safeParse(attempt.before_record.affected_scopes);
        const root = quantityPublicationScopeSchema.safeParse(attempt.before_record.scope);
        if (!actualScopes.success || !root.success || root.data.externalInventoryItemId !== `group:${legacy.groupKey}`)
          return { busy: false, evidence: null };
        const members = actualScopes.data.filter(scope => scope.externalInventoryItemId !== root.data.externalInventoryItemId)
          .map(scope => scope.externalInventoryItemId).sort();
        if (canonicalJson(members) !== canonicalJson(legacy.memberSkus)) return { busy: false, evidence: null };
        proof = { source: "legacy_publish_preflight", evidence: legacy };
        if (attempt.before_record.state === "not_sent") {
          const retained = (await client.query<{ proof: unknown }>(
            "SELECT proof FROM inventory.quantity_publication_no_request_recoveries WHERE attempt_id=$1", [attempt.id])).rows;
          if (retained.length !== 1 || canonicalJson(retained[0].proof) !== canonicalJson(proof)) return { busy: false, evidence: null };
        }
      }
      proofs.push({ attemptId: attempt.id, proof });
    }
    // Validate every candidate before the first mutation. Partial proof must not
    // release any old attempt when a later publication might have been sent.
    for (const attempt of attempts) {
      const preparation = preparations.find(row => row.attemptId === attempt.id);
      if (preparation) {
        if (["running", "uncertain"].includes(String(attempt.before_record.state)))
          await recoverTerminalRequestAttemptInsideTransaction(client, attempt, preparation.evidence.terminal, timestamp);
        continue;
      }
      if (attempt.before_record.state === "not_sent") continue;
      const proof = proofs.find(row => row.attemptId === attempt.id)!.proof;
      if (!await recoverNoRequestAttemptInsideTransaction(client, attempt, proof, timestamp))
        throw new Error("Publication preflight evidence changed inside its exact scope lock.");
    }
    // A newly journaled channel stage can crash before the first admission (for
    // example during its initial group GET). Its owner holds the channel job
    // lock; these inventory locks prove no admitted attempt exists. Preserve the
    // channel's original contract in its checkpoint rather than inventing an
    // inventory attempt or assuming an unversioned legacy stage was instrumented.
    const evidence = { attemptIds: attempts.map(row => row.id), proofs,
      ...(preparations.length ? { preparations: preparations.map(row => ({ attemptId: row.attemptId,
        contract: row.evidence.contract, requests: row.evidence.terminal.receipts, requestEvidenceHash: row.evidence.terminal.hash })) } : {}),
      ...(stageContract ? { stageJournalContract: stageContract } : {}),
      ...(excludedStockHistory ? { excludedStockHistory } : {}) };
    return { busy: false, evidence: { ...evidence, hash: digest(evidence) } };
  }

  private async readPreflightCandidates(client: Client, keys: string[], startedAt: string): Promise<{
    attempts: PreflightAttempt[]; excludedStockHistory?: ExcludedEbayStockHistory;
  } | null> {
    const candidates: PreflightAttempt[] = [];
    const evidenceHash = createHash("sha256");
    let count = 0, preflightNotSentCount = 0, supersededUnknownCount = 0;
    let firstAttemptId = "", lastAttemptId = "";
    let afterId = "0";
    // Keyset pages bound memory without an age/history ceiling. All exact scope
    // locks are already held, so no live owner can append requests while these
    // immutable terminal histories are inspected.
    for (;;) {
      const page = (await client.query<PreflightAttempt>(
        `SELECT a.id::text,to_jsonb(a) AS before_record,to_jsonb(a)::text AS before_record_text,a.affected_scope_keys,a.started_at,
          (a.owner_kind='outbox' AND a.affected_scope_keys=ARRAY[a.scope_key]
            AND a.scope->>'providerScopeType'='account' AND o.provider_key_snapshot='ebay'
            AND o.provider_scope_type_snapshot='account' AND o.activation_run_id IS NOT NULL
            AND o.destination_kind_snapshot=a.scope->>'destinationKind'
            AND COALESCE(o.channel_connection_id_snapshot,o.dropship_store_connection_id_snapshot)::text=a.scope->>'connectionId'
            AND o.external_scope_id_snapshot=a.scope->>'externalScopeId'
            AND o.external_inventory_item_id_snapshot=a.scope->>'externalInventoryItemId'
            AND o.product_variant_id::text=a.scope->>'productVariantId') IS TRUE AS outbox_scope_proven,
          (r.before_record-'state'=to_jsonb(a)-'state'
            AND r.request_evidence=COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'request_record',to_jsonb(q),'result_record',to_jsonb(result)) ORDER BY q.ordinal)
              FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results result ON result.request_id=q.id
              WHERE q.attempt_id=a.id),'[]'::jsonb)
            AND a.affected_scope_keys <@ r.scope_keys AND w.scope_hash=r.scope_hash
            AND w.connection_id::text=a.scope->>'connectionId' AND w.external_scope_id=a.scope->>'externalScopeId'
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(w.scopes) s
              WHERE s->>'destinationKind'=a.scope->>'destinationKind' AND s->>'providerKey'='ebay'
                AND s->>'providerScopeType'='account' AND s->>'connectionId'=a.scope->>'connectionId'
                AND s->>'externalScopeId'=a.scope->>'externalScopeId'
                AND s->>'externalInventoryItemId'=a.scope->>'externalInventoryItemId'
                AND s->>'productVariantId'=a.scope->>'productVariantId')) IS TRUE AS replacement_receipt_proven,
          CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object('id',o.id::text,'activationRunId',o.activation_run_id::text,
            'publicationTargetId',o.publication_target_id,'targetRevision',o.publication_target_revision_snapshot::text,
            'desiredRevision',o.desired_revision::text,'payloadHash',o.payload_hash)::text END AS outbox_identity,
          to_jsonb(r)::text AS replacement_receipt,
          EXISTS(SELECT 1 FROM inventory.quantity_provider_requests q WHERE q.attempt_id=a.id) AS has_requests
         FROM inventory.quantity_publication_attempts a
         LEFT JOIN inventory.inventory_publication_outbox o ON o.id=a.outbox_id
         LEFT JOIN inventory.ebay_automatic_publication_recoveries r ON r.attempt_id=a.id
         LEFT JOIN inventory.ebay_publication_reconciliation_watches w ON w.id=r.watch_id
         WHERE a.scope->>'providerKey'='ebay' AND a.affected_scope_keys && $1::text[]
           AND a.started_at >= $2 AND a.id > $3::bigint
         ORDER BY a.id LIMIT $4 FOR UPDATE OF a`, [keys, startedAt, afterId, ATTEMPT_PAGE_SIZE])).rows;
      for (const attempt of page) {
        const state = String(attempt.before_record.state);
        // The held scope locks fence request insertion. Snapshot empty journals
        // with the page, avoiding one round trip per retained stock failure.
        const receipts = attempt.has_requests ? await this.readRequestReceipts(client, attempt.id) : [];
        const attribution = attributeEbayOutboxStockHistory({ state,
          journalContract: attempt.before_record.request_journal_contract,
          outboxScopeProven: attempt.outbox_scope_proven, replacementReceiptProven: attempt.replacement_receipt_proven,
          resolutionBasis: attempt.before_record.resolution_basis, outcomeHash: attempt.before_record.outcome_hash,
          completedAt: attempt.before_record.completed_at }, receipts);
        if (attribution) {
          count += 1;
          if (attribution === "owner_preflight_not_sent") preflightNotSentCount += 1;
          else supersededUnknownCount += 1;
          if (!firstAttemptId) firstAttemptId = attempt.id;
          lastAttemptId = attempt.id;
          // Hash exact PostgreSQL JSON text so bigint identifiers are never
          // rounded. Fixed-size ordered digests keep arbitrarily long stock
          // history bounded, while every source row remains immutable/auditable.
          evidenceHash.update(digest({ attribution, attempt: attempt.before_record_text,
            outbox: attempt.outbox_identity, replacement: attempt.replacement_receipt }));
          continue;
        }
        if (["succeeded", "resolved", "rejected", "not_sent"].includes(state)) {
          if (isCompletedEbayNonPublicationAttempt({ state, journalContract: attempt.before_record.request_journal_contract,
            canonicalOutboxStock: attempt.before_record.owner_kind === "outbox" && attempt.before_record.outbox_id != null
              && attempt.affected_scope_keys.length === 1 }, receipts)) continue;
        }
        candidates.push(attempt);
        if (candidates.length > MAX_PUBLICATION_CANDIDATES) return null;
      }
      if (page.length < ATTEMPT_PAGE_SIZE) return { attempts: candidates, ...(count ? {
        excludedStockHistory: { count, preflightNotSentCount, supersededUnknownCount,
          firstAttemptId, lastAttemptId, evidenceHash: evidenceHash.digest("hex") },
      } : {}) };
      afterId = page[page.length - 1].id;
    }
  }

  private async readRequestReceipts(client: Client, attemptId: string): Promise<TerminalRequestReceipt[]> {
    return (await client.query<TerminalRequestReceipt>(`SELECT q.id::text AS "requestId",q.ordinal,q.method,q.path,
      q.request_hash AS "requestHash",r.outcome,r.http_status AS "httpStatus",r.response_hash AS "responseHash",
      COALESCE(r.error_codes,'{}') AS "errorCodes",r.request_terminated AS "requestTerminated",
      CASE WHEN r.recorded_at IS NULL THEN NULL ELSE to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS "recordedAt"
      FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
      WHERE q.attempt_id=$1 ORDER BY q.ordinal LIMIT 2001`, [attemptId])).rows;
  }

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
      ? `/sell/inventory/v1/offer/${encodeURIComponent(input.offerIds[0])}/publish`
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
