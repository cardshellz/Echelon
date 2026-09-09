import type { InventoryAvailabilityTransactionQueryClient as Client } from "../application/inventory-availability-transaction-query.port";
import type { QuantityPublicationScope } from "../domain/quantity-publication-admission";
import { quantityProviderResponseEvidenceSchema, QuantityProviderEvidenceError,
  type QuantityProviderRequestEvidenceStore, type QuantityProviderRequestStart,
  type QuantityProviderResponseEvidence } from "../application/quantity-provider-request-evidence";

/** Uses the owner's locked connection, but never holds a transaction across HTTP. */
export class PostgresQuantityProviderRequestEvidenceStore implements QuantityProviderRequestEvidenceStore {
  constructor(private readonly client: Client, private readonly attemptId: string,
    private readonly ownerToken: string, private readonly scopes: readonly QuantityPublicationScope[]) {}

  async start(request: QuantityProviderRequestStart): Promise<string> {
    return this.transaction(async () => {
      const row = (await this.client.query<{ id: string }>(`INSERT INTO inventory.quantity_provider_requests
      (attempt_id,ordinal,method,path,request_hash,started_at)
      SELECT id,$3,$4,$5,$6,$7 FROM inventory.quantity_publication_attempts
      WHERE id=$1 AND owner_token=$2 AND state='running' RETURNING id::text`,
    [this.attemptId,this.ownerToken,request.ordinal,request.method,request.path,request.requestHash,request.startedAt])).rows[0];
      if (!row) throw new QuantityProviderEvidenceError();
      return row.id;
    });
  }

  async finish(requestId: string, raw: QuantityProviderResponseEvidence, recordedAt: string): Promise<void> {
    const evidence = quantityProviderResponseEvidenceSchema.parse(raw);
    await this.transaction(async () => {
      const inserted = await this.client.query(`INSERT INTO inventory.quantity_provider_request_results
        (request_id,outcome,http_status,provider_request_id,response_hash,error_codes,retry_not_before,recorded_at,cooldown_scope)
        SELECT r.id,$4,$5,$6,$7,$8,$9,$10,$11 FROM inventory.quantity_provider_requests r
        JOIN inventory.quantity_publication_attempts a ON a.id=r.attempt_id
        WHERE r.id=$1 AND a.id=$2 AND a.owner_token=$3 AND a.state='running' RETURNING request_id`,
      [requestId,this.attemptId,this.ownerToken,evidence.outcome,evidence.httpStatus,evidence.providerRequestId,
        evidence.responseHash,evidence.errorCodes,evidence.retryNotBefore,recordedAt,evidence.cooldownScope]);
      if (inserted.rowCount !== 1) throw new QuantityProviderEvidenceError();
      if (evidence.retryNotBefore) {
        // Empty item is the explicit account-wide key; real provider SKUs are
        // nonempty by the admission schema, so no valid item can collide with it.
        const cooldownScopes = this.scopes.map(scope => ({ ...scope,
          externalInventoryItemId: evidence.cooldownScope === "account" ? "" : scope.externalInventoryItemId }));
        // Group owners conservatively cool every locked member: a listing may share
        // its provider revision quota across variants. Fresh events cannot shorten it.
        await this.client.query(`INSERT INTO inventory.quantity_publication_cooldowns
          (provider_key,provider_scope_type,external_scope_id,external_inventory_item_id,retry_not_before,request_id)
          SELECT DISTINCT incoming."providerKey",incoming."providerScopeType",incoming."externalScopeId",incoming."externalInventoryItemId",$2::timestamptz,$3::bigint
          FROM jsonb_to_recordset($1::jsonb) AS incoming("providerKey" text,"providerScopeType" text,"externalScopeId" text,"externalInventoryItemId" text)
          ORDER BY 1,2,3,4
          ON CONFLICT(provider_key,provider_scope_type,external_scope_id,external_inventory_item_id)
          DO UPDATE SET retry_not_before=EXCLUDED.retry_not_before,request_id=EXCLUDED.request_id
          WHERE quantity_publication_cooldowns.retry_not_before<EXCLUDED.retry_not_before`,
        [JSON.stringify(cooldownScopes),evidence.retryNotBefore,requestId]);
      }
    });
  }

  private async transaction<T>(work: () => Promise<T>): Promise<T> {
    await this.client.query("BEGIN");
    try {
      await this.client.query("SET LOCAL lock_timeout='2s'");
      await this.client.query("SET LOCAL statement_timeout='10s'");
      await this.client.query("SET LOCAL idle_in_transaction_session_timeout='15s'");
      const result = await work();
      await this.client.query("COMMIT");
      return result;
    } catch (error) {
      try { await this.client.query("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error,rollbackError], "Quantity response evidence rollback failed."); }
      throw error;
    }
  }
}
