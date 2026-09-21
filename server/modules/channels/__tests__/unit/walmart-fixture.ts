// Synthetic US fixture shaped from Walmart's Get Order reference; no customer data.
export function walmartOrderFixture(status = "Created", quantity = "1") {
  return {
    purchaseOrderId: "PO-123", customerOrderId: "CO-456", orderType: "REGULAR",
    orderDate: Date.parse("2026-09-20T12:00:00Z"), shipNode: { id: "NODE-1", type: "SellerFulfilled" },
    shippingInfo: { estimatedShipDate: Date.parse("2026-09-23T12:00:00Z"), methodCode: "Standard",
      postalAddress: { name: "Test Customer", address1: "123 Test Street", city: "Test City", state: "PA", postalCode: "19000", country: "USA" } },
    orderLines: { orderLine: [{ lineNumber: "1", item: { sku: "WALMART-SKU", productName: "Test product" },
      charges: { charge: [{ chargeType: "PRODUCT", chargeName: "ItemPrice", chargeAmount: { currency: "USD", amount: "19.99" },
        tax: { taxAmount: { currency: "USD", amount: "1.20" } } }] },
      orderLineQuantity: { unitOfMeasurement: "EACH", amount: quantity },
      orderLineStatuses: { orderLineStatus: [{ status, statusQuantity: { unitOfMeasurement: "EACH", amount: quantity },
        trackingInfo: { trackingNumber: "TRACK-1", carrierName: { carrier: "UPS" } } }] },
      fulfillment: { fulfillmentOption: "DELIVERY" },
    }] },
  };
}
