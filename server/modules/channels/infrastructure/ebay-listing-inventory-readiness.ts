import type { InventoryEbayPublicationReadinessInput } from "@shared/types/ebay-publication-readiness";
import { pool } from "../../../db";
import { ensureEbayPublicationReady, InventoryPublicationMembershipError, InventoryPublicationSelectionError } from "../../inventory-planning/quantity-publication";
import { EbayListingSyncError } from "../ebay-listing-sync.domain";
import type { VerifiedEbayListingPreparation } from "../ebay-listing-preparation-scope";

/** Publishing and maintenance share one stock preparation owner. The caller
 * supplies the identity verified against eBay and the durable job's actor/key. */
export async function ensureEbayListingInventoryReady(
  source: InventoryEbayPublicationReadinessInput,
  execution: { commandKey: string; actor: string } | undefined,
  now: Date,
  verifiedListing?: VerifiedEbayListingPreparation,
): Promise<void> {
  if (!execution) throw new EbayListingSyncError("EBAY_PUBLICATION_OWNER_REQUIRED",
    "Automatic stock preparation requires the saved listing job and its authenticated actor.");
  try {
    await ensureEbayPublicationReady(pool, source, { ...execution, now, ...(verifiedListing ? { verifiedListing } : {}) });
  } catch (error) {
    // Only validated Inventory business errors may become public diagnostics.
    if (error instanceof InventoryPublicationMembershipError || error instanceof InventoryPublicationSelectionError)
      throw new EbayListingSyncError(error.code, error.message, { cause: error });
    throw error;
  }
}
