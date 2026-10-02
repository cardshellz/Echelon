import { describe, expect, it, vi } from "vitest";
import { PgDropshipOrderIntakeHealthRepository } from "../../infrastructure/dropship-order-intake-health.repository";
import type { DropshipOrderIntakeHealthPolicy } from "../../domain/dropship-order-intake-health";

const now = new Date("2026-08-25T14:00:00.000Z");
const policy: DropshipOrderIntakeHealthPolicy = {
  degradedAfterFailures: 2,
  stoppedAfterFailures: 6,
  degradedAfterMs: 15 * 60_000,
  stoppedAfterMs: 30 * 60_000,
};

describe("PgDropshipOrderIntakeHealthRepository", () => {
  it("commits the successful poll cursor, heartbeat, setup check, and transition audit atomically", async () => {
    const harness = makeHarness({ healthRows: [] });
    const repository = new PgDropshipOrderIntakeHealthRepository(harness.pool as any);

    const result = await repository.recordPollSucceeded({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      mode: "poll",
      syncedThrough: now,
      now,
      policy,
    });

    expect(result.transition).toMatchObject({
      previousStatus: null,
      transitioned: true,
      current: { status: "healthy", lastSuccessAt: now },
    });
    expect(sqlCalls(harness.client)).toEqual(expect.arrayContaining([
      expect.stringContaining("UPDATE dropship.dropship_store_connections"),
      expect.stringContaining("INSERT INTO dropship.dropship_store_order_intake_health"),
      expect.stringContaining("INSERT INTO dropship.dropship_store_setup_checks"),
      expect.stringContaining("INSERT INTO dropship.dropship_audit_events"),
    ]));
    expect(sqlCalls(harness.client).at(-1)).toBe("COMMIT");
    const cursorCall = harness.client.query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE dropship.dropship_store_connections"));
    expect(cursorCall?.[1]).toEqual([22, now, now]);
  });

  it("records a degraded failure without advancing the successful order cursor", async () => {
    const harness = makeHarness({
      healthRows: [makeHealthRow({ status: "warning", consecutive_failures: 1 })],
    });
    const repository = new PgDropshipOrderIntakeHealthRepository(harness.pool as any);

    const result = await repository.recordPollFailed({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      mode: "poll",
      failureCode: "EBAY_UNAVAILABLE",
      failureMessage: "provider unavailable",
      now,
      policy,
    });

    expect(result.transition.current).toMatchObject({
      status: "degraded",
      consecutiveFailures: 2,
      lastFailureCode: "EBAY_UNAVAILABLE",
    });
    expect(sqlCalls(harness.client).some((sql) =>
      sql.includes("UPDATE dropship.dropship_store_connections"))).toBe(false);
    expect(sqlCalls(harness.client).at(-1)).toBe("COMMIT");
  });

  it("revalidates credentials under the store lock before recording a stale transition", async () => {
    const harness = makeHarness({
      connection: makeConnection({ refresh_token_ref: null }),
      candidateRows: [{ id: 22 }],
      healthRows: [makeHealthRow({
        last_attempt_at: new Date(now.getTime() - 31 * 60_000),
      })],
    });
    const repository = new PgDropshipOrderIntakeHealthRepository(harness.pool as any);

    const results = await repository.recordStalePolls({
      platform: "ebay",
      mode: "poll",
      limit: 100,
      now,
      policy,
    });

    expect(results).toEqual([]);
    const candidateSql = String(harness.pool.query.mock.calls[0]?.[0]);
    expect(candidateSql).toContain("JOIN dropship.dropship_store_order_intake_health health");
    expect(candidateSql).not.toContain("COALESCE(health.last_attempt_at, sc.updated_at)");
    expect(candidateSql).toContain("sc.status = 'connected'");
    expect(candidateSql).toContain("sc.setup_status = 'ready'");
    expect(candidateSql).toContain("sc.access_token_ref IS NOT NULL");
    expect(candidateSql).toContain("sc.refresh_token_ref IS NOT NULL");
    expect(sqlCalls(harness.client).some((sql) =>
      sql.includes("INSERT INTO dropship.dropship_store_order_intake_health"))).toBe(false);
    expect(sqlCalls(harness.client).at(-1)).toBe("COMMIT");
  });

  it("never changes a store's setup status when it records a poll", async () => {
    for (const record of ["succeeded", "failed"] as const) {
      const harness = makeHarness({
        connection: makeConnection({ setup_status: "attention_required" }),
        healthRows: [makeHealthRow({ status: "stopped", consecutive_failures: 6 })],
      });
      const repository = new PgDropshipOrderIntakeHealthRepository(harness.pool as any);

      if (record === "succeeded") {
        await repository.recordPollSucceeded({
          vendorId: 10, storeConnectionId: 22, platform: "ebay", mode: "poll", syncedThrough: now, now, policy,
        });
      } else {
        await repository.recordPollFailed({
          vendorId: 10, storeConnectionId: 22, platform: "ebay", mode: "poll",
          failureCode: "EBAY_UNAVAILABLE", failureMessage: "provider unavailable", now, policy,
        });
      }

      expect(sqlCalls(harness.client).some((sql) => sql.includes("SET setup_status"))).toBe(false);
    }
  });

  it("puts a store held only by its intake health check back to ready, under its lock, with an audit event", async () => {
    const harness = makeHarness({
      connection: makeConnection({ setup_status: "attention_required" }),
      candidateRows: [{ id: 22 }],
      healthRows: [makeHealthRow({
        status: "stopped",
        consecutive_failures: 21,
        last_failure_code: "DROPSHIP_EBAY_ORDER_MONEY_INVALID",
      })],
    });
    const repository = new PgDropshipOrderIntakeHealthRepository(harness.pool as any);

    const restored = await repository.restoreStoresHeldOnlyByOrderIntakeHealth({ platform: "ebay", limit: 25, now });

    expect(restored).toEqual([{
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      externalDisplayName: "marz_cards",
      shopDomain: null,
    }]);
    const candidateSql = String(harness.pool.query.mock.calls[0]?.[0]);
    expect(candidateSql).toContain("sc.setup_status = 'attention_required'");
    expect(candidateSql).toContain("health_check.check_key = $2");
    expect(candidateSql).toContain("ssc.check_key <> $2");
    expect(harness.pool.query.mock.calls[0]?.[1]).toEqual(["ebay", "order_intake_health", 25]);

    const calls = sqlCalls(harness.client);
    expect(calls[0]).toBe("BEGIN");
    expect(calls[1]).toContain("pg_advisory_xact_lock");
    expect(calls[2]).toContain("FOR UPDATE");
    const updateIndex = calls.findIndex((sql) => sql.includes("SET setup_status = 'ready'"));
    expect(updateIndex).toBeGreaterThan(2);
    // The UPDATE re-checks every condition under the lock.
    expect(calls[updateIndex]).toContain("AND sc.status = 'connected'");
    expect(calls[updateIndex]).toContain("AND sc.setup_status = 'attention_required'");
    expect(calls[updateIndex]).toContain("health_check.check_key = $2");
    expect(harness.client.query.mock.calls[updateIndex]?.[1]).toEqual([22, "order_intake_health", now]);
    expect(calls.at(-1)).toBe("COMMIT");

    const audit = harness.client.query.mock.calls.find(([, params]) =>
      Array.isArray(params) && params.includes("store_setup_status_restored"));
    expect(String(audit?.[0])).toContain("'dropship_store_connection'");
    expect(JSON.parse(String((audit?.[1] as unknown[])[5]))).toEqual({
      previousSetupStatus: "attention_required",
      setupStatus: "ready",
      reason: "order_intake_health_does_not_block",
      healthStatus: "stopped",
      consecutiveFailures: 21,
      lastFailureCode: "DROPSHIP_EBAY_ORDER_MONEY_INVALID",
    });
  });

  it("changes nothing when the store moved on before its lock was taken", async () => {
    const harness = makeHarness({
      connection: makeConnection({ setup_status: "attention_required" }),
      candidateRows: [{ id: 22 }],
      healthRows: [makeHealthRow({ status: "stopped", consecutive_failures: 6 })],
      // Under the lock the guarded UPDATE finds another blocker, or a new status.
      setupStatusRestoreRowCount: 0,
    });
    const repository = new PgDropshipOrderIntakeHealthRepository(harness.pool as any);

    const restored = await repository.restoreStoresHeldOnlyByOrderIntakeHealth({ platform: "ebay", limit: 25, now });

    expect(restored).toEqual([]);
    expect(harness.client.query.mock.calls.some(([, params]) =>
      Array.isArray(params) && params.includes("store_setup_status_restored"))).toBe(false);
    expect(sqlCalls(harness.client).at(-1)).toBe("COMMIT");
  });

  it("does not restore a store of another platform", async () => {
    const harness = makeHarness({
      connection: makeConnection({ platform: "shopify", setup_status: "attention_required" }),
      candidateRows: [{ id: 22 }],
    });
    const repository = new PgDropshipOrderIntakeHealthRepository(harness.pool as any);

    expect(await repository.restoreStoresHeldOnlyByOrderIntakeHealth({ platform: "ebay", limit: 25, now })).toEqual([]);
    expect(sqlCalls(harness.client).some((sql) => sql.includes("SET setup_status"))).toBe(false);
  });

  it("fails closed when persisted health state contains an unknown status", async () => {
    const harness = makeHarness({
      healthRows: [makeHealthRow({ status: "mystery" })],
    });
    const repository = new PgDropshipOrderIntakeHealthRepository(harness.pool as any);

    await expect(repository.recordPollFailed({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      mode: "poll",
      failureCode: "EBAY_UNAVAILABLE",
      failureMessage: "provider unavailable",
      now,
      policy,
    })).rejects.toThrow("invalid status");

    expect(sqlCalls(harness.client)).toContain("ROLLBACK");
    expect(sqlCalls(harness.client)).not.toContain("COMMIT");
  });
});

function makeHarness(input: {
  connection?: ReturnType<typeof makeConnection>;
  candidateRows?: Array<{ id: number }>;
  healthRows?: Array<ReturnType<typeof makeHealthRow>>;
  setupStatusRestoreRowCount?: number;
}) {
  const connection = input.connection ?? makeConnection();
  const client = {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM dropship.dropship_store_connections") && sql.includes("FOR UPDATE")) {
        return { rows: [connection], rowCount: 1 };
      }
      if (sql.includes("FROM dropship.dropship_store_order_intake_health") && sql.includes("FOR UPDATE")) {
        return { rows: input.healthRows ?? [], rowCount: input.healthRows?.length ?? 0 };
      }
      if (sql.includes("SET setup_status")) {
        return { rows: [], rowCount: input.setupStatusRestoreRowCount ?? 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rows: input.candidateRows ?? [], rowCount: input.candidateRows?.length ?? 0 })),
  };
  return { client, pool };
}

function makeConnection(overrides: Partial<{
  id: number;
  vendor_id: number;
  platform: string;
  external_display_name: string | null;
  shop_domain: string | null;
  status: string;
  setup_status: string;
  access_token_ref: string | null;
  refresh_token_ref: string | null;
  updated_at: Date;
}> = {}) {
  return {
    id: 22,
    vendor_id: 10,
    platform: "ebay",
    external_display_name: "marz_cards",
    shop_domain: null,
    status: "connected",
    setup_status: "ready",
    access_token_ref: "access-ref",
    refresh_token_ref: "refresh-ref",
    updated_at: new Date("2026-08-25T13:00:00.000Z"),
    ...overrides,
  };
}

function makeHealthRow(overrides: Record<string, unknown> = {}) {
  return {
    store_connection_id: 22,
    mode: "poll",
    status: "healthy",
    consecutive_failures: 0,
    last_attempt_at: new Date("2026-08-25T13:55:00.000Z"),
    last_success_at: new Date("2026-08-25T13:55:00.000Z"),
    last_failure_at: null,
    last_failure_code: null,
    last_failure_message: null,
    status_changed_at: new Date("2026-08-25T13:55:00.000Z"),
    created_at: new Date("2026-08-25T13:00:00.000Z"),
    updated_at: new Date("2026-08-25T13:55:00.000Z"),
    ...overrides,
  };
}

function sqlCalls(client: { query: ReturnType<typeof vi.fn> }): string[] {
  return client.query.mock.calls.map(([sql]) => String(sql).trim());
}
