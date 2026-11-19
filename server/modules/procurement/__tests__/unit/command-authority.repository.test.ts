import { PgDialect } from "drizzle-orm/pg-core";
import { type SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { readCommandAuthorityActor } from "../../../identity/infrastructure/command-authority.repository";

function reader(rows: unknown[][]) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const execute = vi.fn(async (query: SQL) => {
    statements.push(new PgDialect().sqlToQuery(query));
    const result = rows.shift();
    if (!result) throw new Error("Unexpected authority query");
    return { rows: result };
  });
  return { execute, statements };
}

describe("Identity command authority projection", () => {
  it("deduplicates current unconstrained grants and preserves scoped evidence separately", async () => {
    const tx = reader([[{ id: "buyer", active: 1 }], [{ id: 1 }], [
      { resource: "settings", action: "edit", unscoped: true },
      { resource: "purchasing", action: "cancel", unscoped: true },
      { resource: "settings", action: "edit", unscoped: true },
      { resource: "purchasing", action: "approve", unscoped: false },
    ]]);
    expect(await readCommandAuthorityActor(tx, "buyer")).toEqual({
      userId: "buyer", active: true, permissions: ["purchasing:cancel", "settings:edit"], scopedPermissions: ["purchasing:approve"],
    });
    expect(tx.statements.every((statement) => statement.params.includes("buyer"))).toBe(true);
    expect(tx.statements.map((statement) => statement.sql.replace(/\s+/g, " "))).toEqual([
      expect.stringContaining("FOR SHARE"),
      expect.stringContaining("FOR SHARE OF role,assignment"),
      expect.stringContaining("FOR SHARE OF assignment,grant_row,permission"),
    ]);
  });

  it.each([{ users: [] }, { users: [{ id: "buyer", active: 0 }] }])("returns no authority for missing or inactive current accounts", async ({ users }) => {
    const tx = reader([users]);
    expect(await readCommandAuthorityActor(tx, "buyer")).toEqual({ userId: "buyer", active: false, permissions: [], scopedPermissions: [] });
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty actor before issuing a database query", async () => {
    const tx = reader([]);
    await expect(readCommandAuthorityActor(tx, "  ")).rejects.toThrow();
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "true", 1])("rejects malformed unscoped evidence (%s) instead of authorizing", async (unscoped) => {
    const tx = reader([[{ id: "buyer", active: 1 }], [{ id: 1 }], [
      { resource: "purchasing", action: "approve", unscoped },
    ]]);
    await expect(readCommandAuthorityActor(tx, "buyer")).rejects.toThrow();
  });
});
