import { z } from "zod";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import { readCatalogStockSelectionFactsForVariants } from "../../catalog/catalog-stock-selection.reader";
import type { DropshipCatalogExposureRule } from "../domain/catalog-exposure";
import { DropshipError } from "../domain/errors";
import type { DropshipStockSelectionCandidate } from "../domain/stock-publication-selection";
import type { DropshipVendorVariantOverride } from "../domain/vendor-selection";
import type { SelectionEffectsListing, SelectionEffectsStore } from "../domain/vendor-selection-effects";
import {
  DROPSHIP_STOCK_LISTING_ROWS_SQL,
  dropshipStockListingRowSchema,
  dropshipStockSelectionCandidate,
  readDropshipStockExposureRules,
  readDropshipStockOverrides,
  readDropshipStockPickedVariantIds,
} from "./dropship-stock-publication-selection.reader";

/**
 * The facts a step 1 save's effects are decided from (PLAN-B v4.1 §7.7):
 * for the touched sizes, on every store of the vendor, exactly what the stock
 * publication reader (SPR) would read, so the confirm counts what stock
 * publication will do. A fixed number of statements however many sizes are
 * touched (stores with their listing configs, the listing rows through SPR's
 * own SQL, overrides, catalog facts, exposure rules, picks before); no
 * per-product loop, no lock, no write. The caller's transaction gives the
 * snapshot (the preview's REPEATABLE READ READ ONLY, or the save's own).
 * The decision itself is the pure decideSelectionEffects.
 */

const id = z.number().int().positive().max(2_147_483_647);
/** A save adds and removes at most 10,000 sizes each (§8.2). */
const MAX_TOUCHED_SIZES = 20_000;
const inputSchema = z.object({
  vendorId: id,
  productVariantIds: z.array(id).max(MAX_TOUCHED_SIZES),
}).strict();
const storeRowSchema = z.object({
  id,
  platform: z.string(),
  status: z.string(),
  storeName: z.string().nullable(),
  config: z.object({
    listingMode: z.enum(["draft_first", "live", "manual_only"]),
    inventoryMode: z.enum(["managed_quantity_sync", "manual_quantity", "disabled"]),
    isActive: z.boolean(),
  }).nullable(),
});

export interface DropshipSelectionEffectsFacts {
  /** The vendor's picks among the touched sizes, before the change. */
  pickedBefore: Set<number>;
  /** Catalog facts of the touched sizes that exist, ascending; a size without a row is absent. */
  candidates: DropshipStockSelectionCandidate[];
  adminRules: DropshipCatalogExposureRule[];
  overrides: DropshipVendorVariantOverride[];
  /** Every store of the vendor, ascending by id, each with its listing rows of the touched sizes. */
  stores: SelectionEffectsStore[];
}

export async function readDropshipSelectionEffectsFacts(client: StockSelectionQueryClient, raw: {
  vendorId: number; productVariantIds: readonly number[];
}): Promise<DropshipSelectionEffectsFacts> {
  const input = inputSchema.parse(raw);
  const productVariantIds = [...new Set(input.productVariantIds)].sort((left, right) => left - right);
  const storeRows = z.array(storeRowSchema).parse((await client.query(`SELECT sc.id, sc.platform, sc.status,
    NULLIF(BTRIM(sc.external_display_name), '') AS "storeName",
    CASE WHEN lc.id IS NULL THEN NULL ELSE jsonb_build_object('listingMode',lc.listing_mode,
      'inventoryMode',lc.inventory_mode,'isActive',lc.is_active) END AS config
    FROM dropship.dropship_store_connections sc
    LEFT JOIN dropship.dropship_store_listing_configs lc ON lc.store_connection_id=sc.id AND lc.platform=sc.platform
    WHERE sc.vendor_id=$1 ORDER BY sc.id`, [input.vendorId])).rows);
  const storeIds = storeRows.map((row) => row.id);
  if (new Set(storeIds).size !== storeIds.length) {
    // SPR's refusal for the same data.
    throw new DropshipError("DROPSHIP_STOCK_SELECTION_AMBIGUOUS", "Multiple listing configurations describe this store connection.",
      { classification: "permanent", vendorId: input.vendorId });
  }
  const listingRows = z.array(dropshipStockListingRowSchema).parse(productVariantIds.length && storeIds.length
    ? (await client.query(DROPSHIP_STOCK_LISTING_ROWS_SQL, [input.vendorId, storeIds, productVariantIds])).rows : []);
  const overrides = await readDropshipStockOverrides(client, input.vendorId, productVariantIds);
  const catalog = await readCatalogStockSelectionFactsForVariants(client, productVariantIds);
  const adminRules = await readDropshipStockExposureRules(client);
  const pickedBefore = await readDropshipStockPickedVariantIds(client, input.vendorId, productVariantIds);

  const listingsByStore = new Map<number, SelectionEffectsListing[]>();
  for (const { storeConnectionId, ...listing } of listingRows) {
    const rows = listingsByStore.get(storeConnectionId) ?? [];
    rows.push(listing);
    listingsByStore.set(storeConnectionId, rows);
  }
  const candidates: DropshipStockSelectionCandidate[] = [];
  for (const { product, variant } of catalog) {
    const candidate = dropshipStockSelectionCandidate(product, variant, variant.id);
    if (candidate) candidates.push(candidate);
  }
  return {
    pickedBefore,
    candidates,
    adminRules,
    overrides,
    stores: storeRows.map((row) => ({
      storeConnectionId: row.id,
      storeName: row.storeName ?? defaultStoreName(row.platform),
      platform: row.platform,
      config: row.config,
      storePaused: row.status === "paused",
      listings: listingsByStore.get(row.id) ?? [],
    })),
  };
}

/** A store with no display name, as the publish run's notice names it (listing-push-run-words.ts). */
function defaultStoreName(platform: string): string {
  // PROPOSED (Stage 3/5, step 1 plan S2-5)
  return platform === "ebay" ? "your eBay store" : "your store";
}
