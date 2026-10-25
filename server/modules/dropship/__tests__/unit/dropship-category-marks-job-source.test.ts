import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
import { DropshipError } from "../../domain/errors";
import { PgDropshipCategoryMarksJobSource } from "../../infrastructure/dropship-category-marks-job.source";

const NOW = new Date("2026-10-13T09:15:00.000Z");
/**
 * The selected-catalog keyset over the vendor's own picks (PLAN-B v4.1 §9 row 3, FIDELITY-3), not over every
 * sellable size: the scan reads O(selected) rows of that one vendor.
 */
const VENDOR_PICKS_KEYSET = /FROM dropship\.dropship_vendor_selected_variants s[\s\S]*WHERE s\.vendor_id = \$1 AND s\.product_variant_id > \$2/;
/** Statements a read may send: never a write, a row lock or an advisory lock. */
const WRITE_OR_LOCK = /\b(INSERT|UPDATE|DELETE|LOCK\s+TABLE|FOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)|pg_advisory)/i;

/** A pool whose one client records every statement; every read answers no row unless `failOn` matches. */
function fakePool(options: { storeRows?: unknown[]; failOn?: RegExp; failure?: unknown; rollbackFails?: boolean; connectFailure?: unknown } = {}) {
  const statements: string[] = [];
  const released: unknown[] = [];
  const answer = async (sql: string) => {
    statements.push(sql);
    if (options.failOn?.test(sql)) throw options.failure;
    if (sql === "ROLLBACK" && options.rollbackFails) throw new Error("connection lost");
    return { rows: /FROM dropship\.dropship_store_connections sc\s+JOIN dropship\.dropship_vendors/.test(sql) ? options.storeRows ?? [] : [] };
  };
  const pool = {
    query: vi.fn(answer),
    connect: vi.fn(async () => {
      if (options.connectFailure) throw options.connectFailure;
      return { query: vi.fn(answer), release: vi.fn((error?: unknown) => { released.push(error); }) };
    }),
  };
  return { pool: pool as unknown as Pool, statements, released, raw: pool };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null, (error: unknown) => error);
}

describe("PgDropshipCategoryMarksJobSource (plan PR 9, P28, 10.5)", () => {
  it("lists eBay stores by P28's lists, by vendor then store, with no entitlement filter and no lock, in one statement", async () => {
    const { pool, statements } = fakePool({ storeRows: [{ vendor_id: 10, store_connection_id: 22 }, { vendor_id: 10, store_connection_id: 24 },
      { vendor_id: 11, store_connection_id: 23 }] });

    await expect(new PgDropshipCategoryMarksJobSource(pool).listMarkableStores()).resolves.toEqual([
      { vendorId: 10, storeConnectionId: 22 }, { vendorId: 10, storeConnectionId: 24 }, { vendorId: 11, storeConnectionId: 23 }]);

    expect(statements).toHaveLength(1);
    const [sql] = statements;
    expect(sql).toContain("sc.platform = 'ebay'");
    expect(sql).toContain("sc.status IN ('connected', 'needs_reauth', 'refresh_failed')");
    expect(sql).toContain("v.status IN ('active', 'onboarding')");
    expect(sql).toContain("ORDER BY sc.vendor_id, sc.id");
    expect(sql).not.toMatch(/entitlement/);
    expect(sql).not.toMatch(WRITE_OR_LOCK);
  });

  it.each([
    ["an id that is not an int4", [{ vendor_id: "10", store_connection_id: 22 }]],
    ["a store id past int4", [{ vendor_id: 10, store_connection_id: 2_147_483_648 }]],
    ["a store twice", [{ vendor_id: 10, store_connection_id: 22 }, { vendor_id: 10, store_connection_id: 22 }]],
  ])("refuses %s as a broken contract (fatal for the tick)", async (_label, rows) => {
    const error = await failure(new PgDropshipCategoryMarksJobSource(fakePool({ storeRows: rows }).pool).listMarkableStores());
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", context: { classification: "fatal" } });
  });

  it("answers a lost connection or a full pool as the retryable BUSY, and passes any other failure as it is", async () => {
    const lost = Object.assign(new Error("terminating connection"), { code: "57P01" });
    await expect(new PgDropshipCategoryMarksJobSource(fakePool({ failOn: /dropship_store_connections/, failure: lost }).pool)
      .listMarkableStores()).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: { classification: "transient" } });
    const full = new Error("timeout exceeded when trying to connect");
    await expect(new PgDropshipCategoryMarksJobSource(fakePool({ connectFailure: full }).pool).listSelectedProductIds(10, NOW))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: { failure: "pool_acquire_timeout" } });
    const unexpected = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    await expect(new PgDropshipCategoryMarksJobSource(fakePool({ failOn: /dropship_store_connections/, failure: unexpected }).pool)
      .listMarkableStores()).rejects.toBe(unexpected);
  });

  it("scans a vendor's chosen products in one read-only snapshot on its own connection, with no lock or write", async () => {
    const { pool, statements, released, raw } = fakePool();

    await expect(new PgDropshipCategoryMarksJobSource(pool).listSelectedProductIds(10, NOW)).resolves.toEqual([]);

    expect(raw.connect).toHaveBeenCalledOnce();
    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.some((sql) => VENDOR_PICKS_KEYSET.test(sql))).toBe(true);
    expect(statements.filter((sql) => WRITE_OR_LOCK.test(sql))).toEqual([]);
    expect(released).toEqual([undefined]);
  });

  it("rolls back and releases the connection when the scan fails, and destroys it when the rollback fails too", async () => {
    const lost = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const kept = fakePool({ failOn: VENDOR_PICKS_KEYSET, failure: lost });
    await expect(new PgDropshipCategoryMarksJobSource(kept.pool).listSelectedProductIds(10, NOW))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: { failure: "ECONNRESET" } });
    expect(kept.statements.at(-1)).toBe("ROLLBACK");
    expect(kept.released).toEqual([undefined]);

    const broken = fakePool({ failOn: VENDOR_PICKS_KEYSET, failure: lost, rollbackFails: true });
    await expect(new PgDropshipCategoryMarksJobSource(broken.pool).listSelectedProductIds(10, NOW))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY" });
    expect(broken.released).toHaveLength(1);
    expect(broken.released[0]).toBeInstanceOf(Error);
  });

  it.each([
    ["a vendor id of 0", 0, NOW],
    ["a vendor id past int4", 2_147_483_648, NOW],
    ["an invalid time", 10, new Date(Number.NaN)],
  ])("refuses %s before taking a connection", async (_label, vendorId, now) => {
    const { pool, raw } = fakePool();
    const error = await failure(new PgDropshipCategoryMarksJobSource(pool).listSelectedProductIds(vendorId, now));
    expect(error).toBeInstanceOf(DropshipError);
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
    expect(raw.connect).not.toHaveBeenCalled();
  });
});
