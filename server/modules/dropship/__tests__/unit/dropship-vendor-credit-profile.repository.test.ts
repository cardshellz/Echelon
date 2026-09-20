import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgDropshipVendorCreditProfileRepository } from "../../infrastructure/dropship-vendor-credit-profile.repository";

const now = new Date("2026-09-20T10:00:00.000Z");

const command = {
  vendorId: 10,
  advanceCapOverrideCents: 200_000,
  note: "Six months of clean settlements.",
  idempotencyKey: "credit-profile-001",
  requestHash: "request-hash",
  actor: { actorType: "admin" as const, actorId: "admin-1" },
  now,
};

describe("PgDropshipVendorCreditProfileRepository", () => {
  describe("getByVendorId", () => {
    it("maps the row, parsing bigint cents that pg returns as strings", async () => {
      const query = vi.fn(async (_sql: string, _values?: unknown[]) => result([profileRow()]));
      const repository = new PgDropshipVendorCreditProfileRepository({ query } as unknown as Pool);

      const profile = await repository.getByVendorId(10);

      expect(query.mock.calls[0]?.[1]).toEqual([10]);
      expect(profile).toEqual({
        vendorId: 10,
        advanceCapOverrideCents: 200_000,
        note: "Six months of clean settlements.",
        createdAt: now,
        updatedAt: now,
        updatedBy: { actorType: "admin", actorId: "admin-1" },
      });
    });

    it("returns null when the vendor has no profile, and maps a NULL override to null", async () => {
      const none = vi.fn(async (_sql: string, _values?: unknown[]) => result([]));
      await expect(new PgDropshipVendorCreditProfileRepository({ query: none } as unknown as Pool).getByVendorId(10))
        .resolves.toBeNull();

      const cleared = vi.fn(async (_sql: string, _values?: unknown[]) => result([{ ...profileRow(), advance_cap_override_cents: null }]));
      await expect(new PgDropshipVendorCreditProfileRepository({ query: cleared } as unknown as Pool).getByVendorId(10))
        .resolves.toMatchObject({ advanceCapOverrideCents: null });
    });

    it("honours a stored zero override and refuses a negative or fractional one", async () => {
      const zero = vi.fn(async (_sql: string, _values?: unknown[]) => result([{ ...profileRow(), advance_cap_override_cents: "0" }]));
      await expect(new PgDropshipVendorCreditProfileRepository({ query: zero } as unknown as Pool).getByVendorId(10))
        .resolves.toMatchObject({ advanceCapOverrideCents: 0 });

      for (const bad of ["-1", "12.5"]) {
        const query = vi.fn(async (_sql: string, _values?: unknown[]) => result([{ ...profileRow(), advance_cap_override_cents: bad }]));
        await expect(new PgDropshipVendorCreditProfileRepository({ query } as unknown as Pool).getByVendorId(10))
          .rejects.toMatchObject({
            code: "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_STORED_VALUE",
            context: expect.objectContaining({ classification: "fatal", column: "advance_cap_override_cents" }),
          });
      }
    });

    it("classifies a missing table as transient so the caller can fall back to the policy cap", async () => {
      const query = vi.fn(async (_sql: string, _values?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
        throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      });
      await expect(new PgDropshipVendorCreditProfileRepository({ query } as unknown as Pool).getByVendorId(10))
        .rejects.toMatchObject({
          code: "DROPSHIP_VENDOR_CREDIT_PROFILE_TABLE_MISSING",
          context: expect.objectContaining({ classification: "transient" }),
        });
    });
  });

  describe("set", () => {
    it("claims the command, locks the row, upserts, completes the command and audits before -> after in one transaction", async () => {
      const client = new ScriptedClient({ existing: { ...profileRow(), advance_cap_override_cents: "100000", note: "old" } });
      const repository = new PgDropshipVendorCreditProfileRepository(poolFor(client));

      const set = await repository.set(command);

      expect(set.idempotentReplay).toBe(false);
      expect(set.previousProfile?.advanceCapOverrideCents).toBe(100_000);
      expect(set.profile.advanceCapOverrideCents).toBe(200_000);
      expect(client.queries[0]).toBe("BEGIN");
      expect(client.queries.at(-1)).toBe("COMMIT");

      const order = [
        "INSERT INTO dropship.dropship_admin_config_commands",
        "WHERE vendor_id = $1 FOR UPDATE",
        "INSERT INTO dropship.dropship_vendor_credit_profiles",
        "UPDATE dropship.dropship_admin_config_commands",
        "INSERT INTO dropship.dropship_audit_events",
      ].map((fragment) => client.queries.findIndex((query) => query.includes(fragment)));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      const upsert = client.queries.find((query) => query.includes("INSERT INTO dropship.dropship_vendor_credit_profiles"));
      expect(upsert).toContain("ON CONFLICT (vendor_id) DO UPDATE");
      expect(client.paramsFor("INSERT INTO dropship.dropship_vendor_credit_profiles"))
        .toEqual([10, 200_000, "Six months of clean settlements.", now, "admin", "admin-1"]);

      const commandParams = client.paramsFor("INSERT INTO dropship.dropship_admin_config_commands");
      expect(commandParams?.slice(0, 4)).toEqual([
        "vendor_credit_profile_set", "credit-profile-001", "request-hash", "dropship_vendor_credit_profile",
      ]);
      // The command's entity is the vendor, so a replay can find the row again.
      expect(client.paramsFor("UPDATE dropship.dropship_admin_config_commands")?.[2]).toBe("10");

      // The audit row is attributed to the vendor and to the real staff actor.
      const auditParams = client.paramsFor("INSERT INTO dropship.dropship_audit_events");
      expect(auditParams?.slice(0, 6)).toEqual([
        10, "dropship_vendor_credit_profile", "10", "vendor_credit_profile_set", "admin", "admin-1",
      ]);
      const payload = JSON.parse(String(auditParams?.[6]));
      expect(payload).toEqual({
        idempotencyKey: "credit-profile-001",
        before: { advanceCapOverrideCents: 100_000, note: "old" },
        after: { advanceCapOverrideCents: 200_000, note: "Six months of clean settlements." },
      });
    });

    it("records a null before when the vendor had no profile", async () => {
      const client = new ScriptedClient({ existing: null });
      const repository = new PgDropshipVendorCreditProfileRepository(poolFor(client));

      const set = await repository.set(command);

      expect(set.previousProfile).toBeNull();
      const payload = JSON.parse(String(client.paramsFor("INSERT INTO dropship.dropship_audit_events")?.[6]));
      expect(payload.before).toBeNull();
    });

    it("clears the override when asked to, passing NULL through to the row", async () => {
      const client = new ScriptedClient({ existing: profileRow(), written: { ...profileRow(), advance_cap_override_cents: null, note: null } });
      const repository = new PgDropshipVendorCreditProfileRepository(poolFor(client));

      const set = await repository.set({ ...command, advanceCapOverrideCents: null, note: null });

      expect(client.paramsFor("INSERT INTO dropship.dropship_vendor_credit_profiles")?.slice(1, 3)).toEqual([null, null]);
      expect(set.profile.advanceCapOverrideCents).toBeNull();
    });

    it("replays a completed command by re-reading the vendor's row, writing nothing", async () => {
      const client = new ScriptedClient({ replayEntityId: "10" });
      const repository = new PgDropshipVendorCreditProfileRepository(poolFor(client));

      const set = await repository.set(command);

      expect(set).toMatchObject({ idempotentReplay: true, previousProfile: null });
      expect(set.profile.vendorId).toBe(10);
      expect(client.queries.some((query) => query.includes("INSERT INTO dropship.dropship_vendor_credit_profiles"))).toBe(false);
      expect(client.queries.some((query) => query.includes("INSERT INTO dropship.dropship_audit_events"))).toBe(false);
      expect(client.queries.at(-1)).toBe("COMMIT");
    });

    it("refuses an idempotency key reused for a different request", async () => {
      const client = new ScriptedClient({ replayEntityId: "10", existingRequestHash: "another" });
      const repository = new PgDropshipVendorCreditProfileRepository(poolFor(client));

      await expect(repository.set(command)).rejects.toMatchObject({
        code: "DROPSHIP_VENDOR_CREDIT_PROFILE_IDEMPOTENCY_CONFLICT",
        context: expect.objectContaining({ classification: "permanent" }),
      });
      expect(client.queries).toContain("ROLLBACK");
      expect(client.released).toBe(true);
    });

    it("treats a command claimed but never finished as transient", async () => {
      const client = new ScriptedClient({ replayEntityId: null });
      const repository = new PgDropshipVendorCreditProfileRepository(poolFor(client));

      await expect(repository.set(command)).rejects.toMatchObject({
        code: "DROPSHIP_VENDOR_CREDIT_PROFILE_COMMAND_INCOMPLETE",
        context: expect.objectContaining({ classification: "transient" }),
      });
      expect(client.queries).toContain("ROLLBACK");
    });

    it("maps an unknown vendor (foreign key) to a permanent not-found, rolling back", async () => {
      const client = new ScriptedClient({ writeError: Object.assign(new Error("fk"), { code: "23503" }) });
      const repository = new PgDropshipVendorCreditProfileRepository(poolFor(client));

      await expect(repository.set(command)).rejects.toMatchObject({
        code: "DROPSHIP_VENDOR_CREDIT_PROFILE_VENDOR_NOT_FOUND",
        context: expect.objectContaining({ classification: "permanent" }),
      });
      expect(client.queries).toContain("ROLLBACK");
      expect(client.released).toBe(true);
    });

    it("maps a violated CHECK constraint to bad input", async () => {
      const client = new ScriptedClient({ writeError: Object.assign(new Error("check"), { code: "23514" }) });
      const repository = new PgDropshipVendorCreditProfileRepository(poolFor(client));

      await expect(repository.set(command)).rejects.toMatchObject({
        code: "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_INPUT",
        context: expect.objectContaining({ classification: "permanent" }),
      });
      expect(client.queries).toContain("ROLLBACK");
    });
  });
});

interface ScriptedClientOptions {
  existing?: Record<string, unknown> | null;
  written?: Record<string, unknown>;
  replayEntityId?: string | null;
  existingRequestHash?: string;
  writeError?: Error;
}

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
      return result(this.options.replayEntityId === undefined ? [{ id: 60 } as unknown as T] : []);
    }
    if (normalized.includes("FROM dropship.dropship_admin_config_commands")) {
      return result([{
        id: 60,
        command_type: "vendor_credit_profile_set",
        request_hash: this.options.existingRequestHash ?? "request-hash",
        entity_id: this.options.replayEntityId ?? null,
      } as unknown as T]);
    }
    if (normalized.includes("WHERE vendor_id = $1 FOR UPDATE")) {
      const existing = this.options.existing === undefined ? profileRow() : this.options.existing;
      return result(existing ? [existing as unknown as T] : []);
    }
    if (normalized.includes("FROM dropship.dropship_vendor_credit_profiles WHERE vendor_id = $1 LIMIT 1")) {
      return result([profileRow() as unknown as T]);
    }
    if (normalized.includes("INSERT INTO dropship.dropship_vendor_credit_profiles")) {
      if (this.options.writeError) throw this.options.writeError;
      return result([(this.options.written ?? profileRow()) as unknown as T]);
    }
    return result([]);
  }

  release(): void {
    this.released = true;
  }
}

function profileRow(): Record<string, unknown> {
  return {
    id: 4,
    vendor_id: 10,
    // pg returns bigint columns as strings; the mapper has to parse them.
    advance_cap_override_cents: "200000",
    note: "Six months of clean settlements.",
    created_at: now,
    updated_at: now,
    updated_by_actor_type: "admin",
    updated_by_actor_id: "admin-1",
  };
}

function poolFor(client: ScriptedClient): Pool {
  return { connect: async () => client as unknown as PoolClient } as unknown as Pool;
}

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}
