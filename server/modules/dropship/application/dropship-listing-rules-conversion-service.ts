import { z } from "zod";
import type { EbayCategoryRulesProfile } from "../../../../shared/dropship/ebay-category-rules";
import type { ContentProfile } from "../../../../shared/dropship/listing-content";
import {
  LISTING_RULES_CONVERSION_ERROR_CODES,
  MAX_CONVERSION_REMOVED_RULES,
  listingRulesConversionApplyInputSchema,
  type ConversionChangedReason,
  type ListingRuleConversionActorType,
  type ListingRuleConversionRecord,
  type ListingRulesConversionApplyResponse,
} from "../../../../shared/dropship/listing-rules-conversion";
import { RULES_CONVERSION_SYSTEM_KEY_PREFIX } from "../../../../shared/dropship/listing-rules-conversion-keys";
import { LISTING_SETTING_KEY_PATTERN, type CategoryListingSettingPatch, type ProductListingSettingPatch } from "../../../../shared/dropship/listing-setting-values";
import {
  LISTING_SETTING_BUSY_REASONS,
  LISTING_SETTING_WRITE_ERROR_CODES,
  MAX_STORE_LISTING_TEXT_BYTES,
} from "../../../../shared/dropship/listing-setting-writes";
import type { PricingProfile } from "../../../../shared/dropship/pricing-rules";
import { DropshipError } from "../domain/errors";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import type { DropshipListingStoreContext } from "./dropship-listing-preview-service";
import { checkRulesConversion, type ConversionInputs, type RulesConversionPlan } from "./dropship-listing-rules-conversion";
import {
  MAX_LISTED_SIZES,
  WRITABLE_ENTITLEMENT_STATUS,
  WRITABLE_STORE_STATUSES,
  WRITABLE_VENDOR_STATUSES,
  assertListingSettingMember,
  authorizeListingSettingWrite,
  listingSettingKeyConflict,
  listingSettingStoreIdSchema,
  listingSettingStoreTextLimit,
  listingSettingWriteHash,
  parseListingSettingInput,
  type ListingSettingHeavyWriteGate,
  type ListingSettingWriteLog,
} from "./dropship-listing-setting-write-support";
import type { CategoryListingSettingSaveResult } from "./dropship-listing-setting-writes";
import type { OlderGroupRuleCounts } from "./dropship-listing-settings-facts";
import {
  conversionCostReadFailedError,
  type ListingSettingsConversionLoad,
  type ListingSettingsCostReadFailure,
} from "./dropship-listing-settings-service";
import type { DropshipClock } from "./dropship-ports";

/**
 * Moving a store's older group rules into category and product settings, as
 * one transaction per store (PR 11, plan 7.B; design record 8.7, REC:899-900):
 * the vendor's apply from the sheet (here), and the same transaction body for
 * the system job (11e2, convertInTransaction's system mode). One writer, two
 * actors (plan D10).
 *
 * The body (convertInTransaction) runs plan 7.B.3's steps 5-16 in order, on
 * the transaction object the repository opened with steps 1-4 (BEGIN, the
 * request lock for the vendor, the store lock, the owner rows FOR SHARE):
 *  5. the gate, then the record under this key (vendor: a replay, or the key
 *     used for another plan) or any record of the store (system: converted
 *     once, ever, plan D20);
 *  6. the older rules' counts: none → `nothing_to_convert`, no write;
 *  7. the selection lock, then the chosen sizes (over 10,000 → too large);
 *  8. categories, products and sizes FOR SHARE, ascending;
 *  9. the planner's inputs on this client (loadConversionInputsWithClient) and
 *     the plan (checkRulesConversion); a failed .ops cost read stops here;
 * 10. the decision: the vendor's hashes (the writes first, then the plan),
 *     then what blocks the move; the system applies only a clean store;
 * 11. the conversion record (it claims the key);
 * 12. category settings, ascending; 13. product values; 14. the profiles that
 *     held groups, emptied; 15. first marks; 16. the store's audit row.
 * The repository COMMITs (step 17) only a body that wrote; the INFO line
 * follows the COMMIT (applyForMember).
 *
 * Pure orchestration: every read and write is the transaction object's, the
 * plan is the planner's, the clock is read once by the caller. No money is
 * computed here: the plan writes recipes, never cents (plan 7.B.3).
 */

/** The request hash's operation (plan 3.3): with the store and the plan hash, what every revision of the apply carries. */
export const RULES_CONVERSION_OPERATION = "rules_conversion_v1";
/** Seconds before resending an apply whose catalog moved under it (the wait of every listing-settings BUSY). */
const CATALOG_CHANGED_RETRY_AFTER_SECONDS = 5;

/** The system job's key for a store (plan D12, 3.3): `rules-conversion:<storeConnectionId>`. */
export function rulesConversionSystemKey(storeConnectionId: number): string {
  if (!Number.isSafeInteger(storeConnectionId) || storeConnectionId <= 0) {
    throw listingSettingsInvariantFailed("The rules conversion's system key needs a store id.");
  }
  return `${RULES_CONVERSION_SYSTEM_KEY_PREFIX}${storeConnectionId}`;
}

/** The request hash a conversion's record and revisions carry (plan 3.3): the operation, the store and the plan hash. */
export function rulesConversionRequestHash(storeConnectionId: number, planHash: string): string {
  return listingSettingWriteHash(RULES_CONVERSION_OPERATION, { storeConnectionId, planHash });
}

// ---------------------------------------------------------------------------
// The port (types only; the repository is S/infrastructure/dropship-listing-rules-conversion.repository.ts)
// ---------------------------------------------------------------------------

export interface ListingRulesConversionActor {
  actorType: ListingRuleConversionActorType;
  actorId: string;
}

/** Who opens the transaction: the vendor by member and key, or the system job for one store (its key is the store's own). */
export type ListingRulesConversionExecuteInput =
  | { actorType: "vendor"; memberId: string; storeConnectionId: number; idempotencyKey: string }
  | { actorType: "system"; jobKey: string; storeConnectionId: number };

/** The chosen sizes, their products, and the categories to lock (the chosen products' and every rule's target), ascending. */
export type ListingRulesConversionChosenIds =
  | { state: "ok"; productVariantIds: number[]; productIds: number[]; categoryIds: number[] }
  | { state: "too_large" };

/** What lockCatalog found and locked, ascending: a row Card Shellz deleted is not among them. */
export interface ListingRulesConversionLockedCatalog {
  categoryIds: number[];
  productIds: number[];
  productVariantIds: number[];
}

/** The record the apply writes first (plan 12): everything but the key, the actor and the ids, which are the transaction's. */
export interface ListingRulesConversionRecordInput {
  requestHash: string;
  planHash: string;
  writesHash: string;
  clean: boolean;
  changedSizeCount: number;
  categoryCount: number;
  productCount: number;
  pricingGroupsRemoved: number;
  contentGroupsRemoved: number;
  ebayRulesRemoved: number;
  now: Date;
}

/** One older rule the move removed, for the store's audit row: its id, name and scope kind. */
const removedRuleSchema = z.object({ id: z.string().min(1), name: z.string().min(1), scopeType: z.string().min(1) }).strict();
const auditIds = z.array(z.number().int().positive()).max(MAX_LISTED_SIZES);
const auditCount = z.number().int().nonnegative();
const auditRevisionId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();

/**
 * The store's `listing_rules_converted` audit row (plan 7.B.3 step 16): the
 * record, its hashes and counts, the rules removed (at most 100 of each, the
 * profiles' own caps) and at most 100 category and product ids, with every
 * total beside them. Ids, names and counts only; each value a revision
 * changed is in that revision's own audit row. `revisions` names the three
 * profile revisions the move wrote (null for a profile it left alone), so
 * this row leads to the pricing, description and eBay rules audit rows
 * (CLAUDE.md §10): the description and eBay rules rows' payloads do not name
 * the conversion; the pricing row's carries its `conversionId`. Category and
 * product revisions carry the conversion's `lc:` keys.
 */
export const listingRulesConvertedAuditSchema = z.object({
  conversionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestKey: z.string().regex(LISTING_SETTING_KEY_PATTERN),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  writesHash: z.string().regex(/^[a-f0-9]{64}$/),
  clean: z.boolean(),
  counts: z.object({ categories: auditCount, products: auditCount, changedSizes: auditCount, firstMarks: auditCount }).strict(),
  removed: z.object({
    pricingGroups: z.array(removedRuleSchema).max(MAX_CONVERSION_REMOVED_RULES),
    contentGroups: z.array(removedRuleSchema).max(MAX_CONVERSION_REMOVED_RULES),
    ebayRules: z.array(removedRuleSchema).max(MAX_CONVERSION_REMOVED_RULES),
  }).strict(),
  categoryIds: auditIds,
  productIds: auditIds,
  revisions: z.object({ pricing: auditRevisionId, content: auditRevisionId, ebayRules: auditRevisionId }).strict(),
}).strict();
export type ListingRulesConvertedAudit = z.infer<typeof listingRulesConvertedAuditSchema>;

/**
 * One store's conversion transaction (plan 7.B.3, D10, D13), opened by the
 * repository under the store lock (and, for the vendor, the request lock),
 * with the owner rows held FOR SHARE. Every read and write runs on the
 * transaction's own client. The calls run in the order they are declared
 * here, each at most once, any of them skipped; a call out of that order, a
 * second call, a writer before the record or after the store audit row, and
 * any call after the body returns are DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED
 * (fatal). A writer's version conflict here is a broken contract, since every
 * writer of these rows takes the store lock: it is raised as
 * DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED with the writer's code in
 * `context.causeCode` (plan D24), never as a conflict to retry.
 */
export interface ListingRulesConversionTransaction {
  readonly vendorId: number;
  readonly storeConnectionId: number;
  readonly actor: ListingRulesConversionActor;
  /** The conversion's key: the vendor's request key, or the system's `rules-conversion:<store>`. */
  readonly requestKey: string;
  /** The store context the gate decides on (loadStoreContext on this client); null when there is none. */
  authorize(): Promise<DropshipListingStoreContext | null>;
  /** The record this vendor wrote under this key, or null (the replay check, plan 3.3). No lock: the key's lock is held. */
  findConversionByKey(): Promise<ListingRuleConversionRecord | null>;
  /** Whether any conversion of this store was ever recorded, by either actor (plan D20). */
  hasAnyConversion(): Promise<boolean>;
  /** D16's counts over the store's three profiles, read on this client. */
  loadOlderGroupRuleCounts(): Promise<OlderGroupRuleCounts>;
  /** The selection tables in SHARE MODE (the W9 and content writers' locks): no selection or catalog rule changes until commit. */
  lockSelection(): Promise<void>;
  /** The chosen sizes (the read model's own selection, over 10,000 refused) and the categories to lock. */
  listChosenIds(now: Date): Promise<ListingRulesConversionChosenIds>;
  /** Categories, products and sizes FOR SHARE, in that order, each ascending; once, before any write. */
  lockCatalog(input: { categoryIds: readonly number[]; productIds: readonly number[]; productVariantIds: readonly number[] }):
    Promise<ListingRulesConversionLockedCatalog>;
  /** The planner's inputs on this client (loadConversionInputsWithClient), composed exactly as the dry run's. */
  loadInputs(now: Date): Promise<ListingSettingsConversionLoad>;
  /** The record, first of the writes: it claims the key (UNIQUE (vendor_id, idempotency_key)). */
  insertConversion(input: ListingRulesConversionRecordInput): Promise<ListingRuleConversionRecord>;
  /** Each category in ascending id through the category writer, under its `lc:…:category:<id>` key. */
  saveCategories(input: {
    categories: ReadonlyArray<{ categoryId: number; expectedRevisionId: number | null; patch: CategoryListingSettingPatch }>;
    requestHash: string;
    now: Date;
  }): Promise<CategoryListingSettingSaveResult[]>;
  /** Each product its own patch, set-based (the per-product writer), under `lc:…:product:<id>` keys. */
  saveProducts(input: {
    products: ReadonlyArray<{ productId: number; expectedRevisionId: number | null; patch: ProductListingSettingPatch }>;
    requestHash: string;
    now: Date;
  }): Promise<{ changed: Array<{ productId: number; revisionId: number }>; unchangedProductIds: number[] }>;
  /** The pricing profile with its groups emptied: a revision, the head and one audit row, no per-size row (plan D11). */
  savePricingProfile(input: { expectedRevisionId: number; profile: PricingProfile; now: Date }):
    Promise<{ revisionId: number; previousRevisionId: number | null }>;
  /** The description profile with its groups emptied, under `lc:…:content_profile:<store>`. */
  saveContentProfile(input: { expectedRevisionId: number; profile: ContentProfile; requestHash: string; now: Date }):
    Promise<{ revisionId: number }>;
  /** The eBay category rules, version 1 with `rules: []` and its default kept (plan D7), under `lc:…:ebay_rules:<store>`. */
  saveEbayCategoryRules(input: { expectedRevisionId: number; profile: EbayCategoryRulesProfile; requestHash: string; now: Date }):
    Promise<{ revisionId: number }>;
  /** First marks for the given chosen products that have none (ON CONFLICT DO NOTHING; one audit row when it inserts). */
  insertFirstCategoryMarks(input: { productIds: readonly number[]; now: Date }): Promise<{ insertedProductIds: number[] }>;
  /** The store's `listing_rules_converted` audit row, last of the writes. */
  insertStoreAudit(input: { payload: ListingRulesConvertedAudit; now: Date }): Promise<void>;
}

export interface ListingRulesConversionRepository {
  /**
   * One transaction, READ COMMITTED (plan D13): BEGIN, the request lock (the
   * vendor only), the store lock, the owner rows FOR SHARE (by member, or by
   * store for the system), then the body. COMMIT when the body wrote (its
   * record, its writes and its store audit row together); ROLLBACK when it
   * wrote nothing or threw, with the original error, mapped once.
   */
  executeConversion<T>(input: ListingRulesConversionExecuteInput,
    operation: (tx: ListingRulesConversionTransaction) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// The transaction body (plan 7.B.3), shared by both actors
// ---------------------------------------------------------------------------

/**
 * The vendor applies only the plan he was shown (plan D1): both hashes of
 * his dry run. The system applies only a clean store (11e2).
 */
export type ConversionMode =
  | { kind: "vendor"; expectedPlanHash: string; expectedWritesHash: string }
  | { kind: "system" };

/** Why the system leaves a store alone at the gate (plan 13.2, 13.7): expected, never retried as a fault. */
export type ConversionSkipReason = "store_not_found" | "not_ebay" | "vendor_not_eligible" | "vendor_not_entitled" | "store_not_eligible";

/**
 * What one transaction did. The vendor's refusals are thrown (plan 3.4); the
 * system's expected outcomes are answers, so the job can count them (11e2):
 * - `converted`: the record, the writes and the audit rows commit together;
 * - `replayed` (vendor): this key already converted; nothing written;
 * - `nothing_to_convert`: the store holds no older group rules; nothing written;
 * - `skipped`, `already_converted`, `too_large`, `not_clean` (system only):
 *   nothing written.
 */
export type ConversionTransactionResult =
  | { outcome: "converted"; record: ListingRuleConversionRecord; marksInserted: number }
  | { outcome: "replayed"; record: ListingRuleConversionRecord }
  | { outcome: "nothing_to_convert" }
  | { outcome: "skipped"; reason: ConversionSkipReason }
  | { outcome: "already_converted" }
  | { outcome: "too_large" }
  | { outcome: "not_clean"; changedSizeCount: number; wouldLosePriceCount: number; wouldBlockListingCount: number; tooMuchText: boolean };

/**
 * Plan 7.B.3's steps 5-16 for one store, in order, for either actor (see the
 * module comment). `now` is the caller's one clock reading. Writes only when
 * the vendor's hashes are the ones recomputed here and nothing blocks the
 * move, or (system) when the store is clean; every refusal comes before the
 * first write, so a refused apply writes nothing. A plan that does not belong
 * to the locked catalog, or a writer that answers outside its contract, is a
 * fatal invariant; a catalog that moved under the locks' gaps (a new size)
 * is the transient BUSY, retried with the same key.
 */
export async function convertInTransaction(tx: ListingRulesConversionTransaction, mode: ConversionMode,
  now: Date): Promise<ConversionTransactionResult> {
  const { storeConnectionId } = tx;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw listingSettingsInvariantFailed("A rules conversion needs the caller's clock reading.", { storeConnectionId });
  }
  if (tx.actor.actorType !== mode.kind) {
    throw listingSettingsInvariantFailed("A rules conversion's mode is not its transaction's actor.", { storeConnectionId });
  }

  // 5. The gate, then the record (replay or the system's converted-once rule).
  const store = await tx.authorize();
  if (mode.kind === "vendor") {
    await authorizeListingSettingWrite({ vendorId: tx.vendorId, storeConnectionId, catalog: { loadStoreContext: async () => store } });
    const requestHash = rulesConversionRequestHash(storeConnectionId, mode.expectedPlanHash);
    const earlier = await tx.findConversionByKey();
    if (earlier !== null) {
      const mismatched = [
        earlier.storeConnectionId === storeConnectionId ? null : "storeConnectionId",
        earlier.requestHash === requestHash ? null : "requestHash",
      ].filter((field): field is string => field !== null);
      if (mismatched.length > 0) throw listingSettingKeyConflict(mismatched, { storeConnectionId });
      return { outcome: "replayed", record: earlier };
    }
  } else {
    const skip = systemSkipReason(store);
    if (skip !== null) return { outcome: "skipped", reason: skip };
    if (await tx.hasAnyConversion()) return { outcome: "already_converted" };
  }

  // 6. Nothing to move: no write, no record (a store the vendor already moved answers here too).
  const counts = await tx.loadOlderGroupRuleCounts();
  if (counts.pricingGroups + counts.contentGroups + counts.ebayCategoryRules === 0) return { outcome: "nothing_to_convert" };

  // 7. The selection, under its SHARE locks.
  await tx.lockSelection();
  const chosen = await tx.listChosenIds(now);
  if (chosen.state === "too_large") {
    if (mode.kind === "system") return { outcome: "too_large" };
    throw selectionTooLarge(storeConnectionId);
  }

  // 8. The catalog rows the plan reads and writes, FOR SHARE; a row deleted since step 7 means the catalog moved.
  const locked = await tx.lockCatalog({
    categoryIds: chosen.categoryIds, productIds: chosen.productIds, productVariantIds: chosen.productVariantIds,
  });
  if (!sameIds(locked.categoryIds, chosen.categoryIds) || !sameIds(locked.productIds, chosen.productIds)
    || !sameIds(locked.productVariantIds, chosen.productVariantIds)) {
    throw catalogChanged(storeConnectionId);
  }

  // 9. The inputs on this client, then the plan.
  const load = await tx.loadInputs(now);
  if (load.state === "not_ebay") {
    throw listingSettingsInvariantFailed("A rules conversion's store left eBay under its locked owner rows.", { storeConnectionId });
  }
  // Over 10,000 now, or other sizes than step 7 locked: a size Card Shellz added between the two reads.
  if (load.state === "too_large") throw catalogChanged(storeConnectionId);
  if (load.costReadFailure !== null) throw conversionCostReadFailedError(storeConnectionId, load.costReadFailure);
  const inputs = load.inputs;
  assertInputsOfLockedCatalog(inputs, locked, storeConnectionId);
  const { plan, diff } = checkRulesConversion(inputs);
  if (diff.hashes === null || diff.state === "no_older_rules" || !sameCounts(plan.olderRules, counts)) {
    throw listingSettingsInvariantFailed("A rules conversion's plan disagrees with the older rules it locked.", { storeConnectionId });
  }
  assertPlanOfLockedCatalog(plan, locked, storeConnectionId);

  // 10. The decision, before any write.
  if (mode.kind === "vendor") {
    if (diff.hashes.writesHash !== mode.expectedWritesHash) throw conversionChanged(storeConnectionId, "settings_changed");
    if (diff.hashes.planHash !== mode.expectedPlanHash) throw conversionChanged(storeConnectionId, "listed_changes_moved");
    if (diff.blocked.wouldLosePrice.length > 0) throw wouldLosePrice(storeConnectionId, diff.blocked.wouldLosePrice);
    if (diff.blocked.wouldBlockListing.length > 0) throw wouldBlockListing(storeConnectionId, diff.blocked.wouldBlockListing);
    if (diff.blocked.tooMuchText) {
      throw listingSettingStoreTextLimit(storeConnectionId, inputs.storeTextBytes + diff.blocked.addedProductTextBytes, MAX_STORE_LISTING_TEXT_BYTES);
    }
  } else if (diff.state !== "clean") {
    return {
      outcome: "not_clean", changedSizeCount: diff.rows.length, wouldLosePriceCount: diff.blocked.wouldLosePrice.length,
      wouldBlockListingCount: diff.blocked.wouldBlockListing.length, tooMuchText: diff.blocked.tooMuchText,
    };
  }

  // 11-16. The writes, in plan D13's order; each revision carries the request hash, each audit row the actor.
  const { planHash, writesHash } = diff.hashes;
  const requestHash = rulesConversionRequestHash(storeConnectionId, planHash);
  const profiles = emptiedProfiles(inputs, plan, storeConnectionId);
  const record = await tx.insertConversion({
    // A clean plan has no changed row (the record's CHECK holds it); the vendor's may.
    requestHash, planHash, writesHash, clean: diff.state === "clean", changedSizeCount: diff.rows.length,
    categoryCount: plan.categories.length, productCount: plan.products.length,
    pricingGroupsRemoved: plan.profiles.pricing?.removedIds.length ?? 0,
    contentGroupsRemoved: plan.profiles.content?.removedIds.length ?? 0,
    ebayRulesRemoved: plan.profiles.ebayRules?.removedIds.length ?? 0,
    now,
  });
  if (plan.categories.length > 0) {
    const saved = await tx.saveCategories({
      categories: plan.categories.map((write) => ({ categoryId: write.categoryId, expectedRevisionId: write.expectedRevisionId, patch: write.patch })),
      requestHash, now,
    });
    assertEachChanged(saved.map((result) => result.outcome), plan.categories.length, "category", storeConnectionId);
  }
  if (plan.products.length > 0) {
    const saved = await tx.saveProducts({
      products: plan.products.map((write) => ({ productId: write.productId, expectedRevisionId: write.expectedRevisionId, patch: write.patch })),
      requestHash, now,
    });
    if (saved.unchangedProductIds.length > 0 || !sameIds(saved.changed.map((entry) => entry.productId), plan.products.map((write) => write.productId))) {
      throw listingSettingsInvariantFailed("A rules conversion's product write left a planned product unchanged.", { storeConnectionId });
    }
  }
  const revisions = {
    pricing: profiles.pricing === null ? null : (await tx.savePricingProfile({ ...profiles.pricing, now })).revisionId,
    content: profiles.content === null ? null : (await tx.saveContentProfile({ ...profiles.content, requestHash, now })).revisionId,
    ebayRules: profiles.ebayRules === null ? null
      : (await tx.saveEbayCategoryRules({ ...profiles.ebayRules, requestHash, now })).revisionId,
  };
  const marks = plan.firstMarks.length > 0
    ? await tx.insertFirstCategoryMarks({ productIds: plan.firstMarks, now })
    : { insertedProductIds: [] };
  await tx.insertStoreAudit({ payload: storeAuditPayload({ record, plan, inputs, requestKey: tx.requestKey,
    changedSizeCount: record.changedSizeCount, firstMarks: marks.insertedProductIds.length, revisions }), now });
  return { outcome: "converted", record, marksInserted: marks.insertedProductIds.length };
}

/**
 * The system job's gate (plan 13.2): an eBay store, `connected`,
 * `needs_reauth` or `refresh_failed`, of an `active` or `onboarding` vendor
 * whose .ops entitlement is `active`: the write gate's own two allow-lists
 * and its entitlement rule (authorizeListingSettingWrite), which 11e2's store
 * query binds too, so the query and this re-check never differ. The
 * entitlement is read from authorize()'s context under the owner rows' FOR
 * SHARE, as the vendor's own write gate reads it: the system never makes a
 * write the vendor himself could not make.
 */
function systemSkipReason(store: DropshipListingStoreContext | null): ConversionSkipReason | null {
  if (store === null) return "store_not_found";
  if (store.platform !== "ebay") return "not_ebay";
  if (!WRITABLE_VENDOR_STATUSES.has(store.vendorStatus)) return "vendor_not_eligible";
  if (store.entitlementStatus !== WRITABLE_ENTITLEMENT_STATUS) return "vendor_not_entitled";
  if (!WRITABLE_STORE_STATUSES.has(store.storeStatus)) return "store_not_eligible";
  return null;
}

/**
 * The plan was built from rows the locks hold: the same chosen sizes step 7
 * locked, each under a product and in a category step 8 locked, and every
 * category a rule names among the locked ones. Step 8's FOR SHARE holds only
 * what it finds, so a change Card Shellz committed between step 7's read and
 * step 8's lock is not held: a size added, a size moved to another product, a
 * product moved to another category, or a category renamed into a rule's
 * name. Then the apply stops (transient: its retry reads and locks again and,
 * for the vendor, answers CHANGED when the plan moved).
 */
function assertInputsOfLockedCatalog(inputs: ConversionInputs, locked: ListingRulesConversionLockedCatalog, storeConnectionId: number): void {
  const { candidates } = inputs.listing;
  const sizes = candidates.map((candidate) => candidate.productVariantId).sort((left, right) => left - right);
  const lockedProducts = new Set(locked.productIds);
  const lockedCategories = new Set(locked.categoryIds);
  const targets = [...inputs.categoriesByName.values()].flatMap((categories) => categories.map((category) => category.id));
  if (!sameIds(sizes, locked.productVariantIds)
    || !candidates.every((candidate) => lockedProducts.has(candidate.productId))
    || !candidates.every((candidate) => candidate.categoryId === null || lockedCategories.has(candidate.categoryId))
    || !targets.every((categoryId) => lockedCategories.has(categoryId))) {
    throw catalogChanged(storeConnectionId);
  }
}

/** Every row the plan writes is one the locks hold; the inputs already are, so a breach is the planner's fault. */
function assertPlanOfLockedCatalog(plan: RulesConversionPlan, locked: ListingRulesConversionLockedCatalog, storeConnectionId: number): void {
  const categories = new Set(locked.categoryIds);
  const products = new Set(locked.productIds);
  if (!plan.categories.every((write) => categories.has(write.categoryId))
    || !plan.products.every((write) => products.has(write.productId))
    || !plan.firstMarks.every((productId) => products.has(productId))) {
    throw listingSettingsInvariantFailed("A rules conversion's plan writes a catalog row its transaction did not lock.", { storeConnectionId });
  }
}

interface EmptiedProfiles {
  pricing: { expectedRevisionId: number; profile: PricingProfile } | null;
  content: { expectedRevisionId: number; profile: ContentProfile } | null;
  ebayRules: { expectedRevisionId: number; profile: EbayCategoryRulesProfile } | null;
}

/**
 * The three profiles the plan empties, each at the revision the plan read,
 * with the store defaults kept (plan D5, D7): every group (or rule) removed,
 * nothing else changed. A plan that names another revision, or groups other
 * than the profile's, does not belong to these inputs.
 */
function emptiedProfiles(inputs: ConversionInputs, plan: RulesConversionPlan, storeConnectionId: number): EmptiedProfiles {
  const { pricing, content, ebayCategoryRules } = inputs.listing;
  const planned = <P>(kind: string, state: { revisionId: number | null; profile: P | null }, ids: readonly string[] | undefined,
    write: RulesConversionPlan["profiles"]["pricing"]): { expectedRevisionId: number; profile: P } | null => {
    if (write === null) return null;
    if (state.profile === null || state.revisionId !== write.expectedRevisionId || !sameStrings(ids ?? [], write.removedIds)) {
      throw listingSettingsInvariantFailed("A rules conversion's plan empties a profile its inputs do not hold.", { storeConnectionId, kind });
    }
    return { expectedRevisionId: write.expectedRevisionId, profile: state.profile };
  };
  const pricingWrite = planned("pricing", pricing, pricing.profile?.groups.map((group) => group.id), plan.profiles.pricing);
  const contentWrite = planned("content", content, content.profile?.groups.map((group) => group.id), plan.profiles.content);
  const ebayWrite = planned("ebay_rules", ebayCategoryRules, ebayCategoryRules.profile?.rules.map((rule) => rule.id), plan.profiles.ebayRules);
  return {
    pricing: pricingWrite && { expectedRevisionId: pricingWrite.expectedRevisionId, profile: { ...pricingWrite.profile, groups: [] } },
    content: contentWrite && { expectedRevisionId: contentWrite.expectedRevisionId, profile: { ...contentWrite.profile, groups: [] } },
    ebayRules: ebayWrite && { expectedRevisionId: ebayWrite.expectedRevisionId, profile: { ...ebayWrite.profile, rules: [] } },
  };
}

/** The store's audit row (plan 7.B.3 step 16). */
function storeAuditPayload(input: {
  record: ListingRuleConversionRecord; plan: RulesConversionPlan; inputs: ConversionInputs; requestKey: string;
  changedSizeCount: number; firstMarks: number; revisions: ListingRulesConvertedAudit["revisions"];
}): ListingRulesConvertedAudit {
  const { record, plan, inputs } = input;
  const { pricing, content, ebayCategoryRules } = inputs.listing;
  const removed = (rules: ReadonlyArray<{ id: string; name: string; scope: { type: string } }>) => rules
    .slice(0, MAX_CONVERSION_REMOVED_RULES).map((rule) => ({ id: rule.id, name: rule.name, scopeType: rule.scope.type }));
  return {
    conversionId: record.id,
    requestKey: input.requestKey,
    planHash: record.planHash,
    writesHash: record.writesHash,
    clean: record.clean,
    counts: { categories: plan.categories.length, products: plan.products.length, changedSizes: input.changedSizeCount, firstMarks: input.firstMarks },
    removed: {
      pricingGroups: plan.profiles.pricing === null ? [] : removed(pricing.profile?.groups ?? []),
      contentGroups: plan.profiles.content === null ? [] : removed(content.profile?.groups ?? []),
      ebayRules: plan.profiles.ebayRules === null ? [] : removed(ebayCategoryRules.profile?.rules ?? []),
    },
    categoryIds: plan.categories.map((write) => write.categoryId).slice(0, MAX_LISTED_SIZES),
    productIds: plan.products.map((write) => write.productId).slice(0, MAX_LISTED_SIZES),
    revisions: input.revisions,
  };
}

/** Under the store lock the plan's writes always change their rows: a replay or an unchanged row means a writer broke its contract. */
function assertEachChanged(outcomes: readonly string[], expected: number, writer: string, storeConnectionId: number): void {
  if (outcomes.length !== expected || outcomes.some((outcome) => outcome !== "changed")) {
    throw listingSettingsInvariantFailed("A rules conversion writer did not change a row its plan writes.", {
      storeConnectionId, writer, outcomes: [...new Set(outcomes)],
    });
  }
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const a = [...left].sort(order);
  const b = [...right].sort(order);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameCounts(left: OlderGroupRuleCounts, right: OlderGroupRuleCounts): boolean {
  return left.pricingGroups === right.pricingGroups && left.contentGroups === right.contentGroups
    && left.ebayCategoryRules === right.ebayCategoryRules;
}

// ---------------------------------------------------------------------------
// Refusals (plan 3.4); every one before the first write
// ---------------------------------------------------------------------------

function permanent(code: string, message: string, context: Record<string, unknown>): DropshipError {
  return new DropshipError(code, message, { ...context, retryable: false, classification: "permanent" });
}

/** The recomputed plan is not the one shown (plan 3.3, D1): the writes moved, or only the listed changes did. */
export function conversionChanged(storeConnectionId: number, reason: ConversionChangedReason): DropshipError {
  return permanent(LISTING_RULES_CONVERSION_ERROR_CODES.changed,
    "Your listings changed since you checked what moving the older group rules over does. Check again before moving them.",
    { storeConnectionId, reason });
}

function selectionTooLarge(storeConnectionId: number): DropshipError {
  return permanent("DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
    "More than 10,000 sizes are chosen for this store. Choose 10,000 or fewer to move its older group rules over.", { storeConnectionId });
}

/** D9a: a size with a usable price today would have none after the move (the save guard's own rule, in the planner). */
function wouldLosePrice(storeConnectionId: number, sizes: ReadonlyArray<{ productVariantId: number; priceCents: number | null }>): DropshipError {
  return permanent("DROPSHIP_LISTING_PRICE_WOULD_BE_LOST",
    "Moving the older group rules over would leave some sizes without a price. Give them a price first.", {
      storeConnectionId, sizeCount: sizes.length,
      sizes: sizes.slice(0, MAX_LISTED_SIZES).map((size) => ({ productVariantId: size.productVariantId, priceCents: size.priceCents })),
    });
}

/** D9b: a size listed on eBay that can be sent today would be blocked after the move, and stop getting stock updates. */
function wouldBlockListing(storeConnectionId: number,
  sizes: ReadonlyArray<{ productVariantId: number; reasons: readonly string[] }>): DropshipError {
  return permanent(LISTING_RULES_CONVERSION_ERROR_CODES.wouldBlockListing,
    "Moving the older group rules over would stop some listed sizes from getting stock updates. Fix them first.", {
      storeConnectionId, sizeCount: sizes.length,
      sizes: sizes.slice(0, MAX_LISTED_SIZES).map((size) => ({ productVariantId: size.productVariantId, blockers: [...size.reasons] })),
    });
}

/**
 * Card Shellz added, moved or renamed a catalog row between the chosen-size
 * read and the load, or removed one before its lock (assertInputsOfLockedCatalog):
 * transient, raised before any write, because the retry reads and locks again
 * (and answers CHANGED when the plan moved).
 */
function catalogChanged(storeConnectionId: number): DropshipError {
  return new DropshipError(LISTING_SETTING_WRITE_ERROR_CODES.busy, "Card Shellz products changed while this was being saved. Try again.", {
    storeConnectionId, reason: LISTING_SETTING_BUSY_REASONS.catalogChanged, retryAfterSeconds: CATALOG_CHANGED_RETRY_AFTER_SECONDS,
    retryable: true, classification: "transient",
  });
}

// ---------------------------------------------------------------------------
// The vendor's apply (plan 7.B.2)
// ---------------------------------------------------------------------------

export interface DropshipListingRulesConversionServiceDependencies {
  repository: ListingRulesConversionRepository;
  clock: DropshipClock;
  /** Monotonic milliseconds, for `elapsed_ms` only; the write's time is `clock`, read once. */
  timer: () => number;
  log: ListingSettingWriteLog;
  /** The factory's one heavy-write gate (plan 3.10 (a)): an apply holds up to 10,000 sizes' plan. */
  heavyWrites: Pick<ListingSettingHeavyWriteGate, "run">;
}

/** The success line's action (plan 3.5): one per answered apply, after COMMIT. */
export const RULES_CONVERSION_APPLIED_ACTION = "dropship.listing_settings.rules_conversion_applied";
/** A failed .ops cost read inside a conversion's load (plan D14), told by the repository while the load goes on. */
export const RULES_CONVERSION_COST_READ_FAILED_ACTION = "dropship.listing_settings.rules_conversion_cost_read_failed";

/** The outcomes a transaction answers with a record or with nothing to move: the ones the success line reports. */
export type AnsweredConversionResult = Extract<ConversionTransactionResult, { outcome: "converted" | "replayed" | "nothing_to_convert" }>;

/**
 * The success line's fields (plan 3.5), for either actor, so one query on
 * RULES_CONVERSION_APPLIED_ACTION returns every conversion: ids and counts
 * only, never a text value or a name. A replay's `before`, `after` and
 * `marks_inserted` are unknown (they are in its record and audit rows), so
 * null, not 0.
 */
export function rulesConversionAppliedLogFields(input: {
  result: AnsweredConversionResult;
  vendorId: number;
  storeConnectionId: number;
  actor: ListingRulesConversionActor;
  requestKey: string;
  elapsedMs: number;
}): Record<string, unknown> {
  const { result } = input;
  const record = result.outcome === "nothing_to_convert" ? null : result.record;
  return {
    outcome: result.outcome,
    vendor_id: input.vendorId,
    store_connection_id: input.storeConnectionId,
    actor_type: input.actor.actorType,
    actor_id: input.actor.actorId,
    request_key: input.requestKey,
    conversion_id: record?.id ?? null,
    plan_hash: record?.planHash ?? null,
    clean: record?.clean ?? null,
    category_count: record?.categoryCount ?? 0,
    product_count: record?.productCount ?? 0,
    pricing_groups_removed: record?.pricingGroupsRemoved ?? 0,
    content_groups_removed: record?.contentGroupsRemoved ?? 0,
    ebay_rules_removed: record?.ebayRulesRemoved ?? 0,
    changed_size_count: record?.changedSizeCount ?? 0,
    // A replay wrote nothing now and does not read what the first apply marked: unknown, not 0.
    marks_inserted: result.outcome === "converted" ? result.marksInserted : result.outcome === "replayed" ? null : 0,
    // The older rules before and after this request (a replay's are in its record and audit rows).
    before: result.outcome === "converted" ? removedCounts(result.record) : result.outcome === "replayed" ? null : NO_OLDER_RULES,
    after: result.outcome === "replayed" ? null : NO_OLDER_RULES,
    elapsed_ms: input.elapsedMs,
  };
}

/** Where the cost-read reporter writes: the platform logger's two levels it uses. */
export interface RulesConversionCostReadLog {
  warn(action: string, fields: Record<string, unknown>): void;
  debug(action: string, fields: Record<string, unknown>): void;
}

/**
 * The repository's cost-read reporter for both actors' factories (plan D14).
 * The load goes on and the body refuses the failure with
 * conversionCostReadFailedError, whose class this line takes, so the two
 * agree: a transient failure is WARN `deferred`, the only line that keeps
 * its stage and SQLSTATE (the 503's log entry and body carry neither); a
 * failure that ends as the fatal invariant is DEBUG `failed`, because that
 * invariant's own ERROR line carries both and one event gets one ERROR.
 */
export function rulesConversionCostReadReporter(log: RulesConversionCostReadLog):
  (failure: ListingSettingsCostReadFailure & { vendorId: number; storeConnectionId: number; variantCount: number }) => void {
  return (failure) => {
    const transient = conversionCostReadFailedError(failure.storeConnectionId, failure).context?.classification === "transient";
    const fields = {
      outcome: transient ? "deferred" : "failed",
      error_code: "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE",
      error_class: transient ? "transient" : "fatal",
      vendor_id: failure.vendorId,
      store_connection_id: failure.storeConnectionId,
      variant_count: failure.variantCount,
      stage: failure.stage,
      sql_state: failure.sqlState,
    };
    if (transient) log.warn(RULES_CONVERSION_COST_READ_FAILED_ACTION, fields);
    else log.debug(RULES_CONVERSION_COST_READ_FAILED_ACTION, fields);
  };
}

export class DropshipListingRulesConversionService {
  constructor(private readonly deps: DropshipListingRulesConversionServiceDependencies) {}

  /**
   * POST …/listing-settings/conversion/apply (plan 7.B.2): the input parsed
   * (400), one clock reading, then one transaction behind the heavy-write
   * gate whose body is convertInTransaction in vendor mode, bound to the two
   * hashes the vendor was shown. One INFO line after the transaction, whatever
   * it answered (no text value, no name; plan 3.5).
   */
  async applyForMember(memberId: string, storeId: unknown, body: unknown): Promise<ListingRulesConversionApplyResponse> {
    assertListingSettingMember(memberId);
    const storeConnectionId = parseListingSettingInput(listingSettingStoreIdSchema, storeId);
    const parsed = parseListingSettingInput(listingRulesConversionApplyInputSchema, body);
    const started = this.deps.timer();
    const now = this.deps.clock.now();
    const mode: ConversionMode = { kind: "vendor", expectedPlanHash: parsed.planHash, expectedWritesHash: parsed.writesHash };

    const { result, vendorId } = await this.deps.heavyWrites.run(() => this.deps.repository.executeConversion({
      actorType: "vendor", memberId, storeConnectionId, idempotencyKey: parsed.idempotencyKey,
    }, async (tx) => ({ result: await convertInTransaction(tx, mode, now), vendorId: tx.vendorId })));

    const answered = vendorOutcome(result, storeConnectionId);
    this.deps.log.info(RULES_CONVERSION_APPLIED_ACTION, rulesConversionAppliedLogFields({
      result: answered, vendorId, storeConnectionId, actor: { actorType: "vendor", actorId: memberId },
      requestKey: parsed.idempotencyKey, elapsedMs: Math.max(0, Math.round(this.deps.timer() - started)),
    }));
    return vendorAnswer(answered);
  }
}

const NO_OLDER_RULES = Object.freeze({ pricing_groups: 0, content_groups: 0, ebay_rules: 0 });

function removedCounts(record: ListingRuleConversionRecord): { pricing_groups: number; content_groups: number; ebay_rules: number } {
  return { pricing_groups: record.pricingGroupsRemoved, content_groups: record.contentGroupsRemoved, ebay_rules: record.ebayRulesRemoved };
}

/** The vendor's transaction answers only these; the system's outcomes never reach a vendor. */
function vendorOutcome(result: ConversionTransactionResult, storeConnectionId: number): AnsweredConversionResult {
  switch (result.outcome) {
    case "converted":
    case "replayed":
    case "nothing_to_convert":
      return result;
    default:
      throw listingSettingsInvariantFailed("A vendor's rules conversion answered a system outcome.", { storeConnectionId, outcome: result.outcome });
  }
}

/** The vendor's answer from his transaction's outcome. */
function vendorAnswer(result: AnsweredConversionResult): ListingRulesConversionApplyResponse {
  return result.outcome === "nothing_to_convert"
    ? { outcome: "nothing_to_convert", conversionId: null, categoryCount: 0, productCount: 0 }
    : { outcome: result.outcome, conversionId: result.record.id, categoryCount: result.record.categoryCount,
      productCount: result.record.productCount };
}
