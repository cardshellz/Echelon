import { describe, expect, it, vi } from "vitest";
vi.mock("../../../../db", () => ({ db: {} }));
import { mapPurchaseOrderWithLinesInput, parseNullableDateInput } from "../../purchase-order-entry-input";

describe("purchase order entry wire mapping", () => {
  it("preserves catalog directives, quote dates and purchase-unit pricing without inventing legacy costs", () => {
    const mapped = mapPurchaseOrderWithLinesInput({ vendor_id: 3, lines: [{
      product_id: 11, product_variant_id: 22, expected_receive_units_per_variant: 100,
      pricing_source: "manual", quote_reference: "QUOTE-7", quoted_at: "2026-07-11T00:00:00.000Z",
      quote_valid_until: "2026-08-01", catalog_write: { mode: "upsert", set_preferred: true },
      pricing: { basis: "per_purchase_uom", purchase_uom: "case", uom_quantity: 5,
        pieces_per_uom: 100, quoted_cost_mills_per_uom: 40_000 },
    }] }, false);
    expect(mapped.vendorId).toBe(3);
    expect(mapped.lines[0]).toMatchObject({ productId: 11, productVariantId: 22,
      expectedReceiveVariantId: 22, expectedReceiveUnitsPerVariant: 100, orderQty: 500,
      pricingSource: "manual", quoteReference: "QUOTE-7", quotedAt: new Date("2026-07-11T00:00:00.000Z"),
      quoteValidUntil: "2026-08-01", catalogWrite: { mode: "upsert", setPreferred: true },
      pricing: { basis: "per_purchase_uom", purchaseUom: "case", uomQuantity: 5,
        piecesPerUom: 100, quotedCostMillsPerUom: 40_000 } });
    expect(mapped.lines[0]).not.toHaveProperty("unitCostMills");
    expect(mapped.lines[0]).not.toHaveProperty("unitCostCents");
    expect(mapped.lines[0]).not.toHaveProperty("packSize");
  });

  it("rejects conflicting catalog preferred aliases before the owner writes", () => {
    expect(() => mapPurchaseOrderWithLinesInput({ vendor_id: 3, lines: [{
      catalog_write: { mode: "upsert", set_preferred: true, setPreferred: false },
    }] }, false)).toThrow(expect.objectContaining({ statusCode: 400, details: { code: "PO_LINE_CATALOG_WRITE_INVALID" } }));
  });

  it("retains full draft identity, explicit warehouse clearing and exact cent/mill inputs", () => {
    const mapped = mapPurchaseOrderWithLinesInput({ vendor_id: 3, warehouse_id: null,
      expected_delivery_date: "2026-08-01", vendor_notes: "Supplier terms", internal_notes: "Buyer note",
      lines: [{ line_id: 10, client_id: "line-10", parent_client_id: "parent-7", product_id: 11,
        product_variant_id: 22, quantity_ordered: 500, unit_cost_cents: 125, unit_cost_mills: 12_500,
        total_product_cost_cents: 62_500, packaging_cost_cents: 20,
        pricing: { basis: "extended_total", quantity_pieces: 500, quoted_total_cents: 62_500 } }],
    }, true);
    expect(mapped).toMatchObject({ vendorId: 3, warehouseId: null, expectedDeliveryDate: new Date("2026-08-01"),
      vendorNotes: "Supplier terms", internalNotes: "Buyer note", lines: [{ lineId: 10, clientId: "line-10",
        parentClientId: "parent-7", orderQty: 500, unitCostCents: 125, unitCostMills: 12_500,
        totalProductCostCents: 62_500, packagingCostCents: 20,
        pricing: { basis: "extended_total", quantityPieces: 500, quotedTotalCents: 62_500 } }] });
    expect(parseNullableDateInput("2026-07-11T00:30:00.000Z", "expectedUpdatedAt"))
      .toEqual(new Date("2026-07-11T00:30:00.000Z"));
  });

  it("keeps camel-case legacy fields and absent warehouse distinct from an explicit clear", () => {
    const mapped = mapPurchaseOrderWithLinesInput({ vendorId: 3, poType: "blanket", lines: [{
      productId: 11, productVariantId: 22, orderQty: 2, unitCostMills: 15_000,
      catalogWrite: { mode: "upsert", setPreferred: false },
    }] }, false);
    expect(mapped).toMatchObject({ vendorId: 3, poType: "blanket", warehouseId: undefined,
      lines: [{ productId: 11, productVariantId: 22, orderQty: 2, unitCostMills: 15_000,
        catalogWrite: { mode: "upsert", setPreferred: false } }] });
  });

  it.each([{}, 0, "invalid-date"])("rejects malformed date %j explicitly", value => {
    expect(() => parseNullableDateInput(value, "expectedUpdatedAt"))
      .toThrow(expect.objectContaining({ statusCode: 400, details: { code: "INVALID_DATE_INPUT", field: "expectedUpdatedAt" } }));
  });
});
