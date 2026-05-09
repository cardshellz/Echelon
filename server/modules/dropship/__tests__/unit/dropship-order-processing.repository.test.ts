import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

import { PgDropshipOrderProcessingRepository } from "../../infrastructure/dropship-order-processing.repository";

const now = new Date("2026-05-09T18:00:00.000Z");
const expiredAt = new Date("2026-05-09T17:59:59.000Z");

describe("PgDropshipOrderProcessingRepository", () => {
  it("claims expired payment holds so the service can cancel them through the audited path", async () => {
    const row = makeProcessingIntakeRow({
      status: "payment_hold",
      payment_hold_expires_at: expiredAt,
    });
    const client = makeClaimClient(row);
    const repository = new PgDropshipOrderProcessingRepository(makePool(client));

    const result = await repository.claimIntake({
      intakeId: 91,
      workerId: "worker-1",
      now,
    });

    expect(result).toMatchObject({
      claimed: true,
      skipReason: null,
      intake: {
        intakeId: 91,
        status: "processing",
        paymentHoldExpiresAt: expiredAt,
      },
      config: { defaultWarehouseId: 3, warehouseConfigError: null },
    });

    const claimQuery = client.query.mock.calls.find((call) =>
      String(call[0]).includes("SET status = 'processing'"),
    );
    expect(claimQuery?.[1]).toEqual([91, now]);

    const auditQuery = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    );
    expect(auditQuery?.[1]).toEqual([
      10,
      22,
      "91",
      "order_processing_claimed",
      "worker-1",
      "info",
      JSON.stringify({
        status: "processing",
        externalOrderId: "EXT-91",
        previousStatus: "payment_hold",
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

function makeClaimClient(row: ProcessingRow): PoolClient & {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(async (query: string) => {
      if (String(query).includes("FOR UPDATE OF oi")) {
        return { rows: [row] };
      }
      if (String(query).includes("SET status = 'processing'")) {
        return { rows: [{ ...row, status: "processing" }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  } as unknown as PoolClient & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}

interface ProcessingRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  platform: "ebay" | "shopify";
  external_order_id: string;
  status: string;
  payment_hold_expires_at: Date | null;
  normalized_payload: {
    lines: Array<{
      productVariantId: number;
      quantity: number;
      unitRetailPriceCents: number;
      externalLineItemId: string;
      title: string;
    }>;
    shipTo: {
      name: string;
      address1: string;
      city: string;
      region: string;
      postalCode: string;
      country: string;
    };
  };
  store_config: Record<string, unknown>;
}

function makeProcessingIntakeRow(overrides: Partial<ProcessingRow> = {}): ProcessingRow {
  return {
    id: 91,
    vendor_id: 10,
    store_connection_id: 22,
    platform: "shopify",
    external_order_id: "EXT-91",
    status: "received",
    payment_hold_expires_at: null,
    normalized_payload: {
      lines: [{
        productVariantId: 101,
        quantity: 1,
        unitRetailPriceCents: 1000,
        externalLineItemId: "line-1",
        title: "Shell",
      }],
      shipTo: {
        name: "Buyer Name",
        address1: "1 Main St",
        city: "New York",
        region: "NY",
        postalCode: "10001",
        country: "US",
      },
    },
    store_config: { orderProcessing: { defaultWarehouseId: 3 } },
    ...overrides,
  };
}
