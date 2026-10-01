import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RECEIVE_AS_INACTIVE_ERROR,
  RECEIVE_AS_REQUIRED_ERROR,
  productLineReceiveConfigurationError,
  receiveAsBreakdown,
  receiveConfigurationLinePatch,
  receiveConfigurationOptionLabel,
  receiveConfigurationOptions,
  receiveConfigurationOptionsState,
  type ReceiveConfigurationOption,
} from "../../../pages/PurchaseOrderEdit";

// The shape GET /api/products/:id returns for ESS-TOP-STD-SLV-CLR, the SKU
// whose PO could not be saved because the editor offered no receive choice.
const essentialsVariants = [
  {
    id: 12,
    productId: 6,
    sku: "ESS-TOP-STD-SLV-CLR-C1000",
    name: "Case of 1000 (10 packs of 100)",
    unitsPerVariant: 1000,
    hierarchyLevel: 3,
    isActive: true,
  },
  {
    id: 11,
    productId: 6,
    sku: "ESS-TOP-STD-SLV-CLR-P100",
    name: "Pack of 100",
    unitsPerVariant: 100,
    hierarchyLevel: 1,
    isActive: true,
  },
];

const pack: ReceiveConfigurationOption = {
  variantId: 11,
  sku: "ESS-TOP-STD-SLV-CLR-P100",
  name: "Pack of 100",
  unitsPerVariant: 100,
};
const caseOf1000: ReceiveConfigurationOption = {
  variantId: 12,
  sku: "ESS-TOP-STD-SLV-CLR-C1000",
  name: "Case of 1000 (10 packs of 100)",
  unitsPerVariant: 1000,
};

const line = (expectedReceiveVariantId: number | null) => ({
  expectedReceiveVariantId,
  sku: "ESS-TOP-STD-SLV-CLR",
  productName: "35PT 3x4 Toploader Essentials Clear",
});

describe("Receive As dropdown options", () => {
  it("offers every active variant of the SKU, smallest package first", () => {
    expect(receiveConfigurationOptions(essentialsVariants)).toEqual([pack, caseOf1000]);
  });

  it("never offers archived variants", () => {
    expect(receiveConfigurationOptions([
      { ...essentialsVariants[0], isActive: false },
      essentialsVariants[1],
    ])).toEqual([pack]);
  });

  it("treats a variant without an explicit active flag as not offerable", () => {
    const { isActive: _ignored, ...withoutFlag } = essentialsVariants[1];
    expect(receiveConfigurationOptions([withoutFlag])).toEqual([]);
  });

  it("drops rows without a usable id or units", () => {
    const base = essentialsVariants[1];
    expect(receiveConfigurationOptions([
      { ...base, id: 0 },
      { ...base, id: "abc" },
      { ...base, id: true },
      { ...base, unitsPerVariant: 0 },
      { ...base, unitsPerVariant: null },
      { ...base, unitsPerVariant: 1.5 },
      null,
      "variant",
    ])).toEqual([]);
  });

  it("returns no options for a missing or malformed payload", () => {
    expect(receiveConfigurationOptions(undefined)).toEqual([]);
    expect(receiveConfigurationOptions({ variants: essentialsVariants })).toEqual([]);
  });

  it("does not mutate the API payload", () => {
    const payload = structuredClone(essentialsVariants);
    receiveConfigurationOptions(payload);
    expect(payload).toEqual(essentialsVariants);
  });

  it("labels each option with its name, SKU, and pieces", () => {
    expect(receiveConfigurationOptionLabel(pack))
      .toBe("Pack of 100 (ESS-TOP-STD-SLV-CLR-P100) · 100 pcs");
    expect(receiveConfigurationOptionLabel(caseOf1000))
      .toBe("Case of 1000 (10 packs of 100) (ESS-TOP-STD-SLV-CLR-C1000) · 1,000 pcs");
    expect(receiveConfigurationOptionLabel({ ...pack, name: null }))
      .toBe("ESS-TOP-STD-SLV-CLR-P100 · 100 pcs");
    expect(receiveConfigurationOptionLabel({ ...pack, unitsPerVariant: 1 }))
      .toBe("Pack of 100 (ESS-TOP-STD-SLV-CLR-P100) · 1 pc");
  });
});

describe("Receive As line patch", () => {
  it("carries the variant's own units so the server's units check passes", () => {
    expect(receiveConfigurationLinePatch(caseOf1000)).toEqual({
      expectedReceiveVariantId: 12,
      expectedReceiveUnitsPerVariant: 1000,
    });
  });
});

describe("Receive As validation", () => {
  const ready = { status: "ready" as const, options: [pack, caseOf1000] };

  it("blocks a line with no choice", () => {
    expect(productLineReceiveConfigurationError(line(null), ready)).toBe(RECEIVE_AS_REQUIRED_ERROR);
    expect(productLineReceiveConfigurationError(line(0), ready)).toBe(RECEIVE_AS_REQUIRED_ERROR);
  });

  it("blocks a line with no choice while variants are still loading", () => {
    expect(productLineReceiveConfigurationError(line(null), { status: "loading" }))
      .toBe(RECEIVE_AS_REQUIRED_ERROR);
    expect(productLineReceiveConfigurationError(line(null), undefined))
      .toBe(RECEIVE_AS_REQUIRED_ERROR);
  });

  it("requires a choice even when the SKU has a single variant", () => {
    expect(productLineReceiveConfigurationError(
      line(null),
      { status: "ready", options: [caseOf1000] },
    )).toBe(RECEIVE_AS_REQUIRED_ERROR);
  });

  it("accepts a chosen active variant", () => {
    expect(productLineReceiveConfigurationError(line(12), ready)).toBeNull();
    expect(productLineReceiveConfigurationError(line(11), ready)).toBeNull();
  });

  it("leaves a saved choice to the server while variants load or fail", () => {
    expect(productLineReceiveConfigurationError(line(12), { status: "loading" })).toBeNull();
    expect(productLineReceiveConfigurationError(line(12), { status: "error" })).toBeNull();
  });

  it("rejects a choice that is not an active variant of the SKU", () => {
    // 14 is the archived case variant of the retired SHLZ-TOP-35PT-ESS SKU.
    expect(productLineReceiveConfigurationError(line(14), ready)).toBe(RECEIVE_AS_INACTIVE_ERROR);
  });

  it("names the SKU when it has no active variant to receive into", () => {
    expect(productLineReceiveConfigurationError(
      { expectedReceiveVariantId: null, sku: "SHLZ-TOP-35PT-ESS", productName: "Old" },
      { status: "ready", options: [] },
    )).toBe(
      "SHLZ-TOP-35PT-ESS has no active variant to receive into; add or reactivate one on the product",
    );
  });
});

describe("Receive As query state", () => {
  it("is loading before the product arrives", () => {
    expect(receiveConfigurationOptionsState({ isError: false })).toEqual({ status: "loading" });
  });

  it("is an error when the product cannot be loaded", () => {
    expect(receiveConfigurationOptionsState({ isError: true })).toEqual({ status: "error" });
  });

  it("keeps the last good variants when a background refetch fails", () => {
    expect(receiveConfigurationOptionsState({
      isError: true,
      data: { variants: essentialsVariants },
    })).toEqual({ status: "ready", options: [pack, caseOf1000] });
  });
});

describe("Receive As breakdown", () => {
  it("shows whole packages", () => {
    expect(receiveAsBreakdown(525_000, 1000)).toBe("525 x 1,000 pcs");
  });

  it("shows loose pieces instead of rounding up", () => {
    expect(receiveAsBreakdown(1_050, 1000)).toBe("1 x 1,000 pcs + 50 loose");
    expect(receiveAsBreakdown(40, 100)).toBe("40 loose");
  });

  it("has nothing to add for single pieces or an empty quantity", () => {
    expect(receiveAsBreakdown(525_000, 1)).toBeNull();
    expect(receiveAsBreakdown(0, 1000)).toBeNull();
  });
});

describe("PO editor Receive As wiring", () => {
  const editor = readFileSync(
    join(process.cwd(), "client", "src", "pages", "PurchaseOrderEdit.tsx"),
    "utf8",
  );

  it("renders a Receive As dropdown on every product line", () => {
    expect(editor).toContain("data-testid={`select-receive-as-${idx}`}");
    expect(editor).toContain("onChange(receiveConfigurationLinePatch(option))");
  });

  it("loads the dropdown from the product's variants", () => {
    expect(editor).toContain("fetch(`/api/products/${productId}`)");
  });

  it("checks Receive As in both the inline errors and the save validator", () => {
    const uses = editor.match(/productLineReceiveConfigurationError\(\s*l,/g) ?? [];
    expect(uses).toHaveLength(2);
  });
});
