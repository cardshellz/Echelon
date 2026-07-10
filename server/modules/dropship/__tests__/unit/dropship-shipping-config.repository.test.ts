import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import { PgDropshipShippingConfigRepository } from "../../infrastructure/dropship-shipping-config.repository";

describe("PgDropshipShippingConfigRepository policy windows", () => {
  it("rejects overlapping active markup policies before insertion", async () => {
    const client = new PolicyConflictClient();
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    const repository = new PgDropshipShippingConfigRepository(pool);

    const operation = repository.createMarkupPolicy({
      name: "Summer shipping",
      markupBps: 250,
      fixedMarkupCents: 0,
      minMarkupCents: null,
      maxMarkupCents: null,
      isActive: true,
      effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
      effectiveTo: new Date("2026-08-01T00:00:00.000Z"),
      idempotencyKey: "markup-window-conflict-001",
      requestHash: "request-hash",
      actor: { actorType: "admin", actorId: "admin-1" },
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    await expect(operation).rejects.toMatchObject<DropshipError>({
      code: "DROPSHIP_SHIPPING_POLICY_WINDOW_CONFLICT",
      context: {
        policyKind: "markup",
        conflictingPolicyId: 17,
        conflictingPolicyName: "Default shipping",
      },
    });
    expect(client.queries.some((sql) => sql.includes("INSERT INTO dropship.dropship_shipping_markup_config"))).toBe(false);
    expect(client.queries).toContain("ROLLBACK");
    expect(client.released).toBe(true);
  });
});

class PolicyConflictClient {
  readonly queries: string[] = [];
  released = false;

  async query<T>(sql: string): Promise<QueryResult<T>> {
    this.queries.push(sql.trim());
    if (sql.includes("INSERT INTO dropship.dropship_admin_config_commands")) {
      return result([{ id: 91 } as T]);
    }
    if (sql.includes("SELECT id, name") && sql.includes("dropship_shipping_markup_config")) {
      return result([{ id: 17, name: "Default shipping" } as T]);
    }
    return result([]);
  }

  release(): void {
    this.released = true;
  }
}

function result<T>(rows: T[]): QueryResult<T> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}
