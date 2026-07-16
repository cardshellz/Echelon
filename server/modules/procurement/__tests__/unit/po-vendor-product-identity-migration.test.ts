import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("PO vendor-product identity migration", () => {
  it("fails closed on existing vendor/product mismatches and guards every identity owner", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "migrations/146_po_vendor_product_identity_guard.sql",
      ),
      "utf8",
    );

    expect(migration).toContain(
      "Cannot enforce PO vendor-product identity; invalid links found",
    );
    expect(migration).toContain(
      "purchase_order_lines_vendor_product_identity_guard",
    );
    expect(migration).toContain("purchase_orders_linked_vendor_identity_guard");
    expect(migration).toContain("vendor_products_linked_identity_guard");
    expect(migration).toContain("mapping_vendor_id <> header_vendor_id");
    expect(migration).toContain("mapping_product_id <> NEW.product_id");
    expect(migration).toContain(
      "mapping_variant_id IS DISTINCT FROM receive_variant_id",
    );
    expect(migration).toContain("mapping_active <> 1");
  });
});
