import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  PgDropshipVendorStandingRepository,
  pauseDropshipVendorWithClient,
} from "../../infrastructure/dropship-vendor-standing.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const now = new Date("2026-09-17T12:00:00.000Z");

describe("PgDropshipVendorStandingRepository", () => {
  it("pauses only an active vendor, bumps the revision, and audits it in the same transaction", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(firstWords(sqlText));
      if (sqlText.startsWith("UPDATE dropship.dropship_vendors")) {
        expect(sqlText).toContain("SET status = 'paused'");
        expect(sqlText).toContain("standing_revision = standing_revision + 1");
        expect(sqlText).toContain("AND status = 'active'");
        expect(params).toEqual([10, "card_declined", now]);
        return { rows: [standingRow({ status: "paused", standing_reason: "card_declined", paused_at: now, standing_revision: 1 })] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        expect(sqlText).toContain("'dropship_vendor'");
        expect(sqlText).toContain("'dropship-vendor-standing'");
        expect(params?.slice(0, 3)).toEqual([10, "10", "vendor_paused"]);
        expect(JSON.parse(String(params?.[3]))).toEqual({
          reason: "card_declined",
          evidence: { source: "wallet_maintenance", runId: 5 },
          before: { status: "active" },
          after: { status: "paused", standingReason: "card_declined", pausedAt: now.toISOString(), standingRevision: 1 },
        });
        expect(params?.[4]).toBe(now);
        return { rows: [] };
      }
      return { rows: [] };
    });
    const { pool, released } = makePool(query);

    const result = await new PgDropshipVendorStandingRepository(pool).pauseVendor({
      vendorId: 10,
      reason: "card_declined",
      evidence: { source: "wallet_maintenance", runId: 5 },
      now,
    });

    expect(result).toEqual({
      changed: true,
      standing: {
        vendorId: 10,
        status: "paused",
        standingReason: "card_declined",
        pausedAt: now,
        standingRevision: 1,
        listingHoldState: "released",
        listingHoldReconciledAt: null,
        listingHoldDetail: null,
      },
    });
    expect(statements).toEqual(["BEGIN", "UPDATE dropship.dropship_vendors", "INSERT INTO", "COMMIT"]);
    expect(released()).toBe(true);
  });

  it("reports the current standing unchanged when the guarded pause matches no row", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      statements.push(firstWords(sqlText));
      if (sqlText.startsWith("UPDATE dropship.dropship_vendors")) return { rows: [] };
      if (sqlText.startsWith("SELECT")) return { rows: [standingRow({ status: "paused", standing_reason: "operator", paused_at: now, standing_revision: 2 })] };
      return { rows: [] };
    });
    const { pool } = makePool(query);

    await expect(new PgDropshipVendorStandingRepository(pool).pauseVendor({ vendorId: 10, reason: "funding_returned", evidence: {}, now }))
      .resolves.toMatchObject({ changed: false, standing: { status: "paused", standingReason: "operator", standingRevision: 2 } });
    expect(statements).toEqual(["BEGIN", "UPDATE dropship.dropship_vendors", "SELECT id,", "COMMIT"]);
  });

  it("resumes only a funding pause, never an operator pause, with the before state in the audit row", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(firstWords(sqlText));
      if (sqlText.startsWith("SELECT")) {
        expect(sqlText).toContain("FOR UPDATE");
        expect(sqlText).toContain("entitlement_status");
        return { rows: [standingRow({ status: "paused", standing_reason: "funding_returned", paused_at: now, standing_revision: 1, listing_hold_state: "held", entitlement_status: "active" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_vendors")) {
        expect(sqlText).toContain("SET status = $3");
        expect(sqlText).toContain("standing_reason = NULL");
        expect(sqlText).toContain("AND status = 'paused'");
        expect(sqlText).toContain("AND standing_reason IN ('card_declined', 'funding_returned')");
        expect(params).toEqual([10, now, "active"]);
        return { rows: [standingRow({ status: "active", standing_revision: 2, listing_hold_state: "held" })] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        expect(params?.slice(0, 3)).toEqual([10, "10", "vendor_resumed"]);
        expect(JSON.parse(String(params?.[3]))).toEqual({
          evidence: { availableBalanceCents: 6000 },
          before: { status: "paused", standingReason: "funding_returned", pausedAt: now.toISOString() },
          after: { status: "active", standingRevision: 2 },
        });
        return { rows: [] };
      }
      return { rows: [] };
    });
    const { pool } = makePool(query);

    const result = await new PgDropshipVendorStandingRepository(pool).resumeVendor({ vendorId: 10, evidence: { availableBalanceCents: 6000 }, now });

    expect(result).toMatchObject({ changed: true, standing: { status: "active", standingReason: null, pausedAt: null, standingRevision: 2, listingHoldState: "held" } });
    expect(statements).toEqual(["BEGIN", "SELECT id,", "UPDATE dropship.dropship_vendors", "INSERT INTO", "COMMIT"]);
  });

  it("resumes into the status the membership now implies, and fails closed on an entitlement it does not know", async () => {
    for (const [entitlement, expected] of [["lapsed", "lapsed"], ["suspended", "suspended"], ["grace", "active"], ["mystery", "lapsed"]] as const) {
      const query = vi.fn(async (sql: string, params?: unknown[]) => {
        const sqlText = String(sql);
        if (sqlText.startsWith("SELECT")) {
          return { rows: [standingRow({ status: "paused", standing_reason: "card_declined", paused_at: now, standing_revision: 1, entitlement_status: entitlement })] };
        }
        if (sqlText.startsWith("UPDATE dropship.dropship_vendors")) {
          expect(params?.[2]).toBe(expected);
          return { rows: [standingRow({ status: expected, standing_revision: 2 })] };
        }
        if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
          expect(JSON.parse(String(params?.[3]))).toMatchObject({ after: { status: expected, standingRevision: 2 } });
        }
        return { rows: [] };
      });
      const { pool } = makePool(query);
      await expect(new PgDropshipVendorStandingRepository(pool).resumeVendor({ vendorId: 10, evidence: {}, now }))
        .resolves.toMatchObject({ changed: true, standing: { status: expected, standingReason: null } });
    }
  });

  it("leaves an operator pause in place and commits nothing else", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      statements.push(firstWords(sqlText));
      if (sqlText.startsWith("SELECT")) return { rows: [standingRow({ status: "paused", standing_reason: "operator", paused_at: now })] };
      return { rows: [] };
    });
    const { pool } = makePool(query);

    await expect(new PgDropshipVendorStandingRepository(pool).resumeVendor({ vendorId: 10, evidence: {}, now }))
      .resolves.toMatchObject({ changed: false, standing: { standingReason: "operator" } });
    expect(statements).toEqual(["BEGIN", "SELECT id,", "UPDATE dropship.dropship_vendors", "COMMIT"]);
  });

  it("rolls back and releases the client when a statement fails", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      statements.push(firstWords(sqlText));
      if (sqlText.startsWith("UPDATE")) throw new Error("connection lost");
      return { rows: [] };
    });
    const { pool, released } = makePool(query);

    await expect(new PgDropshipVendorStandingRepository(pool).pauseVendor({ vendorId: 10, reason: "card_declined", evidence: {}, now }))
      .rejects.toThrow("connection lost");
    expect(statements).toEqual(["BEGIN", "UPDATE dropship.dropship_vendors", "ROLLBACK"]);
    expect(released()).toBe(true);
  });

  it("shares the pause statement with callers that hold their own transaction", async () => {
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      if (sqlText.startsWith("UPDATE")) return { rows: [standingRow({ status: "paused", standing_reason: "funding_returned", paused_at: now, standing_revision: 1 })] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;

    await expect(pauseDropshipVendorWithClient(client, { vendorId: 10, reason: "funding_returned", evidence: { ledgerEntryId: 1 }, now }))
      .resolves.toMatchObject({ changed: true, standing: { status: "paused", standingReason: "funding_returned" } });
    expect(query.mock.calls.map((call) => firstWords(String(call[0])))).toEqual(["UPDATE dropship.dropship_vendors", "INSERT INTO"]);
  });

  it("lists paused-for-funding vendors oldest first, listing-hold mismatches, and live store connections", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      if (sqlText.includes("standing_reason IN ('card_declined', 'funding_returned')")) {
        expect(sqlText).toContain("WHERE status = 'paused'");
        expect(sqlText).toContain("ORDER BY paused_at ASC, id ASC");
        expect(params).toEqual([25]);
        return { rows: [standingRow({ status: "paused", standing_reason: "card_declined", paused_at: now, standing_revision: 1 })] };
      }
      if (sqlText.includes("listing_hold_state = 'released'")) {
        expect(sqlText).toContain("(status = 'paused' AND listing_hold_state = 'released')");
        expect(sqlText).toContain("(status <> 'paused' AND listing_hold_state = 'held')");
        expect(params).toEqual([25]);
        return { rows: [standingRow({ status: "active", listing_hold_state: "held", standing_revision: 4 })] };
      }
      if (sqlText.includes("FROM dropship.dropship_store_connections")) {
        expect(sqlText).toContain("AND status <> 'disconnected'");
        expect(params).toEqual([10]);
        return { rows: [{ id: 77 }, { id: 78 }] };
      }
      throw new Error(`unexpected SQL: ${sqlText}`);
    });
    const repository = new PgDropshipVendorStandingRepository({ query } as unknown as Pool);

    await expect(repository.listPausedForFunding({ limit: 25 })).resolves.toMatchObject([{ vendorId: 10, standingReason: "card_declined" }]);
    await expect(repository.listListingHoldMismatches({ limit: 25 })).resolves.toMatchObject([{ vendorId: 10, status: "active", listingHoldState: "held" }]);
    await expect(repository.listStoreConnectionIds(10)).resolves.toEqual([77, 78]);
  });

  it("records the listing hold state and fails loudly for an unknown vendor", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(String(sql)).toContain("SET listing_hold_state = $2");
      return { rowCount: params?.[0] === 10 ? 1 : 0, rows: [] };
    });
    const repository = new PgDropshipVendorStandingRepository({ query } as unknown as Pool);

    await expect(repository.recordListingHoldState({ vendorId: 10, state: "held", detail: null, now })).resolves.toBeUndefined();
    expect(query.mock.calls[0]?.[1]).toEqual([10, "held", now, null]);
    await expect(repository.recordListingHoldState({ vendorId: 404, state: "held", detail: "x", now }))
      .rejects.toMatchObject({ code: "DROPSHIP_VENDOR_STANDING_NOT_FOUND" });
  });

  it("refuses a row whose status, reason or hold state is outside the allowed sets", async () => {
    for (const bad of [{ status: "frozen" }, { standing_reason: "bored" }, { listing_hold_state: "maybe" }]) {
      const query = vi.fn(async () => ({ rows: [standingRow({ ...(bad.standing_reason ? { status: "paused", paused_at: now } : {}), ...bad })] }));
      const repository = new PgDropshipVendorStandingRepository({ query } as unknown as Pool);
      await expect(repository.getStanding(10)).rejects.toMatchObject({ code: "DROPSHIP_VENDOR_STANDING_ROW_INVALID" });
    }
  });
});

function standingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    status: "active",
    standing_reason: null,
    paused_at: null,
    standing_revision: 0,
    listing_hold_state: "released",
    listing_hold_reconciled_at: null,
    listing_hold_detail: null,
    ...overrides,
  };
}

function firstWords(sql: string): string {
  return sql.trim().split(/\s+/).slice(0, 2).join(" ");
}

function makePool(query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>): { pool: Pool; released: () => boolean } {
  let released = false;
  const client = { query, release: () => { released = true; } } as unknown as PoolClient;
  const pool = { connect: async () => client, query } as unknown as Pool;
  return { pool, released: () => released };
}
