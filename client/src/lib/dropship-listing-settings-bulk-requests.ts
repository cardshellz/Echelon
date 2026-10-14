import type { QueryClient } from "@tanstack/react-query";
import { saveProductsBulkResponseSchema, type SaveProductsBulkResponse } from "@shared/dropship/listing-setting-writes";
import { queryErrorMessage } from "./dropship-ops-surface";
import {
  LISTING_SETTINGS_OFF_CONTRACT,
  ListingSettingsReadError,
  listingSettingsProductIdsQueryOptions,
  listingSettingsQueryKey,
  type ListingSettingsProductIdsRequest,
} from "./dropship-listing-settings";
import {
  BULK_EDITOR_ID,
  classifyWriteFailure,
  failureAfterUnconfirmed,
  LISTING_SETTINGS_KEY_PREFIXES,
  type ListingSettingsDraft,
  type WriteFailure,
} from "./dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "./dropship-listing-settings-drawer";
import {
  BULK_REQUEST_INVALID,
  bulkChangedFields,
  bulkPatch,
  bulkReload,
  bulkSaveBody,
  bulkSignature,
  bulkTextTooLarge,
  readBulkDraft,
  type BulkDraftValue,
  type BulkReload,
  type BulkSaveBody,
} from "./dropship-listing-settings-bulk";
import type { ProductSettingsSaveCallbacks, ProductSettingsSaveDrafts } from "./dropship-listing-settings-product-requests";
import { idsRequestFor, pickSelected, type ListingSettingsSelection, type PickedProducts } from "./dropship-listing-settings-selection";
import { LISTING_SETTINGS_BULK_WORDS, LISTING_SETTINGS_EDIT_WORDS } from "./dropship-listing-settings-words";

/**
 * "Set for selected"'s save (W6, `POST …/listing-settings/products/bulk`;
 * Listing settings PR 10, plan 6.4): the request, its answer's contract, the
 * re-reads after it, "Load latest", and the save run from Save to settled,
 * as `runProductSettingsSave` runs W5's.
 *
 * Rules this module keeps (plan D5, D6, D7, D9):
 * - One request key per request (`ls-bulk:…`), reused only while the request
 *   is the same, so a Check again is answered by the first save.
 * - The products and revisions sent are the ones the sheet's ids read gave
 *   when it opened, kept in the draft (D6).
 * - A save's answer is checked, never shown or cached: the Products list and
 *   the ids read are read again instead (D9).
 * - A Check again answered "not now" keeps its doubt (D7b).
 *
 * The network calls and the query client are passed in, so every step can be
 * run in a test.
 */

/** The W6 route of one store. */
export function productsBulkEndpoint(storeConnectionId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/listing-settings/products/bulk`;
}

/**
 * A W6 answer checked against its contract, for the products it was sent for.
 * Throws a ListingSettingsReadError (`…_OFF_CONTRACT`) when it doesn't match:
 * the save still stands (a 2xx), only the page can't trust what it says.
 */
export function readSavedProductsBulk(answer: unknown, productCount: number): SaveProductsBulkResponse {
  const parsed = saveProductsBulkResponseSchema.safeParse(answer);
  if (parsed.success && parsed.data.productCount === productCount) return parsed.data;
  throw new ListingSettingsReadError({
    code: LISTING_SETTINGS_OFF_CONTRACT,
    message: "This page couldn't read Card Shellz's answer. Reload the page and try again.",
    context: {
      write: "W6",
      productCount,
      issues: parsed.success
        ? [{ path: "productCount", code: "other_count" }]
        : parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    },
  });
}

export type BulkSaveQueryClient = Pick<QueryClient, "cancelQueries" | "fetchQuery" | "invalidateQueries">;

/**
 * Reads the Products list and the sheet's ids read again after a save (D9:
 * never from a save's answer). Reads in flight are cancelled first, so an
 * older answer can't land after these. Every Products page is marked stale
 * and the shown ones are read now; the ids read is read fresh with the
 * sheet's own `gcTime: 0`, so it is dropped once the sheet closes and the
 * next opening reads again (D6). Throws when a read fails.
 */
export async function rereadAfterBulkSave(
  queryClient: BulkSaveQueryClient,
  storeConnectionId: number,
  idsRequest: ListingSettingsProductIdsRequest | null,
): Promise<void> {
  const products = [...listingSettingsQueryKey(storeConnectionId), "products"] as const;
  const ids = [...listingSettingsQueryKey(storeConnectionId), "product-ids"] as const;
  await Promise.all([
    queryClient.cancelQueries({ queryKey: products }),
    queryClient.cancelQueries({ queryKey: ids }),
  ]);
  const reads: Array<Promise<unknown>> = [queryClient.invalidateQueries({ queryKey: products }, { throwOnError: true })];
  if (idsRequest !== null) {
    const options = listingSettingsProductIdsQueryOptions(storeConnectionId, idsRequest);
    // fetchQuery without the read's gcTime would keep the answer 5 minutes (query-core keeps the longest gcTime it was given).
    reads.push(queryClient.fetchQuery({ queryKey: options.queryKey, queryFn: options.queryFn, staleTime: 0, gcTime: options.gcTime, retry: false }));
  }
  await Promise.all(reads);
}

/**
 * "Load latest and keep my changes" after a 409 (R:542, plan 6.5), and
 * [Discard] after one (`mine` with no choices): reads the selection's ids
 * again, then says what the read does to the draft (`bulkReload`: the
 * vendor's choices on the products and revisions read now, a fresh start on
 * them, or none left). Throws when the read fails.
 */
export async function loadLatestBulk(
  queryClient: Pick<QueryClient, "cancelQueries" | "fetchQuery">,
  storeConnectionId: number,
  selection: ListingSettingsSelection,
  mine: BulkDraftValue,
): Promise<BulkReload> {
  const request = idsRequestFor(selection);
  if (request === null) return bulkReload(mine, { products: [], missing: 0, total: 0, matched: null });
  const options = listingSettingsProductIdsQueryOptions(storeConnectionId, request);
  await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
  const answer = await queryClient.fetchQuery({ queryKey: options.queryKey, queryFn: options.queryFn, staleTime: 0, gcTime: options.gcTime, retry: false });
  const picked: PickedProducts = pickSelected(answer, selection);
  return bulkReload(mine, picked);
}

// ---------------------------------------------------------------------------
// Running a save
// ---------------------------------------------------------------------------

export interface ProductsBulkSaveRun {
  storeConnectionId: number;
  /** The step's draft as the vendor pressed Save (or Check again): the sheet's choices, products and phase. */
  draft: ListingSettingsDraft;
  /** The draft provider's two save calls. */
  drafts: ProductSettingsSaveDrafts;
  /** The page's pending-save counter (D10). */
  callbacks: ProductSettingsSaveCallbacks;
  send: (body: BulkSaveBody) => Promise<unknown>;
  /** Reads the Products list and the ids read again (`rereadAfterBulkSave`). */
  reread: () => Promise<unknown>;
  /** The step marks the step 3 preview stale and reads every listing settings view again. */
  onSettingsSaved: () => void;
  /** A save refused because of a block a banner explains. The draft is kept. Never given a refusal (D8). */
  onBlocked?: (error: unknown) => void;
}

export type ProductsBulkSaveOutcome =
  /** Nothing was sent: no change, no product, too much text, another action is running, or no save can start now. */
  | { kind: "not_started"; message: string | null }
  /** `productCount`: the products the save named, for "Saved for 312 products. Still selected." */
  | { kind: "saved"; viewStale: boolean; productCount: number }
  | { kind: "failed"; failure: WriteFailure };

/**
 * One "Set for selected" save, start to finish (plan 6.4):
 * 1. the draft's choices make the patch; with none, or no product, nothing is
 *    sent; with more text than the server's budget for its products, nothing
 *    is sent either (Save is off with the same words, 6.5);
 * 2. the page's pending-save counter starts, or the save does not;
 * 3. the draft takes the request key (`ls-bulk`): the same request reuses its key;
 * 4. the body is checked by the shared schema, then sent; a failure is
 *    classified (W6) and, for a Check again, keeps its doubt (D7b);
 * 5. a 2xx means saved. The Products list and the ids read are read again
 *    (the answer is only checked); if that read or the check fails, the save
 *    still stands and the vendor sees "Saved. We couldn't load the latest view.";
 * 6. the step is told, and the counter always ends once it started.
 */
export async function runProductsBulkSave(run: ProductsBulkSaveRun): Promise<ProductsBulkSaveOutcome> {
  const value = run.draft.editor === BULK_EDITOR_ID ? readBulkDraft(run.draft.value) : null;
  if (value === null || bulkChangedFields(value).length === 0) return { kind: "not_started", message: null };
  if (value.products.length === 0) return { kind: "not_started", message: LISTING_SETTINGS_BULK_WORDS.noneChosen };
  const patch = bulkPatch(value);
  if (bulkTextTooLarge(value.products.length, patch)) return { kind: "not_started", message: LISTING_SETTINGS_BULK_WORDS.tooMuchText };
  const signature = bulkSignature(run.storeConnectionId, value.products, patch);
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
    const key = run.drafts.startSave(signature, LISTING_SETTINGS_KEY_PREFIXES.bulkSettings);
    if (key === null) return { kind: "not_started", message: null };

    let body: BulkSaveBody;
    try {
      body = bulkSaveBody({ key, products: value.products, patch });
    } catch {
      // Never sent; the next try gets a new key.
      const failure: WriteFailure = {
        phase: "refused", message: LISTING_SETTINGS_EDIT_WORDS.cantBuild, code: BULK_REQUEST_INVALID, status: null, fields: [],
      };
      run.drafts.settle(key, { kind: "failure", failure });
      return { kind: "failed", failure };
    }

    let answer: unknown;
    try {
      answer = await run.send(body);
    } catch (error) {
      const classified = classifyWriteFailure("W6", error);
      const failure = failureAfterUnconfirmed(wasUncertain, classified);
      run.drafts.settle(key, { kind: "failure", failure });
      // The banner learns of every block, a Check again's too, which stays unconfirmed (D7b).
      if (classified.phase === "blocked") run.onBlocked?.(error);
      return { kind: "failed", failure };
    }

    let viewStale = false;
    try {
      // Checked for its contract only; what it says is never shown or cached (D9).
      readSavedProductsBulk(answer, body.products.length);
    } catch {
      // Deliberate: a 2xx saved, but the page and the server disagree on the answer. The views are
      // still read again, and the draft says the view may be out of date, with [Reload].
      viewStale = true;
    }
    try {
      await run.reread();
    } catch {
      // Deliberate: the save stands; only the view is out of date ("saved_view_stale").
      viewStale = true;
    }
    run.drafts.settle(key, { kind: viewStale ? "saved_view_stale" : "saved" });
    run.onSettingsSaved();
    return { kind: "saved", viewStale, productCount: body.products.length };
  } finally {
    run.callbacks.onSaveSettled();
  }
}
