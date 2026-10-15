import type { QueryClient } from "@tanstack/react-query";
import {
  acknowledgeCategoryMovesResponseSchema,
  type AcknowledgeCategoryMovesInput,
  type AcknowledgeCategoryMovesResponse,
} from "@shared/dropship/listing-setting-writes";
import { queryErrorMessage } from "./dropship-ops-surface";
import { LISTING_SETTINGS_OFF_CONTRACT, ListingSettingsReadError, listingSettingsQueryKey } from "./dropship-listing-settings";
import {
  classifyWriteFailure,
  failureAfterUnconfirmed,
  LISTING_SETTINGS_KEY_PREFIXES,
  UPDATED_PRODUCTS_EDITOR_ID,
  type ListingSettingsDraft,
  type WriteFailure,
} from "./dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "./dropship-listing-settings-drawer";
import type { ProductSettingsSaveCallbacks, ProductSettingsSaveDrafts } from "./dropship-listing-settings-product-requests";
import {
  acknowledgeBody,
  gotItSignature,
  readUpdatedProductsDraft,
  UPDATED_PRODUCTS_REQUEST_INVALID,
  type UpdatedProductMoveItem,
} from "./dropship-listing-settings-updated";
import { LISTING_SETTINGS_EDIT_WORDS } from "./dropship-listing-settings-words";

/**
 * "Got it" and "Got it for all N" in "Card Shellz updated products" (W13,
 * `POST …/listing-settings/category-moves/acknowledge`; Listing settings PR
 * 10g, plan 10.2, 10.4): the request, its answer's contract, the re-reads
 * after it, and the run from the button to settled, as
 * `runProductSettingsSave` runs W5's.
 *
 * Rules this module keeps (plan D5, D6, D7, D9):
 * - One request key per set of products (`ls-moves:…`), reused only while
 *   the request is the same, so a Check again is answered by the first send.
 * - The items sent are the ones the sheet's read gave, kept in the draft (D6).
 * - The answer is checked and its lists are shown (what moved again, 10.3),
 *   never cached: every updated-products page, the Products list and the
 *   summary are read again instead (D9). A replay names no product and is
 *   re-read only.
 * - A Check again answered "not now" keeps its doubt (D7b).
 *
 * The network calls and the query client are passed in, so every step can be
 * run in a test.
 */

/** The W13 route of one store. */
export function categoryMovesAcknowledgeEndpoint(storeConnectionId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/listing-settings/category-moves/acknowledge`;
}

/**
 * A W13 answer checked against its contract, for the products it was sent
 * for: every product it names was sent. Throws a ListingSettingsReadError
 * (`…_OFF_CONTRACT`) when it doesn't match: the "Got it" still stands (a
 * 2xx), only the page can't trust what it says.
 */
export function readAcknowledgedCategoryMoves(answer: unknown, sent: readonly UpdatedProductMoveItem[]): AcknowledgeCategoryMovesResponse {
  const parsed = acknowledgeCategoryMovesResponseSchema.safeParse(answer);
  const sentIds = new Set(sent.map((item) => item.productId));
  const unsent = parsed.success
    ? [...parsed.data.acknowledgedProductIds, ...parsed.data.movedAgainProductIds].filter((productId) => !sentIds.has(productId))
    : [];
  if (parsed.success && unsent.length === 0) return parsed.data;
  throw new ListingSettingsReadError({
    code: LISTING_SETTINGS_OFF_CONTRACT,
    message: "This page couldn't read Card Shellz's answer. Reload the page and try again.",
    context: {
      write: "W13",
      itemCount: sent.length,
      issues: parsed.success
        ? [{ path: "productIds", code: "unsent_product" }]
        : parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    },
  });
}

export type CategoryMovesQueryClient = Pick<QueryClient, "cancelQueries" | "invalidateQueries">;

/** The listing settings reads a "Got it" changes (plan 10.2, D9): every updated-products page, the Products list, the summary. */
const READS_AFTER_ACKNOWLEDGE = ["updated-products", "products", "summary"] as const;

/**
 * After a confirmed "Got it" (D9): every updated-products page, every Products
 * page and the summary are marked stale and the shown ones read now (prefixes,
 * never one page's key). Reads in flight are cancelled first, so an older
 * answer can't land after these. Never taken from the answer. Throws when a
 * refetch fails.
 */
export async function rereadAfterCategoryMoves(queryClient: CategoryMovesQueryClient, storeConnectionId: number): Promise<void> {
  const keys = READS_AFTER_ACKNOWLEDGE.map((read) => [...listingSettingsQueryKey(storeConnectionId), read] as const);
  await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }, { throwOnError: true })));
}

// ---------------------------------------------------------------------------
// Running a "Got it"
// ---------------------------------------------------------------------------

export interface CategoryMovesAcknowledgeRun {
  storeConnectionId: number;
  /** The step's draft as the vendor pressed Got it (or Check again): the items and the phase. */
  draft: ListingSettingsDraft;
  /** The draft provider's two save calls. */
  drafts: ProductSettingsSaveDrafts;
  /** The page's pending-save counter (D10). */
  callbacks: ProductSettingsSaveCallbacks;
  send: (body: AcknowledgeCategoryMovesInput) => Promise<unknown>;
  /** Reads the updated-products pages, the Products list and the summary again (`rereadAfterCategoryMoves`). */
  reread: () => Promise<unknown>;
  /** The step marks the step 3 preview stale and reads every listing settings view again. */
  onSettingsSaved: () => void;
  /** A "Got it" refused because of a block a banner explains. The draft is kept. Never given a refusal (D8). */
  onBlocked?: (error: unknown) => void;
}

export type CategoryMovesAcknowledgeOutcome =
  /** Nothing was sent: not a "Got it" draft, no item, another action is running, or no send can start now. */
  | { kind: "not_started"; message: string | null }
  /**
   * A 2xx. `answer` is the server's, for "Done." and what moved again (10.3);
   * null when it broke its contract (then `viewStale`, and only "Done." shows).
   */
  | { kind: "saved"; viewStale: boolean; answer: AcknowledgeCategoryMovesResponse | null }
  | { kind: "failed"; failure: WriteFailure };

/**
 * One "Got it", start to finish (plan 10.2, 10.4):
 * 1. the draft's items make the request; with none, nothing is sent;
 * 2. the page's pending-save counter starts, or the send does not;
 * 3. the draft takes the request key (`ls-moves`): the same request reuses its key;
 * 4. the body is checked by the shared schema, then sent; a failure is
 *    classified (W13) and, for a Check again, keeps its doubt (D7b);
 * 5. a 2xx means done. The answer is checked and handed back (what moved
 *    again); the views are read again; if that read or the check fails, the
 *    "Got it" still stands and the vendor sees "Saved. We couldn't load the
 *    latest view." A replay names no product: the re-read shows what stands;
 * 6. the step is told, and the counter always ends once it started.
 */
export async function runCategoryMovesAcknowledge(run: CategoryMovesAcknowledgeRun): Promise<CategoryMovesAcknowledgeOutcome> {
  const value = run.draft.editor === UPDATED_PRODUCTS_EDITOR_ID ? readUpdatedProductsDraft(run.draft.value) : null;
  if (value === null || value.items.length === 0) return { kind: "not_started", message: null };
  const signature = gotItSignature(run.storeConnectionId, value.items);
  // Read before the send starts: startSave turns the phase to "saving".
  const wasUncertain = run.draft.phase === "uncertain";

  if (run.callbacks.disabled) return { kind: "not_started", message: DRAWER_WORDS.busy };
  try {
    run.callbacks.onSaveStarted();
  } catch (error) {
    // Nothing was sent, so the draft is untouched and the button works again once the other action ends.
    return { kind: "not_started", message: queryErrorMessage(error, DRAWER_WORDS.busy) };
  }
  try {
    const key = run.drafts.startSave(signature, LISTING_SETTINGS_KEY_PREFIXES.categoryMoves);
    if (key === null) return { kind: "not_started", message: null };

    let body: AcknowledgeCategoryMovesInput;
    try {
      body = acknowledgeBody({ key, items: value.items });
    } catch {
      // Never sent; the next try gets a new key.
      const failure: WriteFailure = {
        phase: "refused", message: LISTING_SETTINGS_EDIT_WORDS.cantBuild, code: UPDATED_PRODUCTS_REQUEST_INVALID, status: null, fields: [],
      };
      run.drafts.settle(key, { kind: "failure", failure });
      return { kind: "failed", failure };
    }

    let raw: unknown;
    try {
      raw = await run.send(body);
    } catch (error) {
      const classified = classifyWriteFailure("W13", error);
      const failure = failureAfterUnconfirmed(wasUncertain, classified);
      run.drafts.settle(key, { kind: "failure", failure });
      // The banner learns of every block, a Check again's too, which stays unconfirmed (D7b).
      if (classified.phase === "blocked") run.onBlocked?.(error);
      return { kind: "failed", failure };
    }

    let viewStale = false;
    let answer: AcknowledgeCategoryMovesResponse | null = null;
    try {
      // Checked for its contract; its lists are shown (what moved again), never cached (D9).
      answer = readAcknowledgedCategoryMoves(raw, body.items);
    } catch {
      // Deliberate: a 2xx did it, but the page and the server disagree on the answer. The views are
      // still read again, and the draft says the view may be out of date, with [Reload].
      viewStale = true;
    }
    try {
      await run.reread();
    } catch {
      // Deliberate: the "Got it" stands; only the view is out of date ("saved_view_stale").
      viewStale = true;
    }
    run.drafts.settle(key, { kind: viewStale ? "saved_view_stale" : "saved" });
    run.onSettingsSaved();
    return { kind: "saved", viewStale, answer };
  } finally {
    run.callbacks.onSaveSettled();
  }
}
