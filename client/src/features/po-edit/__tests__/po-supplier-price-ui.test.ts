import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function page(name: string): string {
  return readFileSync(join(process.cwd(), "client", "src", "pages", name), "utf8");
}

describe("PO supplier-price capture UI", () => {
  const fullEditor = page("PurchaseOrderEdit.tsx");
  const quickCreate = page("PurchaseOrders.tsx");
  const detail = page("PurchaseOrderDetail.tsx");

  it("uses the same explicit line-level supplier-price action on every PO surface", () => {
    for (const source of [fullEditor, quickCreate, detail]) {
      expect(source).toContain("Update supplier price with this quote");
      expect(source).toContain("catalogWrite");
    }
  });

  it("replaces the save-time new-product-only modal with persistent line intent", () => {
    expect(fullEditor).not.toContain("<AddToCatalogDialog");
    expect(fullEditor).not.toContain("catalogOriginallyAbsent");
    expect(fullEditor).toContain("catalogWrite: vendorId ? { mode: \"upsert\" } : undefined");
    expect(fullEditor).toContain("...(l.catalogWrite ? { catalogWrite: l.catalogWrite } : {})");
  });

  it("allows existing PO line edits to update supplier pricing and refresh catalog queries", () => {
    expect(detail).toContain("editSaveToVendorCatalog");
    expect(detail).toContain("setPreferred: editSetAsPreferred");
    expect(detail).toContain("if (command.body.catalogWrite)");
    expect(detail).toContain('queryKey: ["/api/vendor-products"]');
  });

  it("keeps quick-create capture opt-in for existing catalog rows and suggested for new mappings", () => {
    expect(quickCreate).toContain("setInlineSaveToVendorCatalog(false)");
    expect(quickCreate).toContain("setInlineSaveToVendorCatalog(true)");
    expect(quickCreate).toContain('line.pricingSource === "manual"');
    expect(quickCreate).toContain('line.pricing.basis !== "extended_total"');
  });
});
