import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { withoutRetiredVariantFields } from "../../catalog.routes";

describe("retired variant write fields", () => {
  it("drops the retired dropship flag from a variant write and keeps everything else", () => {
    const body = { name: "Pack of 50", sku: "ARM-ENV-SGL-P50", dropshipEligible: true, isActive: true };

    expect(withoutRetiredVariantFields(body)).toEqual({ name: "Pack of 50", sku: "ARM-ENV-SGL-P50", isActive: true });
    // The request body itself is left as it was.
    expect(body.dropshipEligible).toBe(true);
  });

  it("passes a missing or non-object body through unchanged", () => {
    expect(withoutRetiredVariantFields(undefined)).toBeUndefined();
    expect(withoutRetiredVariantFields(null)).toBeNull();
    expect(withoutRetiredVariantFields("text")).toBe("text");
  });

  it("is applied to both the variant create and the variant update writes", () => {
    const source = readFileSync(resolve(process.cwd(), "server/modules/catalog/catalog.routes.ts"), "utf8");

    expect(source.match(/\.\.\.withoutRetiredVariantFields\(req\.body\)/g)).toHaveLength(2);
    expect(source).not.toContain("dropshipEligible: req.body.dropshipEligible");
  });
});
