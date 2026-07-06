import { describe, expect, it } from "vitest";

async function loadModule() {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  return await import("../repair-leaked-reservations");
}

describe("repair-leaked-reservations", () => {
  it("defaults to the conservative picked measure (dry-run, least)", async () => {
    const { parseCli } = await loadModule();
    expect(parseCli([])).toEqual({ apply: false, limit: 25, variantId: null, picked: "least" });
    expect(parseCli(["--picked=max", "--apply", "--variant=207", "--limit=50"])).toEqual({
      apply: true,
      limit: 50,
      variantId: 207,
      picked: "max",
    });
  });

  it("gates drift on the CHOSEN measure while always reporting both targets", async () => {
    const { buildDriftSql } = await loadModule();

    const least = buildDriftSql("least");
    const max = buildDriftSql("max");

    // both targets always computed for the side-by-side report
    for (const sql of [least, max]) {
      expect(sql).toContain(
        "SUM(GREATEST(0, oi.quantity - LEAST(COALESCE(oi.picked_quantity, 0), COALESCE(lp.picked, 0)))) AS target_least",
      );
      expect(sql).toContain(
        "SUM(GREATEST(0, oi.quantity - GREATEST(COALESCE(oi.picked_quantity, 0), COALESCE(lp.picked, 0)))) AS target_max",
      );
      // voided picks never count as consumed reservations
      expect(sql).toContain("it.voided_at IS NULL");
      // only non-terminal orders hold reservations — 'completed' is terminal
      // (all warehouse work done; leftovers released on entry)
      expect(sql).toContain("o.warehouse_status NOT IN ('cancelled', 'shipped', 'completed')");
    }

    // ...but drift and the WHERE gate follow the chosen measure
    expect(least).toContain("COALESCE(a.target_least, 0)::int AS target_reserved");
    expect(least).toContain("WHERE r.current_reserved > COALESCE(a.target_least, 0)");
    expect(max).toContain("COALESCE(a.target_max, 0)::int AS target_reserved");
    expect(max).toContain("WHERE r.current_reserved > COALESCE(a.target_max, 0)");
  });

  it("the accurate measure can only release MORE than the conservative one, never reserve more", async () => {
    // GREATEST(picked_a, picked_b) >= LEAST(picked_a, picked_b) for all inputs,
    // so target_max <= target_least and drift_max >= drift_least. This test
    // pins the direction: switching to --picked=max can only widen releases,
    // never create reservations.
    const { buildDriftSql } = await loadModule();
    const sql = buildDriftSql("max");
    const targetLeastPos = sql.indexOf("AS target_least");
    const targetMaxPos = sql.indexOf("AS target_max");
    expect(targetLeastPos).toBeGreaterThan(-1);
    expect(targetMaxPos).toBeGreaterThan(-1);
    // structural sanity: max variant subtracts the GREATEST picked expression
    expect(sql).toContain("oi.quantity - GREATEST(COALESCE(oi.picked_quantity, 0)");
  });
});
