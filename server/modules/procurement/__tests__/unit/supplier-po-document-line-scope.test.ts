import { describe, expect, it } from "vitest";
import type { PurchaseOrderLine } from "@shared/schema/procurement.schema";
import { buildSupplierPoDocument } from "../../supplier-po-document";
import { renderPoHtml } from "../../po-document";
import { supplierDocumentSource } from "../fixtures/supplier-po-document.fixture";

type FixtureLine = Pick<PurchaseOrderLine, keyof ReturnType<typeof supplierDocumentSource>["lines"][number]>;

function sourceWithTargetedDiscount() {
  const source = supplierDocumentSource();
  const product: FixtureLine = { ...source.lines[0], lineNumber: 7 };
  const discount: FixtureLine = {
    ...product, id: 12, lineNumber: 8, lineType: "discount", parentLineId: product.id,
    productId: null, productVariantId: null, sku: null, vendorSku: null, productName: null,
    description: "Agreed discount on the goods", unitCostCents: -100, unitCostMills: -10000,
    totalProductCostCents: -100, packagingCostCents: 0, discountCents: 0, taxCents: 0, lineTotalCents: -100,
    pricingBasis: "not_applicable", quotedUnitCostMills: null,
  };
  return { ...source, po: { ...source.po, subtotalCents: 12245, totalCents: 12245 }, lines: [product, discount] };
}

function expectInvalid(source: unknown) {
  expect(() => buildSupplierPoDocument(source)).toThrowError(
    expect.objectContaining({ code: "INVALID_SUPPLIER_DOCUMENT_SOURCE", statusCode: 409 }),
  );
}

describe("supplier PO commercial line scope", () => {
  it("preserves a targeted discount's active product line number in the DTO and HTML", () => {
    const source = sourceWithTargetedDiscount();
    const before = structuredClone(source);
    const document = buildSupplierPoDocument(source);
    expect(document.lines[0].appliesToLineNumber).toBeNull();
    expect(document.lines[1].appliesToLineNumber).toBe(7);
    expect(renderPoHtml(document)).toContain("Applies to line 7");
    expect(document.totals.totalCents).toBe(12245);
    expect(source).toEqual(before);
  });

  it("retains closed product rows as valid commercial targets", () => {
    const source = sourceWithTargetedDiscount();
    source.lines[0].status = "closed";
    expect(buildSupplierPoDocument(source).lines[1].appliesToLineNumber).toBe(7);
  });

  it("leaves an untargeted charge at document scope", () => {
    const source = sourceWithTargetedDiscount();
    source.lines[1].parentLineId = null;
    const document = buildSupplierPoDocument(source);
    expect(document.lines[1].appliesToLineNumber).toBeNull();
    expect(renderPoHtml(document)).not.toContain("Applies to line");
  });

  it("rejects a missing parent instead of silently dropping the target", () => {
    const source = sourceWithTargetedDiscount();
    source.lines[1].parentLineId = 999;
    expectInvalid(source);
  });

  it("does not retarget a cancelled parent to its replacement with the same line number", () => {
    const source = sourceWithTargetedDiscount();
    const replacement = { ...source.lines[0], id: 13 };
    source.lines[0].status = "cancelled";
    source.lines.push(replacement);
    expectInvalid(source);
  });

  it("rejects a target from another purchase order", () => {
    const source = sourceWithTargetedDiscount();
    source.lines[0].purchaseOrderId = 2;
    expectInvalid(source);
  });

  it("rejects non-product parents and adjustment chains", () => {
    const source = sourceWithTargetedDiscount();
    source.lines.push({ ...source.lines[1], id: 13, lineNumber: 9, parentLineId: null });
    source.lines[1].parentLineId = 13;
    expectInvalid(source);
  });

  it("rejects self-targeting charges", () => {
    const source = sourceWithTargetedDiscount();
    source.lines[1].parentLineId = source.lines[1].id;
    expectInvalid(source);
  });

  it("rejects a parent on a product line", () => {
    const source = sourceWithTargetedDiscount();
    source.lines[0].parentLineId = source.lines[1].id;
    expectInvalid(source);
  });
});
