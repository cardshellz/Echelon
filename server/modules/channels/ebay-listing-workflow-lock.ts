import { z } from "zod";

// Shared by first publication and saved maintenance. Quantity admission retains
// its independent exact provider-resource locks and remains the quantity owner.
export const EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE = 918427;
export function ebayListingWorkflowLockKey(channelId: number, productId: number): string {
  const id = z.number().int().positive().max(2147483647);
  return `listing:${id.parse(channelId)}:${id.parse(productId)}`;
}
