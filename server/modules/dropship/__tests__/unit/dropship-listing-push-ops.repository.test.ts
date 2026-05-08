import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgDropshipListingPushOpsRepository } from "../../infrastructure/dropship-listing-push-ops.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const now = new Date("2026-05-07T18:30:00.000Z");

describe("PgDropshipListingPushOpsRepository", () => {
  it("requeues retryable failed job items and records an ops audit event", async () => {
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "COMMIT") {
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_listing_push_jobs") && sqlText.includes("FOR UPDATE")) {
        return { rows: [makeJobRow({ status: "failed" })] };
      }
      if (sqlText.includes("UPDATE dropship.dropship_listing_push_job_items")) {
        return {
          rows: [
            { id: 1001, listing_id: 501 },
            { id: 1002, listing_id: 502 },
          ],
        };
      }
      if (sqlText.includes("UPDATE dropship.dropship_vendor_listings")) {
        return { rows: [] };
      }
      if (sqlText.includes("UPDATE dropship.dropship_listing_push_jobs")) {
        return { rows: [makeJobRow({ status: "queued", updated_at: now, completed_at: null })] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipListingPushOpsRepository(makePool(makeClient(query)));

    const result = await repository.retryJob(makeRetryInput());

    expect(result).toMatchObject({
      jobId: 44,
      previousStatus: "failed",
      status: "queued",
      requeuedItemCount: 2,
      idempotentReplay: false,
      updatedAt: now,
    });

    const itemRetry = query.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_listing_push_job_items"),
    );
    expect(String(itemRetry?.[0])).toContain("AND status = 'failed'");
    expect(String(itemRetry?.[0])).toContain("COALESCE((result->'push'->>'retryable')::boolean, true) = true");
    expect(itemRetry?.[1]?.[0]).toBe(44);
    expect(JSON.parse(String(itemRetry?.[1]?.[1]))).toMatchObject({
      lastRetryRequest: {
        idempotencyKey: "retry-listing-job-44",
        reason: "marketplace outage cleared",
        actorType: "admin",
        actorId: "ops-user",
        requestedAt: now.toISOString(),
      },
    });

    const listingRetry = query.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_vendor_listings"),
    );
    expect(listingRetry?.[1]?.[0]).toEqual([501, 502]);

    const audit = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    );
    expect(audit?.[1]).toEqual([
      10,
      22,
      "44",
      "listing_push_job_retry_requested",
      "admin",
      "ops-user",
      "info",
      JSON.stringify({
        idempotencyKey: "retry-listing-job-44",
        previousStatus: "failed",
        requeuedItemCount: 2,
        staleJobUpdatedAt: null,
        staleAfterMinutes: null,
        reason: "marketplace outage cleared",
      }),
      now,
    ]);
  });

  it("rejects non-stale processing job retries without requeueing items", async () => {
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "ROLLBACK") {
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_listing_push_jobs") && sqlText.includes("FOR UPDATE")) {
        return {
          rows: [makeJobRow({
            status: "processing",
            updated_at: now,
          })],
        };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipListingPushOpsRepository(makePool(makeClient(query)));

    await expect(repository.retryJob(makeRetryInput())).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_PUSH_OPS_STATUS_NOT_RETRYABLE",
      context: {
        jobId: 44,
        status: "processing",
        updatedAt: now.toISOString(),
        staleAfterMinutes: 30,
      },
    });
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_listing_push_job_items"),
    )).toBe(false);
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    )).toBe(false);
  });
});

function makeRetryInput() {
  return {
    jobId: 44,
    idempotencyKey: "retry-listing-job-44",
    reason: "marketplace outage cleared",
    actor: { actorType: "admin" as const, actorId: "ops-user" },
    now,
  };
}

function makeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 44,
    vendor_id: 10,
    store_connection_id: 22,
    status: "failed",
    updated_at: new Date("2026-05-07T18:00:00.000Z"),
    completed_at: new Date("2026-05-07T18:10:00.000Z"),
    ...overrides,
  };
}

function makeClient(query: ReturnType<typeof vi.fn>): PoolClient {
  return { query, release: vi.fn() } as unknown as PoolClient;
}

function makePool(client: PoolClient): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}
