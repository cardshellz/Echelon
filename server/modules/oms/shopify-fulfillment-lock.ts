/** Creates and label corrections must serialize on the same originating order. */
export function shopifyOrderFulfillmentLockId(omsOrderId: number): number {
  const key = 1_600_000_000_000 + omsOrderId;
  if (!Number.isSafeInteger(omsOrderId) || omsOrderId <= 0 || !Number.isSafeInteger(key)) {
    throw new Error("Invalid Shopify fulfillment order lock identity");
  }
  return key;
}
