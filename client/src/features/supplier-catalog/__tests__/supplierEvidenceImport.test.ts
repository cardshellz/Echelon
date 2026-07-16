import { describe, expect, it } from "vitest";
import {
  parseSupplierEvidenceCsv,
  supplierEvidenceImportTemplateCsv,
} from "../supplierEvidenceImport";

describe("supplier evidence CSV", () => {
  it("creates a strict blank template", () => {
    const template = supplierEvidenceImportTemplateCsv();
    expect(template.split(/\r?\n/)[0]).toBe(
      "sku,vendor_sku,pricing_basis,quoted_unit_cost,purchase_uom,pieces_per_purchase_uom,quote_reference,quoted_at,quote_valid_until,moq_pieces,lead_time_days,is_preferred",
    );
  });

  it("parses exact per-piece and purchase-UOM quotes without float conversion", () => {
    const result = parseSupplierEvidenceCsv([
      "sku,vendor_sku,pricing_basis,quoted_unit_cost,purchase_uom,pieces_per_purchase_uom,quote_reference,quoted_at,quote_valid_until,moq_pieces,lead_time_days,is_preferred",
      'var-1,"V, ONE",per_piece,0.0075,,,Q-1,2026-07-15,2026-08-15,12,5,true',
      "VAR-2,V-2,per_purchase_uom,12.3456,case,24,Q-2,2026-07-15,,48,7,yes",
    ].join("\n"));

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        sku: "VAR-1",
        vendorSku: "V, ONE",
        pricingBasis: "per_piece",
        quotedUnitCost: "0.0075",
        purchaseUom: null,
        piecesPerPurchaseUom: null,
        quoteReference: "Q-1",
        quotedAt: "2026-07-15",
        quoteValidUntil: "2026-08-15",
        moqPieces: 12,
        leadTimeDays: 5,
        isPreferred: true,
      },
      {
        sku: "VAR-2",
        vendorSku: "V-2",
        pricingBasis: "per_purchase_uom",
        quotedUnitCost: "12.3456",
        purchaseUom: "case",
        piecesPerPurchaseUom: 24,
        quoteReference: "Q-2",
        quotedAt: "2026-07-15",
        quoteValidUntil: null,
        moqPieces: 48,
        leadTimeDays: 7,
        isPreferred: true,
      },
    ]);
  });

  it("fails closed on unexpected columns and incoherent pricing fields", () => {
    const result = parseSupplierEvidenceCsv([
      "sku,pricing_basis,quoted_unit_cost,quoted_at,lead_time_days,is_preferred,unit_price",
      "VAR-1,per_piece,1.25,2026-07-15,5,true,1.25",
      "VAR-2,per_purchase_uom,4.00,2026-07-15,5,true,4.00",
    ].join("\n"));

    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ rowNumber: 1, message: "Unexpected column: unit_price" }),
      expect.objectContaining({ rowNumber: 3, field: "pricing_basis" }),
    ]));
  });

  it("rejects CSV batches larger than the server contract", () => {
    const header = "sku,pricing_basis,quoted_unit_cost,quoted_at,lead_time_days,is_preferred";
    const data = Array.from(
      { length: 201 },
      (_, index) => `SKU-${index + 1},per_piece,1.0000,2026-07-15,5,true`,
    );
    const result = parseSupplierEvidenceCsv([header, ...data].join("\n"));

    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "The CSV cannot contain more than 200 evidence rows." }),
    ]));
  });
});
