import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for scripts/backfill-wms-oms-fulfillment-order-id-from-gid.ts
//
// Coverage:
//   1. parseFlags — CLI surface. Destructive defaults must be safe.
//   2. isShopifyOrderGid — GID shape validator.
//   3. processChunk — core loop against a mocked db.execute / db.transaction.
//      Drives both dry-run (no writes) and execute (writes land) modes.
//
// Why this matters:
//   This backfill touches ~53,537 production rows. A flag-parsing bug or a
//   loop bug could silently corrupt a WMS column used by the hourly
//   ShipStation reconcile. The mock here stands in for the live DB; the
//   real integration is covered (in theory) by the per-chunk defence-in-
//   depth re-check in the script itself (WHERE oms_fulfillment_order_id =
//   old_value) — but we also prove the call shapes here.
// ─────────────────────────────────────────────────────────────────────────────

// ── Mock `db` BEFORE importing the script under test. `vi.hoisted` is
// required so the mock exists at import time for the ESM module graph.
const mockState = vi.hoisted(() => {
  return {
    // queue of responses for db.execute() — FIFO.
    executeResponses: [] as Array<{ rows: any[] }>,
    executeCalls: [] as Array<{ sql: string; params: any[] }>,
    transactionRan: 0,
    transactionShouldThrow: false as false | Error,
    txExecuteResponses: [] as Array<{ rows: any[] }>,
    txExecuteCalls: [] as Array<{ sql: string; params: any[] }>,
  };
});

vi.mock("../../server/db", () => {
  return {
    db: {
      execute: vi.fn(async (query: any) => {
        // drizzle `sql` templates stringify to something useful-enough for
        // call-shape assertions; we don't parse them, we just record them.
        mockState.executeCalls.push({
          sql: String(query?.queryChunks ?? query ?? ""),
          params: query?.params ?? [],
        });
        if (mockState.executeResponses.length === 0) {
          throw new Error(
            `mock db.execute called but no response queued (call #${mockState.executeCalls.length})`,
          );
        }
        return mockState.executeResponses.shift()!;
      }),
      transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => {
        mockState.transactionRan++;
        if (mockState.transactionShouldThrow) {
          throw mockState.transactionShouldThrow;
        }
        const tx = {
          execute: vi.fn(async (query: any) => {
            mockState.txExecuteCalls.push({
              sql: String(query?.queryChunks ?? query ?? ""),
              params: query?.params ?? [],
            });
            if (mockState.txExecuteResponses.length === 0) {
              throw new Error(
                `mock tx.execute called but no response queued (call #${mockState.txExecuteCalls.length})`,
              );
            }
            return mockState.txExecuteResponses.shift()!;
          }),
        };
        return await fn(tx);
      }),
    },
  };
});

// Now import the script under test.
import {
  parseFlags,
  processChunk,
  newStats,
} from "../backfill-wms-oms-fulfillment-order-id-from-gid";
import { isShopifyOrderGid } from "../backfill-wms-oms-fulfillment-order-id-from-gid";

beforeEach(() => {
  mockState.executeResponses = [];
  mockState.executeCalls = [];
  mockState.txExecuteResponses = [];
  mockState.txExecuteCalls = [];
  mockState.transactionRan = 0;
  mockState.transactionShouldThrow = false;
});

// ─────────────────────────────────────────────────────────────────────────────
// parseFlags
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFlags", () => {
  it("defaults to dry-run (execute=false) with no args", () => {
    const flags = parseFlags([]);
    expect(flags.execute).toBe(false);
    expect(flags.chunkSize).toBe(500);
    expect(flags.sleepMs).toBe(500);
    expect(flags.limit).toBeNull();
  });

  it("--dry-run alone still yields execute=false", () => {
    const flags = parseFlags(["--dry-run"]);
    expect(flags.execute).toBe(false);
  });

  it("--execute flips execute to true", () => {
    const flags = parseFlags(["--execute"]);
    expect(flags.execute).toBe(true);
  });

  it("rejects --dry-run + --execute together (operator confusion is not a green light)", () => {
    expect(() => parseFlags(["--dry-run", "--execute"])).toThrow(
      /Cannot pass both/,
    );
  });

  it("parses --limit, --chunk-size, --sleep-ms as integers", () => {
    const flags = parseFlags([
      "--limit=100",
      "--chunk-size=50",
      "--sleep-ms=250",
    ]);
    expect(flags.limit).toBe(100);
    expect(flags.chunkSize).toBe(50);
    expect(flags.sleepMs).toBe(250);
  });

  it("allows --sleep-ms=0 (valid power-user intent: no throttle)", () => {
    const flags = parseFlags(["--sleep-ms=0"]);
    expect(flags.sleepMs).toBe(0);
  });

  it("rejects non-positive or non-integer --limit and --chunk-size", () => {
    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--limit=-5"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--limit=1.5"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--chunk-size=abc"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--chunk-size=0"])).toThrow(/positive integer/);
  });

  it("rejects negative --sleep-ms", () => {
    expect(() => parseFlags(["--sleep-ms=-1"])).toThrow(/non-negative integer/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isShopifyOrderGid
// ─────────────────────────────────────────────────────────────────────────────

describe("isShopifyOrderGid", () => {
  it("accepts canonical Shopify order GIDs", () => {
    expect(isShopifyOrderGid("gid://shopify/Order/1")).toBe(true);
    expect(isShopifyOrderGid("gid://shopify/Order/5432109876543")).toBe(true);
  });

  it("rejects other Shopify resource GIDs", () => {
    expect(isShopifyOrderGid("gid://shopify/Customer/1")).toBe(false);
    expect(isShopifyOrderGid("gid://shopify/ProductVariant/1")).toBe(false);
    expect(isShopifyOrderGid("gid://shopify/FulfillmentOrder/1")).toBe(false);
  });

  it("rejects malformed / non-digit suffix / empty / null / non-string", () => {
    expect(isShopifyOrderGid("gid://shopify/Order/")).toBe(false);
    expect(isShopifyOrderGid("gid://shopify/Order/abc")).toBe(false);
    expect(isShopifyOrderGid("gid://shopify/Order/1/extra")).toBe(false);
    expect(isShopifyOrderGid("")).toBe(false);
    expect(isShopifyOrderGid(null)).toBe(false);
    expect(isShopifyOrderGid(undefined)).toBe(false);
    expect(isShopifyOrderGid(12345)).toBe(false);
  });

  it("rejects plain numeric IDs (Path A rows are not candidates)", () => {
    expect(isShopifyOrderGid("12345")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processChunk — dry-run
// ─────────────────────────────────────────────────────────────────────────────

describe("processChunk — dry-run (execute=false)", () => {
  it("matches a single OMS row and counts it without writing", async () => {
    mockState.executeResponses = [
      // OMS lookup for the single candidate
      { rows: [{ id: 999 }] },
    ];

    const rows = [
      {
        wms_id: 1,
        wms_order_number: "SHOP-1",
        gid: "gid://shopify/Order/10001",
      },
    ];

    const stats = await processChunk(rows as any, false);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.updatedInDb).toBe(0); // dry-run: no writes
    expect(stats.errors).toBe(0);
    expect(mockState.transactionRan).toBe(0);
    expect(mockState.txExecuteCalls.length).toBe(0);
  });

  it("skips rows with 0 OMS matches and logs them", async () => {
    mockState.executeResponses = [
      { rows: [] }, // no OMS match
    ];
    const rows = [
      { wms_id: 2, wms_order_number: "SHOP-2", gid: "gid://shopify/Order/20002" },
    ];

    const stats = await processChunk(rows as any, false);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(0);
    expect(stats.skippedNoOmsMatch).toBe(1);
    expect(stats.updatedInDb).toBe(0);
  });

  it("skips rows with >1 OMS matches (ambiguous — never guess)", async () => {
    mockState.executeResponses = [
      { rows: [{ id: 100 }, { id: 200 }] },
    ];
    const rows = [
      { wms_id: 3, wms_order_number: "SHOP-3", gid: "gid://shopify/Order/30003" },
    ];

    const stats = await processChunk(rows as any, false);

    expect(stats.scanned).toBe(1);
    expect(stats.skippedMultipleOmsMatches).toBe(1);
    expect(stats.matched).toBe(0);
    expect(stats.updatedInDb).toBe(0);
  });

  it("skips rows whose gid fails strict shape validation (without consulting DB)", async () => {
    // NOTE: invalid-GID rows should not trigger an OMS lookup at all.
    // Queue no responses — if the script calls db.execute for one of these,
    // the mock throws and the test fails.
    const rows = [
      { wms_id: 4, wms_order_number: "SHOP-4", gid: "gid://shopify/Order/" },
      { wms_id: 5, wms_order_number: "SHOP-5", gid: "gid://shopify/Customer/42" },
    ];

    const stats = await processChunk(rows as any, false);

    expect(stats.scanned).toBe(2);
    expect(stats.skippedInvalidGidShape).toBe(2);
    expect(stats.matched).toBe(0);
    expect(stats.updatedInDb).toBe(0);
    expect(mockState.executeCalls.length).toBe(0);
  });

  it("reports errors from the OMS lookup without aborting the chunk", async () => {
    // Make the first lookup throw, the second succeed.
    let call = 0;
    (await import("../../server/db")).db.execute = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("pg timeout");
      return { rows: [{ id: 777 }] };
    }) as any;

    const rows = [
      { wms_id: 6, wms_order_number: "SHOP-6", gid: "gid://shopify/Order/60006" },
      { wms_id: 7, wms_order_number: "SHOP-7", gid: "gid://shopify/Order/70007" },
    ];

    const stats = await processChunk(rows as any, false);

    expect(stats.scanned).toBe(2);
    expect(stats.errors).toBe(1);
    expect(stats.matched).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processChunk — execute
// ─────────────────────────────────────────────────────────────────────────────

describe("processChunk — execute (writes enabled)", () => {
  it("updates matched rows inside a single transaction", async () => {
    // Reset the mock (previous test replaced db.execute).
    const dbMod = await import("../../server/db");
    dbMod.db.execute = vi.fn(async () => {
      mockState.executeCalls.push({ sql: "", params: [] });
      return mockState.executeResponses.shift()!;
    }) as any;

    mockState.executeResponses = [
      { rows: [{ id: 111 }] }, // row 1 OMS lookup
      { rows: [{ id: 222 }] }, // row 2 OMS lookup
    ];
    mockState.txExecuteResponses = [
      { rows: [{ id: 10 }] }, // row 1 UPDATE returning id
      { rows: [{ id: 11 }] }, // row 2 UPDATE returning id
    ];

    const rows = [
      { wms_id: 10, wms_order_number: "SHOP-10", gid: "gid://shopify/Order/100100" },
      { wms_id: 11, wms_order_number: "SHOP-11", gid: "gid://shopify/Order/100101" },
    ];

    const stats = await processChunk(rows as any, true);

    expect(stats.scanned).toBe(2);
    expect(stats.matched).toBe(2);
    expect(stats.updatedInDb).toBe(2);
    expect(stats.errors).toBe(0);
    expect(mockState.transactionRan).toBe(1); // single tx per chunk
    expect(mockState.txExecuteCalls.length).toBe(2);
  });

  it("rolls back the chunk on transaction failure without double-counting", async () => {
    const dbMod = await import("../../server/db");
    dbMod.db.execute = vi.fn(async () => {
      return mockState.executeResponses.shift()!;
    }) as any;

    mockState.executeResponses = [
      { rows: [{ id: 333 }] }, // OMS lookup succeeds
    ];
    mockState.transactionShouldThrow = new Error("deadlock detected");

    const rows = [
      { wms_id: 99, wms_order_number: "SHOP-99", gid: "gid://shopify/Order/999" },
    ];

    const stats = await processChunk(rows as any, true);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.errors).toBe(1);
    expect(stats.updatedInDb).toBe(0); // reset on tx failure
  });

  it("counts NOOP when the defence-in-depth re-check finds 0 rows (concurrent update)", async () => {
    const dbMod = await import("../../server/db");
    dbMod.db.execute = vi.fn(async () => {
      return mockState.executeResponses.shift()!;
    }) as any;

    mockState.executeResponses = [
      { rows: [{ id: 444 }] }, // OMS lookup
    ];
    mockState.txExecuteResponses = [
      { rows: [] }, // UPDATE affected 0 rows — someone else changed it first
    ];

    const rows = [
      { wms_id: 50, wms_order_number: "SHOP-50", gid: "gid://shopify/Order/50050" },
    ];

    const stats = await processChunk(rows as any, true);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.updatedInDb).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it("does not open a transaction when there is nothing to update", async () => {
    const dbMod = await import("../../server/db");
    dbMod.db.execute = vi.fn(async () => {
      return mockState.executeResponses.shift()!;
    }) as any;

    mockState.executeResponses = [
      { rows: [] }, // no OMS match
    ];

    const rows = [
      { wms_id: 60, wms_order_number: "SHOP-60", gid: "gid://shopify/Order/600" },
    ];

    const stats = await processChunk(rows as any, true);

    expect(stats.scanned).toBe(1);
    expect(stats.skippedNoOmsMatch).toBe(1);
    expect(stats.updatedInDb).toBe(0);
    expect(mockState.transactionRan).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// newStats — boring but worth asserting zero-start.
// ─────────────────────────────────────────────────────────────────────────────

describe("newStats", () => {
  it("initializes every counter to zero", () => {
    const s = newStats();
    expect(s.scanned).toBe(0);
    expect(s.matched).toBe(0);
    expect(s.skippedNoOmsMatch).toBe(0);
    expect(s.skippedMultipleOmsMatches).toBe(0);
    expect(s.skippedInvalidGidShape).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.updatedInDb).toBe(0);
  });
});
