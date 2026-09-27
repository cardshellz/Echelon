import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgDropshipListingTierRepository } from "../../infrastructure/dropship-listing-tier.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const NOW = new Date("2026-09-17T12:00:00.000Z");

interface Scenario {
  existing?: Record<string, unknown> | null;
  vendors?: Record<string, unknown>[];
  listings?: Array<{ product_variant_id: number; uom_type: string }>;
  appliedRowCount?: number;
  failWith?: { code: string };
}

function holdRow(overrides: Record<string, unknown> = {}) {
  return {
    vendor_id: 10,
    held_tiers: ["case"],
    revision: 3,
    applied: true,
    tiers_on: ["pack"],
    detail: "held case",
    evaluated_at: new Date("2026-09-17T11:00:00.000Z"),
    applied_at: new Date("2026-09-17T11:00:00.000Z"),
    ...overrides,
  };
}

function fakePool(scenario: Scenario = {}) {
  const statements: string[] = [];
  const params: unknown[][] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const text = String(sql).replace(/\s+/g, " ").trim();
    statements.push(text);
    params.push(values ?? []);
    if (scenario.failWith) throw Object.assign(new Error("db failure"), scenario.failWith);
    if (text.startsWith("SELECT v.id AS vendor_id")) return { rows: scenario.vendors ?? [] };
    if (text.startsWith("SELECT id FROM dropship.dropship_store_connections")) return { rows: [{ id: 77 }, { id: 78 }] };
    if (text.startsWith("SELECT DISTINCT listing.product_variant_id")) return { rows: scenario.listings ?? [] };
    if (text.includes("FOR UPDATE")) return { rows: scenario.existing ? [scenario.existing] : [] };
    if (text.startsWith("UPDATE dropship.dropship_vendor_listing_tier_holds SET evaluated_at")) {
      return { rows: [{ ...(scenario.existing as Record<string, unknown>), evaluated_at: values?.[1], tiers_on: values?.[2] }] };
    }
    if (text.startsWith("INSERT INTO dropship.dropship_vendor_listing_tier_holds")) {
      const previous = scenario.existing as Record<string, unknown> | null | undefined;
      return { rows: [holdRow({
        vendor_id: values?.[0], held_tiers: values?.[1], revision: previous ? Number(previous.revision) + 1 : 1,
        applied: false, detail: values?.[2], evaluated_at: values?.[3], applied_at: null, tiers_on: values?.[4],
      })] };
    }
    if (text.startsWith("UPDATE dropship.dropship_vendor_listing_tier_holds SET applied")) {
      return { rowCount: scenario.appliedRowCount ?? 1, rows: [] };
    }
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, statements, params, release };
}

describe("PgDropshipListingTierRepository", () => {
  it("lists active and paused vendors with their recorded tier hold, oldest first", async () => {
    const { pool, params } = fakePool({ vendors: [
      { vendor_id: 10, status: "active", held_tiers: ["case"], revision: 3, applied: true, tiers_on: ["pack"], detail: "held case", evaluated_at: NOW, applied_at: NOW },
      { vendor_id: 11, status: "paused", held_tiers: null, revision: null, applied: null, tiers_on: null, detail: null, evaluated_at: null, applied_at: null },
    ] });

    const vendors = await new PgDropshipListingTierRepository(pool).listVendorsForReview({ limit: 50 });

    expect(vendors).toEqual([
      { vendorId: 10, status: "active", tierHold: { vendorId: 10, heldTiers: ["case"], revision: 3, applied: true, tiersOn: ["pack"], detail: "held case", evaluatedAt: NOW, appliedAt: NOW } },
      { vendorId: 11, status: "paused", tierHold: null },
    ]);
    expect(params[0]).toEqual([["active", "paused"], 50]);
  });

  it("reads one vendor's status and last decision whatever the status, a September row with no tiers on", async () => {
    const found = fakePool({ vendors: [
      { vendor_id: 10, status: "onboarding", held_tiers: [], revision: 5, applied: true, tiers_on: null, detail: null, evaluated_at: NOW, applied_at: NOW },
    ] });
    await expect(new PgDropshipListingTierRepository(found.pool).getVendor(10)).resolves.toEqual({
      vendorId: 10,
      status: "onboarding",
      tierHold: { vendorId: 10, heldTiers: [], revision: 5, applied: true, tiersOn: null, detail: null, evaluatedAt: NOW, appliedAt: NOW },
    });
    expect(found.statements[0]).toContain("WHERE v.id = $1");
    expect(found.statements[0]).not.toContain("ANY($1::text[])");
    expect(found.params[0]).toEqual([10]);

    const missing = fakePool({ vendors: [] });
    await expect(new PgDropshipListingTierRepository(missing.pool).getVendor(99)).resolves.toBeNull();

    const unmigrated = fakePool({ failWith: { code: "42P01" } });
    await expect(new PgDropshipListingTierRepository(unmigrated.pool).getVendor(10))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_TIER_TABLE_MISSING" });
  });

  it("groups a store's listing SKUs by the tier their unit of measure sells in", async () => {
    const { pool, params } = fakePool({ listings: [
      { product_variant_id: 101, uom_type: "each" },
      { product_variant_id: 102, uom_type: "inner_pack" },
      { product_variant_id: 201, uom_type: "case" },
      { product_variant_id: 202, uom_type: "skid" },
    ] });

    const byTier = await new PgDropshipListingTierRepository(pool).listListingVariantIdsByTier({ vendorId: 10, storeConnectionId: 77 });

    expect(byTier).toEqual({ pack: [101, 102], case: [201, 202] });
    expect(params[0]).toEqual([10, 77]);
  });

  it("refuses a listing whose unit of measure is unknown rather than guessing its tier", async () => {
    const { pool } = fakePool({ listings: [{ product_variant_id: 101, uom_type: "carton" }] });
    await expect(new PgDropshipListingTierRepository(pool).listListingVariantIdsByTier({ vendorId: 10, storeConnectionId: 77 }))
      .rejects.toMatchObject({ code: "DROPSHIP_CATALOG_VARIANT_UOM_TYPE_INVALID" });
  });

  it("records a changed set of held tiers with a bumped revision and an audit row in one transaction", async () => {
    const { pool, statements, params, release } = fakePool({ existing: holdRow({ held_tiers: [], revision: 3 }) });

    const result = await new PgDropshipListingTierRepository(pool).recordHeldTiers({
      vendorId: 10, heldTiers: ["case", "pack"], detail: "pack: off; case: off", now: NOW,
    });

    expect(result).toEqual({
      changed: true,
      record: { vendorId: 10, heldTiers: ["pack", "case"], revision: 4, applied: false, tiersOn: [], detail: "pack: off; case: off", evaluatedAt: NOW, appliedAt: null },
    });
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    const insertIndex = statements.findIndex((statement) => statement.startsWith("INSERT INTO dropship.dropship_vendor_listing_tier_holds"));
    expect(params[insertIndex]).toEqual([10, ["pack", "case"], "pack: off; case: off", NOW, []]);
    expect(statements[insertIndex]).toContain("revision = dropship_vendor_listing_tier_holds.revision + 1");
    expect(statements[insertIndex]).toContain("tiers_on = EXCLUDED.tiers_on");
    const auditIndex = statements.findIndex((statement) => statement.startsWith("INSERT INTO dropship.dropship_audit_events"));
    expect(auditIndex).toBeGreaterThan(insertIndex);
    expect(params[auditIndex]?.[0]).toBe(10);
    expect(params[auditIndex]?.[2]).toBe("dropship-listing-tiers");
    expect(JSON.parse(String(params[auditIndex]?.[3]))).toEqual({
      before: { heldTiers: [], tiersOn: ["pack"], revision: 3 },
      after: { heldTiers: ["pack", "case"], tiersOn: [], revision: 4 },
      detail: "pack: off; case: off",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("only refreshes the evaluation time and the tiers on when the held tiers did not change", async () => {
    // A September row decided again by the current rule: same held tiers, no revision, no audit row, tiers_on recorded.
    const { pool, statements, params } = fakePool({ existing: holdRow({ held_tiers: ["case"], revision: 3, tiers_on: null }) });

    const result = await new PgDropshipListingTierRepository(pool).recordHeldTiers({ vendorId: 10, heldTiers: ["case"], detail: "x", now: NOW });

    expect(result).toEqual({ changed: false, record: expect.objectContaining({ heldTiers: ["case"], revision: 3, applied: true, tiersOn: ["pack"], evaluatedAt: NOW }) });
    const updateIndex = statements.findIndex((statement) => statement.startsWith("UPDATE dropship.dropship_vendor_listing_tier_holds SET evaluated_at"));
    expect(statements[updateIndex]).toContain("tiers_on = $3::text[]");
    expect(params[updateIndex]).toEqual([10, NOW, ["pack"]]);
    expect(statements.some((statement) => statement.startsWith("INSERT INTO"))).toBe(false);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("creates the first row at revision one for a vendor without one", async () => {
    const { pool } = fakePool({ existing: null });

    const result = await new PgDropshipListingTierRepository(pool).recordHeldTiers({ vendorId: 10, heldTiers: [], detail: null, now: NOW });

    expect(result).toEqual({ changed: true, record: expect.objectContaining({ heldTiers: [], revision: 1, applied: false, tiersOn: ["pack", "case"] }) });
  });

  it("refuses a stored tiers_on entry that is not a listing tier", async () => {
    const read = fakePool({ vendors: [
      { vendor_id: 10, status: "active", held_tiers: [], revision: 3, applied: true, tiers_on: ["pallet"], detail: null, evaluated_at: NOW, applied_at: NOW },
    ] });
    await expect(new PgDropshipListingTierRepository(read.pool).getVendor(10))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_TIER_INVALID_STORED_VALUE" });
  });

  it("marks a revision applied only while it is still current", async () => {
    const current = fakePool({ appliedRowCount: 1 });
    await expect(new PgDropshipListingTierRepository(current.pool).recordApplied({ vendorId: 10, revision: 4, applied: true, detail: "held case", now: NOW }))
      .resolves.toBe(true);
    expect(current.params[0]).toEqual([10, 4, true, NOW, "held case"]);

    const stale = fakePool({ appliedRowCount: 0 });
    await expect(new PgDropshipListingTierRepository(stale.pool).recordApplied({ vendorId: 10, revision: 3, applied: false, detail: "deferred", now: NOW }))
      .resolves.toBe(false);
  });

  it("rolls back and names a missing table or an unknown vendor", async () => {
    const missing = fakePool({ failWith: { code: "42P01" } });
    await expect(new PgDropshipListingTierRepository(missing.pool).recordHeldTiers({ vendorId: 10, heldTiers: [], detail: null, now: NOW }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_TIER_TABLE_MISSING", context: { classification: "transient" } });
    expect(missing.release).toHaveBeenCalledOnce();

    const unknown = fakePool({ failWith: { code: "23503" } });
    await expect(new PgDropshipListingTierRepository(unknown.pool).recordApplied({ vendorId: 10, revision: 1, applied: true, detail: null, now: NOW }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_TIER_VENDOR_NOT_FOUND" });
  });

  it("refuses stored tiers or revisions it does not recognise", async () => {
    const { pool } = fakePool({ vendors: [
      { vendor_id: 10, status: "active", held_tiers: ["pallet"], revision: 3, applied: true, tiers_on: [], detail: null, evaluated_at: NOW, applied_at: NOW },
    ] });
    await expect(new PgDropshipListingTierRepository(pool).listVendorsForReview({ limit: 10 }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_TIER_INVALID_STORED_VALUE" });
  });
});
