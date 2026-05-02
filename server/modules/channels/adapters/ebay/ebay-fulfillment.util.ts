export function buildEbayShippingFulfillmentPath(orderId: string): string {
  const normalizedOrderId = orderId.trim();
  if (!normalizedOrderId) {
    throw new Error("eBay orderId is required for shipping fulfillment.");
  }
  return `/sell/fulfillment/v1/order/${encodeURIComponent(normalizedOrderId)}/shipping_fulfillment`;
}

export function extractEbayFulfillmentIdFromLocation(location: string | null): string | null {
  if (!location) return null;
  const segments = location.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? null;
}

export function normalizeEbayTrackingNumber(trackingNumber: string): string {
  const normalized = trackingNumber.trim().replace(/[\s-]+/g, "");
  if (!normalized) {
    throw new Error("eBay trackingNumber is required.");
  }
  if (!/^[A-Za-z0-9]+$/.test(normalized)) {
    throw new Error("eBay trackingNumber must contain only alphanumeric characters after separator normalization.");
  }
  return normalized;
}
