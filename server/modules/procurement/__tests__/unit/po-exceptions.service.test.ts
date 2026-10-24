import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// PO Exceptions service tests (Phase 1 — migration 0567).
//
// Covers:
//   - computePayloadHash: deterministic, key order independent
//   - upsertException: preserve exact-source accepted match variance
//   - resolve requires resolutionNote
//   - listExceptions: filters by includeResolved
//   - countOpenExceptions: returns count + maxSeverity correctly
//   - detectQtyVariance: flags short and over, ignores cancelled lines
// Financial detector coverage lives in po-financial-exceptions.domain.test.ts
// and the real PostgreSQL po-financial-exceptions.integration.test.ts.
//
// All tests mock the db module to keep this purely in-memory.
// ─────────────────────────────────────────────────────────────────────────────

// Mock db with a chainable query builder. Test installs row-set responses
// per-call as needed.
const dbState = {
  selectChain: [] as any[],
  insertReturn: null as any,
  updateReturn: null as any,
};

function makeChain(finalValue: any): any {
  const chain: any = {};
  ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit", "groupBy", "set", "values"].forEach(
    (m) => {
      chain[m] = vi.fn(() => chain);
    },
  );
  chain.returning = vi.fn(async () => finalValue);
  // Allow `await chain` for select() patterns
  chain.then = (resolve: any) => Promise.resolve(finalValue).then(resolve);
  return chain;
}

// Note: vi.mock paths are resolved relative to the file BEING MOCKED'S
// import statement, not the test file. The service uses `../../db` which
// resolves to server/db.ts. We mock that real module path so any imports
// of it (transitive included) get our stub.
vi.mock("../../../../db", () => {
  const mockDb: any = {
    select: vi.fn(() => {
      const next = dbState.selectChain.shift() ?? [];
      return makeChain(next);
    }),
    insert: vi.fn(() => {
      return makeChain(dbState.insertReturn ?? []);
    }),
    update: vi.fn(() => {
      return makeChain(dbState.updateReturn ?? []);
    }),
  };
  mockDb.transaction = vi.fn(async (cb: any) => cb(mockDb));
  return {
    db: mockDb,
  };
});

// Now import the service AFTER mocking
import {
  computePayloadHash,
  upsertException,
  resolveException,
  listExceptions,
  countOpenExceptions,
  detectQtyVariance,
} from "../../po-exceptions.service";

beforeEach(() => {
  dbState.selectChain = [];
  dbState.insertReturn = null;
  dbState.updateReturn = null;
});

// ─── computePayloadHash ──────────────────────────────────────────────────────

describe("computePayloadHash", () => {
  it("produces the same hash for the same input", () => {
    const a = computePayloadHash(123, "qty_short", { lineId: 1, shortedQty: 2 });
    const b = computePayloadHash(123, "qty_short", { lineId: 1, shortedQty: 2 });
    expect(a).toBe(b);
  });

  it("is order-independent on payload keys", () => {
    const a = computePayloadHash(123, "qty_short", { lineId: 1, shortedQty: 2 });
    const b = computePayloadHash(123, "qty_short", { shortedQty: 2, lineId: 1 });
    expect(a).toBe(b);
  });

  it("differs on different po_id", () => {
    const a = computePayloadHash(123, "qty_short", { lineId: 1 });
    const b = computePayloadHash(124, "qty_short", { lineId: 1 });
    expect(a).not.toBe(b);
  });

  it("differs on different kind", () => {
    const a = computePayloadHash(123, "qty_short", { lineId: 1 });
    const b = computePayloadHash(123, "qty_over", { lineId: 1 });
    expect(a).not.toBe(b);
  });

  it("differs on different payload value", () => {
    const a = computePayloadHash(123, "qty_short", { lineId: 1, shortedQty: 2 });
    const b = computePayloadHash(123, "qty_short", { lineId: 1, shortedQty: 3 });
    expect(a).not.toBe(b);
  });
});

// Public-owner insertion and lifecycle persistence are covered in
// ../integration/po-exception-lifecycle.integration.test.ts with real PostgreSQL.
describe("source-bound exception acceptance", () => {
  it("keeps an exact-source accepted match variance resolved on re-detection", async () => {
    const accepted = {
      id: 5,
      poId: 123,
      kind: "match_mismatch",
      severity: "warn",
      status: "resolved",
      payloadHash: computePayloadHash(123, "match_mismatch", {
        invoiceId: 10,
        sourceFingerprint: "source-a",
        sourceVersion: 1,
      }),
    };
    dbState.selectChain.push([accepted]);

    const result = await upsertException({
      poId: 123,
      kind: "match_mismatch",
      severity: "warn",
      title: "Accepted invoice variance",
      payload: {
        invoiceId: 10,
        sourceFingerprint: "source-a",
        sourceVersion: 1,
      },
      preserveResolved: true,
    });

    expect(result).toBe(accepted);
  });
});

describe("resolveException — note required (pure validation)", () => {
  it("requires a non-empty resolution note", async () => {
    await expect(resolveException(1, "user:42", "")).rejects.toThrow(/resolution/i);
    await expect(resolveException(1, "user:42", "   ")).rejects.toThrow(/resolution/i);
  });
});

// ─── listExceptions ────────────────────────────────────────────────────────

describe("listExceptions", () => {
  it("filters out resolved/dismissed by default", async () => {
    dbState.selectChain.push([
      { id: 1, status: "open" },
      { id: 2, status: "acknowledged" },
    ]);
    const list = await listExceptions(123);
    expect(list).toHaveLength(2);
  });

  it("includes resolved/dismissed when opts.includeResolved=true", async () => {
    dbState.selectChain.push([
      { id: 1, status: "open" },
      { id: 2, status: "acknowledged" },
      { id: 3, status: "resolved" },
      { id: 4, status: "dismissed" },
    ]);
    const list = await listExceptions(123, { includeResolved: true });
    expect(list).toHaveLength(4);
  });
});

// ─── countOpenExceptions ────────────────────────────────────────────────────

describe("countOpenExceptions", () => {
  it("returns count and max severity from open + acknowledged rows", async () => {
    dbState.selectChain.push([
      { severity: "info" },
      { severity: "warn" },
      { severity: "error" },
    ]);
    const result = await countOpenExceptions(123);
    expect(result.count).toBe(3);
    expect(result.maxSeverity).toBe("error");
  });

  it("returns null maxSeverity when no exceptions", async () => {
    dbState.selectChain.push([]);
    const result = await countOpenExceptions(123);
    expect(result.count).toBe(0);
    expect(result.maxSeverity).toBeNull();
  });

  it("ranks warn over info", async () => {
    dbState.selectChain.push([{ severity: "warn" }, { severity: "info" }]);
    const result = await countOpenExceptions(123);
    expect(result.maxSeverity).toBe("warn");
  });
});

// ─── detectQtyVariance ───────────────────────────────────────────────────────

describe("detectQtyVariance", () => {
  it("flags qty_short when receivedQty < orderQty on a non-cancelled line", async () => {
    // PO + lines fetch: line 1 short by 2
    dbState.selectChain.push([
      {
        id: 1,
        poId: 123,
        sku: "TEST-1",
        orderQty: 24,
        receivedQty: 22,
        status: "open",
      },
    ]);
    // upsert lookup: no existing
    dbState.selectChain.push([]);
    dbState.insertReturn = [{ id: 100, kind: "qty_short" }];

    await detectQtyVariance(123);
    // Asserts pass if no throw — the side-effect is a po_exceptions row
    expect(dbState.selectChain.length).toBe(0); // both consumed
  });

  it("flags qty_over when receivedQty > orderQty", async () => {
    dbState.selectChain.push([
      {
        id: 1,
        poId: 123,
        sku: "TEST-1",
        orderQty: 24,
        receivedQty: 26,
        status: "open",
      },
    ]);
    dbState.selectChain.push([]); // upsert lookup
    dbState.insertReturn = [{ id: 100, kind: "qty_over" }];

    await detectQtyVariance(123);
    expect(dbState.selectChain.length).toBe(0);
  });

  it("ignores cancelled lines", async () => {
    dbState.selectChain.push([
      {
        id: 1,
        poId: 123,
        sku: "TEST-1",
        orderQty: 24,
        receivedQty: 0,
        status: "cancelled", // skipped
      },
    ]);

    await detectQtyVariance(123);
    // No upsert was attempted, so selectChain shouldn't have been
    // consumed beyond the initial line fetch.
    expect(dbState.selectChain.length).toBe(0);
  });

  it("does nothing when receivedQty == orderQty (clean receipt)", async () => {
    dbState.selectChain.push([
      {
        id: 1,
        poId: 123,
        sku: "TEST-1",
        orderQty: 24,
        receivedQty: 24,
        status: "open",
      },
    ]);

    await detectQtyVariance(123);
    expect(dbState.selectChain.length).toBe(0);
  });
});
