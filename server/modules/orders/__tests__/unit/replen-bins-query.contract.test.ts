/**
 * The 2026-08-11 route-owned SQL array failure made replen-bin hints empty.
 * The route now delegates exact item identities to the picking source owner;
 * this ratchet prevents another independent SQL source resolver from returning.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("picking replen-bins query contract", () => {
  const source = readFileSync(
    resolve(process.cwd(), "server/modules/orders/picking.routes.ts"),
    "utf8",
  );

  it("delegates bounded item identities to the shared source owner without issuing another source query", () => {
    const start = source.indexOf('app.get("/api/picking/replen-bins"');
    const end = source.indexOf("\n  app.", start + 1);
    const handler = source.slice(start, end);
    expect(handler).toContain(".slice(0, 100)");
    expect(handler).toContain("picking.getDedicatedReplenBins(itemIds)");
    expect(handler).not.toMatch(/db\.execute|SELECT |ANY\(/);
  });
});
