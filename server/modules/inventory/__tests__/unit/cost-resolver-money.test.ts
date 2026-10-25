import { describe, expect, it, vi } from "vitest";
import { resolveCost } from "../../cost-resolver";

function database(variant: unknown) {
  const db: any = { select: vi.fn(() => db), from: () => db, where: () => db,
    limit: vi.fn(async () => variant == null ? [] : [variant]), execute: vi.fn() };
  return db;
}

describe("catalog estimate money boundaries", () => {
  it("keeps nullable estimate tiers unavailable and falls through to the next recorded cost", async () => {
    await expect(resolveCost(database({ lastCostCents: null, standardCostCents: "23", avgCostCents: null }), 1, 0))
      .resolves.toEqual({ costCents: 23, source: "standard", provisional: true });
    await expect(resolveCost(database({ lastCostCents: null, standardCostCents: null, avgCostCents: null }), 1))
      .resolves.toEqual({ costCents: 0, source: "unresolved", provisional: true });
  });
  it.each(["23junk", "2.3", "9007199254740992"])("rejects malformed recorded cents %s without trying a lower estimate", async value => {
    await expect(resolveCost(database({ lastCostCents: value, standardCostCents: 23 }), 1))
      .rejects.toMatchObject({ name: "MoneyInputError" });
  });
  it("validates explicit costs before reading estimates", async () => {
    const db = database(null);
    await expect(resolveCost(db, 1, Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({ code: "MONEY_INPUT_OVERFLOW" });
    expect(db.select).not.toHaveBeenCalled();
    await expect(resolveCost(db, 1, 23)).resolves.toEqual({ costCents: 23, source: "explicit", provisional: false });
  });
});
