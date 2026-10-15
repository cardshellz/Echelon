import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { evaluateDropshipCatalogExposure } from "../domain/catalog-exposure";
import { DropshipError } from "../domain/errors";
import { prepareEbayCategoryRules, resolveEbayListingCategory } from "../application/dropship-ebay-category-resolver";
import type { DropshipListingStoreContext } from "../application/dropship-listing-preview-service";
import { conversionCategoryNamesToRead } from "../application/dropship-listing-rules-conversion";
import type { ListingSettingsInputs } from "../application/dropship-listing-settings-facts";
import type {
  ListingSettingsConversionLoad, ListingSettingsCostReadFailure, ListingSettingsLoad, ListingSettingsProductOwnRead,
  ListingSettingsRepository, ListingSettingsStoreLevelInputs,
} from "../application/dropship-listing-settings-service";
import { loadSelectedCandidates } from "../application/dropship-selected-catalog";
import { readCategoryListingSettings } from "./dropship-category-listing-settings.repository";
import { readEbayCategoryRules } from "./dropship-ebay-category-rules.reader";
import { readContentProfile, readListingContentSettings } from "./dropship-listing-content.reader";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import {
  readCatalogCategoriesByName, readCatalogCategoryNames, readListingSettingLayers,
} from "./dropship-listing-setting-layers.reader";
import { readStoreListingTextBytesWithClient } from "./dropship-listing-setting-writes.repository";
import { readPricingProfile } from "./dropship-pricing-profile.reader";
import { readProductCategoryMarks } from "./dropship-product-category-marks.repository";
import { readProductListingSettings } from "./dropship-product-listing-settings.repository";
import { selectedCatalogReaderForTransaction } from "./dropship-selected-catalog.reader";
import { PgShellzClubProductCostAdapter } from "./shellz-club-product-cost.adapter";

type Reader = Pick<PoolClient, "query">;

/**
 * Told when the .ops cost read fails inside a load: the load goes on, unpriced by cost, and says so
 * (`costReadFailure`). The stage and SQLSTATE tell a timeout from a schema fault; never a message.
 */
export type ListingSettingsCostReadFailureReport = (input: {
  vendorId: number; storeConnectionId: number; variantCount: number; stage: string; sqlState: string | null;
}) => void;

/**
 * What the read model's inputs load to for a store whose owner the caller
 * has already resolved (loadListingSettingsInputsWithClient): the inputs, or
 * why there are none to build views from.
 */
export type ListingSettingsInputsLoad =
  | { state: "ok"; inputs: ListingSettingsInputs; costReadFailure: ListingSettingsCostReadFailure | null }
  | { state: "too_large"; store: DropshipListingStoreContext; storeLevel: ListingSettingsStoreLevelInputs }
  | { state: "not_ebay"; store: DropshipListingStoreContext };

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
 * The store's owner by member, as every read here resolves it: the store is
 * one of the member's vendor's connections. One predicate for the views'
 * fingerprint and the dry run's owner read, so both answer the same 404.
 */
const OWNER_BY_MEMBER = `FROM dropship.dropship_vendors v
  JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
  WHERE v.member_id::text = $1 AND sc.id = $2`;

/**
 * The owner alone, for a read that is never cached (the rules conversion's
 * dry run): the fingerprint's owner part without its digests, which would
 * hash every listing row of the store only to be thrown away.
 */
const OWNER_SQL = `SELECT v.id AS vendor_id
  ${OWNER_BY_MEMBER}`;

/**
 * The store's owner and a fingerprint of every Dropship-owned value the views
 * read, in one row, so the cache key costs one query. Each part is the value
 * itself, or the id of the immutable revision that holds it: the three
 * profiles, the price and description settings, and the product and category
 * settings, whose triggers keep each row equal to its revision (migrations
 * 0657, 0659, 0660, 0717, 0738, 0739; the last two refuse a delete, so a reset
 * is a new revision too). So every committed save, reset or delete changes the
 * fingerprint. The store's category marks (0739) are a part too, as their own
 * values (product, category, seen_at; plan P29): a first mark, or a "Got it"
 * that acknowledges at least one product, changes it, so "Card Shellz updated
 * products" shows either at once instead of after the cache's time limit. A
 * "Got it" whose products all moved again writes no mark (only its request
 * ledger row and audit row, which are not parts), so it changes nothing here:
 * their new category shows within the time limit, like any move. Marks are
 * never deleted (the 0739 guard).
 * The rows of the categories moved products came from are in the category
 * settings part, which covers every category row of the store. What Card
 * Shellz owns with no revision (catalog facts, a product's category and that
 * category's name, .ops costs, the eBay category mappings, exposure time
 * windows) is covered by the cache's time limit instead (Listing settings
 * design 8.4): a move itself shows within that limit. The reads in this file
 * and these parts change together: the PostgreSQL suite fails when a load
 * reads a Dropship table that is not here.
 */
const FINGERPRINT_SQL = `
WITH owner AS (
  SELECT v.id AS vendor_id, sc.id AS store_connection_id,
         -- What the store context reads (loadStoreContext); tokens only as present or not.
         json_build_array(v.status, v.entitlement_status, sc.status, sc.setup_status, sc.platform,
           sc.access_token_ref IS NOT NULL, sc.refresh_token_ref IS NOT NULL) AS access
  ${OWNER_BY_MEMBER}
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
  ${rowsDigest("s.product_id, s.revision_id", `dropship.dropship_product_listing_settings s
     WHERE s.vendor_id = o.vendor_id AND s.store_connection_id = o.store_connection_id`, "s.product_id")},
  ${rowsDigest("s.category_id, s.revision_id", `dropship.dropship_category_listing_settings s
     WHERE s.vendor_id = o.vendor_id AND s.store_connection_id = o.store_connection_id`, "s.category_id")},
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
    "dropship.dropship_vendor_listings l WHERE l.store_connection_id = o.store_connection_id", "l.id")},
  ${rowsDigest("m.product_id, m.category_id, m.seen_at", `dropship.dropship_product_category_seen m
     WHERE m.vendor_id = o.vendor_id AND m.store_connection_id = o.store_connection_id`, "m.product_id")}
) AS parts
FROM owner o`;

interface FingerprintRow { vendor_id: number; parts: unknown }

/** The vendor that owns the store, when it is the member's; null otherwise. */
async function readOwner(client: Reader, input: { memberId: string; storeConnectionId: number }): Promise<number | null> {
  const row = (await client.query<{ vendor_id: number }>(OWNER_SQL, [input.memberId, input.storeConnectionId])).rows[0];
  return row ? row.vendor_id : null;
}

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
    private readonly reportCostReadFailure: ListingSettingsCostReadFailureReport = () => undefined,
  ) {}

  async readFingerprint(input: { memberId: string; storeConnectionId: number }): Promise<string | null> {
    return (await readOwnerFingerprint(this.dbPool, input))?.fingerprint ?? null;
  }

  async load(input: { memberId: string; storeConnectionId: number; now: Date }): Promise<ListingSettingsLoad | null> {
    return this.inReadSnapshot<ListingSettingsLoad | null>(async (client) => {
      // The fingerprint is read first, so it describes exactly the snapshot everything else is read from.
      const owner = await readOwnerFingerprint(client, input);
      if (!owner) return null;
      const load = await loadListingSettingsInputsWithClient(client,
        { vendorId: owner.vendorId, storeConnectionId: input.storeConnectionId, now: input.now }, this.reportCostReadFailure);
      // The views only need to know that the costs are missing: they show those sizes unpriced and cache nothing.
      return load.state === "ok"
        ? { state: "ok", inputs: load.inputs, costReadFailed: load.costReadFailure !== null, fingerprint: owner.fingerprint }
        : { ...load, fingerprint: owner.fingerprint };
    });
  }

  /**
   * The rules conversion's dry run inputs (PR 11, plan 4.B.1, D14, D23), in
   * one read snapshot (inReadSnapshot) with no lock and no write: the owner by
   * member, by the predicate every read here uses (OWNER_SQL: the dry run is
   * never cached, so it reads no fingerprint), then the conversion's inputs
   * on the snapshot's one client (loadConversionInputsWithClient).
   */
  async loadConversionInputs(input: { memberId: string; storeConnectionId: number; now: Date }): Promise<ListingSettingsConversionLoad | null> {
    return this.inReadSnapshot(async (client) => {
      const vendorId = await readOwner(client, input);
      if (vendorId === null) return null;
      return loadConversionInputsWithClient(client, { vendorId, storeConnectionId: input.storeConnectionId, now: input.now },
        this.reportCostReadFailure);
    });
  }

  async readProductOwnSettings(input: {
    vendorId: number; storeConnectionId: number; productId: number; productVariantIds: readonly number[];
  }): Promise<ListingSettingsProductOwnRead> {
    // One snapshot, as the load: the row and the catalog facts its main text is checked against agree.
    return this.inReadSnapshot(async (client) => {
      const rows = await readProductListingSettings(client, {
        vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, productIds: [input.productId],
      });
      const row = rows.get(input.productId) ?? null;
      // Only a main text is checked against the catalog, so a product without one reads no catalog.
      const catalog = row?.values.mainText != null ? await readProductCatalog(client, input.productId, input.productVariantIds) : null;
      return { row, catalog };
    });
  }

  /**
   * load, loadConversionInputs and readProductOwnSettings each run in one
   * REPEATABLE READ READ ONLY snapshot on one pooled client, with no lock:
   * the views and the dry run never write, and a long scan must not block
   * listing queues. readFingerprint is the one small pool query outside it
   * (the views' cache key, read before load opens its snapshot). COMMIT, or
   * ROLLBACK on any failure (the read's own failure is the one thrown, a
   * failed COMMIT's included), and the client is released once on every path.
   */
  private async inReadSnapshot<T>(work: (client: Reader) => Promise<T>): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * The rules conversion's planner inputs for one store (PR 11, plan 4.B.1),
 * every read on `client` and so in the caller's transaction: the dry run's
 * read snapshot here, and the apply's own transaction (11c2, plan 7.B.3
 * step 9), so the apply plans over inputs composed exactly as the dry run's.
 * It opens, commits and rolls back nothing and takes no lock; the caller has
 * already resolved the store's owner (`vendorId`). In order: the read
 * model's own inputs (loadListingSettingsInputsWithClient); the categories
 * the store's category rules name, by exact name, active or not (plan D8;
 * the names come from the inputs just read, conversionCategoryNamesToRead,
 * so the planner and this read agree on them); every such category's
 * settings row, or null for one with none (the planner refuses a target
 * whose row was never read); and the store's saved product text in bytes,
 * by the store text cap's own statement (plan D9c). A store not on eBay or
 * over 10,000 sizes is passed through, unplanned.
 */
export async function loadConversionInputsWithClient(client: Reader,
  input: { vendorId: number; storeConnectionId: number; now: Date },
  reportCostReadFailure: ListingSettingsCostReadFailureReport): Promise<ListingSettingsConversionLoad> {
  const { vendorId, storeConnectionId } = input;
  const load = await loadListingSettingsInputsWithClient(client, input, reportCostReadFailure);
  if (load.state !== "ok") return { state: load.state, store: load.store };
  const listing = load.inputs;
  const categoriesByName = await readCatalogCategoriesByName(client, conversionCategoryNamesToRead(listing));
  const categoryIds = [...categoriesByName.values()].flatMap((categories) => categories.map((category) => category.id));
  // A key for every category named, chosen products or not: the planner refuses a target whose row was never read.
  const rows = await readCategoryListingSettings(client, { vendorId, storeConnectionId, categoryIds });
  const categoryRows = new Map(categoryIds.map((categoryId) => [categoryId, rows.get(categoryId) ?? null] as const));
  const storeTextBytes = await readStoreListingTextBytesWithClient(client, { vendorId, storeConnectionId });
  return { state: "ok", inputs: { listing, categoriesByName, categoryRows, storeTextBytes }, costReadFailure: load.costReadFailure };
}

/**
 * The read model's inputs for one store (Listing settings design 8.4), every
 * read on `client` and so in the caller's transaction: the views' snapshot,
 * and, through loadConversionInputsWithClient, the dry run's snapshot and
 * the apply's transaction (plan PR 11, 4.B.1, 7.B). It opens, commits and
 * rolls back nothing, and takes no lock; the caller has already resolved
 * the store's owner (`vendorId`). Only the .ops cost read sets its own
 * savepoint on the client (PgShellzClubProductCostAdapter.forTransaction). A
 * failed cost read leaves the costs unavailable, is told to
 * `reportCostReadFailure` and comes back as `costReadFailure` (its stage and
 * SQLSTATE), for the caller to decide on.
 */
export async function loadListingSettingsInputsWithClient(client: Reader,
  input: { vendorId: number; storeConnectionId: number; now: Date },
  reportCostReadFailure: ListingSettingsCostReadFailureReport): Promise<ListingSettingsInputsLoad> {
  const { vendorId, storeConnectionId } = input;
  const reader = PgDropshipListingPreviewRepository.readerForTransaction(client);
  const store = await reader.loadStoreContext({ vendorId, storeConnectionId });
  if (!store) throw new Error(`Listing settings found the owner of store ${storeConnectionId} but not its context.`);
  if (store.platform !== "ebay") return { state: "not_ebay", store };

  const pricing = await readPricingProfile(client, storeConnectionId, vendorId);
  const listingConfig = await reader.getStoreListingConfig(storeConnectionId);
  const ebayCategoryRules = await readEbayCategoryRules(client, vendorId, storeConnectionId);
  const content = await readContentProfile(client, vendorId, storeConnectionId);
  const storeLevel = { pricing, listingConfig, ebayCategoryRules, content };

  let candidates: ListingSettingsInputs["candidates"];
  try {
    candidates = await loadSelectedCandidates({ vendorId, ...selectedCatalogReaderForTransaction(client) }, input.now, "listing_settings");
  } catch (error) {
    if (error instanceof DropshipError && error.code === "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") {
      return { state: "too_large", store, storeLevel };
    }
    throw error;
  }

  const ids = candidates.map((row) => row.productVariantId);
  // The product and category settings, once, for every resolver below (plan D26), and the live names of
  // every chosen size's category (plan D19), which the category views show (PR 9e, plan 8.11): one read
  // either way, and a superset of the categories with settings. Plain reads in this snapshot, like
  // everything else here.
  const layers = await readListingSettingLayers(client, { vendorId, storeConnectionId, candidates });
  const categoryNames = await readCatalogCategoryNames(client,
    [...new Set(candidates.flatMap((row) => row.categoryId === null ? [] : [row.categoryId]))]);
  const categoryMoves = await readCategoryMoveInputs(client, { vendorId, storeConnectionId, candidates });
  let costReadFailure: ListingSettingsCostReadFailure | null = null;
  const costs = await PgShellzClubProductCostAdapter.forTransaction(client, (failure) => {
    // Recorded before the report runs, so a report that throws (the adapter swallows it) cannot hide the failure.
    costReadFailure = { stage: failure.stage, sqlState: failure.sqlState };
    reportCostReadFailure({ vendorId, storeConnectionId, variantCount: failure.variantCount, stage: failure.stage, sqlState: failure.sqlState });
  }).loadProductCosts({ vendorId, productVariantIds: ids });
  const preparedCategories = prepareEbayCategoryRules(ebayCategoryRules.revisionId, ebayCategoryRules.profile, layers);
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
    layers,
    categoryNames,
    categoryMoves,
  };
  return { state: "ok", inputs, costReadFailure };
}

/**
 * What "Card Shellz updated products" needs (plan PR 9, 10.6), in the load's
 * snapshot and with no lock (the marks reader without `forUpdate`): the marks
 * of the chosen products, then, only for products whose mark's category
 * differs from their current one, the settings rows and live names of the
 * categories they came from. Both reads are skipped when no product moved, so
 * a store without moves pays one indexed read. Kept out of `layers` and
 * `categoryNames`, which the other views read (the PostgreSQL suite pins
 * them).
 */
async function readCategoryMoveInputs(client: Reader, input: {
  vendorId: number;
  storeConnectionId: number;
  candidates: ListingSettingsInputs["candidates"];
}): Promise<ListingSettingsInputs["categoryMoves"]> {
  const { vendorId, storeConnectionId } = input;
  const currentCategory = new Map(input.candidates.map((row) => [row.productId, row.categoryId]));
  const marks = await readProductCategoryMarks(client, { vendorId, storeConnectionId, productIds: [...currentCategory.keys()] });
  const fromCategoryIds = [...new Set([...marks.values()].flatMap((mark) =>
    mark.categoryId !== null && mark.categoryId !== currentCategory.get(mark.productId) ? [mark.categoryId] : []))];
  return {
    marks,
    fromCategories: fromCategoryIds.length === 0 ? new Map()
      : await readCategoryListingSettings(client, { vendorId, storeConnectionId, categoryIds: fromCategoryIds }),
    fromCategoryNames: await readCatalogCategoryNames(client, fromCategoryIds),
  };
}

/**
 * The product's catalog facts its own main text is checked against
 * (productCatalogHash), from the same catalog read the views and W5 use
 * (listCatalogCandidates), so the check here is the one they make. Every fact
 * is a product column, so the size with the lowest id the catalog still lists
 * gives them; null when it lists none of `productVariantIds` for the product.
 * Only those facts are kept: a description can be long.
 */
async function readProductCatalog(client: Reader, productId: number, productVariantIds: readonly number[]):
  Promise<ListingSettingsProductOwnRead["catalog"]> {
  const candidates = await PgDropshipListingPreviewRepository.readerForTransaction(client).listCatalogCandidates(productVariantIds);
  const first = candidates.filter((candidate) => candidate.productId === productId)
    .sort((left, right) => left.productVariantId - right.productVariantId)[0];
  return first === undefined ? null : {
    productId: first.productId, description: first.description, brand: first.brand, condition: first.condition,
    itemSpecifics: first.itemSpecifics,
  };
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
