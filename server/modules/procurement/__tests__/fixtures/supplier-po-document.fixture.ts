/** Synthetic stored-row shape. Real persistence is covered by the sibling PG suite. */
export function supplierDocumentSource() {
  return {
    po: {
      id: 1, poNumber: "PO-DOCUMENT-001", vendorId: 2, warehouseId: 3,
      status: "draft", physicalStatus: "draft", financialStatus: "unbilled",
      revisionNumber: 0, currency: "USD", orderDate: null,
      createdAt: new Date("2026-10-12T12:00:00.000Z"), updatedAt: new Date("2026-10-12T12:00:00.000Z"),
      expectedDeliveryDate: new Date("2026-11-01T00:00:00.000Z"),
      paymentTermsDays: 30, paymentTermsType: "net", incoterms: "FOB",
      shipToAddress: null, vendorContactName: null, vendorContactEmail: null, referenceNumber: null,
      subtotalCents: 12345, discountCents: 0, taxCents: 0, shippingCostCents: 0, totalCents: 12345,
      vendorNotes: "Please confirm delivery.", internalNotes: "PRIVATE_PO_MARGIN_DO_NOT_DISCLOSE",
    },
    lines: [{
      id: 11, purchaseOrderId: 1, lineNumber: 1, lineType: "product", status: "open", parentLineId: null,
      productId: 10, productVariantId: 100, sku: "CASE-SKU", vendorSku: "SUPPLIER-SKU",
      productName: "Recorded product name", description: null, orderQty: 1,
      receivedQty: 0, cancelledQty: 0, expectedReceiveVariantId: 100, expectedReceiveUnitsPerVariant: 1,
      unitCostCents: 12345, unitCostMills: 1234500, totalProductCostCents: 12345,
      packagingCostCents: 0, discountCents: 0, taxCents: 0, lineTotalCents: 12345,
      pricingBasis: "per_piece", pricingSource: "manual", purchaseUom: null,
      purchaseUomQuantity: null, piecesPerPurchaseUom: null, quotedUnitCostMills: 1234500,
      quotedTotalCents: null, pricingRemainderMills: 0, notes: "PRIVATE_LINE_NEGOTIATION",
    }],
    vendor: { id: 2, name: "Synthetic supplier", address: "2 Vendor Lane", city: "Boston", state: "MA", postalCode: "02101", country: "US", contactName: "Purchasing desk", email: "vendor@example.test", phone: "555-0100", internalNotes: "PRIVATE_VENDOR_BANK_TERMS" },
    warehouse: { id: 3, name: "Receiving dock", address: "3 Receiving Road", city: "Boston", state: "MA", postalCode: "02102", country: "US" },
    companyName: "Synthetic buyer", companyAddress: "1 Buyer Street", companyCity: "Boston", companyState: "MA", companyPostalCode: "02100", companyCountry: "US",
  };
}
