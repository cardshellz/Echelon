import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { evaluateDropshipCatalogExposure } from "../domain/catalog-exposure";
import { DropshipError } from "../domain/errors";
import { prepareEbayCategoryRules, resolveEbayListingCategory } from "../application/dropship-ebay-category-resolver";
import type { ListingSettingsInputs } from "../application/dropship-listing-settings-facts";
import type { ListingSettingsLoad, ListingSettingsRepository } from "../application/dropship-listing-settings-service";
import { loadSelectedCandidates } from "../application/dropship-selected-catalog";
import { readEbayCategoryRules } from "./dropship-ebay-category-rules.reader";
import { readContentProfile, readListingContentSettings } from "./dropship-listing-content.reader";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import { loadRulePriceContext } from "./dropship-rule-price.loader";
import { selectedCatalogReaderForTransaction } from "./dropship-selected-catalog.reader";
import { PgShellzClubProductCostAdapter } from "./shellz-club-product-cost.adapter";

type Reader = Pick<PoolClient, "query">;

/**
 * A digest of exactly the rows one view reads, in a stable order; null when
 * there are none. Any insert, update or delete of those rows changes it,
 * whatever order concurrent saves commit in (a newest-id or newest-time check
 * can miss a save that commits after a later one). It only detects change and
 * is never used as an identity or a secret. Every argument is a constant in
 * this file, never input.
 */
function rowsDigest(columns: string, from: string, orderBy: string): string {
  return `(SELECT encode(sha256(convert_to(string_agg(json_build_array(${columns})::text, ',' ORDER BY ${orderBy}), 'UTF8')), 'hex')
     FROM ${from})`;
}

/**
 * The store's owner and a fingerprint of every Dropship-owned value the views
 * read, in one row, so the cache key costs one query. Each part is the value
 * itself, or the id of the immutable revision that holds it: the three
 * profiles, and the price and description settings, whose triggers keep each
 * row equal to its revision (migrations 0657, 0659, 0660, 0717). So every
 * committed save, reset or delete changes the fingerprint. What Card Shellz
 * owns with no revision (catalog facts, .ops costs, the eBay category
 * mappings, exposure time windows) is covered by the cache's time limit
 * instead (Listing settings design 8.4). The reads in this file and these parts
 * change together: the PostgreSQL suite fails when a load reads a Dropship
 * table that is not here.
 */
const FINGERPRINT_SQL = `
WITH owner AS (
  SELECT v.id AS vendor_id, sc.id AS store_connection_id,
         -- What the store context reads (loadStoreContext); tokens only as present or not.
         json_build_array(v.status, v.entitlement_status, sc.status, sc.setup_status, sc.platform,
           sc.access_token_ref IS NOT NULL, sc.refresh_token_ref IS NOT NULL) AS access
  FROM dropship.dropship_vendors v
  JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
  WHERE v.member_id::text = $1 AND sc.id = $2
)
SELECT o.vendor_id, json_build_array(
  o.access,
  (SELECT json_build_array(c.id, c.platform, c.listing_mode, c.inventory_mode, c.price_mode, c.marketplace_config,
          c.required_config_keys, c.required_product_fields, c.is_active)
     FROM dropship.dropship_store_listing_configs c WHERE c.store_connection_id = o.store_connection_id),
  (SELECT p.revision_id FROM dropship.dropship_pricing_profiles p
     WHERE p.vendor_id = o.vendor_id AND p.store_connection_id = o.store_connection_id),
  (SELECT p.revision_id FROM dropship.dropship_content_profiles p
     WHERE p.vendor_id = o.vendor_id AND p.store_connection_id = o.store_connection_id),
  (SELECT p.revision_id FROM dropship.dropship_ebay_category_rule_profiles p
     WHERE p.vendor_id = o.vendor_id AND p.store_connection_id = o.store_connection_id),
  ${rowsDigest("s.product_variant_id, s.revision_id", `dropship.dropship_listing_price_settings s
     WHERE s.vendor_id = o.vendor_id AND s.store_connection_id = o.store_connection_id`, "s.product_variant_id")},
  ${rowsDigest("s.product_variant_id, s.revision_id", `dropship.dropship_listing_content_settings s
     WHERE s.vendor_id = o.vendor_id AND s.store_connection_id = o.store_connection_id`, "s.product_variant_id")},
  ${rowsDigest("s.product_variant_id, s.revision_id, s.fulfillment_policy_id, s.return_policy_id, s.payment_policy_id, s.updated_at",
    `dropship.dropship_ebay_listing_policy_overrides s
     WHERE s.vendor_id = o.vendor_id AND s.store_connection_id = o.store_connection_id`, "s.product_variant_id")},
  ${rowsDigest("s.product_variant_id, s.store_category_names", `dropship.dropship_ebay_store_category_assignments s
     WHERE s.vendor_id = o.vendor_id AND s.store_connection_id = o.store_connection_id`, "s.product_variant_id")},
  ${rowsDigest(`r.id, r.scope_type, r.action, r.product_line_id, r.product_id, r.product_variant_id, r.category,
     r.auto_connect_new_skus, r.auto_list_new_skus, r.priority`, `dropship.dropship_vendor_selection_rules r
     WHERE r.vendor_id = o.vendor_id AND r.is_active = true`, "r.id")},
  ${rowsDigest("x.product_variant_id, x.enabled_override, x.marketplace_quantity_cap", `dropship.dropship_vendor_variant_overrides x
     WHERE x.vendor_id = o.vendor_id`, "x.id")},
  ${rowsDigest(`r.id, r.scope_type, r.action, r.product_line_id, r.product_id, r.product_variant_id, r.category,
     r.starts_at, r.ends_at, r.priority`, "dropship.dropship_catalog_rules r WHERE r.is_active = true", "r.id")},
  ${rowsDigest(`pp.id, pp.scope_type, pp.product_line_id, pp.product_id, pp.product_variant_id, pp.category, pp.mode,
     pp.floor_price_cents, pp.ceiling_price_cents`, "dropship.dropship_pricing_policies pp WHERE pp.is_active = true", "pp.id")},
  ${rowsDigest("h.id, h.product_variant_id, h.held_at", `dropship.dropship_cost_change_listing_holds h
     WHERE h.vendor_id = o.vendor_id AND h.store_connection_id = o.store_connection_id AND h.released_at IS NULL`, "h.id")},
  ${rowsDigest("l.id, l.product_variant_id, l.status, l.vendor_retail_price_cents, l.quantity_cap, l.external_listing_id",
    "dropship.dropship_vendor_listings l WHERE l.store_connection_id = o.store_connection_id", "l.id")}
) AS parts
FROM owner o`;

interface FingerprintRow { vendor_id: number; parts: unknown }

async function readOwnerFingerprint(client: Reader, input: { memberId: string; storeConnectionId: number }):
  Promise<{ vendorId: number; fingerprint: string } | null> {
  const row = (await client.query<FingerprintRow>(FINGERPRINT_SQL, [input.memberId, input.storeConnectionId])).rows[0];
  if (!row) return null;
  return { vendorId: row.vendor_id,
    fingerprint: createHash("sha256").update(JSON.stringify([row.vendor_id, input.storeConnectionId, row.parts])).digest("hex") };
}

export class PgDropshipListingSettingsRepository implements ListingSettingsRepository {
  constructor(
    private readonly dbPool: Pick<Pool, "query" | "connect"> = defaultPool,
    private readonly reportCostReadFailure: (input: { vendorId: number; storeConnectionId: number; variantCount: number; stage: string }) => void = () => undefined,
  ) {}

  async readFingerprint(input: { memberId: string; storeConnectionId: number }): Promise<string | null> {
    return (await readOwnerFingerprint(this.dbPool, input))?.fingerprint ?? null;
  }

  async load(input: { memberId: string; storeConnectionId: number; now: Date }): Promise<ListingSettingsLoad | null> {
    const client = await this.dbPool.connect();
    try {
      // One snapshot, no locks: the views never write, and a long scan must not block listing queues.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await this.loadInSnapshot(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadInSnapshot(client: Reader, input: { memberId: string; storeConnectionId: number; now: Date }): Promise<ListingSettingsLoad | null> {
    // The fingerprint is read first, so it describes exactly the snapshot everything else is read from.
    const owner = await readOwnerFingerprint(client, input);
    if (!owner) return null;
    const { vendorId, fingerprint } = owner;
    const storeConnectionId = input.storeConnectionId;
    const reader = PgDropshipListingPreviewRepository.readerForTransaction(client);
    const store = await reader.loadStoreContext({ vendorId, storeConnectionId });
    if (!store) throw new Error(`Listing settings found the owner of store ${storeConnectionId} but not its context.`);
    if (store.platform !== "ebay") return { state: "not_ebay", fingerprint, store };

    const pricing = (await loadRulePriceContext(client, { vendorId, storeConnectionId })).state;
    const listingConfig = await reader.getStoreListingConfig(storeConnectionId);
    const ebayCategoryRules = await readEbayCategoryRules(client, vendorId, storeConnectionId);
    const content = await readContentProfile(client, vendorId, storeConnectionId);
    const storeLevel = { pricing, listingConfig, ebayCategoryRules, content };

    let candidates: ListingSettingsInputs["candidates"];
    try {
      candidates = await loadSelectedCandidates({ vendorId, ...selectedCatalogReaderForTransaction(client) }, input.now, "listing_settings");
    } catch (error) {
      if (error instanceof DropshipError && error.code === "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") {
        return { state: "too_large", fingerprint, store, storeLevel };
      }
      throw error;
    }

    const ids = candidates.map((row) => row.productVariantId);
    let costReadFailed = false;
    const costs = await PgShellzClubProductCostAdapter.forTransaction(client, (failure) => {
      costReadFailed = true;
      this.reportCostReadFailure({ vendorId, storeConnectionId, variantCount: failure.variantCount, stage: failure.stage });
    }).loadProductCosts({ vendorId, productVariantIds: ids });
    const preparedCategories = prepareEbayCategoryRules(ebayCategoryRules.revisionId, ebayCategoryRules.profile);
    const inputs: ListingSettingsInputs = {
      store,
      candidates,
      sizesTotalByProductId: await countOfferedSizes(client, reader, candidates, input.now),
      savedPrices: new Map((await reader.listSavedListingPrices({ vendorId, storeConnectionId, productVariantIds: ids }))
        .map((row) => [row.productVariantId, row])),
      existingListings: new Map((await reader.listExistingListings({ storeConnectionId, productVariantIds: ids }))
        .map((row) => [row.productVariantId, row])),
      pricing,
      costs,
      pricingPolicies: await reader.listPricingPolicies(),
      listingConfig,
      policyOverrides: new Map((await reader.listEbayListingPolicyOverrides({ vendorId, storeConnectionId, productVariantIds: ids }))
        .map((row) => [row.productVariantId, row])),
      shelfAssignments: new Map((await reader.listEbayStoreCategoryAssignments({ vendorId, storeConnectionId, productVariantIds: ids }))
        .map((row) => [row.productVariantId, row.storeCategoryNames])),
      ebayCategoryRules,
      ebayCategories: new Map(candidates.map((row) => [row.productVariantId, resolveEbayListingCategory(row, preparedCategories)])),
      content,
      contentSettings: await readListingContentSettings(client, vendorId, storeConnectionId, ids),
      pausedSince: await readLiveHolds(client, { vendorId, storeConnectionId, productVariantIds: ids }),
    };
    return { state: "ok", fingerprint, inputs, costReadFailed };
  }
}

/**
 * Every size of each chosen product that the vendor could choose: sellable
 * and offered by Card Shellz now. The chosen sizes are always among them.
 */
async function countOfferedSizes(client: Reader, reader: ReturnType<typeof PgDropshipListingPreviewRepository.readerForTransaction>,
  candidates: ListingSettingsInputs["candidates"], now: Date): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (const candidate of candidates) counts.set(candidate.productId, (counts.get(candidate.productId) ?? 0) + 1);
  if (!candidates.length) return counts;
  const chosen = new Set(candidates.map((row) => row.productVariantId));
  const others = (await client.query<{ id: number }>(
    `SELECT id FROM catalog.product_variants WHERE product_id = ANY($1::int[]) AND requires_shipping = true
     AND COALESCE(track_inventory, true) = true AND sales_eligibility = 'sellable' ORDER BY id`,
    [[...counts.keys()]])).rows.map((row) => row.id).filter((id) => !chosen.has(id));
  if (!others.length) return counts;
  const rules = await reader.listCatalogExposureRules();
  for (const candidate of await reader.listCatalogCandidates(others)) {
    if (evaluateDropshipCatalogExposure(candidate, rules, now).exposed) {
      counts.set(candidate.productId, (counts.get(candidate.productId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * When each size's live cost-change hold began (`held_at`, the time the hold
 * pass recorded; dropship-cost-change-listing-action.repository.ts). A
 * released hold no longer pauses the size, and a size has at most one live
 * hold (migration 0713's partial unique index).
 */
async function readLiveHolds(client: Reader, input: { vendorId: number; storeConnectionId: number; productVariantIds: readonly number[] }):
  Promise<Map<number, Date>> {
  if (!input.productVariantIds.length) return new Map();
  const result = await client.query<{ product_variant_id: number; held_at: Date }>(
    `SELECT product_variant_id, held_at FROM dropship.dropship_cost_change_listing_holds
     WHERE vendor_id = $1 AND store_connection_id = $2 AND released_at IS NULL AND product_variant_id = ANY($3::int[])`,
    [input.vendorId, input.storeConnectionId, input.productVariantIds]);
  return new Map(result.rows.map((row) => [row.product_variant_id, row.held_at]));
}

async function rollbackQuietly(client: Reader): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The read already failed; that error is the one to report, not a failed rollback.
  }
}
