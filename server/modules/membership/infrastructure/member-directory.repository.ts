/**
 * Postgres reads of the membership schema, owned by the membership app
 * (cardshellz/shellz-club-app) in the shared database. Read-only: Echelon never
 * writes these tables from here. The current-plan rule is not re-implemented:
 * it is the membership app's own view, membership.member_current_membership.
 */

import type { Pool, QueryResultRow } from "pg";
import type { CurrentMembershipRow, MemberDirectory } from "../application/member-resolver";
import type { PlanRow } from "../domain/member-resolution";

/** The one query shape the directory needs; a pg Pool or PoolClient fits it. */
export interface MemberDirectoryQueryClient {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Adapts a pool that only exposes connect(): each query borrows a connection
 * and always returns it, even when the query fails.
 */
export function connectionPerQuery(pool: Pick<Pool, "connect">): MemberDirectoryQueryClient {
  return {
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      const client = await pool.connect();
      try {
        return await client.query<R>(text, values);
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Enough rows to tell "one" from "more than one". members.shopify_customer_id
 * is unique, but a numeric id and its GID form are two values that could each
 * belong to a different member.
 */
const AMBIGUITY_PROBE_LIMIT = 3;

export class PgMemberDirectory implements MemberDirectory {
  constructor(private readonly client: MemberDirectoryQueryClient) {}

  async findMemberIdsByShopifyCustomerIds(candidates: readonly string[]): Promise<string[]> {
    if (candidates.length === 0) return [];
    const result = await this.client.query<{ member_id: string }>(
      `SELECT m.id::text AS member_id
       FROM membership.members m
       WHERE m.shopify_customer_id = ANY($1::text[])
       ORDER BY m.id
       LIMIT ${AMBIGUITY_PROBE_LIMIT}`,
      [[...candidates]],
    );
    return result.rows.map((row) => row.member_id);
  }

  async findMemberIdsByShopifyCustomerIdAliases(candidates: readonly string[]): Promise<string[]> {
    if (candidates.length === 0) return [];
    // Joined to members, as the membership app does: an alias whose member is
    // gone identifies no one.
    const result = await this.client.query<{ member_id: string }>(
      `SELECT DISTINCT m.id::text AS member_id
       FROM membership.member_shopify_customer_ids a
       JOIN membership.members m ON m.id = a.member_id
       WHERE a.shopify_customer_id = ANY($1::text[])
       ORDER BY 1
       LIMIT ${AMBIGUITY_PROBE_LIMIT}`,
      [[...candidates]],
    );
    return result.rows.map((row) => row.member_id);
  }

  async memberExists(memberId: string): Promise<boolean> {
    const result = await this.client.query(
      `SELECT 1 FROM membership.members WHERE id = $1 LIMIT 1`,
      [memberId],
    );
    return result.rows.length > 0;
  }

  async findCurrentMemberships(memberId: string): Promise<CurrentMembershipRow[]> {
    const result = await this.client.query<{ subscription_id: string; plan_id: string | null; status: string }>(
      `SELECT cm.subscription_id::text AS subscription_id,
              cm.plan_id::text AS plan_id,
              cm.status
       FROM membership.member_current_membership cm
       WHERE cm.member_id = $1
       LIMIT 2`,
      [memberId],
    );
    return result.rows.map((row) => ({
      subscriptionId: row.subscription_id,
      planId: row.plan_id,
      status: row.status,
    }));
  }

  async findPlan(planId: string): Promise<PlanRow | null> {
    const result = await this.client.query<PlanRow>(
      `SELECT p.id::text AS plan_id, p.name, p.primary_color, p.priority_modifier
       FROM membership.plans p
       WHERE p.id = $1
       LIMIT 1`,
      [planId],
    );
    return result.rows[0] ?? null;
  }
}
