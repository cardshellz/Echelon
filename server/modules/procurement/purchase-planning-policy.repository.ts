import type { Pool, PoolClient } from "pg";
import { parsePurchasePlanningPolicy, type PurchasePlanningPolicy } from "@shared/procurement/purchase-planning-policy";

export interface PurchasePlanningPolicyRecord { revision: number; policy: PurchasePlanningPolicy }
export interface PurchasePlanningPolicyChange {
  revision: number;
  actorId: string;
  changedAt: string;
  before: PurchasePlanningPolicy;
  after: PurchasePlanningPolicy;
}

type PolicyRow = { revision: number; policy: unknown };
type ChangeRow = { revision: number; actor_id: string; changed_at: Date; before_policy: unknown; after_policy: unknown; request_hash: string };

function record(row: PolicyRow | undefined): PurchasePlanningPolicyRecord {
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new Error("Purchase planning policy is not initialized; apply migration 223");
  }
  return { revision: row.revision, policy: parsePurchasePlanningPolicy(row.policy) };
}

export class PurchasePlanningPolicyRepository {
  constructor(private readonly database: Pool) {}

  async read(): Promise<PurchasePlanningPolicyRecord> {
    const result = await this.database.query<PolicyRow>("SELECT revision, policy FROM procurement.purchase_planning_policy WHERE id = 1");
    return record(result.rows[0]);
  }

  async searchProducts(search: string): Promise<Array<{ id: number; sku: string | null; name: string }>> {
    const result = await this.database.query<{ id: number; sku: string | null; name: string }>(
      "SELECT id, sku, name FROM catalog.products WHERE is_active = true AND (sku ILIKE $1 OR name ILIKE $1) ORDER BY sku, id LIMIT 50", [`%${search}%`],
    );
    return result.rows;
  }

  async describeProducts(ids: number[]): Promise<Array<{ id: number; sku: string | null; name: string }>> {
    if (ids.length === 0) return [];
    const result = await this.database.query<{ id: number; sku: string | null; name: string }>(
      "SELECT id, sku, name FROM catalog.products WHERE id = ANY($1::int[]) ORDER BY sku, id", [ids],
    );
    return result.rows;
  }

  async history(): Promise<PurchasePlanningPolicyChange[]> {
    const result = await this.database.query<ChangeRow>(
      "SELECT revision, actor_id, changed_at, before_policy, after_policy, request_hash FROM procurement.purchase_planning_policy_revisions ORDER BY revision DESC LIMIT 50",
    );
    return result.rows.map((row) => ({ revision: row.revision, actorId: row.actor_id,
      changedAt: row.changed_at.toISOString(), before: parsePurchasePlanningPolicy(row.before_policy), after: parsePurchasePlanningPolicy(row.after_policy) }));
  }

  async transaction<T>(work: (tx: PurchasePlanningPolicyTransaction) => Promise<T>): Promise<T> {
    const connection = await this.database.connect();
    try {
      await connection.query("BEGIN");
      const result = await work(new PurchasePlanningPolicyTransaction(connection));
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally { connection.release(); }
  }
}

export class PurchasePlanningPolicyTransaction {
  constructor(private readonly connection: PoolClient) {}

  async lock(): Promise<PurchasePlanningPolicyRecord> {
    const result = await this.connection.query<PolicyRow>("SELECT revision, policy FROM procurement.purchase_planning_policy WHERE id = 1 FOR UPDATE");
    return record(result.rows[0]);
  }

  async findRequest(idempotencyKey: string): Promise<{ requestHash: string; result: PurchasePlanningPolicyRecord } | null> {
    const result = await this.connection.query<ChangeRow>(
      "SELECT revision, after_policy, request_hash FROM procurement.purchase_planning_policy_revisions WHERE idempotency_key = $1", [idempotencyKey],
    );
    const row = result.rows[0];
    return row ? { requestHash: row.request_hash, result: { revision: row.revision, policy: parsePurchasePlanningPolicy(row.after_policy) } } : null;
  }

  async validateProducts(productIds: number[]): Promise<number[]> {
    if (productIds.length === 0) return [];
    const result = await this.connection.query<{ id: number }>(
      "SELECT id FROM catalog.products WHERE id = ANY($1::int[]) ORDER BY id FOR KEY SHARE", [productIds],
    );
    return result.rows.map((row) => row.id);
  }

  async save(input: { before: PurchasePlanningPolicyRecord; policy: PurchasePlanningPolicy; actorId: string; idempotencyKey: string; requestHash: string; changedAt: Date }): Promise<PurchasePlanningPolicyRecord> {
    const revision = input.before.revision + 1;
    await this.connection.query(
      "INSERT INTO procurement.purchase_planning_policy_revisions (revision, idempotency_key, request_hash, actor_id, changed_at, before_policy, after_policy) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)",
      [revision, input.idempotencyKey, input.requestHash, input.actorId, input.changedAt, JSON.stringify(input.before.policy), JSON.stringify(input.policy)],
    );
    await this.connection.query(
      "UPDATE procurement.purchase_planning_policy SET revision = $1, policy = $2::jsonb WHERE id = 1", [revision, JSON.stringify(input.policy)],
    );
    return { revision, policy: input.policy };
  }
}
