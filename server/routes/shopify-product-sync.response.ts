import type { Response } from "express";
import { publicationSelectionBusyIssue } from "../modules/inventory-planning/publication-selection-work";

export function sendShopifyProductSyncFailure(response: Response, error: unknown): void {
  const busy = publicationSelectionBusyIssue(error);
  if (busy) {
    response.setHeader("Retry-After", "2");
    response.status(409).json({ code: busy.code, retryable: true,
      error: "A stock update is finishing. Some catalog items may already have synced. Refresh, then retry Sync from Shopify to continue.",
      partialChangesPossible: true });
    return;
  }
  console.error(JSON.stringify({ code: "SHOPIFY_PRODUCT_SYNC_FAILED", errorType: error instanceof Error ? error.name : typeof error }));
  response.status(500).json({ code: "SHOPIFY_PRODUCT_SYNC_FAILED", error: "Failed to sync products from Shopify", partialChangesPossible: true });
}
