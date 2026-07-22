import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(resolve(process.cwd(), "client/src/pages/DemandPlanner.tsx"), "utf8");

describe("demand planner UI contract", () => {
  it("selects catalog products by name or SKU instead of raw IDs", () => {
    expect(page).toContain("/api/catalog/products/search");
    expect(page).toContain("Search product name or SKU");
    expect(page).not.toContain("placeholder=\"Product ID\"");
  });

  it("edits the complete event with optimistic concurrency evidence", () => {
    expect(page).toContain('method: event ? "PUT" : "POST"');
    expect(page).toContain("expectedUpdatedAt: event.updatedAt");
  });

  it("uses camelCase API fields consistently", () => {
    expect(page).not.toMatch(/\bevent_type\b|\bstart_date\b|\bexpected_pieces\b/);
    expect(page).toContain("weightedExpectedPieces");
  });
});
