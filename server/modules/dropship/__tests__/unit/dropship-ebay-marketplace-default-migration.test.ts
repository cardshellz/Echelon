import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "migrations/216_dropship_ebay_marketplace_default.sql"),
  "utf8",
);

describe("dropship eBay marketplace default migration", () => {
  it("adds the US marketplace only to eBay configs where that key is absent", () => {
    expect(sql).toContain("jsonb_build_object('marketplaceId', 'EBAY_US')");
    expect(sql).toContain("WHERE platform = 'ebay'");
    expect(sql).toContain("NOT (COALESCE(marketplace_config, '{}'::jsonb) ? 'marketplaceId')");
  });

  it("does not replace the complete marketplace config object", () => {
    expect(sql).toContain("COALESCE(marketplace_config, '{}'::jsonb)");
    expect(sql).toContain("|| jsonb_build_object");
    expect(sql).not.toMatch(/SET\s+marketplace_config\s*=\s*jsonb_build_object/i);
  });
});
