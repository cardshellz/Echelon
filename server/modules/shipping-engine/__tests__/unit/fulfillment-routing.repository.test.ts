import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresFulfillmentRoutingStore } from "../../infrastructure/fulfillment-routing.repository";

describe("PostgresFulfillmentRoutingStore", () => {
  it("returns only exact scoped methods while reporting preserved legacy rows", async () => {
    const { pool, query, release } = fakePool([
      { rows: [], rowCount: null },
      { rows: [{
        service_level_id: 7,
        revision: 2,
        current_revision_id: "92",
        updated_by: "operator-1",
        updated_at: new Date("2026-09-01T12:00:00.000Z"),
      }], rowCount: 1 },
      { rows: [
        {
          provider: "shipstation_v2",
          provider_account_id: "se-fedex",
          provider_account_name: "FedEx account",
          carrier: "fedex",
          carrier_name: "FedEx",
          service_code: "fedex_ground",
          service_name: "FedEx Ground",
          priority: 1,
          domestic: true,
          international: false,
          revision_id: "92",
          is_active: true,
        },
        {
          provider: "legacy_unscoped",
          provider_account_id: null,
          provider_account_name: null,
          carrier: "USPS",
          carrier_name: "USPS",
          service_code: "legacy",
          service_name: "legacy",
          priority: 2,
          domestic: false,
          international: false,
          revision_id: null,
          is_active: true,
        },
      ], rowCount: 2 },
      { rows: [], rowCount: null },
    ]);
    const store = new PostgresFulfillmentRoutingStore(pool);

    await expect(store.getProfile(7)).resolves.toMatchObject({
      serviceLevelId: 7,
      revision: 2,
      currentRevisionId: 92,
      legacyUnscopedMethodCount: 1,
      methods: [{
        providerAccountId: "se-fedex",
        serviceCode: "fedex_ground",
        priority: 1,
      }],
    });
    expect(query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/).slice(0, 2).join(" ")))
      .toEqual(["BEGIN ISOLATION", "SELECT service_level_id,", "SELECT provider,", "COMMIT"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back and fails closed when a scoped method belongs to another revision", async () => {
    const { pool, query, release } = fakePool([
      { rows: [], rowCount: null },
      { rows: [{
        service_level_id: 7,
        revision: 2,
        current_revision_id: "92",
        updated_by: "operator-1",
        updated_at: new Date("2026-09-01T12:00:00.000Z"),
      }], rowCount: 1 },
      { rows: [{
        provider: "shipstation_v2",
        provider_account_id: "se-fedex",
        provider_account_name: "FedEx account",
        carrier: "fedex",
        carrier_name: "FedEx",
        service_code: "fedex_ground",
        service_name: "FedEx Ground",
        priority: 1,
        domestic: true,
        international: false,
        revision_id: "91",
        is_active: true,
      }], rowCount: 1 },
      { rows: [], rowCount: null },
    ]);
    const store = new PostgresFulfillmentRoutingStore(pool);

    await expect(store.getProfile(7)).rejects.toMatchObject({
      code: "SHIPPING_FULFILLMENT_ROUTING_DATA_INTEGRITY_ERROR",
    });
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});

function fakePool(results: Array<{ rows: unknown[]; rowCount: number | null }>) {
  let index = 0;
  const query = vi.fn(async () => {
    const result = results[index++];
    if (!result) throw new Error("Unexpected query.");
    return result;
  });
  const release = vi.fn();
  const pool = {
    connect: vi.fn().mockResolvedValue({ query, release }),
  } as unknown as Pool;
  return { pool, query, release };
}
