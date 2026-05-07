import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

import { PgDropshipOrderRejectionRepository } from "../../infrastructure/dropship-order-rejection.repository";

const now = new Date("2026-05-06T12:00:00.000Z");

describe("PgDropshipOrderRejectionRepository", () => {
  it("blocks vendor rejection when the store is connected but not launch-ready", async () => {
    const client = makeClient(makeIntakeRow({
      setup_status: "pending",
      access_token_ref: "access-ref",
      refresh_token_ref: "refresh-ref",
    }));
    const repository = new PgDropshipOrderRejectionRepository(makePool(client));

    await expect(repository.rejectOrder({
      intakeId: 42,
      vendorId: 10,
      reason: "Cannot fulfill selected SKU.",
      idempotencyKey: "reject-order-42",
      actor: { actorType: "vendor", actorId: "member-1" },
      rejectedAt: now,
    })).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_STORE_BLOCKED",
      context: {
        intakeId: 42,
        storeConnectionId: 22,
        storeStatus: "connected",
        setupStatus: "pending",
      },
    });

    const updateQuery = client.query.mock.calls.find((call) => String(call[0]).includes("SET status = 'rejected'"));
    expect(updateQuery).toBeUndefined();
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("loads store readiness fields while locking the intake row for rejection", async () => {
    const client = makeClient(makeIntakeRow());
    const repository = new PgDropshipOrderRejectionRepository(makePool(client));

    await repository.rejectOrder({
      intakeId: 42,
      vendorId: 10,
      reason: "Cannot fulfill selected SKU.",
      idempotencyKey: "reject-order-42",
      actor: { actorType: "vendor", actorId: "member-1" },
      rejectedAt: now,
    });

    const selectQuery = client.query.mock.calls.find((call) => String(call[0]).includes("FROM dropship.dropship_order_intake oi"));
    expect(String(selectQuery?.[0])).toContain("sc.status AS store_status");
    expect(String(selectQuery?.[0])).toContain("sc.setup_status");
    expect(String(selectQuery?.[0])).toContain("sc.access_token_ref");
    expect(String(selectQuery?.[0])).toContain("sc.refresh_token_ref");
    expect(String(selectQuery?.[0])).toContain("FOR UPDATE OF oi, sc");
  });
});

function makePool(client: PoolClient): Pool {
  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

function makeClient(row: Record<string, unknown>): PoolClient & {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(async (query: string) => {
      const queryText = String(query);
      if (queryText.includes("FROM dropship.dropship_order_intake oi")) {
        return { rows: [row] };
      }
      if (queryText.includes("SET status = 'rejected'")) {
        return { rows: [{
          ...row,
          status: "rejected",
          rejection_reason: "Cannot fulfill selected SKU.",
          cancellation_status: "order_intake_rejected",
          updated_at: now,
        }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  } as unknown as PoolClient & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}

function makeIntakeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    vendor_id: 10,
    store_connection_id: 22,
    external_order_id: "external-1",
    external_order_number: "1001",
    status: "received",
    rejection_reason: null,
    cancellation_status: null,
    oms_order_id: null,
    updated_at: new Date("2026-05-06T11:55:00.000Z"),
    store_platform: "shopify",
    store_status: "connected",
    setup_status: "ready",
    access_token_ref: "access-ref",
    refresh_token_ref: null,
    ...overrides,
  };
}
