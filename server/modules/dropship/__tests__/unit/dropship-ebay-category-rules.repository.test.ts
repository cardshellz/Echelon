import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgDropshipEbayCategoryRulesRepository } from "../../infrastructure/dropship-ebay-category-rules.repository";
import { SLEEVES, rulesProfile } from "../fixtures/ebay-category-rules.fixture";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));

const NOW = new Date("2026-09-30T12:00:00.000Z");

class ScriptedClient {
  sql: string[] = [];
  params: unknown[][] = [];
  release = vi.fn();
  headRevision: { id: number; profile: unknown; created_at: Date } | null = null;
  replay: { request_hash: string; store_connection_id: number } | null = null;
  ownerFound = true;

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = text.trim();
    this.sql.push(sql);
    this.params.push(params);
    if (sql.includes("FROM dropship.dropship_vendors v")) return rows<T>(this.ownerFound ? [{ vendor_id: 10 }] : []);
    if (sql.includes("FROM dropship.dropship_ebay_category_rule_profiles p")) return rows<T>(this.headRevision ? [this.headRevision] : []);
    if (sql.startsWith("SELECT request_hash, store_connection_id")) return rows<T>(this.replay ? [this.replay] : []);
    if (sql.startsWith("INSERT INTO dropship.dropship_ebay_category_rule_revisions")) {
      this.headRevision = { id: 12, profile: JSON.parse(String(params[3])), created_at: NOW };
      return rows<T>([{ id: 12 }]);
    }
    return rows<T>([]);
  }
}

function rows<T>(values: unknown[]): { rows: T[] } {
  return { rows: values as T[] };
}

function poolFor(client: ScriptedClient): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

describe("PgDropshipEbayCategoryRulesRepository", () => {
  it("reads in a read-only snapshot without the store lock or row locks", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));

    const state = await repository.execute({ memberId: "member-1", storeConnectionId: 44, mode: "read" }, (tx) => tx.loadState());

    expect(state).toEqual({ revisionId: null, profile: null, updatedAt: null });
    expect(client.sql[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(client.sql.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(false);
    expect(client.sql.some((sql) => sql.includes("FOR SHARE"))).toBe(false);
    expect(client.sql.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("writes under the request and store locks, chains the revision and audits before and after", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));
    const profile = rulesProfile({ defaultCategory: SLEEVES });

    const state = await repository.execute(
      { memberId: "member-1", storeConnectionId: 44, mode: "write", idempotencyKey: "category-rules:1" },
      async (tx) => {
        await tx.saveProfile({ expectedRevisionId: null, profile, idempotencyKey: "category-rules:1", requestHash: "a".repeat(64), now: NOW });
        return tx.loadState();
      },
    );

    expect(state).toMatchObject({ revisionId: 12, profile });
    expect(client.sql[0]).toBe("BEGIN");
    expect(client.sql[1]).toContain("hashtext('dropship_ebay_category_rules_request')");
    expect(client.sql[2]).toContain("hashtext('dropship_listing_push_job')");
    expect(client.sql.find((sql) => sql.includes("FROM dropship.dropship_vendors v"))).toContain("FOR SHARE OF v, sc");
    const insertIndex = client.sql.findIndex((sql) => sql.startsWith("INSERT INTO dropship.dropship_ebay_category_rule_revisions"));
    expect(client.params[insertIndex]).toEqual([10, 44, null, JSON.stringify(profile), "category-rules:1", "a".repeat(64), "member-1", NOW]);
    expect(client.sql.some((sql) => sql.includes("INSERT INTO dropship.dropship_ebay_category_rule_profiles"))).toBe(true);
    const auditIndex = client.sql.findIndex((sql) => sql.includes("dropship_audit_events"));
    expect(JSON.parse(String(client.params[auditIndex][4]))).toEqual({ revisionId: 12, previousRevisionId: null, before: null, after: profile });
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("refuses a stale expected revision and rolls back without writing", async () => {
    const client = new ScriptedClient();
    client.headRevision = { id: 5, profile: rulesProfile(), created_at: NOW };
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));

    await expect(repository.execute(
      { memberId: "member-1", storeConnectionId: 44, mode: "write", idempotencyKey: "category-rules:2" },
      (tx) => tx.saveProfile({ expectedRevisionId: 4, profile: rulesProfile(), idempotencyKey: "category-rules:2", requestHash: "b".repeat(64), now: NOW }),
    )).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT" });
    expect(client.sql.some((sql) => sql.startsWith("INSERT INTO"))).toBe(false);
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("replays a matching key and refuses the same key for a different request or store", async () => {
    const client = new ScriptedClient();
    client.replay = { request_hash: "c".repeat(64), store_connection_id: 44 };
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));
    const input = { memberId: "member-1", storeConnectionId: 44, mode: "read" as const };

    await expect(repository.execute(input, (tx) => tx.findReplay("category-rules:3", "c".repeat(64)))).resolves.toBe(true);
    await expect(repository.execute(input, (tx) => tx.findReplay("category-rules:3", "d".repeat(64))))
      .rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    client.replay = { request_hash: "c".repeat(64), store_connection_id: 45 };
    await expect(repository.execute(input, (tx) => tx.findReplay("category-rules:3", "c".repeat(64))))
      .rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
  });

  it("refuses a write from a read transaction or with another request's key", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));
    const save = { expectedRevisionId: null, profile: rulesProfile(), requestHash: "e".repeat(64), now: NOW };

    await expect(repository.execute({ memberId: "member-1", storeConnectionId: 44, mode: "read" },
      (tx) => tx.saveProfile({ ...save, idempotencyKey: "category-rules:4" }))).rejects.toThrow("write transaction");
    await expect(repository.execute({ memberId: "member-1", storeConnectionId: 44, mode: "write", idempotencyKey: "category-rules:4" },
      (tx) => tx.saveProfile({ ...save, idempotencyKey: "category-rules:5" }))).rejects.toThrow("write transaction");
    await expect(repository.execute({ memberId: "member-1", storeConnectionId: 44, mode: "write" }, async () => undefined))
      .rejects.toThrow("requires its request key");
  });

  it("reports a store that is not the member's as not found", async () => {
    const client = new ScriptedClient();
    client.ownerFound = false;
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));

    await expect(repository.execute({ memberId: "member-2", storeConnectionId: 44, mode: "read" }, (tx) => tx.loadState()))
      .rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("refuses persisted rules that no longer satisfy the contract", async () => {
    const client = new ScriptedClient();
    client.headRevision = { id: 5, profile: { version: 2, rules: "broken" }, created_at: NOW };
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));

    await expect(repository.execute({ memberId: "member-1", storeConnectionId: 44, mode: "read" }, (tx) => tx.loadState()))
      .rejects.toThrow("failed their contract");
  });
});
