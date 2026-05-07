import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

import { PgDropshipListingPreviewRepository } from "../../infrastructure/dropship-listing-preview.repository";

describe("PgDropshipListingPreviewRepository", () => {
  it("maps launch readiness from store credential fields", async () => {
    const client = makeClient({
      vendor_id: 10,
      vendor_status: "active",
      entitlement_status: "active",
      store_connection_id: 22,
      store_status: "connected",
      setup_status: "ready",
      platform: "ebay",
      access_token_ref: "access-ref",
      refresh_token_ref: null,
    });
    const repository = new PgDropshipListingPreviewRepository(makePool(client));

    const result = await repository.loadStoreContext({
      vendorId: 10,
      storeConnectionId: 22,
    });

    expect(result).toMatchObject({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "ebay",
      storeLaunchReady: false,
    });
    const query = client.query.mock.calls[0]?.[0];
    expect(String(query)).toContain("sc.access_token_ref");
    expect(String(query)).toContain("sc.refresh_token_ref");
    expect(client.release).toHaveBeenCalledTimes(1);
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
    query: vi.fn(async () => ({ rows: [row] })),
    release: vi.fn(),
  } as unknown as PoolClient & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}
