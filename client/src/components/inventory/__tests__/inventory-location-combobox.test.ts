import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  formatInventoryLocationLabel,
  inventoryLocationSearchValue,
} from "../InventoryLocationCombobox";

describe("InventoryLocationCombobox contract", () => {
  const location = {
    id: 17,
    code: "PICK-A-01",
    name: "Primary pick face",
    zone: "A",
    locationType: "pick",
    warehouseId: 3,
    isActive: 1,
  };

  it("searches every operator-visible inventory-location identity field", () => {
    expect(inventoryLocationSearchValue(location)).toBe(
      "PICK-A-01 Primary pick face A pick 17",
    );
  });

  it("formats a stable selected-location label without inventing warehouse context", () => {
    expect(formatInventoryLocationLabel(location)).toBe("PICK-A-01 — Primary pick face");
    expect(formatInventoryLocationLabel({ ...location, name: null })).toBe("PICK-A-01");
  });

  it("standardizes searchable, accessible, viewport-bounded, scrollable behavior", () => {
    const source = readFileSync(
      "client/src/components/inventory/InventoryLocationCombobox.tsx",
      "utf8",
    );

    expect(source).toContain('role="combobox"');
    expect(source).toContain("<CommandInput");
    expect(source).toContain('className="max-h-64 overflow-y-auto overscroll-contain"');
    expect(source).toContain('collisionPadding={16}');
    expect(source).toContain('max-w-[calc(100vw-2rem)]');
    expect(source).toContain("locations.map((location)");
    expect(source).not.toMatch(/locations\.slice\(/);
  });

  it("keeps clearing opt-in so required workflows cannot silently remove a destination", () => {
    const source = readFileSync(
      "client/src/components/inventory/InventoryLocationCombobox.tsx",
      "utf8",
    );

    expect(source).toContain("allowClear = false");
    expect(source).toContain("allowClear && value !== null");
  });
});
