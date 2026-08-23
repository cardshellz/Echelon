import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Receiving inventory-location selector contract", () => {
  const source = readFileSync("client/src/pages/Receiving.tsx", "utf8");

  it("routes every interactive inventory-location choice through the shared selector", () => {
    expect(source.match(/<InventoryLocationCombobox/g)).toHaveLength(3);
    expect(source).not.toContain("resolveLocSearch");
    expect(source).not.toContain("handleLocationSearch");
    expect(source).not.toContain("locationResults");
  });

  it("does not truncate inventory-location choices", () => {
    expect(source).not.toMatch(/filterActionableWarehouseLocations[\s\S]{0,200}\.slice\(/);
    expect(source).not.toContain(".slice(0, 15)");
  });
});
