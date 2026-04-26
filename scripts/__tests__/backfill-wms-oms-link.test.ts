import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for scripts/backfill-wms-oms-link.ts (consolidated backfill)
//
// Coverage:
//   1. parseFlags — CLI surface including --path flag.
//   2. isShopifyOrderGid — GID shape validator.
//   3. processPathABatch — Path A (GID) dry-run + execute.
//   4. processPathBBatch — Path B (NULL) dry-run + execute.
//   5. Both paths in one run — summary correctness.
//   6. --path A / --path B flag → only that path runs.
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
  processPathABatch,
  processPathBBatch,
  newAStats,
  newBStats,
  isShopifyOrderGid,
} from "../backfill-wms-oms-link";

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
  it("defaults to dry-run with both paths", () => {
    const flags = parseFlags([]);
    expect(flags.execute).toBe(false);
    expect(flags.batchSize).toBe(500);
    expect(flags.sleepMs).toBe(500);
    expect(flags.limit).toBeNull();
    expect(flags.path).toBe("both");
  });

  it("--execute flips execute to true", () => {
    expect(parseFlags(["--execute"]).execute).toBe(true);
  });

  it("rejects --dry-run + --execute together", () => {
    expect(() => parseFlags(["--dry-run", "--execute"])).toThrow(/Cannot pass both/);
  });

  it("parses --limit, --batch-size, --sleep-ms", () => {
    const flags = parseFlags(["--limit=100", "--batch-size=50", "--sleep-ms=250"]);
    expect(flags.limit).toBe(100);
    expect(flags.batchSize).toBe(50);
    expect(flags.sleepMs).toBe(250);
  });

  it("allows --sleep-ms=0", () => {
    expect(parseFlags(["--sleep-ms=0"]).sleepMs).toBe(0);
  });

  it("rejects non-positive --limit / --batch-size", () => {
    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--limit=1.5"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--batch-size=-1"])).toThrow(/positive integer/);
  });

  it("parses --path=A", () => {
    expect(parseFlags(["--path=A"]).path).toBe("A");
  });

  it("parses --path=B", () => {
    expect(parseFlags(["--path=B"]).path).toBe("B");
  });

  it("parses --path=both", () => {
    expect(parseFlags(["--path=both"]).path).toBe("both");
  });

  it("rejects invalid --path value", () => {
    expect(() => parseFlags(["--path=C"])).toThrow(/--path must be A, B, or both/);
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

  it("rejects other resource types and malformed values", () => {
    expect(isShopifyOrderGid("gid://shopify/Customer/1")).toBe(false);
    expect(isShopifyOrderGid("gid://shopify/Order/")).toBe(false);
    expect(isShopifyOrderGid("gid://shopify/Order/abc")).toBe(false);
    expect(isShopifyOrderGid("12345")).toBe(false);
    expect(isShopifyOrderGid(null)).toBe(false);
    expect(isShopifyOrderGid(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path A — dry-run
// ─────────────────────────────────────────────────────────────────────────────

describe("processPathABatch — dry-run", () => {
  it("matches a single OMS row and counts it without writing", async () => {
    mockState.executeResponses = [{ rows: [{ id: 999 }] }];

    const rows = [
      { wms_id: 1, wms_order_number: "SHOP-1", gid: "gid://shopify/Order/10001" },
    ];

    const stats = await processPathABatch(rows as any, false);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.orphans).toBe(0);
    expect(stats.ambiguous).toBe(0);
    expect(stats.updatedInDb).toBe(0);
    expect(stats.errors).toBe(0);
    expect(mockState.transactionRan).toBe(0);
  });

  it("counts orphan rows (0 OMS matches)", async () => {
    mockState.executeResponses = [{ rows: [] }];

    const rows = [
      { wms_id: 2, wms_order_number: "SHOP-2", gid: "gid://shopify/Order/20002" },
    ];

    const stats = await processPathABatch(rows as any, false);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(0);
    expect(stats.orphans).toBe(1);
    expect(stats.updatedInDb).toBe(0);
  });

  it("counts ambiguous rows (>1 OMS matches)", async () => {
    mockState.executeResponses = [{ rows: [{ id: 100 }, { id: 200 }] }];

    const rows = [
      { wms_id: 3, wms_order_number: "SHOP-3", gid: "gid://shopify/Order/30003" },
    ];

    const stats = await processPathABatch(rows as any, false);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(0);
    expect(stats.ambiguous).toBe(1);
    expect(stats.updatedInDb).toBe(0);
  });

  it("skips invalid GID shapes without consulting DB", async () => {
    const rows = [
      { wms_id: 4, wms_order_number: "SHOP-4", gid: "gid://shopify/Order/" },
      { wms_id: 5, wms_order_number: "SHOP-5", gid: "gid://shopify/Customer/42" },
    ];

    const stats = await processPathABatch(rows as any, false);

    expect(stats.scanned).toBe(2);
    expect(stats.skippedInvalidGidShape).toBe(2);
    expect(stats.matched).toBe(0);
    expect(mockState.executeCalls.length).toBe(0);
  });

  it("reports errors without aborting the batch", async () => {
    const dbMod = await import("../../server/db");
    let call = 0;
    (dbMod.db.execute as any) = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("pg timeout");
      return { rows: [{ id: 777 }] };
    });

    const rows = [
      { wms_id: 6, wms_order_number: "SHOP-6", gid: "gid://shopify/Order/60006" },
      { wms_id: 7, wms_order_number: "SHOP-7", gid: "gid://shopify/Order/70007" },
    ];

    const stats = await processPathABatch(rows as any, false);

    expect(stats.scanned).toBe(2);
    expect(stats.errors).toBe(1);
    expect(stats.matched).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path A — execute
// ─────────────────────────────────────────────────────────────────────────────

describe("processPathABatch — execute", () => {
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
      { wms_id: 10, wms_order_number: "SHOP-10", gid: "gid://shopify/Order/100100" },
      { wms_id: 11, wms_order_number: "SHOP-11", gid: "gid://shopify/Order/100101" },
    ];

    const stats = await processPathABatch(rows as any, true);

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

    mockState.executeResponses = [{ rows: [{ id: 333 }] }];
    mockState.transactionShouldThrow = new Error("deadlock detected");

    const rows = [
      { wms_id: 99, wms_order_number: "SHOP-99", gid: "gid://shopify/Order/999" },
    ];

    const stats = await processPathABatch(rows as any, true);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.errors).toBe(1);
    expect(stats.updatedInDb).toBe(0);
  });

  it("counts NOOP on concurrent update (defence-in-depth re-check)", async () => {
    const dbMod = await import("../../server/db");
    (dbMod.db.execute as any) = vi.fn(async () => {
      return mockState.executeResponses.shift()!;
    });

    mockState.executeResponses = [{ rows: [{ id: 444 }] }];
    mockState.txExecuteResponses = [{ rows: [] }];

    const rows = [
      { wms_id: 50, wms_order_number: "SHOP-50", gid: "gid://shopify/Order/50050" },
    ];

    const stats = await processPathABatch(rows as any, true);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.updatedInDb).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it("skips transaction when nothing to update", async () => {
    const dbMod = await import("../../server/db");
    (dbMod.db.execute as any) = vi.fn(async () => {
      return mockState.executeResponses.shift()!;
    });

    mockState.executeResponses = [{ rows: [] }];

    const rows = [
      { wms_id: 60, wms_order_number: "SHOP-60", gid: "gid://shopify/Order/600" },
    ];

    const stats = await processPathABatch(rows as any, true);

    expect(stats.orphans).toBe(1);
    expect(mockState.transactionRan).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path B — dry-run
// ─────────────────────────────────────────────────────────────────────────────

describe("processPathBBatch — dry-run", () => {
  it("matches a row and counts it without writing", async () => {
    mockState.executeResponses = [{ rows: [{ id: 999 }] }];

    const rows = [
      { wms_id: 1, wms_order_number: "SHOP-1", wms_channel_id: 10 },
    ];

    const stats = await processPathBBatch(rows as any, false);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.orphans).toBe(0);
    expect(stats.updatedInDb).toBe(0);
    expect(stats.errors).toBe(0);
    expect(mockState.transactionRan).toBe(0);
  });

  it("counts orphan rows (0 OMS matches)", async () => {
    mockState.executeResponses = [{ rows: [] }];

    const rows = [
      { wms_id: 2, wms_order_number: "SHOP-2", wms_channel_id: 10 },
    ];

    const stats = await processPathBBatch(rows as any, false);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(0);
    expect(stats.orphans).toBe(1);
    expect(stats.updatedInDb).toBe(0);
  });

  it("skips rows with NULL channel_id", async () => {
    const rows = [
      { wms_id: 3, wms_order_number: "SHOP-3", wms_channel_id: null },
    ];

    const stats = await processPathBBatch(rows as any, false);

    expect(stats.scanned).toBe(1);
    expect(stats.skippedChannelMismatch).toBe(1);
    expect(stats.matched).toBe(0);
    expect(mockState.executeCalls.length).toBe(0);
  });

  it("counts ambiguous rows (>1 OMS matches)", async () => {
    mockState.executeResponses = [{ rows: [{ id: 100 }, { id: 200 }] }];

    const rows = [
      { wms_id: 4, wms_order_number: "SHOP-4", wms_channel_id: 10 },
    ];

    const stats = await processPathBBatch(rows as any, false);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(0);
    expect(stats.ambiguous).toBe(1);
    expect(stats.updatedInDb).toBe(0);
  });

  it("processes mixed matched + orphan rows", async () => {
    mockState.executeResponses = [
      { rows: [{ id: 111 }] },
      { rows: [] },
      { rows: [{ id: 333 }] },
    ];

    const rows = [
      { wms_id: 10, wms_order_number: "SHOP-10", wms_channel_id: 1 },
      { wms_id: 11, wms_order_number: "SHOP-11", wms_channel_id: 1 },
      { wms_id: 12, wms_order_number: "SHOP-12", wms_channel_id: 1 },
    ];

    const stats = await processPathBBatch(rows as any, false);

    expect(stats.scanned).toBe(3);
    expect(stats.matched).toBe(2);
    expect(stats.orphans).toBe(1);
    expect(stats.updatedInDb).toBe(0);
  });

  it("reports errors without aborting the batch", async () => {
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

    const stats = await processPathBBatch(rows as any, false);

    expect(stats.scanned).toBe(2);
    expect(stats.errors).toBe(1);
    expect(stats.matched).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path B — execute
// ─────────────────────────────────────────────────────────────────────────────

describe("processPathBBatch — execute", () => {
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

    const stats = await processPathBBatch(rows as any, true);

    expect(stats.scanned).toBe(2);
    expect(stats.matched).toBe(2);
    expect(stats.updatedInDb).toBe(2);
    expect(stats.errors).toBe(0);
    expect(mockState.transactionRan).toBe(1);
  });

  it("rolls back on transaction failure", async () => {
    const dbMod = await import("../../server/db");
    (dbMod.db.execute as any) = vi.fn(async () => {
      return mockState.executeResponses.shift()!;
    });

    mockState.executeResponses = [{ rows: [{ id: 333 }] }];
    mockState.transactionShouldThrow = new Error("deadlock detected");

    const rows = [
      { wms_id: 99, wms_order_number: "SHOP-99", wms_channel_id: 1 },
    ];

    const stats = await processPathBBatch(rows as any, true);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.errors).toBe(1);
    expect(stats.updatedInDb).toBe(0);
  });

  it("does not open a transaction when nothing to update", async () => {
    const dbMod = await import("../../server/db");
    (dbMod.db.execute as any) = vi.fn(async () => {
      return mockState.executeResponses.shift()!;
    });

    mockState.executeResponses = [{ rows: [] }];

    const rows = [
      { wms_id: 60, wms_order_number: "SHOP-60", wms_channel_id: 1 },
    ];

    const stats = await processPathBBatch(rows as any, true);

    expect(stats.orphans).toBe(1);
    expect(mockState.transactionRan).toBe(0);
  });

  it("counts NOOP on concurrent update", async () => {
    const dbMod = await import("../../server/db");
    (dbMod.db.execute as any) = vi.fn(async () => {
      return mockState.executeResponses.shift()!;
    });

    mockState.executeResponses = [{ rows: [{ id: 444 }] }];
    mockState.txExecuteResponses = [{ rows: [] }];

    const rows = [
      { wms_id: 50, wms_order_number: "SHOP-50", wms_channel_id: 1 },
    ];

    const stats = await processPathBBatch(rows as any, true);

    expect(stats.scanned).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.updatedInDb).toBe(0);
    expect(stats.errors).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stats constructors — zero-start
// ─────────────────────────────────────────────────────────────────────────────

describe("newAStats / newBStats", () => {
  it("initializes every counter to zero for Path A", () => {
    const s = newAStats();
    expect(s.scanned).toBe(0);
    expect(s.matched).toBe(0);
    expect(s.orphans).toBe(0);
    expect(s.ambiguous).toBe(0);
    expect(s.skippedInvalidGidShape).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.updatedInDb).toBe(0);
  });

  it("initializes every counter to zero for Path B", () => {
    const s = newBStats();
    expect(s.scanned).toBe(0);
    expect(s.matched).toBe(0);
    expect(s.orphans).toBe(0);
    expect(s.ambiguous).toBe(0);
    expect(s.skippedChannelMismatch).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.updatedInDb).toBe(0);
  });
});
