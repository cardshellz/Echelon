import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipEntitlementPort,
  DropshipEntitlementSnapshot,
  DropshipIdentityPort,
  DropshipMemberIdentity,
} from "../application";
import {
  evaluateDropshipMembershipEntitlement,
  normalizeCardShellzEmail,
  type DropshipMembershipEntitlementInput,
} from "../domain/auth";

interface MembershipEntitlementRow {
  member_id: string;
  member_email: string | null;
  member_status: string | null;
  subscription_id: string | null;
  subscription_status: string | null;
  billing_status: string | null;
  plan_id: string | null;
  plan_name: string | null;
  includes_dropship: boolean | null;
  plan_is_active: boolean | null;
}

interface MemberIdentityRow {
  member_id: string;
  member_email: string;
  member_status: string | null;
}

export class ShellzClubEntitlementAdapter implements DropshipIdentityPort, DropshipEntitlementPort {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async resolveMemberByCardShellzEmail(email: string): Promise<DropshipMemberIdentity | null> {
    const normalizedEmail = normalizeCardShellzEmail(email);
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<MemberIdentityRow>(
        `SELECT id::text AS member_id, email AS member_email, status AS member_status
         FROM membership.members
         WHERE LOWER(email) = LOWER($1)
         LIMIT 1`,
        [normalizedEmail],
      );

      const row = result.rows[0];
      if (!row) return null;

      return {
        memberId: row.member_id,
        cardShellzEmail: normalizeCardShellzEmail(row.member_email),
        memberStatus: row.member_status,
      };
    } finally {
      client.release();
    }
  }

  async getEntitlementByMemberId(memberId: string): Promise<DropshipEntitlementSnapshot | null> {
    const client = await this.dbPool.connect();
    try {
      const row = await this.fetchMembershipEntitlementRow(client, memberId);
      if (!row) return null;

      const evaluated = evaluateDropshipMembershipEntitlement(toEntitlementInput(row));
      return {
        memberId: evaluated.memberId,
        cardShellzEmail: evaluated.cardShellzEmail,
        planId: evaluated.planId,
        planName: evaluated.planName,
        subscriptionId: evaluated.subscriptionId,
        includesDropship: evaluated.includesDropship,
        status: evaluated.status,
        reasonCode: evaluated.reasonCode,
      };
    } finally {
      client.release();
    }
  }

  async upsertAuthIdentity(input: {
    memberId: string;
    cardShellzEmail: string;
    verifiedAt: Date;
  }): Promise<number> {
    const normalizedEmail = normalizeCardShellzEmail(input.cardShellzEmail);
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_auth_identities
          (member_id, primary_email, last_card_shellz_proof_at, created_at, updated_at)
         VALUES ($1, $2, $3, $3, $3)
         ON CONFLICT (member_id) DO UPDATE
           SET primary_email = EXCLUDED.primary_email,
               last_card_shellz_proof_at = EXCLUDED.last_card_shellz_proof_at,
               updated_at = EXCLUDED.updated_at
         RETURNING id`,
        [input.memberId, normalizedEmail, input.verifiedAt],
      );
      return result.rows[0].id;
    } finally {
      client.release();
    }
  }

  private async fetchMembershipEntitlementRow(
    client: PoolClient,
    memberId: string,
  ): Promise<MembershipEntitlementRow | null> {
    const result = await client.query<MembershipEntitlementRow>(
      `SELECT
          m.id::text AS member_id,
          m.email AS member_email,
          m.status AS member_status,
          ms.id::text AS subscription_id,
          ms.status AS subscription_status,
          ms.billing_status AS billing_status,
          ms.plan_id::text AS plan_id,
          p.name AS plan_name,
          p.includes_dropship AS includes_dropship,
          p.is_active AS plan_is_active
       FROM membership.members m
       LEFT JOIN LATERAL (
         SELECT *
         FROM membership.member_subscriptions ms
         WHERE ms.member_id::text = m.id::text
         ORDER BY
           CASE
             WHEN ms.status = 'active' AND COALESCE(ms.billing_status, 'current') = 'current' THEN 0
             WHEN ms.status = 'active' AND ms.billing_status = 'past_due' THEN 1
             WHEN ms.status = 'paused' OR ms.billing_status = 'paused' THEN 2
             ELSE 3
           END,
           ms.created_at DESC NULLS LAST
         LIMIT 1
       ) ms ON true
       LEFT JOIN membership.plans p ON p.id::text = ms.plan_id::text
       WHERE m.id::text = $1
       LIMIT 1`,
      [memberId],
    );

    return result.rows[0] ?? null;
  }
}

function toEntitlementInput(row: MembershipEntitlementRow): DropshipMembershipEntitlementInput {
  return {
    memberId: row.member_id,
    memberEmail: row.member_email,
    memberStatus: row.member_status,
    subscriptionId: row.subscription_id,
    subscriptionStatus: row.subscription_status,
    billingStatus: row.billing_status,
    planId: row.plan_id,
    planName: row.plan_name,
    planIncludesDropship: row.includes_dropship,
    planIsActive: row.plan_is_active,
  };
}
