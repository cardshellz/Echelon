import type { Pool } from "pg";
import { QuantityPublicationAdmissionError } from "../domain/quantity-publication-admission";
import { ebayAutomaticRecoveryCommandSchema, sortedRecoveryScopes, supportsAutomaticEbayReplacement,
  type EbayAutomaticRecoveryInput, type SavedEbayRequestOperation } from "../domain/ebay-automatic-publication-recovery";
import type { EbayAutomaticPublicationRecoveryStore, EbayAutomaticRecoveryResult } from "../application/ebay-automatic-publication-recovery.service";
import { quantityPublicationScopeLockKey, retainCatchupScopes } from "./quantity-publication-admission.repository";
import { reconciliationHash, reconciliationFailure, tryLockReconciliationScopes, withReconciliationTransaction } from "./ebay-publication-reconciliation.persistence";

interface AttemptRow {
  id: string; owner_kind: string; before_record: string; affected_scope_keys: string[]; outbox_scope_proven: boolean;
}

export class PostgresEbayAutomaticPublicationRecoveryRepository implements EbayAutomaticPublicationRecoveryStore {
  constructor(private readonly pool: Pick<Pool, "connect">) {}
  async recover(raw: EbayAutomaticRecoveryInput & { now: Date }): Promise<EbayAutomaticRecoveryResult> {
    const { now, ...input } = raw;
    const command = ebayAutomaticRecoveryCommandSchema.parse(input);
    const scopes = sortedRecoveryScopes(command.scopes);
    const keys = scopes.map(quantityPublicationScopeLockKey).sort();
    const scopeHash = reconciliationHash(scopes);
    return withReconciliationTransaction(this.pool, async client => {
      if (!await tryLockReconciliationScopes(client, keys)) return { superseded: [], unresolved: [], busy: true, watchId: null };
      const attempts = (await client.query<AttemptRow>(`SELECT a.id::text,a.owner_kind,to_jsonb(a)::text AS before_record,a.affected_scope_keys,
        (a.owner_kind='outbox' AND cardinality(a.affected_scope_keys)=1 AND EXISTS(
          SELECT 1 FROM inventory.inventory_publication_outbox o WHERE o.id=a.outbox_id
          AND o.provider_key_snapshot='ebay' AND o.provider_scope_type_snapshot='account'
          AND o.destination_kind_snapshot=a.scope->>'destinationKind'
          AND COALESCE(o.channel_connection_id_snapshot,o.dropship_store_connection_id_snapshot)::text=a.scope->>'connectionId'
          AND o.external_scope_id_snapshot=a.scope->>'externalScopeId'
          AND o.external_inventory_item_id_snapshot=a.scope->>'externalInventoryItemId'
          AND o.product_variant_id::text=a.scope->>'productVariantId')) AS outbox_scope_proven
        FROM inventory.quantity_publication_attempts a WHERE a.state IN ('running','uncertain')
          AND a.scope->>'providerKey'='ebay' AND a.affected_scope_keys && $1::text[]
        ORDER BY a.id LIMIT 101 FOR UPDATE OF a`, [keys])).rows;
      if (attempts.length > 100) throw reconciliationFailure("PUBLICATION_AUTOMATIC_RECOVERY_LIMIT", "This listing exceeds the bounded automatic recovery review. Review its retained request history.");
      const existing = (await client.query<{ id: string; scope_hash: string }>(`SELECT id::text,scope_hash FROM inventory.ebay_publication_reconciliation_watches
        WHERE product_id=$1 AND connection_id=$2 AND external_scope_id=$3 AND scope_hash=$4 FOR UPDATE`,
      [scopes[0]!.productId, scopes[0]!.connectionId, scopes[0]!.externalScopeId, scopeHash])).rows[0];
      if (attempts.length === 0) {
        const prior = (await client.query<{ attempt_id: string }>(`SELECT attempt_id::text FROM inventory.ebay_automatic_publication_recoveries
          WHERE sync_job_id=$1 AND sync_revision=$2 AND scope_hash=$3 ORDER BY attempt_id DESC LIMIT 100`,
        [command.syncJobId, command.syncRevision, scopeHash])).rows;
        // The channel owner uses watchId only to request current readiness. A
        // related obligation still needs that preparation after membership
        // changes, but this read must not rebind its immutable identity/receipt.
        const related = existing ?? (await client.query<{ id: string }>(`SELECT id::text FROM inventory.ebay_publication_reconciliation_watches
          WHERE product_id=$1 AND connection_id=$2 AND external_scope_id=$3 ORDER BY id LIMIT 1`,
        [scopes[0]!.productId, scopes[0]!.connectionId, scopes[0]!.externalScopeId])).rows[0];
        return { superseded: prior.map(row => row.attempt_id), unresolved: [], busy: false, watchId: related?.id ?? null };
      }
      const requested = new Set(keys);
      const evidence = new Map<string, string>();
      for (const attempt of attempts) {
        const receipts = (await client.query<{ ordinal: number; method: string; path: string; request_record: string; result_record: string | null }>(
          `SELECT q.ordinal,q.method,q.path,to_jsonb(q)::text AS request_record,to_jsonb(r)::text AS result_record
           FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
           WHERE q.attempt_id=$1 ORDER BY q.ordinal LIMIT 2001`, [attempt.id])).rows;
        if (attempt.affected_scope_keys.length === 0 || attempt.affected_scope_keys.some(key => !requested.has(key))
          || !supportsAutomaticEbayReplacement({ owner: attempt.owner_kind, outboxScopeProven: attempt.outbox_scope_proven,
            requests: receipts as SavedEbayRequestOperation[] })) {
          return { superseded: [], unresolved: attempts.map(row => row.id), busy: false, watchId: existing?.id ?? null };
        }
        // Preserve bigint identifiers and all missing result records verbatim.
        evidence.set(attempt.id, `[${receipts.map(row => `{"request_record":${row.request_record},"result_record":${row.result_record ?? "null"}}`).join(",")}]`);
      }
      const watch = (await client.query<{ id: string }>(`INSERT INTO inventory.ebay_publication_reconciliation_watches
        (product_id,connection_id,external_scope_id,scope_hash,scopes,next_check_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$6,$6)
        ON CONFLICT(product_id,connection_id,external_scope_id,scope_hash) DO UPDATE SET revision=ebay_publication_reconciliation_watches.revision+1,
          cycle=ebay_publication_reconciliation_watches.cycle+1,next_check_at=$6,updated_at=$6,
          state='pending',last_error_code=NULL,last_error_message=NULL,lease_token=NULL,lease_expires_at=NULL
        RETURNING id::text`, [scopes[0]!.productId, scopes[0]!.connectionId, scopes[0]!.externalScopeId,
        scopeHash, JSON.stringify(scopes), now.toISOString()])).rows[0]!;
      for (const attempt of attempts) {
        await client.query(`INSERT INTO inventory.ebay_automatic_publication_recoveries
          (attempt_id,sync_job_id,sync_revision,watch_id,scope_hash,scope_keys,before_record,request_evidence,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`, [attempt.id, command.syncJobId, command.syncRevision,
          watch.id, scopeHash, keys, attempt.before_record, evidence.get(attempt.id), now.toISOString()]);
        const updated = await client.query("UPDATE inventory.quantity_publication_attempts SET state='superseded_unknown' WHERE id=$1 AND state IN ('running','uncertain')", [attempt.id]);
        if (updated.rowCount !== 1) throw reconciliationFailure("PUBLICATION_AUTOMATIC_RECOVERY_CHANGED", "A prior inventory request changed during recovery.");
      }
      await retainCatchupScopes(client, scopes.filter(scope => scope.productVariantId !== null), null, "ebay_automatic_sync_recovery", now);
      return { superseded: attempts.map(row => row.id), unresolved: [], busy: false, watchId: watch.id };
    }).catch(error => {
      if (error instanceof QuantityPublicationAdmissionError) throw error;
      const sqlState = error instanceof Error && "code" in error && typeof error.code === "string"
        && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
      console.error(JSON.stringify({ event: "ebay_automatic_publication_recovery_failed", syncJobId: command.syncJobId,
        code: "PUBLICATION_AUTOMATIC_RECOVERY_FAILED", sqlState }));
      throw Object.assign(reconciliationFailure("PUBLICATION_AUTOMATIC_RECOVERY_FAILED",
        "The saved inventory recovery could not commit. Sync will retry automatically without changing the old request evidence."), { cause: error });
    });
  }
}
