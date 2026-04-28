/**
 * Unit tests for resolveShipStationIds — data-driven ShipStation routing.
 *
 * Covers the 4-tier fallback chain:
 *   1. Per-row shipping_config jsonb (channel → storeId, warehouse → warehouseId)
 *   2. Env var defaults (SHIPSTATION_DEFAULT_STORE_ID / SHIPSTATION_DEFAULT_WAREHOUSE_ID)
 *   3. Hardcoded legacy fallback (319989 / 996884)
 *
 * Each test mocks db.execute to return controlled channel/warehouse rows.
 * No network, no real DB. Deterministic per coding-standards Rule #2.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveShipStationIds } from "../../shipstation.service";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Build a mock db whose execute() returns the given rows per call. */
function mockDb(...rowSets: Array<Array<Record<string, unknown> | null>>): any {
  const calls = rowSets;
  let callIndex = 0;
  return {
    execute: vi.fn().mockImplementation(() => {
      const rows = calls[callIndex] ?? calls[calls.length - 1] ?? [];
      callIndex++;
      return Promise.resolve({ rows });
    }),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("resolveShipStationIds", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SHIPSTATION_DEFAULT_STORE_ID;
    delete process.env.SHIPSTATION_DEFAULT_WAREHOUSE_ID;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // --- Tier 1: shipping_config set on both channel and warehouse ---

  it("returns values from channels.shipping_config and warehouses.shipping_config when both are set", async () => {
    const db = mockDb(
      // channel query
      [{ shipping_config: { shipstation: { storeId: 500001 } } }],
      // warehouse query
      [{ shipping_config: { shipstation: { warehouseId: 800001 } } }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result).toEqual({ storeId: 500001, warehouseId: 800001 });
  });

  it("handles shipping_config as a JSON string (pg jsonb returns string in some drivers)", async () => {
    const db = mockDb(
      [{ shipping_config: '{"shipstation":{"storeId":500002}}' }],
      [{ shipping_config: '{"shipstation":{"warehouseId":800002}}' }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result).toEqual({ storeId: 500002, warehouseId: 800002 });
  });

  // --- Tier 2: partial shipping_config (only channel set, warehouse null) ---

  it("uses channel storeId from config + env var warehouseId when warehouse config is null", async () => {
    process.env.SHIPSTATION_DEFAULT_WAREHOUSE_ID = "777777";

    const db = mockDb(
      [{ shipping_config: { shipstation: { storeId: 500003 } } }],
      [{ shipping_config: null }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result).toEqual({ storeId: 500003, warehouseId: 777777 });
  });

  it("uses env var storeId + warehouse config warehouseId when channel config is null", async () => {
    process.env.SHIPSTATION_DEFAULT_STORE_ID = "666666";

    const db = mockDb(
      [{ shipping_config: null }],
      [{ shipping_config: { shipstation: { warehouseId: 800004 } } }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result).toEqual({ storeId: 666666, warehouseId: 800004 });
  });

  // --- Tier 3: both null → env var defaults ---

  it("falls back to env var defaults when both shipping_config columns are null", async () => {
    process.env.SHIPSTATION_DEFAULT_STORE_ID = "666666";
    process.env.SHIPSTATION_DEFAULT_WAREHOUSE_ID = "777777";

    const db = mockDb(
      [{ shipping_config: null }],
      [{ shipping_config: null }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result).toEqual({ storeId: 666666, warehouseId: 777777 });
  });

  // --- Tier 4: both null + env vars unset → hardcoded legacy ---

  it("falls back to hardcoded 319989/996884 when config null and env vars unset", async () => {
    const db = mockDb(
      [{ shipping_config: null }],
      [{ shipping_config: null }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result).toEqual({ storeId: 319989, warehouseId: 996884 });
  });

  // --- shipping_config set but shipstation sub-key missing ---

  it("falls back to defaults when channels.shipping_config exists but has no shipstation key", async () => {
    process.env.SHIPSTATION_DEFAULT_STORE_ID = "666666";
    process.env.SHIPSTATION_DEFAULT_WAREHOUSE_ID = "777777";

    const db = mockDb(
      [{ shipping_config: { easypost: { apiKey: "test" } } }],
      [{ shipping_config: null }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result).toEqual({ storeId: 666666, warehouseId: 777777 });
  });

  it("falls back to defaults when warehouses.shipping_config exists but has no shipstation key", async () => {
    process.env.SHIPSTATION_DEFAULT_STORE_ID = "666666";
    process.env.SHIPSTATION_DEFAULT_WAREHOUSE_ID = "777777";

    const db = mockDb(
      [{ shipping_config: null }],
      [{ shipping_config: { shippo: { carrier: "test" } } }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result).toEqual({ storeId: 666666, warehouseId: 777777 });
  });

  // --- Malformed shipping_config (wrong types) ---

  it("falls back when storeId is a string instead of a number", async () => {
    process.env.SHIPSTATION_DEFAULT_STORE_ID = "666666";

    const db = mockDb(
      [{ shipping_config: { shipstation: { storeId: "not-a-number" } } }],
      [{ shipping_config: null }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result.storeId).toBe(666666);
  });

  it("falls back when storeId is a negative number", async () => {
    process.env.SHIPSTATION_DEFAULT_STORE_ID = "666666";

    const db = mockDb(
      [{ shipping_config: { shipstation: { storeId: -1 } } }],
      [{ shipping_config: null }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result.storeId).toBe(666666);
  });

  it("falls back when warehouseId is a float (not integer)", async () => {
    process.env.SHIPSTATION_DEFAULT_WAREHOUSE_ID = "777777";

    const db = mockDb(
      [{ shipping_config: null }],
      [{ shipping_config: { shipstation: { warehouseId: 3.14 } } }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result.warehouseId).toBe(777777);
  });

  // --- Null IDs (no channel or warehouse to look up) ---

  it("falls back to defaults when channelId is null (manual order)", async () => {
    process.env.SHIPSTATION_DEFAULT_STORE_ID = "666666";
    process.env.SHIPSTATION_DEFAULT_WAREHOUSE_ID = "777777";

    const db = mockDb(
      // only warehouse query (channel skipped)
      [{ shipping_config: null }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: null,
      warehouseId: 20,
    });

    expect(result).toEqual({ storeId: 666666, warehouseId: 777777 });
    // channel query should not have been called
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("falls back to defaults when warehouseId is null (legacy WMS order)", async () => {
    process.env.SHIPSTATION_DEFAULT_STORE_ID = "666666";
    process.env.SHIPSTATION_DEFAULT_WAREHOUSE_ID = "777777";

    const db = mockDb(
      // only channel query (warehouse skipped)
      [{ shipping_config: null }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: null,
    });

    expect(result).toEqual({ storeId: 666666, warehouseId: 777777 });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("falls back to defaults when both channelId and warehouseId are null", async () => {
    const db = mockDb();

    const result = await resolveShipStationIds(db, {
      channelId: null,
      warehouseId: null,
    });

    expect(result).toEqual({ storeId: 319989, warehouseId: 996884 });
    expect(db.execute).not.toHaveBeenCalled();
  });

  // --- DB error handling ---

  it("falls back gracefully when channel query throws", async () => {
    process.env.SHIPSTATION_DEFAULT_STORE_ID = "666666";

    const db = {
      execute: vi.fn()
        .mockRejectedValueOnce(new Error("connection timeout"))
        .mockResolvedValueOnce({ rows: [{ shipping_config: { shipstation: { warehouseId: 800005 } } }] }),
    };

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result).toEqual({ storeId: 666666, warehouseId: 800005 });
  });

  it("falls back gracefully when warehouse query throws", async () => {
    process.env.SHIPSTATION_DEFAULT_WAREHOUSE_ID = "777777";

    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ shipping_config: { shipstation: { storeId: 500005 } } }] })
        .mockRejectedValueOnce(new Error("connection timeout")),
    };

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result).toEqual({ storeId: 500005, warehouseId: 777777 });
  });

  // --- Row not found ---

  it("falls back when channel row is not found (empty rows)", async () => {
    process.env.SHIPSTATION_DEFAULT_STORE_ID = "666666";

    const db = mockDb(
      [], // no channel row
      [{ shipping_config: null }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 999,
      warehouseId: 20,
    });

    expect(result.storeId).toBe(666666);
  });

  // --- Mixed: channel config set, warehouse config set with different engine ---

  it("uses channel shipstation config + falls back warehouse when warehouse config has different engine", async () => {
    process.env.SHIPSTATION_DEFAULT_WAREHOUSE_ID = "777777";

    const db = mockDb(
      [{ shipping_config: { shipstation: { storeId: 500006 } } }],
      [{ shipping_config: { easypost: { warehouseId: 999999 } } }],
    );

    const result = await resolveShipStationIds(db, {
      channelId: 10,
      warehouseId: 20,
    });

    expect(result).toEqual({ storeId: 500006, warehouseId: 777777 });
  });
});
