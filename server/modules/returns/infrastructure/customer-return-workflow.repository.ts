import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { customerReturnLabelSubmitInputSchema } from "@shared/returns/customer-return-label.contract";
import { customerReturnCanonicalOrderScopeSchema } from "../application/customer-return-order-access.service";
import { customerReturnCustomerPrincipalSchema, type CustomerReturnCustomerPrincipal } from "../application/customer-return-customer-operations.service";
import { CustomerReturnIntakeError } from "../application/customer-return-intake.ports";
import { customerReturnSubmissionHash } from "../application/customer-return-intake-preparation";
import { returnWorkflowRecordSchema, type CustomerReturnWorkflowStore, type ReturnWorkflowRecord, type ReturnWorkflowTransition } from "../application/customer-return-workflow.ports";

export const RETURN_WORKFLOW_LEASE_MS = 300_000;
const keySchema = z.string().uuid();
const idSchema = z.number().int().positive().safe();
const ownedScope = `o.id=w.oms_order_id AND o.channel_id=w.channel_id
  AND o.external_customer_id=w.scope_snapshot->>'externalCustomerId'
  AND regexp_replace(o.external_order_id,'^gid://shopify/Order/','')=regexp_replace(w.scope_snapshot->>'externalOrderId','^gid://shopify/Order/','')`;

/** Stores only explicit customer intent. No source order or inventory writes. */
export class PostgresCustomerReturnWorkflowStore implements CustomerReturnWorkflowStore {
  constructor(private readonly pool: Pool) {}

  async enqueue(raw: Parameters<CustomerReturnWorkflowStore["enqueue"]>[0]): Promise<ReturnWorkflowRecord> {
    const request = customerReturnLabelSubmitInputSchema.parse(raw.request);
    const scope = customerReturnCanonicalOrderScopeSchema.parse(raw.scope);
    const actor = z.string().trim().min(1).max(255).parse(raw.actor);
    const now = z.date().parse(raw.now);
    const authorizationId = raw.authorizationId === undefined ? null : idSchema.parse(raw.authorizationId);
    if (request.channelId !== scope.channelId) throw conflict();
    const hash = customerReturnSubmissionHash(request, scope.omsOrderId);
    return this.transaction(async client => {
      const source = await client.query(`SELECT id FROM oms.oms_orders WHERE id=$1 AND channel_id=$2
        AND external_customer_id=$3 AND regexp_replace(external_order_id,'^gid://shopify/Order/','')=$4 FOR KEY SHARE`,
      [scope.omsOrderId, scope.channelId, scope.externalCustomerId, scope.externalOrderId.replace(/^gid:\/\/shopify\/Order\//, "")]);
      if (source.rowCount !== 1) throw unavailable();
      const command = (await client.query(`SELECT oms_order_id,request_hash,authorization_id,status FROM returns.customer_return_submission_commands
        WHERE channel_id=$1 AND idempotency_key=$2`, [scope.channelId, request.idempotencyKey])).rows[0];
      if (authorizationId !== null) {
        const authorization = await client.query(`SELECT id FROM returns.customer_return_authorizations
          WHERE id=$1 AND channel_id=$2 AND oms_order_id=$3 FOR KEY SHARE`, [authorizationId, scope.channelId, scope.omsOrderId]);
        if (authorization.rowCount !== 1 || !command || command.status !== "accepted" || Number(command.authorization_id) !== authorizationId) throw conflict();
      } else if (command && (Number(command.oms_order_id) !== scope.omsOrderId || command.request_hash !== hash)) throw conflict();
      const inserted = await client.query(`INSERT INTO returns.customer_return_workflows
        (channel_id,request_key,oms_order_id,request_snapshot,scope_snapshot,semantic_hash,actor,phase,next_run_at,created_at,updated_at,authorization_id)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,CASE WHEN $9::bigint IS NULL THEN 'queued' ELSE 'labels' END,$8,$8,$8,$9)
        ON CONFLICT(channel_id,request_key) DO NOTHING RETURNING channel_id`,
      [scope.channelId, request.idempotencyKey, scope.omsOrderId, JSON.stringify(request), JSON.stringify(scope), hash, actor, now, authorizationId]);
      const row = (await client.query(`SELECT * FROM returns.customer_return_workflows WHERE channel_id=$1 AND request_key=$2 FOR UPDATE`,
        [scope.channelId, request.idempotencyKey])).rows[0];
      if (!row || row.semantic_hash !== hash || Number(row.oms_order_id) !== scope.omsOrderId
        || !sameScope(customerReturnCanonicalOrderScopeSchema.parse(row.scope_snapshot), scope)) throw conflict();
      if (inserted.rowCount === 1) await audit(client, scope.channelId, request.idempotencyKey, actor, null, row.phase, null, now);
      return parse(row);
    });
  }

  async acceptedRequest(rawPrincipal: CustomerReturnCustomerPrincipal, rawAuthorizationId: number) {
    const principal = customerReturnCustomerPrincipalSchema.parse(rawPrincipal), authorizationId = idSchema.parse(rawAuthorizationId);
    const row = (await this.pool.query(`SELECT c.request_snapshot,a.oms_order_id,o.external_order_id FROM returns.customer_return_authorizations a
      JOIN oms.oms_orders o ON o.id=a.oms_order_id AND o.channel_id=a.channel_id
      JOIN returns.customer_return_submission_commands c ON c.authorization_id=a.id AND c.channel_id=a.channel_id AND c.status='accepted'
      WHERE a.id=$1 AND a.channel_id=$2 AND o.external_customer_id=$3 ORDER BY c.created_at LIMIT 1`,
    [authorizationId, principal.channelId, principal.externalCustomerId])).rows[0];
    return row ? { request: customerReturnLabelSubmitInputSchema.parse(row.request_snapshot),
      scope: customerReturnCanonicalOrderScopeSchema.parse({ ...principal, omsOrderId: Number(row.oms_order_id), externalOrderId: row.external_order_id }) } : null;
  }

  async readOwned(rawPrincipal: CustomerReturnCustomerPrincipal, rawKey: string): Promise<ReturnWorkflowRecord | null> {
    const principal = customerReturnCustomerPrincipalSchema.parse(rawPrincipal);
    const key = keySchema.parse(rawKey);
    const row = (await this.pool.query(`SELECT w.* FROM returns.customer_return_workflows w JOIN oms.oms_orders o ON ${ownedScope}
      WHERE w.channel_id=$1 AND w.request_key=$2 AND o.external_customer_id=$3`,
    [principal.channelId, key, principal.externalCustomerId])).rows[0];
    return row ? parse(row) : null;
  }

  async readOwnedOrder(rawPrincipal: CustomerReturnCustomerPrincipal, rawOrderId: number): Promise<ReturnWorkflowRecord | null> {
    const principal = customerReturnCustomerPrincipalSchema.parse(rawPrincipal), omsOrderId = idSchema.parse(rawOrderId);
    const row = (await this.pool.query(`SELECT w.* FROM returns.customer_return_workflows w JOIN oms.oms_orders o ON ${ownedScope}
      WHERE w.channel_id=$1 AND w.oms_order_id=$2 AND o.external_customer_id=$3 AND w.phase NOT IN ('ready','needs_input')
      ORDER BY w.created_at DESC,w.request_key LIMIT 1`, [principal.channelId, omsOrderId, principal.externalCustomerId])).rows[0];
    return row ? parse(row) : null;
  }

  async readOwnedAuthorization(rawPrincipal: CustomerReturnCustomerPrincipal, rawAuthorizationId: number): Promise<ReturnWorkflowRecord | null> {
    const principal = customerReturnCustomerPrincipalSchema.parse(rawPrincipal), authorizationId = idSchema.parse(rawAuthorizationId);
    const row = (await this.pool.query(`SELECT w.* FROM returns.customer_return_workflows w JOIN oms.oms_orders o ON ${ownedScope}
      WHERE w.channel_id=$1 AND w.authorization_id=$2 AND o.external_customer_id=$3`,
    [principal.channelId, authorizationId, principal.externalCustomerId])).rows[0];
    return row ? parse(row) : null;
  }

  async retryOwned(rawPrincipal: CustomerReturnCustomerPrincipal, rawKey: string, rawNow: Date): Promise<ReturnWorkflowRecord | null> {
    const principal = customerReturnCustomerPrincipalSchema.parse(rawPrincipal);
    const key = keySchema.parse(rawKey), now = z.date().parse(rawNow);
    return this.transaction(async client => {
      const row = (await client.query(`SELECT w.* FROM returns.customer_return_workflows w JOIN oms.oms_orders o ON ${ownedScope}
        WHERE w.channel_id=$1 AND w.request_key=$2 AND o.external_customer_id=$3 FOR UPDATE OF w`,
      [principal.channelId, key, principal.externalCustomerId])).rows[0];
      if (!row) return null;
      if (row.phase !== "retryable_failure" && row.phase !== "needs_help") return parse(row);
      const phase = row.authorization_id == null ? "queued" : "labels";
      const saved = (await client.query(`UPDATE returns.customer_return_workflows SET phase=$3,reason=NULL,failures=0,
        explicit_retry=true,next_run_at=$4,lease_token=NULL,lease_until=NULL,last_error_code=NULL,updated_at=$4
        WHERE channel_id=$1 AND request_key=$2 RETURNING *`, [principal.channelId, key, phase, now])).rows[0];
      await audit(client, principal.channelId, key, `customer:${principal.channelId}:${principal.externalCustomerId}`, row.phase, phase, null, now);
      return parse(saved);
    });
  }

  async claim(rawLimit: number, rawToken: string, rawNow: Date): Promise<readonly ReturnWorkflowRecord[]> {
    const limit = z.number().int().min(1).max(10).parse(rawLimit), token = keySchema.parse(rawToken), now = z.date().parse(rawNow);
    return this.transaction(async client => {
      // Ownership changes cannot leave a job silently queued, nor allow an old
      // customer's saved authorization to buy postage for a reassigned order.
      const invalid = await client.query(`SELECT w.channel_id,w.request_key,w.actor,w.phase FROM returns.customer_return_workflows w
        WHERE w.phase IN ('queued','preparing','labels') AND w.next_run_at<=$1
          AND (w.lease_until IS NULL OR w.lease_until<=$1)
          AND NOT EXISTS(SELECT 1 FROM oms.oms_orders o WHERE ${ownedScope})
        ORDER BY w.next_run_at,w.created_at FOR UPDATE OF w SKIP LOCKED LIMIT $2`, [now, limit]);
      for (const row of invalid.rows) {
        await client.query(`UPDATE returns.customer_return_workflows SET phase='needs_help',reason='RETURN_WORKFLOW_NEEDS_HELP',
          last_error_code='RETURN_WORKFLOW_OWNER_CHANGED',lease_token=NULL,lease_until=NULL,updated_at=$3
          WHERE channel_id=$1 AND request_key=$2`, [row.channel_id, row.request_key, now]);
        await audit(client, Number(row.channel_id), row.request_key, row.actor, row.phase, "needs_help", "RETURN_WORKFLOW_OWNER_CHANGED", now);
      }
      const rows = await client.query(`WITH candidates AS (
        SELECT w.channel_id,w.request_key,w.phase AS previous_phase FROM returns.customer_return_workflows w JOIN oms.oms_orders o ON ${ownedScope}
        WHERE w.phase IN ('queued','preparing','labels') AND w.next_run_at<=$1 AND (w.lease_until IS NULL OR w.lease_until<=$1)
        ORDER BY w.next_run_at,w.created_at FOR UPDATE OF w SKIP LOCKED LIMIT $2
      ) UPDATE returns.customer_return_workflows w SET lease_token=$3,lease_until=$4,updated_at=$1,
        phase=CASE WHEN w.authorization_id IS NULL THEN 'preparing' ELSE 'labels' END
      FROM candidates c WHERE w.channel_id=c.channel_id AND w.request_key=c.request_key RETURNING w.*,c.previous_phase`,
      [now, limit, token, new Date(now.getTime() + RETURN_WORKFLOW_LEASE_MS)]);
      for (const row of rows.rows) await audit(client, Number(row.channel_id), row.request_key, `worker:return-workflow:${token}`, row.previous_phase, row.phase, null, now);
      return rows.rows.map(parse);
    });
  }

  async settle(record: ReturnWorkflowRecord, transition: ReturnWorkflowTransition, rawNow: Date): Promise<boolean> {
    const checked = returnWorkflowRecordSchema.parse(record);
    const now = z.date().parse(rawNow), nextRunAt = z.date().parse(transition.nextRunAt);
    const result = returnWorkflowRecordSchema.parse({ ...checked, phase: transition.phase, reason: transition.reason,
      authorizationId: transition.authorizationId, failures: transition.failures, leaseToken: null, updatedAt: now });
    return this.transaction(async client => {
      const updated = await client.query(`UPDATE returns.customer_return_workflows SET phase=$4,reason=$5,authorization_id=$6,
        failures=$7,next_run_at=$8,last_error_code=$9,lease_token=NULL,lease_until=NULL,updated_at=$10,explicit_retry=false
        WHERE channel_id=$1 AND request_key=$2 AND lease_token=$3 AND lease_until>$10 RETURNING channel_id`,
      [checked.scope.channelId, checked.request.idempotencyKey, checked.leaseToken, result.phase, result.reason,
        result.authorizationId, result.failures, nextRunAt, transition.errorCode == null ? null : z.string().regex(/^[A-Z0-9_]{1,100}$/).parse(transition.errorCode), now]);
      if (updated.rowCount !== 1) return false;
      await audit(client, checked.scope.channelId, checked.request.idempotencyKey, `worker:return-workflow:${checked.leaseToken}`, checked.phase, result.phase, transition.errorCode, now);
      return true;
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
function parse(row: Record<string, unknown>): ReturnWorkflowRecord {
  return returnWorkflowRecordSchema.parse({ request: row.request_snapshot, scope: row.scope_snapshot, actor: row.actor,
    phase: row.phase, reason: row.reason, authorizationId: row.authorization_id == null ? null : idSchema.parse(Number(row.authorization_id)),
    failures: Number(row.failures), explicitRetry: row.explicit_retry, leaseToken: row.lease_token, updatedAt: row.updated_at });
}
function sameScope(left: ReturnWorkflowRecord["scope"], right: ReturnWorkflowRecord["scope"]): boolean {
  return left.channelId === right.channelId && left.omsOrderId === right.omsOrderId
    && left.externalCustomerId === right.externalCustomerId && left.externalOrderId === right.externalOrderId;
}
async function audit(client: PoolClient, channelId: number, key: string, actor: string, from: string | null, to: string, code: string | null, now: Date): Promise<void> {
  await client.query(`INSERT INTO returns.customer_return_workflow_events(channel_id,request_key,actor,from_phase,to_phase,error_code,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [channelId, key, actor, from, to, code, now]);
}
function conflict(): CustomerReturnIntakeError { return new CustomerReturnIntakeError("RETURN_LABEL_COMMAND_CONFLICT", "This request belongs to different return details.", 409); }
function unavailable(): CustomerReturnIntakeError { return new CustomerReturnIntakeError("CUSTOMER_RETURN_UNAVAILABLE", "This return is unavailable.", 404); }
