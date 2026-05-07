import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgDropshipOrderOpsRepository } from "../../infrastructure/dropship-order-ops.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const now = new Date("2026-05-03T12:00:00.000Z");

describe("PgDropshipOrderOpsRepository", () => {
  it("rejects non-stale processing intake retries without updating the row", async () => {
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "ROLLBACK") {
        return { rows: [] };
      }
      if (sqlText.trim().startsWith("SELECT") && sqlText.includes("FOR UPDATE")) {
        return {
          rows: [
            makeActionRow({
              status: "processing",
              updated_at: now,
            }),
          ],
        };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipOrderOpsRepository(makePool(makeClient(query)));

    await expect(repository.retryIntake(makeRetryInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_OPS_STATUS_NOT_RETRYABLE",
      context: {
        intakeId: 42,
        status: "processing",
        updatedAt: now.toISOString(),
        staleAfterMinutes: 30,
      },
    });
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_order_intake"),
    )).toBe(false);
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    )).toBe(false);
  });

  it("moves stale processing intakes to retrying with audit context", async () => {
    const staleUpdatedAt = new Date("2026-05-03T11:20:00.000Z");
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "COMMIT") {
        return { rows: [] };
      }
      if (sqlText.trim().startsWith("SELECT") && sqlText.includes("FOR UPDATE")) {
        return {
          rows: [
            makeActionRow({
              status: "processing",
              updated_at: staleUpdatedAt,
            }),
          ],
        };
      }
      if (sqlText.includes("UPDATE dropship.dropship_order_intake")) {
        return {
          rows: [
            makeActionRow({
              status: "retrying",
              updated_at: now,
            }),
          ],
        };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipOrderOpsRepository(makePool(makeClient(query)));

    const result = await repository.retryIntake(makeRetryInput());

    expect(result).toMatchObject({
      intakeId: 42,
      previousStatus: "processing",
      status: "retrying",
      idempotentReplay: false,
      updatedAt: now,
    });

    const updateCall = query.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_order_intake"),
    );
    expect(updateCall?.[1]).toEqual([42, now]);

    const auditCall = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    );
    expect(auditCall?.[1]?.[0]).toBe(10);
    expect(auditCall?.[1]?.[1]).toBe(22);
    expect(auditCall?.[1]?.[2]).toBe("42");
    expect(auditCall?.[1]?.[3]).toBe("order_ops_retry_requested");
    expect(auditCall?.[1]?.[4]).toBe("admin");
    expect(auditCall?.[1]?.[5]).toBe("ops-user");
    expect(auditCall?.[1]?.[6]).toBe("info");
    expect(JSON.parse(String(auditCall?.[1]?.[7]))).toMatchObject({
      externalOrderId: "ORDER-42",
      idempotencyKey: "admin-retry-42",
      previousStatus: "processing",
      staleProcessingUpdatedAt: staleUpdatedAt.toISOString(),
      staleAfterMinutes: 30,
      reason: "recover stale processing intake",
    });
  });
});

function makeRetryInput() {
  return {
    intakeId: 42,
    idempotencyKey: "admin-retry-42",
    reason: "recover stale processing intake",
    actor: { actorType: "admin" as const, actorId: "ops-user" },
    now,
  };
}

function makeActionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    vendor_id: 10,
    store_connection_id: 22,
    external_order_id: "ORDER-42",
    status: "failed",
    payment_hold_expires_at: null,
    rejection_reason: "previous failure",
    cancellation_status: null,
    updated_at: now,
    ...overrides,
  };
}

function makeClient(query: ReturnType<typeof vi.fn>): PoolClient {
  return { query, release: vi.fn() } as unknown as PoolClient;
}

function makePool(client: PoolClient): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}
