import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import { PgDropshipCarrierProtectionRepository } from "../../infrastructure/dropship-carrier-protection.repository";

const now = new Date("2026-07-10T12:00:00.000Z");

describe("PgDropshipCarrierProtectionRepository", () => {
  it("rejects an overlapping default assignment before insertion", async () => {
    const client = new DefaultConflictClient();
    const repository = new PgDropshipCarrierProtectionRepository(poolFor(client));

    await expect(repository.createAssignment({
      policyId: 7,
      name: "Default protection",
      priority: 0,
      channelId: null,
      warehouseId: null,
      carrier: null,
      service: null,
      destinationCountry: null,
      destinationRegion: null,
      minShipmentValueCents: null,
      maxShipmentValueCents: null,
      isDefault: true,
      idempotencyKey: "default-conflict-001",
      requestHash: "request-hash",
      actor: { actorType: "admin", actorId: "admin-1" },
      now,
    })).rejects.toMatchObject({ code: "DROPSHIP_CARRIER_PROTECTION_DEFAULT_CONFLICT" });

    expect(client.queries.some((query) => query.includes("INSERT INTO dropship.dropship_carrier_protection_assignments"))).toBe(false);
    expect(client.queries).toContain("ROLLBACK");
    expect(client.released).toBe(true);
  });
});

class DefaultConflictClient {
  readonly queries: string[] = [];
  released = false;

  async query<T>(sql: string): Promise<QueryResult<T>> {
    const normalized = sql.trim();
    this.queries.push(normalized);
    if (normalized.includes("INSERT INTO dropship.dropship_admin_config_commands")) return result([{ id: 50 } as T]);
    if (normalized.includes("FROM dropship.dropship_carrier_protection_policies WHERE id")) return result([policyRow() as T]);
    if (normalized.includes("SELECT a.id AS assignment_id")) return result([{ assignment_id: 4, policy_id: 3 } as T]);
    return result([]);
  }

  release(): void { this.released = true; }
}

function policyRow(): Record<string, unknown> {
  return {
    id: 7, policy_key: "STANDARD", version: 1, supersedes_policy_id: null, name: "Standard", status: "active",
    covered_loss: true, covered_misdelivery: true, covered_damage: true,
    merchandise_reimbursement_bps: 10000, shipping_reimbursement_bps: 10000,
    deductible_cents: 0, max_credit_cents: null, loss_wait_days: 7, misdelivery_wait_days: 2,
    damage_inspection_required: true, payout_trigger: "internal_approval", carrier_claim_required: true,
    approval_mode: "manual", automatic_approval_limit_cents: null, effective_from: now,
    effective_to: null, created_by: "admin-1", created_at: now, retired_at: null,
  };
}

function poolFor(client: DefaultConflictClient): Pool {
  return { connect: async () => client as unknown as PoolClient } as unknown as Pool;
}

function result<T>(rows: T[]): QueryResult<T> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}
