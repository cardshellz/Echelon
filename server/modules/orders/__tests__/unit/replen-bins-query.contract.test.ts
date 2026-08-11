/**
 * Contract test for the /api/picking/replen-bins pick-location query.
 *
 * Regression guard for the 2026-08-11 production failure: interpolating a JS
 * array directly into a drizzle sql template (`= ANY(${itemIds})`) renders a
 * parenthesized parameter tuple — `ANY(($1, $2, ...))` — which Postgres
 * rejects with "op ANY/ALL (array) requires array on right side" (42809).
 * The endpoint degraded to `{}` on every call, so pickers silently never saw
 * replen-bin labels. The query must build a real array:
 * `ANY(ARRAY[...]::integer[])` via sql.join.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("picking replen-bins query contract", () => {
  const source = readFileSync(
    resolve(process.cwd(), "server/modules/orders/picking.routes.ts"),
    "utf8",
  );

  it("passes item ids as a Postgres array, not a parameter tuple", () => {
    expect(source).toContain(
      "WHERE oi.id = ANY(ARRAY[${sql.join(itemIds, sql`, `)}]::integer[])",
    );
    // The broken form: a raw JS-array interpolation renders ANY(($1, $2, ...)).
    expect(source).not.toMatch(/=\s*ANY\(\$\{itemIds\}\)/);
  });
});
