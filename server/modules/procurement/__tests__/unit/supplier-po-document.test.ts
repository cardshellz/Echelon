import { describe, expect, it } from "vitest";
import { buildSupplierPoDocument } from "../../supplier-po-document";
import { renderPoHtml } from "../../po-document";
import { supplierDocumentSource } from "../fixtures/supplier-po-document.fixture";

describe("supplier PO output contract", () => {
  it("projects actual canonical field names and keeps private fields outside the DTO and HTML", () => {
    const source = supplierDocumentSource();
    const before = structuredClone(source);
    const document = buildSupplierPoDocument(source);
    expect(document.totals.totalCents).toBe(12345);
    expect(document.purpose).toBe("draft_preview");
    expect(document.lines[0].productName).toBe("Recorded product name");
    for (const output of [JSON.stringify(document), renderPoHtml(document)]) {
      expect(output).not.toMatch(/PRIVATE_|internalNotes|PRIVATE_LINE_NEGOTIATION/);
      expect(output).toContain("Please confirm delivery.");
    }
    expect(renderPoHtml(document)).toContain("$123.45");
    expect(source).toEqual(before);
  });

  it("removes cancelled historical lines but retains received and closed commercial rows", () => {
    const source = supplierDocumentSource();
    source.po.status = "received";
    source.lines[0].status = "received";
    source.lines.push({ ...source.lines[0], id: 12, lineNumber: 2, sku: "CANCELLED-REMOVED-SKU", status: "cancelled", cancelledQty: 1 });
    let document = buildSupplierPoDocument(source);
    expect(document.lines.map(line => line.id)).toEqual([11]);
    expect(renderPoHtml(document)).not.toContain("CANCELLED-REMOVED-SKU");
    expect(document.purpose).toBe("current_copy");
    source.lines[0].status = "closed";
    document = buildSupplierPoDocument(source);
    expect(document.lines.map(line => line.id)).toEqual([11]);
  });

  it.each([undefined, null, 12345.5, Number.MAX_SAFE_INTEGER + 1])("rejects missing or unsafe canonical total %s rather than formatting zero", (totalCents) => {
    const source = supplierDocumentSource();
    expect(() => buildSupplierPoDocument({ ...source, po: { ...source.po, totalCents } }))
      .toThrow(expect.objectContaining({ code: "INVALID_SUPPLIER_DOCUMENT_SOURCE" }));
  });

  it("rejects source total disagreement without repairing stored economics", () => {
    const source = supplierDocumentSource();
    source.po.totalCents = 12346;
    expect(() => buildSupplierPoDocument(source)).toThrow(expect.objectContaining({ code: "SUPPLIER_DOCUMENT_TOTAL_MISMATCH" }));
    expect(source.po.totalCents).toBe(12346);
  });

  it("accepts an explicit free product instead of treating zero as absent", () => {
    const source = supplierDocumentSource();
    source.po.subtotalCents = source.po.totalCents = 0;
    Object.assign(source.lines[0], { unitCostCents: 0, unitCostMills: 0, totalProductCostCents: 0, lineTotalCents: 0, quotedUnitCostMills: 0 });
    expect(buildSupplierPoDocument(source).totals.totalCents).toBe(0);
  });

  it("keeps supplier purchase UOM and exact quote distinct from the receive package", () => {
    const source = supplierDocumentSource();
    source.po.subtotalCents = source.po.totalCents = 2469;
    Object.assign(source.lines[0], { orderQty: 100, expectedReceiveUnitsPerVariant: 20,
      pricingBasis: "per_purchase_uom", purchaseUom: "Carton", purchaseUomQuantity: 2,
      piecesPerPurchaseUom: 50, quotedUnitCostMills: 123450, unitCostMills: 2469,
      unitCostCents: 25, totalProductCostCents: 2469, lineTotalCents: 2469 });
    const document = buildSupplierPoDocument(source);
    expect(document.lines[0]).toMatchObject({ quantityPieces: 100, pricing: {
      basis: "per_purchase_uom", quantity: 2, unitLabel: "Carton", unitCostMills: 123450, piecesPerPurchaseUom: 50,
    } });
    expect(renderPoHtml(document)).not.toContain("RECV/20");
  });

  it("escapes supplier-controlled text and does not let caller purpose fabricate an original issue", () => {
    const source = supplierDocumentSource();
    source.po.vendorNotes = '<script>window.SUPPLIER_ATTACK=1</script>';
    source.lines[0].productName = '<img src=x onerror="window.SUPPLIER_ATTACK=1">';
    const document = buildSupplierPoDocument({ ...source, purpose: "original_issue" });
    expect(document.purpose).toBe("draft_preview");
    const html = renderPoHtml(document);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("changes source identity when current commercial terms change", () => {
    const source = supplierDocumentSource();
    const first = buildSupplierPoDocument(source);
    source.po.vendorNotes = "Different delivery requirement";
    const next = buildSupplierPoDocument(source);
    expect(next.sourceRevision).not.toBe(first.sourceRevision);
    expect(buildSupplierPoDocument(source).sourceRevision).toBe(next.sourceRevision);
  });

  it("excludes private notes and cancelled-row economics from the external content identity", () => {
    const source = supplierDocumentSource();
    source.lines.push({ ...source.lines[0], id: 12, status: "cancelled" });
    const first = buildSupplierPoDocument(source);
    source.po.internalNotes = "REVISED_PRIVATE_NOTE";
    source.lines[1].lineTotalCents = 999999;
    source.lines[1].notes = "OTHER_PRIVATE_NEGOTIATION";
    expect(buildSupplierPoDocument(source).sourceRevision).toBe(first.sourceRevision);
  });

  it.each(["subtotalCents", "discountCents", "taxCents", "shippingCostCents"]) ("requires explicit canonical header %s", (field) => {
    const source = supplierDocumentSource();
    expect(() => buildSupplierPoDocument({ ...source, po: { ...source.po, [field]: undefined } }))
      .toThrow(expect.objectContaining({ code: "INVALID_SUPPLIER_DOCUMENT_SOURCE" }));
  });

  it.each(["totalProductCostCents", "packagingCostCents", "discountCents", "taxCents", "lineTotalCents"])
  ("requires explicit canonical line %s", (field) => {
    const source = supplierDocumentSource();
    expect(() => buildSupplierPoDocument({ ...source, lines: [{ ...source.lines[0], [field]: undefined }] }))
      .toThrow(expect.objectContaining({ code: "INVALID_SUPPLIER_DOCUMENT_SOURCE" }));
  });

  it("rejects a foreign PO line, duplicate active identity, and mismatched supplier", () => {
    const source = supplierDocumentSource();
    for (const bad of [
      { ...source, lines: [{ ...source.lines[0], purchaseOrderId: 999 }] },
      { ...source, lines: [source.lines[0], { ...source.lines[0], id: 12 }] },
      { ...source, vendor: { ...source.vendor, id: 999 } },
      { ...source, po: { ...source.po, currency: "CAD" } },
    ]) expect(() => buildSupplierPoDocument(bad)).toThrow(expect.objectContaining({ code: "INVALID_SUPPLIER_DOCUMENT_SOURCE" }));
  });

  it("reconciles line components and header adjustments without treating shippingCostCents as shippingCents", () => {
    const source = supplierDocumentSource();
    Object.assign(source.lines[0], { packagingCostCents: 100, discountCents: 5, taxCents: 10, lineTotalCents: 12450 });
    Object.assign(source.po, { subtotalCents: 12450, discountCents: 50, taxCents: 25, shippingCostCents: 200, totalCents: 12625 });
    const document = buildSupplierPoDocument(source);
    expect(document.lines[0]).toMatchObject({ productAmountCents: 12345, packagingCents: 100, discountCents: 5, taxCents: 10, totalCents: 12450 });
    expect(document.totals).toEqual({ subtotalCents: 12450, discountCents: 50, taxCents: 25, shippingCents: 200, totalCents: 12625 });
  });

  it("does not turn a legacy rounded unit value into an invented authoritative quote", () => {
    const source = supplierDocumentSource();
    Object.assign(source.po, { subtotalCents: 100, totalCents: 100 });
    Object.assign(source.lines[0], { orderQty: 3, pricingBasis: "legacy_unknown", unitCostMills: null,
      unitCostCents: 33, quotedUnitCostMills: null, totalProductCostCents: 100, lineTotalCents: 100 });
    const document = buildSupplierPoDocument(source);
    expect(document.lines[0].pricing).toMatchObject({ basis: "legacy_unknown", unitCostMills: null });
    expect(document.totals.totalCents).toBe(100);
  });

  it.each(["status", "physicalStatus"])("rejects cancellation recorded in %s instead of fabricating an issued record", (field) => {
    const source = supplierDocumentSource();
    expect(() => buildSupplierPoDocument({ ...source, po: { ...source.po, [field]: "cancelled" } }))
      .toThrow(expect.objectContaining({ code: "PURCHASE_ORDER_DOCUMENT_CANCELLED", statusCode: 409 }));
  });

  it.each([
    { quotedUnitCostMills: 1234499 }, { unitCostMills: 1234499 }, { unitCostCents: 12344 },
    { pricingRemainderMills: 1 }, { quotedTotalCents: 12345 }, { purchaseUom: "Carton" },
  ])("rejects inconsistent saved per-piece pricing %j", (fields) => {
    const source = supplierDocumentSource();
    expect(() => buildSupplierPoDocument({ ...source, lines: [{ ...source.lines[0], ...fields }] }))
      .toThrow(expect.objectContaining({ code: "INVALID_SUPPLIER_DOCUMENT_SOURCE" }));
  });

  it("rejects inconsistent purchase UOM conversion and aggregate safe-integer overflow", () => {
    const source = supplierDocumentSource();
    const quoted = { ...source.lines[0], pricingBasis: "per_purchase_uom", purchaseUom: "Carton",
      purchaseUomQuantity: 2, piecesPerPurchaseUom: 50, orderQty: 99, quotedUnitCostMills: 123450 };
    expect(() => buildSupplierPoDocument({ ...source, lines: [quoted] }))
      .toThrow(expect.objectContaining({ code: "INVALID_SUPPLIER_DOCUMENT_SOURCE" }));
    const large = { ...source.lines[0], pricingBasis: "legacy_unknown", quotedUnitCostMills: null,
      unitCostMills: null, totalProductCostCents: Number.MAX_SAFE_INTEGER, lineTotalCents: Number.MAX_SAFE_INTEGER };
    expect(() => buildSupplierPoDocument({ ...source, lines: [large, { ...large, id: 12, lineNumber: 2 }] }))
      .toThrow(expect.objectContaining({ code: "SUPPLIER_DOCUMENT_TOTAL_MISMATCH" }));
  });

  it.each(["2026-02-30T00:00:00Z", "not-a-date", new Date(Number.NaN)])("rejects invalid source dates %s", (createdAt) => {
    const source = supplierDocumentSource();
    expect(() => buildSupplierPoDocument({ ...source, po: { ...source.po, createdAt } }))
      .toThrow(expect.objectContaining({ code: "INVALID_SUPPLIER_DOCUMENT_SOURCE" }));
  });
});
