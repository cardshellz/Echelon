import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for scripts/dedup-oms-orders-duplicate-external-order-number.ts
//
// Coverage:
//   1. parseFlags — CLI surface.
//   2. main — dry-run, execute, no-dupes, error paths.
// ─────────────────────────────────────────────────────────────────────────────

// ── Mock pg Pool ────────────────────────────────────────────────────────────

const mockPoolState = vi.hoisted(() => {
  return {
    poolQueryResponses: [] as Array<{ rows: any[]; rowCount?: number }>,
    poolQueryCalls: [] as Array<{ text: string; params: any[] }>,
    clientQueryResponses: [] as Array<{ rows: any[]; rowCount?: number }>,
    clientQueryCalls: [] as Array<{ text: string; params: any[] }>,
    beginCount: 0,
    commitCount: 0,
    rollbackCount: 0,
    shouldThrowOnClientQuery: false as boolean,
  };
});

vi.mock("pg", () => {
  const mockClient = {
    query: vi.fn(async (text: string, params?: any[]) => {
      if (text === "BEGIN") {
        mockPoolState.beginCount++;
        return { rows: [], rowCount: 0 };
      }
      if (text === "COMMIT") {
        mockPoolState.commitCount++;
        return { rows: [], rowCount: 0 };
      }
      if (text === "ROLLBACK") {
        mockPoolState.rollbackCount++;
        return { rows: [], rowCount: 0 };
      }
      mockPoolState.clientQueryCalls.push({ text, params: params ?? [] });
      if (mockPoolState.shouldThrowOnClientQuery) {
        throw new Error("simulated DB error");
      }
      if (mockPoolState.clientQueryResponses.length === 0) {
        throw new Error(
          `mock client.query called but no response queued (call #${mockPoolState.clientQueryCalls.length})`,
        );
      }
      return mockPoolState.clientQueryResponses.shift()!;
    }),
    release: vi.fn(),
  };

  class MockPool {
    query = vi.fn(async (text: string, params: any[]) => {
      mockPoolState.poolQueryCalls.push({ text, params });
      if (mockPoolState.poolQueryResponses.length === 0) {
        throw new Error(
          `mock pool.query called but no response queued (call #${mockPoolState.poolQueryCalls.length})`,
        );
      }
      return mockPoolState.poolQueryResponses.shift()!;
    });
    connect = vi.fn(async () => mockClient);
    end = vi.fn(async () => {});
  }
  return { Pool: MockPool };
});

import { parseFlags } from "../dedup-oms-orders-duplicate-external-order-number";

// ── Helpers ─────────────────────────────────────────────────────────────────

function resetMockState() {
  mockPoolState.poolQueryResponses = [];
  mockPoolState.poolQueryCalls = [];
  mockPoolState.clientQueryResponses = [];
  mockPoolState.clientQueryCalls = [];
  mockPoolState.beginCount = 0;
  mockPoolState.commitCount = 0;
  mockPoolState.rollbackCount = 0;
  mockPoolState.shouldThrowOnClientQuery = false;
}

// Set DATABASE_URL so the script doesn't bail on missing env.
process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";

// ── parseFlags ──────────────────────────────────────────────────────────────

describe("parseFlags", () => {
  it("defaults to dry-run with no args", () => {
    const flags = parseFlags([]);
    expect(flags.execute).toBe(false);
    expect(flags.dryRun).toBe(true);
    expect(flags.limit).toBe(1000);
  });

  it("--dry-run is the default (no flag needed)", () => {
    const flags = parseFlags(["--dry-run"]);
    expect(flags.dryRun).toBe(true);
    expect(flags.execute).toBe(false);
  });

  it("--execute flips to execute mode", () => {
    const flags = parseFlags(["--execute"]);
    expect(flags.execute).toBe(true);
    expect(flags.dryRun).toBe(false);
  });

  it("parses --limit as integer", () => {
    const flags = parseFlags(["--limit=10"]);
    expect(flags.limit).toBe(10);
  });

  it("rejects invalid --limit", () => {
    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--limit=-5"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--limit=abc"])).toThrow(/positive integer/);
  });
});

// ── main — dry-run ─────────────────────────────────────────────────────────

describe("main — dry-run", () => {
  beforeEach(resetMockState);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  afterEach(() => exitSpy.mockClear());

  it("logs 2 duplicate groups without writing", async () => {
    const { main } = await import("../dedup-oms-orders-duplicate-external-order-number");

    mockPoolState.poolQueryResponses = [
      {
        rows: [
          { channel_id: 1, external_order_number: "55521", cnt: 2, ids: [100, 101] },
          { channel_id: 2, external_order_number: "55524", cnt: 3, ids: [200, 201, 202] },
        ],
      },
    ];

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main([]);

    expect(mockPoolState.poolQueryCalls.length).toBe(1);
    expect(mockPoolState.beginCount).toBe(0);
    expect(mockPoolState.clientQueryCalls.length).toBe(0);

    const logs = logSpy.mock.calls.map((c) => c[0]);
    expect(logs.some((l: string) => l.includes("[DRY]") && l.includes("55521"))).toBe(true);
    expect(logs.some((l: string) => l.includes("[DRY]") && l.includes("55524"))).toBe(true);
    expect(logs.some((l: string) => l.includes("Safe to apply"))).toBe(true);

    logSpy.mockRestore();
  });
});

// ── main — execute ─────────────────────────────────────────────────────────

describe("main — execute", () => {
  beforeEach(resetMockState);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  afterEach(() => exitSpy.mockClear());

  it("group of 2: keeps oldest, reassigns FKs, deletes newer", async () => {
    const { main } = await import("../dedup-oms-orders-duplicate-external-order-number");

    mockPoolState.poolQueryResponses = [
      {
        rows: [
          { channel_id: 1, external_order_number: "55521", cnt: 2, ids: [100, 101] },
        ],
      },
    ];

    mockPoolState.clientQueryResponses = [
      { rowCount: 1 },  // lines reassigned
      { rowCount: 0 },  // events reassigned
      { rowCount: 1 },  // orders deleted
    ];

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["--execute"]);

    expect(mockPoolState.beginCount).toBe(1);
    expect(mockPoolState.commitCount).toBe(1);
    expect(mockPoolState.rollbackCount).toBe(0);
    expect(mockPoolState.clientQueryCalls.length).toBe(3);

    // Verify reassign lines SQL
    const linesCall = mockPoolState.clientQueryCalls[0];
    expect(linesCall.text).toContain("oms_order_lines");
    expect(linesCall.params[0]).toBe(100);
    expect(linesCall.params[1]).toEqual([101]);

    // Verify reassign events SQL
    const eventsCall = mockPoolState.clientQueryCalls[1];
    expect(eventsCall.text).toContain("oms_order_events");

    // Verify delete SQL
    const deleteCall = mockPoolState.clientQueryCalls[2];
    expect(deleteCall.text).toContain("DELETE FROM oms.oms_orders");

    logSpy.mockRestore();
  });

  it("group of 3: keeps oldest, reassigns + deletes 2 newer", async () => {
    const { main } = await import("../dedup-oms-orders-duplicate-external-order-number");

    mockPoolState.poolQueryResponses = [
      {
        rows: [
          { channel_id: 1, external_order_number: "55524", cnt: 3, ids: [200, 201, 202] },
        ],
      },
    ];

    mockPoolState.clientQueryResponses = [
      { rowCount: 2 },  // lines reassigned
      { rowCount: 1 },  // events reassigned
      { rowCount: 2 },  // orders deleted
    ];

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["--execute"]);

    expect(mockPoolState.commitCount).toBe(1);
    expect(mockPoolState.clientQueryCalls.length).toBe(3);

    // Canonical is 200, doomed are [201, 202]
    expect(mockPoolState.clientQueryCalls[0].params[0]).toBe(200);
    expect(mockPoolState.clientQueryCalls[0].params[1]).toEqual([201, 202]);

    logSpy.mockRestore();
  });

  it("no duplicates found: exits cleanly", async () => {
    const { main } = await import("../dedup-oms-orders-duplicate-external-order-number");

    mockPoolState.poolQueryResponses = [{ rows: [] }];

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["--execute"]);

    expect(mockPoolState.beginCount).toBe(0);
    expect(mockPoolState.clientQueryCalls.length).toBe(0);

    const logs = logSpy.mock.calls.map((c) => c[0]);
    expect(logs.some((l: string) => l.includes("No duplicates"))).toBe(true);

    logSpy.mockRestore();
  });

  it("DB error during transaction: rollback, no partial writes", async () => {
    const { main } = await import("../dedup-oms-orders-duplicate-external-order-number");

    mockPoolState.poolQueryResponses = [
      {
        rows: [
          { channel_id: 1, external_order_number: "ERR-1", cnt: 2, ids: [300, 301] },
        ],
      },
    ];

    mockPoolState.shouldThrowOnClientQuery = true;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await main(["--execute"]);

    expect(mockPoolState.beginCount).toBe(1);
    expect(mockPoolState.rollbackCount).toBe(1);
    expect(mockPoolState.commitCount).toBe(0);

    const errLogs = errSpy.mock.calls.map((c) => c[0]);
    expect(errLogs.some((l: string) => l.includes("ERROR"))).toBe(true);

    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});

// ── main — bad input ───────────────────────────────────────────────────────

describe("main — bad input", () => {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  afterEach(() => exitSpy.mockClear());

  it("negative limit throws", async () => {
    const { main } = await import("../dedup-oms-orders-duplicate-external-order-number");

    await expect(main(["--limit=-1"])).rejects.toThrow(/positive integer/);
  });
});
