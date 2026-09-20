import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgDropshipWalletPolicyRepository } from "../../infrastructure/dropship-wallet-policy.repository";

const now = new Date("2026-09-19T10:00:00.000Z");

const limits = {
  autoReloadMinTriggerCents: 9_000,
  caseTierMinimumCents: 55_000,
  autoReloadMinAmountCents: 20_000,
  manualFundingMinCents: 2_500,
  manualFundingMaxCents: 60_000,
  defaultPaymentHoldTimeoutMinutes: 1_440,
  holdExpiryWarningMinutes: 45,
  advanceFeeBps: 150,
  advanceCapCents: 75_000,
  tierChangeGraceDays: 21,
};

const command = {
  limits,
  changeNote: "Autumn cohort floors.",
  idempotencyKey: "wallet-policy-001",
  requestHash: "request-hash",
  actor: { actorType: "admin" as const, actorId: "admin-1" },
  now,
};

describe("PgDropshipWalletPolicyRepository", () => {
  describe("getActivePolicy", () => {
    it("maps the active row, parsing bigint cents that pg returns as strings", async () => {
      const query = vi.fn(async (_sql: string, _values?: unknown[]) => result([policyRow()]));
      const repository = new PgDropshipWalletPolicyRepository({ query } as unknown as Pool);

      const policy = await repository.getActivePolicy();

      expect(String(query.mock.calls[0]?.[0])).toContain("WHERE is_active = true");
      expect(policy).toEqual({
        policyId: 7,
        version: 3,
        limits,
        isActive: true,
        changeNote: "Autumn cohort floors.",
        createdAt: now,
        createdBy: { actorType: "admin", actorId: "admin-1" },
        deactivatedAt: null,
      });
    });

    it("returns null when nothing is published", async () => {
      const query = vi.fn(async (_sql: string, _values?: unknown[]) => result([]));
      const repository = new PgDropshipWalletPolicyRepository({ query } as unknown as Pool);
      await expect(repository.getActivePolicy()).resolves.toBeNull();
    });

    it("classifies a missing table as transient so the caller can fall back", async () => {
      const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
        throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      });
      const repository = new PgDropshipWalletPolicyRepository({ query } as unknown as Pool);

      await expect(repository.getActivePolicy()).rejects.toMatchObject({
        code: "DROPSHIP_WALLET_POLICY_TABLE_MISSING",
        context: expect.objectContaining({ classification: "transient" }),
      });
    });

    it("refuses a stored value that is not positive integer cents rather than serving it", async () => {
      const query = vi.fn(async (_sql: string, _values?: unknown[]) => result([{ ...policyRow(), minimum_floor_cents: "12.5" }]));
      const repository = new PgDropshipWalletPolicyRepository({ query } as unknown as Pool);

      await expect(repository.getActivePolicy()).rejects.toMatchObject({
        code: "DROPSHIP_WALLET_POLICY_INVALID_STORED_VALUE",
        context: expect.objectContaining({ classification: "fatal", column: "minimum_floor_cents" }),
      });
    });

    it("accepts a zero advance cap and a zero fee, and refuses a negative one", async () => {
      const zeroed = vi.fn(async (_sql: string, _values?: unknown[]) =>
        result([{ ...policyRow(), advance_cap_cents: "0", advance_fee_bps: 0, tier_change_grace_days: 0 }]));
      const policy = await new PgDropshipWalletPolicyRepository({ query: zeroed } as unknown as Pool).getActivePolicy();
      expect(policy?.limits).toMatchObject({ advanceCapCents: 0, advanceFeeBps: 0, tierChangeGraceDays: 0 });

      const negative = vi.fn(async (_sql: string, _values?: unknown[]) =>
        result([{ ...policyRow(), advance_cap_cents: "-1" }]));
      await expect(new PgDropshipWalletPolicyRepository({ query: negative } as unknown as Pool).getActivePolicy())
        .rejects.toMatchObject({
          code: "DROPSHIP_WALLET_POLICY_INVALID_STORED_VALUE",
          context: expect.objectContaining({ column: "advance_cap_cents" }),
        });
    });
  });

  describe("countVendorsBelowLimits", () => {
    it("counts active vendors below each proposed floor without touching their rows", async () => {
      const query = vi.fn(async (_sql: string, _values?: unknown[]) => result([{ below_floor: "4", below_limit: "7", total: "31" }]));
      const repository = new PgDropshipWalletPolicyRepository({ query } as unknown as Pool);

      const counts = await repository.countVendorsBelowLimits({
        autoReloadMinTriggerCents: 9_000,
        autoReloadMinAmountCents: 20_000,
      });

      const [sql, params] = query.mock.calls[0] ?? [];
      expect(String(sql)).toContain("FROM dropship.dropship_auto_reload_settings s");
      expect(String(sql)).toContain("JOIN dropship.dropship_vendors v ON v.id = s.vendor_id");
      expect(String(sql)).toContain("WHERE v.status = 'active'");
      expect(String(sql)).toContain("s.minimum_balance_cents < $1");
      expect(String(sql)).toContain("s.max_single_reload_cents IS NOT NULL");
      // A read may not mutate stored vendor configuration.
      expect(String(sql)).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
      expect(params).toEqual([9_000, 20_000]);
      expect(counts).toEqual({
        vendorsBelowMinimumFloor: 4,
        vendorsBelowMinimumSingleTopUpLimit: 7,
        activeVendorsWithAutoReloadSettings: 31,
      });
    });

    it("reports zeroes when no auto-reload row exists at all", async () => {
      const query = vi.fn(async (_sql: string, _values?: unknown[]) => result([{ below_floor: "0", below_limit: "0", total: "0" }]));
      const repository = new PgDropshipWalletPolicyRepository({ query } as unknown as Pool);

      await expect(repository.countVendorsBelowLimits({
        autoReloadMinTriggerCents: 5_000,
        autoReloadMinAmountCents: 10_000,
      })).resolves.toEqual({
        vendorsBelowMinimumFloor: 0,
        vendorsBelowMinimumSingleTopUpLimit: 0,
        activeVendorsWithAutoReloadSettings: 0,
      });
    });
  });

  describe("createPolicyVersion", () => {
    it("retires the previous version, inserts the next and writes the audit row in one transaction", async () => {
      const client = new ScriptedClient();
      const repository = new PgDropshipWalletPolicyRepository(poolFor(client));

      const result = await repository.createPolicyVersion(command);

      expect(result.idempotentReplay).toBe(false);
      expect(result.previousPolicy?.policyId).toBe(7);
      expect(result.policy.version).toBe(4);
      expect(client.queries[0]).toBe("BEGIN");
      expect(client.queries.at(-1)).toBe("COMMIT");
      // Serialized: the one-active-row index is never raced into a retry storm.
      expect(client.queries.some((query) => query.includes("pg_advisory_xact_lock"))).toBe(true);
      expect(client.queries.some((query) => query.includes("WHERE is_active = true FOR UPDATE"))).toBe(true);
      const retire = client.queries.find((query) => query.includes("UPDATE dropship.dropship_wallet_policies"));
      expect(retire).toContain("SET is_active = false, deactivated_at = $2");
      const insert = client.queries.find((query) => query.includes("INSERT INTO dropship.dropship_wallet_policies"));
      expect(insert).toBeDefined();
      expect(insert).toContain("case_tier_minimum_cents");
      expect(insert).toContain("advance_fee_bps, advance_cap_cents, tier_change_grace_days");
      expect(client.queries.some((query) => query.includes("INSERT INTO dropship.dropship_audit_events"))).toBe(true);

      // The audit row carries the real staff actor, never 'system'.
      const auditParams = client.paramsFor("INSERT INTO dropship.dropship_audit_events");
      expect(auditParams?.[3]).toBe("admin");
      expect(auditParams?.[4]).toBe("admin-1");
      const auditPayload = JSON.parse(String(auditParams?.[5]));
      expect(auditPayload.before).toMatchObject({ policyId: 7, autoReloadMinTriggerCents: 5_000 });
      expect(auditPayload.after).toMatchObject({ autoReloadMinTriggerCents: 9_000, advanceCapCents: 75_000 });
      expect(auditPayload.idempotencyKey).toBe("wallet-policy-001");

      // The insert carries integer cents, bps and days exactly as given, in column order.
      const insertParams = client.paramsFor("INSERT INTO dropship.dropship_wallet_policies");
      expect(insertParams?.slice(0, 11)).toEqual([4, 9_000, 55_000, 20_000, 2_500, 60_000, 1_440, 45, 150, 75_000, 21]);
      expect(insertParams?.slice(11)).toEqual(["Autumn cohort floors.", now, "admin", "admin-1"]);
    });

    it("skips the retire when no version has ever been published", async () => {
      const client = new ScriptedClient({ existingActive: false });
      const repository = new PgDropshipWalletPolicyRepository(poolFor(client));

      const result = await repository.createPolicyVersion(command);

      expect(result.previousPolicy).toBeNull();
      expect(result.policy.version).toBe(1);
      expect(client.queries.some((query) => query.startsWith("UPDATE dropship.dropship_wallet_policies"))).toBe(false);
    });

    it("replays a completed command without writing anything", async () => {
      const client = new ScriptedClient({ replayEntityId: "7" });
      const repository = new PgDropshipWalletPolicyRepository(poolFor(client));

      const result = await repository.createPolicyVersion(command);

      expect(result).toMatchObject({ idempotentReplay: true, previousPolicy: null });
      expect(result.policy.policyId).toBe(7);
      expect(client.queries.some((query) => query.includes("INSERT INTO dropship.dropship_wallet_policies"))).toBe(false);
      expect(client.queries.some((query) => query.includes("INSERT INTO dropship.dropship_audit_events"))).toBe(false);
      expect(client.queries.at(-1)).toBe("COMMIT");
    });

    it("refuses an idempotency key reused for a different proposal", async () => {
      const client = new ScriptedClient({ replayEntityId: "7", existingRequestHash: "a-different-hash" });
      const repository = new PgDropshipWalletPolicyRepository(poolFor(client));

      await expect(repository.createPolicyVersion(command)).rejects.toMatchObject({
        code: "DROPSHIP_WALLET_POLICY_IDEMPOTENCY_CONFLICT",
        context: expect.objectContaining({ classification: "permanent" }),
      });
      expect(client.queries).toContain("ROLLBACK");
      expect(client.released).toBe(true);
    });

    it("treats a command claimed but never finished as transient, not as a replay", async () => {
      const client = new ScriptedClient({ replayEntityId: null });
      const repository = new PgDropshipWalletPolicyRepository(poolFor(client));

      await expect(repository.createPolicyVersion(command)).rejects.toMatchObject({
        code: "DROPSHIP_WALLET_POLICY_COMMAND_INCOMPLETE",
        context: expect.objectContaining({ classification: "transient" }),
      });
      expect(client.queries).toContain("ROLLBACK");
    });

    it("rolls back and classifies a concurrent publish as retryable", async () => {
      const client = new ScriptedClient({ insertError: Object.assign(new Error("duplicate key"), { code: "23505" }) });
      const repository = new PgDropshipWalletPolicyRepository(poolFor(client));

      await expect(repository.createPolicyVersion(command)).rejects.toMatchObject({
        code: "DROPSHIP_WALLET_POLICY_CONFLICT",
        context: expect.objectContaining({ classification: "transient" }),
      });
      expect(client.queries).toContain("ROLLBACK");
      expect(client.released).toBe(true);
    });

    it("rolls back and classifies a violated CHECK constraint as bad input", async () => {
      const client = new ScriptedClient({ insertError: Object.assign(new Error("check violation"), { code: "23514" }) });
      const repository = new PgDropshipWalletPolicyRepository(poolFor(client));

      await expect(repository.createPolicyVersion(command)).rejects.toMatchObject({
        code: "DROPSHIP_WALLET_POLICY_INVALID_INPUT",
        context: expect.objectContaining({ classification: "permanent" }),
      });
      expect(client.queries).toContain("ROLLBACK");
    });
  });
});

interface ScriptedClientOptions {
  existingActive?: boolean;
  replayEntityId?: string | null;
  existingRequestHash?: string;
  insertError?: Error;
}

/**
 * DI-stubbed pg client in the style of the neighbouring repository tests: it
 * answers by SQL shape and records what was asked, so the transaction's
 * ordering and parameters can be asserted without a database.
 */
class ScriptedClient {
  readonly queries: string[] = [];
  readonly params: unknown[][] = [];
  released = false;

  constructor(private readonly options: ScriptedClientOptions = {}) {}

  paramsFor(fragment: string): unknown[] | undefined {
    const index = this.queries.findIndex((query) => query.includes(fragment));
    return index === -1 ? undefined : this.params[index];
  }

  async query<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    const normalized = sql.trim();
    this.queries.push(normalized);
    this.params.push(values);

    if (normalized.includes("INSERT INTO dropship.dropship_admin_config_commands")) {
      // A claimed key means the command already exists: fall through to the replay read.
      return result(this.options.replayEntityId === undefined ? [{ id: 50 } as unknown as T] : []);
    }
    if (normalized.includes("FROM dropship.dropship_admin_config_commands")) {
      return result([{
        id: 50,
        command_type: "wallet_policy_version_created",
        request_hash: this.options.existingRequestHash ?? "request-hash",
        entity_id: this.options.replayEntityId ?? null,
      } as unknown as T]);
    }
    if (normalized.includes("SELECT * FROM dropship.dropship_wallet_policies WHERE id = $1")) {
      return result([policyRow() as unknown as T]);
    }
    if (normalized.includes("WHERE is_active = true FOR UPDATE")) {
      return result(this.options.existingActive === false
        ? []
        : [{ ...policyRow(), minimum_floor_cents: "5000", minimum_single_top_up_limit_cents: "10000" } as unknown as T]);
    }
    if (normalized.includes("COALESCE(MAX(version), 0) + 1")) {
      return result([{ version: this.options.existingActive === false ? 1 : 4 } as unknown as T]);
    }
    if (normalized.includes("INSERT INTO dropship.dropship_wallet_policies")) {
      if (this.options.insertError) throw this.options.insertError;
      return result([{
        ...policyRow(),
        id: 9,
        version: this.options.existingActive === false ? 1 : 4,
      } as unknown as T]);
    }
    return result([]);
  }

  release(): void {
    this.released = true;
  }
}

function policyRow(): Record<string, unknown> {
  return {
    id: 7,
    version: 3,
    // pg returns bigint columns as strings; the mapper has to parse them.
    minimum_floor_cents: "9000",
    case_tier_minimum_cents: "55000",
    minimum_single_top_up_limit_cents: "20000",
    manual_top_up_minimum_cents: "2500",
    manual_top_up_maximum_cents: "60000",
    default_payment_hold_timeout_minutes: 1_440,
    hold_expiry_warning_minutes: 45,
    advance_fee_bps: 150,
    advance_cap_cents: "75000",
    tier_change_grace_days: 21,
    is_active: true,
    change_note: "Autumn cohort floors.",
    created_at: now,
    created_by_actor_type: "admin",
    created_by_actor_id: "admin-1",
    deactivated_at: null,
  };
}

function poolFor(client: ScriptedClient): Pool {
  return { connect: async () => client as unknown as PoolClient } as unknown as Pool;
}

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}
