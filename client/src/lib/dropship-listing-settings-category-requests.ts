import type { QueryClient } from "@tanstack/react-query";
import { saveCategorySettingsResponseSchema, type SaveCategorySettingsResponse } from "@shared/dropship/listing-setting-writes";
import type { ListingSettingsCategoryDetail } from "@shared/dropship/listing-settings";
import { queryErrorMessage } from "./dropship-ops-surface";
import {
  LISTING_SETTINGS_OFF_CONTRACT,
  ListingSettingsReadError,
  listingSettingsCategoryQueryOptions,
  listingSettingsQueryKey,
} from "./dropship-listing-settings";
import {
  categoryEditorId,
  classifyWriteFailure,
  failureAfterUnconfirmed,
  LISTING_SETTINGS_KEY_PREFIXES,
  type ListingSettingsDraft,
  type WriteFailure,
} from "./dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "./dropship-listing-settings-drawer";
import {
  CATEGORY_REQUEST_INVALID,
  categoryClearBody,
  categoryHasChange,
  categoryPatch,
  categorySaveBody,
  categorySignature,
  readCategoryDraft,
  rebaseCategoryDraft,
  type CategoryDraftValue,
  type CategoryReload,
  type CategorySaveBody,
} from "./dropship-listing-settings-categories";
import type { ProductSettingsSaveCallbacks, ProductSettingsSaveDrafts } from "./dropship-listing-settings-product-requests";
import { LISTING_SETTINGS_EDIT_WORDS } from "./dropship-listing-settings-words";

/**
 * One Card Shellz category's save from its editor (W12, `PUT
 * …/listing-settings/categories/:categoryId`; Listing settings PR 10e, plan
 * 8.5, 8.6): the request, its answer's contract, the re-reads after it, "Load
 * latest", and the save run from Save to settled, as `runProductSettingsSave`
 * runs W5's.
 *
 * Rules this module keeps (plan D5, D6, D7, D9, D11):
 * - One request key per request (`ls-cat:…`), reused only while the request
 *   is the same, so a Check again is answered by the first save.
 * - The revision and the "Also clear theirs" set sent are the ones the
 *   editor's detail read gave when it opened, kept in the draft (D6).
 * - A save's answer is checked, never shown or cached: the categories list,
 *   the category's detail, the Products list and the summary are read again
 *   instead, and the products' own reads too when the save cleared products (D9).
 * - A Check again answered "not now" keeps its doubt (D7b).
 * - The older-rules 409 is the backstop (D11): refused for good, and the
 *   card reads the summary again so [Change] goes away; a 404 closes the
 *   editor and reads the card again (8.6).
 *
 * The network calls and the query client are passed in, so every step can be
 * run in a test.
 */

/** The W12 route for one category. */
export function categorySettingsEndpoint(storeConnectionId: number, categoryId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/listing-settings/categories/${categoryId}`;
}

/**
 * A W12 answer checked against its contract, for the category it was sent
 * for. Throws a ListingSettingsReadError (`…_OFF_CONTRACT`) when it doesn't
 * match: the save still stands (a 2xx), only the page can't trust what it says.
 */
export function readSavedCategorySettings(answer: unknown, categoryId: number): SaveCategorySettingsResponse {
  const parsed = saveCategorySettingsResponseSchema.safeParse(answer);
  if (parsed.success && parsed.data.categoryId === categoryId) return parsed.data;
  throw new ListingSettingsReadError({
    code: LISTING_SETTINGS_OFF_CONTRACT,
    message: "This page couldn't read Card Shellz's answer. Reload the page and try again.",
    context: {
      write: "W12",
      categoryId,
      issues: parsed.success
        ? [{ path: "categoryId", code: "other_category" }]
        : parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    },
  });
}

export type CategorySaveQueryClient = Pick<QueryClient, "cancelQueries" | "fetchQuery" | "invalidateQueries">;

/**
 * Reads one category's detail again, fresh (D9: never from a save's answer,
 * which a replay gives with the first save's revision). A read in flight is
 * cancelled first, so an older answer can't land after this one. Throws when
 * the read fails.
 */
export async function rereadCategoryDetail(
  queryClient: Pick<QueryClient, "cancelQueries" | "fetchQuery">,
  storeConnectionId: number,
  categoryId: number,
): Promise<ListingSettingsCategoryDetail> {
  const options = listingSettingsCategoryQueryOptions(storeConnectionId, categoryId);
  await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
  return queryClient.fetchQuery({ queryKey: options.queryKey, queryFn: options.queryFn, staleTime: 0, retry: false });
}

/** The listing settings reads a category save changes (D9), by what the save did. */
const READS_AFTER_CATEGORY_SAVE = ["categories", "products", "summary"] as const;
/** The reads a save that cleared products changes too: the products' own rows and their settings in full ("From category" rows). */
const READS_AFTER_CLEAR = ["product-own", "product"] as const;

/**
 * After a confirmed save (D9): the categories list, every Products page and
 * the summary are marked stale and the shown ones read now (prefixes, never
 * one page's key), the category's detail is read fresh, and, when the save
 * cleared products, every product's own read and detail too (their values
 * and revisions moved). Reads in flight are cancelled first, so an older
 * answer can't land after these. Never taken from the answer. Throws when a
 * read fails.
 */
export async function rereadAfterCategorySave(
  queryClient: CategorySaveQueryClient,
  storeConnectionId: number,
  categoryId: number,
  options: { clearedProducts: boolean },
): Promise<void> {
  const reads = [...READS_AFTER_CATEGORY_SAVE, ...(options.clearedProducts ? READS_AFTER_CLEAR : [])];
  const keys = reads.map((read) => [...listingSettingsQueryKey(storeConnectionId), read] as const);
  const detail = listingSettingsCategoryQueryOptions(storeConnectionId, categoryId);
  await Promise.all([
    ...keys.map((queryKey) => queryClient.cancelQueries({ queryKey })),
    queryClient.cancelQueries({ queryKey: detail.queryKey, exact: true }),
  ]);
  await Promise.all([
    ...keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }, { throwOnError: true })),
    queryClient.fetchQuery({ queryKey: detail.queryKey, queryFn: detail.queryFn, staleTime: 0, retry: false }),
  ]);
}

/**
 * [Reload] after "Saved. We couldn't load the latest view." (D9): the same
 * re-reads as after the save, the products' too when the saved request named
 * any ("Also clear theirs" ticked), read from the draft that holds the saved
 * value (the reducer keeps it as the base). Throws when a read fails.
 */
export async function reloadAfterCategorySave(
  queryClient: CategorySaveQueryClient,
  storeConnectionId: number,
  categoryId: number,
  draft: ListingSettingsDraft | null,
): Promise<void> {
  const saved = draft !== null && draft.editor === categoryEditorId(categoryId) ? readCategoryDraft(draft.value) : null;
  await rereadAfterCategorySave(queryClient, storeConnectionId, categoryId, { clearedProducts: saved !== null && categoryClearBody(saved) !== undefined });
}

/**
 * After a refusal the card must learn of (8.6): the summary (the older-rules
 * counts, D11) and the categories list are marked stale and read now.
 * Throws when a read fails.
 */
export async function rereadCategoryCard(queryClient: Pick<QueryClient, "cancelQueries" | "invalidateQueries">, storeConnectionId: number): Promise<void> {
  const keys = (["summary", "categories"] as const).map((read) => [...listingSettingsQueryKey(storeConnectionId), read] as const);
  await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }, { throwOnError: true })));
}

/**
 * "Load latest and keep my changes" after a 409 (R:542, plan 8.6): reads the
 * detail again, then gives the vendor's choices on what is saved now, the
 * clear set rebuilt from the new `ownValues`, and the fields another window
 * changed too. The editor sends `edited`, then rebases on `latest` with
 * `marked`; with nothing left to keep (`keeps` false) it discards the draft.
 * Throws when the read fails.
 */
export async function loadLatestCategory(
  queryClient: Pick<QueryClient, "cancelQueries" | "fetchQuery">,
  storeConnectionId: number,
  categoryId: number,
  mine: CategoryDraftValue,
): Promise<CategoryReload> {
  return rebaseCategoryDraft(mine, await rereadCategoryDetail(queryClient, storeConnectionId, categoryId));
}

// ---------------------------------------------------------------------------
// Running a save
// ---------------------------------------------------------------------------

/**
 * What the editor does after a failed save, beside showing its words (plan 8.6):
 * - `reread_card`: the store holds older group rules, so the card reads the
 *   summary again and takes [Change] away (D11); the runner has done the read;
 * - `close`: no chosen product is in the category any more: the editor
 *   closes (the draft is dropped) and the card, read again by the runner, no
 *   longer lists it;
 * - `load_latest`: the category or its products changed in another window:
 *   the footer offers [Load latest and keep my changes];
 * - null: nothing beyond the words (Check again, the banner, a marked field).
 */
export type CategoryFailureFollowUp = "reread_card" | "close" | "load_latest" | null;

const OLDER_RULES_PRESENT_CODE = "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT";
const CATEGORY_NOT_FOUND_CODE = "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND";

export function categoryFailureFollowUp(failure: Pick<WriteFailure, "phase" | "code">): CategoryFailureFollowUp {
  if (failure.phase === "conflict") return "load_latest";
  if (failure.phase !== "refused") return null;
  if (failure.code === OLDER_RULES_PRESENT_CODE) return "reread_card";
  if (failure.code === CATEGORY_NOT_FOUND_CODE) return "close";
  return null;
}

export interface CategorySettingsSaveRun {
  storeConnectionId: number;
  categoryId: number;
  /** For the product conflict's words: "The products in <category> changed." */
  categoryName: string;
  /** This category's draft as the vendor pressed Save (or Check again): its choices, its ticks and its phase. */
  draft: ListingSettingsDraft;
  drafts: ProductSettingsSaveDrafts;
  callbacks: ProductSettingsSaveCallbacks;
  send: (body: CategorySaveBody) => Promise<unknown>;
  /** Reads the views again (`rereadAfterCategorySave`), with whether the save cleared products. */
  reread: (options: { clearedProducts: boolean }) => Promise<unknown>;
  /** Reads the summary and the categories list again after a refusal the card must learn of (`rereadCategoryCard`). Best effort. */
  rereadCard?: () => Promise<unknown>;
  /** The step marks the step 3 preview stale and reads every listing settings view again. */
  onSettingsSaved: () => void;
  /** A save refused because of a block a banner explains (plan 4.4). The draft is kept. Never given a refusal (D8). */
  onBlocked?: (error: unknown) => void;
}

export type CategorySettingsSaveOutcome =
  /** Nothing was sent: no change, another action is running, or no save can start now. */
  | { kind: "not_started"; message: string | null }
  /** `clearedProductCount`: the products the save cleared, from the answer; null on a replay or when the answer couldn't be read. */
  | { kind: "saved"; viewStale: boolean; clearedProductCount: number | null }
  | { kind: "failed"; failure: WriteFailure; followUp: CategoryFailureFollowUp };

/**
 * One save of a category's settings, start to finish (plan 8.5, 8.6):
 * 1. the draft's choices and ticks make the patch and the clear set; with
 *    none, nothing is sent;
 * 2. the page's pending-save counter starts, or the save does not;
 * 3. the draft takes the request key (`ls-cat`): the same request reuses its key;
 * 4. the body is checked by the shared schema, then sent; a failure is
 *    classified (W12) and, for a Check again, keeps its doubt (D7b); a
 *    refusal the card must learn of reads the summary and the list again;
 * 5. a 2xx means saved. The views are read again (the answer is only
 *    checked, for whether products were cleared); if that read or the check
 *    fails, the save still stands and the vendor sees "Saved. We couldn't
 *    load the latest view.";
 * 6. the step is told, and the counter always ends once it started.
 */
export async function runCategorySettingsSave(run: CategorySettingsSaveRun): Promise<CategorySettingsSaveOutcome> {
  const value = run.draft.editor === categoryEditorId(run.categoryId) ? readCategoryDraft(run.draft.value) : null;
  if (value === null || value.categoryId !== run.categoryId || !categoryHasChange(value)) return { kind: "not_started", message: null };
  const patch = categoryPatch(value);
  const clear = categoryClearBody(value);
  const signature = categorySignature(run.storeConnectionId, run.categoryId, value.expectedRevisionId, patch, clear);
  // Read before the save starts: startSave turns the phase to "saving".
  const wasUncertain = run.draft.phase === "uncertain";

  if (run.callbacks.disabled) return { kind: "not_started", message: DRAWER_WORDS.busy };
  try {
    run.callbacks.onSaveStarted();
  } catch (error) {
    // Nothing was sent, so the draft is untouched and Save works again once the other action ends.
    return { kind: "not_started", message: queryErrorMessage(error, DRAWER_WORDS.busy) };
  }
  try {
    const key = run.drafts.startSave(signature, LISTING_SETTINGS_KEY_PREFIXES.categorySettings);
    if (key === null) return { kind: "not_started", message: null };

    let body: CategorySaveBody;
    try {
      body = categorySaveBody({ key, expectedRevisionId: value.expectedRevisionId, patch, clear });
    } catch {
      // Never sent; the next try gets a new key.
      const failure: WriteFailure = {
        phase: "refused", message: LISTING_SETTINGS_EDIT_WORDS.cantBuild, code: CATEGORY_REQUEST_INVALID, status: null, fields: [],
      };
      run.drafts.settle(key, { kind: "failure", failure });
      return { kind: "failed", failure, followUp: null };
    }

    let answer: unknown;
    try {
      answer = await run.send(body);
    } catch (error) {
      const classified = classifyWriteFailure("W12", error, { categoryName: run.categoryName });
      const failure = failureAfterUnconfirmed(wasUncertain, classified);
      run.drafts.settle(key, { kind: "failure", failure });
      // The banner learns of every block, a Check again's too, which stays unconfirmed (D7b).
      if (classified.phase === "blocked") run.onBlocked?.(error);
      const followUp = categoryFailureFollowUp(failure);
      if (followUp === "reread_card" || followUp === "close") {
        try {
          await run.rereadCard?.();
        } catch {
          // Deliberate: the refusal stands and is worded; the card's own Try again reads it again.
        }
      }
      return { kind: "failed", failure, followUp };
    }

    let viewStale = false;
    let clearedProductCount: number | null = null;
    try {
      // Checked for its contract; only whether products were cleared is read from it, never a value to show (D9).
      clearedProductCount = readSavedCategorySettings(answer, run.categoryId).clearedProductCount;
    } catch {
      // Deliberate: a 2xx saved, but the page and the server disagree on the answer. The views are
      // still read again, and the draft says the view may be out of date, with [Reload].
      viewStale = true;
    }
    try {
      // A replay (null) or an unreadable answer: the products are read again whenever the request named any.
      await run.reread({ clearedProducts: clearedProductCount === null ? body.clear !== undefined : clearedProductCount > 0 });
    } catch {
      // Deliberate: the save stands; only the view is out of date ("saved_view_stale").
      viewStale = true;
    }
    run.drafts.settle(key, { kind: viewStale ? "saved_view_stale" : "saved" });
    run.onSettingsSaved();
    return { kind: "saved", viewStale, clearedProductCount };
  } finally {
    run.callbacks.onSaveSettled();
  }
}
