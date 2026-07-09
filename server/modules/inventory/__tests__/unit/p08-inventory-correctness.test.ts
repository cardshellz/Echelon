import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** P0.8 — inventory correctness cluster pins (audit F8a-F8f). */
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("P0.8 — inventory correctness cluster", () => {
  it("break/assembly adjustments run inside the caller's transaction", () => {
    const src = read("../../application/break-assembly.use-cases.ts");
    const threaded = src.match(/withTx\(tx\)\.adjustInventory\(/g) ?? [];
    expect(threaded.length).toBe(4);
    expect(src).not.toMatch(/this\.inventoryUseCases\.adjustInventory\(/);
  });

  it("nothing forces negative on-hand (CLAUDE.md §16)", () => {
    const src = read("../../application/inventory.use-cases.ts");
    expect(src).not.toContain("allowNegative: true");
  });

  it("per-warehouse ATP subtracts picked+packed like its siblings", () => {
    const src = read("../../atp.service.ts");
    expect(src).toContain("return onHand - reserved - picked - packed;");
    expect(src).not.toMatch(/return onHand - reserved;\s*\n/);
  });

  it("every lot recost writes mills and cents together", () => {
    const src = read("../../cogs.service.ts");
    // landed-cost, invoice-variance, manual-lot, sku-backfill
    const millsWrites = src.match(/unit_cost_mills = \$\{centsToMills\(/g) ?? [];
    expect(millsWrites.length).toBeGreaterThanOrEqual(4);
    // no recost UPDATE sets total cents without total mills
    const totalCents = src.match(/total_unit_cost_cents = \$\{/g) ?? [];
    const totalMills = src.match(/total_unit_cost_mills = \$\{/g) ?? [];
    expect(totalMills.length).toBeGreaterThanOrEqual(totalCents.length);
  });
});
