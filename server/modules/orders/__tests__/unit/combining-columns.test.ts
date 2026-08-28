import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "../../combining.service.ts"), "utf8");

/**
 * `GET /api/orders/combinable` returned 500 on every call:
 *
 *   Error fetching combinable orders: error: column o.total_amount does not exist
 *
 * wms.orders stores money in `total_cents`; there is no `total_amount` column.
 * Three queries selected it, including the fallback that only exists to retry
 * after a missing-column error - so the retry re-raised the same 42703 and the
 * route 500'd.
 *
 * The cost was invisible: the Orders page renders the Combine button as
 * `{!combinableError && combinableGroups.length > 0 && ...}`, so a failing
 * endpoint looks exactly like "nothing to combine". Combining had been dead with
 * no symptom other than a log line nobody was reading.
 *
 * Runtime SQL is not type-checked, so these are asserted against the source.
 */
describe("combinable orders SQL column names", () => {
  it("selects the money column that wms.orders actually has", () => {
    // `o.total_amount` inside a SELECT list is the shape that broke it. Reading
    // the aliased field back out in TypeScript is fine, so only SQL lines count -
    // identified by the sibling columns they select alongside it.
    const sqlReferences = SRC.split("\n").filter(
      (line) => /o\.total_amount\b/.test(line) && /o\.source|o\.created_at|SELECT/.test(line),
    );
    expect(sqlReferences).toEqual([]);
    expect(SRC).toMatch(/ROUND\(o\.total_cents::numeric \/ 100, 2\)::text AS total_amount/);
  });

  it("converts cents to a dollar string, since the client parses it as dollars", () => {
    // Orders.tsx renders `$${parseFloat(order.totalAmount).toFixed(2)}` - handing
    // it raw cents would overstate every order by 100x.
    const conversions = SRC.match(/ROUND\(o\.total_cents::numeric \/ 100, 2\)::text/g) ?? [];
    expect(conversions.length).toBe(3);
  });

  it("still maps the aliased column onto the response", () => {
    expect(SRC).toMatch(/totalAmount: o\.total_amount,/);
  });

  it("reports the real error when falling back after a missing column", () => {
    // The old log named combined_group_id as the cause for ANY 42703, which is
    // what disguised this one.
    expect(SRC).not.toMatch(/combined_group_id column not yet in database/);
    expect(SRC).toMatch(/columnError\?\.message/);
  });
});
