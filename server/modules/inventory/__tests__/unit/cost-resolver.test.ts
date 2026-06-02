import { describe, expect, it, vi } from "vitest";
import { resolveCost, resolveReturnCost } from "../../cost-resolver";

function mockDb(variantRow?: any, cogsRows?: any[]) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(variantRow ? [variantRow] : []),
  };
  return {
    select: vi.fn(() => selectChain),
    execute: vi.fn(async () => ({ rows: cogsRows ?? [] })),
  } as any;
}

describe("resolveCost", () => {
  it("returns explicit hint when provided", async () => {
    const db = mockDb();
    const result = await resolveCost(db, 1, 500);
    expect(result).toEqual({ costCents: 500, source: "explicit", provisional: false });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("ignores zero/null/undefined hints and falls through", async () => {
    const db = mockDb({ lastCostCents: 300, standardCostCents: null, avgCostCents: null });
    expect(await resolveCost(db, 1, 0)).toMatchObject({ costCents: 300, source: "last_paid" });
    expect(await resolveCost(db, 1, null)).toMatchObject({ costCents: 300, source: "last_paid" });
    expect(await resolveCost(db, 1, undefined)).toMatchObject({ costCents: 300, source: "last_paid" });
  });

  it("falls through to last_paid", async () => {
    const db = mockDb({ lastCostCents: 250, standardCostCents: 200, avgCostCents: 180 });
    const result = await resolveCost(db, 1);
    expect(result).toEqual({ costCents: 250, source: "last_paid", provisional: true });
  });

  it("falls through to standard when last_paid is zero", async () => {
    const db = mockDb({ lastCostCents: 0, standardCostCents: 200, avgCostCents: 180 });
    const result = await resolveCost(db, 1);
    expect(result).toEqual({ costCents: 200, source: "standard", provisional: true });
  });

  it("falls through to avg when standard is also zero", async () => {
    const db = mockDb({ lastCostCents: 0, standardCostCents: 0, avgCostCents: 180 });
    const result = await resolveCost(db, 1);
    expect(result).toEqual({ costCents: 180, source: "avg", provisional: true });
  });

  it("returns unresolved when all sources are zero", async () => {
    const db = mockDb({ lastCostCents: 0, standardCostCents: 0, avgCostCents: 0 });
    const result = await resolveCost(db, 1);
    expect(result).toEqual({ costCents: 0, source: "unresolved", provisional: true });
  });

  it("returns unresolved when variant not found", async () => {
    const db = mockDb(null);
    const result = await resolveCost(db, 999);
    expect(result).toEqual({ costCents: 0, source: "unresolved", provisional: true });
  });
});

describe("resolveReturnCost", () => {
  it("returns order COGS cost when found", async () => {
    const db = mockDb(
      { lastCostCents: 100, standardCostCents: 0, avgCostCents: 0 },
      [{ unit_cost_cents: 350 }],
    );
    const result = await resolveReturnCost(db, 1, 42);
    expect(result).toEqual({ costCents: 350, source: "order_cogs", provisional: false });
  });

  it("falls back to standard waterfall when no COGS rows", async () => {
    const db = mockDb(
      { lastCostCents: 100, standardCostCents: 0, avgCostCents: 0 },
      [],
    );
    const result = await resolveReturnCost(db, 1, 42);
    expect(result).toEqual({ costCents: 100, source: "last_paid", provisional: true });
  });

  it("falls back when COGS row has zero cost", async () => {
    const db = mockDb(
      { lastCostCents: 0, standardCostCents: 200, avgCostCents: 0 },
      [{ unit_cost_cents: 0 }],
    );
    const result = await resolveReturnCost(db, 1, 42);
    expect(result).toEqual({ costCents: 200, source: "standard", provisional: true });
  });
});
