import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("allocation engine inventory strategy contract", () => {
  const source = readFileSync(
    resolve(process.cwd(), "server/modules/channels/allocation-engine.service.ts"),
    "utf8",
  );

  it("calculates channel ATP independently for each variant", () => {
    expect(source).toContain("channelBaseAtpByVariant");
    expect(source).toContain("warehouseRawAtpByVariant");
    expect(source).toContain("warehouseAtpByVariant.get(variant.productVariantId)");
    expect(source).toContain("channelBaseAtpByVariant.get(variant.productVariantId)");
  });

  it("does not use one product-level warehouse value for every variant", () => {
    const allocationLoop = source.slice(
      source.indexOf("const channelBaseAtpByVariant"),
      source.indexOf("// Get channel's rules"),
    );
    expect(allocationLoop).toContain("getAtpPerVariantByWarehouse");
    expect(allocationLoop).not.toContain("getAtpBaseByWarehouse");
    expect(allocationLoop).not.toContain("whVariants[0]");
  });
});
