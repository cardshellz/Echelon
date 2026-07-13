import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readNormalizedSource(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const storageSource = readNormalizedSource(
  resolve(__dirname, "../../procurement.storage.ts"),
);
const handoffRepositorySource = readNormalizedSource(
  resolve(__dirname, "../../recommendation-po-handoff.repository.ts"),
);

describe("supplier quote recommendation query", () => {
  it("selects immutable quote metadata and DB analysis time", () => {
    expect(storageSource).toContain("preferred_vendor.quote_reference AS vendor_quote_reference");
    expect(storageSource).toContain("preferred_vendor.quoted_at AS vendor_quoted_at");
    expect(storageSource).toContain("preferred_vendor.quoted_at_date AS vendor_quoted_at_date");
    expect(storageSource).toContain("preferred_vendor.quote_valid_until AS vendor_quote_valid_until");
    expect(storageSource).toContain("preferred_vendor.moq AS vendor_moq");
    expect(storageSource).toContain("transaction_timestamp() AS recommendation_analysis_as_of");
    expect(storageSource).toContain("current_date::text AS recommendation_analysis_date");
  });

  it("only binds active vendors and receive-compatible preferred catalog rows", () => {
    expect(storageSource).toMatch(/AND v\.active = 1/);
    expect(storageSource).toMatch(
      /vp\.product_variant_id = order_uom\.variant_id\s+OR vp\.product_variant_id IS NULL/,
    );
    expect(storageSource).toMatch(/ORDER BY\s+CASE\s+WHEN vp\.product_variant_id = order_uom\.variant_id THEN 0/);
  });

  it("locks the live supplier MOQ alongside quote metadata for PO handoff", () => {
    expect(handoffRepositorySource).toContain("moq: vendorProducts.moq");
    expect(handoffRepositorySource).toContain('.for("share")');
  });

  it("locks handoff reference rows in deterministic primary-key order", () => {
    expect(handoffRepositorySource).toContain(".orderBy(vendorProducts.id)\n        .for(\"share\")");
    expect(handoffRepositorySource).toContain(".orderBy(vendors.id)\n        .for(\"share\")");
    expect(handoffRepositorySource).toContain(".orderBy(products.id)\n        .for(\"share\")");
    expect(handoffRepositorySource).toContain(".orderBy(productVariants.id)\n        .for(\"share\")");
  });
});
