import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

import { PgDropshipOrderCancellationRepository } from "../../infrastructure/dropship-order-cancellation.repository";

const now = new Date("2026-05-04T20:45:00.000Z");

describe("PgDropshipOrderCancellationRepository", () => {
  it("claims rejected intake rows that require marketplace cancellation", async () => {
    const client = makeClient([{
      id: 1,
      vendor_id: 10,
      store_connection_id: 22,
      platform: "shopify",
      external_order_id: "gid://shopify/Order/1001",
      external_order_number: "1001",
      source_order_id: null,
      ordered_at: "2026-05-04T20:40:00.000Z",
      rejection_reason: "Store connection status needs_reauth does not allow new dropship order intake.",
      cancellation_status: "order_intake_rejected",
    }]);
    const pool = makePool(client);
    const repository = new PgDropshipOrderCancellationRepository(pool);

    const result = await repository.claimPendingCancellations({
      now,
      limit: 25,
      workerId: "worker-1",
    });

    expect(result).toEqual([{
      intakeId: 1,
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
      externalOrderId: "gid://shopify/Order/1001",
      externalOrderNumber: "1001",
      sourceOrderId: null,
      orderedAt: "2026-05-04T20:40:00.000Z",
      rejectionReason: "Store connection status needs_reauth does not allow new dropship order intake.",
      cancellationStatus: "order_intake_rejected",
    }]);

    const claimQuery = client.query.mock.calls.find((call) => String(call[0]).includes("WITH candidates"));
    expect(String(claimQuery?.[0])).toContain("status IN ('cancelled', 'rejected')");
    expect(claimQuery?.[1]).toEqual([
      now,
      ["payment_hold_expired", "order_intake_rejected", "marketplace_cancellation_retrying"],
      "marketplace_cancellation_processing",
      "15 minutes",
      25,
    ]);
  });
});

function makePool(client: PoolClient): Pool {
  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

function makeClient(rows: Record<string, unknown>[]): PoolClient & {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(async (query: string) => {
      if (String(query).includes("WITH candidates")) {
        return { rows };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  } as unknown as PoolClient & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}
