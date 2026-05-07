import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgDropshipTrackingPushOpsRepository } from "../../infrastructure/dropship-tracking-push-ops.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const now = new Date("2026-05-03T12:00:00.000Z");
const shippedAt = new Date("2026-05-02T10:00:00.000Z");

describe("PgDropshipTrackingPushOpsRepository", () => {
  it("rejects non-stale processing tracking push retries without updating the row", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "ROLLBACK") {
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_marketplace_tracking_pushes")) {
        return {
          rows: [
            makeRetryRow({
              status: "processing",
              updated_at: now,
            }),
          ],
        };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipTrackingPushOpsRepository(makePool(makeClient(query)));

    await expect(repository.prepareRetry(makeRetryInput())).rejects.toMatchObject({
      code: "DROPSHIP_TRACKING_PUSH_OPS_STATUS_NOT_RETRYABLE",
      context: {
        pushId: 42,
        status: "processing",
        updatedAt: now.toISOString(),
        staleAfterMinutes: 30,
      },
    });
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_marketplace_tracking_pushes"),
    )).toBe(false);
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    )).toBe(false);
  });

  it("queues stale processing tracking pushes for ops retry with audit context", async () => {
    const staleUpdatedAt = new Date("2026-05-03T11:20:00.000Z");
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "COMMIT") {
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_marketplace_tracking_pushes")) {
        return {
          rows: [
            makeRetryRow({
              status: "processing",
              attempt_count: 3,
              updated_at: staleUpdatedAt,
            }),
          ],
        };
      }
      if (sqlText.includes("UPDATE dropship.dropship_marketplace_tracking_pushes")) {
        return {
          rows: [
            makeRetryRow({
              status: "queued",
              attempt_count: 3,
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
    const repository = new PgDropshipTrackingPushOpsRepository(makePool(makeClient(query)));

    const result = await repository.prepareRetry(makeRetryInput());

    expect(result).toMatchObject({
      pushId: 42,
      previousStatus: "processing",
      omsOrderId: 500,
      wmsShipmentId: 700,
      idempotencyKey: "tracking-existing-key",
      previousAttemptCount: 3,
    });

    const updateCall = query.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_marketplace_tracking_pushes"),
    );
    expect(updateCall?.[1]?.[0]).toBe(42);
    expect(JSON.parse(String(updateCall?.[1]?.[1]))).toMatchObject({
      lastRetryRequest: {
        idempotencyKey: "admin-retry-42",
        reason: "recover stale processing push",
        actorType: "admin",
        actorId: "ops-user",
        requestedAt: now.toISOString(),
      },
    });

    const auditCall = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    );
    expect(auditCall?.[1]?.[3]).toBe("tracking_push_retry_requested");
    expect(auditCall?.[1]?.[4]).toBe("admin");
    expect(auditCall?.[1]?.[5]).toBe("ops-user");
    expect(auditCall?.[1]?.[6]).toBe("info");
    expect(JSON.parse(String(auditCall?.[1]?.[7]))).toMatchObject({
      previousStatus: "processing",
      previousAttemptCount: 3,
      stalePushUpdatedAt: staleUpdatedAt.toISOString(),
      staleAfterMinutes: 30,
      reason: "recover stale processing push",
    });
  });
});

function makeRetryInput() {
  return {
    pushId: 42,
    idempotencyKey: "admin-retry-42",
    reason: "recover stale processing push",
    actor: { actorType: "admin" as const, actorId: "ops-user" },
    now,
  };
}

function makeRetryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    intake_id: 10,
    oms_order_id: 500,
    wms_shipment_id: 700,
    vendor_id: 20,
    store_connection_id: 30,
    platform: "ebay",
    external_order_id: "ORDER-1",
    status: "failed",
    idempotency_key: "tracking-existing-key",
    carrier: "USPS",
    tracking_number: "94001111",
    shipped_at: shippedAt,
    attempt_count: 2,
    last_error_code: "TEMPORARY_OUTAGE",
    last_error_message: "Temporary outage.",
    raw_result: { lastFailure: { retryable: true } },
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
