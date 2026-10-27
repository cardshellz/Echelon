import { z } from "zod";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import { MAX_SELECTION_FACT_SIZES } from "../../../../shared/dropship/vendor-selection-changes";
import {
  readCatalogStockSelectionFactsForProducts,
  readCatalogStockSelectionFactsForVariants,
  type CatalogStockVariantFacts,
} from "../../catalog/catalog-stock-selection.reader";
import type { DropshipCatalogExposureRule } from "../domain/catalog-exposure";
import { DropshipError } from "../domain/errors";
import type { DropshipStockSelectionCandidate } from "../domain/stock-publication-selection";
import type { DropshipVendorVariantOverride } from "../domain/vendor-selection";
import type { SelectionEffectsListing, SelectionEffectsStore } from "../domain/vendor-selection-effects";
import { selectionRemovalTooLarge } from "../domain/vendor-selection-ends";
import {
  DROPSHIP_STOCK_LISTING_ROWS_SQL,
  dropshipStockListingRowSchema,
  dropshipStockSelectionCandidate,
  readDropshipStockExposureRules,
  readDropshipStockOverrides,
  readDropshipStockPickedVariantIds,
  withListingEndState,
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
 *
 * PR C (PLAN-C v4.1 §4.2): a removal widens the facts from the touched sizes
 * to every size of each product it touches (the catalog's published
 * readCatalogStockSelectionFactsForProducts), so decideListingEnds can tell a
 * wholly removed product and end its other sizes' listings. The widened set
 * is bounded by MAX_SELECTION_FACT_SIZES (422 REMOVAL_TOO_LARGE) before any
 * listing is read. The picks are read in two sets (FID-1): `pickedBefore`
 * among the touched sizes, exactly as before, and `siblingPicks` among the
 * rest, read by decideListingEnds only.
 */

const id = z.number().int().positive().max(2_147_483_647);
const inputSchema = z.object({
  vendorId: id,
  /** The touched sizes: a save adds and removes at most 10,000 sizes each (§8.2). */
  productVariantIds: z.array(id).max(MAX_SELECTION_FACT_SIZES),
  /** The removed sizes among them: every size of their products joins the facts. */
  removedIds: z.array(id).max(MAX_SELECTION_FACT_SIZES).optional(),
}).strict();
const storeRowSchema = z.object({
  id,
  platform: z.string(),
  status: z.string(),
  externalAccountId: z.string().nullable(),
  providerEnvironment: z.string().nullable(),
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
  /** The vendor's picks among the other sizes of the removed sizes' products (PR C; empty without a removal). */
  siblingPicks: Set<number>;
  /** Catalog facts of every size in the facts that exists, ascending; a size without a row is absent. */
  candidates: DropshipStockSelectionCandidate[];
  adminRules: DropshipCatalogExposureRule[];
  overrides: DropshipVendorVariantOverride[];
  /** Every store of the vendor, ascending by id, each with its listing rows of every size in the facts. */
  stores: SelectionEffectsStore[];
}

export async function readDropshipSelectionEffectsFacts(client: StockSelectionQueryClient, raw: {
  vendorId: number; productVariantIds: readonly number[]; removedIds?: readonly number[];
}): Promise<DropshipSelectionEffectsFacts> {
  const input = inputSchema.parse(raw);
  const touchedIds = [...new Set(input.productVariantIds)].sort((left, right) => left - right);
  const storeRows = z.array(storeRowSchema).parse((await client.query(`SELECT sc.id, sc.platform, sc.status,
    sc.external_account_id AS "externalAccountId", sc.provider_environment AS "providerEnvironment",
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
  const catalog = await readFactSizes(client, touchedIds, input.removedIds ?? []);
  // Every size in the facts, ascending: the touched sizes and every size of each removed size's product.
  const productVariantIds = [...new Set([...touchedIds, ...catalog.map(({ variant }) => variant.id)])].sort((left, right) => left - right);
  if (productVariantIds.length > MAX_SELECTION_FACT_SIZES) throw selectionRemovalTooLarge({ factSizes: productVariantIds.length });
  const listingRows = z.array(dropshipStockListingRowSchema).parse(productVariantIds.length && storeIds.length
    ? (await client.query(DROPSHIP_STOCK_LISTING_ROWS_SQL, [input.vendorId, storeIds, productVariantIds])).rows : []);
  const overrides = await readDropshipStockOverrides(client, input.vendorId, productVariantIds);
  const adminRules = await readDropshipStockExposureRules(client);
  const pickedBefore = await readDropshipStockPickedVariantIds(client, input.vendorId, touchedIds);
  const touched = new Set(touchedIds);
  const siblingIds = productVariantIds.filter((productVariantId) => !touched.has(productVariantId));
  const siblingPicks = siblingIds.length > 0 ? await readDropshipStockPickedVariantIds(client, input.vendorId, siblingIds) : new Set<number>();

  const listingsByStore = new Map<number, SelectionEffectsListing[]>();
  for (const { storeConnectionId, ...listing } of listingRows) {
    const rows = listingsByStore.get(storeConnectionId) ?? [];
    // `endOpen` as SPR derives it (PLAN-C v4.1 §7), so the confirm counts what stock publication will do.
    rows.push(withListingEndState(listing));
    listingsByStore.set(storeConnectionId, rows);
  }
  const candidates: DropshipStockSelectionCandidate[] = [];
  for (const { product, variant } of catalog) {
    const candidate = dropshipStockSelectionCandidate(product, variant, variant.id);
    if (candidate) candidates.push(candidate);
  }
  return {
    pickedBefore,
    siblingPicks,
    candidates,
    adminRules,
    overrides,
    stores: storeRows.map((row) => ({
      storeConnectionId: row.id,
      storeName: row.storeName ?? defaultStoreName(row.platform),
      platform: row.platform,
      status: row.status,
      externalAccountId: row.externalAccountId,
      providerEnvironment: row.providerEnvironment,
      config: row.config,
      storePaused: row.status === "paused",
      listings: listingsByStore.get(row.id) ?? [],
    })),
  };
}

/**
 * The catalog facts of the touched sizes and, for a removal, of every size of the removed sizes' products, each size
 * once, ascending. The products come from the touched sizes' own facts, so a removal costs one more statement, read
 * with a bound: past MAX_SELECTION_FACT_SIZES nothing else is read (422 REMOVAL_TOO_LARGE).
 */
async function readFactSizes(client: StockSelectionQueryClient, touchedIds: readonly number[],
  removedIds: readonly number[]): Promise<CatalogStockVariantFacts[]> {
  const touched = await readCatalogStockSelectionFactsForVariants(client, touchedIds);
  const removed = new Set(removedIds);
  const removedProductIds = [...new Set(touched.filter(({ variant }) => removed.has(variant.id)).map(({ product }) => product.id))];
  if (removedProductIds.length === 0) return touched;
  const siblings = await readCatalogStockSelectionFactsForProducts(client, removedProductIds, { maxSizes: MAX_SELECTION_FACT_SIZES });
  if (siblings.length > MAX_SELECTION_FACT_SIZES) throw selectionRemovalTooLarge({ factSizes: siblings.length });
  const bySize = new Map<number, CatalogStockVariantFacts>();
  for (const facts of [...touched, ...siblings]) bySize.set(facts.variant.id, facts);
  return [...bySize.values()].sort((left, right) => left.variant.id - right.variant.id);
}

/** A store with no display name, as the publish run's notice names it (listing-push-run-words.ts). */
function defaultStoreName(platform: string): string {
  // PROPOSED (Stage 3/5, step 1 plan S2-5)
  return platform === "ebay" ? "your eBay store" : "your store";
}
