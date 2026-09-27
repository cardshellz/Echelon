import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  PgDropshipCostChangePolicyRepository,
  mapCostChangePolicyError,
} from "../../infrastructure/dropship-cost-change-policy.repository";

const now = new Date("2026-09-27T10:00:00.000Z");

const settings = {
  increaseNoticeDays: 21,
  decreaseTiming: "after_notice" as const,
  priceProtection: true,
  retailChangesGetNotice: false,
  notifyByEmail: true,
  notifyInPortal: true,
  notifyOnDecrease: false,
  noticeMinimumChangeCents: 25,
  noticeMinimumChangeBps: 150,
  rulePricedListings: "wait_for_review" as const,
  belowCostFixedListings: "pause_listing" as const,
  detectionIntervalMinutes: 30,
};

const command = {
  settings,
  changeNote: "Three weeks' notice for the holiday catalog.",
  idempotencyKey: "cost-change-policy-001",
  requestHash: "request-hash",
  actor: { actorType: "admin" as const, actorId: "admin-1" },
  now,
};

describe("PgDropshipCostChangePolicyRepository", () => {
  describe("getActivePolicy", () => {
    it("maps the active row into validated settings", async () => {
      const query = vi.fn(async (_sql: string, _values?: unknown[]) => result([policyRow()]));
      const repository = new PgDropshipCostChangePolicyRepository({ query } as unknown as Pool);

      const policy = await repository.getActivePolicy();

      expect(String(query.mock.calls[0]?.[0])).toContain("WHERE is_active = true");
      expect(policy).toEqual({
        policyId: 7,
        version: 3,
        settings,
        isActive: true,
        changeNote: "Three weeks' notice for the holiday catalog.",
        createdAt: now,
        createdBy: { actorType: "admin", actorId: "admin-1" },
        deactivatedAt: null,
      });
    });

    it("returns null when nothing is published", async () => {
      const query = vi.fn(async (_sql: string, _values?: unknown[]) => result([]));
      const repository = new PgDropshipCostChangePolicyRepository({ query } as unknown as Pool);
      await expect(repository.getActivePolicy()).resolves.toBeNull();
    });

    it("classifies a missing table as transient so the caller can fall back", async () => {
      const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
        throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      });
      const repository = new PgDropshipCostChangePolicyRepository({ query } as unknown as Pool);

      await expect(repository.getActivePolicy()).rejects.toMatchObject({
        code: "DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING",
        context: expect.objectContaining({ classification: "transient" }),
      });
    });

    it("refuses a stored row outside the settings contract rather than serving it", async () => {
      const corruptions: Array<[Record<string, unknown>, string]> = [
        [{ increase_notice_days: 91 }, "increaseNoticeDays"],
        [{ increase_notice_days: 1.5 }, "increaseNoticeDays"],
        [{ decrease_timing: "never" }, "decreaseTiming"],
        [{ notice_minimum_change_bps: 10_001 }, "noticeMinimumChangeBps"],
        [{ below_cost_fixed_listings: "raise_price" }, "belowCostFixedListings"],
        [{ detection_interval_minutes: 5 }, "detectionIntervalMinutes"],
        [{ price_protection: null }, "priceProtection"],
      ];
      for (const [change, setting] of corruptions) {
        const query = vi.fn(async (_sql: string, _values?: unknown[]) => result([{ ...policyRow(), ...change }]));
        await expect(new PgDropshipCostChangePolicyRepository({ query } as unknown as Pool).getActivePolicy())
          .rejects.toMatchObject({
            code: "DROPSHIP_COST_CHANGE_POLICY_INVALID_STORED_VALUE",
            context: expect.objectContaining({ classification: "fatal", policyId: 7, issues: [setting] }),
          });
      }
    });

    it("accepts the edges of every range", async () => {
      const edges = {
        ...policyRow(),
        increase_notice_days: 0,
        notice_minimum_change_cents: 100_000,
        notice_minimum_change_bps: 10_000,
        detection_interval_minutes: 1_440,
      };
      const query = vi.fn(async (_sql: string, _values?: unknown[]) => result([edges]));
      const policy = await new PgDropshipCostChangePolicyRepository({ query } as unknown as Pool).getActivePolicy();
      expect(policy?.settings).toMatchObject({
        increaseNoticeDays: 0,
        noticeMinimumChangeCents: 100_000,
        noticeMinimumChangeBps: 10_000,
        detectionIntervalMinutes: 1_440,
      });
    });
  });

  describe("listPolicyVersions", () => {
    it("reads newest first, bounded by the limit", async () => {
      const retired = { ...policyRow(), id: 6, version: 2, is_active: false, deactivated_at: now };
      const query = vi.fn(async (_sql: string, _values?: unknown[]) => result([policyRow(), retired]));
      const repository = new PgDropshipCostChangePolicyRepository({ query } as unknown as Pool);

      const versions = await repository.listPolicyVersions(20);

      const [sql, params] = query.mock.calls[0] ?? [];
      expect(String(sql)).toContain("ORDER BY version DESC LIMIT $1");
      expect(params).toEqual([20]);
      expect(versions.map((version) => [version.version, version.isActive])).toEqual([[3, true], [2, false]]);
      expect(versions[1]?.deactivatedAt).toEqual(now);
    });

    it("refuses a limit that is not a positive integer without querying", async () => {
      const query = vi.fn(async (_sql: string, _values?: unknown[]) => result([]));
      const repository = new PgDropshipCostChangePolicyRepository({ query } as unknown as Pool);

      for (const limit of [0, -1, 2.5, Number.NaN]) {
        await expect(repository.listPolicyVersions(limit)).rejects.toMatchObject({
          code: "DROPSHIP_COST_CHANGE_POLICY_INVALID_INPUT",
          context: expect.objectContaining({ classification: "permanent" }),
        });
      }
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("createPolicyVersion", () => {
    it("claims the key, retires the previous version, inserts the next and audits it in one transaction", async () => {
      const client = new ScriptedClient();
      const repository = new PgDropshipCostChangePolicyRepository(poolFor(client));

      const outcome = await repository.createPolicyVersion(command);

      expect(outcome.idempotentReplay).toBe(false);
      expect(outcome.previousPolicy?.policyId).toBe(7);
      expect(outcome.policy).toMatchObject({ policyId: 9, version: 4, settings });
      expect(client.queries[0]).toBe("BEGIN");
      expect(client.queries.at(-1)).toBe("COMMIT");
      expect(client.released).toBe(true);

      // Order matters: the key is claimed first, then publishes are serialized
      // before the active row is read, so the version number cannot be raced.
      const claim = client.indexOf("INSERT INTO dropship.dropship_admin_config_commands");
      const lock = client.indexOf("pg_advisory_xact_lock");
      const readActive = client.indexOf("WHERE is_active = true FOR UPDATE");
      const retire = client.indexOf("UPDATE dropship.dropship_cost_change_policies");
      const insert = client.indexOf("INSERT INTO dropship.dropship_cost_change_policies");
      const complete = client.indexOf("UPDATE dropship.dropship_admin_config_commands");
      const audit = client.indexOf("INSERT INTO dropship.dropship_audit_events");
      expect([claim, lock, readActive, retire, insert, complete, audit].every((index) => index > 0)).toBe(true);
      expect(claim < lock && lock < readActive && readActive < retire && retire < insert).toBe(true);
      expect(insert < complete && complete < audit).toBe(true);

      expect(client.paramsFor("pg_advisory_xact_lock")).toEqual([94_004]);
      expect(client.queries[retire]).toContain("SET is_active = false, deactivated_at = $2");
      expect(client.paramsFor("UPDATE dropship.dropship_cost_change_policies")).toEqual([7, now]);

      // Every setting is written exactly as given, in column order.
      expect(client.paramsFor("INSERT INTO dropship.dropship_cost_change_policies")).toEqual([
        4, 21, "after_notice", true, false, true, true, false, 25, 150, "wait_for_review", "pause_listing", 30,
        "Three weeks' notice for the holiday catalog.", now, "admin", "admin-1",
      ]);
      expect(client.paramsFor("UPDATE dropship.dropship_admin_config_commands")).toEqual([
        50, "dropship_cost_change_policy", "9", now,
      ]);

      // The audit row carries the real staff actor and the full before -> after.
      const auditParams = client.paramsFor("INSERT INTO dropship.dropship_audit_events");
      expect(auditParams?.slice(0, 5)).toEqual([
        "dropship_cost_change_policy", "9", "cost_change_policy_version_created", "admin", "admin-1",
      ]);
      const payload = JSON.parse(String(auditParams?.[5]));
      expect(payload).toMatchObject({
        version: 4,
        idempotencyKey: "cost-change-policy-001",
        changeNote: "Three weeks' notice for the holiday catalog.",
        before: { policyId: 7, version: 3, increaseNoticeDays: 14, decreaseTiming: "immediate" },
        after: { policyId: 9, version: 4, ...settings },
      });
      expect(auditParams?.[6]).toBe(now);
    });

    it("skips the retire and records no before when no version was ever published", async () => {
      const client = new ScriptedClient({ existingActive: false });
      const repository = new PgDropshipCostChangePolicyRepository(poolFor(client));

      const outcome = await repository.createPolicyVersion(command);

      expect(outcome.previousPolicy).toBeNull();
      expect(outcome.policy.version).toBe(1);
      expect(client.indexOf("UPDATE dropship.dropship_cost_change_policies")).toBe(-1);
      const payload = JSON.parse(String(client.paramsFor("INSERT INTO dropship.dropship_audit_events")?.[5]));
      expect(payload.before).toBeNull();
    });

    it("stores a missing actor id as null", async () => {
      const client = new ScriptedClient();
      await new PgDropshipCostChangePolicyRepository(poolFor(client)).createPolicyVersion({
        ...command,
        actor: { actorType: "admin" },
      });
      expect(client.paramsFor("INSERT INTO dropship.dropship_cost_change_policies")?.at(-1)).toBeNull();
      expect(client.paramsFor("INSERT INTO dropship.dropship_audit_events")?.[4]).toBeNull();
    });

    it("replays a completed command without writing anything", async () => {
      const client = new ScriptedClient({ replayEntityId: "7" });
      const repository = new PgDropshipCostChangePolicyRepository(poolFor(client));

      const outcome = await repository.createPolicyVersion(command);

      expect(outcome).toMatchObject({ idempotentReplay: true, previousPolicy: null });
      expect(outcome.policy.policyId).toBe(7);
      expect(client.paramsFor("SELECT * FROM dropship.dropship_cost_change_policies WHERE id = $1")).toEqual([7]);
      expect(client.indexOf("pg_advisory_xact_lock")).toBe(-1);
      expect(client.indexOf("INSERT INTO dropship.dropship_cost_change_policies")).toBe(-1);
      expect(client.indexOf("INSERT INTO dropship.dropship_audit_events")).toBe(-1);
      expect(client.queries.at(-1)).toBe("COMMIT");
      expect(client.released).toBe(true);
    });

    it("refuses an idempotency key reused for a different request", async () => {
      const client = new ScriptedClient({ replayEntityId: "7", existingRequestHash: "a-different-hash" });
      const repository = new PgDropshipCostChangePolicyRepository(poolFor(client));

      await expect(repository.createPolicyVersion(command)).rejects.toMatchObject({
        code: "DROPSHIP_COST_CHANGE_POLICY_IDEMPOTENCY_CONFLICT",
        context: expect.objectContaining({ classification: "permanent" }),
      });
      expect(client.queries).toContain("ROLLBACK");
      expect(client.released).toBe(true);
    });

    it("treats a command claimed but never finished as transient, not as a replay", async () => {
      const client = new ScriptedClient({ replayEntityId: null });
      const repository = new PgDropshipCostChangePolicyRepository(poolFor(client));

      await expect(repository.createPolicyVersion(command)).rejects.toMatchObject({
        code: "DROPSHIP_COST_CHANGE_POLICY_COMMAND_INCOMPLETE",
        context: expect.objectContaining({ classification: "transient" }),
      });
      expect(client.queries).toContain("ROLLBACK");
    });

    it("rolls back and classifies a concurrent publish as retryable", async () => {
      const client = new ScriptedClient({ insertError: Object.assign(new Error("duplicate key"), { code: "23505" }) });
      const repository = new PgDropshipCostChangePolicyRepository(poolFor(client));

      await expect(repository.createPolicyVersion(command)).rejects.toMatchObject({
        code: "DROPSHIP_COST_CHANGE_POLICY_CONFLICT",
        context: expect.objectContaining({ classification: "transient" }),
      });
      expect(client.queries).toContain("ROLLBACK");
      expect(client.indexOf("INSERT INTO dropship.dropship_audit_events")).toBe(-1);
      expect(client.released).toBe(true);
    });

    it("rolls back and classifies a violated CHECK constraint as bad input", async () => {
      const client = new ScriptedClient({ insertError: Object.assign(new Error("check violation"), { code: "23514" }) });
      const repository = new PgDropshipCostChangePolicyRepository(poolFor(client));

      await expect(repository.createPolicyVersion(command)).rejects.toMatchObject({
        code: "DROPSHIP_COST_CHANGE_POLICY_INVALID_INPUT",
        context: expect.objectContaining({ classification: "permanent" }),
      });
      expect(client.queries).toContain("ROLLBACK");
    });

    it("rolls back and rethrows an unclassified failure untouched", async () => {
      const failure = Object.assign(new Error("connection reset"), { code: "08006" });
      const client = new ScriptedClient({ insertError: failure });
      const repository = new PgDropshipCostChangePolicyRepository(poolFor(client));

      await expect(repository.createPolicyVersion(command)).rejects.toBe(failure);
      expect(client.queries).toContain("ROLLBACK");
      expect(client.released).toBe(true);
    });
  });
});

describe("mapCostChangePolicyError", () => {
  it("passes through values that are not PG errors", () => {
    const plain = new Error("plain");
    expect(mapCostChangePolicyError(plain)).toBe(plain);
    expect(mapCostChangePolicyError("text")).toBe("text");
    expect(mapCostChangePolicyError(null)).toBeNull();
  });
});

interface ScriptedClientOptions {
  existingActive?: boolean;
  replayEntityId?: string | null;
  existingRequestHash?: string;
  insertError?: Error;
}

/**
 * DI-stubbed pg client in the style of the wallet policy repository test: it
 * answers by SQL shape and records what was asked, so the transaction's
 * ordering and parameters can be asserted without a database.
 */
class ScriptedClient {
  readonly queries: string[] = [];
  readonly params: unknown[][] = [];
  released = false;

  constructor(private readonly options: ScriptedClientOptions = {}) {}

  indexOf(fragment: string): number {
    return this.queries.findIndex((query) => query.includes(fragment));
  }

  paramsFor(fragment: string): unknown[] | undefined {
    const index = this.indexOf(fragment);
    return index === -1 ? undefined : this.params[index];
  }

  async query<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    const normalized = sql.trim();
    this.queries.push(normalized);
    this.params.push(values);

    if (normalized.includes("INSERT INTO dropship.dropship_admin_config_commands")) {
      // No row back means the key is already taken: fall through to the replay read.
      return result(this.options.replayEntityId === undefined ? [{ id: 50 } as unknown as T] : []);
    }
    if (normalized.includes("FROM dropship.dropship_admin_config_commands")) {
      return result([{
        id: 50,
        command_type: "cost_change_policy_version_created",
        request_hash: this.options.existingRequestHash ?? "request-hash",
        entity_id: this.options.replayEntityId ?? null,
      } as unknown as T]);
    }
    if (normalized.includes("SELECT * FROM dropship.dropship_cost_change_policies WHERE id = $1")) {
      return result([policyRow() as unknown as T]);
    }
    if (normalized.includes("WHERE is_active = true FOR UPDATE")) {
      return result(this.options.existingActive === false ? [] : [previousRow() as unknown as T]);
    }
    if (normalized.includes("COALESCE(MAX(version), 0) + 1")) {
      return result([{ version: this.options.existingActive === false ? 1 : 4 } as unknown as T]);
    }
    if (normalized.includes("INSERT INTO dropship.dropship_cost_change_policies")) {
      if (this.options.insertError) throw this.options.insertError;
      return result([{
        ...policyRow(),
        id: 9,
        version: this.options.existingActive === false ? 1 : 4,
        created_by_actor_id: values[16] ?? null,
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
    increase_notice_days: 21,
    decrease_timing: "after_notice",
    price_protection: true,
    retail_changes_get_notice: false,
    notify_by_email: true,
    notify_in_portal: true,
    notify_on_decrease: false,
    notice_minimum_change_cents: 25,
    notice_minimum_change_bps: 150,
    rule_priced_listings: "wait_for_review",
    below_cost_fixed_listings: "pause_listing",
    detection_interval_minutes: 30,
    is_active: true,
    change_note: "Three weeks' notice for the holiday catalog.",
    created_at: now,
    created_by_actor_type: "admin",
    created_by_actor_id: "admin-1",
    deactivated_at: null,
  };
}

/** The version the write retires: the migration's defaults. */
function previousRow(): Record<string, unknown> {
  return {
    ...policyRow(),
    increase_notice_days: 14,
    decrease_timing: "immediate",
    retail_changes_get_notice: true,
    notify_on_decrease: true,
    notice_minimum_change_cents: 0,
    notice_minimum_change_bps: 0,
    rule_priced_listings: "reprice_automatically",
    below_cost_fixed_listings: "warn",
    detection_interval_minutes: 60,
    change_note: "Initial defaults from migration 0710. Confirm or change them in Dropship, Cost changes.",
    created_by_actor_type: "system",
    created_by_actor_id: "migration:0710",
  };
}

function poolFor(client: ScriptedClient): Pool {
  return { connect: async () => client as unknown as PoolClient } as unknown as Pool;
}

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}
