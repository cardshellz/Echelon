import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for scripts/backfill-wms-oms-fulfillment-order-id-from-external-order-number.ts
//
// Coverage:
//   1. parseFlags — CLI surface. Destructive defaults must be safe.
//   2. processBatch — core loop against a mocked db.execute / db.transaction.
//      Drives both dry-run (no writes) and execute (writes land) modes.
//   3. Conservative channel-match behavior.
// ─────────────────────────────────────────────────────────────────────────────

const mockState = vi.hoisted(() => {
  return {
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

import {
  parseFlags,
  processBatch,
  newStats,
} from "../backfill-wms-oms-fulfillment-order-id-from-external-order-number";

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
    expect(flags.batchSize).toBe(500);
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

  it("rejects --dry-run + --execute together", () => {
    expect(() => parseFlags(["--dry-run", "--execute"])).toThrow(
      /Cannot pass both/,
    );
  });

  it("parses --limit, --batch-size, --sleep-ms as integers", () => {
    const flags = parseFlags([
      "--limit=100",
      "--batch-size=50",
      "--sleep-ms=250",
    ]);
    expect(flags.limit).toBe(100);
    expect(flags.batchSize).toBe(50);
    expect(flags.sleepMs).toBe(250);
  });

  it("allows --sleep-ms=0", () => {
    const flags = parseFlags(["--sleep-ms=0"]);
    expect(flags.sleepMs).toBe(0);
  });

  it("rejects non-positive or non-integer --limit and --batch-size", () => {
    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--limit=-5"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--limit=1.5"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--batch-size=abc"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--batch-size=0"])).toThrow(/positive integer/);
  });

  it("rejects negative --sleep-ms", () => {
    expect(() => parseFlags(["--sleep-ms=-1"])).toThrow(/non-negative integer/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processBatch — dry-run
// ─────────────────────────────────────────────────────────────────────────────

describe("processBatch — dry-run (execute=false)", () => {
  it("matches a row and counts it without writing", async () => {
    mockState.executeResponses = [
      { rows: [{ id: 999 }] },
    ];

    const rows = [
      { wms_id: 1, wms_order_number: "SHOP-1", wms_channel_id: 10 },
    ];

    const stats = await processBatch(rows as any, false);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.updatedInDb).toBe(0);
    expect(stats.errors).toBe(0);
    expect(mockState.transactionRan).toBe(0);
    expect(mockState.txExecuteCalls.length).toBe(0);
  });

  it("skips orphan rows (no OMS match) and increments orphan counter", async () => {
    mockState.executeResponses = [
      { rows: [] },
    ];

    const rows = [
      { wms_id: 2, wms_order_number: "SHOP-2", wms_channel_id: 10 },
    ];

    const stats = await processBatch(rows as any, false);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(0);
    expect(stats.skippedOrphan).toBe(1);
    expect(stats.updatedInDb).toBe(0);
  });

  it("skips rows where wms.channel_id is NULL (conservative match)", async () => {
    // Queue no responses — if the script calls db.execute for these,
    // the mock throws and the test fails.
    const rows = [
      { wms_id: 3, wms_order_number: "SHOP-3", wms_channel_id: null },
    ];

    const stats = await processBatch(rows as any, false);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(0);
    expect(stats.skippedChannelMismatch).toBe(1);
    expect(mockState.executeCalls.length).toBe(0);
  });

  it("processes multiple rows, counting matched + orphans correctly", async () => {
    mockState.executeResponses = [
      { rows: [{ id: 111 }] }, // row 1 matches
      { rows: [] },             // row 2 orphan
      { rows: [{ id: 333 }] }, // row 3 matches
    ];

    const rows = [
      { wms_id: 10, wms_order_number: "SHOP-10", wms_channel_id: 1 },
      { wms_id: 11, wms_order_number: "SHOP-11", wms_channel_id: 1 },
      { wms_id: 12, wms_order_number: "SHOP-12", wms_channel_id: 1 },
    ];

    const stats = await processBatch(rows as any, false);

    expect(stats.scanned).toBe(3);
    expect(stats.matched).toBe(2);
    expect(stats.skippedOrphan).toBe(1);
    expect(stats.updatedInDb).toBe(0);
  });

  it("reports errors from OMS lookup without aborting the batch", async () => {
    mockState.executeResponses = [
      // first call throws — handled by re-mocking
    ];

    const dbMod = await import("../../server/db");
    let call = 0;
    (dbMod.db.execute as any) = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("pg timeout");
      return { rows: [{ id: 777 }] };
    });

    const rows = [
      { wms_id: 6, wms_order_number: "SHOP-6", wms_channel_id: 1 },
      { wms_id: 7, wms_order_number: "SHOP-7", wms_channel_id: 1 },
    ];

    const stats = await processBatch(rows as any, false);

    expect(stats.scanned).toBe(2);
    expect(stats.errors).toBe(1);
    expect(stats.matched).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processBatch — execute
// ─────────────────────────────────────────────────────────────────────────────

describe("processBatch — execute (writes enabled)", () => {
  it("updates matched rows inside a transaction", async () => {
    const dbMod = await import("../../server/db");
    (dbMod.db.execute as any) = vi.fn(async () => {
      mockState.executeCalls.push({ sql: "", params: [] });
      return mockState.executeResponses.shift()!;
    });

    mockState.executeResponses = [
      { rows: [{ id: 111 }] },
      { rows: [{ id: 222 }] },
    ];
    mockState.txExecuteResponses = [
      { rows: [{ id: 10 }] },
      { rows: [{ id: 11 }] },
    ];

    const rows = [
      { wms_id: 10, wms_order_number: "SHOP-10", wms_channel_id: 1 },
      { wms_id: 11, wms_order_number: "SHOP-11", wms_channel_id: 1 },
    ];

    const stats = await processBatch(rows as any, true);

    expect(stats.scanned).toBe(2);
    expect(stats.matched).toBe(2);
    expect(stats.updatedInDb).toBe(2);
    expect(stats.errors).toBe(0);
    expect(mockState.transactionRan).toBe(1);
    expect(mockState.txExecuteCalls.length).toBe(2);
  });

  it("rolls back on transaction failure", async () => {
    const dbMod = await import("../../server/db");
    (dbMod.db.execute as any) = vi.fn(async () => {
      return mockState.executeResponses.shift()!;
    });

    mockState.executeResponses = [
      { rows: [{ id: 333 }] },
    ];
    mockState.transactionShouldThrow = new Error("deadlock detected");

    const rows = [
      { wms_id: 99, wms_order_number: "SHOP-99", wms_channel_id: 1 },
    ];

    // processBatch calls process.exit(1) on tx failure, so we mock it.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const stats = await processBatch(rows as any, true);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.errors).toBe(1);
    expect(stats.updatedInDb).toBe(0);

    exitSpy.mockRestore();
  });

  it("does not open a transaction when there is nothing to update", async () => {
    const dbMod = await import("../../server/db");
    (dbMod.db.execute as any) = vi.fn(async () => {
      return mockState.executeResponses.shift()!;
    });

    mockState.executeResponses = [
      { rows: [] },
    ];

    const rows = [
      { wms_id: 60, wms_order_number: "SHOP-60", wms_channel_id: 1 },
    ];

    const stats = await processBatch(rows as any, true);

    expect(stats.scanned).toBe(1);
    expect(stats.skippedOrphan).toBe(1);
    expect(stats.updatedInDb).toBe(0);
    expect(mockState.transactionRan).toBe(0);
  });

  it("counts NOOP when defence-in-depth re-check finds 0 rows (concurrent update)", async () => {
    const dbMod = await import("../../server/db");
    (dbMod.db.execute as any) = vi.fn(async () => {
      return mockState.executeResponses.shift()!;
    });

    mockState.executeResponses = [
      { rows: [{ id: 444 }] },
    ];
    mockState.txExecuteResponses = [
      { rows: [] },
    ];

    const rows = [
      { wms_id: 50, wms_order_number: "SHOP-50", wms_channel_id: 1 },
    ];

    const stats = await processBatch(rows as any, true);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.updatedInDb).toBe(0);
    expect(stats.errors).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// newStats
// ─────────────────────────────────────────────────────────────────────────────

describe("newStats", () => {
  it("initializes every counter to zero", () => {
    const s = newStats();
    expect(s.scanned).toBe(0);
    expect(s.matched).toBe(0);
    expect(s.skippedOrphan).toBe(0);
    expect(s.skippedChannelMismatch).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.updatedInDb).toBe(0);
  });
});
