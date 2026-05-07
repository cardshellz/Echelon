import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

import { PgDropshipListingPushWorkerRepository } from "../../infrastructure/dropship-listing-push-worker.repository";

const now = new Date("2026-05-07T17:30:00.000Z");
const staleUpdatedAt = new Date("2026-05-07T16:55:00.000Z");

describe("PgDropshipListingPushWorkerRepository", () => {
  it("recovers stale processing jobs and requeues in-flight items", async () => {
    const client = makeClient();
    const repository = new PgDropshipListingPushWorkerRepository(makePool(client));

    const result = await repository.claimJob({
      jobId: 30,
      workerId: "worker-1",
      idempotencyKey: "dropship-listing-push:job:30",
      now,
    });

    expect(result.claimed).toBe(true);
    expect(result.job).toMatchObject({
      jobId: 30,
      status: "processing",
      updatedAt: now,
    });
    expect(result.items[0]).toMatchObject({
      itemId: 1,
      status: "queued",
    });

    const itemRecovery = client.query.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_listing_push_job_items")
      && String(call[0]).includes("status = 'queued'"),
    );
    expect(itemRecovery?.[1]).toEqual([
      30,
      now,
      JSON.stringify({
        staleRecovery: {
          previousStatus: "processing",
          status: "queued",
          recoveredAt: now.toISOString(),
          workerId: "worker-1",
          staleAfterMinutes: 30,
        },
      }),
    ]);

    const audit = client.query.mock.calls.find((call) =>
      Array.isArray(call[1]) && call[1][4] === "listing_push_job_stale_recovered",
    );
    expect(audit?.[1]).toEqual([
      10,
      22,
      "dropship_listing_push_job",
      "30",
      "listing_push_job_stale_recovered",
      "worker-1",
      "warning",
      JSON.stringify({
        idempotencyKey: "dropship-listing-push:job:30",
        previousStatus: "processing",
        status: "processing",
        staleJobUpdatedAt: staleUpdatedAt.toISOString(),
        staleAfterMinutes: 30,
        reason: "listing push job exceeded stale processing threshold before completion.",
      }),
      now,
    ]);
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

function makePool(client: PoolClient): Pool {
  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

function makeClient(): PoolClient & {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (sql: string) => {
    const sqlText = String(sql);
    if (sqlText === "BEGIN" || sqlText === "COMMIT") {
      return { rows: [] };
    }
    if (sqlText.includes("FROM dropship.dropship_listing_push_jobs j")) {
      return { rows: [makeJobRow({ status: "processing", updated_at: staleUpdatedAt })] };
    }
    if (sqlText.includes("FROM dropship.dropship_store_listing_configs")) {
      return { rows: [makeConfigRow()] };
    }
    if (
      sqlText.includes("UPDATE dropship.dropship_listing_push_job_items")
      && sqlText.includes("status = 'queued'")
    ) {
      return { rows: [] };
    }
    if (sqlText.includes("UPDATE dropship.dropship_listing_push_jobs AS j")) {
      return { rows: [makeJobRow({ status: "processing", updated_at: now })] };
    }
    if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
      return { rows: [] };
    }
    if (sqlText.includes("FROM dropship.dropship_listing_push_job_items i")) {
      return { rows: [makeItemRow({ status: "queued" })] };
    }
    throw new Error(`Unexpected SQL in test: ${sqlText}`);
  });
  return {
    query,
    release: vi.fn(),
  } as unknown as PoolClient & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}

function makeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 30,
    vendor_id: 10,
    store_connection_id: 22,
    platform: "shopify",
    status: "processing",
    idempotency_key: "push-job-001",
    request_hash: "request-hash",
    created_at: new Date("2026-05-07T16:00:00.000Z"),
    updated_at: staleUpdatedAt,
    completed_at: null,
    ...overrides,
  };
}

function makeConfigRow() {
  return {
    id: 7,
    store_connection_id: 22,
    platform: "shopify",
    listing_mode: "draft_first",
    inventory_mode: "managed_quantity_sync",
    price_mode: "vendor_defined",
    marketplace_config: {},
    required_config_keys: [],
    required_product_fields: [],
    is_active: true,
  };
}

function makeItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    job_id: 30,
    listing_id: 100,
    product_variant_id: 101,
    status: "processing",
    preview_hash: "preview-hash",
    external_listing_id: null,
    error_code: null,
    error_message: null,
    result: { listingIntent: { platform: "shopify" } },
    listing_status: "queued",
    listing_external_listing_id: null,
    listing_external_offer_id: null,
    listing_last_preview_hash: "preview-hash",
    ...overrides,
  };
}
